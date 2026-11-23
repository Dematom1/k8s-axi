import { COMMAND_LINES, DESCRIPTION } from "./help.js";
export const SKILL_DESCRIPTION =
  "Kubernetes diagnostics, guarded exec and port forwarding, and server dry-run manifest previews for agents: triage cluster state, scrub exec output, preview changes, and manage bounded loopback sessions.";
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

Cluster reads are fixed by default. Exec previews resolve the target and check permission and output scrubbing without running the remote command. Generated replay commands pin pod/<name> and --pod-uid; a different UID returns TARGET_CHANGED. Direct invocations without --pod-uid inspect a fresh target. --execute requires explicit --context and -n, echoes the resolved pod and container, and writes an audit start record before running. Port-forward previews the target and permission; --execute requires explicit --context and -n, writes an audit record before launch, binds loopback, and expires after --ttl (15m by default, 10s–60m). Sessions are limited to five per user and can be stopped explicitly or through SessionEnd for the owner cwd and uid. Linux and macOS are supported. Apply/diff server dry-run previews are enabled. No real apply --execute, raw passthrough, interactive sessions, streaming output, or self-update exists.
Apply/diff accept up to 1 MiB and 50 YAML/JSON objects, including typed List wrappers such as SecretList. Secret manifests with non-placeholder values are refused before any cluster call. Use the literal "<redacted>" for every data/stringData value to compare only keys and type; Secrets are never submitted to the server. Previews require real create/patch/get permissions; Secret manifests also require list on secrets. Previews do not write audit records.
Apply/diff redact credential-named fields, credential env literals, adjacent credential flag arguments, and known text patterns, remove server-only fields and last-applied annotations, and truncate string changes to 120 characters unless --full. Non-Secret live field values may appear after pattern-based redaction; credentials in fields whose names do not look sensitive (such as an env var named LICENSE) can remain visible. Store credentials in Secrets.
Secret inventory and apply/diff Secret comparisons use a key-names-only template; --full never reveals their Secret values. Exec alone reads the selected container's referenced Secret values into memory to scrub raw and encoded output and audited argv. Missing get secrets permission refuses execution with SCRUB_UNAVAILABLE. Raw values shorter than four characters are not scrubbed; encoded forms need eight characters. --full removes the character preview limit without disabling guards.
Exec input guards refuse environment dumpers, shells, interpreters, sensitive paths, and recursive ancestors. Relative file operands require an explicit container workingDir so they can be checked. These guards are not a sandbox: arbitrary image binaries can change container state or transform credentials in unknown ways. Use trusted images and restricted RBAC. A local timeout may leave the remote command running. Timeout and capture-limit output is withheld because partial Secret values cannot be scrubbed. Output is bounded to 1 MiB per stream after redaction too; streams expanded past that bound are withheld. The newest 8000 characters are shown unless --full is set. Exec --timeout defaults to 30 seconds, maximum 300.
An unavailable audit start record prevents execution. AUDIT_INCOMPLETE means the audit end record is missing: do not retry an action that ran or may have run. Exec reports a known preflight failure, kubectl launch failure, or API exec denial separately when the remote command did not start.
This is an output restriction, not server-side access control: Secret list permission also grants values to a direct API client.
Diagnostic pod views omit env, args, commands, volumes, and object annotations. Apply/diff may show non-sensitive fields in structural changes.
Log and event text is redacted before truncation, including with --full. Log redaction is best effort, not a guarantee for arbitrary credentials.
Exit 0 means required reads completed or exec succeeded, even if health problems exist. Exit 1 means a failed or refused operation, nonzero remote exit, or partial or unknown health. Exit 2 means usage error.
A missing namespace or context is an error, not an empty result. Partial checks never produce a healthy headline.

Hooks are optional. This skill alone is sufficient. For persistent installations, \`k8s-axi setup hooks\` installs local-only SessionStart and SessionEnd memory. Ephemeral npx installs are refused for hook setup.
`;
}
