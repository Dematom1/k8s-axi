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
const FILE_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "stat",
  "wc",
  "du",
  "df",
  "readlink",
  "realpath",
  "file",
  "od",
  "hexdump",
  "xxd",
  "cp",
  "mv",
  "rm",
  "touch",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "base64",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "cut",
  "sort",
  "uniq",
  "diff",
  "cmp",
  "find",
  "tar",
  "cpio",
  "zip",
  "rsync",
  "grep",
]);
// File tools whose options run another program. Long names also match GNU
// abbreviations, so a benign prefix such as tar --checkpoint is refused too.
const RUNS_PROGRAM: Record<string, { long: string[]; short?: RegExp }> = {
  tar: {
    long: [
      "--checkpoint-action",
      "--to-command",
      "--use-compress-program",
      "--info-script",
      "--new-volume-script",
      "--rsh-command",
      "--rmt-command",
    ],
    short: /^-[^-]*[IF]/,
  },
  cpio: { long: ["--rsh-command", "--rmt-command"] },
  sort: { long: ["--compress-program"] },
  rsync: { long: ["--rsh", "--rsync-path"], short: /^-[^-]*e/ },
  zip: { long: ["--unzip-command"], short: /^-[^-]*TT/ },
};
function runsProgram(command: string, argv: readonly string[]) {
  const rule = RUNS_PROGRAM[command];
  return argv.slice(1).find((token, i) => {
    if (!rule) return false;
    const name = token.split("=")[0] ?? "";
    if (name.length > 2 && name.startsWith("--"))
      return rule.long.some((option) => option.startsWith(name));
    // tar's old-style first argument bundles option letters without a dash.
    if (command === "tar" && i === 0 && /^[A-Za-z]+$/.test(token))
      return /[IF]/.test(token);
    return rule.short?.test(token) ?? false;
  });
}

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

const GREP_VALUE_OPTIONS = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-m",
  "--max-count",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-d",
  "--directories",
  "-D",
  "--devices",
  "--binary-files",
  "--label",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--group-separator",
]);
function grepFileOperands(
  argv: readonly string[],
):
  | { files: Map<number, string>; recursive: boolean; searchesCwd: boolean }
  | undefined {
  const files = new Map<number, string>();
  const positional: number[] = [];
  let explicitPattern = false,
    options = true,
    recursive = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (!options || token === "-" || !token.startsWith("-")) {
      positional.push(i);
      continue;
    }
    let option: string | undefined;
    let attached: string | undefined;
    if (token.startsWith("--")) {
      const equal = token.indexOf("=");
      option = equal < 0 ? token : token.slice(0, equal);
      attached = equal < 0 ? undefined : token.slice(equal + 1);
      if (["--recursive", "--dereference-recursive"].includes(option))
        recursive = true;
      if (!GREP_VALUE_OPTIONS.has(option)) continue;
    } else {
      for (let j = 1; j < token.length; j++) {
        const flag = token[j] ?? "";
        if (flag === "r" || flag === "R") recursive = true;
        if (GREP_VALUE_OPTIONS.has("-" + flag)) {
          option = "-" + flag;
          attached = token.slice(j + 1) || undefined;
          break;
        }
      }
      if (!option) continue;
    }
    const index = attached === undefined ? ++i : i;
    const value = attached ?? argv[index];
    if (value === undefined) return undefined;
    if (["-e", "--regexp", "-f", "--file"].includes(option))
      explicitPattern = true;
    if (["-f", "--file", "--exclude-from"].includes(option))
      files.set(index, value);
    if (["-d", "--directories"].includes(option) && value === "recurse")
      recursive = true;
  }
  if (!explicitPattern) positional.shift();
  for (const index of positional) files.set(index, argv[index] ?? "");
  // A recursive grep with no file operand searches its working directory.
  return { files, recursive, searchesCwd: recursive && !positional.length };
}

const safeProc = (path: string) =>
  /^\/proc\/(?:meminfo|cpuinfo|loadavg|uptime|version|stat|net\/[^/]+(?:\/.*)?)$/.test(
    path,
  );

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
    if (!command || commandArgv[0]?.startsWith("-"))
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
    const runner = runsProgram(command, commandArgv);
    if (runner !== undefined)
      return refuse(
        "options that run another program are not supported",
        runner,
      );
    const grep = command === "grep" ? grepFileOperands(commandArgv) : undefined;
    if (command === "grep" && !grep)
      return refuse("missing grep option value", "grep");
    const grepOperands = grep?.files;
    const recursiveShort = ["ls", "chmod", "chown", "chgrp"].includes(command)
      ? /^-[^-]*R/
      : command === "cp"
        ? /^-[^-]*[rRa]/
        : command === "rm"
          ? /^-[^-]*[rR]/
          : undefined;
    const endOptions = commandArgv.indexOf("--");
    const recursive =
      grep?.recursive ??
      (["find", "tar", "cpio", "zip", "rsync"].includes(command) ||
        commandArgv
          .slice(1, endOptions < 0 ? undefined : endOptions)
          .some(
            (arg) =>
              recursiveShort?.test(arg) ||
              (arg === "--recursive" &&
                ["ls", "cp", "rm", "chmod", "chown", "chgrp"].includes(
                  command,
                )) ||
              (arg === "--archive" && command === "cp"),
          ));
    const protectedPaths = [
      "/proc",
      "/var/run/secrets",
      "/run/secrets",
      ...sensitiveMounts(podSpec, containerName),
    ].map((p) => posix.normalize(p));
    const under = (path: string, parent: string) =>
      path === parent || path.startsWith(parent.replace(/\/$/, "") + "/");
    const workingDir = text(
      objects(podSpec.containers).find((c) => c.name === containerName)
        ?.workingDir,
    );
    const sensitive = (path: string) =>
      protectedPaths.some(
        (p) =>
          (under(path, p) && !(p === "/proc" && safeProc(path))) ||
          (recursive && under(p, path)),
      );
    if (grep?.searchesCwd) {
      if (!workingDir.startsWith("/"))
        return refuse(
          "recursive grep without a file operand needs container workingDir",
          "grep",
        );
      if (sensitive(posix.normalize(workingDir)))
        return refuse(
          "sensitive path or recursive ancestor is not supported",
          "grep",
        );
    }
    for (const [index, token] of commandArgv.entries()) {
      if (grepOperands && index > 0 && !grepOperands.has(index)) continue;
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(token);
      if (
        !grepOperands &&
        index > 0 &&
        !url &&
        !["echo", "printf"].includes(command)
      )
        for (const value of [
          token.includes("=") ? token.slice(token.indexOf("=") + 1) : "",
          /^-[^-]./.test(token) ? token.slice(2) : "",
        ]) {
          // Embedded values such as dd if=/x, curl -d@/x and -F f=@/x.
          const embedded = value.replace(/^@/, "");
          if (!embedded.includes("/")) continue;
          if (!embedded.startsWith("/") && embedded.split("/").includes(".."))
            return refuse("relative parent paths are not supported", token);
          if (!embedded.startsWith("/") && !workingDir.startsWith("/"))
            return refuse(
              "relative path cannot be checked without container workingDir",
              token,
            );
          if (sensitive(posix.resolve(workingDir || "/", embedded)))
            return refuse(
              "sensitive path or recursive ancestor is not supported",
              token,
            );
        }
      const raw =
        grepOperands?.get(index) ??
        (token.startsWith("--") && token.includes("=")
          ? token.slice(token.indexOf("=") + 1)
          : token);
      const candidate = command === "curl" ? raw.replace(/^@/, "") : raw;
      if (!candidate.startsWith("/") && candidate.split("/").includes(".."))
        return refuse("relative parent paths are not supported", token);
      let path = posix.normalize(candidate);
      if (!path.startsWith("/")) {
        const tarMode =
          command === "tar" && index === 1 && /^[A-Za-z]+$/.test(candidate);
        const operand =
          !tarMode &&
          (grepOperands?.has(index) || !candidate.startsWith("-")) &&
          (FILE_COMMANDS.has(command) ||
            !/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) &&
          !(index > 0 && ["echo", "printf"].includes(command)) &&
          (candidate.includes("/") ||
            (index > 0 &&
              (FILE_COMMANDS.has(command) ||
                token.startsWith("@") ||
                token.startsWith("--file="))));
        if (!operand || candidate === "-") continue;
        if (!workingDir.startsWith("/"))
          return refuse(
            "relative path cannot be checked without container workingDir",
            token,
          );
        path = posix.resolve(workingDir, candidate);
      }
      if (sensitive(path))
        return refuse(
          "sensitive path or recursive ancestor is not supported",
          token,
        );
    }
    return { ok: true };
  }
  return refuse("too many wrappers", "argv");
}
