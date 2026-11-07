import type { Parsed } from "../args.js";
import { deadline, remaining, type ListResource } from "../registry.js";
import { resolveTarget, resolveScope, scopeLabel, scoped } from "../target.js";
import {
  kubectl,
  object,
  objects,
  parseObject,
  readList,
  text,
  number,
} from "../kubectl.js";
import { fail } from "../errors.js";
import {
  workloadRow,
  workloadSpecs,
  deploymentDetail,
} from "../model/workloads.js";
import { renderList, validateFields } from "../render.js";
import { encodeObject } from "../toon.js";
import { recentEvents } from "./events.js";
export async function workloadsCommand(p: Parsed): Promise<string> {
  if (
    p.command !== "deployments" &&
    p.command !== "jobs" &&
    p.command !== "pvcs"
  )
    throw new Error("invalid workload noun");
  const noun = p.command,
    spec = workloadSpecs[noun];
  validateFields(spec, p);
  const d = deadline(p.timeout);
  if (p.rolloutStatus) d.end = Date.now() + p.timeout * 1000;
  const t = await resolveTarget(p.context, d),
    s = resolveScope(p, t),
    name = p.name;
  if (
    p.action === "view" &&
    name &&
    (s.kind === "namespace" || p.rolloutStatus)
  ) {
    const read = async () => [
      parseObject(
        await kubectl(
          {
            op: "get",
            resource: "deployment.apps",
            name,
            ...(s.kind === "namespace" ? { namespace: s.name } : {}),
          },
          t,
          d,
        ),
      ),
    ];
    let rows =
      s.kind === "namespace" ? await scoped(s, t, d, read) : await read();
    if (p.rolloutStatus) {
      while (true) {
        const deployment = rows[0] ?? {};
        const conditions = objects(object(deployment.status).conditions);
        const deadlineExceeded = conditions.find(
          (condition) =>
            condition.type === "Progressing" &&
            condition.status === "False" &&
            condition.reason === "ProgressDeadlineExceeded",
        );
        const metadata = object(deployment.metadata);
        const status = object(deployment.status);
        const desired = number(object(deployment.spec).replicas, 1);
        const complete =
          number(status.observedGeneration) >= number(metadata.generation) &&
          number(status.updatedReplicas) === desired &&
          number(status.availableReplicas) === desired &&
          conditions.some(
            (condition) =>
              condition.type === "Progressing" && condition.status === "True",
          ) &&
          conditions.some(
            (condition) =>
              condition.type === "Available" && condition.status === "True",
          );
        if (deadlineExceeded)
          fail(
            "UPSTREAM_ERROR",
            `deployment ${name} rollout failed: ${text(deadlineExceeded.reason)}`,
            [`Inspect pods for deployment ${name}`],
          );
        if (complete) break;
        if (remaining(d) === 0)
          fail("UPSTREAM_ERROR", `deployment ${name} rollout is not complete`, [
            `Inspect pods for deployment ${name}`,
          ]);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000, remaining(d))),
        );
        rows =
          s.kind === "namespace" ? await scoped(s, t, d, read) : await read();
      }
    }
    return encodeObject({
      context: t.context,
      ...deploymentDetail(rows[0] ?? {}, p.full),
      events: await recentEvents(t, s, d, "Deployment", name, p.full),
    });
  }
  const resources: Record<typeof noun, ListResource> = {
    deployments: "deployments.apps",
    jobs: "jobs.batch",
    pvcs: "persistentvolumeclaims",
  };
  const rows = await scoped(s, t, d, () =>
    readList(
      { op: "list", resource: resources[noun], scope: s, selector: p.selector },
      t,
      d,
    ),
  );
  return renderList(
    rows.map((x) => workloadRow(x, noun, s.kind === "all")),
    spec,
    p,
    scopeLabel(s),
    t.context,
  );
}
