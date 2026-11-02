import { object, objects, text, number, type Obj } from "../kubectl.js";
import { age } from "./time.js";
import { conditionRows } from "./nodes.js";
import type { Row, ListSpec } from "../render.js";
export const workloadSpecs: Record<"deployments" | "jobs" | "pvcs", ListSpec> =
  {
    deployments: {
      noun: "deployments",
      defaults: ["deployment", "ready", "updated", "status"],
      fields: ["deployment", "ready", "updated", "status", "age"],
    },
    jobs: {
      noun: "jobs",
      defaults: ["job", "completions", "status", "age"],
      fields: ["job", "completions", "status", "age"],
    },
    pvcs: {
      noun: "pvcs",
      defaults: ["pvc", "status", "capacity", "age"],
      fields: ["pvc", "status", "capacity", "age"],
    },
  };
export function workloadRow(
  raw: Obj,
  noun: keyof typeof workloadSpecs,
  all = false,
): Row {
  const m = object(raw.metadata),
    s = object(raw.status),
    spec = object(raw.spec),
    created = text(m.creationTimestamp),
    id = `${all ? text(m.namespace) + "/" : ""}${text(m.name)}`;
  let status: string, problem: boolean;
  let cells: Row["cells"];
  switch (noun) {
    case "deployments": {
      const desired = number(spec.replicas, 1),
        conds = objects(s.conditions);
      const failed = conds.filter(
        (c) =>
          c.status === "False" &&
          (c.type === "Progressing" || (c.type === "Available" && desired > 0)),
      );
      const stale = number(s.observedGeneration) < number(m.generation);
      problem = stale || failed.length > 0;
      status = stale
        ? "StaleGeneration"
        : failed
            .map((c) => `${text(c.type)}=${text(c.reason, "False")}`)
            .join(";") || (desired === 0 ? "ScaledToZero" : "Available");
      cells = {
        deployment: id,
        ready: `${number(s.readyReplicas)}/${desired}`,
        updated: `${number(s.updatedReplicas)}/${desired}`,
        status,
        age: age(created),
      };
      break;
    }
    case "jobs": {
      const conds = objects(s.conditions),
        failed = conds.find((c) => c.type === "Failed" && c.status === "True");
      problem = !!failed;
      status = failed
        ? `Failed (${text(failed.reason, "unknown")})`
        : conds.some((c) => c.type === "Complete" && c.status === "True")
          ? "Complete"
          : spec.suspend === true
            ? "Suspended"
            : "Running";
      cells = {
        job: id,
        completions: `${number(s.succeeded)}/${number(spec.completions, 1)}`,
        status,
        age: age(created),
      };
      break;
    }
    case "pvcs":
      status = text(s.phase, "Unknown");
      problem = ["Pending", "Lost"].includes(status);
      cells = {
        pvc: id,
        status,
        capacity: text(object(s.capacity).storage, "-"),
        age: age(created),
      };
      break;
    default: {
      const exhaustive: never = noun;
      throw new Error(String(exhaustive));
    }
  }
  return { cells, problem, why: status, created };
}
export function deploymentDetail(
  raw: Obj,
  full = false,
): Record<string, unknown> {
  return {
    ...workloadRow(raw, "deployments").cells,
    namespace: text(object(raw.metadata).namespace),
    generation: number(object(raw.metadata).generation),
    observed: number(object(raw.status).observedGeneration),
    conditions: conditionRows(object(raw.status).conditions, full),
  };
}
