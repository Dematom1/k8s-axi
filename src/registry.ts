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
      resource: "node" | "pod" | "deployment.apps" | "namespace" | "services";
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
  const reject = () => {
    throw new Error("unsafe kubectl invocation");
  };
  if (argv.some((x) => FORBIDDEN_ARGS.includes(x.split("=")[0] ?? "")))
    reject();
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  if (argv[0] === "config") {
    if (
      same(argv, ["config", "current-context"]) ||
      same(argv, ["config", "get-contexts", "-o", "name"])
    )
      return;
    if (
      argv.length === 6 &&
      argv[1] === "view" &&
      argv[2] === "--minify" &&
      argv[3]?.startsWith("--context=") &&
      argv[4] === "-o" &&
      argv[5] ===
        'jsonpath={.clusters[0].cluster.server}{"\\n"}{.contexts[0].context.namespace}'
    )
      return;
    reject();
  }
  if (same(argv, ["version", "--client", "-o", "json"])) return;
  if (
    !argv.at(-2)?.startsWith("--context=") ||
    !/^--request-timeout=\d+(?:\.\d+)?ms$/.test(argv.at(-1) ?? "")
  )
    reject();
  const a = argv.slice(0, -2);
  if (same(a, ["version", "-o", "json"])) return;
  const dns = (s: string | undefined) =>
    !!s &&
    s.length <= 253 &&
    s
      .split(".")
      .every(
        (x) => x.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x),
      );
  if (a[0] === "logs") {
    if (
      dns(a[1]) &&
      a[2] === "-n" &&
      dns(a[3]) &&
      a[4] === "-c" &&
      dns(a[5]) &&
      /^--tail=\d+$/.test(a[6] ?? "") &&
      Number(a[6]?.slice(7)) >= 1 &&
      Number(a[6]?.slice(7)) <= 1000 &&
      a[7] === "--limit-bytes=1048576" &&
      a
        .slice(8)
        .every(
          (x, i) =>
            (x === "--previous" && i === a.length - 9) ||
            (/^--since=\d+s$/.test(x) && i === 0),
        ) &&
      a.length <= 10
    )
      return;
    reject();
  }
  if (a[0] !== "get") reject();
  const resource = a[1],
    rest = a.slice(2);
  if (
    ["node", "pod", "deployment.apps", "namespace"].includes(resource ?? "") &&
    dns(rest[0])
  ) {
    const scope = rest.slice(1, -2);
    if (
      ((!scope.length &&
        resource !== "pod" &&
        resource !== "deployment.apps") ||
        (scope.length === 2 && scope[0] === "-n" && dns(scope[1]))) &&
      rest.at(-2) === "-o" &&
      (rest.at(-1) === "json" ||
        (resource === "namespace" && rest.at(-1) === "name"))
    )
      return;
    reject();
  }
  if (
    ![
      "nodes",
      "namespaces",
      "pods",
      "deployments.apps",
      "jobs.batch",
      "persistentvolumeclaims",
      "services",
      "endpointslices.discovery.k8s.io",
      "events",
      "secrets",
    ].includes(resource ?? "")
  )
    reject();
  if (!["nodes", "namespaces"].includes(resource ?? "")) {
    if (rest[0] === "-A") rest.shift();
    else if (rest[0] === "-n" && dns(rest[1])) rest.splice(0, 2);
    else reject();
  }
  if (resource === "secrets") {
    if (
      rest[0]?.startsWith("--field-selector=metadata.name=") &&
      dns(rest[0].slice("--field-selector=metadata.name=".length))
    )
      rest.shift();
    if (same(rest, [`--output=go-template=${SECRET_TEMPLATE}`])) return;
    reject();
  }
  if (
    ["pods", "deployments.apps", "jobs.batch"].includes(resource ?? "") &&
    rest[0]?.startsWith("--selector=")
  )
    rest.shift();
  if (
    resource === "events" &&
    rest[0]?.startsWith("--field-selector=") &&
    /^--field-selector=(?:type=Warning(?:,|$))?(?:involvedObject.kind=[A-Za-z][A-Za-z0-9]*(?:,|$))?(?:involvedObject.name=[a-z0-9.-]+)?$/.test(
      rest[0],
    )
  )
    rest.shift();
  if (same(rest, ["-o", "json"])) return;
  reject();
}
