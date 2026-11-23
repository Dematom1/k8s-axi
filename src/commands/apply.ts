import { AxiError } from "axi-sdk-js";
import type { Parsed } from "../args.js";
import { fail, usage } from "../errors.js";
import {
  deadline,
  remaining,
  type Deadline,
  type Target,
} from "../registry.js";
import { resolveTarget } from "../target.js";
import {
  kubectl,
  mapKubectlFailure,
  object,
  parseObject,
  text,
} from "../kubectl.js";
import { runProcess } from "../process.js";
import {
  argvForAction,
  assertSafeAction,
  type Action,
} from "../actions/registry.js";
import { parseManifests, readManifest } from "../actions/manifest.js";
import { structuralDiff, type Change } from "../actions/diff.js";
import { parseSecrets } from "../model/secrets.js";
import { encodeObject } from "../toon.js";
import { redactText } from "../redact.js";

export function mapApplyFailure(stderr: string): AxiError {
  const forbidden =
    /cannot (\w+) resource "([a-z0-9.-]+)" in API group "([a-z0-9.-]*)" in the namespace "([a-z0-9-]+)"/.exec(
      stderr,
    );
  if (forbidden)
    return new AxiError(
      `needs ${forbidden[1]} on ${forbidden[2]}${forbidden[3] ? "." + forbidden[3] : ""} in ${forbidden[4]}`,
      "FORBIDDEN",
      ["Use an identity allowed to dry-run this manifest"],
    );
  if (/\(Invalid\)|\bis invalid:/.test(stderr)) {
    const field =
      /\b((?:spec|metadata|data)(?:\.[a-zA-Z0-9_-]+|\[\d+\])+):\s*(Invalid value|Required value|Forbidden|Unsupported value)/.exec(
        stderr,
      );
    return new AxiError(
      field
        ? `${field[1]}: ${field[2]}`
        : "manifest rejected by server validation",
      "INVALID_MANIFEST",
    );
  }
  return mapKubectlFailure(stderr);
}

async function previewCall(
  action: Action,
  target: Target,
  d: Deadline,
): Promise<string> {
  const budget = remaining(d);
  if (!budget) fail("TIMEOUT", "overall preview deadline exceeded");
  const argv = argvForAction(action, target);
  assertSafeAction(action, target, argv);
  let result;
  try {
    result = await runProcess(
      "kubectl",
      argv,
      budget,
      undefined,
      action.kind === "apply" ? action.manifest : undefined,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      fail("KUBECTL_NOT_INSTALLED", "kubectl is not installed");
    fail("UPSTREAM_ERROR", "could not start the cluster preview");
  }
  if (result.timedOut) fail("TIMEOUT", "cluster preview timed out");
  if (result.capped)
    fail(
      "OUTPUT_TOO_LARGE",
      "cluster preview output exceeds the capture limit",
    );
  if (result.exit !== 0) throw mapApplyFailure(result.stderr);
  return result.stdout;
}

export async function applyCommand(p: Parsed): Promise<string> {
  if (!p.filename) usage("-f <path | -> is required", p.command);
  const manifests = parseManifests(await readManifest(p.filename), p.namespace);
  const d = deadline(p.timeout),
    target = await resolveTarget(p.context, d);
  const namespaces = [
    ...new Set(
      manifests.map(
        (m) => m.namespace ?? p.namespace ?? target.defaultNamespace,
      ),
    ),
  ];
  const rows: { object: string; result: string; changes: number }[] = [];
  const changes: Change[] = [];
  const failures: { object: string; code: string; reason: string }[] = [];
  for (const manifest of manifests) {
    const namespace =
      manifest.namespace ?? p.namespace ?? target.defaultNamespace;
    const t = { ...target, defaultNamespace: namespace };
    const id = `${namespace}/${manifest.kind}/${manifest.name}`;
    try {
      if (manifest.kind === "Secret") {
        const live = parseSecrets(
          await kubectl(
            {
              op: "secrets",
              scope: { kind: "namespace", name: namespace, source: "flag" },
              name: manifest.name,
            },
            t,
            d,
          ),
        )[0];
        const keys = new Set([
          ...Object.keys(object(manifest.value.data)),
          ...Object.keys(object(manifest.value.stringData)),
        ]);
        const old = new Set(live?.keys ?? []);
        const added = [...keys].filter((k) => !old.has(k)).sort();
        const removed = [...old].filter((k) => !keys.has(k)).sort();
        const unchanged = [...keys].filter((k) => old.has(k)).sort();
        const type = text(manifest.value.type, "Opaque");
        const changed =
          added.length + removed.length + Number(live?.type !== type);
        rows.push({
          object: id,
          result: `keys only: added [${added.join(",")}]; removed [${removed.join(",")}]; unchanged [${unchanged.join(",")}]; type ${redactText(live?.type ?? "(absent)").text} -> ${redactText(type).text}; values: never compared`,
          changes: changed,
        });
        continue;
      }
      const after = parseObject(
        await previewCall(
          { kind: "apply", manifest: JSON.stringify(manifest.value) },
          t,
          d,
        ),
      );
      const apiVersion = text(manifest.value.apiVersion).split("/");
      const group = apiVersion.length === 2 ? apiVersion[0] : "";
      const version = apiVersion.at(-1);
      const resource = `${manifest.kind}.${version}${group ? `.${group}` : ""}`;
      const raw = await previewCall(
        { kind: "apply-get", resource, name: manifest.name },
        t,
        d,
      );
      const before = raw.trim() ? parseObject(raw) : {};
      const diff = structuralDiff(id, before, after, p.full);
      changes.push(...diff);
      rows.push({
        object: id,
        result: !raw.trim()
          ? "create"
          : diff.length
            ? "configure"
            : "unchanged",
        changes: diff.length,
      });
    } catch (error) {
      if (!(error instanceof AxiError)) throw error;
      failures.push({ object: id, code: error.code, reason: error.message });
      rows.push({
        object: id,
        result: `${error.code}: ${error.message}`,
        changes: 0,
      });
    }
  }
  if (failures.length) process.exitCode = 1;
  const code =
    failures.length === rows.length &&
    failures.every((f) => f.code === failures[0]?.code)
      ? failures[0]?.code
      : "PARTIAL";
  return encodeObject({
    action: p.command,
    mode: "preview - server dry-run, nothing was changed",
    target: {
      context: target.context,
      server: target.server,
      namespace:
        namespaces.length === 1
          ? namespaces[0]
          : "multiple namespaces (see objects)",
    },
    ...(failures.length ? { code, failed: failures } : {}),
    objects: rows,
    changes,
    help: [
      "apply --execute is not available; apply the reviewed manifest with your deployment pipeline",
    ],
  });
}
