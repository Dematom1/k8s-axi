import { runAxiCli, AxiError, exitCodeForError } from "axi-sdk-js";
import { encodeObject } from "./toon.js";
import { VERSION } from "./version.js";
import { DESCRIPTION, TOP_HELP } from "./help.js";

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
    commands: {
      update: async () => {
        throw new AxiError("self-update is not available", "REFUSED", [
          "A human can run npm install -g k8s-axi@latest",
        ]);
      },
    },
    home: async () => {
      throw new AxiError("not built yet", "REFUSED");
    },
    formatError,
    renderUnknownCommand: (command) =>
      encodeObject({
        error: `Unknown command: ${command}`,
        code: "VALIDATION_ERROR",
        help: ["Run `k8s-axi --help`"],
      }) + "\n",
  });
}
