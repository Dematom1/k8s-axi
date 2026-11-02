import type { Parsed } from "../args.js";
import { usage } from "../errors.js";
import { deadline } from "../registry.js";
import { resolveTarget, resolveScope, scopeLabel, scoped } from "../target.js";
import { runChecks, verdict, complete, type Verdict } from "../checks.js";
import { encodeObject } from "../toon.js";
import { age } from "../model/time.js";
import { versionWarning } from "../skew.js";
export function headline(v: Verdict, failed: number, problems: number): string {
  switch (v) {
    case "healthy":
      return "healthy - all checks completed";
    case "problems":
      return `problems - ${problems} problems found`;
    case "partial":
      return `partial - ${failed} of 7 checks failed; ${problems} problems found so far; cluster health unknown`;
    case "unknown":
      return "unknown - all checks failed; cluster health unknown";
    default: {
      const exhaustive: never = v;
      return exhaustive;
    }
  }
}
export async function triageCommand(p: Parsed): Promise<string> {
  if (p.fields || p.selector || p.problems || p.full)
    usage("triage accepts scope, context, timeout and limit only", "triage");
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d),
    s = resolveScope(p, t);
  const checks = await scoped(
    s,
    t,
    d,
    () => runChecks(t, s, d),
    (cs) =>
      cs.reduce(
        (n, c) =>
          n + (c.state === "ok" && c.name !== "nodes" ? c.value.length : 0),
        0,
      ),
  );
  const v = verdict(checks),
    failed = checks.filter((c) => c.state === "failed");
  const problems = checks.flatMap((c) =>
    c.state === "ok"
      ? c.value
          .filter((r) => r.problem)
          .map((r) => ({
            object: `${c.name}/${r.cells[Object.keys(r.cells)[0] ?? ""] ?? "?"}`,
            status: r.cells.status ?? "problem",
            why: r.why,
            age: age(r.created),
          }))
      : [],
  );
  const shown = problems.slice(0, p.command === "home" ? 10 : p.limit);
  if (!complete(v)) process.exitCode = 1;
  return encodeObject({
    context: t.context,
    server: t.server,
    scope: scopeLabel(s),
    status: headline(v, failed.length, problems.length),
    complete: complete(v),
    ...(!complete(v) ? { code: "PARTIAL" } : {}),
    checks: checks.map((c) => ({
      check: c.name,
      state: c.state,
      total: c.state === "ok" ? c.value.length : "",
      problems: c.state === "ok" ? c.value.filter((r) => r.problem).length : "",
    })),
    ...(failed.length
      ? {
          failed: failed.map((c) => ({
            check: c.name,
            code: c.code,
            reason: c.reason,
          })),
        }
      : {}),
    count: `${shown.length} of ${problems.length} problems`,
    truncated: shown.length < problems.length,
    problems: shown,
    ...(p.command === "home" ? { warning: await versionWarning(t, d) } : {}),
    help: [
      `Run \`k8s-axi pods --problems${s.kind === "all" ? " -A" : ` -n ${s.name}`} --context ${JSON.stringify(t.context)}\` for pod diagnostics`,
      ...(failed.length
        ? [
            "Run `k8s-axi <failed-check> -n <namespace>` to narrow a failed read",
          ]
        : []),
    ],
  });
}
