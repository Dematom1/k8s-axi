#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
lab="$root/.lab-live"
name="k8s-axi-lab"
config="$lab/kubeconfig"
lock="$lab/.lock"
owned=0
cluster_owned=0
[ "${1:-}" = run ] || { echo 'usage: scripts/lab-live.sh run' >&2; exit 2; }
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
kind_bin="$lab/bin/kind"
create_pid=
cleanup() {
  if [ -n "$create_pid" ]; then
    kill "$create_pid" 2>/dev/null || true
    wait "$create_pid" 2>/dev/null || true
  fi
  if [ "$owned" = 1 ]; then
    if [ "$cluster_owned" = 1 ] && [ -x "$kind_bin" ]; then KUBECONFIG="$config" "$kind_bin" delete cluster --name "$name" >/dev/null 2>&1 || true; fi
    if [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$$" ]; then
      rm -rf "$lab/bin" "$lab/home" "$lab/tmp" "$lab/package" "$lab/kubeconfig" "$lab/live-results.json"
      rm -rf "$lock"
      rmdir "$lab" 2>/dev/null || true
    fi
  fi
}
mkdir -p "$lab"
start=$(date +%s)
while ! mkdir "$lock" 2>/dev/null; do
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    stale="$lab/.stale-lock-$$"
    if mv "$lock" "$stale" 2>/dev/null; then
      if [ "$(cat "$stale/pid" 2>/dev/null || true)" = "$owner" ]; then
        rm -rf "$stale"
        continue
      fi
      mv "$stale" "$lock" 2>/dev/null || true
    fi
  fi
  [ "$(( $(date +%s) - start ))" -lt 1200 ] || { echo 'FAIL: timed out waiting 20 minutes for the shared kind lab lock' >&2; exit 1; }
  sleep 10
done
owned=1
trap cleanup EXIT HUP INT TERM
printf '%s\n' "$$" > "$lock/pid"
mkdir -p "$lab/bin" "$lab/home" "$lab/tmp"
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) platform=darwin-arm64; kubectl_platform=darwin/arm64 ;;
  Darwin/x86_64) platform=darwin-amd64; kubectl_platform=darwin/amd64 ;;
  Linux/x86_64) platform=linux-amd64; kubectl_platform=linux/amd64 ;;
  Linux/aarch64|Linux/arm64) platform=linux-arm64; kubectl_platform=linux/arm64 ;;
  *) echo "unsupported lab platform: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
verify() {
  file=$1
  expected=$(awk '{print $1}' "$file.sha256")
  case "$expected" in *[!0-9a-fA-F]*|'') echo "invalid SHA-256 file: $file.sha256" >&2; exit 1 ;; esac
  if command -v sha256sum >/dev/null; then actual=$(sha256sum "$file" | awk '{print $1}')
  else actual=$(shasum -a 256 "$file" | awk '{print $1}'); fi
  [ "$actual" = "$expected" ] || { echo "SHA-256 mismatch: $file" >&2; exit 1; }
}
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-$platform" -o "$kind_bin"
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-$platform.sha256sum" -o "$kind_bin.sha256"
verify "$kind_bin"
curl -fsSL "https://dl.k8s.io/release/v1.36.2/bin/$kubectl_platform/kubectl" -o "$lab/bin/kubectl"
curl -fsSL "https://dl.k8s.io/release/v1.36.2/bin/$kubectl_platform/kubectl.sha256" -o "$lab/bin/kubectl.sha256"
verify "$lab/bin/kubectl"
chmod +x "$kind_bin" "$lab/bin/kubectl"
PATH="$lab/bin:$PATH"
export PATH
cluster_wait_start=$(date +%s)
while kind get clusters | grep -Fxq "$name"; do
  node="${name}-control-plane"
  if docker inspect "$node" >/dev/null 2>&1; then
    started=$(docker inspect --format '{{.State.StartedAt}}' "$node")
    age=$(node -e 'process.stdout.write(String(Math.floor((Date.now() - Date.parse(process.argv[1])) / 1000)))' "$started")
    if [ "$age" -gt 2700 ]; then
      kind delete cluster --name "$name" --kubeconfig "$config"
      break
    fi
  fi
  [ "$(( $(date +%s) - cluster_wait_start ))" -lt 1200 ] || { echo 'FAIL: existing kind lab is still active after 20 minutes' >&2; exit 1; }
  sleep 15
done
cluster_owned=1
kind create cluster --name "$name" --kubeconfig "$config" --wait 300s &
create_pid=$!
node="${name}-control-plane"
cap_deadline=$(( $(date +%s) + 120 ))
while ! docker inspect "$node" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$cap_deadline" ]; then
    kill "$create_pid" 2>/dev/null || true
    wait "$create_pid" 2>/dev/null || true
    echo 'FAIL: kind node did not appear within 120 seconds' >&2
    exit 1
  fi
  sleep 0.5
done
# kind has no create-time CPU limit, so cap the node as soon as Docker exposes it.
docker update --cpus=2 "$node" >/dev/null
[ "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$node")" = 2000000000 ] || { echo 'FAIL: could not apply 2 CPU cap to kind node' >&2; exit 1; }
wait "$create_pid"
create_pid=
KUBECONFIG="$config" kubectl config set-context kind-k8sx-alt --cluster="kind-$name" --user="kind-$name" --namespace=fixtures >/dev/null
KUBECONFIG="$config" kubectl config set-cluster ghost --server=https://127.0.0.1:1 >/dev/null
KUBECONFIG="$config" kubectl config set-context ghost --cluster=ghost --user="kind-$name" --namespace=fixtures >/dev/null
KUBECONFIG="$config" kubectl config set-cluster blackhole --server=https://10.255.255.1:6443 >/dev/null
KUBECONFIG="$config" kubectl config set-context blackhole --cluster=blackhole --user="kind-$name" --namespace=fixtures >/dev/null
node=$(KUBECONFIG="$config" kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
export KUBECONFIG="$config" HOME="$lab/home" TMPDIR="$lab/tmp" KUBERC=off K8S_AXI_LAB_LIVE=1
kubectl apply -f "$root/test/live/fixtures.yaml"
kubectl create serviceaccount limited -n fixtures
kubectl create rolebinding "limited-$name" --clusterrole=view --serviceaccount=fixtures:limited -n fixtures
limited_token=$(kubectl create token limited -n fixtures --duration=1h)
kubectl config set-credentials limited --token="$limited_token" >/dev/null
kubectl config set-context limited --cluster="kind-$name" --user=limited --namespace=fixtures >/dev/null
kubectl create serviceaccount nsonly -n fixtures
kubectl create role nsonly --verb=get,list,watch --resource=pods,events -n fixtures
kubectl create rolebinding nsonly --role=nsonly --serviceaccount=fixtures:nsonly -n fixtures
nsonly_token=$(kubectl create token nsonly -n fixtures --duration=1h)
kubectl config set-credentials nsonly --token="$nsonly_token" >/dev/null
kubectl config set-context nsonly --cluster="kind-$name" --user=nsonly --namespace=fixtures >/dev/null
kubectl wait -n fixtures --for=condition=Available deployment/web --timeout=120s
kubectl wait -n fixtures --for=condition=Ready pod/chatty --timeout=300s
kubectl wait -n fixtures --for=jsonpath='{.status.conditions[?(@.type=="Progressing")].reason}'=ProgressDeadlineExceeded deployment/broken --timeout=300s
cd "$root"
npm run build
archive=$(npm pack --silent --pack-destination "$lab")
npm install --prefix "$lab/package" --ignore-scripts --no-audit --no-fund "$lab/$archive"
export K8S_AXI_TEST_PACKAGE="$lab/package/node_modules/k8s-axi" K8S_AXI_LIMITED_TOKEN="$limited_token" K8S_AXI_NSONLY_TOKEN="$nsonly_token"
npx vitest run test/live/*.live.test.ts --reporter=default --reporter=json --outputFile "$lab/live-results.json"
node -e 'const r=require(process.argv[1]); if (!r.numTotalTests || r.numPendingTests || r.numFailedTests) { console.error("live tests did not all execute and pass", r); process.exit(1); }' "$lab/live-results.json"
