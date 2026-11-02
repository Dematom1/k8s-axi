import { test, expect } from "vitest";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSkillMarkdown } from "../src/skill.js";
import { COMMAND_LINES } from "../src/help.js";
import { CODES } from "../src/errors.js";
import { cli } from "./helpers.js";
test("skill is deterministic and rejects one-character drift", () => {
  const expected = createSkillMarkdown(),
    actual = readFileSync("skills/k8s-axi/SKILL.md", "utf8");
  expect(actual).toBe(expected);
  expect(actual + "x").not.toBe(expected);
  const dir = mkdtempSync(join(tmpdir(), "k8s-skill-"));
  try {
    cpSync("dist", join(dir, "dist"), { recursive: true });
    symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    mkdirSync(join(dir, "skills/k8s-axi"), { recursive: true });
    writeFileSync(join(dir, "skills/k8s-axi/SKILL.md"), actual + "x");
    const p = spawnSync(
      process.execPath,
      [join(dir, "dist/scripts/build-skill.js"), "--check"],
      { encoding: "utf8" },
    );
    expect(p.status).toBe(1);
    expect(p.stderr).toContain("is stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(actual).toMatch(/^---\nname: k8s-axi\n/);
  expect(actual).toContain("npx -y k8s-axi");
  expect(actual).not.toContain("https://cluster");
});
for (const line of COMMAND_LINES)
  test(`help ${line}`, () => {
    const args = (line.split(":")[0] ?? "")
      .split(" ")
      .filter((x) => !x.startsWith("<"));
    const p = cli([...args, "--help"], { PATH: "" });
    expect(p.status, p.stdout).toBe(0);
  });
test("README codes match authority and prose has no em dash", () => {
  const md = readFileSync("README.md", "utf8");
  for (const code of CODES)
    expect(md).toMatch(new RegExp(String.raw`\| ${code}\s+\|`));
  expect(md).not.toContain("—");
});
