import { COMMAND_LINES, DESCRIPTION } from "./help.js";
export const SKILL_DESCRIPTION =
  "Kubernetes diagnostics and guarded port forwarding for agents: triage pods, nodes, workloads, events, logs, and Secret metadata; preview or start bounded loopback sessions.";
export function createSkillMarkdown(): string {
  return `---
name: k8s-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
---

# k8s-axi

${DESCRIPTION}.

Run \`npx -y k8s-axi <command>\`. kubectl must be on PATH with a named kubeconfig context.
Use \`npx -y k8s-axi ctx\` to inspect local configuration without contacting a cluster.
Use \`npx -y k8s-axi triage\` for cluster checks, then \`npx -y k8s-axi pods --problems -A\` to narrow the result.
Carry \`--context <name>\` and \`-n <namespace>\` into detail commands. Lists use the configured namespace unless you pass -A. Home and triage default to all namespaces.

## Commands

${COMMAND_LINES.map((line) => "- " + line).join("\n")}

Run \`npx -y k8s-axi <command> --help\` for flags and examples.

## Safety and results

Cluster operations are fixed reads by default. Port-forward previews the target and permission without starting a session. --execute requires explicit --context and -n, echoes the target, and writes an audit record before launch. Sessions bind loopback only, expire after --ttl (15m by default, 10s–60m), and are limited to five per user. Stop them explicitly or through SessionEnd for the owner cwd and uid. Linux and macOS are supported. Guarded exec, apply preview, and diff are not enabled yet. No raw passthrough, public auth reviews, streaming output, or self-update exists.
Secrets enter this process only as metadata and key names projected by a fixed template. --full never adds fields or reveals values.
This is an output restriction, not server-side access control: Secret list permission also grants values to a direct API client.
Pods omit env, args, commands, and volumes. Object annotations are not output.
Log and event text is redacted before truncation, including with --full. Log redaction is best effort, not a guarantee for arbitrary credentials.
Exit 0 means all required reads completed, even if problems exist. Exit 1 means a read failed or health is partial or unknown. Exit 2 means usage error.
A missing namespace or context is an error, not an empty result. Partial checks never produce a healthy headline.

Hooks are optional. This skill alone is sufficient. For persistent installations, \`k8s-axi setup hooks\` installs local-only SessionStart and SessionEnd memory. Ephemeral npx installs are refused for hook setup.
`;
}
