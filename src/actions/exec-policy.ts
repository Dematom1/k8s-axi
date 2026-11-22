import { posix } from "node:path";
import { object, objects, text, type Obj } from "../kubectl.js";

export type ExecPolicy =
  { ok: true } | { ok: false; reason: string; token: string };
const DUMPERS = new Set([
  "env",
  "printenv",
  "set",
  "export",
  "declare",
  "typeset",
  "compgen",
  "envsubst",
]);
const CODE = new Set([
  "sh",
  "bash",
  "ash",
  "dash",
  "zsh",
  "ksh",
  "mksh",
  "fish",
  "perl",
  "ruby",
  "node",
  "php",
  "lua",
  "tclsh",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "sed",
  "xargs",
  "watch",
  "su",
  "sudo",
  "doas",
  "chroot",
  "nsenter",
  "strace",
  "gdb",
]);
const WRAPPERS = new Set([
  "timeout",
  "nice",
  "nohup",
  "stdbuf",
  "ionice",
  "busybox",
  "toybox",
]);

export function sensitiveMounts(podSpec: Obj, containerName: string): string[] {
  const volumes = objects(podSpec.volumes).filter(
    (v) =>
      v.secret !== undefined ||
      v.csi !== undefined ||
      objects(object(v.projected).sources).some(
        (s) => s.secret !== undefined || s.serviceAccountToken !== undefined,
      ),
  );
  const container = objects(podSpec.containers)
    .concat(objects(podSpec.initContainers))
    .find((c) => c.name === containerName);
  return objects(container?.volumeMounts)
    .filter((m) => volumes.some((v) => v.name === m.name))
    .map((m) => text(m.mountPath))
    .filter(Boolean);
}

// Only known wrapper option shapes are unwrapped; ambiguity refuses execution.
function unwrap(argv: readonly string[]): readonly string[] | undefined {
  const command = posix.basename(argv[0] ?? "");
  let i = 1;
  if (["busybox", "toybox", "nohup"].includes(command)) {
    if (argv[i] === "--") i++;
    return argv[i]?.startsWith("-") ? undefined : argv.slice(i);
  }
  while (argv[i]?.startsWith("-")) {
    const option = argv[i++] ?? "";
    if (option === "--") break;
    if (
      command === "timeout" &&
      ["--preserve-status", "--foreground", "--verbose", "-v"].includes(option)
    )
      continue;
    if (
      command === "timeout" &&
      /^(?:--(?:signal|kill-after)=.+|-[sk].+)$/.test(option)
    )
      continue;
    if (
      command === "timeout" &&
      ["-s", "--signal", "-k", "--kill-after"].includes(option)
    ) {
      i++;
      continue;
    }
    if (command === "nice" && /^-\d+$/.test(option)) continue;
    if (command === "nice" && /^--adjustment=.+$/.test(option)) continue;
    if (command === "nice" && ["-n", "--adjustment"].includes(option)) {
      i++;
      continue;
    }
    if (
      command === "stdbuf" &&
      /^(?:-[ioe].+|--(?:input|output|error)=.+)$/.test(option)
    )
      continue;
    if (
      command === "stdbuf" &&
      ["-i", "-o", "-e", "--input", "--output", "--error"].includes(option)
    ) {
      i++;
      continue;
    }
    if (command === "ionice" && ["-t", "--ignore"].includes(option)) continue;
    if (
      command === "ionice" &&
      /^(?:-[cn].+|--(?:class|classdata)=.+)$/.test(option)
    )
      continue;
    if (
      command === "ionice" &&
      ["-c", "-n", "--class", "--classdata"].includes(option)
    ) {
      i++;
      continue;
    }
    return undefined;
  }
  if (command === "timeout") {
    if (!/^\d+(?:\.\d+)?[smhd]?$/.test(argv[i] ?? "")) return undefined;
    i++;
  }
  return argv.slice(i);
}

export function execPolicy(
  argv: readonly string[],
  podSpec: Obj,
  containerName: string,
): ExecPolicy {
  const refuse = (reason: string, token: string): ExecPolicy => ({
    ok: false,
    reason,
    token,
  });
  if (
    argv.length < 1 ||
    argv.length > 64 ||
    argv.some((a) => Buffer.byteLength(a) > 4096 || a.includes("\0"))
  )
    return refuse(
      "command requires 1-64 tokens, at most 4096 bytes each, without NUL",
      "argv",
    );
  let commandArgv = argv;
  for (let depth = 0; depth < 64; depth++) {
    const command = posix.basename(commandArgv[0] ?? "");
    if (!command || command.startsWith("-"))
      return refuse("missing command", "argv");
    if (WRAPPERS.has(command)) {
      const inner = unwrap(commandArgv);
      if (!inner?.length) return refuse("unsupported wrapper options", command);
      commandArgv = inner;
      continue;
    }
    if (DUMPERS.has(command))
      return refuse("environment dumpers are not supported", command);
    if (CODE.has(command) || /^python/.test(command))
      return refuse(
        "shells, code interpreters and privilege tools are not supported",
        command,
      );
    if (
      command === "find" &&
      commandArgv.some((a) =>
        /^-(?:exec(?:dir)?|ok(?:dir)?|fprint.*|delete)$/.test(a),
      )
    )
      return refuse(
        "find execution and write predicates are not supported",
        "find",
      );
    const recursive =
      ["find", "tar", "cpio", "zip", "rsync"].includes(command) ||
      commandArgv.some((a) => a === "--recursive" || /^-[^-]*[rR]/.test(a));
    const protectedPaths = [
      "/proc",
      "/var/run/secrets",
      "/run/secrets",
      ...sensitiveMounts(podSpec, containerName),
    ].map((p) => posix.normalize(p));
    const under = (path: string, parent: string) =>
      path === parent || path.startsWith(parent.replace(/\/$/, "") + "/");
    for (const token of argv) {
      const candidate = (
        token.startsWith("--") && token.includes("=")
          ? token.slice(token.indexOf("=") + 1)
          : token
      ).replace(/^@/, "");
      if (!candidate.startsWith("/") && candidate.split("/").includes(".."))
        return refuse("relative parent paths are not supported", token);
      const path = posix.normalize(candidate);
      if (!path.startsWith("/")) continue;
      const safeProc =
        /^\/proc\/(?:meminfo|cpuinfo|loadavg|uptime|version|stat|net\/[^/]+(?:\/.*)?)$/.test(
          path,
        );
      if (
        protectedPaths.some(
          (p) =>
            (under(path, p) && !(p === "/proc" && safeProc)) ||
            (recursive && under(p, path)),
        )
      )
        return refuse(
          "sensitive path or recursive ancestor is not supported",
          token,
        );
    }
    return { ok: true };
  }
  return refuse("too many wrappers", "argv");
}
