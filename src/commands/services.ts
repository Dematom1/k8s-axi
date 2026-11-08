import type { Parsed } from "../args.js";
import {
  deadline,
  type Target,
  type Scope,
  type Deadline,
} from "../registry.js";
import { resolveTarget, resolveScope, scopeLabel, scoped } from "../target.js";
import {
  kubectl,
  parseObject,
  readList,
  object,
  text,
  type Obj,
} from "../kubectl.js";
import { encodeObject } from "../toon.js";
import { recentEvents } from "./events.js";
import { serviceRows, serviceSpec } from "../model/services.js";
import { renderList, validateFields } from "../render.js";
export async function readServices(
  t: Target,
  s: Scope,
  d: Deadline,
): Promise<{ services: Obj[]; slices: Obj[] }> {
  const [services, slices] = await Promise.all([
    readList({ op: "list", resource: "services", scope: s }, t, d),
    readList(
      { op: "list", resource: "endpointslices.discovery.k8s.io", scope: s },
      t,
      d,
    ),
  ]);
  return { services, slices };
}
export async function servicesCommand(p: Parsed): Promise<string> {
  validateFields(serviceSpec, p);
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d),
    s = resolveScope(p, t);
  if (p.action === "view" && p.name && s.kind === "namespace") {
    const name = p.name;
    const rows = await scoped(s, t, d, async () => [
      parseObject(
        await kubectl(
          { op: "get", resource: "service", name, namespace: s.name },
          t,
          d,
        ),
      ),
    ]);
    const raw = rows[0] ?? {};
    const slices = await readList(
      { op: "list", resource: "endpointslices.discovery.k8s.io", scope: s },
      t,
      d,
    );
    return encodeObject({
      context: t.context,
      ...serviceRows([raw], slices)[0]?.cells,
      namespace: text(object(raw.metadata).namespace),
      clusterIP: text(object(raw.spec).clusterIP),
      externalName: text(object(raw.spec).externalName),
      events: await recentEvents(t, s, d, "Service", name, p.full),
    });
  }
  const [raw] = await scoped(
    s,
    t,
    d,
    async () => [await readServices(t, s, d)],
    (x) => x[0]?.services.length ?? 0,
  );
  return renderList(
    serviceRows(raw?.services ?? [], raw?.slices ?? [], s.kind === "all"),
    serviceSpec,
    p,
    scopeLabel(s),
    t.context,
  );
}
