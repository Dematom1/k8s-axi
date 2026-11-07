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
export async function dispatch(
  command: Parsed["command"],
  args: string[],
  run: (p: Parsed) => Promise<string>,
): Promise<string> {
  if (command === "ctx" && args[0] === "use") refuse("ctx use");
  const p = parseArgs(command, args);
  if (p.help)
    return encodeObject({
      command: `k8s-axi ${command}${p.action === "list" ? "" : " " + p.action}`,
      commands: COMMAND_LINES.filter(
        (line) =>
          line.startsWith(command + " ") || line.startsWith(command + ":"),
      ),
      flags:
        command === "audit"
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
                          p.action === "list"
                            ? "-n <namespace> | -A"
                            : "-n <namespace>",
                        ]),
                    ...(p.action === "list"
                      ? [
                          "--limit <1..1000> (100)",
                          ...(["home", "triage"].includes(command)
                            ? []
                            : ["--fields <a,b>", "--problems"]),
                        ]
                      : []),
                    ...(["home", "triage"].includes(command) ? [] : ["--full"]),
                    ...(["pods", "deployments", "jobs"].includes(command) &&
                    p.action === "list"
                      ? ["-l, --selector <selector>"]
                      : []),
                  ]),
              ...(command === "pods" && p.action === "logs"
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
      examples:
        command === "setup"
          ? [
              "k8s-axi setup hooks",
              "k8s-axi setup status",
              "k8s-axi setup uninstall",
            ]
          : [
              `k8s-axi ${command}${["view", "logs"].includes(p.action) ? " " + p.action + " <name>" : ""}`,
              `k8s-axi ${command} --help`,
            ],
    });
  return run(p);
}
