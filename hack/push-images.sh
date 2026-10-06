#!/usr/bin/env bash
# Builds every image the AX runner on gtr needs and pushes it to $REG: Substrate's components (what
# `ate-setup deploy --image-repo $REG/substrate --image-tag $SUB_REF` installs), its envoy-dataplane,
# AX's server, and the factory worker. Substrate and AX publish no pullable images, and the laptop is
# arm64 and busy, so everything builds on gtr's own amd64 buildkit ($BUILDER) from git, without ko:
# each Go component becomes the image ko would make, its binary at /ko-app/<name> on the same base.
# Prints each image with its digest. See docs/remote-runner.md.
set -euo pipefail

REG=${REG:-ghcr.io/stigenai}
BUILDER=${BUILDER:-gtr-amd64}
SUB=https://github.com/agent-substrate/substrate.git
SUB_REF=${SUB_REF:-v0.3.0}
AX=https://github.com/google/ax.git
AX_REF=${AX_REF:-ac2332829f22360ff97b0ba34d94dd0dd782f17e}
STATIC=gcr.io/distroless/static-debian13:latest@sha256:f2ea2709ac8db56323cbd7d014277f32cb572d9ea124b0076f7aafe5980678fe
CHAINGUARD=cgr.dev/chainguard/static:latest
EMPTY=$(mktemp -d)
trap 'rm -rf "$EMPTY"' EXIT

build() { # tag, then buildx args
  local tag=$1
  shift
  docker buildx build --builder "$BUILDER" --platform linux/amd64 --push \
    --metadata-file "$EMPTY/meta.json" -t "$tag" "$@" >&2
  echo "$tag@$(jq -r '."containerimage.digest"' "$EMPTY/meta.json")"
}

go_image() { # repo, ref, package, base, tag, ldflags
  local name
  name=$(basename "$3")
  build "$5" -f - "$EMPTY" <<EOF
FROM golang:1.27-bookworm AS build
RUN git init -q /src && git -C /src fetch -q --depth 1 $1 $2 && git -C /src checkout -q FETCH_HEAD
WORKDIR /src
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w $6" -o /app ./$3
FROM $4
COPY --from=build /app /ko-app/$name
ENTRYPOINT ["/ko-app/$name"]
EOF
}

version=-X=github.com/agent-substrate/substrate/internal/version.Version=$SUB_REF
for pkg in cmd/ateapi cmd/atecontroller cmd/atelet cmd/atenet cmd/ateom-gvisor cmd/ateom-microvm \
  cmd/credential-provider/kubernetes-secrets cmd/podcertcontroller \
  demos/counter demos/egress demos/multi-template/fspersist demos/sandbox; do
  base=$STATIC
  # the overrides in Substrate's .ko.yaml at v0.3.0
  [ "$pkg" = cmd/ateom-microvm ] && base=debian:13-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132
  [ "$pkg" = demos/sandbox ] && base=alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
  go_image "$SUB" "$SUB_REF" "$pkg" "$base" "$REG/substrate/$(basename "$pkg"):$SUB_REF" "$version"
done
build "$REG/substrate/envoy-dataplane:$SUB_REF" "$SUB#$SUB_REF:cmd/dataplane/envoy"

go_image "$AX" "$AX_REF" cmd/ax-server "$CHAINGUARD" "$REG/ax/ax-server:${AX_REF:0:7}" ""

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
build "$REG/factory-worker:$(git -C "$root" rev-parse --short HEAD)" \
  --build-arg AX_COMMIT="$AX_REF" -f "$root/Dockerfile.worker" "$root"
