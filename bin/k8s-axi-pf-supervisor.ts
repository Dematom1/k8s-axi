import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { argvForAction, assertSafeAction } from "../src/actions/registry.js";
import {
  readSession,
  saveSession,
  processIdentity,
  finishSession,
  validSessionId,
  type ForwardSession,
} from "../src/actions/port-forward.js";
import { mapKubectlFailure, object } from "../src/kubectl.js";

async function supervise(): Promise<void> {
  const [id = "", token = ""] = process.argv.slice(2);
  if (!validSessionId(id) || !validSessionId(token)) return;
  let record: ForwardSession | undefined;
  const wait = Date.now() + 5000;
  while (Date.now() < wait) {
    record = readSession(id);
    if (record) break;
    await sleep(25);
  }
  if (
    !record ||
    record.token !== token ||
    record.supervisor_pid !== process.pid ||
    record.state !== "starting"
  )
    return;
  const current = record;
  const action = {
    kind: "port-forward",
    target: current.pod,
    ports: [current.mapping],
  } as const;
  const argv = argvForAction(action, current.target);
  assertSafeAction(action, current.target, argv);
  const child = spawn("kubectl", argv, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KUBERC: "off" },
  });
  let ready = false,
    closing = false,
    stderr = "",
    stdout = "",
    capped = false;
  const ending: { reason: "expired" | "stopped" | "exited" } = {
    reason: "exited",
  };
  let failureCode: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (outcome: typeof ending.reason, code?: string) => {
    if (closing) return;
    closing = true;
    ending.reason = outcome;
    failureCode = code;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
  };
  process.on("SIGTERM", () => stop("stopped"));
  process.on("SIGINT", () => stop("stopped"));
  const expiry = setTimeout(
    () => stop("expired"),
    Math.max(0, Date.parse(current.expires_at) - Date.now()),
  );
  const startup = setTimeout(() => stop("exited", "TIMEOUT"), 14500);
  let totalOut = 0,
    totalErr = 0;
  child.on("spawn", () => {
    if (!child.pid) return;
    const identity = processIdentity(child.pid);
    if (!identity || identity.pgid !== current.pgid) {
      stop("exited", "UPSTREAM_ERROR");
      return;
    }
    current.child = identity;
    saveSession(current);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    totalOut += chunk.length;
    if (totalOut > 1048576) {
      capped = true;
      stop("exited", "OUTPUT_TOO_LARGE");
      return;
    }
    if (ready || closing) return;
    stdout += chunk.toString("utf8");
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^Forwarding from 127\.0\.0\.1:(\d+) -> (\d+)$/.exec(line);
      if (!match) continue;
      const local = Number(match[1]);
      if (
        local < 1024 ||
        local > 65535 ||
        Number(match[2]) !== current.remote
      ) {
        stop("exited", "UPSTREAM_ERROR");
        return;
      }
      const identity = child.pid ? processIdentity(child.pid) : undefined;
      if (!identity || identity.pgid !== current.pgid) {
        stop("exited", "UPSTREAM_ERROR");
        return;
      }
      current.child = identity;
      ready = true;
      clearTimeout(startup);
      current.state = "ready";
      current.local = local;
      saveSession(current);
      break;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    totalErr += chunk.length;
    if (totalErr > 1048576) {
      capped = true;
      stop("exited", "OUTPUT_TOO_LARGE");
      return;
    }
    stderr += chunk.toString("utf8");
    if (
      /address already in use|unable to listen on any of the requested ports/i.test(
        stderr,
      )
    )
      stop("exited", "PORT_IN_USE");
  });
  child.once("error", (error) => {
    failureCode =
      object(error).code === "ENOENT"
        ? "KUBECTL_NOT_INSTALLED"
        : "UPSTREAM_ERROR";
  });
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  clearTimeout(expiry);
  clearTimeout(startup);
  if (killTimer) clearTimeout(killTimer);
  if (!ready && ending.reason !== "expired" && ending.reason !== "stopped") {
    current.state = "failed";
    current.code =
      failureCode ??
      (capped
        ? "OUTPUT_TOO_LARGE"
        : /address already in use|unable to listen on any of the requested ports/i.test(
              stderr,
            )
          ? "PORT_IN_USE"
          : mapKubectlFailure(stderr).code);
    saveSession(current);
  } else if (ending.reason !== "stopped")
    finishSession(current, ending.reason, failureCode);
}

// Private entry point: never print subprocess output or an unhandled exception.
await supervise().catch(() => {
  process.exitCode = 1;
});
