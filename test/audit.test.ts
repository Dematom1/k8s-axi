import { afterAll, beforeEach, expect, test } from "vitest";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendAudit,
  auditPath,
  newAuditId,
  readAudit,
} from "../src/actions/audit.js";
import {
  argvForAction,
  assertSafeAction,
  requireExecuteTarget,
} from "../src/actions/registry.js";
import type { Action } from "../src/actions/registry.js";
import { validateNamespace } from "../src/args.js";
import type { Target } from "../src/registry.js";
import { parseArgs } from "../src/args.js";
import { auditCommand } from "../src/commands/audit.js";

const root = join(tmpdir(), `k8s-axi-audit-${newAuditId()}`);
const oldState = process.env.XDG_STATE_HOME;
beforeEach(() => {
  process.env.XDG_STATE_HOME = root;
});
afterAll(() => {
  if (oldState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldState;
  rmSync(root, { recursive: true, force: true });
});

test("audit log is private, redacts credentials, and reads newest records", () => {
  appendAudit({
    id: newAuditId(),
    phase: "start",
    action: "exec",
    argv: ["tool", "--password=CANARY_SECRET"],
  });
  appendAudit({ id: newAuditId(), phase: "end", action: "exec", exit: 0 });
  const path = auditPath();
  expect(statSync(join(root, "k8s-axi")).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).not.toContain("CANARY_SECRET");
  expect(readAudit({ limit: 1 })).toHaveLength(1);
  expect(readAudit({ limit: 5, action: "exec" })).toHaveLength(2);
});

test("audit command returns empty history before first write", async () => {
  const state = join(root, "fresh");
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    expect(readAudit({ limit: 100 })).toEqual([]);
    expect(await auditCommand(parseArgs("audit", []))).toContain("count: 0");
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  }
});

test("audit reader includes a complete final record without newline", () => {
  const state = join(root, "unterminated");
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  const id = newAuditId();
  try {
    appendAudit({ id, phase: "start", action: "exec" });
    const path = auditPath();
    const data = readFileSync(path, "utf8");
    writeFileSync(path, data.slice(0, -1));
    expect(readAudit({ limit: 1 })[0]?.id).toBe(id);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  }
});

test("audit reader rejects oversized records without exposing their contents", () => {
  const state = join(root, "oversized");
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  const secret = "x".repeat(1024 * 1024 + 1);
  try {
    mkdirSync(dirname(auditPath()), { recursive: true });
    writeFileSync(auditPath(), secret);
    let error: unknown;
    try {
      readAudit({ limit: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(String(error)).not.toContain(secret);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  }
});

test("audit rotation keeps one generation", () => {
  mkdirSync(dirname(auditPath()), { recursive: true });
  writeFileSync(auditPath(), "x".repeat(10 * 1024 * 1024), { mode: 0o600 });
  appendAudit({ id: newAuditId(), phase: "start", action: "apply" });
  const rotated = readdirSync(join(root, "k8s-axi")).find((name) =>
    /^audit\.\d+\.\d+\.[0-9a-f-]+\.jsonl$/.test(name),
  );
  expect(rotated).toBeDefined();
  expect(statSync(join(root, "k8s-axi", rotated ?? "")).size).toBe(
    10 * 1024 * 1024,
  );
});

test("action argv is exact and audit parses supported filters", async () => {
  const target = {
    context: "production" as Target["context"],
    server: "https://cluster.example",
    defaultNamespace: validateNamespace("apps"),
    source: "flag",
  } satisfies Target;
  const action: Action = {
    kind: "exec",
    target: "web-0",
    container: "app",
    command: ["ls", "/app"],
  };
  const argv = argvForAction(action, target);
  expect(() => assertSafeAction(action, target, argv)).not.toThrow();
  expect(() =>
    assertSafeAction(action, target, [...argv, "--token=x"]),
  ).toThrow(/unsafe kubectl action/);
  expect(
    parseArgs("audit", ["--action", "apply", "--limit", "3"]),
  ).toMatchObject({
    auditAction: "apply",
    limit: 3,
  });
  expect(await auditCommand(parseArgs("audit", []))).toContain("records");
});

test("audit write failures fail closed", () => {
  const blocked = join(root, "not-a-directory");
  writeFileSync(blocked, "");
  process.env.XDG_STATE_HOME = blocked;
  expect(() =>
    appendAudit({ id: newAuditId(), phase: "start", action: "exec" }),
  ).toThrow(expect.objectContaining({ code: "AUDIT_UNAVAILABLE" }));
});

test("action inputs reject invalid DNS labels and ports", () => {
  const target = {
    context: "production" as Target["context"],
    server: "https://cluster.example",
    defaultNamespace: validateNamespace("apps"),
    source: "flag",
  } satisfies Target;
  for (const action of [
    { kind: "exec", target: `${"a".repeat(64)}`, container: "app", command: ["true"] },
    { kind: "exec", target: "pod", container: `${"a".repeat(64)}`, command: ["true"] },
    { kind: "port-forward", target: "pod", ports: ["0:80"] },
    { kind: "port-forward", target: "pod", ports: ["80:70000"] },
  ] as const)
    expect(() => argvForAction(action, target)).toThrow();
});

test("execute requires explicit context and namespace", () => {
  expect(() =>
    requireExecuteTarget({ execute: true, namespace: "default" }),
  ).toThrow(/--context/);
  expect(() =>
    requireExecuteTarget({ execute: true, context: "prod" }),
  ).toThrow(/-n/);
  expect(() =>
    requireExecuteTarget({
      execute: true,
      context: "prod",
      namespace: "default",
    }),
  ).not.toThrow();
});
