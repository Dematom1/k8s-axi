# k8s-axi

Kubernetes diagnostics, guarded exec, server dry-run manifest previews, and bounded, opt-in port forwarding for agents. Output is TOON, including errors.

## Install

```sh
npx skills add Dematom1/k8s-axi --skill k8s-axi -g
```

This installs the skill for Claude Code, Codex, Cursor, OpenCode, and other skills-aware agents. The skill runs `npx -y k8s-axi`, so no global k8s-axi install is needed. Diagnosis still needs kubectl and a named kubeconfig context (see [Requirements](#requirements)).

Zero setup: tell your agent "Execute `npx -y k8s-axi` to diagnose Kubernetes pods, nodes, workloads, events, and logs read-only."

### Optional

A global install enables `k8s-axi setup hooks` (see [Agent integration](#agent-integration)):

```sh
npm install -g k8s-axi
k8s-axi triage
```

## Dematom1 platform AXIs

| tool                   | skill install                                                              |
| ---------------------- | -------------------------------------------------------------------------- |
| terraform-axi          | `npx skills add Dematom1/terraform-axi --skill terraform-axi -g`           |
| k8s-axi                | `npx skills add Dematom1/k8s-axi --skill k8s-axi -g`                       |
| argocd-axi             | `npx skills add Dematom1/argocd-axi --skill argocd-axi -g`                 |
| argo-workflows-axi     | `npx skills add Dematom1/argo-workflows-axi --skill argo-workflows-axi -g` |
| datadog-axi (optional) | `npx skills add Dematom1/datadog-axi --skill datadog-axi -g`               |

## Requirements

Node 22.12 or newer, kubectl on PATH, and a named kubeconfig context with read access.
KUBECONFIG passes through unchanged. There is no in-cluster ServiceAccount configuration in v1.
Client and server minors more than one apart produce an advisory warning on home.
The tool does not log in or prompt. Credential plugins are run by kubectl and inherit the process deadline.
Exec additionally needs `create pods/exec` and `get secrets` for the selected container's referenced Secrets. Deployment targets need deployment reads and pod/ReplicaSet listing.

## Commands

Run `k8s-axi` for an all-namespace overview or `k8s-axi <command> --help` for flags and examples.

- `triage`: seven checks covering nodes, pods, deployments, jobs, PVCs, service endpoints, and recent warnings.
- `ctx`: local context, server, namespace, client version, and context names. No network.
- `nodes`, `nodes view <node>`: readiness, pressure, version, conditions, taints, and resources.
- `namespaces`, `namespaces view <name>`: discover namespaces; inspect phase and conditions.
- `pods`, `pods view <pod>`: readiness, waiting states, last termination, owner, and events.
- `pods logs <pod> [-c <container>] [--tail <n>] [--since <duration>] [--previous]`: fetches up to 1 MiB and returns the newest whole lines (default 100, maximum 1000), redacted best-effort. It requests one extra line (up to 1001) to detect omitted logs, then returns at most the requested tail; `--full` lifts only the character preview. Output includes the shown endpoints, whether more lines are available, and an omitted-line count when known. Truncated output includes a continuation hint. Unavailable container logs return `LOGS_UNAVAILABLE` (exit 1) with a hint to inspect the pod or its events.
- Common kubectl reads are accepted: `get <resource> [name]`, `describe <resource> <name>`, and `logs <pod>` map to these read commands. `rollout status deployment/<name>` checks bounded rollout status without watching; `top` is unsupported. Writes remain refused.
- `deployments`, `deployments view <name>`: rollout state and conditions.
- `jobs`, `pvcs`, `services`: completion, storage phase, and ready EndpointSlice counts. Each supports `view <name>` and named `get` reads.
- `events [--warnings] [--since 15m] [--for Pod/name]`, `events view <name>`: newest first, timestamp, occurrence count, and message.
- `secrets`, `secrets view <name>`: metadata and key names only.
- `setup hooks`, `setup status`, `setup uninstall`: opt-in local agent integration.
- `context`, `context end`: directory-scoped session summary.
- `audit [--limit <n>] [--action exec|port-forward|apply]`: newest local guarded-action records; no network access.
- `port-forward <pod|pod/name|service/name|deployment/name> [local:]remote`: previews one loopback-only forwarding session. `--execute` requires explicit `--context` and `-n`. The local port defaults to random; explicit local ports must be 1024–65535. `--ttl` defaults to 15m, with a range of 10s–60m. Deployments resolve to the newest Ready pod. Services resolve their TCP port to the selected pod's target port.
- `port-forward list`, `port-forward stop <id>`, `port-forward stop --all`: manage up to five sessions per user. These commands make no cluster calls. `--address` is refused. Linux and macOS are supported.
- `exec <pod|deployment/name> [-c <container>] -n <namespace> --context <name> [--timeout <1..300>] [--full] [--execute] -- <argv...>`: preview by default. Execution requires explicit context and namespace. Deployment targets resolve to the newest Ready pod owned through the Deployment's ReplicaSet UID chain. Container selection uses the default-container annotation, then the sole container, otherwise requires `-c`. There is no shell expansion or interactive stdin/TTY. The default local timeout is 30 seconds. Output is capped at 1 MiB per stream before and after redaction; oversized redacted streams are withheld. The newest 8000 characters are shown unless `--full` is set. A timed-out command may keep running in the container; timeout and capture-limit output is withheld because partial Secret values cannot be scrubbed.

- `apply -f <path | -> [--context <name>] [-n <namespace>] [--full]`, `diff` with the same flags: identical server dry-run previews with per-object create/configure/unchanged outcomes and structural path changes. Requires real create/patch/get permissions; Secret manifests also require `list` on secrets. No `--execute`, URLs, directories, `-k`, or `--recursive`.

Apply/diff read YAML multi-document or JSON input, flatten `kind: List` and typed List wrappers such as `SecretList`, and accept at most 1 MiB and 50 objects. Each object needs `apiVersion`, `kind`, and `metadata.name`. Namespace comes from the manifest, then `-n`, then the context default; conflicting manifest and flag namespaces are rejected. kubectl receives one JSON object at a time through stdin, never the user's path.
Any Secret `data` or `stringData` value other than the literal `"<redacted>"` refuses the entire preview before any kubectl call. Placeholder Secrets compare only key sets and type through the existing key-only projection; values are never read or compared, and Secret documents are never sent to apply. Manage values with the Secret tool or your deployment pipeline.
Diffs omit status, server-managed metadata, and last-applied annotations. Values under credential-named fields, credential-named env literals, adjacent credential flag arguments, and recognized text patterns are redacted before truncation to 120 characters per string; `--full` lifts truncation, not redaction. Non-Secret live field values may appear in output after pattern-based redaction; credentials in fields whose names do not look sensitive (such as an env var named `LICENSE`) can remain visible. Store credentials in Secrets. Exit 1 includes per-object failures; mixed results use `PARTIAL`.

Global flags: `--context <name>`, `--timeout <seconds>` (default 20, range 1 to 120), `--help`, and `--version` (`-v`, `-V`).
Namespaced lists default to the kubeconfig namespace, falling back to `default`. Home and triage default to all namespaces.
Use `-A` for all namespaces or `-n <namespace>` for one. They cannot be combined. A namespace named `all` is not an alias for `-A`.
Lists accept `--limit` (default 100, maximum 1000), `--fields <a,b>`, and `--problems`.
Pods, deployments, and jobs also accept `-l <selector>`. The default list schema has at most four columns.
`--full` only untruncates allowlisted text. It never adds object fields and changes nothing for Secrets.
Logs use the limits described above.

## Errors and exits

All errors have `error`, `code`, and actionable `help` on stdout. Raw subprocess stderr is suppressed.
Exit 0 means required reads completed or exec succeeded, including an unhealthy cluster. Exit 1 means a failed, refused, or partial operation. Exit 2 means usage error.
A failed check cannot produce a healthy headline. Partial triage includes completed rows, `complete: false`, and `code: PARTIAL`.
A missing context or namespace is an error. An empty namespace that cannot be verified is not a definitive empty result.

| Code                  | Meaning                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| VALIDATION_ERROR      | Invalid arguments or selector. Exit 2.                                                                |
| REFUSED               | Write, raw passthrough, streaming, or self-update refused.                                            |
| CONTEXT_NOT_FOUND     | Requested context is not configured.                                                                  |
| NO_CONTEXT            | No named current context.                                                                             |
| NOT_FOUND             | Requested object does not exist.                                                                      |
| FORBIDDEN             | Cluster denied the read.                                                                              |
| AUTH_REQUIRED         | Credentials required or credential helper failed.                                                     |
| AUTH_EXPIRED          | Credentials expired.                                                                                  |
| SERVER_UNREACHABLE    | Network or TLS failure.                                                                               |
| TIMEOUT               | Per-call or overall deadline expired.                                                                 |
| RATE_LIMITED          | Cluster throttled the read.                                                                           |
| UNSUPPORTED_RESOURCE  | Cluster has no such resource type.                                                                    |
| UPSTREAM_ERROR        | Invalid response or unclassified read failure.                                                        |
| KUBECTL_NOT_INSTALLED | Install kubectl on PATH.                                                                              |
| OUTPUT_TOO_LARGE      | A stream exceeds 128 MiB for reads or 1 MiB for exec. Narrow the scope.                               |
| NAMESPACE_NOT_FOUND   | Namespace does not exist.                                                                             |
| NAMESPACE_UNVERIFIED  | Namespace lookup forbidden and result empty.                                                          |
| PARTIAL               | One or more triage checks failed.                                                                     |
| CONFIG_INVALID        | Local configuration or integration could not be read, written, or verified.                           |
| SECRET_EXPOSURE       | Action input could expose Secret material.                                                            |
| SCRUB_UNAVAILABLE     | Secret values could not be loaded for safe output scrubbing.                                          |
| REMOTE_EXIT_NONZERO   | The remote command returned a nonzero exit status.                                                    |
| AUDIT_UNAVAILABLE     | The action audit log could not be written or read.                                                    |
| AUDIT_INCOMPLETE      | Completion record missing; inspect whether exec reports a known launch failure or possible execution. |
| SESSION_LIMIT         | The maximum number of owned port-forward sessions is running.                                         |
| SESSION_NOT_FOUND     | The requested owned session does not exist.                                                           |
| PORT_IN_USE           | The requested local port is already in use.                                                           |
| SECRET_MANIFEST       | A Secret manifest contains values instead of redacted placeholders.                                   |
| INVALID_MANIFEST      | The manifest is invalid or unsupported.                                                               |
| LOGS_UNAVAILABLE      | The requested container logs are unavailable.                                                         |
| UNSUPPORTED_PLATFORM  | Port-forward process groups require Linux or macOS.                                                   |

## Safety model

Cluster access is read-only by default. Apply preview and diff use client-side apply semantics with `--dry-run=server`; they never persist objects and never submit Secrets. They echo the target context, sanitized server, namespace and each object. Previews are not audited. `apply --execute` is not enabled. Port forwarding previews the resolved context, server, namespace, pod, ports, permission, and expiry. Only `--execute` starts a forwarding session, after its start record is written to the local audit log. Exec previews perform target, permission, and output-scrub checks without executing a remote command. `--execute` requires explicit `--context` and `-n`, echoes the resolved target, and appends an audit record before spawning. If that append fails, nothing runs. If only the completion record fails, `AUDIT_INCOMPLETE` warns not to retry an action that ran or may have run. Exec preserves a known preflight or kubectl launch failure separately when the remote command did not start. `k8s-axi audit` reads the log without contacting the cluster. There is no arbitrary kubectl argument path, attach, proxy, raw output, public auth review, or self-update.
Port-forward sessions live under `${XDG_STATE_HOME:-$HOME/.local/state}/k8s-axi/sessions/`, with 0700 directories and 0600 records. A detached supervisor owns each process group, waits up to 15 seconds for loopback readiness, and expires the session without reconnecting. Explicit stop, expiry, SessionEnd, and opportunistic reaping clean up sessions. SessionEnd stops sessions owned by the payload's real cwd and uid; agents in the same directory share ownership.
Before signalling a live supervisor's process group, cleanup verifies its token in the process command. After supervisor death, cleanup requires the surviving child's pid, process group, exact start time, and exact command to match the saved identity. A mismatch or unreadable identity drops the record without signalling and audits `dropped`; it cannot safely promise cleanup of that unverified process.
Every network call pins the resolved context. Namespace preflight distinguishes a missing namespace from an empty list.
Read and preview subprocesses have closed stdin (except the manifest pipe for dry-run apply), a shared overall deadline, per-call timeouts, process-group cleanup, and a 128 MiB per-stream output cap. Port-forward supervisors close stdin and cap each captured stream at 1 MiB; their lifetime is bounded by the session TTL. Exec output is capped at 1 MiB per stream. The audit log is stored at `${XDG_STATE_HOME:-$HOME/.local/state}/k8s-axi/audit.jsonl`, with private directory and file permissions.
KUBERC is disabled so user defaults cannot silently rewrite a read. kubectl can write its own discovery cache, but k8s-axi never modifies kubeconfig or cluster resources.

Secret inventory and apply/diff Secret comparisons use a fixed go-template that returns metadata and key names, never values. Secret manifest values are read locally only to enforce the placeholder guard and are never printed. Exec is the sole cluster-Secret value-read exception: it reads Secrets referenced by the selected container's env, envFrom, and mounted Secret or projected-Secret volumes into memory only to scrub output. Credential-named literal env values are scrubbed too. A missing required Secret or denied `get secrets` permission refuses both preview and execution with `SCRUB_UNAVAILABLE`; absent optional Secrets are skipped.
Exec scrubs raw values and base64, base64url, hex, and percent-encoded forms before pattern redaction and truncation. Values shorter than four characters are not value-scrubbed; the preview reports their count. Encoded forms need at least eight characters. JWT pattern redaction covers projected ServiceAccount tokens. Command echoes and audited argv are scrubbed too; audit hashes use the original argv. Refusal records omit argv because the scrub set may be unavailable.
The input guard rejects environment dumpers, shells, interpreters, unsafe wrapper options, sensitive paths, and recursive traversal of their ancestors. Relative file operands require an explicit container `workingDir`. Exec rechecks the Pod UID and resourceVersion immediately before launch and refuses changes with `TARGET_CHANGED`; kubectl has no atomic UID precondition for exec, so this does not eliminate the final replacement race. These guards are not a sandbox: exec may change container state, arbitrary image binaries may transform credentials in unknown ways, and CSI or external credentials cannot be enumerated as Kubernetes Secret values. Use a trusted image and restricted RBAC.
This is an output safeguard, not access control: API permission to list Secrets also permits values through other clients.
Diagnostic pod views omit env, args, command, volumes, and all annotations. Apply/diff may show non-sensitive fields in structural changes. The default-container annotation is used internally for log and exec selection.
Free text is redacted before truncation, including `--full`. Log redaction is **best effort**. Unknown credential formats can remain in arbitrary log text.

## Agent integration

Either integration path is sufficient. Neither is installed automatically.

- **Skill:** `npx skills add Dematom1/k8s-axi --skill k8s-axi -g`, or copy `skills/k8s-axi/SKILL.md` into your agent's skills directory. Examples use `npx -y k8s-axi`.
- **Hooks:** after a persistent install, run `k8s-axi setup hooks`. Claude Code and Codex get SessionStart context. OpenCode gets a managed ambient plugin. Claude Code SessionEnd records command names, counts, and the most-used context, not command arguments or output. It also stops port-forward sessions owned by the payload directory.

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
sh scripts/lab-live.sh run
sh scripts/lab-live.sh crashloop
sh scripts/real-kubectl.sh
npm run build:skill
```

Tests use a fake kubectl and a loopback API server. The real kubectl lane requires no cluster credentials.
`npm run test:live` runs the disposable kind-cluster suite against the packed tarball. Docker and Go 1.26+ are required.
The lab installs `github.com/Dematom1/dibs@v0.2.7` and leases a kind cluster with the script PID as owner, a one-hour TTL, and `project=k8s-axi` and `task=lab-live` labels.
It uses the lease's private kubeconfig, caps the node at two CPUs during creation, and releases the lease on exit. Failed cleanup retains the lease and fails the run.
The `crashloop` mode runs the 120-second restart regression through the same lease lifecycle. The legacy `test/live/crashloop.sh` entry point delegates to this mode.

Dibs has no background sweeper. On persistent hosts, schedule `dibs sweep --confirm` with cron or a host timer to reclaim leases after owner death or expiry.
Use the same absolute `DIBS_STATE`, Docker context, and user as the lab, with dibs v0.2.7 and kind on the timer's PATH.
The lab defaults to the existing shared ledger at `${BERTH_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/berth}` and exports both state variables to that path; an explicit `DIBS_STATE` takes precedence.
Keep state outside `.lab-live` so it survives lab cleanup. A lab killed with SIGKILL leaves its lease for the next sweep; the TTL alone does not delete the cluster.
CI runs a final sweep even if the lab fails. You can also reclaim a killed local run with:

```sh
go install github.com/Dematom1/dibs@v0.2.7
export DIBS_STATE="${DIBS_STATE:-${BERTH_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/berth}}"
PATH="$PWD/.lab-live/bin:$PATH" dibs sweep --confirm
dibs list --json
kind get clusters
```

After successful cleanup, neither the lab lease nor the kind cluster named in its `resource_name` remains. Existing unleased clusters are not adopted or deleted.

## Releases

`npm run check` includes generated skill drift. Pack and verify with `node scripts/verify-package.mjs`.
Release workflows stage an exact stamped tarball. A human approval and registry-artifact verification are separate gates.
No repository, remote, registry publication, or trusted publisher is created by this local build.
Selected scaffolding, session-memory, and TOON helpers follow argocd-axi (MIT). See LICENSE.
