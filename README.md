# k8s-axi

Strictly read-only Kubernetes diagnostics for agents. Output is TOON, including errors.

## Install

```sh
npm install -g k8s-axi
k8s-axi triage
```

For one-off reads, use `npx -y k8s-axi pods -A`.
This source is a local pre-release. Publication and trusted publishing require separate approval.

## Requirements

Node 22.12 or newer, kubectl on PATH, and a named kubeconfig context with read access.
KUBECONFIG passes through unchanged. There is no in-cluster ServiceAccount configuration in v1.
Client and server minors more than one apart produce an advisory warning on home.
The tool does not log in or prompt. Credential plugins are run by kubectl and inherit the process deadline.

## Commands

Run `k8s-axi` for an all-namespace overview or `k8s-axi <command> --help` for flags and examples.

- `triage`: seven checks covering nodes, pods, deployments, jobs, PVCs, service endpoints, and recent warnings.
- `ctx`: local context, server, namespace, client version, and context names. No network.
- `nodes`, `nodes view <node>`: readiness, pressure, version, conditions, taints, and resources.
- `namespaces`: discover namespaces.
- `pods`, `pods view <pod>`: readiness, waiting states, last termination, owner, and events.
- `pods logs <pod> [-c <container>] [--tail <n>] [--since <duration>] [--previous]`: recent logs, never follows.
- Common kubectl reads are accepted: `get <resource> [name]`, `describe <resource> <name>`, and `logs <pod>` map to these read commands. `rollout status deployment/<name>` checks bounded rollout status without watching; `top` is unsupported. Writes remain refused.
- `deployments`, `deployments view <name>`: rollout state and conditions.
- `jobs`, `pvcs`, `services`: completion, storage phase, and ready EndpointSlice counts.
- `events [--warnings] [--since 15m] [--for Pod/name]`: newest first, timestamp, occurrence count, and message.
- `secrets`, `secrets view <name>`: metadata and key names only.
- `setup hooks`, `setup status`, `setup uninstall`: opt-in local agent integration.
- `context`, `context end`: directory-scoped session summary.
- `audit [--limit <n>] [--action exec|port-forward|apply]`: newest local guarded-action records; no network access.

Global flags: `--context <name>`, `--timeout <seconds>` (default 20, range 1 to 120), `--help`, and `--version` (`-v`, `-V`).
Namespaced lists default to the kubeconfig namespace, falling back to `default`. Home and triage default to all namespaces.
Use `-A` for all namespaces or `-n <namespace>` for one. They cannot be combined. A namespace named `all` is not an alias for `-A`.
Lists accept `--limit` (default 100, maximum 1000), `--fields <a,b>`, and `--problems`.
Pods, deployments, and jobs also accept `-l <selector>`. The default list schema has at most four columns.
`--full` only untruncates allowlisted text. It never adds object fields and changes nothing for Secrets.
Log defaults are 100 lines, at most 1000 lines, and at most 1 MiB from the server.

## Errors and exits

All errors have `error`, `code`, and actionable `help` on stdout. Raw subprocess stderr is suppressed.
Exit 0 means required reads completed, including an unhealthy cluster. Exit 1 means a failed or partial read. Exit 2 means usage error.
A failed check cannot produce a healthy headline. Partial triage includes completed rows, `complete: false`, and `code: PARTIAL`.
A missing context or namespace is an error. An empty namespace that cannot be verified is not a definitive empty result.

| Code                  | Meaning                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| VALIDATION_ERROR      | Invalid arguments or selector. Exit 2.                                      |
| REFUSED               | Write, raw passthrough, streaming, or self-update refused.                  |
| CONTEXT_NOT_FOUND     | Requested context is not configured.                                        |
| NO_CONTEXT            | No named current context.                                                   |
| NOT_FOUND             | Requested object does not exist.                                            |
| FORBIDDEN             | Cluster denied the read.                                                    |
| AUTH_REQUIRED         | Credentials required or credential helper failed.                           |
| AUTH_EXPIRED          | Credentials expired.                                                        |
| SERVER_UNREACHABLE    | Network or TLS failure.                                                     |
| TIMEOUT               | Per-call or overall deadline expired.                                       |
| RATE_LIMITED          | Cluster throttled the read.                                                 |
| UNSUPPORTED_RESOURCE  | Cluster has no such resource type.                                          |
| UPSTREAM_ERROR        | Invalid response or unclassified read failure.                              |
| KUBECTL_NOT_INSTALLED | Install kubectl on PATH.                                                    |
| OUTPUT_TOO_LARGE      | Combined subprocess output exceeds 128 MiB. Narrow the scope.               |
| NAMESPACE_NOT_FOUND   | Namespace does not exist.                                                   |
| NAMESPACE_UNVERIFIED  | Namespace lookup forbidden and result empty.                                |
| PARTIAL               | One or more triage checks failed.                                           |
| CONFIG_INVALID        | Local configuration or integration could not be read, written, or verified. |
| SECRET_EXPOSURE       | Action input could expose Secret material.                                  |
| SCRUB_UNAVAILABLE     | Secret values could not be loaded for safe output scrubbing.                |
| REMOTE_EXIT_NONZERO   | The remote command returned a nonzero exit status.                          |
| AUDIT_UNAVAILABLE     | The action audit log could not be written or read.                          |
| AUDIT_INCOMPLETE      | The action ran, but its completion record could not be written.             |
| SESSION_LIMIT         | The maximum number of owned port-forward sessions is running.               |
| SESSION_NOT_FOUND     | The requested owned session does not exist.                                 |
| PORT_IN_USE           | The requested local port is already in use.                                 |
| SECRET_MANIFEST       | A Secret manifest contains values instead of redacted placeholders.         |
| INVALID_MANIFEST      | The manifest is invalid or unsupported.                                     |

## Safety model

Cluster access is read-only by default. The shared safety foundation for guarded `exec`, `port-forward`, apply preview, and diff is in place; those action commands are not enabled until their implementation lanes ship. When enabled, execution will require an explicit `--execute`, echo the target context, namespace, and target, and be recorded in a local audit log. `k8s-axi audit` reads that log without contacting the cluster. There is no arbitrary kubectl argument path, attach, proxy, raw output, auth review, or self-update.
Every network call pins the resolved context. Namespace preflight distinguishes a missing namespace from an empty list.
Subprocesses have closed stdin, a shared overall deadline, per-call timeouts, process-group cleanup, and a 128 MiB combined output cap. The audit log is stored at `${XDG_STATE_HOME:-$HOME/.local/state}/k8s-axi/audit.jsonl`, with private directory and file permissions.
KUBERC is disabled so user defaults cannot silently rewrite a read. kubectl can write its own discovery cache, but k8s-axi never modifies kubeconfig or cluster resources.

Secrets are read only through a fixed go-template. Only namespace, name, type, creation time, and key names reach this process. Secret data, stringData, annotations, and labels do not.
This is an output guarantee, not access control: API permission to list Secrets also permits values through other clients.
Pods omit env, args, command, volumes, and all annotations. The default-container annotation is used internally for log selection only.
Free text is redacted before truncation, including `--full`. Log redaction is **best effort**. Unknown credential formats can remain in arbitrary log text.

## Agent integration

Either integration path is sufficient. Neither is installed automatically.

- **Skill:** use `skills/k8s-axi/SKILL.md` in your agent's skills directory. Examples use `npx -y k8s-axi`.
- **Hooks:** after a persistent install, run `k8s-axi setup hooks`. Claude Code and Codex get SessionStart context. OpenCode gets a managed ambient plugin. Claude Code SessionEnd records command names, counts, and the most-used context, not command arguments or output.

The dedicated `k8s-axi-ctx` hook is local only and does not make a health claim. Setup refuses ephemeral npx installations.
`setup status` reopens destinations. `setup uninstall` removes SessionStart and SessionEnd hooks and the managed plugin, preserving unrelated settings and the shared Codex feature flag. When `CLAUDE_CONFIG_DIR` is set, k8s-axi's SessionEnd hook and its setup status/install/uninstall use that directory; setup creates a missing directory with mode `0700` and `settings.json` with mode `0600`. The SDK-managed SessionStart hook also updates `~/.claude/settings.json`. In `~/.claude/settings.json` and `~/.codex/hooks.json`, axi-sdk-js treats any `SessionStart` hook command (including legacy `session_start` entries) containing `k8s-axi` as managed, so `setup uninstall` may also remove an unrelated hook whose command contains that text. This substring rule does not apply to k8s-axi's own SessionEnd handling or its custom `CLAUDE_CONFIG_DIR` SessionStart handling, which use narrower command matching.
Session memory is stored under `$XDG_CONFIG_HOME/k8s-axi`, or `~/.config/k8s-axi`. Version cache is stored under `$XDG_CACHE_HOME/k8s-axi`, or `~/.cache/k8s-axi`.

## Server-side read-only RBAC

An operator can provision a dedicated identity using this ClusterRole. Do not apply it through k8s-axi.
The built-in `view` role excludes Secrets. Grant Secret inventory only when the identity is allowed to read their values at the API boundary.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: k8s-axi-reader
rules:
  - apiGroups: [""]
    resources:
      [
        nodes,
        namespaces,
        pods,
        services,
        persistentvolumeclaims,
        events,
        secrets,
      ]
    verbs: [get, list]
  - apiGroups: [""]
    resources: [pods/log]
    verbs: [get]
  - apiGroups: [apps]
    resources: [deployments]
    verbs: [get, list]
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [get, list]
  - apiGroups: [discovery.k8s.io]
    resources: [endpointslices]
    verbs: [get, list]
```

## Development

```sh
npm ci
npm run check
npm run test:real
npm run test:live
sh scripts/lab-live.sh
sh scripts/real-kubectl.sh
npm run build:skill
```

Tests use a fake kubectl and a loopback API server. The real kubectl lane requires no cluster credentials.
`scripts/live-readonly.mjs` is manual only and requires an explicit context and a temporary working directory.

## Releases

`npm run check` includes generated skill drift. Pack and verify with `node scripts/verify-package.mjs`.
Release workflows stage an exact stamped tarball. A human approval and registry-artifact verification are separate gates.
No repository, remote, registry publication, or trusted publisher is created by this local build.
Selected scaffolding, session-memory, and TOON helpers follow argocd-axi (MIT). See LICENSE.
