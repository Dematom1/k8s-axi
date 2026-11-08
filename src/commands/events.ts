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
import { kubectl, parseObject, readList, object, text } from "../kubectl.js";
import { encodeObject } from "../toon.js";
import { eventRow, eventRows, eventSpec } from "../model/events.js";
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
  if (p.action === "view" && p.name && s.kind === "namespace") {
    const event = p.name;
    const rows = await scoped(s, t, d, async () => [
      parseObject(
        await kubectl(
          { op: "get", resource: "event", name: event, namespace: s.name },
          t,
          d,
        ),
      ),
    ]);
    const raw = rows[0] ?? {};
    return encodeObject({
      context: t.context,
      event: text(object(raw.metadata).name),
      ...eventRow(raw, p.full).cells,
    });
  }
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
