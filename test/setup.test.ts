import { test, expect } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  statSync,
  symlinkSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cli } from "./helpers.js";
import { lab } from "./lab.js";
function tree(path: string, mode: number) {
  if (!existsSync(path)) return;
  if (mode === 0o700) chmodSync(path, mode);
  if (statSync(path).isDirectory())
    for (const n of readdirSync(path)) tree(join(path, n), mode);
  chmodSync(path, mode);
}
test("opt-in hooks are absolute, executable, idempotent and uninstall preserves others", () => {
  const l = lab();
  const settings = join(l.env.HOME, ".claude/settings.json");
  try {
    mkdirSync(join(l.env.HOME, ".claude"));
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo unrelated" }] },
          ],
        },
      }),
    );
    expect(cli(["setup", "hooks"], l.env).status).toBe(0);
    const installed = readFileSync(settings, "utf8"),
      mtime = statSync(settings).mtimeMs;
    expect(cli(["setup", "hooks"], l.env).status).toBe(0);
    expect(statSync(settings).mtimeMs).toBe(mtime);
    const duplicateSettings = JSON.parse(installed);
    const managedCommand = `'${process.execPath.replaceAll("'", "'\\''")}' '${resolve(
      process.env.K8S_AXI_TEST_PACKAGE ?? ".",
      "dist/bin/k8s-axi-ctx.js",
    ).replaceAll("'", "'\\''")}'`;
    duplicateSettings.hooks.SessionStart[0].hooks.push(
      { type: "command", command: "echo foreign deployment" },
      {
        type: "command",
        command:
          "'/old/node' '/old/node_modules/k8s-axi/dist/bin/k8s-axi-ctx.js'",
      },
      { type: "command", command: "k8s-axi-ctx" },
    );
    const duplicateGroup = structuredClone(
      duplicateSettings.hooks.SessionStart.find(
        (group: { hooks: { command: string }[] }) =>
          group.hooks.some((hook) => hook.command === managedCommand),
      ),
    );
    duplicateSettings.hooks.SessionStart.push(duplicateGroup, {
      ...duplicateGroup,
      matcher: "startup",
    });
    writeFileSync(settings, JSON.stringify(duplicateSettings));
    const repair = cli(["setup", "hooks"], l.env);
    expect(
      repair.status,
      `${repair.stdout}\n${readFileSync(settings, "utf8")}`,
    ).toBe(0);
    expect(repair.stdout).not.toContain("changed: false");
    const repaired = JSON.parse(readFileSync(settings, "utf8"));
    const repairedCommands = repaired.hooks.SessionStart.flatMap(
      (group: { hooks: { command: string }[] }) => group.hooks,
    ).map((hook: { command: string }) => hook.command);
    expect(
      repairedCommands.filter((hook: string) => hook === managedCommand),
    ).toHaveLength(1);
    expect(repairedCommands).toContain("echo foreign deployment");
    expect(
      repaired.hooks.SessionStart.some(
        (group: { matcher?: string; hooks: { command: string }[] }) =>
          group.matcher === undefined &&
          group.hooks.some((hook) => hook.command === managedCommand),
      ),
    ).toBe(true);
    expect(repairedCommands).not.toContain(
      "'/old/node' '/old/node_modules/k8s-axi/dist/bin/k8s-axi-ctx.js'",
    );
    expect(repairedCommands).not.toContain("k8s-axi-ctx");
    symlinkSync(process.execPath, join(l.env.PATH, "node"));
    const hooks = JSON.parse(installed).hooks;
    const start = hooks.SessionStart.flatMap(
      (g: { hooks: { command: string }[] }) => g.hooks,
    ).find((h: { command: string }) => h.command === managedCommand).command;
    const run = spawnSync("/bin/sh", ["-c", start], {
      cwd: l.dir,
      env: { ...process.env, ...l.env },
      input: "{}",
      encoding: "utf8",
      timeout: 10000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("context");
    expect(run.stdout).not.toContain("healthy");
    expect(l.calls().length).toBeGreaterThan(0);
    expect(
      l.calls().every((c) => ["config", "version"].includes(c.args[0])),
    ).toBe(true);
    const transcript = join(l.dir, "transcript");
    writeFileSync(
      transcript,
      JSON.stringify({
        message: {
          content: [
            {
              type: "tool_use",
              input: {
                command:
                  "k8s-axi pods --context default --selector password=CANARY",
              },
            },
          ],
        },
      }) + "\n",
    );
    const end = hooks.SessionEnd[0].hooks[0].command;
    const recorded = spawnSync("/bin/sh", ["-c", end], {
      cwd: l.dir,
      env: { ...process.env, ...l.env },
      input: JSON.stringify({ cwd: l.dir, transcript_path: transcript }),
      encoding: "utf8",
      timeout: 10000,
    });
    expect(recorded.status).toBe(0);
    expect(recorded.stdout).toContain("pods 1");
    const memory = readFileSync(
      join(l.env.XDG_CONFIG_HOME, "k8s-axi/sessions.json"),
      "utf8",
    );
    expect(memory).not.toContain("CANARY");
    expect(memory).not.toContain("selector");
    expect(cli(["setup", "uninstall"], l.env).status).toBe(0);
    expect(readFileSync(settings, "utf8")).toContain("echo unrelated");
    expect(readFileSync(settings, "utf8")).not.toContain("k8s-axi");
    expect(cli(["setup", "status"], l.env).stdout).toContain("absent");
  } finally {
    l.clean();
  }
});
for (const dir of [".claude", ".codex", ".config", "all"])
  for (const action of ["hooks", "uninstall", "status"])
    test.skipIf(process.getuid?.() === 0)(`denied ${dir} ${action}`, () => {
      const l = lab();
      try {
        if (action !== "hooks")
          expect(cli(["setup", "hooks"], l.env).status).toBe(0);
        const dirs = dir === "all" ? [".claude", ".codex", ".config"] : [dir];
        for (const d of dirs) {
          const path = join(l.env.HOME, d);
          mkdirSync(path, { recursive: true });
          tree(path, action === "status" ? 0o000 : 0o500);
        }
        const p = cli(["setup", action], l.env);
        expect(p.status, p.stdout).toBe(1);
        expect(p.stdout).toContain("CONFIG_INVALID");
        expect(p.stderr).toBe("");
      } finally {
        for (const d of [".claude", ".codex", ".config"])
          tree(join(l.env.HOME, d), 0o700);
        l.clean();
      }
    });
test("Claude hooks use CLAUDE_CONFIG_DIR settings", () => {
  const l = lab();
  const configDir = join(l.dir, "custom-claude");
  const settings = join(configDir, "settings.json");
  mkdirSync(configDir);
  const userHook = { type: "command", command: "echo k8s-axi" };
  const unrelatedHook = {
    type: "command",
    command: "/opt/other/k8s-axi-ctx.js",
  };
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [userHook, unrelatedHook] }] },
    }),
  );
  const env = { ...l.env, CLAUDE_CONFIG_DIR: configDir };
  try {
    const installed = cli(["setup", "hooks"], env);
    expect(installed.status, installed.stdout).toBe(0);
    const count = (file: string) =>
      (JSON.parse(readFileSync(file, "utf8")).hooks?.SessionStart ?? [])
        .flatMap((group: { hooks: { command: string }[] }) => group.hooks)
        .filter(
          (hook: { command: string }) =>
            hook.command === "k8s-axi-ctx" ||
            (hook.command.includes("/k8s-axi/") &&
              hook.command.includes("/k8s-axi-ctx.js")),
        ).length;
    const defaultSettings = join(l.env.HOME, ".claude/settings.json");
    expect(count(settings)).toBe(1);
    expect(count(defaultSettings), readFileSync(defaultSettings, "utf8")).toBe(
      1,
    );
    expect(readFileSync(settings, "utf8")).toContain("echo k8s-axi");
    expect(readFileSync(settings, "utf8")).toContain(
      "/opt/other/k8s-axi-ctx.js",
    );
    expect(cli(["setup", "status"], env).stdout).toContain(
      "sessionEnd: installed",
    );
    expect(cli(["setup", "uninstall"], env).status).toBe(0);
    expect(count(settings)).toBe(0);
    expect(count(defaultSettings)).toBe(0);
    expect(readFileSync(settings, "utf8")).toContain("echo k8s-axi");
    expect(readFileSync(settings, "utf8")).toContain(
      "/opt/other/k8s-axi-ctx.js",
    );
    expect(cli(["setup", "status"], env).stdout).toContain(
      "sessionEnd: absent",
    );
  } finally {
    l.clean();
  }
});
test("setup creates a missing custom Claude settings directory", () => {
  const l = lab();
  const configDir = join(l.dir, "missing-claude");
  const settings = join(configDir, "settings.json");
  try {
    const result = cli(["setup", "hooks"], {
      ...l.env,
      CLAUDE_CONFIG_DIR: configDir,
    });
    expect(result.status, result.stdout).toBe(0);
    const value = JSON.parse(readFileSync(settings, "utf8"));
    expect(value.hooks.SessionStart).toHaveLength(1);
    expect(value.hooks.SessionEnd).toHaveLength(1);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(settings).mode & 0o777).toBe(0o600);
    expect(
      cli(["setup", "status"], { ...l.env, CLAUDE_CONFIG_DIR: configDir })
        .stdout,
    ).toContain("sessionEnd: installed");
    expect(
      cli(["setup", "uninstall"], { ...l.env, CLAUDE_CONFIG_DIR: configDir })
        .status,
    ).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({});
    expect(
      cli(["setup", "status"], { ...l.env, CLAUDE_CONFIG_DIR: configDir })
        .stdout,
    ).toContain("sessionEnd: absent");
  } finally {
    l.clean();
  }
});
test("invalid nested settings fail, ctx missing kubectl remains harmless", () => {
  const l = lab();
  try {
    mkdirSync(join(l.env.HOME, ".claude"));
    writeFileSync(join(l.env.HOME, ".claude/settings.json"), "null");
    expect(cli(["setup", "status"], l.env).stdout).toContain("CONFIG_INVALID");
    const p = spawnSync(
      process.execPath,
      [
        resolve(
          process.env.K8S_AXI_TEST_PACKAGE ?? ".",
          "dist/bin/k8s-axi-ctx.js",
        ),
      ],
      { env: { ...process.env, ...l.env, PATH: l.dir }, encoding: "utf8" },
    );
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("KUBECTL_NOT_INSTALLED");
    expect(p.stdout).not.toContain("healthy");
  } finally {
    l.clean();
  }
});
