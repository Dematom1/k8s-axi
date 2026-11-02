import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
import { podDetail } from "../src/model/pods.js";
import { object, objects } from "../src/kubectl.js";
const CANARY = "CANARY_UNREAD_FIELD_7db";
const when = "2020-01-01T00:00:00Z";
const base = {
  kind: "Pod",
  apiVersion: "v1",
  metadata: {
    name: "p",
    namespace: "sandbox",
    creationTimestamp: when,
    annotations: { lastApplied: "payload" },
    managedFields: [{ manager: "payload" }],
    ownerReferences: [{ kind: "Workflow", name: "w" }],
  },
  spec: {
    containers: [
      {
        name: "c",
        env: [{ name: "PASSWORD", value: "payload" }],
        args: ["payload"],
        command: ["payload"],
      },
    ],
    volumes: [{ secret: { secretName: "payload" } }],
    nodeName: "node",
    replicas: 1,
    selector: { app: "p" },
  },
  status: {
    phase: "Running",
    conditions: [
      { type: "Ready", status: "True", reason: "Ready", message: "normal" },
    ],
    containerStatuses: [{ name: "c", ready: true, restartCount: 0 }],
    nodeInfo: { kubeletVersion: "v1.32.1" },
    capacity: { storage: "1Gi" },
    readyReplicas: 1,
    updatedReplicas: 1,
  },
  unused: "payload",
};
const allowed = [
  /^kind$/,
  /^metadata\.(name|namespace|creationTimestamp)$/,
  /^metadata\.ownerReferences\.\d+\.(kind|name)$/,
  /^spec\.containers\.\d+\.name$/,
  /^spec\.nodeName$/,
  /^spec\.selector\./,
  /^status\.(phase|conditions\.\d+\.(type|status|reason|message)|containerStatuses\.\d+\.name|nodeInfo\.kubeletVersion|capacity\.storage)$/,
];
function poison(v: unknown, path = ""): unknown {
  if (typeof v === "string")
    return allowed.some((re) => re.test(path)) ? v : CANARY;
  if (Array.isArray(v)) return v.map((x, i) => poison(x, path + "." + i));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        poison(x, path ? path + "." + k : k),
      ]),
    );
  return v;
}
const raw = poison(base);
function assertClean(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(CANARY);
}
test("poison sweep detects an env projection regression", () => {
  const detail = podDetail(object(raw));
  assertClean(detail);
  const env = object(objects(object(object(raw).spec).containers)[0]).env;
  expect(() => assertClean({ ...detail, env })).toThrow();
});
for (const args of [
  ["nodes"],
  ["nodes", "view", "p"],
  ["namespaces"],
  ["pods", "-A"],
  ["pods", "view", "p"],
  ["pods", "logs", "p", "-c", "c"],
  ["deployments"],
  ["deployments", "view", "p"],
  ["jobs"],
  ["pvcs"],
  ["services"],
  ["events"],
  ["secrets"],
  ["secrets", "view", "s"],
  ["triage"],
  [],
])
  for (const full of [false, true])
    test(`poison ${args.join(" ")} full=${full}`, () => {
      const l = lab(
        [
          { prefix: ["get", "namespace"], stdout: "namespace/sandbox" },
          { prefix: ["get", "node"], stdout: JSON.stringify(raw) },
          { prefix: ["get", "pod"], stdout: JSON.stringify(raw) },
          { prefix: ["get", "deployment.apps"], stdout: JSON.stringify(raw) },
          {
            prefix: ["get", "secrets"],
            stdout: JSON.stringify([
              "sandbox",
              "s",
              "Opaque",
              when,
              ["tls.crt"],
            ]),
          },
          { prefix: ["logs"], stdout: "normal log" },
          ...targetRules(),
        ],
        { stdout: JSON.stringify({ items: [raw] }) },
      );
      try {
        const p = cli(
          [
            ...args,
            ...(full && args[0] !== "triage" && args.length ? ["--full"] : []),
          ],
          l.env,
        );
        expect(p.status, p.stdout).toBe(0);
        expect(p.stderr).toBe("");
        assertClean(p.stdout);
        for (const call of l.calls()) expect(call.kuberc).toBe("off");
      } finally {
        l.clean();
      }
    });
