import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { redactText } from "../redact.js";
import { VERSION } from "../version.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const ACTIONS = ["exec", "port-forward", "apply"] as const;
export type AuditedAction = (typeof ACTIONS)[number];
export type AuditPhase = "start" | "end" | "refused";
export interface AuditRecord {
  v: 1;
  id: string;
  phase: AuditPhase;
  ts: string;
  tool: "k8s-axi";
  version: string;
  action: AuditedAction;
  context?: string;
  server?: string;
  namespace?: string;
  target?: string;
  argv?: string[];
  argv_sha256?: string;
  cwd?: string;
  uid?: number;
  pid?: number;
  outcome?:
    | "ok"
    | "remote_nonzero"
    | "timeout"
    | "forbidden"
    | "refused"
    | "error"
    | "expired"
    | "stopped"
    | "reaped"
    | "exited";
  exit?: number;
  code?: string;
  duration_ms?: number;
  stdout_bytes?: number;
  stderr_bytes?: number;
  redactions?: number;
  scrubbed?: number;
}

export function auditPath(env: NodeJS.ProcessEnv = process.env): string {
  const state =
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(state, "k8s-axi", "audit.jsonl");
}

function safeDirectoryExists(path: string): boolean {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("invalid audit directory");
  }
  return true;
}

function safeValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value).text;
  if (Array.isArray(value)) return value.map(safeValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, safeValue(item)]),
    );
  return value;
}

export function appendAudit(
  record: Omit<AuditRecord, "v" | "ts" | "tool" | "version">,
): void {
  const path = auditPath();
  const dir = dirname(path);
  try {
    safeDirectoryExists(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!safeDirectoryExists(dir)) throw new Error("invalid audit directory");
    const dirFd = openSync(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (!fstatSync(dirFd).isDirectory()) throw new Error("invalid audit directory");
      fchmodSync(dirFd, 0o700);
    } finally {
      closeSync(dirFd);
    }
    const safe = Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, safeValue(value)]),
    );
    const line =
      JSON.stringify({
        ...safe,
        v: 1,
        ts: new Date().toISOString(),
        tool: "k8s-axi",
        version: VERSION,
      }) + "\n";
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    let opened: ReturnType<typeof fstatSync>;
    try {
      opened = fstatSync(fd);
      if (!opened.isFile()) throw new Error("invalid audit file");
      fchmodSync(fd, 0o600);
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written === 0) throw new Error("audit write made no progress");
        offset += written;
      }
    } finally {
      closeSync(fd);
    }
    try {
      const current = statSync(path);
      if (
        current.dev === opened.dev &&
        current.ino === opened.ino &&
        current.size > MAX_BYTES
      )
        renameSync(
          path,
          join(dir, `audit.${Date.now()}.${process.pid}.${randomUUID()}.jsonl`),
        );
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  } catch {
    throw new AxiError("audit log unavailable", "AUDIT_UNAVAILABLE", []);
  }
}

function isAuditFile(name: string): boolean {
  return (
    name === "audit.jsonl" ||
    name === "audit.1.jsonl" ||
    /^audit\.\d+\.\d+\.[0-9a-f-]+\.jsonl$/.test(name)
  );
}

export function newAuditId(): string {
  return randomUUID();
}

function parseRecord(value: unknown): AuditRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid audit record");
  const record = Object.fromEntries(Object.entries(value));
  const strings = ["id", "ts", "tool", "version"];
  const numbers = ["uid", "pid", "exit", "duration_ms", "stdout_bytes", "stderr_bytes", "redactions", "scrubbed"];
  const stringFields = ["context", "server", "namespace", "target", "argv_sha256", "cwd", "code"];
  const outcomes = ["ok", "remote_nonzero", "timeout", "forbidden", "refused", "error", "expired", "stopped", "reaped", "exited"];
  if (
    record.v !== 1 ||
    strings.some((key) => typeof record[key] !== "string") ||
    record.tool !== "k8s-axi" ||
    !Number.isFinite(Date.parse(String(record.ts))) ||
    !(record.phase === "start" || record.phase === "end" || record.phase === "refused") ||
    !ACTIONS.some((action) => action === record.action) ||
    stringFields.some((key) => key in record && typeof record[key] !== "string") ||
    numbers.some((key) => key in record && (typeof record[key] !== "number" || !Number.isFinite(record[key]))) ||
    ("argv" in record && (!Array.isArray(record.argv) || record.argv.some((arg) => typeof arg !== "string))) ||
    ("outcome" in record && !outcomes.some((outcome) => outcome === record.outcome))
  )
    throw new Error("invalid audit record");
  return record as AuditRecord;
}

export function readAudit(options: {
  limit: number;
  action?: AuditedAction;
}): AuditRecord[] {
  if (options.limit <= 0) return [];
  const rows: AuditRecord[] = [];
  const consumeLine = (line: string) => {
    if (!line) return;
    const row = parseRecord(JSON.parse(line) as unknown);
    if (options.action && row.action !== options.action) return;
    rows.push(row);
    rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id));
    if (rows.length > options.limit) rows.shift();
  };
  const consume = (file: string) => {
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error("invalid audit file");
      const chunk = Buffer.alloc(64 * 1024);
      let remainder = Buffer.alloc(0);
      let count: number;
      while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        const data = Buffer.concat([remainder, chunk.subarray(0, count)]);
        let start = 0;
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          if (end - start > MAX_RECORD_BYTES) throw new Error("audit record too large");
          const line = data.subarray(start, end).toString("utf8");
          start = end + 1;
          consumeLine(line);
        }
        remainder = data.subarray(start);
        if (remainder.length > MAX_RECORD_BYTES)
          throw new Error("audit record too large");
      }
      if (remainder.length) consumeLine(remainder.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  };
  try {
    const path = auditPath();
    const dir = dirname(path);
    if (!safeDirectoryExists(dir)) return [];
    let entries: ReturnType<typeof opendirSync>;
    try {
      entries = opendirSync(dir);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    try {
      let entry;
      while ((entry = entries.readSync()) !== null)
        if (isAuditFile(entry.name) && entry.name !== "audit.jsonl") {
          if (!entry.isFile()) throw new Error("invalid audit file");
          consume(join(dir, entry.name));
        }
    } finally {
      entries.closeSync();
    }
    consume(path);
  } catch {
    throw new AxiError("audit log is unavailable or invalid", "AUDIT_UNAVAILABLE", []);
  }
  return rows.reverse();
}
