#!/usr/bin/env bash
set -euo pipefail
root=$PWD
lab=$root/.lab-live
mkdir -p "$lab"
export HOME=$lab/home TMPDIR=$lab/tmp KUBECONFIG=$lab/kubeconfig
mkdir -p "$HOME" "$TMPDIR"
lock=/tmp/k8s-axi-kind-lab.lock
start=$SECONDS
while ! mkdir "$lock" 2>/dev/null; do
  if [[ -d $lock && $(($(date +%s) - $(stat -f %m "$lock"))) -gt 1800 ]]; then
    pid=$(cat "$lock/pid" 2>/dev/null || true)
    if [[ -n $pid ]] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
  fi
  (( SECONDS - start < 1200 )) || { echo 'timed out waiting for kind lab lock' >&2; exit 1; }
  sleep 10
done
echo $$ > "$lock/pid"
name="k8s-axi-$$-$RANDOM"
cleanup() { kind delete cluster --name "$name" >/dev/null 2>&1 || true; rm -rf "$lock" "$lab"; }
trap cleanup EXIT INT TERM
kind create cluster --name "$name" --kubeconfig "$KUBECONFIG"
node=$(kind get nodes --name "$name" | head -n1)
docker update --cpus=2 "$node"
kubectl create namespace fixtures
kubectl -n fixtures run crashy2 --image=busybox:1.36 --restart=Always -- /bin/sh -c 'exit 7'
until [[ $(kubectl -n fixtures get pod crashy2 -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo 0) -gt 0 ]]; do sleep 1; done
npm run build --silent
for delay in 15 30 45 60 90 120; do
  sleep "$delay"
  triage=$(node dist/bin/k8s-axi.js triage -n fixtures)
  grep -Eq 'pods/crashy2.*(CrashLoopBackOff|Error \(7\))' <<<"$triage" || { echo "triage missed crashy2 at ${delay}s" >&2; exit 1; }
  pods=$(node dist/bin/k8s-axi.js pods -n fixtures)
  ! grep -E 'crashy2.*NotReady' <<<"$pods" || { echo "pods labeled crashy2 NotReady at ${delay}s" >&2; exit 1; }
done
