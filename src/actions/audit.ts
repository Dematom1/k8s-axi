import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { redactText } from "../redact.js";
import { VERSION } from "../version.js";

const MAX_BYTES = 10 * 1024 * 1024;
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
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
    let fd = openSync(path, "a", 0o600);
    try {
      fchmodSync(fd, 0o600);
      const opened = fstatSync(fd);
      if (opened.size + Buffer.byteLength(line) > MAX_BYTES) {
        const current = statSync(path);
        if (current.dev === opened.dev && current.ino === opened.ino) {
          try {
            renameSync(
              path,
              join(
                dir,
                `audit.${Date.now()}.${process.pid}.${randomUUID()}.jsonl`,
              ),
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
        }
      }
      writeSync(fd, line);
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  } catch {
    throw new AxiError("audit log unavailable", "AUDIT_UNAVAILABLE", []);
  }
}

export function newAuditId(): string {
  return randomUUID();
}

function parseRecord(value: unknown): AuditRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("v" in value) ||
    value.v !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("phase" in value) ||
    !["start", "end", "refused"].includes(String(value.phase)) ||
    !("ts" in value) ||
    typeof value.ts !== "string" ||
    !("action" in value) ||
    typeof value.action !== "string" ||
    !ACTIONS.some((action) => action === value.action)
  )
    throw new Error("invalid audit record");
  return value as AuditRecord;
}

export function readAudit(options: {
  limit: number;
  action?: AuditedAction;
}): AuditRecord[] {
  let text: string;
  try {
    const path = auditPath();
    const dir = dirname(path);
    const rotated = readdirSync(dir)
      .filter((name) => /^audit\.(?:1|\d+\.\d+\.[0-9a-f-]+)\.jsonl$/.test(name))
      .sort()
      .map((name) => join(dir, name));
    const files = [...rotated, path].filter(existsSync);
    const totalBytes = files.reduce((total, file) => total + statSync(file).size, 0);
    if (totalBytes > 2 * MAX_BYTES)
      throw new Error("audit history exceeds retained size");
    text = files.map((file) => readFileSync(file, "utf8")).join("\n");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
    throw new AxiError("audit log unavailable", "AUDIT_UNAVAILABLE", []);
  }
  let rows: AuditRecord[];
  try {
    rows = text
      .split("\n")
      .filter(Boolean)
      .map((line) => parseRecord(JSON.parse(line) as unknown));
  } catch {
    throw new AxiError("audit log is invalid", "AUDIT_UNAVAILABLE", []);
  }
  return rows
    .filter((row) => !options.action || row.action === options.action)
    .slice(-options.limit)
    .reverse();
}
