#!/usr/bin/env bash
# Builds the factory worker image (Dockerfile.worker) on an amd64 buildx builder ($BUILDER) and pushes it
# to $REG. Prints the image with its digest, for FACTORY_AX_IMAGE. See docs/remote-runner.md.
set -euo pipefail

REG=${REG:?set REG to the registry and org, e.g. ghcr.io/<org>}
BUILDER=${BUILDER:?set BUILDER to an amd64 buildx builder}
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
tag=$REG/factory-worker:$(git -C "$root" rev-parse --short HEAD)
meta=$(mktemp)
trap 'rm -f "$meta"' EXIT

docker buildx build --builder "$BUILDER" --platform linux/amd64 --push --metadata-file "$meta" \
  -t "$tag" -f "$root/Dockerfile.worker" "$root" >&2
echo "$tag@$(jq -r '."containerimage.digest"' "$meta")"
