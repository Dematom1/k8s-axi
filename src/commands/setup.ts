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
import { object } from "../kubectl.js";
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
      }
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "ENOENT")
        continue;
      fail("CONFIG_INVALID", `cannot read or parse hook destination ${file}`);
    }
  }
  return {
    claude: s.claude.installed ? "installed" : "absent",
    codex:
      s.codex.installed && s.codex.userFeatureEnabled
        ? "installed"
        : s.codex.installed
          ? "partial"
          : "absent",
    opencode: s.opencode.installed ? "installed" : "absent",
    sessionEnd: sessionEndHookStatus() ? "installed" : "absent",
  };
}
export async function setupCommand(p: Parsed): Promise<string> {
  if (!["hooks", "status", "uninstall"].includes(p.action))
    usage("choose setup hooks, setup status or setup uninstall", "setup");
  const before = hookStatus();
  if (p.action === "status") return encodeObject(before);
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
    if (
      Object.values(before).every((x) => x === "installed") &&
      [observed.claude.path, observed.codex.path].every((file) =>
        readFileSync(file, "utf8").includes(JSON.stringify(command)),
      ) &&
      readFileSync(observed.opencode.path, "utf8").includes(
        JSON.stringify(entry),
      ) &&
      readFileSync(observed.claude.path, "utf8").includes(
        join(dirname(entry), "k8s-axi.js"),
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
        if (changed) writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
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
