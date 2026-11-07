import { runAxiCli, AxiError, exitCodeForError } from "axi-sdk-js";
import { encodeObject } from "./toon.js";
import { VERSION } from "./version.js";
import { DESCRIPTION, TOP_HELP } from "./help.js";
import { NOUNS, type Parsed } from "./args.js";
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
import { auditCommand } from "./commands/audit.js";
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
  audit: auditCommand,
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
export async function main(argv = process.argv.slice(2)): Promise<void> {
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
