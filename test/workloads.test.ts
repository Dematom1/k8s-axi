import { test, expect } from "vitest";
import { workloadRow } from "../src/model/workloads.js";
import { serviceRows } from "../src/model/services.js";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
for (const [raw, problem] of [
  [
    {
      spec: { replicas: 0 },
      status: { conditions: [{ type: "Available", status: "False" }] },
    },
    false,
  ],
  [{ metadata: { generation: 2 }, status: { observedGeneration: 1 } }, true],
  [
    { status: { conditions: [{ type: "Progressing", status: "False" }] } },
    true,
  ],
  [{ status: { conditions: [{ type: "Available", status: "False" }] } }, true],
  [
    { spec: { replicas: 2 }, status: { readyReplicas: 2, updatedReplicas: 2 } },
    false,
  ],
] as const)
  test(`deployment ${JSON.stringify(raw)}`, () =>
    expect(workloadRow(raw, "deployments").problem).toBe(problem));
for (const [raw, status] of [
  [
    { status: { conditions: [{ type: "Complete", status: "True" }] } },
    "Complete",
  ],
  [
    {
      status: {
        conditions: [
          { type: "Failed", status: "True", reason: "BackoffLimitExceeded" },
        ],
      },
    },
    "Failed (BackoffLimitExceeded)",
  ],
  [{ spec: { suspend: true } }, "Suspended"],
  [{}, "Running"],
] as const)
  test(`job ${status}`, () =>
    expect(workloadRow(raw, "jobs").cells.status).toBe(status));
for (const phase of ["Bound", "Pending", "Lost"])
  test(`pvc ${phase}`, () =>
    expect(workloadRow({ status: { phase } }, "pvcs").problem).toBe(
      phase !== "Bound",
    ));
test("service joins", () => {
  const svc = {
    metadata: { name: "web", namespace: "ns" },
    spec: { selector: { app: "web" } },
  };
  const slices = [
    {
      metadata: {
        namespace: "ns",
        labels: { "kubernetes.io/service-name": "web" },
      },
      endpoints: [
        { conditions: { ready: true } },
        { conditions: { ready: false } },
      ],
    },
  ];
  expect(serviceRows([svc], slices)[0]?.cells.endpoints).toBe(1);
  expect(serviceRows([svc], [])[0]?.problem).toBe(true);
  for (const spec of [{}, { type: "ExternalName", selector: { app: "web" } }])
    expect(serviceRows([{ ...svc, spec }], [])[0]?.problem).toBe(false);
  expect(
    serviceRows(
      [{ ...svc, spec: { ...svc.spec, clusterIP: "None" } }],
      slices,
    )[0]?.problem,
  ).toBe(false);
});
for (const noun of ["deployments", "jobs", "pvcs", "services"])
  test(`missing ${noun}`, () => {
    const l = lab([
      {
        prefix: ["get", "namespace", "missing"],
        stderr: "Error from server (NotFound)",
        code: 1,
      },
      ...targetRules(),
    ]);
    try {
      expect(cli([noun, "-n", "missing"], l.env).stdout).toContain(
        "NAMESPACE_NOT_FOUND",
      );
      expect(l.calls().every((x) => !x.args.includes("endpoints"))).toBe(true);
    } finally {
      l.clean();
    }
  });
test("failed service join cannot report readiness", () => {
  const l = lab([
    {
      prefix: ["get", "endpointslices.discovery.k8s.io"],
      stderr: "forbidden:",
      code: 1,
    },
    ...targetRules(),
  ]);
  try {
    const p = cli(["services"], l.env);
    expect(p.status).toBe(1);
    expect(p.stdout).toContain("FORBIDDEN");
  } finally {
    l.clean();
  }
});
