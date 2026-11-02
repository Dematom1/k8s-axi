import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cli } from "./helpers.js";
import { VERSION } from "../src/version.js";
test("metadata and packed boundary", () => {
  const p = JSON.parse(readFileSync("package.json", "utf8"));
  expect(p.repository.url).toBe("git+https://github.com/Dematom1/k8s-axi.git");
  expect(p.homepage).toBe("https://github.com/Dematom1/k8s-axi#readme");
  expect(p.bugs.url).toBe("https://github.com/Dematom1/k8s-axi/issues");
  expect(p.publishConfig.access).toBe("public");
  const pack = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { encoding: "utf8" },
  );
  expect(pack.status).toBe(0);
  for (const f of JSON.parse(pack.stdout)[0].files)
    expect(f.path).not.toMatch(/^(test|src|\.claude)\//);
});
test("version, help, unknown command", () => {
  expect(cli(["--version"]).stdout).toBe(`${VERSION}\n`);
  expect(cli(["--help"]).status).toBe(0);
  expect(cli(["nonsense"]).status).toBe(2);
  expect(
    cli([], { PATH: "", KUBECONFIG: "/nonexistent/k8s-axi-test" }).status,
  ).toBe(1);
});
