import type { Parsed } from "../args.js";
import { resolveTarget } from "../target.js";
import { deadline } from "../registry.js";
import { kubectl, parseJSON, object, text } from "../kubectl.js";
import { encodeObject } from "../toon.js";
export async function ctxCommand(p: Parsed): Promise<string> {
  const d = deadline(p.timeout);
  const target = await resolveTarget(p.context, d);
  const [names, raw] = await Promise.all([
    kubectl({ op: "local", query: "contexts" }, undefined, d),
    kubectl({ op: "local", query: "client-version" }, undefined, d),
  ]);
  const version = object(object(parseJSON(raw)).clientVersion);
  return encodeObject({
    context: target.context,
    server: target.server,
    namespace: target.defaultNamespace,
    kubectl: text(version.gitVersion, `1.${text(version.minor)}`),
    contexts: names.trim().split(/\r?\n/),
    help: ["Run `k8s-axi triage` for live cluster checks"],
  });
}
