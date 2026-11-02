import type { NamespaceName, ResourceName, Selector } from "./args.js";
export const REFUSALS = [
  "apply",
  "create",
  "delete",
  "edit",
  "patch",
  "replace",
  "scale",
  "rollout",
  "label",
  "annotate",
  "taint",
  "cordon",
  "uncordon",
  "drain",
  "exec",
  "attach",
  "port-forward",
  "proxy",
  "cp",
  "debug",
  "run",
  "expose",
  "autoscale",
  "set",
  "certificate",
  "auth",
  "token",
  "login",
  "update",
  "get",
  "describe",
  "ctx use",
] as const;
export type ContextName = string & { readonly __brand: "ContextName" };
export interface Target {
  context: ContextName;
  server: string;
  defaultNamespace: NamespaceName;
  source: "flag" | "current";
}
export type Scope =
  | { kind: "all" }
  | { kind: "namespace"; name: NamespaceName; source: "flag" | "kubeconfig" };
export type ListResource =
  | "nodes"
  | "namespaces"
  | "pods"
  | "deployments.apps"
  | "jobs.batch"
  | "persistentvolumeclaims"
  | "services"
  | "endpointslices.discovery.k8s.io"
  | "events";
export interface EventFilter {
  warnings: boolean;
  kind?: string;
  name?: ResourceName;
}
export type Read =
  | { op: "local"; query: "current-context" | "contexts" | "client-version" }
  | { op: "target"; context: ContextName }
  | {
      op: "list";
      resource: ListResource;
      scope: Scope | "cluster";
      selector?: Selector;
      fieldSelector?: EventFilter;
    }
  | {
      op: "get";
      resource: "node" | "pod" | "deployment.apps" | "namespace";
      name: ResourceName | NamespaceName;
      namespace?: NamespaceName;
    }
  | { op: "namespace-exists"; name: NamespaceName }
  | { op: "secrets"; scope: Scope; name?: ResourceName }
  | {
      op: "logs";
      pod: ResourceName;
      namespace: NamespaceName;
      container: ResourceName;
      tail: number;
      sinceSeconds?: number;
      previous: boolean;
    }
  | { op: "server-version" };
export const SECRET_TEMPLATE =
  '{{range .items}}{{"["}}{{printf "%q" .metadata.namespace}},{{printf "%q" .metadata.name}},{{printf "%q" (printf "%v" .type)}},{{printf "%q" .metadata.creationTimestamp}},{{"["}}{{$sep := ""}}{{range $k, $_ := .data}}{{$sep}}{{printf "%q" $k}}{{$sep = ","}}{{end}}{{"]]\\n"}}{{end}}';
export const FORBIDDEN_ARGS = [
  "--raw",
  "-f",
  "--follow",
  "--watch",
  "-w",
  "-i",
  "--stdin",
  "-t",
  "--tty",
  "-v",
  "--v",
  "--token",
  "--as",
  "--as-group",
  "--as-uid",
  "--server",
  "-s",
  "--kubeconfig",
  "--insecure-skip-tls-verify",
  "--certificate-authority",
  "--client-key",
  "--client-certificate",
  "--username",
  "--password",
  "--cache-dir",
  "--subresource",
  "--kuberc",
];
export interface Deadline {
  end: number;
  perCall: number;
}
export function deadline(seconds = 20): Deadline {
  return {
    end: Date.now() + Math.max(45000, seconds * 2000),
    perCall: seconds * 1000,
  };
}
export function remaining(d: Deadline): number {
  return Math.max(0, Math.min(d.perCall, d.end - Date.now()));
}
function scopeArgs(s: Scope | "cluster"): string[] {
  return s === "cluster" ? [] : s.kind === "all" ? ["-A"] : ["-n", s.name];
}
export function argvFor(
  read: Read,
  target: Target | undefined,
  d: Deadline,
): string[] {
  if (read.op === "local")
    return read.query === "current-context"
      ? ["config", "current-context"]
      : read.query === "contexts"
        ? ["config", "get-contexts", "-o", "name"]
        : ["version", "--client", "-o", "json"];
  if (read.op === "target")
    return [
      "config",
      "view",
      "--minify",
      `--context=${read.context}`,
      "-o",
      'jsonpath={.clusters[0].cluster.server}{"\\n"}{.contexts[0].context.namespace}',
    ];
  if (!target) throw new Error("network read requires target");
  const pinned = [
    `--context=${target.context}`,
    `--request-timeout=${Math.max(1, remaining(d) - Math.min(5000, remaining(d) / 4))}ms`,
  ];
  let args: string[];
  switch (read.op) {
    case "namespace-exists":
      args = ["get", "namespace", read.name, "-o", "name"];
      break;
    case "list": {
      const f = read.fieldSelector;
      const fields = f
        ? [
            ...(f.warnings ? ["type=Warning"] : []),
            ...(f.kind ? [`involvedObject.kind=${f.kind}`] : []),
            ...(f.name ? [`involvedObject.name=${f.name}`] : []),
          ]
        : [];
      args = [
        "get",
        read.resource,
        ...scopeArgs(read.scope),
        ...(read.selector ? [`--selector=${read.selector}`] : []),
        ...(fields.length ? [`--field-selector=${fields.join(",")}`] : []),
        "-o",
        "json",
      ];
      break;
    }
    case "get":
      args = [
        "get",
        read.resource,
        read.name,
        ...(read.namespace ? ["-n", read.namespace] : []),
        "-o",
        "json",
      ];
      break;
    case "secrets":
      args = [
        "get",
        "secrets",
        ...scopeArgs(read.scope),
        ...(read.name ? [`--field-selector=metadata.name=${read.name}`] : []),
        `--output=go-template=${SECRET_TEMPLATE}`,
      ];
      break;
    case "logs":
      args = [
        "logs",
        read.pod,
        "-n",
        read.namespace,
        "-c",
        read.container,
        `--tail=${read.tail}`,
        "--limit-bytes=1048576",
        ...(read.sinceSeconds ? [`--since=${read.sinceSeconds}s`] : []),
        ...(read.previous ? ["--previous"] : []),
      ];
      break;
    case "server-version":
      args = ["version", "-o", "json"];
      break;
    default: {
      const exhaustive: never = read;
      throw new Error(String(exhaustive));
    }
  }
  return [...args, ...pinned];
}
export function assertSafe(argv: readonly string[]): void {
  if (
    !["config", "version", "get", "logs"].includes(argv[0] ?? "") ||
    (argv[0] === "config" &&
      !["current-context", "get-contexts", "view"].includes(argv[1] ?? "")) ||
    argv.some((x) => FORBIDDEN_ARGS.includes(x.split("=")[0] ?? ""))
  )
    throw new Error("unsafe kubectl invocation");
}
