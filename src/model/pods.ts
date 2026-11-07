import { object, objects, text, number, type Obj } from "../kubectl.js";
import { redactText } from "../redact.js";
import { conditionRows } from "./nodes.js";
import { age, elapsed } from "./time.js";
import { preview } from "../commands/common.js";
import type { ListSpec, Row } from "../render.js";
export type PodHealth =
  | { state: "completed" }
  | { state: "running" }
  | { state: "starting"; reason: string }
  | { state: "problem"; reason: string };
export const podSpec: ListSpec = {
  noun: "pods",
  defaults: ["pod", "ready", "status", "restarts"],
  fields: [
    "pod",
    "ready",
    "status",
    "restarts",
    "age",
    "owner",
    "node",
    "last-exit",
    "labels",
  ],
};
export function classifyPod(pod: Obj, now = Date.now()): PodHealth {
  const meta = object(pod.metadata),
    spec = object(pod.spec),
    s = object(pod.status),
    phase = text(s.phase, "Unknown");
  if (phase === "Succeeded") return { state: "completed" };
  if (
    meta.deletionTimestamp &&
    elapsed(text(meta.deletionTimestamp), now) >
      number(spec.terminationGracePeriodSeconds, 30) + 60
  )
    return { state: "problem", reason: "StuckTerminating" };
  const statuses = [
    ...objects(s.initContainerStatuses),
    ...objects(s.containerStatuses),
  ];
  const waiting = statuses
    .map((c) => text(object(object(c.state).waiting).reason))
    .filter(Boolean);
  const failure = waiting.find(
    (x) => !["ContainerCreating", "PodInitializing"].includes(x),
  );
  if (failure) return { state: "problem", reason: failure };
  const terminated = statuses
    .flatMap((c) => [
      object(object(c.state).terminated),
      c.ready === true &&
      Object.keys(object(object(c.state).running)).length > 0
        ? {}
        : object(object(c.lastState).terminated),
    ])
    .find(
      (state) => Object.keys(state).length > 0 && number(state.exitCode) !== 0,
    );
  if (terminated)
    return {
      state: "problem",
      reason: `${text(terminated.reason, "Error")} (${number(terminated.exitCode)})`,
    };
  if (["Failed", "Unknown"].includes(phase))
    return { state: "problem", reason: text(s.reason, phase) };
  const reason = waiting[0] ?? (phase === "Running" ? "NotReady" : phase);
  if (statuses.some((c) => c.ready === false && number(c.restartCount) > 0))
    return { state: "problem", reason };
  if (
    phase === "Running" &&
    objects(s.conditions).some((c) => c.type === "Ready" && c.status === "True")
  )
    return { state: "running" };
  const hasRestarts = statuses.some((c) => number(c.restartCount) > 0);
  if (hasRestarts) return { state: "problem", reason };
  const initializing = waiting.some((x) =>
    ["ContainerCreating", "PodInitializing"].includes(x),
  );
  return initializing && elapsed(text(meta.creationTimestamp), now) <= 120
    ? { state: "starting", reason }
    : { state: "problem", reason };
}
export function owner(raw: Obj): string {
  return (
    objects(object(raw.metadata).ownerReferences)
      .map((x) => `${text(x.kind)}/${text(x.name)}`)
      .join(",") || "none"
  );
}
export function podRow(raw: Obj, all = false, now = Date.now()): Row {
  const meta = object(raw.metadata),
    s = object(raw.status),
    containers = objects(s.containerStatuses),
    spec = object(raw.spec),
    health = classifyPod(raw, now);
  const last =
    containers
      .map((c) => object(object(c.lastState).terminated))
      .filter((t) => Object.keys(t).length)
      .map((t) => `${text(t.reason)} (${number(t.exitCode)})`)
      .join(";") || "none";
  const status =
    health.state === "completed"
      ? "Completed"
      : health.state === "running"
        ? "Running"
        : health.reason;
  return {
    problem: health.state === "problem",
    why: `${status}, owner ${owner(raw)}`,
    created: text(meta.creationTimestamp),
    cells: {
      pod: `${all ? text(meta.namespace) + "/" : ""}${text(meta.name)}`,
      ready: `${containers.filter((c) => c.ready === true).length}/${objects(spec.containers).length}`,
      status,
      restarts:
        containers.reduce((sum, c) => sum + number(c.restartCount), 0) +
        objects(s.initContainerStatuses).reduce(
          (sum, c) => sum + number(c.restartCount),
          0,
        ),
      age: age(text(meta.creationTimestamp), now),
      owner: owner(raw),
      node: text(spec.nodeName, "unscheduled"),
      "last-exit": last,
      labels: redactText(JSON.stringify(object(meta.labels))).text,
    },
  };
}
export function podDetail(raw: Obj, full = false): Record<string, unknown> {
  const s = object(raw.status);
  const cells = podRow(raw).cells;
  const { labels: _labels, ...safe } = cells;
  return {
    ...safe,
    namespace: text(object(raw.metadata).namespace),
    owner: owner(raw),
    conditions: conditionRows(s.conditions, full),
    containers: [
      ...objects(s.initContainerStatuses).map((c): Obj => ({
        ...c,
        init: true,
      })),
      ...objects(s.containerStatuses),
    ].map((c) => {
      const state = object(c.state),
        last = object(object(c.lastState).terminated),
        current = object(state.terminated);
      return {
        name: text(c.name),
        init: c.init === true,
        ready: c.ready === true,
        restarts: number(c.restartCount),
        waiting: text(object(state.waiting).reason),
        message: preview(
          redactText(text(object(state.waiting).message)).text,
          full,
          500,
        ),
        terminated: text(current.reason),
        "last-exit": text(last.reason),
        "exit-code": number(last.exitCode),
        "last-message": preview(redactText(text(last.message)).text, full, 500),
      };
    }),
  };
}
