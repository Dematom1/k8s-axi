#!/bin/sh
set -eu

root=$(realpath "$(dirname -- "$0")/..")
lab="$root/.lab-live"
lock=/tmp/k8s-axi-kind-lab.lock
name=k8s-axi-live
created=0
locked=0
kind_bin="$lab/kind"

cleanup() {
  if [ "$created" -eq 1 ]; then
    KUBECONFIG="$lab/kubeconfig" "$kind_bin" delete cluster --name "$name" >/dev/null 2>&1 || true
  fi
  rm -rf "$lab"
  if [ "$locked" -eq 1 ]; then
    rm -f "$lock/pid"
    rmdir "$lock"
  fi
}
trap cleanup EXIT INT TERM

if ! mkdir "$lock" 2>/dev/null; then
  echo "kind lab lock is held: $lock" >&2
  exit 1
fi
locked=1
printf '%s\n' "$$" > "$lock/pid"
mkdir -p "$lab"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) checksum=0c8c7dbe5e23594a198b786c4bc13dacc101fa6196b0cb0b23a1ca44e61f4b4f; asset=kind-darwin-arm64 ;;
  *) echo "unsupported host for pinned kind binary: $(uname -s):$(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/$asset" -o "$kind_bin"
printf '%s  %s\n' "$checksum" "$kind_bin" | shasum -a 256 -c -
chmod 700 "$kind_bin"

export KUBECONFIG="$lab/kubeconfig"
export K8S_AXI_KIND="$kind_bin"
export K8S_AXI_LIVE=1
export XDG_STATE_HOME="$lab/state"
created=1
"$kind_bin" create cluster --name "$name" --image kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0 --wait 120s
docker update --cpus=2 "${name}-control-plane" >/dev/null
"$kind_bin" export kubeconfig --name "$name" --kubeconfig "$KUBECONFIG"
kubectl --context "kind-$name" apply -f "$root/test/live/fixtures.yaml"
"$kind_bin" get clusters | grep -Fx "$name"
npm --prefix "$root" run test:live
