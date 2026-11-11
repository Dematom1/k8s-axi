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
// --help wins wherever invalid input sits; the route is the first action word
// after skipping unknown flags and the values of known flags.
for (const [args, command] of [
  [["pods", "--help"], "k8s-axi pods"],
  [["pods", "view", "nginx", "--help"], "k8s-axi pods view"],
  [["pods", "--bogus", "--help"], "k8s-axi pods"],
  [["pods", "--bogus", "value", "--help"], "k8s-axi pods"],
  [["pods", "--bogus", "view", "nginx", "--help"], "k8s-axi pods view"],
  [
    ["pods", "--bogus", "value", "view", "nginx", "--help"],
    "k8s-axi pods view",
  ],
  [["pods", "view", "--bogus", "nginx", "--help"], "k8s-axi pods view"],
  [["pods", "view", "nginx", "--bogus", "--help"], "k8s-axi pods view"],
  [["pods", "view", "logs", "--bogus", "--help"], "k8s-axi pods view"],
  [
    ["pods", "view", "nginx", "--limit=0", "--bogus", "--help"],
    "k8s-axi pods view",
  ],
  [
    ["pods", "--bogus", "value", "view", "nginx", "--limit=0", "--help"],
    "k8s-axi pods view",
  ],
  [["pods", "--bogus", "logs", "-h"], "k8s-axi pods logs"],
  [["pods", "--bogus=1", "view", "nginx", "-h"], "k8s-axi pods view"],
  [["pods", "-n", "view", "--help"], "k8s-axi pods"],
  [["pods", "--help", "--bogus", "view"], "k8s-axi pods view"],
  [["nodes", "--bogus=1", "-h"], "k8s-axi nodes"],
  [["--bogus", "--help"], "k8s-axi home"],
] as const)
  test(`help wins over invalid input: ${args.join(" ")}`, () => {
    const p = cli([...args]);
    expect(p.status).toBe(0);
    expect(p.stdout).not.toContain("VALIDATION_ERROR");
    expect(p.data).toMatchObject({ command });
  });
