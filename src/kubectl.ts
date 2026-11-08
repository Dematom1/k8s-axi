import { spawn } from "node:child_process";
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
export const OUTPUT_CAP = 128 * 1024 * 1024;
export function mapKubectlFailure(
  stderr: string,
  operation?: Read["op"],
): AxiError {
  if (
    operation === "logs" &&
    /unable to retrieve container logs for|failed to get container logs?|previous terminated container.*not found|previous.*not available/i.test(
      stderr,
    )
  )
    return new AxiError("container logs are unavailable", "LOGS_UNAVAILABLE", [
      "Run `k8s-axi pods view <pod>` or check events for the pod",
    ]);
  const cases: [RegExp, ErrorCode, string][] = [
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
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", argv, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, KUBERC: "off" },
    });
    let done = false,
      bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Already exited. */
        }
    };
    const finish = (error?: AxiError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const terminate = (error: AxiError) => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000);
      finish(error);
    };
    const timer = setTimeout(
      () =>
        terminate(
          new AxiError("the cluster read timed out", "TIMEOUT", [
            "Retry with --timeout <seconds>",
          ]),
        ),
      budget,
    );
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const)
      stream.on("data", (b: Buffer) => {
        if (done) return;
        bytes += b.length;
        if (bytes > cap)
          terminate(
            new AxiError(
              "read output exceeds 128 MiB; narrow the namespace or selector",
              "OUTPUT_TOO_LARGE",
            ),
          );
        else chunks.push(b);
      });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        new AxiError(
          error.code === "ENOENT"
            ? "kubectl is not installed"
            : "could not start the cluster reader",
          error.code === "ENOENT" ? "KUBECTL_NOT_INSTALLED" : "UPSTREAM_ERROR",
          ["Install kubectl, then run `k8s-axi ctx`"],
        ),
      ),
    );
    child.on("close", (code) => {
      if (done) return;
      finish(
        code === 0
          ? undefined
          : mapKubectlFailure(
              redactText(Buffer.concat(stderr).toString("utf8")).text,
              read.op,
            ),
      );
    });
  });
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
