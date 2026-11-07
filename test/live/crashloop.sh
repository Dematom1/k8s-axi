#!/usr/bin/env bash
set -euo pipefail
root=$PWD
lab=$root/.lab-live/run-$$-$RANDOM
mkdir -p "$lab/bin"
name="k8s-axi-$$-$RANDOM"
lock=${K8S_AXI_LAB_LOCK:-/tmp/k8s-axi-kind-lab.lock}
owned_lock=0
lock_token="$name"
cleanup() {
  if (( owned_lock )) && [[ $(cat "$lock/owner" 2>/dev/null || true) == "$lock_token" ]]; then
    kind delete cluster --name "$name" >/dev/null 2>&1 || true
    rm -f "$lock/pid" "$lock/owner"
    rmdir "$lock" 2>/dev/null || true
  fi
  rm -rf "$lab"
  rmdir "$root/.lab-live" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
export HOME=$lab/home TMPDIR=$lab/tmp KUBECONFIG=$lab/kubeconfig
mkdir -p "$HOME" "$TMPDIR"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64|Darwin-aarch64) platform=darwin-arm64 ;;
  Linux-x86_64) platform=linux-amd64 ;;
  *) echo "unsupported lab platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
kind_url="https://kind.sigs.k8s.io/dl/v0.33.0/kind-$platform"
curl -fsSLo "$lab/bin/kind-$platform" "$kind_url"
curl -fsSLo "$lab/kind.sha256sum" "$kind_url.sha256sum"
(cd "$lab/bin" && shasum -a 256 -c "$lab/kind.sha256sum")
mv "$lab/bin/kind-$platform" "$lab/bin/kind"
kubectl_version=v1.36.2
kubectl_url="https://dl.k8s.io/release/$kubectl_version/bin/$(uname -s | tr '[:upper:]' '[:lower:]')/$([[ $(uname -m) == arm64 || $(uname -m) == aarch64 ]] && echo arm64 || echo amd64)/kubectl"
curl -fsSLo "$lab/bin/kubectl" "$kubectl_url"
curl -fsSLo "$lab/kubectl.sha256" "$kubectl_url.sha256"
(cd "$lab/bin" && printf '%s  kubectl\n' "$(cat "$lab/kubectl.sha256")" | shasum -a 256 -c)
chmod +x "$lab/bin/kind" "$lab/bin/kubectl"
export PATH="$lab/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
start=$SECONDS
while ! mkdir "$lock" 2>/dev/null; do
  if [[ -d $lock ]]; then
    case "$(uname -s)" in
      Darwin) lock_mtime=$(stat -f %m "$lock") ;;
      Linux) lock_mtime=$(stat -c %Y "$lock") ;;
      *) echo "unsupported lock host: $(uname -s)" >&2; exit 1 ;;
    esac
    if (( $(date +%s) - lock_mtime > 1800 )); then
      pid=$(cat "$lock/pid" 2>/dev/null || true)
      if [[ $pid =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null &&
        ln "$lock/pid" "$lock/reclaim" 2>/dev/null; then
        if [[ $(cat "$lock/pid" 2>/dev/null || true) == "$pid" &&
          $(cat "$lock/reclaim" 2>/dev/null || true) == "$pid" ]] &&
          (( $(date +%s) - lock_mtime > 1800 )) && ! kill -0 "$pid" 2>/dev/null; then
          rm -f "$lock/pid"
          rm -f "$lock/reclaim"
          rmdir "$lock" 2>/dev/null || true
        else
          rm -f "$lock/reclaim"
        fi
        continue
      fi
    fi
  fi
  (( SECONDS - start < 1200 )) || { echo 'timed out waiting for kind lab lock' >&2; exit 1; }
  sleep 10
done
owned_lock=1
echo $$ > "$lock/pid"
printf '%s\n' "$lock_token" > "$lock/owner"
kind create cluster --name "$name" --kubeconfig "$KUBECONFIG"
npm run build --silent
node=$(kind get nodes --name "$name" | head -n1)
docker update --cpus=2 "$node"
kubectl create namespace fixtures
kubectl -n fixtures create serviceaccount default --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n fixtures -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: restarting-not-ready
spec:
  restartPolicy: Always
  containers:
  - name: app
    image: busybox:1.36
    command: ["/bin/sh", "-c", "if [ ! -f /restart-state/restarted ]; then touch /restart-state/restarted; exit 1; fi; sleep 3600"]
    volumeMounts:
    - name: restart-state
      mountPath: /restart-state
    readinessProbe:
      exec: { command: ["/bin/false"] }
      periodSeconds: 1
  volumes:
  - name: restart-state
    emptyDir: {}
YAML
started=$SECONDS
while [[ $(kubectl -n fixtures get pod restarting-not-ready -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo 0) -le 0 ]] || [[ -z $(kubectl -n fixtures get pod restarting-not-ready -o jsonpath='{.status.containerStatuses[0].state.running.startedAt}' 2>/dev/null || true) ]]; do
  (( SECONDS - started < 90 )) || { echo 'timed out waiting for restarting-not-ready to restart and run' >&2; exit 1; }
  sleep 1
done
immediate_triage=$(node dist/bin/k8s-axi.js triage -n fixtures)
grep -q 'pods/restarting-not-ready' <<<"$immediate_triage" || { echo 'triage omitted restarting-not-ready immediately after first restart' >&2; exit 1; }
kubectl -n fixtures run crashy2 --image=busybox:1.36 --restart=Always -- /bin/sh -c 'exit 7'
started=$SECONDS
while [[ $(kubectl -n fixtures get pod crashy2 -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo 0) -le 0 ]]; do
  (( SECONDS - started < 90 )) || { echo 'timed out waiting for crashy2 first restart' >&2; exit 1; }
  sleep 1
done
first_restart=$SECONDS
kubectl apply -n fixtures -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: oom
spec:
  restartPolicy: Never
  containers:
  - name: app
    image: busybox:1.36
    command: ["/bin/sh", "-c", "dd if=/dev/zero of=/dev/null bs=32M count=1"]
    resources:
      limits: { memory: 16Mi }
YAML
for at in 15 30 45 60 90 120; do
  remaining=$((at - (SECONDS - first_restart)))
  if (( remaining > 0 )); then sleep "$remaining"; fi
  triage=$(node dist/bin/k8s-axi.js triage -n fixtures)
  grep -Eq 'pods/crashy2.*(CrashLoopBackOff|Error \(7\))' <<<"$triage" || { echo "triage missed crashy2 at ${at}s" >&2; exit 1; }
  pods=$(node dist/bin/k8s-axi.js pods -n fixtures)
  ! grep -E 'crashy2.*NotReady' <<<"$pods" || { echo "pods labeled crashy2 NotReady at ${at}s" >&2; exit 1; }
done
started=$SECONDS
while [[ $(kubectl -n fixtures get pod oom -o jsonpath='{.status.containerStatuses[0].state.terminated.reason}' 2>/dev/null || true) != OOMKilled ]]; do
  (( SECONDS - started < 90 )) || { echo 'timed out waiting for OOMKilled state' >&2; exit 1; }
  sleep 1
done
pod_output=$(node dist/bin/k8s-axi.js pods -n fixtures --problems)
grep -E 'restarting-not-ready.*Error \(1\)' <<<"$pod_output" || { echo 'restarting-not-ready not classified as Error (1) problem' >&2; exit 1; }
grep -F 'oom' <<<"$pod_output" | grep -F 'OOMKilled (137)' || { echo 'oom not classified as OOMKilled (137)' >&2; exit 1; }
[[ $(kubectl -n fixtures get pod oom -o jsonpath='{.status.containerStatuses[0].state.terminated.reason}') == OOMKilled ]] || { echo 'oom did not terminate with OOMKilled' >&2; exit 1; }
node dist/bin/k8s-axi.js triage -n fixtures | grep -q 'pods/restarting-not-ready' || { echo 'triage omitted restarting-not-ready' >&2; exit 1; }
node dist/bin/k8s-axi.js triage -n fixtures | grep -q 'pods/oom' || { echo 'triage omitted oom' >&2; exit 1; }
# restartPolicy Always creates the terminated-between-restarts state for crashy2.
node dist/bin/k8s-axi.js pods view crashy2 -n fixtures | grep -Eq 'CrashLoopBackOff|Error \(7\)'
secret_value='k8s-axi-live-secret-canary-91e7'
secret_b64=$(printf %s "$secret_value" | base64 | tr -d '\n')
cat > "$lab/secret.yaml" <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: leak-check
  namespace: fixtures
type: Opaque
data:
  neutral: $secret_b64
YAML
kubectl apply -f "$lab/secret.yaml" >/dev/null
safety_output=$( {
  node dist/bin/k8s-axi.js pods -n fixtures || exit $?
  node dist/bin/k8s-axi.js triage -n fixtures || exit $?
  node dist/bin/k8s-axi.js pods view crashy2 -n fixtures || exit $?
  node dist/bin/k8s-axi.js pods view oom -n fixtures || exit $?
  node dist/bin/k8s-axi.js describe pod crashy2 -n fixtures || true
  node dist/bin/k8s-axi.js secrets view leak-check -n fixtures --full || exit $?
} 2>&1 )
if grep -Fq "$secret_value" <<<"$safety_output" || grep -Fq "$secret_b64" <<<"$safety_output"; then echo 'Secret canary leaked in diagnostic output' >&2; exit 1; fi
set +e
missing_ns=$(node dist/bin/k8s-axi.js pods -n k8s-axi-missing-ns 2>&1); missing_ns_code=$?
missing_pod=$(node dist/bin/k8s-axi.js pods view k8s-axi-missing-pod -n fixtures 2>&1); missing_pod_code=$?
set -e
if (( missing_ns_code == 0 )); then echo 'missing namespace returned success' >&2; exit 1; fi
grep -q NAMESPACE_NOT_FOUND <<<"$missing_ns"
if (( missing_pod_code == 0 )); then echo 'missing pod returned success' >&2; exit 1; fi
grep -q NOT_FOUND <<<"$missing_pod"
