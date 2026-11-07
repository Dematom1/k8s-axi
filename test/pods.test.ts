import { test, expect } from "vitest";
import { classifyPod, podDetail, podRow } from "../src/model/pods.js";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
const old = new Date(Date.now() - 600000).toISOString();
export const pod = {
  kind: "Pod",
  metadata: {
    name: "p",
    namespace: "sandbox",
    creationTimestamp: old,
    ownerReferences: [{ kind: "Workflow", name: "w" }],
    annotations: { payload: "CANARY" },
  },
  spec: {
    containers: [
      {
        name: "c",
        env: [{ name: "PASSWORD", value: "CANARY" }],
        args: ["CANARY"],
      },
    ],
  },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "False" }],
    containerStatuses: [
      {
        name: "c",
        ready: false,
        restartCount: 3,
        lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
      },
    ],
  },
};
for (const reason of [
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "CreateContainerConfigError",
])
  test(reason, () =>
    expect(
      classifyPod({
        ...pod,
        status: {
          ...pod.status,
          containerStatuses: [{ state: { waiting: { reason } } }],
        },
      }),
    ).toEqual({ state: "problem", reason }),
  );
test("phase, readiness, startup, init and termination", () => {
  expect(classifyPod(pod).state).toBe("problem");
  const recent = {
    ...pod,
    metadata: { ...pod.metadata, creationTimestamp: new Date().toISOString() },
  };
  expect(classifyPod(recent).state).toBe("problem");
  expect(
    classifyPod({
      ...recent,
      status: {
        ...recent.status,
        containerStatuses: [
          { ready: false, restartCount: 0, state: { running: {} } },
        ],
      },
    }),
  ).toMatchObject({ state: "problem", reason: "NotReady" });
  expect(
    classifyPod({
      ...recent,
      status: {
        ...recent.status,
        containerStatuses: [
          {
            ready: false,
            restartCount: 0,
            state: { terminated: { reason: "OOMKilled", exitCode: 137 } },
          },
        ],
      },
    }),
  ).toMatchObject({ state: "problem", reason: "OOMKilled (137)" });
  expect(
    classifyPod({
      ...recent,
      status: {
        ...recent.status,
        containerStatuses: [
          {
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: "ContainerCreating" } },
          },
        ],
      },
    }).state,
  ).toBe("starting");
  for (const phase of ["Pending", "Failed", "Unknown"])
    expect(classifyPod({ ...pod, status: { phase } }).state).toBe("problem");
  expect(classifyPod({ ...pod, status: { phase: "Succeeded" } }).state).toBe(
    "completed",
  );
  expect(
    classifyPod({
      ...pod,
      status: {
        phase: "Running",
        initContainerStatuses: [
          { state: { waiting: { reason: "InitError" } } },
        ],
      },
    }).state,
  ).toBe("problem");
  expect(
    classifyPod({
      ...pod,
      metadata: { ...pod.metadata, deletionTimestamp: old },
    }),
  ).toMatchObject({ reason: "StuckTerminating" });
  expect(podRow(pod).cells["last-exit"]).toContain("OOMKilled");
  expect(JSON.stringify(podDetail(pod, true))).not.toContain("CANARY");
  expect(podDetail(pod).owner).toBe("Workflow/w");
});
test("pod scope and problems", () => {
  const l = lab([
    {
      prefix: ["get", "namespace", "missing"],
      stderr: "Error from server (NotFound)",
      code: 1,
    },
    {
      prefix: ["get", "pods"],
      stdout: JSON.stringify({
        items: [
          pod,
          {
            ...pod,
            metadata: { ...pod.metadata, name: "complete" },
            status: { phase: "Succeeded" },
          },
        ],
      }),
    },
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "-A", "--problems"], l.env);
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("1 of 2 total");
    expect(p.stdout).not.toContain("complete,");
    expect(cli(["pods", "-n", "missing"], l.env).stdout).toContain(
      "NAMESPACE_NOT_FOUND",
    );
    expect(cli(["pods", "view", "p", "--full"], l.env).stdout).not.toContain(
      "CANARY",
    );
  } finally {
    l.clean();
  }
});
