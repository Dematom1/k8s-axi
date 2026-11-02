import { object, objects, text, type Obj } from "../kubectl.js";
import { age } from "./time.js";
import type { Row, ListSpec } from "../render.js";
export const serviceSpec: ListSpec = {
  noun: "services",
  defaults: ["service", "type", "endpoints", "status"],
  fields: ["service", "type", "endpoints", "status", "age"],
};
export function serviceRows(
  services: Obj[],
  slices: Obj[],
  all = false,
): Row[] {
  const counts = new Map<string, number>();
  for (const slice of slices) {
    const m = object(slice.metadata),
      key = `${text(m.namespace)}/${text(object(m.labels)["kubernetes.io/service-name"])}`;
    counts.set(
      key,
      (counts.get(key) ?? 0) +
        objects(slice.endpoints).filter(
          (e) => object(e.conditions).ready !== false,
        ).length,
    );
  }
  return services.map((raw) => {
    const m = object(raw.metadata),
      spec = object(raw.spec),
      id = `${text(m.namespace)}/${text(m.name)}`,
      ready = counts.get(id) ?? 0,
      type = text(spec.type, "ClusterIP"),
      na =
        type === "ExternalName" ||
        Object.keys(object(spec.selector)).length === 0,
      problem = !na && ready === 0;
    return {
      problem,
      why: problem ? "no ready endpoints" : "",
      created: text(m.creationTimestamp),
      cells: {
        service: all ? id : text(m.name),
        type,
        endpoints: na ? "n/a" : ready,
        status: na ? "n/a" : problem ? "NoReadyEndpoints" : "Ready",
        age: age(text(m.creationTimestamp)),
      },
    };
  });
}
