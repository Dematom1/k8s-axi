import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { validateResourceName } from "../args.js";
import type { Target } from "../registry.js";

export type Action =
  | {
      kind: "exec";
      target: string;
      container: string;
      command: readonly string[];
    }
  | { kind: "port-forward"; target: string; ports: readonly string[] }
  | { kind: "apply"; manifest: string }
  | { kind: "secret-values"; name: string }
  | { kind: "can-i"; resource: "pods/exec" | "pods/portforward" };

function validResourceName(value: string): boolean {
  try {
    validateResourceName(value);
    return true;
  } catch {
    return false;
  }
}

function validPortMapping(value: string): boolean {
  const ports = value.split(":");
  return (
    ports.length === 2 &&
    (ports[0] === "" ||
      (/^\d{1,5}$/.test(ports[0] ?? "") &&
        Number(ports[0]) >= 1024 &&
        Number(ports[0]) <= 65535)) &&
    /^\d{1,5}$/.test(ports[1] ?? "") &&
    Number(ports[1]) >= 1 &&
    Number(ports[1]) <= 65535
  );
}

export function argvForAction(action: Action, target: Target): string[] {
  const base = [`--context=${target.context}`];
  switch (action.kind) {
    case "exec":
      if (
        !validResourceName(action.target) ||
        !validResourceName(action.container) ||
        !action.command.length ||
        action.command.length > 64 ||
        action.command.some(
          (arg) => Buffer.byteLength(arg) > 4096 || arg.includes("\0"),
        ) ||
        !action.command[0] ||
        action.command[0].startsWith("-")
      )
        throw new Error("invalid exec action");
      return [
        "exec",
        action.target,
        "-n",
        target.defaultNamespace,
        "-c",
        action.container,
        ...base,
        "--",
        ...action.command,
      ];
    case "secret-values":
      if (!validResourceName(action.name))
        throw new Error("invalid Secret reference");
      return [
        "get",
        "secret",
        action.name,
        "-n",
        target.defaultNamespace,
        "-o",
        "json",
        ...base,
      ];
    case "port-forward":
      if (
        !validResourceName(action.target) ||
        action.ports.length !== 1 ||
        !validPortMapping(action.ports[0] ?? "")
      )
        throw new Error("invalid port-forward action");
      return [
        "port-forward",
        action.target,
        ...action.ports,
        "-n",
        target.defaultNamespace,
        ...base,
      ];
    case "can-i":
      if (action.resource !== "pods/exec" && action.resource !== "pods/portforward")
        throw new Error("invalid permission action");
      return [
        "auth",
        "can-i",
        "create",
        action.resource,
        "-n",
        target.defaultNamespace,
        ...base,
      ];
    case "apply":
      return [
        "apply",
        "--dry-run=server",
        "-n",
        target.defaultNamespace,
        "-f",
        "-",
        ...base,
      ];
    default: {
      const exhaustive: never = action;
      throw new Error(String(exhaustive));
    }
  }
}

export function assertSafeAction(
  action: Action,
  target: Target,
  argv: readonly string[],
): void {
  const expected = argvForAction(action, target);
  if (
    argv.length !== expected.length ||
    argv.some((arg, i) => arg !== expected[i])
  )
    throw new Error("unsafe kubectl action invocation");
}

export function argvSha256(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

export function requireExecuteTarget(options: {
  execute: boolean;
  context?: string;
  namespace?: string;
}): void {
  if (!options.execute) return;
  if (!options.context || !options.namespace)
    throw new AxiError(
      `--execute requires explicit ${!options.context ? "--context" : "-n"}`,
      "VALIDATION_ERROR",
      ["Add both --context <name> and -n <namespace>"],
    );
}

export function actionTarget(
  target: Target,
  namespace: string,
  object: string,
) {
  return {
    context: target.context,
    server: target.server,
    namespace,
    target: object,
  };
}
