# Local release candidate evidence

This is a **local pre-release**, not a registry-artifact admission. Nothing was pushed, published, or staged on npm.

Run `K8S_AXI_EVIDENCE_DIR=<outside-repository-directory> node scripts/verify-package.mjs` on a clean committed checkout. The script records the exact source head, archive gitHead, tarball path, SHA-512 integrity, size, installed test results, and every negative case in `release-evidence.json`. It packs a temporary stage rather than modifying package.json. The final clean-head proof is retained by firstmate in `data/k8s-axi-build/p16-final/release-evidence.json`.

The rehearsal used `--allow-dirty` to exercise this gate before its commit. Its archive is not the final candidate. The final invocation refuses uncommitted changes. The output identifies either run as local pre-release.

## Executed negative cases

Each row runs under a fresh temporary HOME and cwd. Commands below use `node <installed>/dist/bin/k8s-axi.js`; `HOME=$CASE_HOME`, `XDG_CONFIG_HOME=$CASE_HOME/.config`, and `KUBECONFIG=$CASE_HOME/no-kubeconfig`. The machine-readable proof records their exact expanded argv and paths. Permission checks ran as a non-root user. Root runs fail as inconclusive.

Files reopened after every command:

- F1: `.claude/settings.json`
- F2: `.codex/hooks.json`
- F3: `.codex/config.toml`
- F4: `.config/opencode/plugins/axi-k8s-axi.js`

`present` and `absent` below describe reopened files, not inferred installation. Full reopened content, denied-read results, reported error text, stderr, and partial writes are in the proof JSON. Status and uninstall reopen all managed destinations. The tests validate actual managed entries and shared feature state, not just file existence.

| Case           | Denied destination | Command           | Exit | Stdout code    | Reported status                                                                            | Stderr | Reopened F1/F2/F3/F4            | Partial writes |
| -------------- | ------------------ | ----------------- | ---- | -------------- | ------------------------------------------------------------------------------------------ | ------ | ------------------------------- | -------------- |
| 1 (install)    | .claude            | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"absent","codex":"installed","opencode":"installed","sessionEnd":"absent"}       | empty  | absent/present/present/present  | F2, F3, F4     |
| 2 (repair)     | .claude            | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"partial","codex":"installed","opencode":"installed","sessionEnd":"partial"}     | empty  | present/present/present/present | F2, F4         |
| 3 (uninstall)  | .claude            | `setup uninstall` | 1    | CONFIG_INVALID | {"claude":"installed","codex":"absent","opencode":"absent","sessionEnd":"installed"}       | empty  | present/present/present/absent  | F2, F4         |
| 4 (status)     | .claude            | `setup status`    | 1    | CONFIG_INVALID | error, not success                                                                         | empty  | present/present/present/present | none           |
| 5 (install)    | .codex             | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"installed","codex":"absent","opencode":"installed","sessionEnd":"installed"}    | empty  | present/absent/absent/present   | F1, F4         |
| 6 (repair)     | .codex             | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"installed","codex":"partial","opencode":"installed","sessionEnd":"installed"}   | empty  | present/present/present/present | F1, F4         |
| 7 (uninstall)  | .codex             | `setup uninstall` | 1    | CONFIG_INVALID | {"claude":"absent","codex":"installed","opencode":"absent","sessionEnd":"absent"}          | empty  | present/present/present/absent  | F1, F4         |
| 8 (status)     | .codex             | `setup status`    | 1    | CONFIG_INVALID | error, not success                                                                         | empty  | present/present/present/present | none           |
| 9 (install)    | .config            | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"installed","codex":"installed","opencode":"absent","sessionEnd":"installed"}    | empty  | present/present/present/absent  | F1, F2, F3     |
| 10 (repair)    | .config            | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"installed","codex":"installed","opencode":"partial","sessionEnd":"installed"}   | empty  | present/present/present/present | F1, F2         |
| 11 (uninstall) | .config            | `setup uninstall` | 1    | CONFIG_INVALID | {"claude":"absent","codex":"absent","opencode":"installed","sessionEnd":"absent"}          | empty  | present/present/present/present | F1, F2         |
| 12 (status)    | .config            | `setup status`    | 1    | CONFIG_INVALID | error, not success                                                                         | empty  | present/present/present/present | none           |
| 13 (install)   | nested             | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"absent","codex":"installed","opencode":"installed","sessionEnd":"absent"}       | empty  | present/present/present/present | F2, F3, F4     |
| 14 (repair)    | nested             | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"partial","codex":"installed","opencode":"installed","sessionEnd":"partial"}     | empty  | present/present/present/present | F2, F4         |
| 15 (uninstall) | nested             | `setup uninstall` | 1    | CONFIG_INVALID | {"claude":"installed","codex":"absent","opencode":"absent","sessionEnd":"installed"}       | empty  | present/present/present/absent  | F2, F4         |
| 16 (status)    | nested             | `setup status`    | 1    | CONFIG_INVALID | error, not success                                                                         | empty  | present/present/present/present | none           |
| 17 (install)   | all                | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"absent","codex":"absent","opencode":"absent","sessionEnd":"absent"}             | empty  | absent/absent/absent/absent     | none           |
| 18 (repair)    | all                | `setup hooks`     | 1    | CONFIG_INVALID | {"claude":"partial","codex":"partial","opencode":"partial","sessionEnd":"partial"}         | empty  | present/present/present/present | none           |
| 19 (uninstall) | all                | `setup uninstall` | 1    | CONFIG_INVALID | {"claude":"installed","codex":"installed","opencode":"installed","sessionEnd":"installed"} | empty  | present/present/present/present | none           |
| 20 (status)    | all                | `setup status`    | 1    | CONFIG_INVALID | error, not success                                                                         | empty  | present/present/present/present | none           |

Repair cases first relocate every managed executable path, so each denied destination actually needs a write. Nested cases include an existing settings file. The all case denies every integration directory. This catches partial installation instead of treating a no-op as a failed write experiment.

Source and failed-path proof: `src/commands/setup.ts`, `src/session-hook.ts`, `test/setup.test.ts`, and `scripts/verify-package.mjs`.

## Lifecycle and artifact gates

| Gate                                                | Local result                 | Source or execution                                                                                                       |
| --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Exact installed archive                             | Met before publication       | Pack into a temporary stage, assert gitHead, install with scripts disabled, run the full suite using K8S_AXI_TEST_PACKAGE |
| Structured denied writes and status                 | Met locally                  | Twenty rows above, CONFIG_INVALID and exit 1, actual files reopened                                                       |
| Stored lifecycle commands                           | Met locally                  | Parse installed SessionStart and SessionEnd commands, execute with stdin from unrelated cwd and a Node-only PATH          |
| Relocation and quoting                              | Met locally                  | Repair after copying to a path containing spaces and a single quote                                                       |
| Real npx lifecycle                                  | Met locally                  | Actual npm exec of local tarball refuses setup with REFUSED, exit 1, and no integration files                             |
| Repeat install and unrelated hooks                  | Met locally                  | test/setup.test.ts preserves unrelated entries and checks unchanged mtime                                                 |
| Namespace and context failures                      | Met locally and live         | target tests, command-family matrix, docs/live-matrix.md                                                                  |
| All health failure subsets                          | Met locally                  | All 128 subsets in test/checks.test.ts plus partial, unreachable, clean and problem CLI cases                             |
| Subprocess deadlines                                | Met locally                  | Hung process, SIGTERM-ignoring process, inherited pipes, SIGTERM-ignoring grandchild, overall deadline                    |
| Fixed read boundary                                 | Met locally                  | Exhaustive argv snapshot, runtime refusal tests and no subprocess import outside kubectl.ts in shipped source             |
| Secret output projection                            | Met locally and live         | Real kubectl template, canaries, pagination, expired continuation, and zero sampled live value matches                    |
| Poison sensitivity                                  | Met locally                  | Every noun in default and full modes, plus deliberate pod env projection fails the assertion                              |
| Pinned real clients                                 | Met on this host             | kubectl v1.32.0 and v1.36.2, SHA-256 verified by scripts/real-kubectl.sh                                                  |
| Generated skill drift                               | Met locally                  | A one-character edit fails the actual checker in a temporary copy                                                         |
| Workflow safety                                     | Static gates met             | YAML tests and actionlint. No workflow has run on GitHub because no repository exists                                     |
| Published artifact identity, signatures, provenance | Open                         | Requires first approved staged publication, then verify-package.mjs --published <version> on the matching source commit   |
| Family sweep                                        | Open outside this repository | Firstmate owns routing the classes listed below                                                                           |

## Final gate corrections

The release checks cover completed pods during delayed deletion and keep timeout escalation referenced so a SIGTERM-ignoring grandchild cannot survive when its parent exits. A full 1 MiB single-line log exposed repeated assignment-pattern rescans; a left boundary and linear quoted-value matching remove that stall, with the maximum-size CLI case retained as a regression. Hook status rejects stale paths as partial, and detail previews disclose their original size.

## Family follow-ups

The planning report measured inherited-pipe deadline defeat and redaction gaps in argocd-axi. It also identified user-default argument injection as a class to check across CLI wrappers and an OIDC-job npm hand-off risk in terraform-axi. This task changes none of those repositories. Their same-class checks and published-artifact confirmation remain with firstmate.
