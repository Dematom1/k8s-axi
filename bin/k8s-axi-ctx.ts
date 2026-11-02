#!/usr/bin/env node
import { ctxCommand } from "../src/commands/ctx.js";
import { parseArgs } from "../src/args.js";
import { formatError } from "../src/cli.js";
try {
  process.stdout.write((await ctxCommand(parseArgs("ctx", []))) + "\n");
} catch (error) {
  process.stdout.write(formatError(error).output);
  process.exitCode = 0;
}
