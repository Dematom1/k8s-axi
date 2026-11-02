import {
  validateResourceName,
  type Parsed,
  type ResourceName,
} from "../args.js";
import {
  deadline,
  type Target,
  type Deadline,
  type Scope,
} from "../registry.js";
import { resolveTarget, resolveScope, scopeLabel, scoped } from "../target.js";
import { readList } from "../kubectl.js";
import { eventRows, eventSpec } from "../model/events.js";
import { renderList, validateFields } from "../render.js";
export async function recentEvents(
  target: Target,
  scope: Scope,
  d: Deadline,
  kind: string,
  name: ResourceName,
  full = false,
): Promise<Record<string, string | number>[]> {
  return eventRows(
    await readList(
      {
        op: "list",
        resource: "events",
        scope,
        fieldSelector: { warnings: false, kind, name },
      },
      target,
      d,
    ),
    full,
  )
    .slice(0, 10)
    .map((x) => x.cells);
}
export async function eventsCommand(p: Parsed): Promise<string> {
  validateFields(eventSpec, p);
  const parts = p.forObject?.split("/");
  const name = parts?.[1] ? validateResourceName(parts[1]) : undefined;
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d),
    s = resolveScope(p, t);
  const raw = await scoped(s, t, d, () =>
    readList(
      {
        op: "list",
        resource: "events",
        scope: s,
        fieldSelector: { warnings: p.warnings, kind: parts?.[0], name },
      },
      t,
      d,
    ),
  );
  return renderList(
    eventRows(raw, p.full, p.since),
    eventSpec,
    p,
    scopeLabel(s),
    t.context,
  );
}
