#!/bin/sh
set -eu

root=$(realpath "$(dirname -- "$0")/..")
lab="$root/.lab-live"
name=k8s-axi-lab
created=0
attempting=0
kind_bin="$lab/kind"
mkdir -p "$lab/home" "$lab/tmp" "$lab/state"
export HOME="$lab/home"
export TMPDIR="$lab/tmp"
export KUBECONFIG="$lab/kubeconfig"
export K8S_AXI_KIND="$kind_bin"
export K8S_AXI_LIVE=1
export XDG_STATE_HOME="$lab/state"

cleanup() {
  if [ "$created" -eq 1 ] || { [ "$attempting" -eq 1 ] && "$kind_bin" get clusters 2>/dev/null | grep -Fx "$name" >/dev/null; }; then
    "$kind_bin" delete cluster --name "$name" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1 || true
  fi
  rm -rf "$lab"
}
trap cleanup EXIT INT TERM

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) checksum=0c8c7dbe5e23594a198b786c4bc13dacc101fa6196b0cb0b23a1ca44e61f4b4f; asset=kind-darwin-arm64 ;;
  *) echo "unsupported host for pinned kind binary: $(uname -s):$(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/$asset" -o "$kind_bin"
printf '%s  %s\n' "$checksum" "$kind_bin" | shasum -a 256 -c -
chmod 700 "$kind_bin"

cluster_exists() {
  "$kind_bin" get clusters 2>/dev/null | grep -Fx "$name" >/dev/null
}

cluster_is_stale() {
  created_at=$(docker inspect -f '{{.Created}}' "$name-control-plane" 2>/dev/null) || return 1
  created_epoch=$(TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "${created_at%%.*}" +%s 2>/dev/null) || return 1
  now=$(date +%s)
  [ "$((now - created_epoch))" -gt 2700 ]
}

deadline=$(($(date +%s) + 1200))
while :; do
  if cluster_exists; then
    if cluster_is_stale; then
      "$kind_bin" delete cluster --name "$name" --kubeconfig "$KUBECONFIG" >/dev/null
    else
      [ "$(date +%s)" -lt "$deadline" ] || { echo "timed out waiting for kind cluster: $name" >&2; exit 1; }
      sleep 5
      continue
    fi
  fi

  attempting=1
  "$kind_bin" create cluster --name "$name" --kubeconfig "$KUBECONFIG" --image kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0 --wait 120s >"$lab/create.log" 2>&1 &
  create_pid=$!
  while kill -0 "$create_pid" 2>/dev/null; do
    if docker inspect "$name-control-plane" >/dev/null 2>&1; then
      docker update --cpus=2 "$name-control-plane" >/dev/null
      break
    fi
    sleep 1
  done
  if wait "$create_pid"; then
    created=1
    attempting=0
    break
  fi
  if cluster_exists && cluster_is_stale; then
    "$kind_bin" delete cluster --name "$name" --kubeconfig "$KUBECONFIG" >/dev/null
    attempting=0
    continue
  fi
  [ "$(date +%s)" -lt "$deadline" ] || { echo "timed out acquiring kind cluster: $name" >&2; exit 1; }
  attempting=0
  sleep 5
done

"$kind_bin" export kubeconfig --name "$name" --kubeconfig "$KUBECONFIG"
kubectl --context "kind-$name" apply -f "$root/test/live/fixtures.yaml"
"$kind_bin" get clusters | grep -Fx "$name"
npm --prefix "$root" run test:live
