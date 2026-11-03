#!/usr/bin/env bash
set -eu
if ! printf '%s\n' "$TAG" | grep -Eq '^(k8s-axi-)?v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Invalid release tag: $TAG" >&2
  exit 1
fi
if [ "$GITHUB_REF" != "refs/tags/$TAG" ]; then
  echo "Dispatch this workflow on the tag: gh workflow run release-please.yml --ref $TAG -f tag=$TAG" >&2
  exit 1
fi
