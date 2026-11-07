#!/usr/bin/env bash
set -euo pipefail
root=$PWD
lab=$root/.lab-live
name=k8s-axi-lab
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
export HOME="$lab/home" TMPDIR="$lab/tmp" KUBECONFIG="$lab/kubeconfig"
mkdir -p "$HOME" "$TMPDIR"
node_container="$name-control-plane"
acquired=0
cleanup() { if [ "$acquired" = 1 ]; then kind delete cluster --name "$name" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT INT TERM
start=$SECONDS
while [ $((SECONDS - start)) -lt 1200 ]; do
  kind create cluster --name "$name" --kubeconfig "$KUBECONFIG" >"$lab/kind-create.log" 2>&1 &
  create_pid=$!
  capped=0
  while kill -0 "$create_pid" 2>/dev/null; do
    if docker inspect "$node_container" >/dev/null 2>&1; then
      docker update --cpus=2 "$node_container"
      capped=1
      break
    fi
    sleep 2
  done
  if wait "$create_pid"; then
    [ "$capped" = 1 ] || { docker update --cpus=2 "$node_container"; }
    acquired=1
    break
  fi
  if ! grep -qi 'already exists' "$lab/kind-create.log"; then
    cat "$lab/kind-create.log" >&2
    echo 'FAIL: could not create kind cluster' >&2
    exit 1
  fi
  if docker inspect "$node_container" >/dev/null 2>&1; then
    created=$(docker inspect -f '{{.Created}}' "$node_container")
    if python3 -c 'import datetime,sys; created=datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")); now=datetime.datetime.now(datetime.timezone.utc); sys.exit(0 if (now-created).total_seconds()>2700 else 1)' "$created"; then
      kind delete cluster --name "$name"
      continue
    fi
  fi
  sleep 15
done
[ "$acquired" = 1 ] || { echo 'FAIL: timed out waiting for shared kind cluster name' >&2; exit 1; }
node=$(kind get nodes --name "$name" | head -1)
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
kubectl --kubeconfig "$KUBECONFIG" -n fixtures apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  restartPolicy: Never
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "printf 'password=secret\\nAuthorization: Bearer token\\n'; sleep 3600"]
EOF
kubectl --kubeconfig "$KUBECONFIG" -n fixtures wait --for=jsonpath='{.status.phase}'=Running pod/chatty pod/web --timeout=120s
check_tail() {
  tail=$1
  first=$2
  out=$(node "$root/dist/bin/k8s-axi.js" pods logs chatty -n fixtures --tail "$tail")
  last_line=$(printf '%s\n' "$out" | grep -oE 'line [0-9]+' | tail -1)
  [ "$last_line" = 'line 2999' ] || { echo "FAIL: --tail $tail ended at $last_line" >&2; exit 1; }
  printf '%s\n' "$out" | grep -F "line $first" >/dev/null || { echo "FAIL: --tail $tail omitted its first expected line" >&2; exit 1; }
  count=$(printf '%s\n' "$out" | sed -n 's/^logs\[\([0-9]*\)\].*/\1/p')
  [ "$count" = "$tail" ] || { echo "FAIL: --tail $tail returned $count lines" >&2; exit 1; }
  if [ "$tail" = 1000 ]; then
    printf '%s\n' "$out" | grep -F 'tail 1000' >/dev/null || { echo 'FAIL: continuation hint omitted --tail 1000' >&2; exit 1; }
  fi
}
check_tail 100 2900
check_tail 1000 2000
if node "$root/dist/bin/k8s-axi.js" pods logs chatty -n fixtures --previous >"$lab/previous.out" 2>&1; then
  echo 'FAIL: missing previous-container logs unexpectedly succeeded' >&2
  exit 1
fi
grep -F 'LOGS_UNAVAILABLE' "$lab/previous.out" >/dev/null || { echo 'FAIL: missing previous logs were not LOGS_UNAVAILABLE' >&2; exit 1; }
web_out=$(node "$root/dist/bin/k8s-axi.js" pods logs web -n fixtures)
printf '%s\n' "$web_out" | grep -F 'redacted: 2' >/dev/null || { echo 'FAIL: web log redaction count changed from the baseline of 2' >&2; exit 1; }
echo 'PASS: exact log tails, missing-previous error, and web redaction count'
