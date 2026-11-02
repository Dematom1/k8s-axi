import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
import { nodeSpec } from "../src/model/nodes.js";
import { podSpec } from "../src/model/pods.js";
import { eventSpec } from "../src/model/events.js";
import { workloadSpecs } from "../src/model/workloads.js";
import { serviceSpec } from "../src/model/services.js";
import { secretSpec } from "../src/model/secrets.js";
import { object } from "../src/kubectl.js";
test("every default resource schema stays within four columns", () => {
  for (const spec of [
    nodeSpec,
    podSpec,
    eventSpec,
    ...Object.values(workloadSpecs),
    serviceSpec,
    secretSpec,
  ])
    expect(spec.defaults.length).toBeLessThanOrEqual(4);
});
test("version uses the Node startup floor, without loading commands", () => {
  function median(args: string[]) {
    return (
      Array.from({ length: 5 }, () => {
        const t = performance.now();
        const p = spawnSync(process.execPath, args, {
          encoding: "utf8",
          env: { ...process.env, PATH: "" },
        });
        expect(p.status).toBe(0);
        return performance.now() - t;
      }).sort((a, b) => a - b)[2] ?? 0
    );
  }
  const baseline = median(["-e", 'process.stdout.write("0.1.0\\n")']),
    version = median([
      resolve(process.env.K8S_AXI_TEST_PACKAGE ?? ".", "dist/bin/k8s-axi.js"),
      "--version",
    ]);
  expect(version).toBeLessThan(baseline * 3 + 40);
});
test("bounded log cut and previous error are explicit", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  for (const previous of [false, true]) {
    const l = lab([
      { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
      {
        prefix: ["logs"],
        ...(previous
          ? { stderr: "previous terminated container c not found", code: 1 }
          : { stdout: "x".repeat(1048576) }),
      },
      ...targetRules(),
    ]);
    try {
      const p = cli(
        ["pods", "logs", "p", ...(previous ? ["--previous"] : [])],
        l.env,
      );
      expect(p.status).toBe(previous ? 1 : 0);
      if (previous)
        expect(p.stdout).toContain("no previous terminated container");
      else expect(object(p.data)["byte-limited"]).toBe(true);
    } finally {
      l.clean();
    }
  }
});
