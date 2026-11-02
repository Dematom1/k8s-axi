import { test, expect } from "vitest";
import { verdict, complete, CHECK_NAMES, type Check } from "../src/checks.js";
import type { Row } from "../src/render.js";
import { skewWarning } from "../src/skew.js";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
for (let mask = 0; mask < 128; mask++)
  test(`failure subset ${mask}`, () => {
    const checks: Check<Row[]>[] = CHECK_NAMES.map((name, i) =>
      mask & (1 << i)
        ? { name, state: "failed", code: "FORBIDDEN", reason: "denied" }
        : { name, state: "ok", value: [] },
    );
    const v = verdict(checks);
    expect(v === "healthy").toBe(mask === 0);
    expect(complete(v)).toBe(mask === 0);
  });
for (const mode of ["healthy", "partial", "unknown", "problems"])
  test(`triage ${mode}`, () => {
    const fallback =
      mode === "unknown"
        ? { stderr: "dial tcp", code: 1 }
        : { stdout: '{"items":[]}' };
    const extra =
      mode === "partial"
        ? [
            {
              prefix: ["get", "deployments.apps"],
              stderr: "forbidden:",
              code: 1,
            },
          ]
        : mode === "problems"
          ? [
              {
                prefix: ["get", "pods"],
                stdout: JSON.stringify({
                  items: [
                    {
                      metadata: { name: "failed", namespace: "ns" },
                      status: { phase: "Failed" },
                    },
                  ],
                }),
              },
            ]
          : [];
    const l = lab([...extra, ...targetRules()], fallback);
    try {
      for (const args of [[], ["triage"]]) {
        const p = cli(args, l.env);
        expect(p.status).toBe(["partial", "unknown"].includes(mode) ? 1 : 0);
        expect(p.stdout).toContain(
          "status: " + (mode === "healthy" ? "healthy" : mode),
        );
        if (mode !== "healthy") expect(p.stdout).not.toContain("healthy");
        if (mode === "partial") expect(p.stdout).toContain("complete: false");
      }
    } finally {
      l.clean();
    }
  });
test("missing context and namespace are decisive", () => {
  const l = lab([
    {
      prefix: ["get", "namespace", "missing"],
      stderr: "Error from server (NotFound)",
      code: 1,
    },
    ...targetRules(),
  ]);
  try {
    const p = cli(["triage", "--context", "axi-definitely-missing"], l.env);
    expect(p.status).toBe(1);
    expect(p.stdout).toContain("CONTEXT_NOT_FOUND");
    expect(p.stdout).not.toContain("healthy");
    expect(l.calls().some((c) => c.args[0] === "get")).toBe(false);
    expect(cli(["triage", "-n", "missing"], l.env).stdout).toContain(
      "NAMESPACE_NOT_FOUND",
    );
  } finally {
    l.clean();
  }
});
test("skew rule", () => {
  expect(skewWarning("36", "32")).toContain("exceeds one");
  expect(skewWarning("33", "32")).toBeUndefined();
  expect(skewWarning("32", "32")).toBeUndefined();
});
