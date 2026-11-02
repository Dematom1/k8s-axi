#!/bin/sh
set -eu
version=${KUBECTL_VERSION:-v1.36.2}
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in aarch64|arm64) arch=arm64;; x86_64) arch=amd64;; esac
case "$version/$os/$arch" in
v1.36.2/darwin/arm64) hash=4408c85c83fd3a31adaa555bdf3c7a6c81f74b19449a9060ba31ab91926f023d;;
v1.36.2/darwin/amd64) hash=ce6c5e55cd17559e87e4fb5e73ebbbc2511bcf2b695d7a40c1b1461a9817d4b3;;
v1.36.2/linux/arm64) hash=c957eb8c4bea27a3bb35b269edd9082e27f027f7b76b20b5bf4afebc726c6d3e;;
v1.36.2/linux/amd64) hash=1e9045ec32bea85da43de85f0065358529ea7c7a152eca78154fba5b58c27d82;;
v1.32.0/darwin/arm64) hash=5bfd5de53a054b4ef614c60748e28bf47441c7ed4db47ec3c19a3e2fa0eb5555;;
v1.32.0/darwin/amd64) hash=516585916f499077fac8c2fdd2a382818683f831020277472e6bcf8d1a6f9be4;;
v1.32.0/linux/arm64) hash=ba4004f98f3d3a7b7d2954ff0a424caa2c2b06b78c17b1dccf2acc76a311a896;;
v1.32.0/linux/amd64) hash=646d58f6d98ee670a71d9cdffbf6625aeea2849d567f214bc43a35f8ccb7bf70;;
*) echo 'unsupported kubectl pin' >&2; exit 1;;
esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
curl --fail --silent --show-error --location --max-time 120 "https://dl.k8s.io/release/$version/bin/$os/$arch/kubectl" -o "$scratch/kubectl"
printf '%s  %s\n' "$hash" "$scratch/kubectl" > "$scratch/checksum"
if command -v sha256sum >/dev/null; then sha256sum -c "$scratch/checksum" >&2; else shasum -a 256 -c "$scratch/checksum" >&2; fi
chmod +x "$scratch/kubectl"
PATH="$scratch:$PATH" K8S_AXI_REQUIRE_REAL_KUBECTL=1 npm run test:real
