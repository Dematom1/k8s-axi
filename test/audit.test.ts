import { afterAll, beforeEach, expect, test } from "vitest";
import {
  mkdirSync,
  readFileSync,
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

test("audit rotation keeps one generation", () => {
  mkdirSync(dirname(auditPath()), { recursive: true });
  writeFileSync(auditPath(), "x".repeat(10 * 1024 * 1024), { mode: 0o600 });
  appendAudit({ id: newAuditId(), phase: "start", action: "apply" });
  expect(statSync(join(root, "k8s-axi", "audit.1.jsonl")).size).toBe(
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
