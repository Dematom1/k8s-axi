import { AxiError } from "axi-sdk-js";
import { getSystemErrorName } from "node:util";
import {
  integer,
  parseDuration,
  validateNamespace,
  validateResourceName,
  validateSelector,
} from "../args.js";
import { deadline, remaining, type Target } from "../registry.js";
import { resolveTarget } from "../target.js";
import {
  kubectl,
  mapKubectlFailure,
  object,
  objects,
  parseObject,
  parseList,
  text,
} from "../kubectl.js";
import { runProcess } from "../process.js";
import {
  argvForAction,
  assertSafeAction,
  requireExecuteTarget,
} from "../actions/registry.js";
import { appendAudit, newAuditId } from "../actions/audit.js";
import {
  allSessions,
  reapSessions,
  startSession,
  stopSession,
  validSessionId,
  withSessions,
} from "../actions/port-forward.js";
import { encodeObject } from "../toon.js";
import { fail, usage } from "../errors.js";

const HELP = {
  command: "k8s-axi port-forward",
  commands: [
    "port-forward <pod|pod/name|service/name|deployment/name> [local:]remote",
    "port-forward list",
    "port-forward stop <id> | --all",
  ],
  flags: [
    "-n <namespace>, --context <name> (both required with --execute)",
    "--execute (default: preview only)",
    "--ttl <10s..60m> (15m)",
    "--timeout <1..120 seconds> (20, preflight only)",
    "--help",
    "stop: --all; list/stop make no cluster calls",
  ],
  examples: [
    "k8s-axi port-forward deployment/echo :8080 -n fixtures --context lab",
    "k8s-axi port-forward deployment/echo :8080 -n fixtures --context lab --execute --ttl 10s",
    "k8s-axi port-forward stop --all",
  ],
};
function parse(args: string[]) {
  const pos: string[] = [],
    flags = new Map<string, string | true>();
  const local = args[0] === "list" || args[0] === "stop";
  const allowed = local
    ? args[0] === "stop"
      ? ["all"]
      : []
    : ["namespace", "context", "timeout", "ttl", "execute"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) {
      pos.push(arg);
      continue;
    }
    const [raw = "", ...rest] = arg.replace(/^--?/, "").split("=");
    const key = raw === "n" ? "namespace" : raw;
    if (!allowed.includes(key))
      usage(
        `${key === "address" ? "--address is refused; loopback only" : `Unknown flag ${arg}`}; valid flags: ${[...allowed, "help"].map((x) => `--${x}`).join(", ")}`,
        "port-forward",
      );
    if (flags.has(key)) usage(`Repeated --${key}`, "port-forward");
    if (["all", "execute"].includes(key)) {
      if (rest.length) usage(`--${key} takes no value`, "port-forward");
      flags.set(key, true);
    } else {
      const value = rest.length ? rest.join("=") : args[++i];
      if (!value || value.startsWith("-"))
        usage(`--${key} requires a value`, "port-forward");
      flags.set(key, value);
    }
  }
  const str = (key: string) => {
    const value = flags.get(key);
    return typeof value === "string" ? value : undefined;
  };
  if (pos[0] === "list") {
    if (pos.length !== 1) usage("list takes no arguments", "port-forward");
    return { kind: "list" } as const;
  }
  if (pos[0] === "stop") {
    if (
      flags.has("all")
        ? pos.length !== 1
        : pos.length !== 2 || !validSessionId(pos[1] ?? "")
    )
      usage("stop needs one session id or --all", "port-forward");
    return { kind: "stop", id: pos[1] } as const;
  }
  if (pos.length !== 2)
    usage(
      "port-forward needs one target and one [local:]remote mapping",
      "port-forward",
    );
  const rawTarget = pos[0] ?? "",
    parts = rawTarget.split("/");
  const kind = parts.length === 1 ? "pod" : parts[0];
  if (
    parts.length > 2 ||
    !["pod", "service", "deployment"].includes(kind ?? "")
  )
    usage(
      "target must be pod/name, service/name, deployment/name or a pod name",
      "port-forward",
    );
  const name = validateResourceName(parts.at(-1) ?? "");
  let mapping = pos[1] ?? "";
  if (!mapping.includes(":")) mapping = `:${mapping}`;
  const ports = mapping.split(":");
  if (ports.length !== 2)
    usage("one [local:]remote mapping is required", "port-forward");
  if (ports[0]) integer(ports[0], "local port", 1024, 65535);
  const remote = integer(ports[1] ?? "", "remote port", 1, 65535);
  const ttlArg = str("ttl") ?? "15m",
    ttl = parseDuration(ttlArg);
  if (ttl < 10 || ttl > 3600)
    usage("--ttl must be from 10s to 60m", "port-forward");
  const context = str("context"),
    namespace = str("namespace")
      ? validateNamespace(str("namespace") ?? "")
      : undefined;
  const execute = flags.has("execute");
  requireExecuteTarget({ execute, context, namespace });
  return {
    kind: "forward",
    resource: kind,
    name,
    rawTarget,
    mapping,
    remote,
    ttl,
    ttlArg,
    context,
    namespace,
    execute,
    timeout: integer(str("timeout") ?? "20", "--timeout", 1, 120),
  } as const;
}
async function permission(target: Target, budget: number): Promise<boolean> {
  const action = { kind: "can-i", resource: "pods/portforward" } as const;
  const argv = argvForAction(action, target);
  assertSafeAction(action, target, argv);
  if (budget <= 0) fail("TIMEOUT", "overall preflight deadline exceeded");
  let result;
  try {
    result = await runProcess("kubectl", argv, budget, 1048576);
  } catch (error) {
    if (object(error).code === "ENOENT")
      fail("KUBECTL_NOT_INSTALLED", "kubectl is not installed");
    throw error;
  }
  if (result.timedOut) fail("TIMEOUT", "permission check timed out");
  if (result.capped)
    fail("OUTPUT_TOO_LARGE", "permission response is too large");
  if (result.stdout.trim() === "yes" && result.exit === 0) return true;
  if (result.stdout.trim() === "no" && result.exit === 1) return false;
  throw mapKubectlFailure(result.stderr);
}
export async function portForwardCommand(args: string[]): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) return encodeObject(HELP);
  const p = parse(args);
  let stage = "session state";
  return withSessions(p.kind === "forward" && p.execute, async () => {
    await reapSessions();
    if (p.kind === "list") {
      const rows = allSessions();
      return encodeObject({
        count: rows.length,
        sessions: rows.length
          ? rows.map((r) => ({
              id: r.id,
              local: `127.0.0.1:${r.local}`,
              pod: r.pod,
              expires_at: r.expires_at,
            }))
          : "0 owned port-forward sessions",
        help: ["Run `k8s-axi port-forward stop <id>` to stop a session"],
      });
    }
    if (p.kind === "stop") {
      stage = "session stop";
      const rows = allSessions().filter((r) => !p.id || r.id === p.id);
      if (p.id && !rows.length)
        fail("SESSION_NOT_FOUND", "port-forward session not found", [
          "Run `k8s-axi port-forward list`",
        ]);
      for (const row of rows) await stopSession(row, "stopped");
      return encodeObject({ stopped: rows.length });
    }
    stage = "target resolution";
    const d = deadline(p.timeout);
    const resolved = await resolveTarget(p.context, d);
    const t = {
      ...resolved,
      defaultNamespace: p.namespace ?? resolved.defaultNamespace,
    };
    let pod = p.name,
      remote = p.remote;
    if (p.resource !== "pod") {
      const resource = parseObject(
        await kubectl(
          {
            op: "get",
            resource: p.resource === "service" ? "service" : "deployment.apps",
            name: p.name,
            namespace: t.defaultNamespace,
          },
          t,
          d,
        ),
      );
      const spec = object(resource.spec),
        selector = object(spec.selector);
      const labels =
        p.resource === "service" ? selector : object(selector.matchLabels);
      const expressions =
        p.resource === "deployment"
          ? objects(selector.matchExpressions).map((e) => {
              const key = text(e.key),
                values = Array.isArray(e.values)
                  ? e.values.map((v) => text(v))
                  : [];
              if (e.operator === "In") return `${key} in (${values.join(",")})`;
              if (e.operator === "NotIn")
                return `${key} notin (${values.join(",")})`;
              if (e.operator === "Exists") return key;
              if (e.operator === "DoesNotExist") return `!${key}`;
              return fail("UPSTREAM_ERROR", "unsupported pod selector");
            })
          : [];
      const selectorText = [
        ...Object.entries(labels).map(([k, v]) => `${k}=${text(v)}`),
        ...expressions,
      ].join(",");
      if (!selectorText) fail("NOT_FOUND", "target has no pod selector");
      const pods = parseList(
        await kubectl(
          {
            op: "list",
            resource: "pods",
            scope: {
              kind: "namespace",
              name: t.defaultNamespace,
              source: "flag",
            },
            selector: validateSelector(selectorText),
          },
          t,
          d,
        ),
      );
      const ready = pods
        .filter(
          (v) =>
            !object(v.metadata).deletionTimestamp &&
            object(v.status).phase === "Running" &&
            objects(object(v.status).conditions).some(
              (c) => c.type === "Ready" && c.status === "True",
            ),
        )
        .sort((a, b) =>
          text(object(b.metadata).creationTimestamp).localeCompare(
            text(object(a.metadata).creationTimestamp),
          ),
        )[0];
      if (!ready) fail("NOT_FOUND", "target has no Ready pod");
      pod = validateResourceName(text(object(ready.metadata).name));
      if (p.resource === "service") {
        const port = objects(spec.ports).find(
          (v) =>
            v.port === p.remote &&
            (v.protocol === undefined || v.protocol === "TCP"),
        );
        if (!port) usage("service has no matching TCP port", "port-forward");
        const dest = port.targetPort ?? port.port;
        const named = objects(object(ready.spec).containers)
          .flatMap((c) => objects(c.ports))
          .find((v) => v.name === dest);
        remote = integer(
          String(
            typeof dest === "number" ? dest : (named?.containerPort ?? ""),
          ),
          "service target port",
          1,
          65535,
        );
      }
    } else
      parseObject(
        await kubectl(
          {
            op: "get",
            resource: "pod",
            name: pod,
            namespace: t.defaultNamespace,
          },
          t,
          d,
        ),
      );
    const target = {
      context: t.context,
      server: t.server,
      namespace: t.defaultNamespace,
      pod,
      ...(p.resource !== "pod" ? { from: p.rawTarget } : {}),
      ports: [p.mapping],
    };
    stage = "permission check";
    const permitted = await permission(t, remaining(d));
    if (!permitted) {
      if (p.execute)
        appendAudit({
          id: newAuditId(),
          phase: "refused",
          action: "port-forward",
          context: t.context,
          server: t.server,
          namespace: t.defaultNamespace,
          target: pod,
          outcome: "refused",
          code: "FORBIDDEN",
        });
      process.exitCode = 1;
      return encodeObject({
        target,
        action: "port-forward",
        mode: p.execute ? "refused" : "preview - nothing ran",
        permission: "denied",
        code: "FORBIDDEN",
        error: `needs create pods/portforward in ${t.defaultNamespace}`,
        help: [
          "Use a context allowed to create pods/portforward in this namespace",
        ],
      });
    }
    if (allSessions().length >= 5) {
      if (p.execute)
        appendAudit({
          id: newAuditId(),
          phase: "refused",
          action: "port-forward",
          context: t.context,
          namespace: t.defaultNamespace,
          target: pod,
          outcome: "refused",
          code: "SESSION_LIMIT",
        });
      process.exitCode = 1;
      return encodeObject({
        target,
        action: "port-forward",
        mode: p.execute ? "refused" : "preview - nothing ran",
        error: "at most 5 port-forward sessions per user",
        code: "SESSION_LIMIT",
        help: ["Run `k8s-axi port-forward list` and stop an existing session"],
      });
    }
    if (!p.execute) {
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
      const command = `k8s-axi port-forward ${quote(p.rawTarget)} ${quote(p.mapping)} -n ${quote(t.defaultNamespace)} --context ${quote(t.context)} --ttl ${quote(p.ttlArg)} --execute`;
      return encodeObject({
        target,
        action: "port-forward",
        mode: "preview - nothing ran",
        permission: `allowed (create pods/portforward in ${t.defaultNamespace})`,
        ttl: p.ttlArg,
        expires_at: new Date(Date.now() + p.ttl * 1000).toISOString(),
        bind: "127.0.0.1 and ::1 only",
        help: [`Run \`${command}\``],
      });
    }
    stage = "session startup or cleanup";
    try {
      const record = await startSession(
        t,
        pod,
        `${p.mapping.split(":")[0]}:${remote}`,
        p.ttl,
      );
      return encodeObject({
        target,
        action: "port-forward",
        mode: "executed",
        session: record.id,
        local: `127.0.0.1:${record.local}`,
        expires_at: record.expires_at,
        owner: record.owner,
        audit_id: record.id,
        help: [`Run \`k8s-axi port-forward stop ${record.id}\``],
      });
    } catch (error) {
      if (!(error instanceof AxiError)) throw error;
      process.exitCode = 1;
      return encodeObject({
        target,
        action: "port-forward",
        mode: "failed",
        error: error.message,
        code: error.code,
        help: error.suggestions,
      });
    }
  }).catch((error: unknown) => {
    if (error instanceof AxiError) throw error;
    const errno = object(error).errno;
    const reason =
      typeof errno === "number" && Number.isSafeInteger(errno) && errno < 0
        ? getSystemErrorName(errno)
        : "unclassified local error";
    throw new AxiError(
      `port-forward ${stage} failed (${reason})`,
      "UPSTREAM_ERROR",
      ["Check local process and state permissions, then preview again"],
    );
  });
}
