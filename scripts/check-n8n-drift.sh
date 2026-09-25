#!/usr/bin/env bash
#
# check-n8n-drift.sh: report how far n8n has moved from the pin, without touching the checkout.
#
#   1. Fetches tags and master into .n8n/ (refs only; the working tree and HEAD are left alone).
#   2. For the pin, `stable`, `beta`, the newest release tag and origin/master: applies the
#      patches, in name order, to a throwaway index read from that ref (GIT_INDEX_FILE in a temp
#      dir). A patch that does not apply is drift a re-pin has to resolve by rebasing.
#   3. Lists the commits since the pin that touch what the patches rest on
#      (`workflow-execute.ts`, the scheduler seam files) and n8n's engine v2 (`packages/@n8n/engine`,
#      `packages/@n8n/node-engine-compatibility`), each measured to the newest release and to master.
#
# Read-only for the checkout: no checkout, no reset, no commit. Exit 0 when every ref applies
# cleanly, 1 when at least one does not, 2 on usage errors.
#
# Flags: --no-fetch -h|--help
# Env:   N8N_DIR (default <repo>/.n8n), PATCH_DIR (default <repo>/patches/n8n)
set -euo pipefail

# shellcheck source=n8n-pin.sh
. "$(dirname "${BASH_SOURCE[0]}")/n8n-pin.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_DIR="${N8N_DIR:-$ROOT/.n8n}"
PATCH_DIR="${PATCH_DIR:-$ROOT/patches/n8n}"

FETCH=1
for arg in "$@"; do
  case "$arg" in
    --no-fetch) FETCH=0 ;;
    -h|--help)  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log() { printf '[drift %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "error: $*" >&2; exit 2; }

[ -d "$N8N_DIR/.git" ] || die "$N8N_DIR is not a git checkout; run scripts/bootstrap-n8n.sh"
g() { git -C "$N8N_DIR" "$@"; }

if [ $FETCH -eq 1 ]; then
  log "fetching tags and master"
  # The bootstrap clone is shallow; --tags on a shallow repo fetches the tagged commits, and
  # master's history back to them is what the commit listings below need.
  g fetch -q --tags origin '+refs/heads/master:refs/remotes/origin/master'
  g cat-file -e "$N8N_COMMIT^{commit}" 2>/dev/null || g fetch -q --depth 1 origin "$N8N_COMMIT"
fi

shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)
shopt -u nullglob
[ ${#patches[@]} -gt 0 ] || die "no patches in $PATCH_DIR"

newest=$(g tag --list 'n8n@*' --sort=-v:refname | head -1)
refs=("$N8N_COMMIT" stable beta "$newest" origin/master)
labels=("pin $N8N_TAG" stable beta "newest $newest" master)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

drift=0
printf '\n%-24s %-12s %-10s %s\n' ref commit date patches
for i in "${!refs[@]}"; do
  ref=${refs[$i]}
  if ! sha=$(g rev-parse -q --verify "$ref^{commit}" 2>/dev/null); then
    printf '%-24s %s\n' "${labels[$i]}" "(missing; fetch it or drop it)"; continue
  fi
  date=$(g log -1 --format=%cs "$sha")
  status=clean
  export GIT_INDEX_FILE="$TMP/index"
  g read-tree "$sha"
  for p in "${patches[@]}"; do
    # Sequential apply into the throwaway index: patch 0002 is written against 0001's result.
    if ! g apply --cached "$p" 2>"$TMP/err"; then
      status="DRIFT at $(basename "$p"): $(head -1 "$TMP/err")"; drift=1; break
    fi
  done
  unset GIT_INDEX_FILE
  printf '%-24s %-12s %-10s %s\n' "${labels[$i]}" "${sha:0:10}" "$date" "$status"
done

since() {
  local to=$1; shift
  g log --oneline --no-merges "$N8N_COMMIT..$to" -- "$@" 2>/dev/null || true
}

SEAM=(packages/core/src/execution-engine/workflow-execute.ts
      packages/core/src/execution-engine/index.ts)
ENGINE=(packages/@n8n/engine packages/@n8n/node-engine-compatibility packages/cli/src/modules/engine-v2)

for to in "$newest" origin/master; do
  printf '\n== commits since the pin touching the seam, to %s\n' "$to"
  since "$to" "${SEAM[@]}" | sed 's/^/  /'
  printf '\n== engine v2 commits since the pin, to %s: %s\n' "$to" "$(since "$to" "${ENGINE[@]}" | wc -l | tr -d ' ')"
done
printf '\n'
since origin/master "${ENGINE[@]}" | head -15 | sed 's/^/  /'

[ $drift -eq 0 ] && log "every ref applies cleanly" || log "drift found; see patches/n8n/README.md § Regenerate"
exit $drift
