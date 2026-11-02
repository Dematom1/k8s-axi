import type { Parsed } from "../args.js";
import { deadline } from "../registry.js";
import { resolveTarget, resolveScope, scopeLabel, scoped } from "../target.js";
import { kubectl, parseObject, readList } from "../kubectl.js";
import { podRow, podDetail, podSpec } from "../model/pods.js";
import { renderList, validateFields } from "../render.js";
import { encodeObject } from "../toon.js";
import { fail } from "../errors.js";
import { recentEvents } from "./events.js";
export async function podsCommand(p: Parsed): Promise<string> {
  validateFields(podSpec, p);
  if (p.action === "logs") fail("REFUSED", "logs not built yet");
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d),
    s = resolveScope(p, t);
  if (p.action === "view" && p.name && s.kind === "namespace") {
    const rows = await scoped(s, t, d, async () => [
      parseObject(
        await kubectl(
          { op: "get", resource: "pod", name: p.name!, namespace: s.name },
          t,
          d,
        ),
      ),
    ]);
    return encodeObject({
      context: t.context,
      ...podDetail(rows[0] ?? {}, p.full),
      events: await recentEvents(t, s, d, "Pod", p.name, p.full),
    });
  }
  const rows = await scoped(s, t, d, () =>
    readList(
      { op: "list", resource: "pods", scope: s, selector: p.selector },
      t,
      d,
    ),
  );
  return renderList(
    rows.map((x) => podRow(x, s.kind === "all")),
    podSpec,
    p,
    scopeLabel(s),
    t.context,
  );
}
