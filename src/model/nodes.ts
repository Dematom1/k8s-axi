import { object, objects, text, type Obj } from "../kubectl.js";
import { redactText } from "../redact.js";
import { age } from "./time.js";
import { preview } from "../commands/common.js";
import type { Row, ListSpec } from "../render.js";
export const nodeSpec: ListSpec = {
  noun: "nodes",
  defaults: ["node", "status", "role", "version"],
  fields: ["node", "status", "role", "version", "age", "labels"],
};
export function nodeRow(raw: Obj): Row {
  const meta = object(raw.metadata),
    status = object(raw.status),
    conditions = objects(status.conditions),
    labels = object(meta.labels);
  const ready = text(
    conditions.find((x) => x.type === "Ready")?.status,
    "Unknown",
  );
  const problems = conditions
    .filter((x) => text(x.type).endsWith("Pressure") && x.status === "True")
    .map((x) => text(x.type));
  if (object(raw.spec).unschedulable === true)
    problems.push("SchedulingDisabled");
  if (ready !== "True")
    problems.unshift(ready === "Unknown" ? "Unknown" : "NotReady");
  const state = problems.length ? problems.join("+") : "Ready";
  return {
    problem: problems.length > 0,
    why: state,
    created: text(meta.creationTimestamp),
    cells: {
      node: text(meta.name),
      status: state,
      role:
        Object.keys(labels)
          .filter((x) => x.startsWith("node-role.kubernetes.io/"))
          .map((x) => x.split("/")[1])
          .join("+") || "none",
      version: text(object(status.nodeInfo).kubeletVersion, "unknown"),
      age: age(text(meta.creationTimestamp)),
      labels: redactText(JSON.stringify(labels)).text,
    },
  };
}
export function conditionRows(
  raw: unknown,
  full = false,
): Record<string, string>[] {
  return objects(raw).map((c) => ({
    condition: text(c.type),
    status: text(c.status),
    reason: text(c.reason),
    message: preview(redactText(text(c.message)).text, full, 500),
  }));
}
export function nodeDetail(raw: Obj, full = false): Record<string, unknown> {
  const status = object(raw.status);
  return {
    node: text(object(raw.metadata).name),
    status: nodeRow(raw).cells.status,
    role: nodeRow(raw).cells.role,
    version: nodeRow(raw).cells.version,
    conditions: conditionRows(status.conditions, full),
    taints: objects(object(raw.spec).taints).map((t) => ({
      key: text(t.key),
      value: redactText(text(t.value)).text,
      effect: text(t.effect),
    })),
    capacity: resourceCapacity(status.capacity),
    allocatable: resourceCapacity(status.allocatable),
  };
}
function resourceCapacity(value: unknown): Record<string, string> {
  const v = object(value);
  return Object.fromEntries(
    ["cpu", "memory", "pods", "ephemeral-storage"]
      .filter((k) => k in v)
      .map((k) => [k, text(v[k])]),
  );
}
