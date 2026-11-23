---
name: k8s-axi
description: "Kubernetes diagnostics and server dry-run manifest previews for agents: triage pods, nodes, workloads, events, logs, and Secret metadata without changing the cluster; redaction is best effort."
user-invocable: false
---

# k8s-axi

k8s-axi: Kubernetes diagnostics and guarded-action foundations for agents.

Run `npx -y k8s-axi <command>`. kubectl must be on PATH with a named kubeconfig context.
Use `npx -y k8s-axi ctx` to inspect local configuration without contacting a cluster.
Use `npx -y k8s-axi triage` for cluster checks, then `npx -y k8s-axi pods --problems -A` to narrow the result.
Carry `--context <name>` and `-n <namespace>` into detail commands. Lists use the configured namespace unless you pass -A. Home and triage default to all namespaces.

## Commands

- triage: cluster checks and problems, all namespaces by default
- ctx: context, server, namespace and client version, local only
- nodes: node readiness, pressure, scheduling and version
- nodes view <node>: conditions, taints, resources and recent events
- namespaces: discover namespaces
- namespaces view <name>: namespace phase and conditions
- pods: pod readiness, status and restarts
- pods view <pod>: containers, last termination, owner and recent events
- pods logs <pod>: bounded logs, redaction is best effort
- deployments: rollout readiness and conditions
- deployments view <name>: rollout conditions and recent events
- jobs: completion, failure and suspension
- jobs view <name>: completion counts, conditions and recent events
- pvcs: claim phase and capacity
- pvcs view <name>: claim capacity, volume, conditions and recent events
- services: ready EndpointSlice counts
- services view <name>: ready endpoints, addresses and recent events
- events: newest first, absolute time, count and message
- events view <name>: event object, count and message
- secrets: metadata and key counts only
- secrets view <name>: metadata and key names, never values
- setup hooks: opt-in local agent integrations
- setup status: inspect integrations without writes
- setup uninstall: remove managed hooks, preserve unrelated config
- context: last session summary for this directory
- context end: record command counts and most-used context from stdin hook payload
- audit: show the local log of executed guarded actions
- apply -f <path | ->: server dry-run with redacted structural changes; never applies Secrets
- diff -f <path | ->: identical to apply preview; no real writes

Run `npx -y k8s-axi <command> --help` for flags and examples.

## Safety and results

Enabled cluster operations are fixed reads and apply/diff server dry-run previews through kubectl. Use `npx -y k8s-axi apply -f <path> --context <name>` or diff with the same flags. No real apply --execute, exec, port-forward, raw passthrough, auth reviews, streaming, or self-update exists.
Apply/diff accept up to 1 MiB and 50 YAML/JSON objects, including List. Secret manifests with non-placeholder values are refused before any cluster call. Use the literal "<redacted>" for every data/stringData value to compare only keys and type; Secrets are never submitted to the server. Previews require real create/patch/get permissions and do not write audit records.
Cluster Secrets enter this process only as metadata and key names projected by a fixed template. --full never reveals Secret values. Apply/diff redact credential env literals and known text patterns, remove server-only fields and last-applied annotations, and truncate string changes to 120 characters unless --full. Non-Secret live field values may appear after pattern-based redaction; credentials in fields whose names do not look sensitive (such as an env var named `LICENSE`) can remain visible. Store credentials in Secrets.
This is an output restriction, not server-side access control: Secret list permission also grants values to a direct API client.
Diagnostic pod views omit env, args, commands, volumes, and object annotations. Apply/diff may show non-sensitive fields in structural changes.
Log and event text is redacted before truncation, including with --full. Log redaction is best effort, not a guarantee for arbitrary credentials.
Exit 0 means all required reads completed, even if problems exist. Exit 1 means a read failed or health is partial or unknown. Exit 2 means usage error.
A missing namespace or context is an error, not an empty result. Partial checks never produce a healthy headline.

Hooks are optional. This skill alone is sufficient. For persistent installations, `k8s-axi setup hooks` installs local-only SessionStart and SessionEnd memory. Ephemeral npx installs are refused for hook setup.
