# Read-only live matrix

Historical results from a read-only run on 2026-11-02. The runner described here was retired; use `npm run test:live` for current live verification.

The live cluster changed since planning: 51 pods rather than 76, 35 namespaces, and 72 kube-system events rather than 11. The configured `agent-sandbox-runtime` namespace no longer exists. Its default pod read correctly exits 1 with `NAMESPACE_NOT_FOUND`; the matrix checks that instead of claiming a successful empty namespace. Existing-empty-namespace behavior is covered by the fake lane.

The first matrix caught a test-only lexical timestamp comparison across mixed precision; it now compares parsed instants. The initial abort occurred on the correctly rejected missing current namespace. No cluster or kubeconfig write occurred in either run.

The blind check keeps reference values in memory, scans all captured outputs and at most 12 Secret details, then prints counts only. Zero matches is sampled evidence, not proof for arbitrary log encodings.

```json
{
  "passed": true,
  "counts": {
    "nodes": 4,
    "namespaces": 35,
    "fingerprint": "ae479a003c86bb3ecdaf9c888a51607255c0dcfd483f09328983aebd24886096",
    "pods": 51,
    "kubeSystemEvents": 72,
    "currentNamespaceExists": false,
    "currentNamespacePods": 0,
    "secrets": 63,
    "keys": 157,
    "base64ValueMatches": 0,
    "kubectlPodBytes": 6404,
    "axiPodBytes": 3325,
    "auditCalls": 125
  },
  "checks": {
    "nodes": true,
    "podCount": true,
    "podProblems": true,
    "events": true,
    "eventTimes": true,
    "missingContext": true,
    "missing-pods": true,
    "missing-deployments": true,
    "missing-jobs": true,
    "missing-pvcs": true,
    "missing-services": true,
    "missing-events": true,
    "missing-secrets": true,
    "usage-pods nonsense": true,
    "usage-events --limit 10junk": true,
    "usage-pods --namespace --context default": true,
    "usage-pods -n -A": true,
    "currentNamespace": true,
    "skew": true,
    "secretCounts": true,
    "blindSecrets": true,
    "size": true,
    "kubeconfigUnchanged": true,
    "audit": true
  }
}
```
