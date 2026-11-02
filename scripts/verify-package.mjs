#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  symlinkSync,
  existsSync,
  readdirSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { decode } from "@toon-format/toon";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const published = args.includes("--published")
  ? args[args.indexOf("--published") + 1]
  : undefined;
if (published && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(published))
  throw new Error("invalid published version");
const proof = process.env.K8S_AXI_EVIDENCE_DIR
  ? resolve(process.env.K8S_AXI_EVIDENCE_DIR)
  : mkdtempSync(join(tmpdir(), "k8s-package-"));
mkdirSync(proof, { recursive: true });
function exec(bin, a, options = {}) {
  const p = spawnSync(bin, a, {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (p.error || p.status !== 0)
    throw new Error(
      `verification command failed: ${bin} ${a.slice(0, 3).join(" ")}`,
    );
  return p.stdout;
}
const head = exec("git", ["rev-parse", "HEAD"]).trim(),
  dirty = exec("git", ["status", "--porcelain"]).trim();
if (dirty && !args.includes("--allow-dirty"))
  throw new Error("commit the candidate before verifying its archive");
const work = mkdtempSync(join(proof, "run-")),
  stage = join(work, "stage");
mkdirSync(stage);
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let packed;
if (published) {
  packed = JSON.parse(
    exec("npm", [
      "pack",
      `k8s-axi@${published}`,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      work,
    ]),
  )[0];
} else {
  for (const path of metadata.files)
    if (existsSync(join(root, path)))
      cpSync(join(root, path), join(stage, path), { recursive: true });
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({ ...metadata, gitHead: head }, null, 2) + "\n",
  );
  packed = JSON.parse(
    exec(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", work],
      { cwd: stage },
    ),
  )[0];
}
const tarball = join(work, packed.filename),
  archive = JSON.parse(exec("tar", ["-xOzf", tarball, "package/package.json"]));
if (archive.gitHead !== head)
  throw new Error("archive gitHead does not match the checked-out source");
if (
  archive.name !== "k8s-axi" ||
  archive.version !== (published ?? metadata.version)
)
  throw new Error("archive package identity mismatch");
const prefix = join(work, "install");
exec("npm", [
  "install",
  "--prefix",
  prefix,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  tarball,
]);
const installed = join(prefix, "node_modules/k8s-axi");
const log = exec(
  join(root, "node_modules/.bin/vitest"),
  ["run", "--reporter=json", "--outputFile=" + join(work, "tests.json")],
  {
    env: {
      ...process.env,
      K8S_AXI_TEST_PACKAGE: installed,
      K8S_AXI_REQUIRE_REAL_KUBECTL: "1",
    },
    timeout: 120000,
  },
);
writeFileSync(join(work, "test-run.log"), log);
if (published)
  exec("npm", ["audit", "signatures", "--prefix", prefix], { timeout: 120000 });
const evidence = [];
const files = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".config/opencode/plugins/axi-k8s-axi.js",
];
function snapshot(home) {
  return Object.fromEntries(
    files.map((file) => {
      try {
        return [file, readFileSync(join(home, file), "utf8")];
      } catch (e) {
        return [file, e.code === "ENOENT" ? null : "unreadable"];
      }
    }),
  );
}
function permissions(path, mode) {
  if (!existsSync(path)) return;
  if (mode === 0o700) chmodSync(path, mode);
  if (statSync(path).isDirectory())
    for (const n of readdirSync(path)) permissions(join(path, n), mode);
  chmodSync(path, mode);
}
function invoke(cli, a, home, cwd = home) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    KUBECONFIG: join(home, "no-kubeconfig"),
  };
  const p = spawnSync(process.execPath, [cli, ...a], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    ...p,
    data: decode(p.stdout, { strict: true }),
    env: { HOME: home, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, cwd },
  };
}
const cli = join(installed, "dist/bin/k8s-axi.js");
for (const destination of [".claude", ".codex", ".config", "nested", "all"])
  for (const action of ["install", "repair", "uninstall", "status"]) {
    const home = mkdtempSync(join(work, "negative-"));
    const initialized = action !== "install";
    if (initialized && invoke(cli, ["setup", "hooks"], home).status !== 0)
      throw new Error("baseline setup failed");
    if (action === "repair") {
      for (const file of files) {
        const path = join(home, file);
        if (existsSync(path))
          writeFileSync(
            path,
            readFileSync(path, "utf8").replaceAll(
              installed,
              "/missing/old-install",
            ),
          );
      }
    }
    if (destination === "nested" && !initialized) {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude/settings.json"), '{"unrelated":true}');
    }
    const before = snapshot(home);
    const paths =
      destination === "all"
        ? [".claude", ".codex", ".config"]
        : destination === "nested"
          ? [".claude"]
          : [destination];
    for (const path of paths) {
      mkdirSync(join(home, path), { recursive: true });
      permissions(join(home, path), action === "status" ? 0o000 : 0o500);
    }
    const command = [
      "setup",
      action === "install" || action === "repair" ? "hooks" : action,
    ];
    const result = invoke(cli, command, home);
    const denied = snapshot(home);
    for (const path of paths) permissions(join(home, path), 0o700);
    const reopened = snapshot(home);
    const partialWrites = files.filter((f) => before[f] !== reopened[f]);
    evidence.push({
      destination,
      action,
      command: [process.execPath, cli, ...command],
      env: result.env,
      exit: result.status,
      code: result.data.code ?? null,
      reported: result.data.error ?? result.data,
      stderr: result.stderr,
      denied,
      reopened,
      partialWrites,
    });
    writeFileSync(
      join(proof, "negative-cases.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    if (process.getuid?.() === 0)
      throw new Error("permission gates inconclusive as root");
    if (
      result.status !== 1 ||
      result.data.code !== "CONFIG_INVALID" ||
      result.stderr
    )
      throw new Error(
        `negative integration gate failed: ${destination} ${action} exit=${result.status} code=${result.data.code}`,
      );
  }
// Run the exact stored lifecycle commands after a move into a path containing a quote and spaces.
const relocated = join(work, "relocated ' install");
cpSync(installed, relocated, { recursive: true });
symlinkSync(join(prefix, "node_modules"), join(relocated, "node_modules"));
const movedCli = join(relocated, "dist/bin/k8s-axi.js");
const home = mkdtempSync(join(work, "lifecycle-"));
invoke(cli, ["setup", "hooks"], home);
if (invoke(movedCli, ["setup", "hooks"], home).status !== 0)
  throw new Error("relocation repair failed");
const nodeBin = join(work, "node-only");
mkdirSync(nodeBin);
symlinkSync(process.execPath, join(nodeBin, "node"));
const settings = JSON.parse(
  readFileSync(join(home, ".claude/settings.json"), "utf8"),
);
const transcript = join(work, "transcript.jsonl");
writeFileSync(
  transcript,
  JSON.stringify({
    message: {
      content: [
        {
          type: "tool_use",
          input: {
            command: "k8s-axi pods --context default -l password=CANARY",
          },
        },
      ],
    },
  }) + "\n",
);
for (const event of ["SessionStart", "SessionEnd"]) {
  const command = settings.hooks[event]
    .flatMap((g) => g.hooks)
    .find((h) => h.command.includes("k8s-axi")).command;
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: work,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: nodeBin,
      KUBECONFIG: join(home, "absent"),
    },
    input: JSON.stringify({ cwd: work, transcript_path: transcript }),
    encoding: "utf8",
    timeout: 15000,
  });
  if (
    result.status !== 0 ||
    result.stdout.includes("CANARY") ||
    result.stdout.includes("healthy")
  )
    throw new Error("stored lifecycle execution failed");
  evidence.push({
    action: event,
    command,
    exit: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    cwd: work,
    PATH: nodeBin,
  });
}
const ephemeralHome = mkdtempSync(join(work, "npx-home-"));
const npx = spawnSync(
  "npm",
  ["exec", "--yes", "--package", tarball, "--", "k8s-axi", "setup", "hooks"],
  {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: ephemeralHome,
      npm_config_cache: join(work, "npx-cache"),
      npm_config_ignore_scripts: "true",
    },
    timeout: 90000,
  },
);
const npxData = decode(npx.stdout, { strict: true });
if (
  npx.status !== 1 ||
  npxData.code !== "REFUSED" ||
  files.some((f) => existsSync(join(ephemeralHome, f)))
)
  throw new Error("real npx refusal gate failed");
evidence.push({
  action: "real npx",
  exit: npx.status,
  code: npxData.code,
  stderr: npx.stderr,
  files: snapshot(ephemeralHome),
});
const suite = JSON.parse(readFileSync(join(work, "tests.json"), "utf8"));
const registryDist = published
  ? JSON.parse(exec("npm", ["view", `k8s-axi@${published}`, "dist", "--json"]))
  : undefined;
const actualIntegrity =
  "sha512-" +
  createHash("sha512").update(readFileSync(tarball)).digest("base64");
if (registryDist && registryDist.integrity !== actualIntegrity)
  throw new Error("registry integrity does not match downloaded archive");
const result = {
  label: published ? "published artifact" : "local pre-release",
  tarballURL: registryDist?.tarball ?? "file://" + tarball,
  version: archive.version,
  sourceHead: head,
  gitHead: archive.gitHead,
  dirty: !!dirty,
  tarball,
  size: statSync(tarball).size,
  integrity: actualIntegrity,
  tests: suite.numPassedTests,
  failedTests: suite.numFailedTests,
  negativeCases: evidence.length,
  evidence,
};
writeFileSync(
  join(proof, "release-evidence.json"),
  JSON.stringify(result, null, 2) + "\n",
);
process.stdout.write(
  JSON.stringify({
    ...result,
    evidence: join(proof, "release-evidence.json"),
  }) + "\n",
);
