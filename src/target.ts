import { AxiError } from "axi-sdk-js";
import { validateNamespace, type Parsed } from "./args.js";
import { fail } from "./errors.js";
import { kubectl } from "./kubectl.js";
import type { ContextName, Target, Scope, Deadline } from "./registry.js";
export type { Target, Scope, ContextName } from "./registry.js";
function isContext(value: string, names: string[]): value is ContextName {
  return names.includes(value);
}
export async function resolveTarget(
  flag: string | undefined,
  d: Deadline,
): Promise<Target> {
  const names = (
    await kubectl({ op: "local", query: "contexts" }, undefined, d)
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const name =
    flag ??
    (
      await kubectl({ op: "local", query: "current-context" }, undefined, d)
    ).trim();
  if (!name)
    fail("NO_CONTEXT", "no current context is configured", [
      "Configure a named kubeconfig context, then run `k8s-axi ctx`",
    ]);
  if (!isContext(name, names))
    fail("CONTEXT_NOT_FOUND", "configured context not found", [
      "Run `k8s-axi ctx` to list contexts",
    ]);
  const [server = "", ns = ""] = (
    await kubectl({ op: "target", context: name }, undefined, d)
  )
    .trim()
    .split(/\r?\n/);
  if (!/^https?:\/\//.test(server))
    fail("CONFIG_INVALID", "context has no valid server");
  // Server URLs may contain basic credentials; do not expose userinfo or queries.
  let safeServer: string;
  try {
    const url = new URL(server);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    safeServer = url.toString().replace(/\/$/, "");
  } catch {
    fail("CONFIG_INVALID", "context has no valid server");
  }
  return {
    context: name,
    server: safeServer,
    defaultNamespace: validateNamespace(ns || "default"),
    source: flag ? "flag" : "current",
  };
}
export function resolveScope(p: Parsed, target: Target): Scope {
  return p.all || (!p.namespace && ["home", "triage"].includes(p.command))
    ? { kind: "all" }
    : {
        kind: "namespace",
        name: p.namespace ?? target.defaultNamespace,
        source: p.namespace ? "flag" : "kubeconfig",
      };
}
export function scopeLabel(scope: Scope): string {
  return scope.kind === "all" ? "all namespaces" : `namespace ${scope.name}`;
}
export async function scoped<T>(
  scope: Scope,
  target: Target,
  d: Deadline,
  read: () => Promise<T[]>,
  count: (rows: T[]) => number = (rows) => rows.length,
): Promise<T[]> {
  if (scope.kind === "all") return read();
  const [preflight, data] = await Promise.allSettled([
    kubectl({ op: "namespace-exists", name: scope.name }, target, d),
    read(),
  ]);
  if (preflight.status === "rejected") {
    const e = preflight.reason;
    if (e instanceof AxiError && e.code === "NOT_FOUND")
      fail(
        "NAMESPACE_NOT_FOUND",
        `namespace ${scope.name} not found in context ${target.context}`,
        [
          "Run `k8s-axi namespaces` to list namespaces",
          "Use -A to search all namespaces",
        ],
      );
    if (!(e instanceof AxiError && e.code === "FORBIDDEN")) throw e;
    if (data.status === "fulfilled" && count(data.value) === 0)
      fail(
        "NAMESPACE_UNVERIFIED",
        `cannot verify empty namespace ${scope.name}`,
        ["Run `k8s-axi namespaces` or use -A"],
      );
  }
  if (data.status === "rejected") throw data.reason;
  return data.value;
}
