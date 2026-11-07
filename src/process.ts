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
    if (stdin !== undefined) child.stdin?.end(stdin);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let capped = false;
    let terminating = false;
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
    const killTimer = setTimeout(() => kill("SIGKILL"), timeout + 2000);
    killTimer.unref();
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    };
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
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (exit, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit,
        signal,
        timedOut,
        capped,
      });
    });
  });
}
