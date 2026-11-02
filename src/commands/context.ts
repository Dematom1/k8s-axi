import { realpathSync } from "node:fs";
import type { Parsed } from "../args.js";
import {
  lastSession,
  recordSession,
  summarizeTranscript,
  sessionText,
} from "../sessionlog.js";
import { encodeObject } from "../toon.js";
import { object, text } from "../kubectl.js";
import { fail } from "../errors.js";
function directory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
export async function contextCommand(p: Parsed): Promise<string> {
  if (p.action !== "end") {
    const last = lastSession(directory(process.cwd()));
    return encodeObject({
      last_session: last
        ? sessionText(last)
        : "no recorded session in this directory",
    });
  }
  let raw = "";
  const payload = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stdin deadline")), 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 1048576) {
        clearTimeout(timer);
        process.stdin.destroy();
        reject(new Error("payload too large"));
      }
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(raw);
    });
    process.stdin.on("error", reject);
  }).catch(() =>
    fail(
      "VALIDATION_ERROR",
      "context end requires a bounded SessionEnd payload on stdin",
    ),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    fail("VALIDATION_ERROR", "invalid SessionEnd payload");
  }
  const v = object(parsed),
    path = text(v.transcript_path);
  if (!path)
    fail("VALIDATION_ERROR", "SessionEnd payload needs transcript_path");
  try {
    const summary = await summarizeTranscript(path);
    if (!summary)
      return encodeObject({ recorded: "nothing - no k8s-axi commands" });
    if (!(await recordSession(directory(text(v.cwd, process.cwd())), summary)))
      fail("CONFIG_INVALID", "session memory is busy");
    return encodeObject({ recorded: sessionText(summary) });
  } catch {
    fail("CONFIG_INVALID", "could not read transcript or save session memory");
  }
}
