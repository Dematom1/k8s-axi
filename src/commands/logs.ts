import { validateResourceName, type Parsed } from "../args.js";
import { deadline } from "../registry.js";
import { resolveTarget, resolveScope, scoped, scopeLabel } from "../target.js";
import { kubectl, parseObject, object, objects, text } from "../kubectl.js";
import { usage } from "../errors.js";
import { redactText } from "../redact.js";
import { encodeObject } from "../toon.js";
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
  const lines = redacted.text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const tailLines = lines.slice(-p.tail);
  const shownLines: string[] = [];
  let previewChars = 0;
  for (const line of tailLines.slice().reverse()) {
    const length = line.length + (shownLines.length ? 1 : 0);
    if (!p.full && previewChars + length > 8000) break;
    shownLines.unshift(line);
    previewChars += length;
  }
  const omitted = lines.length - shownLines.length;
  const previewTruncated = !p.full && shownLines.length < tailLines.length;
  const nextTail = Math.min(1000, p.tail * 2);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const command = `k8s-axi pods logs ${quote(name)} -n ${quote(s.name)} --context ${quote(t.context)} -c ${quote(container)}`;
  const carried = `${p.sinceArg ? ` --since ${quote(p.sinceArg)}` : ""}${p.previous ? " --previous" : ""}`;
  const help = previewTruncated
    ? `Run \`${command} --tail ${p.tail}${carried} --full\` to remove the character preview limit; --full does not fetch lines beyond --tail`
    : omitted > 0 && p.tail < 1000
      ? `Run \`${command} --tail ${nextTail}${carried}\` for more logs`
      : omitted > 0
        ? `The current CLI cannot page farther back: --tail is capped at 1000. --since filters by time but does not bypass that cap${p.sinceArg ? ` (currently --since ${quote(p.sinceArg)})` : ""}.`
        : cut
          ? `The log response reached kubectl's 1 MiB limit; try a smaller --tail or --since window. Request: \`${command} --tail ${p.tail}${carried}\``
          : undefined;
  return encodeObject({
    context: t.context,
    scope: scopeLabel(s),
    pod: name,
    container,
    redaction: "best effort",
    redacted: redacted.count,
    "byte-limited": cut,
    truncated: cut || omitted > 0,
    "omitted-lines": omitted,
    shown: shownLines.length ? `${shownLines[0]}..${shownLines.at(-1)}` : "",
    logs: shownLines,
    ...(help ? { help: [help] } : {}),
  });
}
