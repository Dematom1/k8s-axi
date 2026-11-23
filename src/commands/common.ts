import { encodeObject } from "../toon.js";
import { fail } from "../errors.js";
import { parseArgs, type Parsed } from "../args.js";
import { COMMAND_LINES } from "../help.js";
export function refuse(command: string): never {
  return fail(
    "REFUSED",
    `${command} is not supported: k8s-axi only runs guarded exec, port-forward, and apply previews`,
    [
      command === "update"
        ? "A human can run npm install -g k8s-axi@latest"
        : "Run `k8s-axi --help` for supported commands",
    ],
  );
}
export function preview(text: string, full: boolean, size = 120): string {
  return full || text.length <= size
    ? text
    : `${text.slice(0, size)}... (${text.length} chars total; --full)`;
}
export function carriedFlags(p: Parsed): string {
  return `${p.context ? ` --context ${JSON.stringify(p.context)}` : ""}${p.all ? " -A" : p.namespace ? ` -n ${p.namespace}` : ""}${p.selector ? ` -l ${JSON.stringify(p.selector)}` : ""}`;
}
function helpFor(command: Parsed["command"], action: string): string {
  return encodeObject({
    command: `k8s-axi ${command}${action === "list" ? "" : " " + action}`,
    commands: COMMAND_LINES.filter(
      (line) =>
        line.startsWith(command + " ") || line.startsWith(command + ":"),
    ),
    flags: ["apply", "diff"].includes(command)
      ? [
          "-f, --filename <path | -> (required; max 1 MiB, 50 objects)",
          "-n <namespace> (manifest, flag, then context default)",
          "--context <name>",
          "--timeout <seconds> (20, range 1..120)",
          "--full",
          "--help",
          "Server dry-run only; --execute, URLs, directories, -k and --recursive are not supported",
        ]
      : command === "exec"
        ? [
            "--context <name> (required with --execute)",
            "-n <namespace> (required with --execute)",
            "-c, --container <name> (annotation, then sole container)",
            "--timeout <1..300> (30)",
            "--pod-uid <uid> (preview replay identity; changed UID refuses)",
            "--full (up to 1 MiB per stream)",
            "--execute (default: preview only)",
            "-- <argv...> (required; no shell expansion)",
            "--help",
          ]
        : command === "audit"
          ? [
              "--limit <1..1000> (100)",
              "--action exec|port-forward|apply",
              "--help",
            ]
          : [
              "--context <name>",
              "--timeout <seconds> (20)",
              "--help",
              ...(["ctx", "setup", "context"].includes(command)
                ? []
                : [
                    ...(["nodes", "namespaces"].includes(command)
                      ? []
                      : [
                          action === "list"
                            ? "-n <namespace> | -A"
                            : "-n <namespace>",
                        ]),
                    ...(action === "list"
                      ? [
                          "--limit <1..1000> (100)",
                          ...(["home", "triage"].includes(command)
                            ? []
                            : ["--fields <a,b>", "--problems"]),
                        ]
                      : []),
                    ...(["home", "triage"].includes(command) ? [] : ["--full"]),
                    ...(["pods", "deployments", "jobs"].includes(command) &&
                    action === "list"
                      ? ["-l, --selector <selector>"]
                      : []),
                  ]),
              ...(command === "pods" && action === "logs"
                ? [
                    "-c, --container <name> (annotation, then sole container)",
                    "--tail <1..1000> (100)",
                    "--since <duration>",
                    "--previous",
                  ]
                : []),
              ...(command === "events"
                ? ["--warnings", "--since <duration>", "--for Kind/name"]
                : []),
            ],
    examples: ["apply", "diff"].includes(command)
      ? [
          `k8s-axi ${command} -f manifest.yaml --context <name> -n <namespace>`,
          `k8s-axi ${command} -f - --context <name> --full`,
        ]
      : command === "exec"
        ? [
            "k8s-axi exec deployment/web -n fixtures --context <name> -- ls /app",
            "k8s-axi exec pod/<name> --pod-uid <uid> -c app -n fixtures --context <name> --execute -- ls /app",
            "k8s-axi exec <pod> --timeout 3 -n fixtures --context <name> --execute -- sleep 10",
          ]
        : command === "setup"
          ? [
              "k8s-axi setup hooks",
              "k8s-axi setup status",
              "k8s-axi setup uninstall",
            ]
          : [
              `k8s-axi ${command}${["view", "logs"].includes(action) ? " " + action + " <name>" : ""}`,
              `k8s-axi ${command} --help`,
            ],
  });
}

export async function dispatch(
  command: Parsed["command"],
  args: string[],
  run: (p: Parsed) => Promise<string>,
  rolloutStatus = false,
): Promise<string> {
  if (command === "ctx" && args[0] === "use") refuse("ctx use");
  const p = { ...parseArgs(command, args), rolloutStatus };
  if (p.help) return helpFor(command, p.action);
  return run(p);
}
