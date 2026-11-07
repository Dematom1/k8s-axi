import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";

const routes: [string[], string[] | undefined, number?][] = [
  [["get", "pods", "-n", "fixtures"], ["pods", "-n", "fixtures"], 0],
  [
    ["get", "pod", "sample", "-n", "fixtures"],
    ["pods", "view", "sample", "-n", "fixtures"],
  ],
  [
    ["describe", "pod", "sample", "-n", "fixtures"],
    ["pods", "view", "sample", "-n", "fixtures"],
  ],
  [
    ["logs", "sample", "-n", "fixtures"],
    ["pods", "logs", "sample", "-n", "fixtures"],
  ],
  [
    ["rollout", "status", "deployment/broken", "-n", "fixtures"],
    ["deployments", "view", "broken", "-n", "fixtures"],
  ],
  [
    ["get", "deployments", "-n", "fixtures"],
    ["deployments", "-n", "fixtures"],
  ],
  [
    ["get", "jobs", "-n", "fixtures"],
    ["jobs", "-n", "fixtures"],
  ],
  [
    ["get", "secrets", "-n", "fixtures"],
    ["secrets", "-n", "fixtures"],
  ],
  [["get", "nodes"], ["nodes"]],
  [["get", "namespace", "fixtures"], undefined, 2],
  [
    ["get", "events", "-n", "fixtures"],
    ["events", "-n", "fixtures"],
  ],
  [["rollout", "restart", "deployment/web"], undefined, 1],
  [["top", "pods"], undefined, 2],
  [["describe", "configmap", "app-config"], undefined, 2],
];

test.each(routes)("kubectl argv %j", (typed, equivalent, expectedStatus) => {
  const environment = lab([
    { prefix: ["get", "namespace", "fixtures"], stdout: "namespace/fixtures" },
    ...targetRules(),
  ]);
  try {
    const result = cli(typed, environment.env);
    if (equivalent) {
      const expected = cli(equivalent, environment.env);
      expect(result.status).toBe(expectedStatus ?? expected.status);
      expect(result.stdout).toBe(expected.stdout);
    } else {
      expect(result.status).toBe(expectedStatus);
      expect(result.stdout).toContain(
        expectedStatus === 1 ? "REFUSED" : "VALIDATION_ERROR",
      );
      if (typed[0] === "get" || typed[0] === "describe")
        expect(result.stdout).toContain("k8s-axi");
    }
  } finally {
    environment.clean();
  }
});
