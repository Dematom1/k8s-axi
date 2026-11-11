import type { Parsed } from "./args.js";
import { usage } from "./errors.js";
import { encodeObject } from "./toon.js";
import { carriedFlags } from "./commands/common.js";
export interface Row {
  cells: Record<string, string | number>;
  problem: boolean;
  why: string;
  created: string;
}
export interface ListSpec {
  noun: string;
  defaults: readonly string[];
  fields: readonly string[];
}
export function validateFields(spec: ListSpec, p: Parsed): void {
  if (p.fields?.some((x) => !spec.fields.includes(x)))
    usage(`Unknown field; valid fields: ${spec.fields.join(", ")}`, spec.noun);
}
export function renderList(
  rows: Row[],
  spec: ListSpec,
  p: Parsed,
  scope: string,
  context: string,
): string {
  validateFields(spec, p);
  const filtered = (p.problems ? rows.filter((x) => x.problem) : rows).sort(
    (a, b) => Number(b.problem) - Number(a.problem),
  );
  const shown = filtered.slice(0, p.limit);
  const fields = p.fields ?? [...spec.defaults];
  const identity = ` --context ${JSON.stringify(context)}${scope.startsWith("namespace ") ? " -n " + scope.slice(10) : p.all ? " -A" : ""}`;
  const detail = [
    "nodes",
    "pods",
    "deployments",
    "secrets",
    "namespaces",
    "jobs",
    "pvcs",
    "services",
    "events",
  ].includes(spec.noun);
  const detailFlags = identity.replace(" -A", " -n <namespace>");
  const help = [
    shown.length
      ? `Run \`k8s-axi ${spec.noun}${detail ? " view <name>" : " --help"}${detail ? detailFlags : identity}\``
      : `Run \`k8s-axi ${spec.noun}${scope.startsWith("namespace ") ? " -A" : ""} --context ${JSON.stringify(context)}\` to search a wider scope`,
  ];
  if (shown.length < filtered.length)
    help.push(
      `Run \`k8s-axi ${spec.noun}${carriedFlags({ ...p, context })}${!p.all && !p.namespace && scope.startsWith("namespace ") ? " -n " + scope.slice(10) : ""}${p.problems ? " --problems" : ""}${p.warnings ? " --warnings" : ""}${p.since ? " --since " + p.since + "s" : ""}${p.forObject ? " --for " + p.forObject : ""} --limit ${Math.min(1000, filtered.length)}\` to see more (${filtered.length} matching rows)`,
    );
  return encodeObject({
    context,
    scope,
    count: `${shown.length} of ${rows.length} total`,
    total: rows.length,
    matching: filtered.length,
    truncated: shown.length < filtered.length,
    [spec.noun]: shown.length
      ? shown.map((r) =>
          Object.fromEntries(fields.map((f) => [f, r.cells[f] ?? "-"])),
        )
      : `0 ${p.problems ? "problem " : ""}${spec.noun} in ${scope}${scope.startsWith("namespace ") ? " (namespace exists)" : ""}`,
    help,
  });
}
