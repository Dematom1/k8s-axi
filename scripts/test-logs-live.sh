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
if command -v shasum >/dev/null; then
  actual=$(shasum -a 256 "$kind_bin" | awk '{print $1}')
else
  actual=$(sha256sum "$kind_bin" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || { echo 'FAIL: kind checksum mismatch' >&2; exit 1; }
chmod +x "$kind_bin"
export PATH="$lab/bin:/usr/local/bin:$PATH"
export HOME="$lab/home" TMPDIR="$lab/tmp" KUBECONFIG="$lab/kubeconfig"
mkdir -p "$HOME" "$TMPDIR"
node_container="$name-control-plane"
acquired=0
cleanup() { if [ "$acquired" = 1 ]; then kind delete cluster --name "$name" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT INT TERM
is_stale_cluster() {
  created=$(docker inspect -f '{{.Created}}' "$node_container")
  python3 -c 'import datetime,sys; created=datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")); now=datetime.datetime.now(datetime.timezone.utc); sys.exit(0 if (now-created).total_seconds()>2700 else 1)' "$created"
}
start=$SECONDS
while [ $((SECONDS - start)) -lt 1200 ]; do
  if docker inspect "$node_container" >/dev/null 2>&1; then
    if is_stale_cluster; then
      kind delete cluster --name "$name"
      continue
    fi
    sleep 15
    continue
  fi
  create_started=$(date +%s)
  kind create cluster --name "$name" --kubeconfig "$KUBECONFIG" >"$lab/kind-create.log" 2>&1 &
  create_pid=$!
  capped=0
  while kill -0 "$create_pid" 2>/dev/null; do
    if docker inspect "$node_container" >/dev/null 2>&1; then
      created=$(docker inspect -f '{{.Created}}' "$node_container")
      if python3 -c 'import datetime,sys; created=datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")); sys.exit(0 if created.timestamp()>=int(sys.argv[2]) else 1)' "$created" "$create_started"; then
        acquired=1
        docker update --cpus=2 "$node_container"
        capped=1
        break
      fi
    fi
    sleep 2
  done
  if wait "$create_pid"; then
    acquired=1
    [ "$capped" = 1 ] || docker update --cpus=2 "$node_container"
    break
  fi
  if ! grep -Eqi 'already exists|node\(s\) already exist' "$lab/kind-create.log"; then
    cat "$lab/kind-create.log" >&2
    echo 'FAIL: could not create kind cluster' >&2
    exit 1
  fi
  if docker inspect "$node_container" >/dev/null 2>&1 && is_stale_cluster; then
    kind delete cluster --name "$name"
    continue
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
ready=0
for _ in $(seq 1 60); do
  if kubectl --kubeconfig "$KUBECONFIG" -n fixtures logs chatty >"$lab/chatty.log" 2>/dev/null &&
    kubectl --kubeconfig "$KUBECONFIG" -n fixtures logs web >"$lab/web.log" 2>/dev/null &&
    grep -Fq 'line 2999' "$lab/chatty.log" &&
    grep -Fq 'password=secret' "$lab/web.log" &&
    grep -Fq 'Authorization: Bearer token' "$lab/web.log"; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" = 1 ] || { echo 'FAIL: fixture logs did not become ready within 120 seconds' >&2; exit 1; }
check_tail() {
  tail=$1
  first=$2
  out=$(node "$root/dist/bin/k8s-axi.js" pods logs chatty -n fixtures --tail "$tail")
  printf '%s\n' "$out" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk).on("end", () => {
      import("@toon-format/toon").then(({ decode }) => {
      const result = decode(input), expected = Number(process.argv[1]), first = Number(process.argv[2]);
      const lines = result.logs;
      if (lines.length !== expected || lines[0] !== `line ${first}` || lines.at(-1) !== "line 2999" || lines.some((line, i) => line !== `line ${first + i}`)) {
        console.error(`FAIL: --tail ${expected} did not return the exact ordered tail`);
        process.exitCode = 1;
      }
      });
    });
  ' "$tail" "$first" || exit 1
  if [ "$tail" = 1000 ]; then
    printf '%s\n' "$out" | node --input-type=module -e '
      import { decode } from "@toon-format/toon";
      let input = "";
      process.stdin.on("data", chunk => input += chunk).on("end", () => {
        const result = decode(input);
        if (!result.help?.some(hint => hint.includes("--tail 1000"))) {
          console.error("FAIL: full tail must offer a continuation hint with --tail 1000");
          process.exitCode = 1;
        }
      });
    ' || exit 1
  fi
}
check_tail 100 2900
check_tail 1000 2000
if node "$root/dist/bin/k8s-axi.js" pods logs chatty -n fixtures --previous >"$lab/previous.out" 2>&1; then
  echo 'FAIL: missing previous-container logs unexpectedly succeeded' >&2
  exit 1
else
  status=$?
fi
[ "$status" = 1 ] || { echo "FAIL: missing previous logs exited $status, expected 1" >&2; exit 1; }
grep -F 'LOGS_UNAVAILABLE' "$lab/previous.out" >/dev/null || { echo 'FAIL: missing previous logs were not LOGS_UNAVAILABLE' >&2; exit 1; }
web_out=$(node "$root/dist/bin/k8s-axi.js" pods logs web -n fixtures)
printf '%s\n' "$web_out" | node --input-type=module -e '
  import { decode } from "@toon-format/toon";
  let input = "";
  process.stdin.on("data", chunk => input += chunk).on("end", () => {
    const result = decode(input), logs = result.logs.join("\\n");
    if (result.redacted !== 2 || !logs.includes("password=[REDACTED]") || !logs.includes("Bearer [REDACTED]") || logs.includes("secret") || logs.includes("token")) {
      console.error("FAIL: web log redaction markers or baseline changed");
      process.exitCode = 1;
    }
  });
' || exit 1
echo 'PASS: exact log tails, missing-previous error, and web redaction count'
