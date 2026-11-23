import { spawn } from "node:child_process";
import { createServer } from "node:net";
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

async function probeBind(
  host: "127.0.0.1" | "::1",
  port: number,
): Promise<"available" | "unavailable" | "in-use" | "error"> {
  const server = createServer((socket) => socket.destroy());
  return new Promise((resolve) => {
    server.once("error", (error) => {
      const code = object(error).code;
      resolve(
        code === "EADDRINUSE"
          ? "in-use"
          : host === "::1" &&
              ["EAFNOSUPPORT", "EADDRNOTAVAIL", "ENODEV"].includes(String(code))
            ? "unavailable"
            : "error",
      );
    });
    server.listen({ host, port, exclusive: true }, () =>
      server.close((error) => resolve(error ? "error" : "available")),
    );
  });
}

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
  const requestedPort = Number(current.mapping.split(":")[0]);
  const ipv4 = requestedPort
    ? await probeBind("127.0.0.1", requestedPort)
    : "available";
  const ipv6 = await probeBind("::1", requestedPort);
  if (
    ipv4 === "in-use" ||
    ipv6 === "in-use" ||
    ipv4 === "error" ||
    ipv6 === "error"
  ) {
    current.state = "failed";
    current.code =
      ipv4 === "in-use" || ipv6 === "in-use" ? "PORT_IN_USE" : "UPSTREAM_ERROR";
    saveSession(current);
    return;
  }
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
  let partialTimer: ReturnType<typeof setTimeout> | undefined;
  const families = new Set<string>();
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
      const match =
        /^Forwarding from (127\.0\.0\.1|\[::1\]):(\d+) -> (\d+)$/.exec(line);
      if (!match) continue;
      const local = Number(match[2]);
      if (
        local < 1024 ||
        local > 65535 ||
        Number(match[3]) !== current.remote ||
        (requestedPort && local !== requestedPort)
      ) {
        stop("exited", "UPSTREAM_ERROR");
        return;
      }
      if (current.local && current.local !== local) {
        stop("exited", "PORT_IN_USE");
        return;
      }
      current.local = local;
      families.add(match[1] ?? "");
      if (
        !families.has("127.0.0.1") ||
        (ipv6 === "available" && !families.has("[::1]"))
      ) {
        // ponytail: 1s for the sibling bind report; increase only if hosts split reports longer.
        partialTimer ??= setTimeout(() => stop("exited", "PORT_IN_USE"), 1000);
        continue;
      }
      if (partialTimer) clearTimeout(partialTimer);
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
  const failure = await new Promise<NonNullable<ForwardSession["failure"]>>(
    (resolve) =>
      child.once("close", (exit, signal) => resolve({ exit, signal })),
  );
  clearTimeout(expiry);
  clearTimeout(startup);
  if (killTimer) clearTimeout(killTimer);
  if (partialTimer) clearTimeout(partialTimer);
  if (!ready && ending.reason !== "expired" && ending.reason !== "stopped") {
    current.state = "failed";
    current.failure = failure;
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
