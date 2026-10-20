#!/usr/bin/env bash
# Builds the factory worker image (Dockerfile.worker) on an amd64 buildx builder ($BUILDER) and pushes it
# to $REG. TARGET=manager builds the manager image and tags it factory-manager. Prints the image with its digest, for FACTORY_AX_IMAGE. See docs/remote-runner.md.
# Optional: AX_CLI_REPO and AX_CLI_COMMIT build the manager's ax CLI from a fork of google/ax with the AX_ROUTER dial.
set -euo pipefail

TARGET=${TARGET:-worker}
case $TARGET in worker | manager) ;; *) echo "TARGET must be worker or manager" >&2 && exit 2 ;; esac
REG=${REG:?set REG to the registry and org, e.g. ghcr.io/<org>}
BUILDER=${BUILDER:?set BUILDER to an amd64 buildx builder}
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
tag=$REG/factory-$TARGET:$(git -C "$root" rev-parse --short HEAD)
meta=$(mktemp)
trap 'rm -f "$meta"' EXIT

args=()
[[ -z ${AX_CLI_REPO:-} ]] || args+=(--build-arg "AX_CLI_REPO=$AX_CLI_REPO")
[[ -z ${AX_CLI_COMMIT:-} ]] || args+=(--build-arg "AX_CLI_COMMIT=$AX_CLI_COMMIT")

docker buildx build --builder "$BUILDER" --platform linux/amd64 --target "$TARGET" --push --metadata-file "$meta" ${args[@]+"${args[@]}"} \
  -t "$tag" -f "$root/Dockerfile.worker" "$root" >&2
echo "$tag@$(jq -r '."containerimage.digest"' "$meta")"
