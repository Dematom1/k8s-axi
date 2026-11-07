#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
lab="$root/.lab-live"
name="k8s-axi-lab-$$"
config="$lab/kubeconfig"
[ "${1:-}" = run ] || { echo 'usage: scripts/lab-live.sh run' >&2; exit 2; }
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
lock=${K8S_AXI_LAB_LOCK:-/tmp/k8s-axi-kind-lab.lock}
start=$(date +%s)
while ! mkdir "$lock" 2>/dev/null; do
  if [ -f "$lock/pid" ]; then
    mtime=$(stat -c %Y "$lock" 2>/dev/null || stat -f %m "$lock" 2>/dev/null || echo 0)
    if [ "$(( $(date +%s) - mtime ))" -gt 1800 ]; then
      pid=$(cat "$lock/pid" 2>/dev/null || true)
      if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
    fi
  fi
  [ "$(( $(date +%s) - start ))" -lt 1200 ] || { echo 'FAIL: timed out waiting 20 minutes for the shared kind lab lock' >&2; exit 1; }
  sleep 10
done
printf '%s\n' "$$" > "$lock/pid"
mkdir -p "$lab/bin" "$lab/home" "$lab/tmp"
kind_bin="$lab/bin/kind"
cleanup() {
  if [ -x "$kind_bin" ]; then KUBECONFIG="$config" "$kind_bin" delete cluster --name "$name" >/dev/null 2>&1 || true; fi
  rm -rf "$lab" "$lock"
}
trap cleanup EXIT HUP INT TERM
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
kind create cluster --name "$name" --kubeconfig "$config" --wait 120s
KUBECONFIG="$config" kubectl config set-context kind-k8sx-alt --cluster="kind-$name" --user="kind-$name" --namespace=fixtures >/dev/null
KUBECONFIG="$config" kubectl config set-cluster ghost --server=https://127.0.0.1:1 >/dev/null
KUBECONFIG="$config" kubectl config set-context ghost --cluster=ghost --user="kind-$name" --namespace=fixtures >/dev/null
KUBECONFIG="$config" kubectl config set-cluster blackhole --server=https://10.255.255.1:6443 >/dev/null
KUBECONFIG="$config" kubectl config set-context blackhole --cluster=blackhole --user="kind-$name" --namespace=fixtures >/dev/null
node=$(KUBECONFIG="$config" kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
docker update --cpus=2 "$node" >/dev/null
export KUBECONFIG="$config" HOME="$lab/home" TMPDIR="$lab/tmp" KUBERC=off K8S_AXI_LAB_LIVE=1
kubectl apply -f "$root/test/live/fixtures.yaml"
kubectl create serviceaccount limited -n fixtures
kubectl create clusterrolebinding "limited-$name" --clusterrole=view --serviceaccount=fixtures:limited
kubectl config set-credentials limited --token="$(kubectl create token limited -n fixtures --duration=1h)" >/dev/null
kubectl config set-context limited --cluster="kind-$name" --user=limited --namespace=fixtures >/dev/null
kubectl create serviceaccount nsonly -n fixtures
kubectl create role nsonly --verb=get,list,watch --resource=pods,events -n fixtures
kubectl create rolebinding nsonly --role=nsonly --serviceaccount=fixtures:nsonly -n fixtures
kubectl config set-credentials nsonly --token="$(kubectl create token nsonly -n fixtures --duration=1h)" >/dev/null
kubectl config set-context nsonly --cluster="kind-$name" --user=nsonly --namespace=fixtures >/dev/null
kubectl wait -n fixtures --for=condition=Available deployment/web --timeout=120s
kubectl wait -n fixtures --for=condition=Ready pod/chatty --timeout=120s
cd "$root"
npm run build
archive=$(npm pack --silent --pack-destination "$lab")
npm install --prefix "$lab/package" --ignore-scripts --no-audit --no-fund "$lab/$archive"
export K8S_AXI_TEST_PACKAGE="$lab/package/node_modules/k8s-axi"
npx vitest run test/live/*.live.test.ts --reporter=default --reporter=json --outputFile "$lab/live-results.json"
node -e 'const r=require(process.argv[1]); if (!r.numTotalTests || r.numPendingTests || r.numFailedTests) { console.error("live tests did not all execute and pass", r); process.exit(1); }' "$lab/live-results.json"
