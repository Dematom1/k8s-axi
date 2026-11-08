import { expect, test } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";

const views = [
  {
    noun: "jobs",
    resource: "job.batch",
    key: "job",
    spec: { completions: 3 },
    status: { succeeded: 1, failed: 2 },
    expected: { completions: "1/3", active: 0, succeeded: 1, failed: 2 },
  },
  {
    noun: "pvcs",
    resource: "persistentvolumeclaim",
    key: "pvc",
    spec: {
      volumeName: "pv-data",
      storageClassName: "standard",
      resources: { requests: { storage: "2Gi" } },
    },
    status: { phase: "Bound", capacity: { storage: "2Gi" } },
    expected: {
      status: "Bound",
      capacity: "2Gi",
      requested: "2Gi",
      volume: "pv-data",
      storageClass: "standard",
    },
  },
  {
    noun: "services",
    resource: "service",
    key: "service",
    spec: { selector: { app: "web" }, clusterIP: "10.96.0.5" },
    status: {},
    expected: { status: "Ready", endpoints: 1, clusterIP: "10.96.0.5" },
  },
  {
    noun: "events",
    resource: "event",
    key: "event",
    spec: {},
    status: {},
    expected: {
      type: "Warning",
      count: 2,
      object: "sandbox/Pod/web",
      message: "failed scheduling",
    },
  },
  {
    noun: "namespaces",
    resource: "namespace",
    key: "namespace",
    spec: {},
    status: { phase: "Active" },
    expected: { status: "Active" },
  },
];

for (const view of views) {
  test(`${view.noun} view reads one object, not the collection`, () => {
    const environment = lab([
      {
        prefix: ["get", view.resource, "sample"],
        stdout: JSON.stringify({
          metadata: { name: "sample", namespace: "sandbox" },
          spec: view.spec,
          status: view.status,
          type: "Warning",
          reason: "FailedScheduling",
          count: 2,
          involvedObject: { kind: "Pod", name: "web" },
          message: "failed scheduling",
        }),
      },
      {
        prefix: ["get", "endpointslices.discovery.k8s.io"],
        stdout: JSON.stringify({
          items: [
            {
              metadata: {
                name: "sample-slice",
                namespace: "sandbox",
                labels: { "kubernetes.io/service-name": "sample" },
              },
              endpoints: [
                { conditions: { ready: true } },
                { conditions: { ready: false } },
              ],
            },
            {
              metadata: {
                name: "other-slice",
                namespace: "sandbox",
                labels: { "kubernetes.io/service-name": "other" },
              },
              endpoints: [{ conditions: { ready: true } }],
            },
          ],
        }),
      },
      ...targetRules(),
    ]);
    try {
      const result = cli([view.noun, "view", "sample"], environment.env);
      expect(result.status, result.stdout).toBe(0);
      expect(result.data).toMatchObject({
        context: "default",
        [view.key]: "sample",
        ...view.expected,
      });
      const calls = environment.calls().map((call) => call.args);
      const read = calls.find(
        (args) =>
          args[0] === "get" &&
          args[1] === view.resource &&
          args[2] === "sample",
      );
      expect(read).toBeDefined();
      expect(read).toContain("json");
      if (view.noun === "services") {
        const slices = calls.find((args) => args[1] === "endpointslices.discovery.k8s.io");
        expect(slices).toContain("--selector=kubernetes.io/service-name=sample");
      }
      if (view.noun !== "namespaces") expect(read).toContain("sandbox");
      else expect(read).not.toContain("-n");
      expect(
        calls.every(
          (args) =>
            args[0] !== "get" || args[1] !== view.noun || args[2] === "sample",
        ),
      ).toBe(true);
    } finally {
      environment.clean();
    }
  });

  test(`${view.noun} view preserves not-found errors`, () => {
    const environment = lab([
      {
        prefix: ["get", view.resource, "missing"],
        stderr: "Error from server (NotFound): missing",
        code: 1,
      },
      ...targetRules(),
    ]);
    try {
      const result = cli([view.noun, "view", "missing"], environment.env);
      expect(result.status).toBe(1);
      expect(result.data).toMatchObject({
        code: "NOT_FOUND",
        error: "resource not found in the cluster",
      });
    } finally {
      environment.clean();
    }
  });

  test(`${view.noun} view rejects list filters before reads`, () => {
    const environment = lab();
    try {
      for (const flag of [
        "--problems",
        "--fields=status",
        "-A",
        ...(view.noun === "events"
          ? ["--warnings", "--since=15m", "--for=Pod/web"]
          : []),
      ]) {
        expect(
          cli([view.noun, "view", "sample", flag], environment.env).status,
        ).toBe(2);
      }
      expect(environment.calls()).toEqual([]);
    } finally {
      environment.clean();
    }
  });
}

test("namespace view rejects dotted names before cluster access", () => {
  const environment = lab();
  try {
    const result = cli(["namespaces", "view", "a.b"], environment.env);
    expect(result.status).toBe(2);
    expect(result.data).toMatchObject({ error: "namespace must be a DNS label" });
    expect(environment.calls()).toEqual([]);
  } finally {
    environment.clean();
  }
});

test("event view keeps message previews bounded and --full untruncates", () => {
  const message = "a".repeat(200);
  const environment = lab([
    {
      prefix: ["get", "event", "sample"],
      stdout: JSON.stringify({ metadata: { name: "sample" }, message }),
    },
    ...targetRules(),
  ]);
  try {
    const result = cli(["events", "view", "sample"], environment.env);
    expect(result.data).toHaveProperty(
      "message",
      `${message.slice(0, 120)}... (200 chars total; --full)`,
    );
    expect(
      cli(["events", "view", "sample", "--full"], environment.env).data,
    ).toHaveProperty("message", message);
  } finally {
    environment.clean();
  }
});
