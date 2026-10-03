#!/usr/bin/env bash
#
# verify-patch.sh — prove that patches/n8n/*.patch still apply to the pinned n8n commit.
#
#   1. .n8n/ must be a checkout of exactly N8N_COMMIT (run scripts/bootstrap-n8n.sh first);
#      tracked files under PATCH_SCOPE (packages/core/src, packages/@n8n/engine/src) are reset
#      and untracked ones removed, so the patches are always applied to the pristine commit,
#      never on top of themselves.
#   2. Every patch, in name order, is checked with `git apply --check` and then applied.
#      A patch that no longer applies means drift: the pinned commit changed or the patch
#      was edited by hand. The script fails on the first one and leaves the tree as it is.
#   3. With --typecheck, `pnpm --filter <pkg> typecheck` runs on the patched tree for each
#      package in CHECK_PACKAGES (n8n-core, @n8n/engine, @n8n/node-engine-compatibility); with
#      --build, `pnpm --filter <pkg> build` (the checked tsc build into each package's dist),
#      in that order, so compat builds against the patched engine. With --lint, each package
#      in LINT_PACKAGES (@n8n/engine) runs its own `lint` (oxlint) and `format:check`
#      (`biome ci src`) scripts.
#
# The tree is left patched (that is what run-conformance.sh needs). --restore instead puts
# the pristine commit back after the check, so bootstrap-n8n.sh accepts the tree again.
#
# The patches are `git format-patch` output (one commit each, message included); `git apply`
# reads that directly. To regenerate them, see patches/n8n/README.md.
#
# Flags: --restore --typecheck --build --lint -h|--help
# Env:   N8N_DIR (default <repo>/.n8n), PATCH_DIR (default <repo>/patches/n8n)
set -euo pipefail

# shellcheck source=n8n-pin.sh
. "$(dirname "${BASH_SOURCE[0]}")/n8n-pin.sh"
# Paths the patches touch; only these are reset, node_modules/dist/.turbo are never touched.
PATCH_SCOPE=(packages/core/src packages/@n8n/engine/src)
# What --typecheck and --build cover, in build order: compat depends on the engine.
CHECK_PACKAGES=(n8n-core @n8n/engine @n8n/node-engine-compatibility)
# What --lint covers: the packages whose source a patch changes outside packages/core.
LINT_PACKAGES=(@n8n/engine)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_DIR="${N8N_DIR:-$ROOT/.n8n}"
PATCH_DIR="${PATCH_DIR:-$ROOT/patches/n8n}"

RESTORE=0; TYPECHECK=0; BUILD=0; LINT=0
for arg in "$@"; do
  case "$arg" in
    --restore)   RESTORE=1 ;;
    --typecheck) TYPECHECK=1 ;;
    --build)     BUILD=1 ;;
    --lint)      LINT=1 ;;
    -h|--help)   sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log() { printf '[verify-patch %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "error: $*" >&2; exit 1; }

[ -d "$N8N_DIR/.git" ] || die "$N8N_DIR is not a git checkout; run scripts/bootstrap-n8n.sh"
head=$(git -C "$N8N_DIR" rev-parse HEAD)
[ "$head" = "$N8N_COMMIT" ] || die "HEAD of $N8N_DIR is $head, expected $N8N_COMMIT (drift, or a commit was made in the clone)"

reset_scope() {
  git -C "$N8N_DIR" checkout -q -- "${PATCH_SCOPE[@]}"
  git -C "$N8N_DIR" clean -fdq -- "${PATCH_SCOPE[@]}"
  git -C "$N8N_DIR" diff --quiet HEAD -- "${PATCH_SCOPE[@]}" || die "could not reset ${PATCH_SCOPE[*]}"
}

shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)
shopt -u nullglob
[ ${#patches[@]} -gt 0 ] || die "no patches in $PATCH_DIR"

log "resetting ${PATCH_SCOPE[*]} in $N8N_DIR to $N8N_TAG ($N8N_COMMIT)"
reset_scope
if ! git -C "$N8N_DIR" diff --quiet HEAD -- ; then
  log "warning: tracked files outside ${PATCH_SCOPE[*]} are modified in $N8N_DIR; they are left alone"
fi

for p in "${patches[@]}"; do
  name=$(basename "$p")
  # git apply reads format-patch output (mail header and signature are skipped).
  if ! check=$(git -C "$N8N_DIR" apply --check "$p" 2>&1); then
    printf '%s\n' "$check" >&2
    die "$name does not apply to $N8N_TAG ($N8N_COMMIT) (drift)"
  fi
  git -C "$N8N_DIR" apply "$p"
  log "applied $name: $(grep -c '^diff --git' "$p") file(s)"
done
if [ $TYPECHECK -eq 1 ] || [ $BUILD -eq 1 ] || [ $LINT -eq 1 ]; then
  export PATH="$ROOT/conformance-results/.corepack-bin:$PATH"
  export COREPACK_ENABLE_STRICT=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  command -v pnpm >/dev/null 2>&1 || die "no pnpm shim in conformance-results/.corepack-bin; run scripts/bootstrap-n8n.sh"
fi
if [ $TYPECHECK -eq 1 ]; then
  for pkg in "${CHECK_PACKAGES[@]}"; do
    t0=$(date +%s)
    log "typechecking $pkg on the patched tree"
    (cd "$N8N_DIR" && pnpm --filter "$pkg" typecheck)
    log "$pkg: typecheck ok in $(( $(date +%s) - t0 ))s"
  done
fi
if [ $BUILD -eq 1 ]; then
  for pkg in "${CHECK_PACKAGES[@]}"; do
    t0=$(date +%s)
    log "building $pkg on the patched tree"
    (cd "$N8N_DIR" && pnpm --filter "$pkg" build)
    log "$pkg: build ok in $(( $(date +%s) - t0 ))s"
  done
fi
if [ $LINT -eq 1 ]; then
  for pkg in "${LINT_PACKAGES[@]}"; do
    t0=$(date +%s)
    log "linting $pkg on the patched tree (oxlint, then biome ci src)"
    (cd "$N8N_DIR" && pnpm --filter "$pkg" lint && pnpm --filter "$pkg" format:check)
    log "$pkg: lint ok in $(( $(date +%s) - t0 ))s"
  done
fi

if [ $RESTORE -eq 1 ]; then
  reset_scope
  log "all ${#patches[@]} patch(es) apply cleanly; pristine tree restored"
else
  log "all ${#patches[@]} patch(es) applied; tree is patched ($(git -C "$N8N_DIR" status --short -- "${PATCH_SCOPE[@]}" | wc -l | tr -d ' ') path(s))"
fi
