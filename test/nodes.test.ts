import { test, expect } from "vitest";
import { nodeRow } from "../src/model/nodes.js";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
for (const [ready, status] of [
  ["True", "Ready"],
  ["False", "NotReady"],
  ["Unknown", "Unknown"],
])
  test(`node ${ready}`, () =>
    expect(
      nodeRow({
        metadata: { name: "n" },
        status: { conditions: [{ type: "Ready", status: ready }] },
      }).cells.status,
    ).toBe(status));
test("pressure and scheduling", () => {
  const n = nodeRow({
    metadata: {
      name: "n",
      labels: { "node-role.kubernetes.io/control-plane": "" },
    },
    spec: { unschedulable: true },
    status: {
      conditions: [
        { type: "Ready", status: "True" },
        { type: "MemoryPressure", status: "True" },
      ],
    },
  });
  expect(n.problem).toBe(true);
  expect(n.cells.status).toContain("SchedulingDisabled");
  expect(n.cells.status).toContain("MemoryPressure");
  expect(n.cells.role).toBe("control-plane");
});
test("list limits fields and detail", () => {
  const items = Array.from({ length: 1500 }, (_, i) => ({
    metadata: { name: `node-${i}` },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      nodeInfo: { kubeletVersion: "v1.32.1" },
    },
  }));
  const l = lab([
    { prefix: ["get", "nodes"], stdout: JSON.stringify({ items }) },
    {
      prefix: ["get", "node", "missing"],
      stderr: "Error from server (NotFound)",
      code: 1,
    },
    { prefix: ["get", "node"], stdout: JSON.stringify(items[0]) },
    ...targetRules(),
  ]);
  try {
    const p = cli(["nodes", "--limit", "100"], l.env);
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("100 of 1500 total");
    expect(p.data).toMatchObject({ total: 1500 });
    expect(p.stdout).toContain("truncated: true");
    expect(p.stdout).toContain("{node,status,role,version}");
    expect(cli(["nodes", "view", "missing"], l.env).stdout).toContain(
      "NOT_FOUND",
    );
    expect(cli(["nodes", "view", "node-0"], l.env).stdout).toContain(
      "allocatable",
    );
    const before = l.calls().length;
    expect(cli(["nodes", "--fields", "bogus"], l.env).status).toBe(2);
    expect(l.calls().length).toBe(before);
  } finally {
    l.clean();
  }
});
