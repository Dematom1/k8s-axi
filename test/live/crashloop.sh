#!/usr/bin/env bash
set -euo pipefail
root=$PWD
lab=$root/.lab-live
mkdir -p "$lab/bin"
name="k8s-axi-$$-$RANDOM"
lock=/tmp/k8s-axi-kind-lab.lock
owned_lock=0
cleanup() {
  if (( owned_lock )); then kind delete cluster --name "$name" >/dev/null 2>&1 || true; rm -rf "$lock"; fi
  rm -rf "$lab"
}
trap cleanup EXIT INT TERM
export HOME=$lab/home TMPDIR=$lab/tmp KUBECONFIG=$lab/kubeconfig
mkdir -p "$HOME" "$TMPDIR"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64|Darwin-aarch64) platform=darwin-arm64 ;;
  Linux-x86_64) platform=linux-amd64 ;;
  *) echo "unsupported kind platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
url="https://kind.sigs.k8s.io/dl/v0.33.0/kind-$platform"
curl -fsSLo "$lab/bin/kind" "$url"
curl -fsSLo "$lab/kind.sha256sum" "$url.sha256sum"
(cd "$lab" && shasum -a 256 -c kind.sha256sum)
chmod +x "$lab/bin/kind"
export PATH="$lab/bin:$PATH"
start=$SECONDS
while ! mkdir "$lock" 2>/dev/null; do
  if [[ -d $lock && $(($(date +%s) - $(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock"))) -gt 1800 ]]; then
    pid=$(cat "$lock/pid" 2>/dev/null || true)
    if [[ -n $pid ]] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
  fi
  (( SECONDS - start < 1200 )) || { echo 'timed out waiting for kind lab lock' >&2; exit 1; }
  sleep 10
done
owned_lock=1
echo $$ > "$lock/pid"
kind create cluster --name "$name" --kubeconfig "$KUBECONFIG"
node=$(kind get nodes --name "$name" | head -n1)
docker update --cpus=2 "$node"
kubectl create namespace fixtures
kubectl -n fixtures run crashy2 --image=busybox:1.36 --restart=Always -- /bin/sh -c 'exit 7'
until [[ $(kubectl -n fixtures get pod crashy2 -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo 0) -gt 0 ]]; do sleep 1; done
first_restart=$SECONDS
npm run build --silent
for at in 15 30 45 60 90 120; do
  remaining=$((at - (SECONDS - first_restart)))
  if (( remaining > 0 )); then sleep "$remaining"; fi
  triage=$(node dist/bin/k8s-axi.js triage -n fixtures)
  grep -Eq 'pods/crashy2.*(CrashLoopBackOff|Error \(7\))' <<<"$triage" || { echo "triage missed crashy2 at ${at}s" >&2; exit 1; }
  pods=$(node dist/bin/k8s-axi.js pods -n fixtures)
  ! grep -E 'crashy2.*NotReady' <<<"$pods" || { echo "pods labeled crashy2 NotReady at ${at}s" >&2; exit 1; }
done
