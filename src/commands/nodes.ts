import type { Parsed } from "../args.js";
import { deadline } from "../registry.js";
import { resolveTarget } from "../target.js";
import { kubectl, parseObject, readList } from "../kubectl.js";
import { nodeRow, nodeDetail, nodeSpec } from "../model/nodes.js";
import { renderList, validateFields } from "../render.js";
import { encodeObject } from "../toon.js";
import { recentEvents } from "./events.js";
export async function nodesCommand(p: Parsed): Promise<string> {
  validateFields(nodeSpec, p);
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d);
  if (p.action === "view" && p.name) {
    const raw = parseObject(
      await kubectl({ op: "get", resource: "node", name: p.name }, t, d),
    );
    return encodeObject({
      context: t.context,
      ...nodeDetail(raw, p.full),
      events: await recentEvents(t, { kind: "all" }, d, "Node", p.name, p.full),
    });
  }
  return renderList(
    (
      await readList({ op: "list", resource: "nodes", scope: "cluster" }, t, d)
    ).map(nodeRow),
    nodeSpec,
    p,
    "cluster",
    t.context,
  );
}
