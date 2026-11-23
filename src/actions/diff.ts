import { object, type Obj } from "../kubectl.js";
import { redactText } from "../redact.js";
import { preview } from "../commands/common.js";

const credentials =
  /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|_(?:PASS|PWD|KEY))$/i;
function credentialFlag(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^--?[^=]+$/.test(value) &&
    (value === "-p" || credentials.test(value.replace(/^--?/, "")))
  );
}
export interface Change {
  object: string;
  path: string;
  before: unknown;
  after: unknown;
}

export function normalize(value: Obj): Obj {
  const result = structuredClone(value);
  delete result.status;
  const meta = object(result.metadata);
  for (const key of [
    "managedFields",
    "resourceVersion",
    "uid",
    "generation",
    "creationTimestamp",
    "selfLink",
  ])
    delete meta[key];
  const annotations = object(meta.annotations);
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  if (!Object.keys(annotations).length) delete meta.annotations;
  return result;
}

export function structuralDiff(
  id: string,
  before: Obj,
  after: Obj,
  full = false,
): Change[] {
  const changes: Change[] = [];
  const sanitize = (v: unknown, sensitive = false): unknown => {
    if (sensitive) return v === undefined ? null : "[REDACTED]";
    if (typeof v === "string") return redactText(v).text;
    if (Array.isArray(v))
      return v.map((value, i) => sanitize(value, credentialFlag(v[i - 1])));
    if (v && typeof v === "object") {
      const obj = object(v);
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [
          key,
          sanitize(
            value,
            credentials.test(key) ||
              (key === "value" &&
                typeof obj.name === "string" &&
                credentials.test(obj.name)),
          ),
        ]),
      );
    }
    return v ?? null;
  };
  const render = (v: unknown, sensitive = false): unknown => {
    const safe = sanitize(v, sensitive);
    if (typeof safe === "string") return preview(safe, full);
    return safe && typeof safe === "object"
      ? preview(JSON.stringify(safe), full)
      : safe;
  };
  function visit(
    a: unknown,
    b: unknown,
    path: string,
    sensitive = false,
  ): void {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (sensitive) {
      changes.push({
        object: id,
        path,
        before: render(a, true),
        after: render(b, true),
      });
      return;
    }
    if (
      a !== undefined &&
      b !== undefined &&
      (typeof a !== typeof b ||
        (a === null) !== (b === null) ||
        Array.isArray(a) !== Array.isArray(b))
    ) {
      changes.push({ object: id, path, before: render(a), after: render(b) });
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      const left: unknown[] = Array.isArray(a) ? a : [],
        right: unknown[] = Array.isArray(b) ? b : [];
      if (!left.length && !right.length)
        changes.push({ object: id, path, before: render(a), after: render(b) });
      for (let i = 0; i < Math.max(left.length, right.length); i++)
        visit(
          left[i],
          right[i],
          `${path}[${i}]`,
          credentialFlag(left[i - 1]) || credentialFlag(right[i - 1]),
        );
    } else if (
      (typeof a === "object" && a !== null) ||
      (typeof b === "object" && b !== null)
    ) {
      const left = object(a),
        right = object(b);
      if (!Object.keys(left).length && !Object.keys(right).length)
        changes.push({ object: id, path, before: render(a), after: render(b) });
      const sensitive = [left.name, right.name].some(
        (v) => typeof v === "string" && credentials.test(v),
      );
      for (const key of new Set([
        ...Object.keys(left),
        ...Object.keys(right),
      ])) {
        const next = path ? `${path}.${key}` : key;
        visit(
          left[key],
          right[key],
          next,
          credentials.test(key) || (key === "value" && sensitive),
        );
      }
    } else
      changes.push({ object: id, path, before: render(a), after: render(b) });
  }
  visit(normalize(before), normalize(after), "");
  return changes;
}
