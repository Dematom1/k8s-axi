import { validateNamespace, type Parsed } from "../args.js";
import { resolveTarget } from "../target.js";
import { deadline } from "../registry.js";
import { kubectl, parseObject, readList, object, text } from "../kubectl.js";
import { age } from "../model/time.js";
import { conditionRows } from "../model/nodes.js";
import { encodeObject } from "../toon.js";
import { renderList, validateFields } from "../render.js";
const spec = {
  noun: "namespaces",
  defaults: ["namespace", "status", "age"],
  fields: ["namespace", "status", "age"],
};
export async function namespacesCommand(p: Parsed): Promise<string> {
  validateFields(spec, p);
  const name =
    p.action === "view" && p.name ? validateNamespace(p.name) : undefined;
  const d = deadline(p.timeout),
    target = await resolveTarget(p.context, d);
  if (name) {
    const raw = parseObject(
      await kubectl({ op: "get", resource: "namespace", name }, target, d),
    );
    const meta = object(raw.metadata),
      status = object(raw.status);
    return encodeObject({
      context: target.context,
      namespace: text(meta.name),
      status: text(status.phase),
      age: age(text(meta.creationTimestamp)),
      conditions: conditionRows(status.conditions, p.full),
    });
  }
  const rows = (
    await readList(
      { op: "list", resource: "namespaces", scope: "cluster" },
      target,
      d,
    )
  ).map((x) => ({
    problem: object(x.status).phase === "Terminating",
    why: "",
    created: text(object(x.metadata).creationTimestamp),
    cells: {
      namespace: text(object(x.metadata).name),
      status: text(object(x.status).phase),
      age: age(text(object(x.metadata).creationTimestamp)),
    },
  }));
  return renderList(rows, spec, p, "cluster", target.context);
}
