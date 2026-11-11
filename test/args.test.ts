import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { REFUSALS } from "../src/registry.js";
import { parseArgs } from "../src/args.js";
import { lab } from "./lab.js";
for (const args of [
  ["--limit", "10junk"],
  ["--limit", "-5"],
  ["--limit", "0"],
  ["--limit", "1e3"],
  ["--namespace", "--context", "x"],
  ["-n", "-A"],
  ["-A", "-n", "x"],
  ["--namespace="],
  ["-n", "x", "-n", "y"],
  ["nonsense"],
  ["--"],
  ["view", "UPPER"],
  ["logs", "p", "--since", "10"],
  ["--selector", "-x"],
  ["constructor"],
  ["__proto__"],
])
  test(`reject ${args.join(" ")}`, () => {
    const l = lab();
    try {
      const p = cli(["pods", ...args], l.env);
      expect(p.status).toBe(2);
      expect(p.stdout).toContain("VALIDATION_ERROR");
      expect(p.stderr).toBe("");
      expect(l.calls()).toHaveLength(0);
    } finally {
      l.clean();
    }
  });
for (const name of REFUSALS)
  test(`refuse ${name}`, () => {
    const l = lab();
    try {
      const p = cli(name.split(" "), l.env);
      expect(p.status).toBe(1);
      expect(p.stdout).toContain("REFUSED");
      expect(l.calls()).toHaveLength(0);
    } finally {
      l.clean();
    }
  });
test("typed scope and whole values", () => {
  expect(parseArgs("pods", ["-A", "--limit", "15"]).all).toBe(true);
});
for (const [flag, hint] of [
  ["--follow", "Nothing streams"],
  ["--json", "TOON"],
  ["--reveal", "never shown"],
  ["--kubeconfig", "KUBECONFIG"],
  ["--token", "configured"],
])
  test(`hint ${flag}`, () =>
    expect(cli(["pods", flag ?? ""]).stdout).toContain(hint));
for (const args of [
  ["pods", "--bogus", "--help"],
  ["nodes", "--bogus=1", "-h"],
  ["--bogus", "--help"],
])
  test(`help wins over invalid flag: ${args.join(" ")}`, () => {
    const p = cli(args);
    expect(p.status).toBe(0);
    expect(p.stdout).not.toContain("VALIDATION_ERROR");
    expect(p.data).toHaveProperty("flags");
  });
