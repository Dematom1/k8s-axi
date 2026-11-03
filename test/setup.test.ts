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
    duplicateSettings.hooks.SessionStart.push(
      structuredClone(
        duplicateSettings.hooks.SessionStart.find(
          (group: { hooks: { command: string }[] }) =>
            group.hooks.some((hook) => hook.command.includes("k8s-axi")),
        ),
      ),
    );
    writeFileSync(settings, JSON.stringify(duplicateSettings));
    expect(cli(["setup", "hooks"], l.env).status).toBe(0);
    const repaired = JSON.parse(readFileSync(settings, "utf8"));
    expect(
      repaired.hooks.SessionStart.flatMap(
        (group: { hooks: { command: string }[] }) => group.hooks,
      ).filter((hook: { command: string }) => hook.command.includes("k8s-axi")),
    ).toHaveLength(1);
    symlinkSync(process.execPath, join(l.env.PATH, "node"));
    const hooks = JSON.parse(installed).hooks;
    const start = hooks.SessionStart.flatMap(
      (g: { hooks: { command: string }[] }) => g.hooks,
    ).find((h: { command: string }) => h.command.includes("k8s-axi")).command;
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
