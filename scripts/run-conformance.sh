#!/usr/bin/env bash
#
# run-conformance.sh — n8n's execution-engine suite under each scheduler, as a matrix.
#
#   1. scripts/verify-patch.sh puts the two patches onto the pinned commit in .n8n/
#      (skipped with --skip-patch; the tree must then already be patched). With --typecheck
#      it also typechecks and builds packages/core on the patched tree first.
#   2. For each engine, the suite runs with CI=true (junit reporter on) and
#      N8N_EXECUTION_ENGINE=<engine>; the junit lands in conformance-results/<engine>.junit.xml.
#        legacy    StackScheduler, i.e. n8n's own loop behind the seam. Must be identical to
#                  the unpatched baseline (conformance-results/baseline.junit.xml).
#        libpetri  PetriScheduler, registered through setWorkflowSchedulerFactory() from a
#                  generated vitest setup shim inside the n8n tree — see LIBPETRI_HOOK below.
#                  Skipped until n8n-libpetri's build (typescript/dist) exists.
#      The patched n8n never reads N8N_EXECUTION_ENGINE itself (patch 0002 is a plain
#      registry); the shim does, and registers the PetriScheduler when it is `libpetri`.
#   3. typescript/src/conformance/cli.ts turns baseline + <engine>.junit.xml into
#      conformance-results/<engine>.matrix.md; the headline is loop-driving cases passed.
#
# Exit status: non-zero when the legacy run is not identical to the baseline, when the
# libpetri run regresses a case the baseline passes, or when a run fails to produce junit.
#
# Flags: --skip-patch --typecheck --engines=legacy,libpetri -h|--help
# Env:   N8N_DIR (default <repo>/.n8n), N8N_TEST_FILTER (default src/execution-engine),
#        LIBPETRI_HOOK (default <repo>/typescript/dist/n8n-vitest-setup.js)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_DIR="${N8N_DIR:-$ROOT/.n8n}"
RESULTS="$ROOT/conformance-results"
N8N_TEST_FILTER="${N8N_TEST_FILTER:-src/execution-engine}"
BASELINE="$RESULTS/baseline.junit.xml"
CLI="$ROOT/typescript/src/conformance/cli.ts"

# ---------------------------------------------------------------------------------------------
# HOOK (milestone M2): the libpetri engine is wired in by a vitest setup shim the script
# generates INSIDE the n8n tree, packages/core/.n8n-libpetri-setup.mjs, because the modules
# it needs resolve only from there: `n8n-workflow` (NodeHelpers; pinned to its CJS build by
# n8n-core's vite config) and the `@/execution-engine/*` alias (scheduler-registry,
# stack-scheduler — the source, so it is the same module instance `WorkflowExecute` and the
# tests load). n8n-libpetri's own build is imported by absolute file URL: LIBPETRI_HOOK is
# the tsup entry `n8n-vitest-setup` (default typescript/dist/n8n-vitest-setup.js), whose
# `setupN8nVitest({ setWorkflowSchedulerFactory, NodeHelpers, StackScheduler })` registers
# the PetriScheduler when N8N_EXECUTION_ENGINE is `libpetri` and is inert otherwise. The
# libpetri run uses a generated vitest config next to n8n-core's own that extends it with
# `test.setupFiles: ['./.n8n-libpetri-setup.mjs']`. Both generated files are listed in
# .n8n/.git/info/exclude (never in a .gitignore: the clone's tracked tree stays pristine and
# verify-patch.sh's `git clean` leaves excluded files alone). While LIBPETRI_HOOK does not
# exist (typescript/ not built) the engine is reported as skipped.
LIBPETRI_HOOK="${LIBPETRI_HOOK:-$ROOT/typescript/dist/n8n-vitest-setup.js}"
LIBPETRI_SHIM_REL="packages/core/.n8n-libpetri-setup.mjs"
LIBPETRI_CFG_REL="packages/core/vitest.libpetri.config.mts"
# ---------------------------------------------------------------------------------------------

SKIP_PATCH=0; TYPECHECK=0; ENGINES="legacy,libpetri"
for arg in "$@"; do
  case "$arg" in
    --skip-patch) SKIP_PATCH=1 ;;
    --typecheck)  TYPECHECK=1 ;;
    --engines=*)  ENGINES="${arg#--engines=}" ;;
    -h|--help)    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log() { printf '[conformance %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "error: $*" >&2; exit 1; }

[ -f "$BASELINE" ] || die "no $BASELINE; run scripts/bootstrap-n8n.sh first"
[ -d "$N8N_DIR/.git" ] || die "$N8N_DIR is not a git checkout; run scripts/bootstrap-n8n.sh"
[ -x "$ROOT/typescript/node_modules/.bin/tsx" ] || die "typescript/node_modules missing; run npm install in typescript/"
export PATH="$RESULTS/.corepack-bin:$PATH"
export COREPACK_ENABLE_STRICT=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
command -v pnpm >/dev/null 2>&1 || die "no pnpm shim in $RESULTS/.corepack-bin; run scripts/bootstrap-n8n.sh"

if [ $SKIP_PATCH -eq 1 ]; then
  log "== patches: skipped (--skip-patch)"
elif [ $TYPECHECK -eq 1 ]; then
  "$ROOT/scripts/verify-patch.sh" --typecheck --build
else
  "$ROOT/scripts/verify-patch.sh"
fi

# run_suite <engine> [extra vitest args...] → junit at $RESULTS/<engine>.junit.xml
run_suite() {
  local engine=$1; shift
  local junit="$N8N_DIR/packages/core/junit.xml" rc=0 t0
  rm -f "$junit"
  t0=$(date +%s)
  # CI=true: @n8n/vitest-config adds the junit reporter (outputFile ./junit.xml, relative to
  # packages/core). `pnpm --filter n8n-core run test <path>` passes the path filter to vitest.
  (cd "$N8N_DIR" && CI=true N8N_EXECUTION_ENGINE="$engine" pnpm --filter n8n-core run test "$N8N_TEST_FILTER" "$@") \
    > "$RESULTS/$engine.test.log" 2>&1 || rc=$?
  [ -f "$junit" ] || die "$engine: vitest produced no junit.xml (rc=$rc); see $RESULTS/$engine.test.log"
  mv "$junit" "$RESULTS/$engine.junit.xml"
  log "$engine: vitest rc=$rc in $(( $(date +%s) - t0 ))s → $RESULTS/$engine.junit.xml"
}

# exclude_in_clone <path>... — list paths in .n8n/.git/info/exclude (idempotent)
exclude_in_clone() {
  local f="$N8N_DIR/.git/info/exclude" p
  for p in "$@"; do grep -qxF "$p" "$f" 2>/dev/null || printf '%s\n' "$p" >> "$f"; done
}

# write_libpetri_shim — generate the setup shim and the vitest config (see HOOK above)
write_libpetri_shim() {
  local shim="$N8N_DIR/$LIBPETRI_SHIM_REL" cfg="$N8N_DIR/$LIBPETRI_CFG_REL" hook_url
  hook_url=$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$LIBPETRI_HOOK")
  exclude_in_clone "$LIBPETRI_SHIM_REL" "$LIBPETRI_CFG_REL"
  cat > "$shim" <<SHIM
// Generated by n8n-libpetri/scripts/run-conformance.sh — do not edit, do not commit
// (listed in .git/info/exclude). Runs as a vitest setupFile in every n8n-core test worker.
// Everything n8n-specific is imported here, where it resolves, and injected into
// n8n-libpetri; the PetriScheduler is registered only when N8N_EXECUTION_ENGINE=libpetri.
import { NodeHelpers } from 'n8n-workflow';
import { setWorkflowSchedulerFactory } from '@/execution-engine/scheduler-registry';
import { StackScheduler } from '@/execution-engine/stack-scheduler';
import { setupN8nVitest } from '${hook_url}';

const result = setupN8nVitest({ setWorkflowSchedulerFactory, NodeHelpers, StackScheduler });
if (result.engine === 'libpetri' && !globalThis.__n8nLibpetriAnnounced) {
  globalThis.__n8nLibpetriAnnounced = true;
  process.stderr.write('[n8n-libpetri] PetriScheduler registered (pid ' + process.pid + ')\\n');
}
SHIM
  # Next to n8n-core's config so `vitest/config` and `./vite.config` resolve from there;
  # mergeConfig appends our setup file after n8n-core's own.
  cat > "$cfg" <<CFG
import { mergeConfig } from 'vitest/config';
import base from './vite.config';
export default mergeConfig(base, { test: { setupFiles: ['./.n8n-libpetri-setup.mjs'] } });
CFG
  log "libpetri: shim $shim → $hook_url"
}

# matrix <engine> [cli flags...] → $RESULTS/<engine>.matrix.md; returns the cli's exit code
matrix() {
  local engine=$1; shift
  (cd "$ROOT/typescript" && node_modules/.bin/tsx "$CLI" "$BASELINE" "$RESULTS/$engine.junit.xml" \
      --baseline-label baseline --candidate-label "$engine" --out "$RESULTS/$engine.matrix.md" "$@")
}

status=0
IFS=',' read -r -a engines <<< "$ENGINES"
for engine in "${engines[@]}"; do
  case "$engine" in
    legacy)
      log "== legacy (StackScheduler behind the seam)"
      run_suite legacy
      # A pure refactor: same cases, same outcomes as the unpatched baseline.
      if matrix legacy --require-identical; then
        log "legacy: identical to baseline"
      else
        log "legacy: NOT identical to baseline; see $RESULTS/legacy.matrix.md"; status=1
      fi
      ;;
    libpetri)
      log "== libpetri (PetriScheduler)"
      if [ ! -f "$LIBPETRI_HOOK" ]; then
        log "libpetri: skipped — hook not present: $LIBPETRI_HOOK (run npm run build in typescript/)"
        continue
      fi
      write_libpetri_shim
      run_suite libpetri --config "$N8N_DIR/$LIBPETRI_CFG_REL"
      if matrix libpetri; then
        log "libpetri: no regression against baseline"
      else
        log "libpetri: regressions; see $RESULTS/libpetri.matrix.md"; status=1
      fi
      ;;
    *) die "unknown engine: $engine" ;;
  esac
done

for engine in "${engines[@]}"; do
  [ -f "$RESULTS/$engine.matrix.md" ] && { log "$engine: $(sed -n '3p' "$RESULTS/$engine.matrix.md")"; }
done
exit $status
