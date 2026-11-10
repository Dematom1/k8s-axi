#!/bin/sh
# Berth invokes kind synchronously; keep the lab's CPU cap during creation too.
set -eu
kind_bin="$(dirname -- "$0")/kind-real"
if [ "${1:-} ${2:-}" != 'create cluster' ]; then exec "$kind_bin" "$@"; fi
name=
previous=
for arg do
  if [ "$previous" = --name ]; then name=$arg; fi
  previous=$arg
done
[ -n "$name" ] || { echo 'FAIL: kind create requires --name' >&2; exit 1; }
create_pid=
cleanup() {
  if [ -n "$create_pid" ]; then
    kill "$create_pid" 2>/dev/null || true
    wait "$create_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
"$kind_bin" "$@" &
create_pid=$!
node_container="${name}-control-plane"
cap_deadline=$(( $(date +%s) + 300 ))
while ! docker inspect "$node_container" >/dev/null 2>&1; do
  kill -0 "$create_pid" 2>/dev/null || { wait "$create_pid"; exit 1; }
  [ "$(date +%s)" -lt "$cap_deadline" ] || { echo 'FAIL: kind node did not appear within 300 seconds' >&2; exit 1; }
  sleep 0.5
done
# kind has no create-time CPU limit, so cap as soon as Docker exposes the node.
docker update --cpus=2 "$node_container" >/dev/null
[ "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$node_container")" = 2000000000 ] || {
  echo 'FAIL: could not verify 2 CPU cap on kind node' >&2
  exit 1
}
wait "$create_pid"
create_pid=
