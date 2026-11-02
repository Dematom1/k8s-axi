import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSafe } from "../src/registry.js";
export interface Rule {
  prefix: string[];
  stdout?: string;
  stderr?: string;
  code?: number;
  delayMs?: number;
  mode?: string;
}
export function lab(
  rules: Rule[] = [],
  fallback: Omit<Rule, "prefix"> = { stdout: '{"items":[]}' },
) {
  const dir = mkdtempSync(join(tmpdir(), "k8s-axi-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "home"));
  writeFileSync(
    join(bin, "kubectl"),
    `#!/bin/sh\nexec '${process.execPath}' '${resolve("test/fake-kubectl/runner.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "scenario"),
    JSON.stringify({ rules, default: fallback }),
  );
  writeFileSync(join(dir, "calls"), "");
  const env = {
    PATH: bin,
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "home/.config"),
    XDG_CACHE_HOME: join(dir, "home/.cache"),
    K8S_AXI_SCENARIO: join(dir, "scenario"),
    K8S_AXI_CALLS: join(dir, "calls"),
    K8S_AXI_PID: join(dir, "pid"),
  };
  return {
    dir,
    env,
    calls: () =>
      readFileSync(join(dir, "calls"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => {
          const v = JSON.parse(x);
          assertSafe(v.args);
          return v;
        }),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
export function targetRules(): Rule[] {
  return [
    { prefix: ["config", "get-contexts"], stdout: "default\nctx:/@\n" },
    { prefix: ["config", "current-context"], stdout: "default\n" },
    { prefix: ["config", "view"], stdout: "https://cluster.invalid\nsandbox" },
    {
      prefix: ["version"],
      stdout: '{"clientVersion":{"minor":"36"},"serverVersion":{"minor":"32"}}',
    },
    { prefix: ["get", "namespace"], stdout: "namespace/sandbox" },
  ];
}
