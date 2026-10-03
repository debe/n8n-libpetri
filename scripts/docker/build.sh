#!/usr/bin/env bash
#
# build.sh — build the n8n-libpetri Docker image locally from an `npm pack` of this repository
# (tasks/inject-plan.md decision 12; v1 path only). Never pushes.
#
#   scripts/docker/build.sh [n8n-version] [--tarball <n8n-libpetri-*.tgz>] [--allow-unverified]
#
# Default n8n version 2.41.6. Without --tarball it runs `npm run build` and `npm pack` in
# typescript/. The build context is staged in a temporary directory holding only the tarball
# and docker/entrypoint.sh, so nothing else from the repository reaches the image.
#
# The tag is local: n8n-libpetri:<package version>-n8n<n8n version>. The shipped seams carry a
# passing release-neutrality record (scripts/release/neutrality.sh, docs/conformance-release.md),
# so the installer runs without --allow-unverified. Pass --allow-unverified here only to build
# seams that do not have one yet; the installer's record and `status` then say so.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
N8N_VERSION=2.41.6
TARBALL=""
INSTALL_FLAGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-unverified) INSTALL_FLAGS="--allow-unverified"; shift ;;
    --tarball) TARBALL="${2:?--tarball needs a path}"; shift 2 ;;
    --tarball=*) TARBALL="${1#--tarball=}"; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "build.sh: unknown flag $1" >&2; exit 2 ;;
    *) N8N_VERSION="$1"; shift ;;
  esac
done

log() { printf '[docker-build] %s\n' "$*"; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/n8n-libpetri-docker.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

if [ -z "$TARBALL" ]; then
  log "npm run build && npm pack (typescript/)"
  (cd "$ROOT/typescript" && npm run build >/dev/null && npm pack --pack-destination "$STAGE" >/dev/null)
  TARBALL="$(ls "$STAGE"/n8n-libpetri-*.tgz)"
fi
[ -f "$TARBALL" ] || { echo "build.sh: no tarball at $TARBALL" >&2; exit 1; }
cp "$TARBALL" "$STAGE/n8n-libpetri.tgz"
cp "$ROOT/docker/entrypoint.sh" "$STAGE/entrypoint.sh"

VERSION="$(tar -xOzf "$STAGE/n8n-libpetri.tgz" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
TAG="n8n-libpetri:${VERSION}-n8n${N8N_VERSION}"

log "building $TAG on n8nio/n8n:${N8N_VERSION}${INSTALL_FLAGS:+ (install $INSTALL_FLAGS)}"
docker build \
  --file "$ROOT/docker/Dockerfile" \
  --build-arg "N8N_VERSION=${N8N_VERSION}" \
  --build-arg "N8N_LIBPETRI_INSTALL_FLAGS=${INSTALL_FLAGS}" \
  --tag "$TAG" \
  "$STAGE"
log "built $TAG (local only; not pushed)"
echo "$TAG"
