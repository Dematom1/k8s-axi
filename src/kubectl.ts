import { AxiError } from "axi-sdk-js";
import { fail, type ErrorCode } from "./errors.js";
import {
  argvFor,
  assertSafe,
  remaining,
  type Read,
  type Target,
  type Deadline,
} from "./registry.js";
import { redactText } from "./redact.js";
import { OUTPUT_CAP, runProcess } from "./process.js";
export { OUTPUT_CAP } from "./process.js";
export function mapKubectlFailure(stderr: string): AxiError {
  const cases: [RegExp, ErrorCode, string][] = [
    [
      /unable to retrieve container logs for/i,
      "LOGS_UNAVAILABLE",
      "container logs are unavailable",
    ],
    [
      /previous terminated container.*not found|previous.*not available/i,
      "NOT_FOUND",
      "no previous terminated container logs are available",
    ],
    [
      /context.*(?:was not found|not found)/i,
      "CONTEXT_NOT_FOUND",
      "configured context not found",
    ],
    [
      /current-context (?:is not set|must exist)/i,
      "NO_CONTEXT",
      "no current context is configured",
    ],
    [/\(NotFound\)/i, "NOT_FOUND", "resource not found in the cluster"],
    [/\(Forbidden\)|forbidden:/i, "FORBIDDEN", "read forbidden by the cluster"],
    [/expired/i, "AUTH_EXPIRED", "cluster credentials expired"],
    [
      /Unauthorized|must be logged in|getting credentials|exec plugin/i,
      "AUTH_REQUIRED",
      "cluster credentials required",
    ],
    [
      /context deadline exceeded|Client.Timeout|Timeout exceeded/i,
      "TIMEOUT",
      "cluster read timed out",
    ],
    [
      /connection refused|no such host|dial tcp|i\/o timeout|x509|TLS handshake/i,
      "SERVER_UNREACHABLE",
      "the cluster is unreachable",
    ],
    [
      /TooManyRequests|\b429\b/i,
      "RATE_LIMITED",
      "the cluster rate limited this read",
    ],
    [
      /the server doesn't have a resource type/i,
      "UNSUPPORTED_RESOURCE",
      "resource is not supported by the cluster",
    ],
    [/unable to parse requirement/i, "VALIDATION_ERROR", "invalid selector"],
  ];
  const found = cases.find(([re]) => re.test(stderr));
  // Raw stderr is untrusted and can contain credentials or Secret values. Classify only.
  return new AxiError(
    found?.[2] ?? "the cluster read failed",
    found?.[1] ?? "UPSTREAM_ERROR",
    [
      found?.[1] === "CONTEXT_NOT_FOUND"
        ? "Run `k8s-axi ctx`"
        : found?.[1] === "LOGS_UNAVAILABLE"
          ? "Run `k8s-axi pods view <pod>` or check events for the pod"
          : "Run `k8s-axi --help` or retry with a narrower namespace",
    ],
  );
}
export async function kubectl(
  read: Read,
  target: Target | undefined,
  d: Deadline,
  cap = OUTPUT_CAP,
): Promise<string> {
  const budget = remaining(d);
  if (budget <= 0) fail("TIMEOUT", "overall read deadline exceeded");
  const argv = argvFor(read, target, d);
  assertSafe(argv);
  let result;
  try {
    result = await runProcess("kubectl", argv, budget, cap);
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    throw new AxiError(
      code === "ENOENT"
        ? "kubectl is not installed"
        : "could not start the cluster reader",
      code === "ENOENT" ? "KUBECTL_NOT_INSTALLED" : "UPSTREAM_ERROR",
      ["Install kubectl, then run `k8s-axi ctx`"],
    );
  }
  if (result.timedOut)
    throw new AxiError("the cluster read timed out", "TIMEOUT", [
      "Retry with --timeout <seconds>",
    ]);
  if (result.capped)
    throw new AxiError(
      "read output exceeds 128 MiB; narrow the namespace or selector",
      "OUTPUT_TOO_LARGE",
    );
  if (result.exit !== 0)
    throw mapKubectlFailure(redactText(result.stderr).text);
  return result.stdout;
}
export type Obj = Record<string, unknown>;
export function object(value: unknown): Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : {};
}
export function objects(value: unknown): Obj[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
export function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function parseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fail("UPSTREAM_ERROR", "invalid response from the cluster");
  }
}
export function parseObject(raw: string): Obj {
  const v = parseJSON(raw);
  if (
    typeof v !== "object" ||
    v === null ||
    Array.isArray(v) ||
    object(v).kind === "Secret"
  )
    fail("UPSTREAM_ERROR", "unexpected object response from the cluster");
  return object(v);
}
export function parseList(raw: string): Obj[] {
  const v = parseObject(raw);
  if (
    !Array.isArray(v.items) ||
    v.items.some(
      (x) =>
        typeof x !== "object" ||
        x === null ||
        Array.isArray(x) ||
        object(x).kind === "Secret" ||
        !text(object(object(x).metadata).name),
    )
  )
    fail("UPSTREAM_ERROR", "invalid resource list from the cluster");
  return objects(v.items);
}
export async function readList(
  read: Extract<Read, { op: "list" }>,
  target: Target,
  d: Deadline,
): Promise<Obj[]> {
  return parseList(await kubectl(read, target, d));
}
