import { runAxiCli, AxiError, exitCodeForError } from "axi-sdk-js";
import { encodeObject } from "./toon.js";
import { VERSION } from "./version.js";
import { DESCRIPTION, TOP_HELP } from "./help.js";
import { NOUNS, type Noun, type Parsed } from "./args.js";
import { usage } from "./errors.js";
import { REFUSALS } from "./registry.js";
import { dispatch, refuse } from "./commands/common.js";
import { ctxCommand } from "./commands/ctx.js";
import { namespacesCommand } from "./commands/namespaces.js";
import { nodesCommand } from "./commands/nodes.js";
import { podsCommand } from "./commands/pods.js";
import { eventsCommand } from "./commands/events.js";
import { workloadsCommand } from "./commands/workloads.js";
import { servicesCommand } from "./commands/services.js";
import { secretsCommand } from "./commands/secrets.js";
import { triageCommand } from "./commands/triage.js";
import { setupCommand } from "./commands/setup.js";
import { contextCommand } from "./commands/context.js";
const kubectlNouns = new Set<Noun>([
  "nodes",
  "namespaces",
  "pods",
  "deployments",
  "jobs",
  "pvcs",
  "services",
  "events",
  "secrets",
]);
const implementations = {
  nodes: nodesCommand,
  pods: podsCommand,
  events: eventsCommand,
  deployments: workloadsCommand,
  jobs: workloadsCommand,
  pvcs: workloadsCommand,
  services: servicesCommand,
  secrets: secretsCommand,
  setup: setupCommand,
  context: contextCommand,
  triage: triageCommand,
  home: triageCommand,
  ctx: ctxCommand,
  namespaces: namespacesCommand,
} satisfies Record<Parsed["command"], (p: Parsed) => Promise<string>>;

export function formatError(error: unknown): {
  output: string;
  exitCode: number;
} {
  return error instanceof AxiError
    ? {
        output:
          encodeObject({
            error: error.message,
            code: error.code,
            help: error.suggestions,
          }) + "\n",
        exitCode: exitCodeForError(error),
      }
    : {
        output:
          encodeObject({
            error: "unexpected failure",
            code: "UPSTREAM_ERROR",
            help: ["Run `k8s-axi --help`"],
          }) + "\n",
        exitCode: 1,
      };
}
function routeKubectlArgs(argv: string[]): string[] {
  const [verb, ...args] = argv;
  if (verb === "top") usage("top is not supported");
  if (verb === "logs") return ["pods", "logs", ...args];
  if (verb === "get" || verb === "describe") {
    const [rawNoun, ...rest] = args;
    const singular: Record<string, Noun> = {
      node: "nodes",
      ns: "namespaces",
      namespace: "namespaces",
      pod: "pods",
      deployment: "deployments",
      job: "jobs",
      pvc: "pvcs",
      service: "services",
      event: "events",
      secret: "secrets",
    };
    const noun =
      singular[rawNoun ?? ""] ??
      NOUNS.find((candidate) => candidate === rawNoun);
    if (!noun || !kubectlNouns.has(noun))
      usage(
        `unsupported resource ${JSON.stringify(rawNoun)}; use an equivalent k8s-axi noun command`,
      );
    const name = rest[0]?.startsWith("-") ? undefined : rest[0];
    const flags = name ? rest.slice(1) : rest;
    if (name && noun === "namespaces")
      usage("use the equivalent command: k8s-axi namespaces");
    if (name && !["pods", "deployments", "secrets"].includes(noun))
      usage(`use the equivalent command: k8s-axi ${noun}`);
    if (verb === "describe") {
      if (!name) usage("describe requires a resource name");
      return [noun, "view", name, ...flags];
    }
    return [noun, ...(name ? ["view", name] : []), ...flags];
  }
  if (verb === "rollout") {
    if (args[0] !== "status") return argv;
    const target = args[1];
    const match = /^(?:deployment(?:\.apps)?\/)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.exec(target ?? "");
    if (!match) usage("rollout status supports deployments only; use k8s-axi deployments view NAME");
    return ["deployments", "view", match[1]!, ...args.slice(2), "--rollout-status"];
  }
  return argv;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    argv = routeKubectlArgs(argv);
  } catch (error) {
    const result = formatError(error);
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
    return;
  }
  const homeArgs =
    argv[0]?.startsWith("-") &&
    !(
      argv.length === 1 && ["--help", "--version", "-v", "-V"].includes(argv[0])
    )
      ? argv
      : [];
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv: homeArgs.length ? [] : argv,
    topLevelHelp: encodeObject({ help: TOP_HELP }),
    commands: Object.assign(
      Object.create(null),
      Object.fromEntries(
        NOUNS.map((noun) => [
          noun,
          (args: string[]) => dispatch(noun, args, implementations[noun]),
        ]),
      ),
      Object.fromEntries(
        REFUSALS.filter((x) => !x.includes(" ")).map((x) => [
          x,
          async () => refuse(x),
        ]),
      ),
    ),
    home: () => dispatch("home", homeArgs, implementations.home),
    formatError,
    renderUnknownCommand: (command) =>
      encodeObject({
        error: `Unknown command: ${command}`,
        code: "VALIDATION_ERROR",
        help: ["Run `k8s-axi --help`"],
      }) + "\n",
  });
}
