---
name: k8s-axi
description: "Inspect Kubernetes clusters with k8s-axi: diagnose workloads, nodes, events, services, and Secret metadata. Cluster actions remain disabled until their guarded implementation ships."
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

Run `npx -y k8s-axi <command> --help` for flags and examples.

## Safety and results

Enabled cluster operations are fixed reads through kubectl. Guarded exec, port-forward, apply preview, and diff are not enabled yet. When available, actions will default to preview, require explicit --execute for effects, show the target, and write an audit record. No raw passthrough, auth reviews, streaming, or self-update exists.
Secrets enter this process only as metadata and key names projected by a fixed template. --full never adds fields or reveals values.
This is an output restriction, not server-side access control: Secret list permission also grants values to a direct API client.
Pods omit env, args, commands, and volumes. Object annotations are not output.
Log and event text is redacted before truncation, including with --full. Log redaction is best effort, not a guarantee for arbitrary credentials.
Exit 0 means all required reads completed, even if problems exist. Exit 1 means a read failed or health is partial or unknown. Exit 2 means usage error.
A missing namespace or context is an error, not an empty result. Partial checks never produce a healthy headline.

Hooks are optional. This skill alone is sufficient. For persistent installations, `k8s-axi setup hooks` installs local-only SessionStart and SessionEnd memory. Ephemeral npx installs are refused for hook setup.
