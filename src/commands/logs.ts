import { validateResourceName, type Parsed } from "../args.js";
import { deadline } from "../registry.js";
import { resolveTarget, resolveScope, scoped, scopeLabel } from "../target.js";
import { kubectl, parseObject, object, objects, text } from "../kubectl.js";
import { usage } from "../errors.js";
import { redactText } from "../redact.js";
import { encodeObject } from "../toon.js";
import { preview } from "./common.js";
export async function logsCommand(p: Parsed): Promise<string> {
  const name = p.name;
  if (!name) usage("pods logs requires a pod", "pods");
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d),
    s = resolveScope(p, t);
  if (s.kind !== "namespace") usage("logs requires one namespace", "pods");
  const [pod] = await scoped(s, t, d, async () => [
    parseObject(
      await kubectl(
        { op: "get", resource: "pod", name, namespace: s.name },
        t,
        d,
      ),
    ),
  ]);
  const containers = [
    ...objects(object(pod?.spec).containers),
    ...objects(object(pod?.spec).initContainers),
  ].map((x) => text(x.name));
  const annotation = text(
    object(object(pod?.metadata).annotations)[
      "kubectl.kubernetes.io/default-container"
    ],
  );
  const selected =
    p.container ??
    (containers.includes(annotation)
      ? annotation
      : containers.length === 1
        ? containers[0]
        : undefined);
  if (!selected || !containers.includes(selected))
    usage(
      `choose -c <container>; containers: ${containers.join(", ")}`,
      "pods",
    );
  const container = validateResourceName(selected);
  const raw = await kubectl(
    {
      op: "logs",
      pod: name,
      namespace: s.name,
      container,
      tail: p.tail,
      sinceSeconds: p.since,
      previous: p.previous,
    },
    t,
    d,
  );
  const redacted = redactText(raw),
    cut = Buffer.byteLength(raw) >= 1048576;
  const shown = preview(redacted.text, p.full, 8000);
  return encodeObject({
    context: t.context,
    scope: scopeLabel(s),
    pod: name,
    container,
    redaction: "best effort",
    redacted: redacted.count,
    "byte-limited": cut,
    truncated: cut || shown.length < redacted.text.length,
    logs: shown.split(/\r?\n/),
    help:
      shown !== redacted.text
        ? [
            `Run \`k8s-axi pods logs ${name} -n ${s.name} --context ${JSON.stringify(t.context)} -c ${container} --full\` for the untruncated allowlisted text`,
          ]
        : [],
  });
}
