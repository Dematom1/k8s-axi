import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";

const routes: [string[], string[] | undefined, string[]?, number?][] = [
  [
    ["get", "pods", "-n", "fixtures"],
    ["pods", "-n", "fixtures"],
    ["get", "pods"],
    0,
  ],
  [
    ["get", "pod", "sample", "-n", "fixtures"],
    ["pods", "view", "sample", "-n", "fixtures"],
    ["get", "pod", "sample"],
  ],
  [
    ["describe", "pod", "sample", "-n", "fixtures"],
    ["pods", "view", "sample", "-n", "fixtures"],
    ["get", "pod", "sample"],
  ],
  [
    ["logs", "sample", "-n", "fixtures"],
    ["pods", "logs", "sample", "-n", "fixtures"],
    ["logs", "sample"],
  ],
  [
    ["rollout", "status", "deployment/broken", "-n", "fixtures"],
    ["deployments", "view", "broken", "-n", "fixtures"],
    ["get", "deployment.apps", "broken"],
  ],
  [
    ["get", "deployments", "-n", "fixtures"],
    ["deployments", "-n", "fixtures"],
    ["get", "deployments.apps"],
  ],
  [
    ["get", "jobs", "-n", "fixtures"],
    ["jobs", "-n", "fixtures"],
    ["get", "jobs.batch"],
  ],
  [
    ["get", "secrets", "-n", "fixtures"],
    ["secrets", "-n", "fixtures"],
    ["get", "secrets"],
  ],
  [["get", "nodes"], ["nodes"], ["get", "nodes"]],
  [["get", "namespace", "fixtures"], undefined, undefined, 2],
  [["get", "ns", "fixtures"], undefined, undefined, 2],
  [["get", "namespaces", "fixtures"], undefined, undefined, 2],
  [["rollout", "status", "statefulset/web"], undefined, undefined, 2],
  [
    ["get", "events", "-n", "fixtures"],
    ["events", "-n", "fixtures"],
    ["get", "events"],
  ],
  [["rollout", "restart", "deployment/web"], undefined, undefined, 1],
  [["top", "pods"], undefined, undefined, 2],
  [["describe", "configmap", "app-config"], undefined, undefined, 2],
];

test.each(routes)(
  "kubectl argv %j",
  (typed, equivalent, expectedCall, expectedStatus) => {
    const environment = lab([
      {
        prefix: ["get", "namespace", "fixtures"],
        stdout: "namespace/fixtures",
      },
      {
        prefix: ["get", "pod", "sample"],
        stdout: JSON.stringify({
          metadata: { name: "sample" },
          spec: { containers: [{ name: "app" }] },
        }),
      },
      { prefix: ["logs", "sample"], stdout: "sample log line\n" },
      ...targetRules(),
    ]);
    try {
      const result = cli(typed, environment.env);
      if (equivalent) {
        expect(result.status).not.toBe(2);
        expect(result.stdout).not.toContain("REFUSED");
        expect(environment.calls().map(({ args }) => args)).toContainEqual(
          expectedCall,
        );
        if (expectedStatus !== undefined)
          expect(result.status).toBe(expectedStatus);
        if (typed.join(" ") === "get pods -n fixtures") {
          expect(result.status).toBe(0);
          expect(environment.calls().map(({ args }) => args)).toContainEqual([
            "get",
            "pods",
            "-n",
            "fixtures",
          ]);
          expect(result.stdout).toBe(
            cli(["pods", "-n", "fixtures"], environment.env).stdout,
          );
        }
      } else {
        expect(result.status).toBe(expectedStatus);
        expect(result.stdout).toContain(
          expectedStatus === 1 ? "REFUSED" : "VALIDATION_ERROR",
        );
      }
    } finally {
      environment.clean();
    }
  },
);
