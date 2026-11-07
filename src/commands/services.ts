import type { Parsed } from "../args.js";
import {
  deadline,
  type Target,
  type Scope,
  type Deadline,
} from "../registry.js";
import { resolveTarget, resolveScope, scopeLabel, scoped } from "../target.js";
import { readList, type Obj } from "../kubectl.js";
import { serviceRows, serviceSpec } from "../model/services.js";
import { renderList, validateFields } from "../render.js";
import { usage } from "../errors.js";
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
  if (p.action === "view")
    usage("services does not support object views", "services");
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d),
    s = resolveScope(p, t);
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
