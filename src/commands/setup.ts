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
function isManagedStartCommand(command: unknown, expected: string): boolean {
  return (
    command === expected ||
    command === "k8s-axi-ctx" ||
    (typeof command === "string" &&
      /^'[^']*\/node' '[^']*\/node_modules\/k8s-axi\/dist\/bin\/k8s-axi-ctx\.js'$/.test(
        command,
      ))
  );
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
  const starts = (file: string) =>
    objects(
      object(object(JSON.parse(readFileSync(file, "utf8"))).hooks).SessionStart,
    )
      .flatMap((g) => objects(g.hooks))
      .some((h) => h.command === expected);
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
    const observed = sessionStartHookStatus({ marker: "k8s-axi" });
    const command = `${quote(process.execPath)} ${quote(entry)}`;
    const hasOneManagedStartHook = (file: string) =>
      objects(
        object(object(JSON.parse(readFileSync(file, "utf8"))).hooks)
          .SessionStart,
      )
        .flatMap((group) => objects(group.hooks))
        .filter((hook) => isManagedStartCommand(hook.command, command)).length === 1;
    if (
      Object.values(before).every((x) => x === "installed") &&
      [observed.claude.path, observed.codex.path].every(
        hasOneManagedStartHook,
      ) &&
      [observed.claude.path, observed.codex.path].every((file) =>
        readFileSync(file, "utf8").includes(JSON.stringify(command)),
      ) &&
      readFileSync(observed.opencode.path, "utf8").includes(
        JSON.stringify(entry),
      )
    )
      return encodeObject({ ...before, changed: false });
    if (detectInstallMethod({ entry }).kind === "npx")
      fail(
        "REFUSED",
        "setup hooks needs a persistent install, not an ephemeral npx cache",
        [
          "Install globally with npm install -g k8s-axi, then run `k8s-axi setup hooks`",
        ],
      );
    installSessionStartHooks({
      marker: "k8s-axi",
      execPath: entry,
      binaryNames: [],
      distEntrypoints: ["dist/bin/k8s-axi-ctx.js"],
      onError: (e) => errors.push(e),
    });
    // Agent JSON commands run through a shell; pin Node too and quote both paths.
    const s = sessionStartHookStatus({ marker: "k8s-axi" });
    for (const file of [s.claude.path, s.codex.path])
      try {
        const current = object(JSON.parse(readFileSync(file, "utf8")));
        const [next, changed] = computeSessionStartHookUpdate(
          current as HookSettings,
          {
            marker: "k8s-axi",
            command: `${quote(process.execPath)} ${quote(entry)}`,
          },
        );
        const groups = objects(object(next.hooks).SessionStart);
        const hasExpectedCommand = groups
          .flatMap((group) => objects(group.hooks))
          .some((hook) => hook.command === command);
        let keptManaged = false;
        const deduped = groups.flatMap((group) => {
          const hooks = objects(group.hooks).flatMap((hook) => {
            if (
              hook.command !== command &&
              isManagedStartCommand(hook.command, command) &&
              hasExpectedCommand
            )
              return [];
            if (!isManagedStartCommand(hook.command, command)) return [hook];
            if (keptManaged) return [];
            keptManaged = true;
            return [
              hook.command === command ? hook : { ...hook, command },
            ];
          });
          return hooks.length ? [{ ...group, hooks }] : [];
        });
        object(next.hooks).SessionStart = deduped;
        if (changed || JSON.stringify(deduped) !== JSON.stringify(groups))
          writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      } catch {
        errors.push("could not pin hook command");
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
      `hook ${p.action} incomplete; observed ${JSON.stringify(after)}`,
      [
        "Fix destination permissions, then run `k8s-axi setup status` and retry",
      ],
    );
  if (JSON.stringify(before) === JSON.stringify(after) && p.action === "hooks")
    return encodeObject({ ...after, changed: false });
  return encodeObject(after);
}
