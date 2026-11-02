import { object, text, number, type Obj } from "../kubectl.js";
import { redactText } from "../redact.js";
import { preview } from "../commands/common.js";
import { age } from "./time.js";
import type { Row, ListSpec } from "../render.js";
export const eventSpec: ListSpec = {
  noun: "events",
  defaults: ["time", "reason", "object", "message"],
  fields: ["time", "reason", "object", "message", "namespace", "type", "count"],
};
export function eventTime(raw: Obj): string {
  return (
    text(object(raw.series).lastObservedTime) ||
    text(raw.lastTimestamp) ||
    text(raw.eventTime) ||
    text(object(raw.metadata).creationTimestamp)
  );
}
export function eventRow(raw: Obj, full = false): Row {
  const meta = object(raw.metadata),
    involved = object(raw.involvedObject),
    when = eventTime(raw),
    count = number(object(raw.series).count, number(raw.count, 1)),
    type = text(raw.type);
  return {
    problem: false,
    why: "",
    created: when,
    cells: {
      time: `${when || "unknown"} (${age(when)})`,
      reason: `${type} ${text(raw.reason)} x${count}`,
      object: `${text(meta.namespace)}/${text(involved.kind)}/${text(involved.name)}`,
      message: preview(redactText(text(raw.message)).text, full),
      namespace: text(meta.namespace),
      type,
      count,
    },
  };
}
export function eventRows(raw: Obj[], full = false, since?: number): Row[] {
  return raw
    .filter(
      (x) => !since || Date.parse(eventTime(x)) >= Date.now() - since * 1000,
    )
    .sort(
      (a, b) =>
        (Date.parse(eventTime(b)) || 0) - (Date.parse(eventTime(a)) || 0),
    )
    .map((x) => eventRow(x, full));
}
