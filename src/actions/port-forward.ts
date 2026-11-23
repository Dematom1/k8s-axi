import { spawn, execFileSync } from "node:child_process";
import {
  constants,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  statSync,
  fstatSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { AxiError } from "axi-sdk-js";
import { appendAudit, auditPath, safeDirectoryExists } from "./audit.js";
import { acquireSessionLock, releaseSessionLock } from "../sessionlog.js";
import { argvForAction, assertSafeAction, argvSha256 } from "./registry.js";
import { object } from "../kubectl.js";
import { fail } from "../errors.js";
import type { Target } from "../registry.js";

export interface ChildIdentity {
  pid: number;
  pgid: number;
  started: string;
  argv: string;
}
export interface ForwardSession {
  v: 1;
  id: string;
  token: string;
  owner: { cwd: string; uid: number };
  target: Target;
  pod: string;
  remote: number;
  mapping: string;
  local: number;
  created_at: string;
  expires_at: string;
  supervisor_pid: number;
  pgid: number;
  child?: ChildIdentity;
  state: "starting" | "ready" | "failed";
  code?: string;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validSessionId(id: string): boolean {
  return uuid.test(id);
}
export function sessionsDirectory(): string {
  return join(dirname(auditPath()), "sessions");
}
function sessionPath(id: string): string {
  if (!validSessionId(id))
    fail("SESSION_NOT_FOUND", "port-forward session not found");
  return join(sessionsDirectory(), `${id}.json`);
}
function pid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1;
}
function identity(value: unknown): value is ChildIdentity {
  const v = object(value);
  return (
    pid(v.pid) &&
    pid(v.pgid) &&
    typeof v.started === "string" &&
    !!v.started &&
    typeof v.argv === "string" &&
    !!v.argv
  );
}
function session(value: unknown): value is ForwardSession {
  const v = object(value),
    owner = object(v.owner),
    target = object(v.target);
  return (
    v.v === 1 &&
    typeof v.id === "string" &&
    uuid.test(v.id) &&
    typeof v.token === "string" &&
    uuid.test(v.token) &&
    typeof owner.cwd === "string" &&
    Number.isInteger(owner.uid) &&
    owner.uid === process.getuid?.() &&
    typeof target.context === "string" &&
    typeof target.server === "string" &&
    typeof target.defaultNamespace === "string" &&
    (target.source === "flag" || target.source === "current") &&
    typeof v.pod === "string" &&
    /^[a-z0-9][a-z0-9.-]*$/.test(v.pod) &&
    Number.isInteger(v.remote) &&
    Number(v.remote) >= 1 &&
    Number(v.remote) <= 65535 &&
    typeof v.mapping === "string" &&
    Number.isInteger(v.local) &&
    Number(v.local) >= 0 &&
    Number(v.local) <= 65535 &&
    typeof v.created_at === "string" &&
    Number.isFinite(Date.parse(v.created_at)) &&
    typeof v.expires_at === "string" &&
    Number.isFinite(Date.parse(v.expires_at)) &&
    pid(v.supervisor_pid) &&
    v.pgid === v.supervisor_pid &&
    (v.child === undefined || (identity(v.child) && v.child.pgid === v.pgid)) &&
    (v.state === "starting" || v.state === "ready" || v.state === "failed") &&
    (v.code === undefined || typeof v.code === "string")
  );
}
export function readSession(id: string): ForwardSession | undefined {
  let fd: number;
  try {
    fd = openSync(sessionPath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (object(error).code === "ENOENT") return undefined;
    fail("CONFIG_INVALID", "cannot read port-forward session");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16384 || info.uid !== process.getuid?.())
      throw new Error("invalid record");
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!session(value) || value.id !== id) throw new Error("invalid record");
    return value;
  } catch {
    fail("CONFIG_INVALID", "invalid port-forward session record");
  } finally {
    closeSync(fd);
  }
}
export function saveSession(record: ForwardSession): void {
  const path = sessionPath(record.id),
    tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    fail("AUDIT_UNAVAILABLE", "cannot save port-forward session");
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* Already renamed. */
    }
  }
}
export async function withSessions<T>(
  create: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    fail(
      "UNSUPPORTED_PLATFORM",
      "port-forward requires Linux or macOS process groups",
    );
  const dir = sessionsDirectory();
  if (!create && !existsSync(dir)) return fn();
  try {
    if (
      create &&
      safeDirectoryExists(dirname(dir)) &&
      !(statSync(dirname(dir)).mode & 0o222)
    )
      throw new Error("read-only state");
    if (!safeDirectoryExists(dir)) {
      if (!create) return fn();
      const parent = dirname(dir);
      if (safeDirectoryExists(parent) && !(statSync(parent).mode & 0o222))
        throw new Error("read-only state");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (!create && readdirSync(dir).every((name) => !name.endsWith(".json")))
      return fn();
    if (!safeDirectoryExists(dir) || !(statSync(dir).mode & 0o222))
      throw new Error("read-only sessions");
    chmodSync(dir, 0o700);
  } catch {
    fail("AUDIT_UNAVAILABLE", "port-forward state is unavailable");
  }
  const lock = await acquireSessionLock(join(dir, "sessions"));
  if (!lock)
    fail("CONFIG_INVALID", "port-forward session state is busy; retry");
  try {
    return await fn();
  } finally {
    releaseSessionLock(lock);
  }
}
export function allSessions(): ForwardSession[] {
  if (!existsSync(sessionsDirectory())) return [];
  if (!safeDirectoryExists(sessionsDirectory())) return [];
  return readdirSync(sessionsDirectory())
    .filter((name) => name.endsWith(".json"))
    .map((name) => readSession(name.slice(0, -5)))
    .filter((v) => v !== undefined);
}
function inspectProcess(
  id: number,
): { kind: "live"; identity: ChildIdentity } | { kind: "dead" | "unreadable" } {
  try {
    const raw = execFileSync(
      "/bin/ps",
      ["-ww", "-o", "pgid=,lstart=,stat=,command=", "-p", String(id)],
      {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    const match = /^\s*(\d+)\s+(.{24})\s+(\S+)\s+([^\n]+)\n?$/.exec(raw);
    if (!match) return { kind: "unreadable" };
    if (match[3]?.startsWith("Z")) return { kind: "dead" };
    const pgid = Number(match[1]),
      started = match[2],
      argv = match[4];
    return pid(pgid) && started && argv
      ? { kind: "live", identity: { pid: id, pgid, started, argv } }
      : { kind: "unreadable" };
  } catch {
    try {
      process.kill(id, 0);
    } catch (error) {
      if (object(error).code === "ESRCH") return { kind: "dead" };
    }
    return { kind: "unreadable" };
  }
}
export function processIdentity(id: number): ChildIdentity | undefined {
  const status = inspectProcess(id);
  return status.kind === "live" ? status.identity : undefined;
}
export function sameChild(
  expected: ChildIdentity,
  actual: ChildIdentity | undefined,
): boolean {
  return (
    !!actual &&
    expected.pid === actual.pid &&
    expected.pgid === actual.pgid &&
    expected.started === actual.started &&
    expected.argv === actual.argv
  );
}
export function supervisorAlive(record: ForwardSession): boolean {
  const status = inspectProcess(record.supervisor_pid);
  return (
    status.kind === "live" &&
    status.identity.pgid === record.pgid &&
    status.identity.argv.split(/\s+/).includes(record.token)
  );
}
export function ownsGroup(record: ForwardSession): boolean {
  const supervisor = inspectProcess(record.supervisor_pid);
  if (supervisor.kind === "live")
    return (
      supervisor.identity.pgid === record.pgid &&
      supervisor.identity.argv.split(/\s+/).includes(record.token)
    );
  if (supervisor.kind === "unreadable") return false;
  return (
    !!record.child && sameChild(record.child, processIdentity(record.child.pid))
  );
}
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return object(error).code !== "ESRCH";
  }
}
export function finishSession(
  record: ForwardSession,
  outcome: "expired" | "stopped" | "reaped" | "exited" | "dropped",
  code?: string,
): void {
  // Removing the record claims the single end audit across supervisor and stop/reap callers.
  try {
    unlinkSync(sessionPath(record.id));
  } catch (error) {
    if (object(error).code === "ENOENT") return;
    throw error;
  }
  try {
    appendAudit({
      id: record.id,
      phase: "end",
      action: "port-forward",
      outcome,
      ...(code ? { code } : {}),
    });
  } catch {
    throw new AxiError(
      "the port-forward ran; audit completion failed",
      "AUDIT_INCOMPLETE",
      ["the action ran; do not retry"],
    );
  }
}
export async function stopSession(
  record: ForwardSession,
  outcome: "stopped" | "reaped",
): Promise<void> {
  if (!ownsGroup(record)) {
    finishSession(record, "dropped");
    return;
  }
  try {
    process.kill(-record.pgid, "SIGTERM");
  } catch (error) {
    if (object(error).code !== "ESRCH") throw error;
  }
  const end = Date.now() + 2000;
  while (groupAlive(record.pgid) && ownsGroup(record) && Date.now() < end)
    await sleep(25);
  // Recheck identity before escalation, never signal a reused process group.
  if (groupAlive(record.pgid) && ownsGroup(record)) {
    try {
      process.kill(-record.pgid, "SIGKILL");
    } catch (error) {
      if (object(error).code !== "ESRCH") throw error;
    }
  }
  const killed = Date.now() + 1000;
  while (groupAlive(record.pgid) && ownsGroup(record) && Date.now() < killed)
    await sleep(25);
  if (groupAlive(record.pgid)) {
    if (ownsGroup(record))
      fail("TIMEOUT", "port-forward process group did not stop");
    finishSession(record, "dropped");
    return;
  }
  finishSession(record, outcome);
}
export async function reapSessions(): Promise<void> {
  for (const record of allSessions())
    if (Date.parse(record.expires_at) <= Date.now() || !supervisorAlive(record))
      await stopSession(record, "reaped");
}
export async function stopOwnedSessions(cwd: string): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  await withSessions(false, async () => {
    await reapSessions();
    let canonical: string;
    try {
      canonical = realpathSync(cwd);
    } catch {
      return;
    }
    for (const record of allSessions())
      if (record.owner.cwd === canonical) await stopSession(record, "stopped");
  });
}
export async function startSession(
  target: Target,
  pod: string,
  mapping: string,
  ttl: number,
): Promise<ForwardSession> {
  const id = randomUUID(),
    token = randomUUID();
  const action = {
    kind: "port-forward",
    target: pod,
    ports: [mapping],
  } as const;
  const argv = argvForAction(action, target);
  assertSafeAction(action, target, argv);
  const owner = {
    cwd: realpathSync(process.cwd()),
    uid: process.getuid?.() ?? -1,
  };
  appendAudit({
    id,
    phase: "start",
    action: "port-forward",
    context: target.context,
    server: target.server,
    namespace: target.defaultNamespace,
    target: pod,
    argv,
    argv_sha256: argvSha256(argv),
    cwd: owner.cwd,
    uid: owner.uid,
    pid: process.pid,
  });
  let record: ForwardSession | undefined;
  try {
    // The supervisor waits for this parent's starting record before spawning kubectl.
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../bin/k8s-axi-pf-supervisor.js", import.meta.url),
        ),
        id,
        token,
      ],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("no supervisor pid");
    record = {
      v: 1,
      id,
      token,
      owner,
      target,
      pod,
      mapping,
      remote: Number(mapping.split(":")[1]),
      local: 0,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      supervisor_pid: child.pid,
      pgid: child.pid,
      state: "starting",
    };
    saveSession(record);
    child.unref();
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const current = readSession(id);
      if (!current)
        fail("UPSTREAM_ERROR", "port-forward exited before becoming ready");
      record = current;
      if (current.state === "ready") return current;
      if (current.state === "failed")
        throw new AxiError(
          "port-forward could not start",
          current.code ?? "UPSTREAM_ERROR",
          ["Check the target and local port, then preview again"],
        );
      await sleep(50);
    }
    fail("TIMEOUT", "port-forward did not become ready within 15s");
  } catch (error) {
    if (record) await stopSession(readSession(id) ?? record, "stopped");
    else
      appendAudit({
        id,
        phase: "end",
        action: "port-forward",
        outcome: "error",
      });
    throw error;
  }
}
