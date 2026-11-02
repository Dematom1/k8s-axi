import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { load } from "js-yaml";
import { object, objects, text } from "../src/kubectl.js";
function workflow(name: string) {
  return object(
    load(readFileSync(".github/workflows/" + name + ".yml", "utf8")),
  );
}
function assertPublishGate(value: unknown) {
  const jobs = object(object(value).jobs),
    publish = object(jobs.publish),
    build = object(jobs.build),
    release = object(jobs["release-please"]);
  expect(publish.needs).toBe("build");
  expect(publish.if).toBe(
    "${{ !cancelled() && needs.build.result == 'success' }}",
  );
  expect(publish.environment).toBe("npm-publish");
  expect(object(publish.permissions)["id-token"]).toBe("write");
  expect(release.permissions).toEqual({});
  const steps = objects(publish.steps);
  expect(steps.some((s) => text(s.uses).startsWith("actions/checkout"))).toBe(
    false,
  );
  expect(steps.some((s) => /npm (?:ci|install)/.test(text(s.run)))).toBe(false);
  expect(steps.map((s) => s.run).join("\n")).toContain(
    'npm stage publish "./$TARBALL" --access public --provenance --ignore-scripts',
  );
  expect(JSON.stringify(publish)).toContain("11.15.0");
  expect(object(build.permissions)["id-token"]).toBeUndefined();
  expect(JSON.stringify(build)).toContain("publish_current");
  const all = JSON.stringify(build);
  expect(all.indexOf("npm pkg set gitHead")).toBeLessThan(
    all.indexOf("npm pack"),
  );
  expect(all.indexOf("npm pack")).toBeLessThan(
    all.indexOf("JSON.parse(text).gitHead"),
  );
  expect(all.indexOf("JSON.parse(text).gitHead")).toBeLessThan(
    all.indexOf("actions/upload-artifact"),
  );
  for (const [name, job] of Object.entries(jobs))
    if (name !== "publish")
      expect(object(object(job).permissions)["id-token"]).toBeUndefined();
}
test("release boundaries and manual dispatch gate", () => {
  const w = workflow("release-please");
  assertPublishGate(w);
  const broken = structuredClone(w);
  object(object(broken.jobs).publish).if = undefined;
  expect(() => assertPublishGate(broken)).toThrow();
});
test("all action refs pinned and triggers safe", () => {
  for (const f of readdirSync(".github/workflows")) {
    const raw = readFileSync(".github/workflows/" + f, "utf8");
    expect(raw).not.toContain("pull_request_target");
    for (const m of raw.matchAll(/uses:\s*(\S+)/g))
      expect(m[1]).toMatch(/@[a-f0-9]{40}$/);
  }
  expect(
    readFileSync(".github/workflows/no-mistakes-required.yml", "utf8"),
  ).toContain("@f6441c96c352a18b9cadcaef6b6c7017e9ac3970");
});
test("CI covers hosts runtimes pinned clients and archive", () => {
  const raw = readFileSync(".github/workflows/ci.yml", "utf8");
  for (const s of [
    "ubuntu-latest",
    "macos-latest",
    "node: [22, 24]",
    "v1.32.0",
    "v1.36.2",
    "K8S_AXI_REQUIRE_REAL_KUBECTL",
    "--ignore-scripts",
    "KUBECONFIG",
  ])
    expect(raw).toContain(s);
});
