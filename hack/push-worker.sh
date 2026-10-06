#!/usr/bin/env bash
# Builds the factory worker image (Dockerfile.worker) on gtr's own amd64 buildkit ($BUILDER), since the
# laptop is arm64 and busy, and pushes it to $REG. Substrate and AX are installed on gtr from their own
# images. Prints the image with its digest, for FACTORY_AX_IMAGE. See docs/remote-runner.md.
set -euo pipefail

REG=${REG:-ghcr.io/stigenai}
BUILDER=${BUILDER:-gtr-amd64}
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
tag=$REG/factory-worker:$(git -C "$root" rev-parse --short HEAD)
meta=$(mktemp)
trap 'rm -f "$meta"' EXIT

docker buildx build --builder "$BUILDER" --platform linux/amd64 --push --metadata-file "$meta" \
  -t "$tag" -f "$root/Dockerfile.worker" "$root" >&2
echo "$tag@$(jq -r '."containerimage.digest"' "$meta")"
