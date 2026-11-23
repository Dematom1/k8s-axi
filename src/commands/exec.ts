import { AxiError, exitCodeForError } from "axi-sdk-js";
import {
  validateResourceName,
  isPodUid,
  validateSelector,
  type Parsed,
} from "../args.js";
import {
  argvForAction,
  assertSafeAction,
  argvSha256,
  requireExecuteTarget,
  type Action,
} from "../actions/registry.js";
import { appendAudit, newAuditId, type AuditRecord } from "../actions/audit.js";
import { execPolicy } from "../actions/exec-policy.js";
import { ScrubSet, scrubSources } from "../actions/scrub.js";
import { fail, usage } from "../errors.js";
import {
  kubectl,
  mapKubectlFailure,
  object,
  objects,
  parseList,
  parseObject,
  text,
  type Obj,
} from "../kubectl.js";
import { OUTPUT_CAP, runProcess, type ProcessResult } from "../process.js";
import { redactText } from "../redact.js";
import {
  deadline,
  remaining,
  type Deadline,
  type Target,
} from "../registry.js";
import { resolveTarget } from "../target.js";
import { encodeObject } from "../toon.js";

const CAP = 1024 * 1024;
async function actionProcess(
  action: Action,
  target: Target,
  timeout: number,
): Promise<ProcessResult> {
  const argv = argvForAction(action, target);
  assertSafeAction(action, target, argv);
  if (timeout <= 0) fail("TIMEOUT", "action preparation deadline exceeded");
  try {
    return await runProcess(
      "kubectl",
      argv,
      timeout,
      action.kind === "secret-values" ? OUTPUT_CAP : CAP,
    );
  } catch (error) {
    fail(
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "KUBECTL_NOT_INSTALLED"
        : "UPSTREAM_ERROR",
      "could not start the cluster action",
    );
  }
}

async function getPod(p: Parsed, target: Target, d: Deadline): Promise<Obj> {
  const name = p.name;
  if (!name) usage("exec requires one pod or deployment/<name>", "exec");
  let raw: string;
  try {
    raw = await kubectl(
      {
        op: "get",
        resource: p.execDeployment ? "deployment.apps" : "pod",
        name,
        namespace: target.defaultNamespace,
      },
      target,
      d,
    );
  } catch (error) {
    if (error instanceof AxiError && error.code === "NOT_FOUND")
      fail(
        "NOT_FOUND",
        `${p.execDeployment ? "deployment" : "pod"}/${name} not found`,
      );
    throw error;
  }
  const resource = parseObject(raw);
  if (!p.execDeployment) return resource;
  const selector = object(object(resource.spec).selector);
  const labels = Object.entries(object(selector.matchLabels)).map(
    ([key, value]) => `${key}=${text(value)}`,
  );
  for (const expr of objects(selector.matchExpressions)) {
    const key = text(expr.key);
    const values = Array.isArray(expr.values)
      ? expr.values.map((v) => text(v)).join(",")
      : "";
    if (expr.operator === "In" || expr.operator === "NotIn")
      labels.push(
        `${key} ${expr.operator === "In" ? "in" : "notin"} (${values})`,
      );
    else if (expr.operator === "Exists") labels.push(key);
    else if (expr.operator === "DoesNotExist") labels.push(`!${key}`);
    else fail("UPSTREAM_ERROR", "deployment has an invalid pod selector");
  }
  if (!labels.length) fail("UPSTREAM_ERROR", "deployment has no pod selector");
  const pods = parseList(
    await kubectl(
      {
        op: "list",
        resource: "pods",
        scope: {
          kind: "namespace",
          name: target.defaultNamespace,
          source: "flag",
        },
        selector: validateSelector(labels.join(",")),
      },
      target,
      d,
    ),
  );
  const deploymentUid = text(object(resource.metadata).uid);
  if (!deploymentUid) fail("UPSTREAM_ERROR", "deployment identity unavailable");
  const replicaSets = parseList(
    await kubectl(
      {
        op: "list",
        resource: "replicasets.apps",
        scope: {
          kind: "namespace",
          name: target.defaultNamespace,
          source: "flag",
        },
        selector: validateSelector(labels.join(",")),
      },
      target,
      d,
    ),
  );
  const ownedReplicaSets = new Set(
    replicaSets
      .filter((rs) =>
        objects(object(rs.metadata).ownerReferences).some(
          (owner) =>
            owner.controller === true &&
            owner.kind === "Deployment" &&
            owner.uid === deploymentUid,
        ),
      )
      .map((rs) => text(object(rs.metadata).uid))
      .filter(Boolean),
  );
  const ready = pods.filter(
    (pod) =>
      objects(object(pod.metadata).ownerReferences).some(
        (owner) =>
          owner.controller === true &&
          owner.kind === "ReplicaSet" &&
          ownedReplicaSets.has(text(owner.uid)),
      ) &&
      !object(pod.metadata).deletionTimestamp &&
      objects(object(pod.status).conditions).some(
        (c) => c.type === "Ready" && c.status === "True",
      ),
  );
  ready.sort(
    (a, b) =>
      text(object(b.metadata).creationTimestamp).localeCompare(
        text(object(a.metadata).creationTimestamp),
      ) ||
      text(object(b.metadata).name).localeCompare(
        text(object(a.metadata).name),
      ),
  );
  if (!ready[0]) fail("NOT_FOUND", `no Ready pod for deployment/${name}`);
  return ready[0];
}

async function prepareScrub(
  spec: Obj,
  container: string,
  target: Target,
  d: Deadline,
) {
  const sources = scrubSources(spec, container);
  const values = sources.literals.map((entry) => Buffer.from(entry.value));
  const names: string[] = [];
  for (const ref of sources.secrets) {
    const result = await actionProcess(
      { kind: "secret-values", name: ref.name },
      target,
      remaining(d),
    );
    if (result.timedOut || result.capped)
      fail(
        "SCRUB_UNAVAILABLE",
        `cannot prepare output scrub for Secret ${ref.name}; needs get secrets`,
      );
    if (result.exit !== 0) {
      const error = mapKubectlFailure(result.stderr);
      if (error.code === "NOT_FOUND" && ref.optional) continue;
      fail(
        "SCRUB_UNAVAILABLE",
        `cannot read Secret ${ref.name}; needs get secrets in ${target.defaultNamespace}`,
      );
    }
    // Secret JSON never goes through parseObject/parseList or a renderable Obj.
    try {
      const secret: unknown = JSON.parse(result.stdout);
      if (
        !secret ||
        typeof secret !== "object" ||
        !("kind" in secret) ||
        secret.kind !== "Secret"
      )
        throw new Error();
      if ("data" in secret && secret.data !== undefined) {
        if (
          !secret.data ||
          typeof secret.data !== "object" ||
          Array.isArray(secret.data)
        )
          throw new Error();
        for (const encoded of Object.values(secret.data)) {
          if (
            typeof encoded !== "string" ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              encoded,
            )
          )
            throw new Error();
          values.push(Buffer.from(encoded, "base64"));
        }
      }
    } catch {
      fail(
        "SCRUB_UNAVAILABLE",
        `invalid response for Secret ${ref.name}; output scrub unavailable`,
      );
    }
    names.push(ref.name);
  }
  return {
    scrub: new ScrubSet(values),
    secrets: names,
    literals: sources.literals.map((entry) => entry.name),
    short: values.filter((value) => value.toString("utf8").length < 4).length,
  };
}

export async function execCommand(p: Parsed): Promise<string> {
  const execute = p.execute === true;
  requireExecuteTarget({ execute, context: p.context, namespace: p.namespace });
  const command = p.remoteArgv ?? [];
  const d = deadline();
  const id = newAuditId();
  let targetEcho: Obj = {};
  let scrub = new ScrubSet([]);
  let started = false;
  let launchAttempted = false;
  let completed = false;
  const safe = (s: string) => redactText(scrub.scrub(s).text).text;
  const auditBase = () => ({
    id,
    action: "exec" as const,
    context: text(targetEcho.context),
    server: text(targetEcho.server),
    namespace: text(targetEcho.namespace),
    target: `${text(targetEcho.pod)}/${text(targetEcho.container)}`,
  });
  try {
    const resolved = await resolveTarget(p.context, d);
    const target = {
      ...resolved,
      defaultNamespace: p.namespace ?? resolved.defaultNamespace,
    };
    targetEcho = {
      context: target.context,
      server: target.server,
      namespace: target.defaultNamespace,
      pod: p.execDeployment ? "" : (p.name ?? ""),
      ...(p.execDeployment ? { from: `deployment/${p.name}` } : {}),
    };
    const pod = await getPod(p, target, d);
    const podName = validateResourceName(text(object(pod.metadata).name));
    const podUid = text(object(pod.metadata).uid);
    targetEcho.pod = podName;
    if (!isPodUid(podUid))
      fail("UPSTREAM_ERROR", "pod UID unavailable or invalid");
    targetEcho.pod_uid = podUid;
    if (p.podUid && p.podUid !== podUid)
      fail(
        "TARGET_CHANGED",
        "Pod UID differs from the preview; repeat the preview before execution",
      );
    const spec = object(pod.spec);
    const containers = objects(spec.containers).map((c) => text(c.name));
    const annotation = text(
      object(object(pod.metadata).annotations)[
        "kubectl.kubernetes.io/default-container"
      ],
    );
    const selected =
      p.container ??
      (containers.includes(annotation)
        ? annotation
        : containers.length === 1
          ? containers[0]
          : undefined);
    if (p.container && !containers.includes(p.container))
      fail(
        "NOT_FOUND",
        `container ${p.container} not found; containers: ${containers.join(", ")}`,
      );
    if (!selected || !containers.includes(selected))
      usage(
        `choose -c <container>; containers: ${containers.join(", ")}`,
        "exec",
      );
    const container = validateResourceName(selected);
    targetEcho.container = container;
    const policy = execPolicy(command, spec, container);
    if (!policy.ok) {
      const index = command.findIndex(
        (token) => token === policy.token || token.endsWith("/" + policy.token),
      );
      fail(
        "SECRET_EXPOSURE",
        `input guard: ${policy.reason}; ${index >= 0 ? `token ${index + 1}` : "argv shape"} (value omitted)`,
      );
    }
    const permission = await actionProcess(
      { kind: "can-i", resource: "pods/exec", target: podName },
      target,
      remaining(d),
    );
    const permissionLabel = `create pods/exec in ${target.defaultNamespace}`;
    if (permission.timedOut) fail("TIMEOUT", "permission check timed out");
    if (permission.capped)
      fail("OUTPUT_TOO_LARGE", "permission response exceeded its limit");
    if (permission.stdout.trim() === "no") {
      targetEcho.permission = `denied (${permissionLabel})`;
      fail("FORBIDDEN", `permission denied: ${permissionLabel}`);
    }
    if (permission.exit !== 0 || permission.stdout.trim() !== "yes")
      throw mapKubectlFailure(permission.stderr);
    const prepared = await prepareScrub(spec, container, target, d);
    scrub = prepared.scrub;
    const echo = () => ({
      target: targetEcho,
      action: "exec",
      mode: execute ? "executed" : "preview - nothing ran",
      command: command.map(safe),
      permission: `allowed (${permissionLabel})`,
    });
    if (!execute) {
      const replayTarget = `pod/${podName}`;
      const replayable = [
        replayTarget,
        podUid,
        container,
        target.defaultNamespace,
        target.context,
        ...command,
      ].every((value) => safe(value) === value);
      const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const run = replayable
        ? `k8s-axi exec ${quote(replayTarget)} -c ${quote(container)} -n ${quote(target.defaultNamespace)} --context ${quote(target.context)} --timeout ${p.timeout}${p.full ? " --full" : ""} --pod-uid ${quote(podUid)} --execute -- ${command.map(quote).join(" ")}`
        : undefined;
      return encodeObject({
        ...echo(),
        guards: {
          input: "allowed",
          scrub: `${prepared.secrets.length} Secrets (${prepared.secrets.join(", ")}), ${prepared.literals.length} literal env (${prepared.literals.join(", ")})`,
          "unscrubbable short values": prepared.short,
          output: "1 MiB per stream, newest 8000 chars shown (--full for all)",
          timeout: `${p.timeout}s local; a timed-out command may keep running in the container`,
        },
        help: [
          run
            ? `Run \`${run}\``
            : "Reissue the original invocation with --execute, explicit --context and -n, and the inspected Pod target and --pod-uid; sanitized values are not replayable",
        ],
      });
    }
    const action = {
      kind: "exec",
      target: podName,
      container,
      command,
    } satisfies Action;
    appendAudit({
      ...auditBase(),
      phase: "start",
      argv: command.map(safe),
      argv_sha256: argvSha256(command),
      cwd: safe(process.cwd()),
      uid: process.getuid?.(),
      pid: process.pid,
    });
    started = true;
    const inspected = object(pod.metadata);
    const current = object(
      parseObject(
        await kubectl(
          {
            op: "get",
            resource: "pod",
            name: podName,
            namespace: target.defaultNamespace,
          },
          target,
          d,
        ),
      ).metadata,
    );
    if (
      !text(inspected.uid) ||
      !text(inspected.resourceVersion) ||
      current.uid !== inspected.uid ||
      current.resourceVersion !== inspected.resourceVersion
    )
      fail(
        "TARGET_CHANGED",
        "pod identity or resourceVersion changed; repeat the preview before execution",
      );
    const start = Date.now();
    launchAttempted = true;
    const result = await actionProcess(action, target, p.timeout * 1000);
    const duration = Date.now() - start;
    let code: string | undefined;
    let message: string | undefined;
    let remoteExit: number | null = result.exit;
    let outcome: AuditRecord["outcome"] = "ok";
    if (result.timedOut) {
      code = "TIMEOUT";
      message = "local exec deadline exceeded";
      remoteExit = null;
      outcome = "timeout";
    } else if (result.capped) {
      code = "OUTPUT_TOO_LARGE";
      message = "exec output exceeds 1 MiB per stream";
      remoteExit = null;
      outcome = "error";
    } else if (result.exit !== 0) {
      const lastLine = result.stderr.trimEnd().split(/\r?\n/).at(-1) ?? "";
      // kubectl appends its diagnostic directly, so remote stderr without a
      // final newline joins it onto the same line.
      const remote =
        /command terminated with (?:non-zero exit code: Error executing in Docker Container: )?exit code (\d+)$/.exec(
          lastLine,
        );
      if (remote && Number(remote[1]) === result.exit) {
        code = "REMOTE_EXIT_NONZERO";
        message = "remote command exited non-zero";
        outcome = "remote_nonzero";
      } else {
        const failure = mapKubectlFailure(
          /^(?:error:|Error from server)/.test(lastLine) ? lastLine : "",
        );
        code = failure.code;
        message =
          failure.code === "FORBIDDEN"
            ? `permission denied: create pods/exec in ${target.defaultNamespace}`
            : failure.message;
        remoteExit = null;
        outcome = failure.code === "FORBIDDEN" ? "forbidden" : "error";
      }
    }
    const showOutput =
      !result.capped &&
      !result.timedOut &&
      (result.exit === 0 || outcome === "remote_nonzero");
    const clean = (value: string) => {
      const scrubbed = scrub.scrub(showOutput ? value : "");
      const redacted = redactText(scrubbed.text);
      const capped = Buffer.byteLength(redacted.text) > CAP;
      return {
        text: capped ? "" : redacted.text,
        capped,
        scrubbed: scrubbed.count,
        redacted: redacted.count,
      };
    };
    const stdout = clean(result.stdout),
      stderr = clean(result.stderr);
    const truncated =
      result.capped ||
      result.timedOut ||
      stdout.capped ||
      stderr.capped ||
      (!p.full && (stdout.text.length > 8000 || stderr.text.length > 8000));
    const output = {
      ...echo(),
      ...(outcome === "forbidden"
        ? {
            mode: "refused - nothing ran",
            permission: `denied at exec (${permissionLabel})`,
          }
        : {}),
      remote_exit: remoteExit,
      duration: `${duration}ms`,
      stdout: p.full ? stdout.text : stdout.text.slice(-8000),
      stderr: p.full ? stderr.text : stderr.text.slice(-8000),
      redacted: stdout.redacted + stderr.redacted,
      scrubbed: stdout.scrubbed + stderr.scrubbed,
      truncated,
      audit_id: id,
      ...(result.timedOut
        ? { remote_process: `may still be running in ${podName}/${container}` }
        : {}),
    };
    completed = true;
    try {
      appendAudit({
        ...auditBase(),
        phase: "end",
        outcome,
        exit: result.exit ?? 1,
        ...(code ? { code } : {}),
        duration_ms: duration,
        stdout_bytes: Buffer.byteLength(result.stdout),
        stderr_bytes: Buffer.byteLength(result.stderr),
        redactions: output.redacted,
        scrubbed: output.scrubbed,
      });
    } catch {
      process.exitCode = 1;
      return encodeObject({
        ...output,
        error:
          outcome === "forbidden"
            ? "remote command did not start: exec denied; audit end unavailable"
            : "action ran but its audit end record could not be written",
        code: "AUDIT_INCOMPLETE",
        ...(outcome === "forbidden" ? { launch_code: "FORBIDDEN" } : {}),
        help: [
          outcome === "forbidden"
            ? "Execution denied; repair permissions and the audit log before retrying"
            : "the action ran; do not retry",
        ],
      });
    }
    if (code) process.exitCode = 1;
    return encodeObject({
      ...output,
      ...(code ? { error: message, code } : {}),
      ...(truncated
        ? {
            help: [
              result.timedOut
                ? "Incomplete output withheld after timeout; the remote process may still be running"
                : result.capped || stdout.capped || stderr.capped
                  ? "Output exceeded the stream limit and was withheld; narrow the remote command"
                  : "Use --full before -- to remove the character preview limit",
            ],
          }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof AxiError)) throw error;
    if (execute && !completed && error.code !== "AUDIT_UNAVAILABLE") {
      try {
        appendAudit({
          ...auditBase(),
          phase: started ? "end" : "refused",
          outcome: started ? "error" : "refused",
          code: error.code,
          argv_sha256: argvSha256(command),
          exit: 1,
        });
      } catch {
        if (started) {
          process.exitCode = 1;
          const notLaunched =
            !launchAttempted || error.code === "KUBECTL_NOT_INSTALLED";
          return encodeObject({
            target: targetEcho,
            error: notLaunched
              ? "remote command did not start; audit end unavailable"
              : "action may have run; audit end unavailable",
            code: "AUDIT_INCOMPLETE",
            launch_code: error.code,
            help: [
              notLaunched
                ? "Restore the failed preflight or kubectl launch and the audit log before retrying"
                : "the action may have run; do not retry",
            ],
          });
        }
        throw new AxiError(
          "audit log unavailable; nothing ran",
          "AUDIT_UNAVAILABLE",
          [],
        );
      }
    }
    process.exitCode = exitCodeForError(error);
    return encodeObject({
      target: targetEcho,
      action: "exec",
      mode: "refused - nothing ran",
      error: safe(error.message),
      code: error.code,
      help: error.suggestions,
    });
  }
}
