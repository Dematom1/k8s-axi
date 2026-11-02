#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decode } from "@toon-format/toon";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--context" ||
  args[1] !== "default" ||
  !realpathSync(process.cwd()).startsWith(realpathSync(tmpdir()) + "/")
) {
  process.stderr.write(
    "Run from a temporary directory with --context default\n",
  );
  process.exit(2);
}
const context = args[1],
  temp = mkdtempSync(join(tmpdir(), "k8s-live-"));
const checks = {};
const counts = {};
const kubeconfig = process.env.KUBECONFIG ?? join(homedir(), ".kube/config");
const hash = () =>
  createHash("sha256").update(readFileSync(kubeconfig)).digest("hex");
const before = hash();
const real = spawnSync("/bin/sh", ["-c", "command -v kubectl"], {
  encoding: "utf8",
}).stdout.trim();
if (!real) {
  process.stderr.write("kubectl is required\n");
  process.exit(1);
}
const bin = join(temp, "bin");
mkdirSync(bin);
const audit = join(temp, "audit");
writeFileSync(audit, "");
const registry = pathToFileURL(join(root, "dist/src/registry.js")).href;
writeFileSync(
  join(bin, "kubectl"),
  `#!${process.execPath}\nimport {assertSafe} from ${JSON.stringify(registry)};\nimport {spawnSync} from 'node:child_process';\nimport {appendFileSync} from 'node:fs';\nconst a=process.argv.slice(2);try{assertSafe(a);}catch{process.stderr.write('AUDIT_REFUSED');process.exit(90);}\nappendFileSync(${JSON.stringify(audit)},JSON.stringify(a)+'\\n');\nconst p=spawnSync(${JSON.stringify(real)},a,{stdio:'inherit',timeout:130000,env:{...process.env,KUBERC:'off'}});process.exit(p.status ?? 1);\n`,
  { mode: 0o755 },
);
// A .mjs wrapper is needed even on hosts that default extensionless Node files to CommonJS.
writeFileSync(join(temp, "package.json"), '{"type":"module"}');
const env = {
  ...process.env,
  PATH: bin + ":" + process.env.PATH,
  HOME: join(temp, "home"),
  XDG_CACHE_HOME: join(temp, "cache"),
  KUBECONFIG: kubeconfig,
  KUBERC: "off",
};
mkdirSync(env.HOME);
const cli = join(
  process.env.K8S_AXI_TEST_PACKAGE ?? root,
  "dist/bin/k8s-axi.js",
);
const outputs = [];
function run(a, expected = 0) {
  const p = spawnSync(process.execPath, [cli, ...a, "--context", context], {
    encoding: "utf8",
    env,
    timeout: 60000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (p.status !== expected) throw new Error("CLI exit gate: " + a[0]);
  if (p.stderr) throw new Error("unexpected stderr");
  const data = decode(p.stdout, { strict: true });
  outputs.push(p.stdout + p.stderr);
  return { data, stdout: p.stdout };
}
function ref(a) {
  const p = spawnSync(
    real,
    [...a, "--context=" + context, "--request-timeout=15s"],
    {
      encoding: "utf8",
      env: { ...env, PATH: process.env.PATH },
      timeout: 20000,
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  if (p.status !== 0) throw new Error("reference read failed");
  return p.stdout;
}
try {
  const nodes = JSON.parse(ref(["get", "nodes", "-o", "json"])).items;
  const namespaces = JSON.parse(ref(["get", "namespaces", "-o", "json"])).items;
  counts.nodes = nodes.length;
  counts.namespaces = namespaces.length;
  counts.fingerprint = createHash("sha256")
    .update(
      nodes
        .map((n) => n.metadata.uid)
        .sort()
        .join(","),
    )
    .digest("hex");
  const nodeResult = run(["nodes", "--limit", "1000"]).data;
  checks.nodes =
    nodeResult.nodes.length === nodes.length &&
    nodeResult.nodes.every((n) => {
      const raw = nodes.find((r) => r.metadata.name === n.node),
        ready = raw.status.conditions.find((c) => c.type === "Ready")?.status;
      return (
        n.version === raw.status.nodeInfo.kubeletVersion &&
        (ready !== "True" || n.status === "Ready")
      );
    });
  const pods = JSON.parse(ref(["get", "pods", "-A", "-o", "json"])).items;
  const podResult = run(["pods", "-A", "--limit", "1000"]).data;
  counts.pods = podResult.matching;
  checks.podCount = Math.abs(podResult.matching - pods.length) <= 4;
  const independent = (p) => {
    if (
      p.metadata.deletionTimestamp &&
      (Date.now() - Date.parse(p.metadata.deletionTimestamp)) / 1000 >
        (p.spec.terminationGracePeriodSeconds ?? 30) + 60
    )
      return true;
    if (p.status.phase === "Succeeded") return false;
    const waiting = [
      ...(p.status.initContainerStatuses ?? []),
      ...(p.status.containerStatuses ?? []),
    ].some(
      (c) =>
        c.state?.waiting?.reason &&
        !["ContainerCreating", "PodInitializing"].includes(
          c.state.waiting.reason,
        ),
    );
    if (waiting || ["Failed", "Unknown"].includes(p.status.phase)) return true;
    return (
      Date.now() - Date.parse(p.metadata.creationTimestamp) > 120000 &&
      (p.status.phase === "Pending" ||
        (p.status.phase === "Running" &&
          !p.status.conditions?.some(
            (c) => c.type === "Ready" && c.status === "True",
          )))
    );
  };
  const problemResult = run([
    "pods",
    "-A",
    "--problems",
    "--limit",
    "1000",
  ]).data;
  const actual = Array.isArray(problemResult.pods)
    ? problemResult.pods.map((p) => p.pod).sort()
    : [];
  const expected = pods
    .filter(independent)
    .map((p) => p.metadata.namespace + "/" + p.metadata.name)
    .sort();
  checks.podProblems = JSON.stringify(actual) === JSON.stringify(expected);
  const eventRef = JSON.parse(
    ref(["get", "events", "-n", "kube-system", "-o", "json"]),
  ).items;
  const eventResult = run([
    "events",
    "-n",
    "kube-system",
    "--limit",
    "1000",
  ]).data;
  counts.kubeSystemEvents = eventRef.length;
  checks.events = eventResult.matching === eventRef.length;
  const allEvents = run(["events", "-A", "--limit", "1000"]).data;
  checks.eventTimes =
    !Array.isArray(allEvents.events) ||
    (allEvents.events.every((e) => !e.time.startsWith("unknown")) &&
      allEvents.events.every(
        (e, i, es) =>
          i === 0 ||
          Date.parse(e.time.split(" ")[0]) <=
            Date.parse(es[i - 1].time.split(" ")[0]),
      ));
  const missing = "axi-definitely-missing-" + Date.now();
  const missingContext = spawnSync(
    process.execPath,
    [cli, "triage", "--context", missing],
    { encoding: "utf8", env, timeout: 10000 },
  );
  checks.missingContext =
    missingContext.status === 1 &&
    decode(missingContext.stdout).code === "CONTEXT_NOT_FOUND" &&
    !missingContext.stdout.includes("healthy");
  for (const noun of [
    "pods",
    "deployments",
    "jobs",
    "pvcs",
    "services",
    "events",
    "secrets",
  ])
    checks["missing-" + noun] =
      run([noun, "-n", missing], 1).data.code === "NAMESPACE_NOT_FOUND";
  for (const a of [
    ["pods", "nonsense"],
    ["events", "--limit", "10junk"],
    ["pods", "--namespace", "--context", "default"],
    ["pods", "-n", "-A"],
  ])
    checks["usage-" + a.join(" ")] = run(a, 2).data.code === "VALIDATION_ERROR";
  const currentNamespace = run(["ctx"]).data.namespace;
  const namespaceExists = namespaces.some(
    (n) => n.metadata.name === currentNamespace,
  );
  const current = run(["pods"], namespaceExists ? 0 : 1).data;
  checks.currentNamespace = namespaceExists
    ? current.scope === "namespace " + currentNamespace
    : current.code === "NAMESPACE_NOT_FOUND";
  counts.currentNamespaceExists = namespaceExists;
  counts.currentNamespacePods = namespaceExists ? current.matching : 0;
  const home = run([], 0).data;
  checks.skew =
    typeof home.warning === "string" && home.warning.includes("skew");
  // Reference Secret values remain only in this process's memory. Never write or print them.
  const secrets = JSON.parse(ref(["get", "secrets", "-A", "-o", "json"])).items;
  const values = secrets
    .flatMap((s) => Object.values(s.data ?? {}))
    .filter((v) => typeof v === "string" && v.length > 0);
  const inventory = run(["secrets", "-A", "--limit", "1000"]).data;
  counts.secrets = secrets.length;
  counts.keys = values.length;
  checks.secretCounts =
    inventory.matching === secrets.length &&
    inventory.secrets.reduce((n, s) => n + s.keys, 0) ===
      secrets.reduce((n, s) => n + Object.keys(s.data ?? {}).length, 0);
  for (const s of secrets.slice(0, 12))
    run([
      "secrets",
      "view",
      s.metadata.name,
      "-n",
      s.metadata.namespace,
      "--full",
    ]);
  const livePod = pods.find(
    (p) => p.status.phase === "Running" && p.spec.containers?.length,
  );
  if (livePod)
    run([
      "pods",
      "logs",
      livePod.metadata.name,
      "-n",
      livePod.metadata.namespace,
      "-c",
      livePod.spec.containers[0].name,
      "--tail",
      "100",
    ]);
  const joined = outputs.join("\n");
  counts.base64ValueMatches = values.reduce(
    (n, v) => n + Number(joined.includes(v)),
    0,
  );
  checks.blindSecrets = counts.base64ValueMatches === 0;
  const table = ref(["get", "pods", "-A"]);
  const compact = run(["pods", "-A"]).stdout;
  counts.kubectlPodBytes = Buffer.byteLength(table);
  counts.axiPodBytes = Buffer.byteLength(compact);
  checks.size = counts.axiPodBytes < counts.kubectlPodBytes;
  checks.kubeconfigUnchanged = hash() === before;
  counts.auditCalls = readFileSync(audit, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean).length;
  checks.audit = counts.auditCalls > 0;
  const passed = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ passed, counts, checks }) + "\n");
  process.exitCode = passed ? 0 : 1;
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      passed: false,
      error: e.message,
      checks,
      counts,
      kubeconfigUnchanged: hash() === before,
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
