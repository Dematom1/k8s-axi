import { test, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { argvFor, assertSafe, type Read, deadline } from "../src/registry.js";
import { validateNamespace, validateResourceName } from "../src/args.js";
import { resolveTarget } from "../src/target.js";
import { runChecks, verdict } from "../src/checks.js";
import { classifyPod } from "../src/model/pods.js";
import { lab, targetRules } from "./lab.js";
test("pin every allowed operation", async () => {
  const l = lab(targetRules()),
    before = { ...process.env };
  Object.assign(process.env, l.env);
  try {
    const t = await resolveTarget(undefined, deadline()),
      name = validateResourceName("object"),
      ns = validateNamespace("sandbox"),
      scope = { kind: "namespace", name: ns, source: "flag" } as const;
    const reads: Read[] = [
      { op: "local", query: "current-context" },
      { op: "local", query: "contexts" },
      { op: "local", query: "client-version" },
      { op: "target", context: t.context },
      { op: "namespace-exists", name: ns },
      { op: "server-version" },
      ...(
        [
          "nodes",
          "namespaces",
          "pods",
          "deployments.apps",
          "jobs.batch",
          "persistentvolumeclaims",
          "services",
          "endpointslices.discovery.k8s.io",
          "events",
        ] as const
      ).map((resource) => ({
        op: "list" as const,
        resource,
        scope:
          resource === "nodes" || resource === "namespaces"
            ? ("cluster" as const)
            : scope,
      })),
      {
        op: "list",
        resource: "events",
        scope,
        fieldSelector: { warnings: true, kind: "Pod", name },
      },
      { op: "get", resource: "node", name },
      { op: "get", resource: "pod", name, namespace: ns },
      { op: "get", resource: "deployment.apps", name, namespace: ns },
      { op: "get", resource: "namespace", name: ns },
      { op: "secrets", scope: { kind: "all" } },
      { op: "secrets", scope, name },
      {
        op: "logs",
        pod: name,
        namespace: ns,
        container: name,
        tail: 100,
        sinceSeconds: 60,
        previous: true,
      },
    ];
    vi.spyOn(Date, "now").mockReturnValue(100000);
    const args = reads.map((r) =>
      argvFor(r, t, { end: 145000, perCall: 20000 }),
    );
    args.forEach(assertSafe);
    expect(args).toMatchSnapshot();
  } finally {
    vi.restoreAllMocks();
    process.env = before;
    l.clean();
  }
});
for (const args of [
  ["get", "secrets", "-A", "-o", "json"],
  ["get", "configmaps", "-A", "-o", "json"],
  ["config", "use-context", "default"],
  ["get", "pods", "--raw=/"],
  ["logs", "p", "-f"],
  ["auth", "can-i", "get", "pods"],
])
  test(`runtime deny ${args.join(" ")}`, () => {
    expect(() =>
      assertSafe([...args, "--context=default", "--request-timeout=100ms"]),
    ).toThrow();
  });
test("overall deadline fails unfinished checks", async () => {
  const l = lab(targetRules(), { stdout: '{"items":[]}', delayMs: 500 }),
    before = { ...process.env };
  Object.assign(process.env, l.env);
  try {
    const t = await resolveTarget(undefined, deadline());
    const checks = await runChecks(
      t,
      { kind: "all" },
      { end: Date.now() + 200, perCall: 200 },
    );
    expect(
      checks.every((c) => c.state === "failed" && c.code === "TIMEOUT"),
    ).toBe(true);
    expect(verdict(checks)).toBe("unknown");
  } finally {
    process.env = before;
    l.clean();
  }
});
test("SIGTERM-ignoring grandchild cannot survive the CLI deadline", () => {
  const l = lab([], { mode: "grandchild-ignore-term" });
  try {
    const p = spawnSync(
      process.execPath,
      [
        resolve(process.env.K8S_AXI_TEST_PACKAGE ?? ".", "dist/bin/k8s-axi.js"),
        "ctx",
        "--timeout",
        "1",
      ],
      { env: { ...process.env, ...l.env }, encoding: "utf8", timeout: 6000 },
    );
    expect(p.status).toBe(1);
    expect(p.stdout).toContain("TIMEOUT");
    const pid = Number(readFileSync(l.env.K8S_AXI_PID, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    l.clean();
  }
});
test("Succeeded stays completed even during delayed deletion", () =>
  expect(
    classifyPod({
      metadata: { deletionTimestamp: "2020-01-01T00:00:00Z" },
      status: { phase: "Succeeded" },
    }).state,
  ).toBe("completed"));
test("transport is the only subprocess boundary in shipped source", () => {
  const root = resolve(process.env.K8S_AXI_TEST_PACKAGE ?? ".", "dist/src");
  function walk(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)],
    );
  }
  for (const file of walk(root))
    if (file.endsWith(".js") && !file.endsWith("/kubectl.js"))
      expect(readFileSync(file, "utf8")).not.toMatch(/(?:node:)?child_process/);
});
