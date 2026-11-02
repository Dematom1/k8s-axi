import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
import { SECRET_TEMPLATE } from "../src/registry.js";
import { parseSecrets } from "../src/model/secrets.js";
test("only exact projected Secret read", () => {
  const raw =
    JSON.stringify([
      "sandbox",
      "s",
      "Opaque",
      "2020-01-01T00:00:00Z",
      ["tls.crt", "weird_key-1.x"],
    ]) +
    "\n" +
    JSON.stringify(["sandbox", "empty", "Opaque", "2020-01-01T00:00:00Z", []]);
  const l = lab([
    {
      prefix: [
        "get",
        "secrets",
        "-n",
        "sandbox",
        "--field-selector=metadata.name=absent",
      ],
      stdout: "",
    },
    { prefix: ["get", "secrets"], stdout: raw },
    ...targetRules(),
  ]);
  try {
    const a = cli(["secrets", "view", "s"], l.env),
      b = cli(["secrets", "view", "s", "--full"], l.env);
    expect(a.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("never shown");
    expect(a.stdout).toContain("tls.crt");
    expect(cli(["secrets", "view", "absent"], l.env).stdout).toContain(
      "NOT_FOUND",
    );
    for (const c of l.calls().filter((c) => c.args[1] === "secrets"))
      expect(c.args).toContain("--output=go-template=" + SECRET_TEMPLATE);
  } finally {
    l.clean();
  }
  expect(() =>
    parseSecrets(String.raw`["ns","name","type","date",["\xFF"]]`),
  ).toThrow();
  expect(parseSecrets('["n","empty","Opaque","",[]]')[0]?.keys).toEqual([]);
});
