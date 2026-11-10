#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
lab="$root/.lab-live"
lock="$lab/.lock"
real_home=${HOME:?HOME is required}
# Keep leases outside the disposable lab and stable when HOME is isolated below.
BERTH_STATE=${BERTH_STATE:-${XDG_STATE_HOME:-$real_home/.local/state}/berth}
case "$BERTH_STATE" in /*) ;; *) echo 'BERTH_STATE must be absolute' >&2; exit 1 ;; esac
export BERTH_STATE
owned=0
berth_ready=0
case "${1:-}" in
  run|crashloop) mode=$1 ;;
  *) echo 'usage: scripts/lab-live.sh run|crashloop' >&2; exit 2 ;;
esac
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
command -v go >/dev/null || { echo 'Go 1.26+ is required for berth v0.2.0' >&2; exit 1; }
kind_bin="$lab/bin/kind"
berth_bin="$lab/bin/berth"
create_pid=
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  export HOME="$real_home"
  if [ -n "$create_pid" ]; then
    kill "$create_pid" 2>/dev/null || true
    wait "$create_pid" 2>/dev/null || true
    create_pid=
  fi
  if [ "$owned" = 1 ]; then
    cleanup_ok=1
    if [ "$berth_ready" = 1 ]; then
      # Lookup also finds a lease saved before an interrupted/failed create.
      if "$berth_bin" list --owner "pid:$$" --json > "$lab/leases.json" &&
        ids=$(node -e 'for (const l of require(process.argv[1]).leases) console.log(l.id)' "$lab/leases.json"); then
        for id in $ids; do
          if ! "$berth_bin" release "$id" --confirm; then cleanup_ok=0; fi
        done
      else cleanup_ok=0; fi
    fi
    if [ "$cleanup_ok" != 1 ]; then
      echo "FAIL: lease cleanup incomplete; retained $lab and $BERTH_STATE for berth sweep --confirm" >&2
      [ "$result" != 0 ] || result=1
    fi
    if [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$$" ]; then
      if [ "$cleanup_ok" = 1 ]; then
        rm -rf "$lab/bin" "$lab/home" "$lab/tmp" "$lab/package" "$lab/kubeconfig" "$lab/live-results.json" "$lab/lease-id" "$lab/leases.json"
      fi
      rm -rf "$lock"
      rmdir "$lab" 2>/dev/null || true
    fi
  fi
  exit "$result"
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
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
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
GOBIN="$lab/bin" go install github.com/Dematom1/berth@v0.2.0
[ "$("$berth_bin" --version)" = 0.2.0 ] || { echo 'FAIL: berth version mismatch' >&2; exit 1; }
berth_ready=1
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-$platform" -o "$lab/bin/kind-real"
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-$platform.sha256sum" -o "$lab/bin/kind-real.sha256"
verify "$lab/bin/kind-real"
cp "$root/scripts/lab-kind.sh" "$kind_bin"
curl -fsSL "https://dl.k8s.io/release/v1.36.2/bin/$kubectl_platform/kubectl" -o "$lab/bin/kubectl"
curl -fsSL "https://dl.k8s.io/release/v1.36.2/bin/$kubectl_platform/kubectl.sha256" -o "$lab/bin/kubectl.sha256"
verify "$lab/bin/kubectl"
chmod +x "$kind_bin" "$lab/bin/kind-real" "$lab/bin/kubectl"
PATH="$lab/bin:$PATH"
export PATH
"$berth_bin" create --adapter kind --owner "pid:$$" --ttl 1h \
  --resources '2 CPUs, k8s-axi live test lab' \
  --label project=k8s-axi --label task=lab-live --quiet > "$lab/lease-id" &
create_pid=$!
wait "$create_pid"
create_pid=
lease_id=$(cat "$lab/lease-id")
name="berth-$lease_id"
kube_env=$("$berth_bin" env "$lease_id")
eval "$kube_env"
config=$KUBECONFIG
export K8S_AXI_LAB_LEASE="$lease_id" K8S_AXI_LAB_OWNER="pid:$$"
KUBECONFIG="$config" kubectl config set-context kind-k8sx-alt --cluster="kind-$name" --user="kind-$name" --namespace=fixtures >/dev/null
KUBECONFIG="$config" kubectl config set-cluster ghost --server=https://127.0.0.1:1 >/dev/null
KUBECONFIG="$config" kubectl config set-context ghost --cluster=ghost --user="kind-$name" --namespace=fixtures >/dev/null
KUBECONFIG="$config" kubectl config set-cluster blackhole --server=https://10.255.255.1:6443 >/dev/null
KUBECONFIG="$config" kubectl config set-context blackhole --cluster=blackhole --user="kind-$name" --namespace=fixtures >/dev/null
node=$(KUBECONFIG="$config" kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
export KUBECONFIG="$config" HOME="$lab/home" TMPDIR="$lab/tmp" KUBERC=off K8S_AXI_LAB_LIVE=1 K8S_AXI_LIVE=1 K8S_AXI_KIND="$kind_bin" K8S_AXI_REAL_HOME="$real_home"
if [ "$mode" = crashloop ]; then
  (cd "$root" && bash "$root/test/live/crashloop.sh" --leased)
  exit
fi
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
kubectl wait -n fixtures --for=condition=Failed job/failjob --timeout=300s
kubectl wait -n fixtures --for=jsonpath='{.status.containerStatuses[0].restartCount}'=1 pod/crashy pod/crashy2 --timeout=300s
kubectl wait -n fixtures --for=jsonpath='{.status.conditions[?(@.type=="Progressing")].reason}'=ProgressDeadlineExceeded deployment/broken --timeout=300s
cd "$root"
npm run build
archive=$(npm pack --silent --pack-destination "$lab/tmp")
npm install --prefix "$lab/package" --ignore-scripts --no-audit --no-fund "$lab/tmp/$archive"
export K8S_AXI_TEST_PACKAGE="$lab/package/node_modules/k8s-axi" K8S_AXI_LIMITED_TOKEN="$limited_token" K8S_AXI_NSONLY_TOKEN="$nsonly_token"
npx vitest run test/live/*.live.test.ts --reporter=default --reporter=json --outputFile "$lab/live-results.json"
node -e 'const r=require(process.argv[1]); if (!r.numTotalTests || r.numPendingTests || r.numFailedTests) { console.error("live tests did not all execute and pass", r); process.exit(1); }' "$lab/live-results.json"
