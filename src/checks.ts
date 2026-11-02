import { AxiError } from "axi-sdk-js";
import { readList, type Obj } from "./kubectl.js";
import type { Target, Scope, Deadline, ListResource } from "./registry.js";
import type { Row } from "./render.js";
import { nodeRow } from "./model/nodes.js";
import { podRow } from "./model/pods.js";
import { workloadRow } from "./model/workloads.js";
import { serviceRows } from "./model/services.js";
import { eventRows } from "./model/events.js";
export const CHECK_NAMES = [
  "nodes",
  "pods",
  "deployments",
  "jobs",
  "pvcs",
  "services",
  "events",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export type Check<T> =
  | { name: CheckName; state: "ok"; value: T }
  | { name: CheckName; state: "failed"; code: string; reason: string };
export type Verdict = "healthy" | "problems" | "partial" | "unknown";
export function verdict(checks: Check<Row[]>[]): Verdict {
  const failed = checks.filter((c) => c.state === "failed").length;
  if (!checks.length || failed === checks.length) return "unknown";
  if (failed) return "partial";
  return checks.some((c) => c.state === "ok" && c.value.some((r) => r.problem))
    ? "problems"
    : "healthy";
}
export function complete(v: Verdict): boolean {
  return v === "healthy" || v === "problems";
}
export async function runChecks(
  t: Target,
  s: Scope,
  d: Deadline,
): Promise<Check<Row[]>[]> {
  const resources: ListResource[] = [
    "nodes",
    "pods",
    "deployments.apps",
    "jobs.batch",
    "persistentvolumeclaims",
    "services",
    "endpointslices.discovery.k8s.io",
    "events",
  ];
  const results = new Map<ListResource, PromiseSettledResult<Obj[]>>();
  let cursor = 0;
  async function worker() {
    while (cursor < resources.length) {
      const resource = resources[cursor++];
      if (!resource) return;
      try {
        const value = await readList(
          {
            op: "list",
            resource,
            scope: resource === "nodes" ? "cluster" : s,
            ...(resource === "events"
              ? { fieldSelector: { warnings: true } }
              : {}),
          },
          t,
          d,
        );
        results.set(resource, { status: "fulfilled", value });
      } catch (reason) {
        results.set(resource, { status: "rejected", reason });
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  function check(
    name: CheckName,
    rs: ListResource[],
    model: (raw: Obj[][]) => Row[],
  ): Check<Row[]> {
    const raw: Obj[][] = [];
    for (const r of rs) {
      const v = results.get(r);
      if (!v || v.status === "rejected") {
        const e = v?.status === "rejected" ? v.reason : undefined;
        return {
          name,
          state: "failed",
          code: e instanceof AxiError ? e.code : "UPSTREAM_ERROR",
          reason: e instanceof AxiError ? e.message : "cluster read failed",
        };
      }
      raw.push(v.value);
    }
    return { name, state: "ok", value: model(raw) };
  }
  const all = s.kind === "all";
  return [
    check("nodes", ["nodes"], (r) => (r[0] ?? []).map(nodeRow)),
    check("pods", ["pods"], (r) => (r[0] ?? []).map((x) => podRow(x, all))),
    check("deployments", ["deployments.apps"], (r) =>
      (r[0] ?? []).map((x) => workloadRow(x, "deployments", all)),
    ),
    check("jobs", ["jobs.batch"], (r) =>
      (r[0] ?? []).map((x) => workloadRow(x, "jobs", all)),
    ),
    check("pvcs", ["persistentvolumeclaims"], (r) =>
      (r[0] ?? []).map((x) => workloadRow(x, "pvcs", all)),
    ),
    check("services", ["services", "endpointslices.discovery.k8s.io"], (r) =>
      serviceRows(r[0] ?? [], r[1] ?? [], all),
    ),
    check("events", ["events"], (r) => eventRows(r[0] ?? [], false, 3600)),
  ];
}
