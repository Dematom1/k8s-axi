---
name: k8s-axi
description: "Kubernetes diagnostics, guarded exec and port forwarding, and server dry-run manifest previews for agents: triage cluster state, scrub exec output, preview changes, and manage bounded loopback sessions."
user-invocable: false
---

# k8s-axi

k8s-axi: Kubernetes diagnostics, guarded exec and port forwarding, and manifest previews for agents.

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
- context end: stop directory-owned forwarding and record command counts from stdin hook payload
- audit: show the local log of executed guarded actions
- apply -f <path | ->: server dry-run with redacted structural changes; never applies Secrets
- diff -f <path | ->: identical to apply preview; no real writes
- port-forward <target> [local:]remote: preview loopback forwarding; --execute -n <ns> --context <ctx> starts an owned session (--ttl 15m, range 10s..60m)
- port-forward list: owned forwarding sessions, at most 5 per user
- port-forward stop <id> | --all: stop owned sessions
- exec <pod|pod/name|deployment/name> -- <argv...>: guarded preview; --execute requires --context and -n

Run `npx -y k8s-axi <command> --help` for flags and examples.

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

Hooks are optional. This skill alone is sufficient. For persistent installations, `k8s-axi setup hooks` installs local-only SessionStart and SessionEnd memory. Ephemeral npx installs are refused for hook setup.
