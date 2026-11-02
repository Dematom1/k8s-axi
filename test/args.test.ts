import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { REFUSALS } from "../src/registry.js";
import { parseArgs } from "../src/args.js";
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
    const p = cli(["pods", ...args]);
    expect(p.status).toBe(2);
    expect(p.stdout).toContain("VALIDATION_ERROR");
    expect(p.stderr).toBe("");
  });
for (const name of REFUSALS)
  test(`refuse ${name}`, () => {
    const p = cli(name.split(" "));
    expect(p.status).toBe(1);
    expect(p.stdout).toContain("REFUSED");
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
