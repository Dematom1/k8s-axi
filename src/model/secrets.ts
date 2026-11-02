import { fail } from "../errors.js";
import { age } from "./time.js";
import type { ListSpec, Row } from "../render.js";
export interface SecretMeta {
  namespace: string;
  name: string;
  type: string;
  created: string;
  keys: string[];
}
export const secretSpec: ListSpec = {
  noun: "secrets",
  defaults: ["secret", "type", "keys", "age"],
  fields: ["secret", "type", "keys", "age", "key-names"],
};
export function parseSecrets(raw: string): SecretMeta[] {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        fail("UPSTREAM_ERROR", "invalid Secret metadata response");
      }
      if (
        !Array.isArray(v) ||
        v.length !== 5 ||
        typeof v[0] !== "string" ||
        typeof v[1] !== "string" ||
        typeof v[2] !== "string" ||
        typeof v[3] !== "string" ||
        !Array.isArray(v[4]) ||
        !v[4].every((x: unknown) => typeof x === "string")
      )
        fail("UPSTREAM_ERROR", "invalid Secret metadata response");
      return {
        namespace: v[0],
        name: v[1],
        type: v[2],
        created: v[3],
        keys: v[4],
      };
    });
}
export function secretRow(s: SecretMeta, all = false): Row {
  return {
    problem: false,
    why: "",
    created: s.created,
    cells: {
      secret: `${all ? s.namespace + "/" : ""}${s.name}`,
      type: s.type,
      keys: s.keys.length,
      age: age(s.created),
      "key-names": s.keys.join(", "),
    },
  };
}
export function secretDetail(s: SecretMeta): Record<string, unknown> {
  return {
    namespace: s.namespace,
    name: s.name,
    type: s.type,
    created: s.created,
    age: age(s.created),
    "key-names": s.keys,
    values: "never shown",
  };
}
