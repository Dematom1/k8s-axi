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
    ["rollout", "status", "deployment/healthy", "-n", "fixtures"],
    ["deployments", "view", "healthy", "-n", "fixtures"],
    ["get", "deployment.apps", "healthy"],
    0,
  ],
  [
    ["rollout", "status", "deployment/old", "-n", "fixtures"],
    ["deployments", "view", "old", "-n", "fixtures"],
    ["get", "deployment.apps", "old"],
    0,
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
  ...["namespace", "ns", "namespaces"].map(
    (noun): [string[], string[], string[], number] => [
      ["get", noun, "fixtures"],
      ["namespaces", "view", "fixtures"],
      ["get", "namespace", "fixtures"],
      0,
    ],
  ),
  ...[
    ["job", "jobs", "job.batch"],
    ["jobs", "jobs", "job.batch"],
    ["pvc", "pvcs", "persistentvolumeclaim"],
    ["pvcs", "pvcs", "persistentvolumeclaim"],
    ["service", "services", "service"],
    ["services", "services", "service"],
    ["event", "events", "event"],
    ["events", "events", "event"],
  ].map(([alias, noun, resource]): [string[], string[], string[], number] => [
    ["get", alias!, "sample", "-n", "fixtures"],
    [noun!, "view", "sample", "-n", "fixtures"],
    ["get", resource!, "sample"],
    0,
  ]),
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
  (typed, equivalent, _expectedCall, expectedStatus) => {
    const environment = lab([
      {
        prefix: ["get", "namespace", "fixtures"],
        stdout: JSON.stringify({
          metadata: { name: "fixtures" },
          status: { phase: "Active" },
        }),
      },
      {
        prefix: ["get", "deployment.apps", "healthy"],
        stdout: JSON.stringify({
          metadata: { name: "healthy", generation: 2 },
          spec: { replicas: 2 },
          status: {
            observedGeneration: 2,
            replicas: 2,
            updatedReplicas: 2,
            availableReplicas: 2,
            conditions: [
              {
                type: "Progressing",
                status: "True",
                reason: "ReplicaSetUpdated",
              },
              {
                type: "Available",
                status: "True",
                reason: "MinimumReplicasAvailable",
              },
            ],
          },
        }),
      },
      {
        prefix: ["get", "deployment.apps", "old"],
        stdout: JSON.stringify({
          metadata: { name: "old", generation: 2 },
          spec: { replicas: 2 },
          status: {
            observedGeneration: 2,
            replicas: 3,
            updatedReplicas: 2,
            availableReplicas: 2,
            conditions: [
              { type: "Progressing", status: "True" },
              { type: "Available", status: "True" },
            ],
          },
        }),
      },
      ...["job.batch", "persistentvolumeclaim", "service", "event"].map(
        (resource) => ({
          prefix: ["get", resource, "sample"],
          stdout: JSON.stringify({
            metadata: { name: "sample", namespace: "fixtures" },
          }),
        }),
      ),
      { prefix: ["get", "secrets"], stdout: "" },
      {
        prefix: ["get", "deployment.apps", "broken"],
        stdout: JSON.stringify({
          metadata: { name: "broken", generation: 1 },
          spec: { replicas: 1 },
          status: {
            observedGeneration: 1,
            conditions: [
              {
                type: "Progressing",
                status: "False",
                reason: "ProgressDeadlineExceeded",
              },
            ],
          },
        }),
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
        if (expectedStatus === 1 && typed[0] === "rollout") {
          expect(result.status).toBe(1);
          expect(result.stdout).toContain(
            typed[2]?.endsWith("broken")
              ? "ProgressDeadlineExceeded"
              : "rollout is not complete",
          );
        } else if (typed[0] === "logs") {
          expect(result.stdout).toContain("sample log line");
        } else if (equivalent[1] === "view") {
          const key =
            equivalent[0] === "pods"
              ? "pod"
              : equivalent[0] === "deployments"
                ? "deployment"
                : equivalent[0] === "namespaces"
                  ? "namespace"
                  : equivalent[0] === "jobs"
                    ? "job"
                    : equivalent[0] === "pvcs"
                      ? "pvc"
                      : equivalent[0] === "services"
                        ? "service"
                        : equivalent[0] === "events"
                          ? "event"
                          : "secret";
          if (typed[0] === "rollout" && typed[2]?.endsWith("broken")) {
            expect(result.stdout).toContain("ProgressDeadlineExceeded");
          } else {
            expect(result.data).toHaveProperty(key, equivalent[2]);
          }
        } else {
          expect(result.stdout).toContain(equivalent[0]!);
        }
        if (expectedStatus !== undefined)
          expect(result.status).toBe(expectedStatus);
        if (typed.join(" ") === "get pods -n fixtures") {
          expect(result.status).toBe(0);
          expect(result.data).toMatchObject({
            scope: "namespace fixtures",
            count: "0 of 0 total",
            pods: "0 pods in namespace fixtures (namespace exists)",
          });
          expect(result.stdout).toBe(
            cli(["pods", "-n", "fixtures"], environment.env).stdout,
          );
        }
        if (_expectedCall)
          expect(
            environment
              .calls()
              .some((call) =>
                _expectedCall.every((arg, i) => call.args[i] === arg),
              ),
          ).toBe(true);
      } else {
        expect(result.status).toBe(expectedStatus);
        expect(result.stdout).toContain(
          expectedStatus === 1 ? "REFUSED" : "VALIDATION_ERROR",
        );
        if (typed[0] === "top")
          expect(result.stdout).toContain("not supported");
        if (typed[0] === "describe")
          expect(result.stdout).toContain("k8s-axi configmaps");
      }
    } finally {
      environment.clean();
    }
  },
);
