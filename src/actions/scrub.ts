import { object, objects, text, type Obj } from "../kubectl.js";
import { CREDENTIAL_NAME } from "../redact.js";

const MARKER = "[REDACTED SECRET VALUE]";

export class ScrubSet {
  #forms: string[];
  constructor(values: readonly Buffer[]) {
    const forms = new Set<string>();
    for (const bytes of values) {
      const raw = bytes.toString("utf8");
      if (raw.length >= 4) forms.add(raw);
      const add = (s: string) => {
        if (s.length >= 8) forms.add(s);
      };
      add(bytes.toString("hex"));
      add(bytes.toString("hex").toUpperCase());
      const encodedUri = encodeURIComponent(raw);
      add(encodedUri);
      add(encodedUri.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
      const percent = Array.from(
        bytes,
        (b) => "%" + b.toString(16).padStart(2, "0"),
      ).join("");
      add(percent);
      add(percent.toUpperCase());
      for (const encoding of ["base64", "base64url"] as const) {
        const encoded = bytes.toString(encoding);
        add(encoded);
        add(encoded.replace(/=+$/, ""));
        for (let prefix = 0; prefix < 3; prefix++) {
          const aligned = Buffer.concat([Buffer.alloc(prefix), bytes]).toString(
            encoding,
          );
          add(
            aligned.slice(
              Math.ceil((prefix * 8) / 6),
              Math.floor(((prefix + bytes.length) * 8) / 6),
            ),
          );
        }
      }
    }
    this.#forms = [...forms].sort((a, b) => b.length - a.length);
  }
  scrub(text: string): { text: string; count: number } {
    // Match against the original text so a short value cannot corrupt a marker.
    const matches: { start: number; end: number }[] = [];
    for (const form of this.#forms) {
      for (
        let start = text.indexOf(form);
        start !== -1;
        start = text.indexOf(form, start + 1)
      )
        matches.push({ start, end: start + form.length });
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = 0,
      result = "",
      count = 0;
    for (const match of matches) {
      if (match.start < end) {
        end = Math.max(end, match.end);
        continue;
      }
      result += text.slice(end, match.start) + MARKER;
      end = match.end;
      count++;
    }
    return { text: result + text.slice(end), count };
  }
}

export interface SecretReference {
  name: string;
  optional: boolean;
}
export function scrubSources(
  podSpec: Obj,
  containerName: string,
): {
  secrets: SecretReference[];
  literals: { name: string; value: string }[];
} {
  const container = objects(podSpec.containers)
    .concat(objects(podSpec.initContainers))
    .find((c) => c.name === containerName);
  const references: SecretReference[] = [];
  const add = (ref: Obj, nameKey: string) => {
    const name = text(ref[nameKey]);
    if (name) references.push({ name, optional: ref.optional === true });
  };
  for (const env of objects(container?.env))
    add(object(object(env.valueFrom).secretKeyRef), "name");
  for (const env of objects(container?.envFrom))
    add(object(env.secretRef), "name");
  for (const mount of objects(container?.volumeMounts)) {
    const volume = objects(podSpec.volumes).find((v) => v.name === mount.name);
    add(object(volume?.secret), "secretName");
    for (const source of objects(object(volume?.projected).sources))
      add(object(source.secret), "name");
  }
  const secrets = [...new Set(references.map((r) => r.name))].map((name) => ({
    name,
    optional: references
      .filter((r) => r.name === name)
      .every((r) => r.optional),
  }));
  const literals = objects(container?.env)
    .filter(
      (env) =>
        typeof env.value === "string" && CREDENTIAL_NAME.test(text(env.name)),
    )
    .map((env) => ({ name: text(env.name), value: text(env.value) }));
  return { secrets, literals };
}
