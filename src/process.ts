import { spawn } from "node:child_process";

export const OUTPUT_CAP = 128 * 1024 * 1024;

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exit: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  capped: boolean;
}

export async function runProcess(
  command: string,
  argv: readonly string[],
  timeout: number,
  cap = OUTPUT_CAP,
  stdin?: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, KUBERC: "off" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let capped = false;
    let terminating = false;
    let childClosed = false;
    let escalationComplete = false;
    let result: ProcessResult | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (childClosed && (!terminating || escalationComplete) && result)
        resolve(result);
    };
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process group has already exited.
        }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeout);
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      kill("SIGTERM");
      escalationTimer = setTimeout(() => {
        kill("SIGKILL");
        escalationComplete = true;
        finish();
      }, 2000);
    };
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") terminate();
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const)
      stream?.on("data", (chunk: Buffer) => {
        if (terminating) return;
        bytes += chunk.length;
        if (bytes > cap) {
          capped = true;
          terminate();
        } else chunks.push(chunk);
      });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      reject(error);
    });
    child.once("close", (exit, signal) => {
      clearTimeout(timer);
      childClosed = true;
      result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit,
        signal,
        timedOut,
        capped,
      };
      finish();
    });
  });
}
