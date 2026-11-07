#!/usr/bin/env bash
set -euo pipefail
root=$PWD
lab=$root/.lab-live
lock=/tmp/k8s-axi-kind-lab.lock
mkdir -p "$lab/bin"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Linux-x86_64) platform=linux-amd64 ;;
  *) echo "FAIL: unsupported kind platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
kind_bin="$lab/bin/kind"
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-$platform" -o "$kind_bin"
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-$platform.sha256sum" -o "$lab/bin/kind.sha256sum"
expected=$(awk '{print $1}' "$lab/bin/kind.sha256sum")
actual=$(shasum -a 256 "$kind_bin" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo 'FAIL: kind checksum mismatch' >&2; exit 1; }
chmod +x "$kind_bin"
export PATH="$lab/bin:/usr/local/bin:$PATH"
start=$SECONDS
while ! mkdir "$lock" 2>/dev/null; do
  if [ -f "$lock/pid" ] && [ $(( $(date +%s) - $(stat -f %m "$lock") )) -gt 1800 ] && ! kill -0 "$(<"$lock/pid")" 2>/dev/null; then
    rmdir "$lock" 2>/dev/null || true
    continue
  fi
  if [ $((SECONDS - start)) -ge 1200 ]; then echo 'FAIL: timed out waiting for kind lab lock' >&2; exit 1; fi
  sleep 10
done
printf '%s\n' "$$" > "$lock/pid"
name="k8s-axi-logs-$$"
export HOME="$lab/home" TMPDIR="$lab/tmp" KUBECONFIG="$lab/kubeconfig"
mkdir -p "$HOME" "$TMPDIR"
cleanup() { kind delete cluster --name "$name" >/dev/null 2>&1 || true; rm -rf "$lock"; }
trap cleanup EXIT INT TERM
kind create cluster --name "$name" --kubeconfig "$KUBECONFIG"
node=$(kind get nodes --name "$name" | head -1)
docker update --cpus=2 "$node"
kubectl --kubeconfig "$KUBECONFIG" wait --for=condition=Ready node --all --timeout=120s
kubectl --kubeconfig "$KUBECONFIG" create namespace fixtures
kubectl --kubeconfig "$KUBECONFIG" -n fixtures apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: chatty
spec:
  restartPolicy: Never
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "i=0; while [ $i -lt 3000 ]; do printf 'line %s\\n' $i; i=$((i+1)); done; sleep 3600"]
EOF
kubectl --kubeconfig "$KUBECONFIG" -n fixtures wait --for=jsonpath='{.status.phase}'=Running pod/chatty --timeout=120s
out=$(node "$root/dist/bin/k8s-axi.js" pods logs chatty -n fixtures --tail 1000)
printf '%s\n' "$out" | grep -F 'line 2999' >/dev/null || { echo 'FAIL: newest log line missing' >&2; exit 1; }
printf '%s\n' "$out" | grep -F 'tail 1000' >/dev/null || { echo 'FAIL: continuation hint omitted --tail 1000' >&2; exit 1; }
echo 'PASS: logs tail includes newest lines 2000..2999'
