import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectInstallMethod,
  installSessionStartHooks,
  uninstallSessionStartHooks,
  sessionStartHookStatus,
  computeSessionStartHookUpdate,
  type HookSettings,
} from "axi-sdk-js";
import {
  installSessionEndHook,
  uninstallSessionEndHook,
  sessionEndHookStatus,
} from "../session-hook.js";
import type { Parsed } from "../args.js";
import { fail, usage } from "../errors.js";
import { object, objects } from "../kubectl.js";
import { encodeObject } from "../toon.js";
function entrypoint(): string {
  return realpathSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../bin/k8s-axi-ctx.js"),
  );
}
function quote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
export function hookStatus() {
  const s = sessionStartHookStatus({ marker: "k8s-axi" });
  for (const [file, json] of [
    [s.claude.path, true],
    [s.codex.path, true],
    [s.codex.userFeaturePath, false],
    [s.opencode.path, false],
  ] as const) {
    try {
      const raw = readFileSync(file, "utf8");
      if (json) {
        const v: unknown = JSON.parse(raw);
        if (typeof v !== "object" || v === null || Array.isArray(v))
          throw new Error("not an object");
        const hooks = object(v).hooks;
        if (
          hooks !== undefined &&
          (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))
        )
          throw new Error("invalid hooks");
        for (const event of ["SessionStart", "SessionEnd"]) {
          const groups = object(hooks)[event];
          if (
            groups !== undefined &&
            (!Array.isArray(groups) ||
              groups.some((g) => !Array.isArray(object(g).hooks)))
          )
            throw new Error("invalid hook groups");
        }
      }
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "ENOENT")
        continue;
      fail("CONFIG_INVALID", `cannot read or parse hook destination ${file}`);
    }
  }
  const expected = `${quote(process.execPath)} ${quote(entrypoint())}`;
  const starts = (file: string) => {
    const commands = objects(
      object(object(JSON.parse(readFileSync(file, "utf8"))).hooks).SessionStart,
    )
      .flatMap((g) => objects(g.hooks))
      .map((hook) => object(hook).command)
      .filter(
        (command): command is string =>
          typeof command === "string" &&
          (command.includes("k8s-axi") || command === "k8s-axi-ctx"),
      );
    return commands.length === 1 && commands[0] === expected;
  };
  const claude = s.claude.installed
    ? starts(s.claude.path)
      ? "installed"
      : "partial"
    : "absent";
  const codex = s.codex.installed
    ? starts(s.codex.path) && s.codex.userFeatureEnabled
      ? "installed"
      : "partial"
    : "absent";
  const end = sessionEndHookStatus();
  const expectedEnd = `${quote(process.execPath)} ${quote(join(dirname(entrypoint()), "k8s-axi.js"))} context end`;
  const endCurrent =
    end &&
    objects(
      object(object(JSON.parse(readFileSync(s.claude.path, "utf8"))).hooks)
        .SessionEnd,
    )
      .flatMap((g) => objects(g.hooks))
      .some((h) => h.command === expectedEnd);
  return {
    claude,
    codex,
    opencode: s.opencode.installed
      ? readFileSync(s.opencode.path, "utf8").includes(
          `const command = ${JSON.stringify(entrypoint())};`,
        )
        ? "installed"
        : "partial"
      : "absent",
    sessionEnd: end ? (endCurrent ? "installed" : "partial") : "absent",
  };
}
export async function setupCommand(p: Parsed): Promise<string> {
  if (!["hooks", "status", "uninstall"].includes(p.action))
    usage("choose setup hooks, setup status or setup uninstall", "setup");
  const before = hookStatus();
  if (p.action === "status") {
    if (Object.values(before).includes("partial"))
      fail(
        "CONFIG_INVALID",
        `partial hook installation: ${JSON.stringify(before)}`,
        ["Run `k8s-axi setup hooks` to repair paths"],
      );
    return encodeObject(before);
  }
  const errors: string[] = [];
  let wroteSettings = false;
  if (p.action === "uninstall") {
    uninstallSessionStartHooks({
      marker: "k8s-axi",
      onError: (e) => errors.push(e),
    });
    try {
      uninstallSessionEndHook();
    } catch {
      errors.push("SessionEnd removal failed");
    }
  } else {
    const entry = entrypoint();
    if (detectInstallMethod({ entry }).kind === "npx")
      fail(
        "REFUSED",
        "setup hooks needs a persistent install, not an ephemeral npx cache",
        [
          "Install globally with npm install -g k8s-axi, then run `k8s-axi setup hooks`",
        ],
      );
    const s = sessionStartHookStatus({ marker: "k8s-axi" });
    if (!s.claude.installed || !s.codex.installed)
      installSessionStartHooks({
        marker: "k8s-axi",
        execPath: entry,
        binaryNames: [],
        distEntrypoints: ["dist/bin/k8s-axi-ctx.js"],
        onError: (e) => errors.push(e),
      });
    // Agent JSON commands run through a shell; pin Node too and quote both paths.
    for (const file of [s.claude.path, s.codex.path])
      try {
        const installed = readFileSync(file, "utf8");
        const current = object(JSON.parse(installed));
        const initial = JSON.stringify(current, null, 2) + "\n";
        const [next, changed] = computeSessionStartHookUpdate(
          current as HookSettings,
          {
            marker: "k8s-axi",
            command: `${quote(process.execPath)} ${quote(entry)}`,
          },
        );
        // Work around axi-sdk-js#259: its update repairs only the first managed hook.
        const expected = `${quote(process.execPath)} ${quote(entry)}`;
        const groups = objects(object(next.hooks).SessionStart);
        const isManaged = (hook: unknown) => {
          const command = object(hook).command;
          return (
            typeof command === "string" &&
            (command.includes("k8s-axi") || command === "k8s-axi-ctx")
          );
        };
        const broadGroup = groups.findIndex((group) => {
          const matcher = object(group).matcher;
          return matcher === undefined || matcher === null || matcher === "";
        });
        const managedGroup = groups.findIndex((group) =>
          objects(group.hooks).some(isManaged),
        );
        const destination = broadGroup === -1 ? managedGroup : broadGroup;
        const managedEntry = groups
          .flatMap((group) => objects(group.hooks))
          .find((hook) => object(hook).command === expected);
        const canonical = {
          ...(managedEntry ? object(managedEntry) : {}),
          type: "command",
          command: expected,
          timeout: 10,
        };
        const normalized: Record<string, unknown>[] = groups.flatMap(
          (group, index) => {
            const kept = objects(group.hooks).filter(
              (hook) => !isManaged(hook),
            );
            if (index === destination) kept.push(canonical);
            return kept.length ? [{ ...group, hooks: kept }] : [];
          },
        );
        if (destination < 0)
          normalized.push({ matcher: "", hooks: [canonical] });
        object(next.hooks).SessionStart = normalized;
        const serialized = JSON.stringify(next, null, 2) + "\n";
        if ((changed || serialized !== initial) && serialized !== installed) {
          writeFileSync(file, serialized);
          wroteSettings = true;
        }
      } catch (error) {
        errors.push(`could not pin hook command: ${String(error)}`);
      }
    try {
      installSessionEndHook(realpathSync(join(dirname(entry), "k8s-axi.js")));
    } catch {
      errors.push("SessionEnd installation failed");
    }
  }
  const after = hookStatus(),
    desired = p.action === "uninstall" ? "absent" : "installed";
  if (errors.length || Object.values(after).some((x) => x !== desired))
    fail(
      "CONFIG_INVALID",
      `hook ${p.action} incomplete; observed ${JSON.stringify(after)}; ${errors.join("; ")}`,
      [
        "Fix destination permissions, then run `k8s-axi setup status` and retry",
      ],
    );
  if (
    !wroteSettings &&
    JSON.stringify(before) === JSON.stringify(after) &&
    p.action === "hooks"
  )
    return encodeObject({ ...after, changed: false });
  return encodeObject(after);
}
