#!/usr/bin/env bash
#
# verify-patch.sh — prove that patches/n8n/*.patch still apply to the pinned n8n commit.
#
#   1. .n8n/ must be a checkout of exactly N8N_COMMIT (run scripts/bootstrap-n8n.sh first);
#      tracked files under packages/core/src are reset and untracked ones removed, so the
#      patches are always applied to the pristine commit, never on top of themselves.
#   2. Every patch, in name order, is checked with `git apply --check` and then applied.
#      A patch that no longer applies means drift: the pinned commit changed or the patch
#      was edited by hand. The script fails on the first one and leaves the tree as it is.
#   3. With --typecheck, `pnpm --filter n8n-core typecheck` runs on the patched tree; with
#      --build, `pnpm --filter n8n-core build` (the checked tsc build into packages/core/dist).
#
# The tree is left patched (that is what run-conformance.sh needs). --restore instead puts
# the pristine commit back after the check, so bootstrap-n8n.sh accepts the tree again.
#
# The patches are `git format-patch` output (one commit each, message included); `git apply`
# reads that directly. To regenerate them, see patches/n8n/README.md.
#
# Flags: --restore --typecheck --build -h|--help
# Env:   N8N_DIR (default <repo>/.n8n), PATCH_DIR (default <repo>/patches/n8n)
set -euo pipefail

N8N_COMMIT="441970b211d13a3ce547916b2b8ee93677b620e9"
# Paths the patches touch; only these are reset, node_modules/dist/.turbo are never touched.
PATCH_SCOPE=(packages/core/src)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_DIR="${N8N_DIR:-$ROOT/.n8n}"
PATCH_DIR="${PATCH_DIR:-$ROOT/patches/n8n}"

RESTORE=0; TYPECHECK=0; BUILD=0
for arg in "$@"; do
  case "$arg" in
    --restore)   RESTORE=1 ;;
    --typecheck) TYPECHECK=1 ;;
    --build)     BUILD=1 ;;
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

log "resetting ${PATCH_SCOPE[*]} in $N8N_DIR to $N8N_COMMIT"
reset_scope
if ! git -C "$N8N_DIR" diff --quiet HEAD -- ; then
  log "warning: tracked files outside ${PATCH_SCOPE[*]} are modified in $N8N_DIR; they are left alone"
fi

for p in "${patches[@]}"; do
  name=$(basename "$p")
  # git apply reads format-patch output (mail header and signature are skipped).
  if ! check=$(git -C "$N8N_DIR" apply --check "$p" 2>&1); then
    printf '%s\n' "$check" >&2
    die "$name does not apply to $N8N_COMMIT (drift)"
  fi
  git -C "$N8N_DIR" apply "$p"
  log "applied $name: $(grep -c '^diff --git' "$p") file(s)"
done
if [ $TYPECHECK -eq 1 ] || [ $BUILD -eq 1 ]; then
  export PATH="$ROOT/conformance-results/.corepack-bin:$PATH"
  export COREPACK_ENABLE_STRICT=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  command -v pnpm >/dev/null 2>&1 || die "no pnpm shim in conformance-results/.corepack-bin; run scripts/bootstrap-n8n.sh"
fi
if [ $TYPECHECK -eq 1 ]; then
  t0=$(date +%s)
  log "typechecking packages/core on the patched tree"
  (cd "$N8N_DIR" && pnpm --filter n8n-core typecheck)
  log "typecheck ok in $(( $(date +%s) - t0 ))s"
fi
if [ $BUILD -eq 1 ]; then
  t0=$(date +%s)
  log "building packages/core on the patched tree"
  (cd "$N8N_DIR" && pnpm --filter n8n-core build)
  log "build ok in $(( $(date +%s) - t0 ))s"
fi

if [ $RESTORE -eq 1 ]; then
  reset_scope
  log "all ${#patches[@]} patch(es) apply cleanly; pristine tree restored"
else
  log "all ${#patches[@]} patch(es) applied; tree is patched ($(git -C "$N8N_DIR" status --short -- "${PATCH_SCOPE[@]}" | wc -l | tr -d ' ') path(s))"
fi
