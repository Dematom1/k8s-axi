import { AxiError } from "axi-sdk-js";
export const CODES = [
  "VALIDATION_ERROR",
  "REFUSED",
  "CONTEXT_NOT_FOUND",
  "NO_CONTEXT",
  "NOT_FOUND",
  "FORBIDDEN",
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "SERVER_UNREACHABLE",
  "TIMEOUT",
  "RATE_LIMITED",
  "UNSUPPORTED_RESOURCE",
  "UPSTREAM_ERROR",
  "KUBECTL_NOT_INSTALLED",
  "OUTPUT_TOO_LARGE",
  "NAMESPACE_NOT_FOUND",
  "NAMESPACE_UNVERIFIED",
  "PARTIAL",
  "CONFIG_INVALID",
  "LOGS_UNAVAILABLE",
] as const;
export type ErrorCode = (typeof CODES)[number];
export function fail(
  code: ErrorCode,
  message: string,
  help = ["Run `k8s-axi --help`"],
): never {
  throw new AxiError(message, code, help);
}
export function usage(message: string, command = ""): never {
  return fail("VALIDATION_ERROR", message, [
    `Run \`k8s-axi ${command ? command + " " : ""}--help\``,
  ]);
}
