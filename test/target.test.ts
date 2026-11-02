import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
import { resolveScope, scoped, resolveTarget } from "../src/target.js";
import { parseArgs } from "../src/args.js";
import { deadline } from "../src/registry.js";
for (const context of ["missing", "ctx:/@"])
  test(`context ${context}`, () => {
    const l = lab(targetRules());
    try {
      const p = cli(["ctx", "--context", context], l.env);
      expect(p.status).toBe(context === "missing" ? 1 : 0);
      if (context === "missing")
        expect(p.stdout).toContain("CONTEXT_NOT_FOUND");
      expect(
        l
          .calls()
          .every(
            (x) =>
              ["config", "version"].includes(x.args[0]) &&
              !x.args.includes("--request-timeout=15000ms"),
          ),
      ).toBe(true);
    } finally {
      l.clean();
    }
  });
test("no current context", () => {
  const l = lab([
    {
      prefix: ["config", "current-context"],
      stderr: "current-context is not set",
      code: 1,
    },
    ...targetRules(),
  ]);
  try {
    expect(cli(["ctx"], l.env).stdout).toContain("NO_CONTEXT");
  } finally {
    l.clean();
  }
});
for (const [kind, rows, code] of [
  ["found", [], null],
  ["missing", [], "NAMESPACE_NOT_FOUND"],
  ["forbidden", [{}], null],
  ["forbidden", [], "NAMESPACE_UNVERIFIED"],
  ["network", [{}], "SERVER_UNREACHABLE"],
] as const)
  test(`scope ${kind} ${rows.length}`, async () => {
    const rule = {
      prefix: ["get", "namespace"],
      stdout: kind === "found" ? "namespace/sandbox" : "",
      stderr:
        kind === "missing"
          ? "Error from server (NotFound)"
          : kind === "forbidden"
            ? "forbidden:"
            : kind === "network"
              ? "dial tcp"
              : "",
      code: kind === "found" ? 0 : 1,
    };
    const l = lab([rule, ...targetRules()]);
    const before = { ...process.env };
    Object.assign(process.env, l.env);
    try {
      const d = deadline();
      const t = await resolveTarget(undefined, d);
      const scope = resolveScope(parseArgs("pods", []), t);
      const result = scoped(scope, t, d, async () => [...rows]);
      if (code) await expect(result).rejects.toMatchObject({ code });
      else await expect(result).resolves.toHaveLength(rows.length);
      expect(
        l
          .calls()
          .filter((c) => c.args[0] === "get")
          .every((c) => c.args.includes("--context=default")),
      ).toBe(true);
    } finally {
      process.env = before;
      l.clean();
    }
  });
test("namespaces forbidden", () => {
  const l = lab([
    { prefix: ["get", "namespaces"], stderr: "forbidden:", code: 1 },
    ...targetRules(),
  ]);
  try {
    expect(cli(["namespaces"], l.env).stdout).toContain("FORBIDDEN");
  } finally {
    l.clean();
  }
});
