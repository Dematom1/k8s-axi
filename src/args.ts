import { usage } from "./errors.js";
export type NamespaceName = string & { readonly __brand: "NamespaceName" };
export type ResourceName = string & { readonly __brand: "ResourceName" };
export type Selector = string & { readonly __brand: "Selector" };
function isNamespace(x: string): x is NamespaceName {
  return x.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x);
}
function isResource(x: string): x is ResourceName {
  return x.length <= 253 && x.split(".").every(isNamespace);
}
function isSelector(x: string): x is Selector {
  return (
    x.length > 0 &&
    x.length <= 4096 &&
    !x.startsWith("-") &&
    /^[a-zA-Z0-9_./=,!()\s-]+$/.test(x)
  );
}
export function validateNamespace(x: string): NamespaceName {
  if (!isNamespace(x)) usage("namespace must be a DNS label");
  return x;
}
export function validateResourceName(x: string): ResourceName {
  if (!isResource(x)) usage("name must be a lowercase DNS subdomain");
  return x;
}
export function validateSelector(x: string): Selector {
  if (!isSelector(x)) usage("invalid selector");
  return x;
}
export function integer(
  x: string,
  flag: string,
  min: number,
  max: number,
): number {
  if (!/^\d+$/.test(x) || Number(x) < min || Number(x) > max)
    usage(`${flag} must be an integer from ${min} to ${max}`);
  return Number(x);
}
export function parseDuration(x: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(x);
  if (!m) usage("duration needs a unit: 30s, 15m, 1h, 1d");
  const n =
    Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? ""] ?? 0);
  if (!Number.isSafeInteger(n) || n <= 0) usage("duration must be positive");
  return n;
}
export const NOUNS = [
  "nodes",
  "namespaces",
  "pods",
  "deployments",
  "jobs",
  "pvcs",
  "services",
  "events",
  "secrets",
  "triage",
  "ctx",
  "setup",
  "context",
  "audit",
] as const;
export type Noun = (typeof NOUNS)[number];
const globalFlags = ["context", "timeout", "help"];
const listFlags = [
  "namespace",
  "all-namespaces",
  "selector",
  "problems",
  "limit",
  "fields",
  "full",
];
const aliases: Record<string, string> = {
  n: "namespace",
  A: "all-namespaces",
  l: "selector",
  c: "container",
  h: "help",
};
const booleans = new Set([
  "help",
  "all-namespaces",
  "problems",
  "full",
  "warnings",
  "previous",
]);
const hints: Record<string, string> = {
  follow: "Nothing streams; use --tail and --since",
  f: "Nothing streams; use --tail and --since",
  watch: "Nothing streams; use --tail and --since",
  w: "Nothing streams; use --tail and --since",
  o: "Output is always TOON",
  output: "Output is always TOON",
  json: "Output is always TOON",
  reveal: "Secret values are never shown; no flag reveals them",
  decode: "Secret values are never shown; no flag reveals them",
  "show-values": "Secret values are never shown; no flag reveals them",
  kubeconfig: "Set KUBECONFIG in the environment",
  as: "Uses the context as configured",
  token: "Uses the context as configured",
  server: "Uses the context as configured",
};
export interface Parsed {
  command: Noun | "home";
  action: string;
  name?: ResourceName;
  context?: string;
  namespace?: NamespaceName;
  all: boolean;
  selector?: Selector;
  limit: number;
  fields?: string[];
  problems: boolean;
  full: boolean;
  timeout: number;
  help: boolean;
  warnings: boolean;
  since?: number;
  forObject?: string;
  container?: ResourceName;
  tail: number;
  previous: boolean;
  rolloutStatus: boolean;
  auditAction?: "exec" | "port-forward" | "apply";
}
export function parseArgs(command: Parsed["command"], args: string[]): Parsed {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  const allowed = [
    ...globalFlags,
    ...(command === "audit"
      ? ["limit", "action"]
      : ["ctx", "context", "setup"].includes(command)
        ? []
        : listFlags.filter(
            (f) =>
              f !== "selector" ||
              ["pods", "deployments", "jobs"].includes(command),
          )),
    ...(command === "events" ? ["warnings", "since", "for"] : []),
    ...(command === "pods" ? ["container", "tail", "since", "previous"] : []),
  ];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) {
      pos.push(arg);
      continue;
    }
    const [raw = "", ...rest] = arg.replace(/^--?/, "").split("=");
    const key = aliases[raw] ?? raw;
    if (!allowed.includes(key))
      usage(
        `${hints[raw] ?? `Unknown flag ${arg}`}; valid flags: ${allowed.map((x) => "--" + x).join(", ")}`,
        command,
      );
    if (flags.has(key)) usage(`Repeated --${key}`, command);
    if (booleans.has(key)) {
      if (rest.length) usage(`--${key} takes no value`, command);
      flags.set(key, true);
    } else {
      const value = rest.length ? rest.join("=") : args[++i];
      if (!value || value.startsWith("-"))
        usage(`--${key} requires a value`, command);
      flags.set(key, value);
    }
  }
  const str = (key: string): string | undefined => {
    const v = flags.get(key);
    return typeof v === "string" ? v : undefined;
  };
  let action = "list";
  let name: ResourceName | undefined;
  if (pos.length) {
    action = pos[0] ?? "";
    const actions =
      command === "pods"
        ? ["view", "logs"]
        : [
              "nodes",
              "namespaces",
              "deployments",
              "jobs",
              "pvcs",
              "services",
              "events",
              "secrets",
            ].includes(command)
          ? ["view"]
          : command === "setup"
            ? ["hooks", "status", "uninstall"]
            : command === "context"
              ? ["end"]
              : [];
    if (!actions.includes(action))
      usage(`Unknown subcommand ${action}`, command);
    if (["view", "logs"].includes(action)) {
      if (pos.length !== 2 && !(flags.has("help") && pos.length === 1))
        usage(`${action} requires one name`, command);
      if (pos[1]) name = validateResourceName(pos[1]);
    } else if (pos.length !== 1) usage("Surplus positional arguments", command);
  }
  if (flags.has("all-namespaces") && flags.has("namespace"))
    usage("-A and -n are mutually exclusive", command);
  if (["view", "logs"].includes(action) && flags.has("all-namespaces"))
    usage("view and logs require one namespace, not -A", command);
  if (
    (flags.has("container") && action !== "logs") ||
    (flags.has("tail") && action !== "logs") ||
    (flags.has("previous") && action !== "logs")
  )
    usage("log flags require pods logs", command);
  if (
    ["nodes", "namespaces"].includes(command) &&
    ["namespace", "all-namespaces", "selector"].some((x) => flags.has(x))
  )
    usage("cluster-scoped command does not accept scope flags", command);
  if (
    command === "events" &&
    action === "view" &&
    ["warnings", "since", "for"].some((f) => flags.has(f))
  )
    usage("event filters require a list command", command);
  if (command === "pods" && flags.has("since") && action !== "logs")
    usage("--since requires pods logs", command);
  if (
    ["view", "logs"].includes(action) &&
    ["selector", "problems", "limit", "fields"].some((f) => flags.has(f))
  )
    usage("list flags require a list command", command);
  const auditAction = str("action");
  if (auditAction && !["exec", "port-forward", "apply"].includes(auditAction))
    usage("--action must be exec, port-forward, or apply", command);
  const forObject = str("for");
  if (
    forObject &&
    !/^[A-Za-z][A-Za-z0-9]*\/[a-z0-9][a-z0-9.-]*$/.test(forObject)
  )
    usage("--for needs Kind/name", command);
  return {
    command,
    action,
    name,
    context: str("context"),
    namespace: str("namespace")
      ? validateNamespace(str("namespace") ?? "")
      : undefined,
    all: flags.has("all-namespaces"),
    selector: str("selector")
      ? validateSelector(str("selector") ?? "")
      : undefined,
    limit: integer(str("limit") ?? "100", "--limit", 1, 1000),
    fields: str("fields")?.split(","),
    problems: flags.has("problems"),
    full: flags.has("full"),
    timeout: integer(str("timeout") ?? "20", "--timeout", 1, 120),
    help: flags.has("help"),
    warnings: flags.has("warnings"),
    since: str("since") ? parseDuration(str("since") ?? "") : undefined,
    forObject,
    container: str("container")
      ? validateResourceName(str("container") ?? "")
      : undefined,
    tail: integer(str("tail") ?? "100", "--tail", 1, 1000),
    previous: flags.has("previous"),
    rolloutStatus: false,
    auditAction:
      auditAction === "exec" ||
      auditAction === "port-forward" ||
      auditAction === "apply"
        ? auditAction
        : undefined,
  };
}
