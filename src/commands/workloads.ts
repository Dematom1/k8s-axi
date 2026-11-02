import type { Parsed } from "../args.js";
import { deadline, type ListResource } from "../registry.js";
import { resolveTarget, resolveScope, scopeLabel, scoped } from "../target.js";
import { kubectl, parseObject, readList } from "../kubectl.js";
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
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d),
    s = resolveScope(p, t),
    name = p.name;
  if (p.action === "view" && name && s.kind === "namespace") {
    const rows = await scoped(s, t, d, async () => [
      parseObject(
        await kubectl(
          { op: "get", resource: "deployment.apps", name, namespace: s.name },
          t,
          d,
        ),
      ),
    ]);
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
