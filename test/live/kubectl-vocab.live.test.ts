import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const liveTest = test.skipIf(process.env.K8S_AXI_LAB_LIVE !== "1");
const cliPath = resolve("dist/bin/k8s-axi.js");
function run(args: string[]) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { ...result, elapsed: Date.now() - started };
}

liveTest("kubectl read vocabulary routes to bounded diagnostics", () => {
  for (const args of [
    ["get", "pods", "-n", "fixtures"],
    ["describe", "deployment", "broken", "-n", "fixtures"],
  ]) {
    const result = run(args);
    expect(result.stdout).not.toContain("REFUSED");
    expect(result.stdout).not.toBe("");
  }

  const result = run([
    "rollout",
    "status",
    "deployment/broken",
    "-n",
    "fixtures",
    "--timeout",
    "20",
  ]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("ProgressDeadlineExceeded");
  expect(result.stdout).not.toContain("REFUSED");
  expect(result.elapsed).toBeLessThan(20_000);
});
