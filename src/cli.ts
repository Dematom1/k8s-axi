import { runAxiCli, AxiError, exitCodeForError } from "axi-sdk-js";
import { encodeObject } from "./toon.js";
import { VERSION } from "./version.js";
import { DESCRIPTION, TOP_HELP } from "./help.js";
import { NOUNS } from "./args.js";
import { REFUSALS } from "./registry.js";
import { dispatch, refuse, implementations } from "./commands/common.js";
import { ctxCommand } from "./commands/ctx.js";
import { namespacesCommand } from "./commands/namespaces.js";
Object.assign(implementations, {
  ctx: ctxCommand,
  namespaces: namespacesCommand,
});

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
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: encodeObject({ help: TOP_HELP }),
    commands: Object.assign(
      Object.create(null),
      Object.fromEntries(
        NOUNS.map((noun) => [noun, (args: string[]) => dispatch(noun, args)]),
      ),
      Object.fromEntries(
        REFUSALS.filter((x) => !x.includes(" ")).map((x) => [
          x,
          async () => refuse(x),
        ]),
      ),
    ),
    home: (args) => dispatch("home", args),
    formatError,
    renderUnknownCommand: (command) =>
      encodeObject({
        error: `Unknown command: ${command}`,
        code: "VALIDATION_ERROR",
        help: ["Run `k8s-axi --help`"],
      }) + "\n",
  });
}
