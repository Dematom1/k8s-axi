import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";

const path = () =>
  join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isManagedEntry(entry: unknown): boolean {
  if (!isRecord(entry) || typeof entry.command !== "string") return false;
  return (
    entry.command === "k8s-axi context end" ||
    entry.command.endsWith("/k8s-axi context end") ||
    /[\\/]k8s-axi\.js' context end$/.test(entry.command)
  );
}

function settings(): Record<string, unknown> {
  const file = path();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw new AxiError(
      `Cannot read Claude settings ${file}: ${String(error)}`,
      "CONFIG_INVALID",
      [`Check read permissions and JSON syntax for ${file}`],
    );
  }
  if (!isRecord(value))
    throw new AxiError(`${file} is not a JSON object`, "CONFIG_INVALID", [
      `Fix the JSON object in ${file}`,
    ]);
  return value;
}

export function writeClaudeSettings(value: Record<string, unknown>): void {
  const file = path();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    if (
      existsSync(file) &&
      readFileSync(file, "utf8") === `${JSON.stringify(value, null, 2)}\n`
    )
      return;
    mkdirSync(join(file, ".."), { recursive: true });
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* No temporary file to remove. */
    }
    throw new AxiError(
      `Cannot update Claude settings ${file}: ${String(error)}`,
      "UPSTREAM_ERROR",
      [`Check write permissions for ${file} and its parent directory`],
    );
  }
}

export function installSessionEndHook(entrypoint: string): void {
  const value = settings();
  const hooks = isRecord(value.hooks) ? value.hooks : {};
  value.hooks = hooks;
  const groups = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
  const next: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      next.push(group);
      continue;
    }
    const kept = group.hooks.filter((entry) => !isManagedEntry(entry));
    if (kept.length) next.push({ ...group, hooks: kept });
  }
  next.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `'${process.execPath.replaceAll("'", "'\\''")}' '${entrypoint.replaceAll("'", "'\\''")}' context end`,
        timeout: 30,
      },
    ],
  });
  hooks.SessionEnd = next;
  writeClaudeSettings(value);
}

export function sessionEndHookStatus(): boolean {
  const hooks = settings().hooks;
  const groups = isRecord(hooks) ? hooks.SessionEnd : undefined;
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        isRecord(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some(isManagedEntry),
    )
  );
}

export function uninstallSessionEndHook(): boolean {
  const value = settings();
  const hooks = value.hooks;
  if (!isRecord(hooks) || !Array.isArray(hooks.SessionEnd)) return false;
  let removed = false;
  const next = hooks.SessionEnd.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
    const entries = group.hooks.filter((entry) => {
      const ours = isManagedEntry(entry);
      removed ||= ours;
      return !ours;
    });
    return entries.length ? [{ ...group, hooks: entries }] : [];
  });
  if (!removed) return false;
  if (next.length) hooks.SessionEnd = next;
  else delete hooks.SessionEnd;
  if (Object.keys(hooks).length === 0) delete value.hooks;
  writeClaudeSettings(value);
  if (sessionEndHookStatus())
    throw new AxiError(
      `SessionEnd hook remains in ${path()}`,
      "UPSTREAM_ERROR",
      ["Re-run `k8s-axi setup uninstall` after checking the settings file"],
    );
  return true;
}
