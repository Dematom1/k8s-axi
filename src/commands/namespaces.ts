import type { Parsed } from "../args.js";
import { resolveTarget } from "../target.js";
import { deadline } from "../registry.js";
import { readList, object, text } from "../kubectl.js";
import { encodeObject } from "../toon.js";
export async function namespacesCommand(p: Parsed): Promise<string> {
  const d = deadline(p.timeout);
  const target = await resolveTarget(p.context, d);
  const rows = await readList(
    { op: "list", resource: "namespaces", scope: "cluster" },
    target,
    d,
  );
  const shown = rows.slice(0, p.limit).map((x) => ({
    namespace: text(object(x.metadata).name),
    status: text(object(x.status).phase),
    age: text(object(x.metadata).creationTimestamp),
  }));
  return encodeObject({
    context: target.context,
    count: `${shown.length} of ${rows.length} total`,
    namespaces: shown.length ? shown : "0 namespaces found in the cluster",
    truncated: shown.length < rows.length,
    help: ["Run `k8s-axi pods -n <namespace>`"],
  });
}
