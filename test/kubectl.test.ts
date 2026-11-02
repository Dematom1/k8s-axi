import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { kubectl, parseList, mapKubectlFailure } from "../src/kubectl.js";
import {
  argvFor,
  deadline,
  SECRET_TEMPLATE,
  type Read,
} from "../src/registry.js";
import { redactText } from "../src/redact.js";
import { lab } from "./lab.js";
const local: Read = { op: "local", query: "contexts" };
test("secret cannot use JSON list operation", () => {
  // @ts-expect-error secrets have a distinct projected operation
  const bad: Read = { op: "list", resource: "secrets", scope: { kind: "all" } };
  expect(bad.op).toBe("list");
  expect(SECRET_TEMPLATE).not.toContain("stringData");
});
test("subprocess stdin is closed", async () => {
  const l = lab([], { mode: "stdin" }),
    before = { ...process.env };
  Object.assign(process.env, l.env);
  try {
    await expect(kubectl(local, undefined, deadline())).resolves.toBe("closed");
  } finally {
    process.env = before;
    l.clean();
  }
});
test("registry local pins", () => {
  expect(argvFor(local, undefined, deadline())).toEqual([
    "config",
    "get-contexts",
    "-o",
    "name",
  ]);
});
for (const mode of ["hang", "grandchild", "ignore-term"])
  test(`deadline ${mode}`, async () => {
    const l = lab([], { mode });
    const before = { ...process.env };
    Object.assign(process.env, l.env);
    const start = Date.now();
    try {
      await expect(
        kubectl(local, undefined, { end: Date.now() + 1000, perCall: 1000 }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(Date.now() - start).toBeLessThan(2000);
      await new Promise((r) => setTimeout(r, 2200));
      if (mode === "grandchild") {
        const pid = Number(readFileSync(l.env.K8S_AXI_PID, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      process.env = before;
      l.clean();
    }
  });
test("cap, malformed, secret, missing binary, env", async () => {
  const l = lab([], { mode: "huge" });
  const before = { ...process.env };
  Object.assign(process.env, l.env);
  try {
    await expect(
      kubectl(local, undefined, deadline(), 100),
    ).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    expect(l.calls()[0].kuberc).toBe("off");
    process.env.PATH = l.dir;
    await expect(kubectl(local, undefined, deadline())).rejects.toMatchObject({
      code: "KUBECTL_NOT_INSTALLED",
    });
  } finally {
    process.env = before;
    l.clean();
  }
  for (const raw of ["{", "{}", '{"items":[{"kind":"Secret"}]}'])
    expect(() => parseList(raw)).toThrow();
});
for (const [stderr, code] of [
  ["context was not found", "CONTEXT_NOT_FOUND"],
  ["current-context is not set", "NO_CONTEXT"],
  ["Error from server (NotFound)", "NOT_FOUND"],
  ["forbidden:", "FORBIDDEN"],
  ["Unauthorized", "AUTH_REQUIRED"],
  ["exec plugin", "AUTH_REQUIRED"],
  ["expired", "AUTH_EXPIRED"],
  ["dial tcp", "SERVER_UNREACHABLE"],
  ["context deadline exceeded", "TIMEOUT"],
  ["429", "RATE_LIMITED"],
  ["the server doesn't have a resource type", "UNSUPPORTED_RESOURCE"],
  ["unable to parse requirement", "VALIDATION_ERROR"],
  ["bad", "UPSTREAM_ERROR"],
])
  test(`map ${code}`, () =>
    expect(mapKubectlFailure(stderr ?? "").code).toBe(code));
for (const value of [
  "password=CANARY",
  '{"password":"CANARY"}',
  String.raw`{\"password\":\"CANARY\"}`,
  String.raw`{\\\"password\\\":\\\"CANARY\\\"}`,
  "DB_PASS=CANARY",
  "DB_PWD=CANARY",
  "DB_KEY=CANARY",
  "Bearer CANARY",
  "https://me:CANARY@host",
  "-----BEGIN PRIVATE KEY-----\nCANARY\n-----END PRIVATE KEY-----",
])
  test(`redact ${value}`, () =>
    expect(redactText(value).text).not.toContain("CANARY"));
test("normal corpus unchanged and key formats redacted", () => {
  for (const s of [
    "pod ready",
    "restarted 3 times",
    "GET /api/v1 200",
    "namespace/default",
  ])
    expect(redactText(s).text).toBe(s);
  expect(redactText("AKIA" + "A".repeat(16)).count).toBe(1);
  expect(redactText("Y2FuYXJ5".repeat(8) + "==").count).toBe(1);
});
