import { afterEach, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { cli } from "./helpers.js";
import { lab, targetRules, type Rule } from "./lab.js";
import { parseManifests, MANIFEST_CAP } from "../src/actions/manifest.js";
import { structuralDiff } from "../src/actions/diff.js";
import { argvForAction, assertSafeAction } from "../src/actions/registry.js";
import { mapApplyFailure } from "../src/commands/apply.js";
import { validateNamespace } from "../src/args.js";
import { resolveTarget } from "../src/target.js";
import { deadline } from "../src/registry.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const deployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "sandbox" },
  spec: { replicas: 1 },
};
const secret = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "db-creds" },
  stringData: { password: "<redacted>", extra: "<redacted>" },
};
function setup(docs: unknown[], rules: Rule[] = []) {
  const l = lab([...targetRules(), ...rules]);
  cleanups.push(l.clean);
  const path = join(l.dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ kind: "List", items: docs }));
  const calls = () =>
    readFileSync(join(l.dir, "calls"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).args as string[]);
  return { ...l, path, calls };
}

test("A1/A11 server dry-run diffs replicas, pins context, never passes the user's path", () => {
  const after = { ...deployment, spec: { replicas: 3 } };
  const l = setup(
    [after],
    [
      { prefix: ["apply"], stdout: JSON.stringify(after) },
      {
        prefix: ["get", "Deployment/web"],
        stdout: JSON.stringify(deployment),
      },
    ],
  );
  const args = ["-f", l.path, "--context", "default"];
  const a = cli(["apply", ...args], l.env),
    b = cli(["diff", ...args], l.env);
  expect(a.status).toBe(0);
  expect(b.stdout).toBe(a.stdout.replace("action: apply", "action: diff"));
  expect(a.data).toMatchObject({
    objects: [{ result: "configure", changes: 1 }],
    changes: [{ path: "spec.replicas", before: 1, after: 3 }],
  });
  const calls = l.calls();
  expect(calls.every((call) => !call.includes(l.path))).toBe(true);
  expect(calls.filter((c) => c[0] === "apply")).toEqual(
    Array(2).fill([
      "apply",
      "--dry-run=server",
      "-o",
      "json",
      "-n",
      "sandbox",
      "-f",
      "-",
      "--context=default",
    ]),
  );
  const captured = readFileSync(join(l.dir, "calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    captured
      .filter((call) => call.args[0] === "apply")
      .map((call) => JSON.parse(call.stdin)),
  ).toEqual([after, after]);
});

test("A2 refuses the entire mixed run before even local kubectl config reads", () => {
  const canary = "C3_NEUTRAL_SECRET_67391";
  const l = setup([
    deployment,
    { ...secret, stringData: { password: canary } },
  ]);
  const r = cli(["apply", "-f", l.path], l.env);
  expect(r.status).toBe(1);
  expect(r.data).toMatchObject({ code: "SECRET_MANIFEST" });
  expect(r.stdout + r.stderr).not.toContain(canary);
  expect(r.stdout).toContain("document 2");
  expect(r.stdout).toContain("password");
  expect(l.calls()).toEqual([]);
});

test("A3 Secret placeholders compare key set and type through projection only", () => {
  const l = setup(
    [secret],
    [
      {
        prefix: ["get", "secrets"],
        stdout: '["sandbox","db-creds","Opaque","",["password","old"]]\n',
      },
    ],
  );
  const r = cli(["apply", "-f", l.path], l.env);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("added [extra]");
  expect(r.stdout).toContain("removed [old]");
  expect(r.stdout).toContain("unchanged [password]");
  expect(r.stdout).toContain("values: never compared");
  expect(l.calls().filter((c) => c[0] === "apply")).toHaveLength(0);
  expect(
    l
      .calls()
      .filter((c) => c[0] === "get")
      .every((c) => c.some((v) => v.startsWith("--output=go-template="))),
  ).toBe(true);
});

test("A4/A5 redacts credential env literals and args before truncation and strips last-applied", () => {
  const canary = "NEUTRAL_782613_VALUE";
  const before = {
    ...deployment,
    metadata: {
      ...deployment.metadata,
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": canary,
      },
    },
    status: { token: canary },
  };
  const after = {
    ...before,
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "app",
              env: [{ name: "API_KEY", value: canary }],
              args: [`password=${canary}`],
            },
          ],
        },
      },
    },
  };
  const l = setup(
    [after],
    [
      { prefix: ["apply"], stdout: JSON.stringify(after) },
      {
        prefix: ["get", "Deployment/web"],
        stdout: JSON.stringify(before),
      },
    ],
  );
  for (const full of [[], ["--full"]]) {
    const r = cli(["apply", "-f", l.path, ...full], l.env);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(canary);
    expect(r.stdout).not.toContain("last-applied");
    expect(r.stdout).toContain("[REDACTED]");
  }
});

test.each(["patch", "create"])(
  "A6/A7 names the missing %s permission without leaking stderr",
  (verb) => {
    const l = setup(
      [deployment],
      [
        {
          prefix: ["apply"],
          code: 1,
          stderr: `Error from server (Forbidden): cannot ${verb} resource "deployments" in API group "apps" in the namespace "sandbox" NEUTRAL_782613_VALUE`,
        },
      ],
    );
    const r = cli(["apply", "-f", l.path], l.env);
    expect(r.status).toBe(1);
    expect(r.data).toMatchObject({ code: "FORBIDDEN" });
    expect(r.stdout).toContain(`needs ${verb} on deployments.apps in sandbox`);
    expect(r.stdout).not.toContain("NEUTRAL_782613_VALUE");
  },
);

test("target namespace follows document namespaces rather than the context default", () => {
  const doc = {
    ...deployment,
    metadata: { ...deployment.metadata, namespace: "other" },
  };
  const l = setup(
    [doc],
    [
      { prefix: ["apply"], stdout: JSON.stringify(doc) },
      { prefix: ["get", "Deployment/web"], stdout: "" },
    ],
  );
  expect(cli(["apply", "-f", l.path], l.env).data).toMatchObject({
    target: { namespace: "other" },
  });
  expect(l.calls().filter((call) => call[0] === "apply")[0]).toContain("other");
  writeFileSync(
    l.path,
    JSON.stringify({ kind: "List", items: [doc, deployment] }),
  );
  expect(cli(["apply", "-f", l.path], l.env).data).toMatchObject({
    target: { namespace: "multiple namespaces (see objects)" },
  });
});

test("A8 keeps per-object outcomes in a partial preview", () => {
  const l = setup(
    [secret, deployment],
    [
      { prefix: ["get", "secrets"], stdout: "" },
      {
        prefix: ["apply"],
        code: 1,
        stderr: "Error from server (Forbidden): denied",
      },
    ],
  );
  const r = cli(["apply", "-f", l.path], l.env);
  expect(r.status).toBe(1);
  expect(r.data).toMatchObject({
    code: "PARTIAL",
    objects: [
      { object: "sandbox/Secret/db-creds" },
      { object: "sandbox/Deployment/web" },
    ],
  });
});

test("A9 reports an invalid field and reason, never the rejected value", () => {
  const l = setup(
    [deployment],
    [
      {
        prefix: ["apply"],
        code: 1,
        stderr:
          'The Deployment "web" is invalid: spec.replicas: Invalid value: -1: must be greater than zero',
      },
    ],
  );
  const r = cli(["apply", "-f", l.path], l.env);
  expect(r.status).toBe(1);
  expect(r.data).toMatchObject({ code: "INVALID_MANIFEST" });
  expect(r.stdout).toContain("spec.replicas: Invalid value");
  expect(r.stdout).not.toContain("-1");
});

test("A10/A12 rejects unsupported input locally", () => {
  const l = setup([deployment]);
  for (const args of [
    ["-k", l.dir],
    ["--recursive", "-f", l.path],
    ["-f", "https://example.invalid/x"],
    ["-f", l.dir],
    ["--execute"],
    ["-f", l.path, "-n", "other"],
    [],
    ["-f", l.path, "-A"],
  ]) {
    const r = cli(["apply", ...args], l.env);
    expect(r.status, args.join(" ")).toBe(2);
    expect(r.data).toMatchObject({ code: "VALIDATION_ERROR" });
  }
  expect(l.calls()).toEqual([]);
  writeFileSync(l.path, " ".repeat(MANIFEST_CAP + 1));
  expect(cli(["diff", "-f", l.path], l.env).status).toBe(2);
  writeFileSync(
    l.path,
    JSON.stringify({ kind: "List", items: Array(51).fill(deployment) }),
  );
  expect(cli(["diff", "-f", l.path], l.env).status).toBe(2);
});

test("YAML parses Kubernetes defaultMode using YAML 1.1 octal", () => {
  const manifests = parseManifests(
    `apiVersion: v1\nkind: Pod\nmetadata: {name: scalars}\nspec:\n  containers: [{name: app, image: busybox}]\n  volumes:\n    - name: settings\n      configMap: {name: settings, defaultMode: 0644}`,
  );
  expect(manifests).toHaveLength(1);
  expect(manifests[0]?.value).toMatchObject({
    spec: { volumes: [{ configMap: { defaultMode: 0o644 } }] },
  });
});

test("stdin JSON and multi-document YAML parse, empty or malformed docs fail safely", () => {
  expect(
    parseManifests(
      'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: app}\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: redacted}\nstringData: {key: "<redacted>"}',
    ),
  ).toHaveLength(2);
  for (const raw of [
    "",
    "kind: [",
    "kind: Secret\nstringData: {password: canary}",
    JSON.stringify({ kind: "List", items: Array(51).fill(deployment) }),
    "a: &a [*a]",
  ])
    expect(() => parseManifests(raw)).toThrow();
  const l = setup(
    [deployment],
    [
      { prefix: ["apply"], stdout: JSON.stringify(deployment) },
      { prefix: ["get", "Deployment/web"], stdout: "" },
    ],
  );
  const r = spawnSync(
    process.execPath,
    [resolve("dist/bin/k8s-axi.js"), "apply", "-f", "-"],
    {
      env: { ...process.env, ...l.env },
      input: JSON.stringify(deployment),
      encoding: "utf8",
    },
  );
  expect(r.status).toBe(0);
  expect(decode(r.stdout)).toMatchObject({ objects: [{ result: "create" }] });
});

test("normalizes server-only fields and safely truncates all string leaves", () => {
  expect(
    structuralDiff(
      "x",
      {
        metadata: {
          uid: "1",
          annotations: {
            "kubectl.kubernetes.io/last-applied-configuration": "secret",
          },
        },
        status: { x: 1 },
      },
      { metadata: { uid: "2" }, status: { x: 2 } },
    ),
  ).toEqual([]);
  const result = structuralDiff("x", {}, { data: { text: "z".repeat(200) } });
  expect(result[0]?.after).toContain("200 chars total; --full");
  expect(
    structuralDiff("x", {}, { data: { text: "z".repeat(200) } }, true)[0]
      ?.after,
  ).toBe("z".repeat(200));
  expect(mapApplyFailure("error untrusted canary").message).not.toContain(
    "canary",
  );
  expect(
    mapApplyFailure(
      'cannot get resource "widgets" in API group "team--ops.example.com" in the namespace "sandbox"',
    ).code,
  ).toBe("FORBIDDEN");
  expect(
    structuralDiff(
      "x",
      { x: "old" },
      { x: { env: [{ name: "API_KEY", value: "NEUTRAL_782613_VALUE" }] } },
    ),
  ).toMatchObject([{ path: "x", before: "old" }]);
  expect(
    JSON.stringify(
      structuralDiff(
        "x",
        { x: "old" },
        { x: { env: [{ name: "API_KEY", value: "NEUTRAL_782613_VALUE" }] } },
      ),
    ),
  ).not.toContain("NEUTRAL_782613_VALUE");
  expect(structuralDiff("x", {}, { x: [] })).toMatchObject([
    { path: "x", before: null, after: "[]" },
  ]);
});

test("action allowlist rejects Secret/List apply and unprojected Secret reads", async () => {
  const l = setup([]);
  const old = { ...process.env };
  Object.assign(process.env, l.env);
  try {
    const target = await resolveTarget(undefined, deadline());
    for (const resource of [
      "Secret",
      "secrets",
      "Secret.v1",
      "pods --raw",
      "Deployment.v1.-bad.example.com",
      "Deployment.v1.bad-.example.com",
      "Deployment.v1.bad..example.com",
      "Deployment.v1.Bad.example.com",
    ])
      expect(() =>
        argvForAction({ kind: "apply-get", resource, name: "x" }, target),
      ).toThrow();
    expect(
      argvForAction(
        {
          kind: "apply-get",
          resource: "Deployment.v1.team--ops.example.com",
          name: "web",
        },
        target,
      ),
    ).toContain("Deployment.v1.team--ops.example.com/web");
    expect(() =>
      argvForAction(
        { kind: "apply-get", resource: "ConfigMap.v1.", name: "settings" },
        target,
      ),
    ).toThrow();
    for (const kind of [
      "Secret",
      "List",
      "secret",
      "SecretList",
      "DeploymentList",
    ])
      expect(() =>
        argvForAction(
          { kind: "apply", manifest: JSON.stringify({ kind }) },
          target,
        ),
      ).toThrow();
    const action = {
      kind: "apply-get",
      resource: "Deployment.v1.apps",
      name: "web",
    } as const;
    const argv = argvForAction(action, {
      ...target,
      defaultNamespace: validateNamespace("sandbox"),
    });
    expect(() => assertSafeAction(action, target, argv)).not.toThrow();
    expect(() =>
      assertSafeAction(action, target, [...argv, "--raw"]),
    ).toThrow();
  } finally {
    process.env = old;
  }
});

test.each(["List", "SecretList", "ConfigMapList"])(
  "typed wrapper %s cannot send real Secret values to kubectl",
  (kind) => {
    const canary = "NEUTRAL_TYPED_VALUE_631879";
    const member = { ...secret, stringData: { password: canary } };
    const wrapper = {
      apiVersion: "v1",
      kind,
      metadata: { name: "bundle" },
      items: [member],
    };
    const l = setup([deployment, wrapper]);
    const result = cli(["apply", "-f", l.path], l.env);
    expect(result.status).toBe(kind === "ConfigMapList" ? 2 : 1);
    expect(result.data).toMatchObject({
      code: kind === "ConfigMapList" ? "VALIDATION_ERROR" : "SECRET_MANIFEST",
    });
    expect(result.stdout + result.stderr).not.toContain(canary);
    expect(l.calls()).toEqual([]);
  },
);

test.each([
  ["kind", "ConfigMap"],
  ["apiVersion", "apps/v1"],
])(
  "typed Lists reject conflicting member %s before kubectl",
  (field, value) => {
    const member = {
      metadata: { name: "db-creds" },
      stringData: { password: "NEUTRAL_TYPED_VALUE_631879" },
      [field]: value,
    };
    const l = setup([
      { apiVersion: "v1", kind: "SecretList", items: [member] },
    ]);
    const result = cli(["apply", "-f", l.path], l.env);
    expect(result.status).toBe(2);
    expect(result.data).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(result.stdout + result.stderr).not.toContain(
      "NEUTRAL_TYPED_VALUE_631879",
    );
    expect(l.calls()).toEqual([]);
  },
);

test("typed Lists inherit member kind and API version and enforce the object cap", () => {
  const member = {
    metadata: { name: "db-creds" },
    stringData: { password: "<redacted>" },
  };
  const wrapper = { apiVersion: "v1", kind: "SecretList", items: [member] };
  expect(parseManifests(JSON.stringify(wrapper))).toMatchObject([
    { kind: "Secret", value: { apiVersion: "v1", kind: "Secret", ...member } },
  ]);
  expect(() =>
    parseManifests(
      JSON.stringify({ ...wrapper, items: Array(51).fill(member) }),
    ),
  ).toThrow();
  const l = setup([wrapper], [{ prefix: ["get", "secrets"], stdout: "" }]);
  expect(cli(["apply", "-f", l.path], l.env).status).toBe(0);
  expect(l.calls().some((call) => call[0] === "apply")).toBe(false);
});

test.each(["--password", "--token", "--api-key", "-p"])(
  "credential flags %s hide adjacent values on every diff path",
  (flag) => {
    const oldValue = "NEUTRAL_OLD_VALUE_631879",
      newValue = "NEUTRAL_NEW_VALUE_631879";
    const before = { spec: { args: [flag, oldValue, "--verbose", "safe"] } };
    const after = { spec: { args: [flag, newValue, "--verbose", "safe"] } };
    for (const full of [false, true]) {
      const changes = structuralDiff("x", before, after, full);
      expect(changes).toEqual([
        {
          object: "x",
          path: "spec.args[1]",
          before: "[REDACTED]",
          after: "[REDACTED]",
        },
      ]);
      const aggregate = structuralDiff("x", { spec: "old shape" }, after, full);
      expect(JSON.stringify(aggregate)).not.toContain(newValue);
      expect(JSON.stringify(aggregate)).toContain("safe");
      const removedFlag = structuralDiff(
        "x",
        before,
        { spec: { args: ["--label", oldValue, "--verbose", "changed"] } },
        full,
      );
      expect(JSON.stringify(removedFlag)).not.toContain(oldValue);
      expect(JSON.stringify(removedFlag)).toContain("changed");
    }
  },
);

test.each(["password", "token", "secret", "apiKey", "DB_PASSWORD"])(
  "credential-named fields %s hide scalar and aggregate changes",
  (key) => {
    const canary = "NEUTRAL_FIELD_VALUE_631879";
    for (const full of [false, true]) {
      const after = { data: { [key]: canary, ordinary: "visible" } };
      const changes = structuralDiff("x", {}, after, full);
      expect(changes).toContainEqual({
        object: "x",
        path: `data.${key}`,
        before: null,
        after: "[REDACTED]",
      });
      expect(changes).toContainEqual({
        object: "x",
        path: "data.ordinary",
        before: null,
        after: "visible",
      });
      expect(
        JSON.stringify(structuralDiff("x", { data: "old shape" }, after, full)),
      ).not.toContain(canary);
      expect(
        JSON.stringify(structuralDiff("x", after, {}, full)),
      ).not.toContain(canary);
    }
  },
);

test.each([
  [
    "autoscaling/v1",
    "HorizontalPodAutoscaler",
    "HorizontalPodAutoscaler.v1.autoscaling",
  ],
  ["v1", "ConfigMap", "ConfigMap.v1"],
])(
  "manifest API version %s pins the live-object representation",
  (apiVersion, kind, _resource) => {
    const manifest = { apiVersion, kind, metadata: { name: "versioned" } };
    const l = setup(
      [manifest],
      [
        { prefix: ["apply"], stdout: JSON.stringify(manifest) },
        {
          prefix: ["get", `${kind}/versioned`],
          stdout: JSON.stringify(manifest),
        },
      ],
    );
    const result = cli(["apply", "-f", l.path], l.env);
    expect(result.status).toBe(0);
    expect(result.data).toMatchObject({
      objects: [{ result: "unchanged", changes: 0 }],
      changes: [],
    });
    expect(l.calls().find((call) => call[0] === "get")).toContain(
      `${kind}/versioned`,
    );
  },
);
