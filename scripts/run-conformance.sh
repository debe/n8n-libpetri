#!/usr/bin/env bash
#
# run-conformance.sh — an n8n suite under each scheduler, as a matrix.
#
# SCOPE (--scope, default execution-engine) picks which suite. Each scope has its own
# baseline (bootstrap-n8n.sh --scope=NAME writes it, on the unpatched tree) and its own
# artefact names, so the scopes never overwrite each other:
#
#   scope             package       filter                 baseline / labels
#   execution-engine  n8n-core      src/execution-engine   baseline.junit.xml, legacy, libpetri
#   core              n8n-core      whole package          baseline-core.junit.xml, legacy-core, libpetri-core
#   workflow          n8n-workflow  whole package          baseline-workflow.junit.xml, legacy-workflow, …
#   cli               n8n           whole package          baseline-cli.junit.xml, legacy-cli, …
#   engine            @n8n/engine   unit config            baseline-engine.junit.xml, legacy-engine
#   compat            @n8n/node-engine-compatibility, unit config
#                                                          baseline-compat.junit.xml, legacy-compat
#   cli-v2            n8n           src/modules/engine-v2, src/services/__tests__/engine-v2-dispatcher
#                                                          baseline-cli-v2.junit.xml, legacy-cli-v2
#   engine-int        @n8n/engine, integration config (test:integration)
#                                                          baseline-engine-int.junit.xml, legacy-engine-int
#   compat-int        @n8n/node-engine-compatibility, integration config
#                                                          baseline-compat-int.junit.xml, legacy-compat-int
#   all               execution-engine, then core, then workflow, in one run
#
# engine-int and compat-int are the same packages' integration configs. They need Docker:
# n8n's own testcontainers code starts a Postgres per file, unmodified. They run with
# --maxWorkers=1 (one Postgres at a time), and every leg writes <label>.pg-stamp.txt with the
# Postgres server version and the images Docker started (scripts/pg-stamp.sh). Like engine and
# compat, their legacy leg is a neutrality leg and their libpetri leg is the settlement leg.
#
# engine, compat and cli-v2 are the engine v2 scopes that need no Postgres; what their unit
# configs leave out, and why, is listed in bootstrap-n8n.sh's header. They carry no v1
# scheduler seam (none of them constructs a WorkflowExecute), so their libpetri leg is the
# settlement leg below, not a PetriScheduler leg; their legacy leg is a neutrality leg: the
# patched tree with nothing registered against the unpatched baseline. compat and cli-v2 load n8n-core and @n8n/engine from dist,
# so like `cli` they rebuild their chain first and the legs run against the patched dists.
#
# `cli` needs its own install and build (see bootstrap-n8n.sh --scope=cli): its vitest loads
# every workspace package from dist and its globalSetup dies without them. It is not in
# `all`, because that build is minutes and the other three scopes do not need it.
#
# The libpetri leg needs the scheduler seam, and the seam is in packages/core. How the shim
# reaches it differs per scope:
#
#   execution-engine, core   `@/execution-engine/scheduler-registry` — n8n-core's own path
#                            alias, i.e. the source modules its tests load.
#   cli                      `n8n-core` — packages/cli's `workspaceDistExternals` plugin
#                            resolves every workspace package to its built dist and marks it
#                            external, so the source modules are a different instance there.
#                            The dist must be built from the *patched* tree; the script greps
#                            the built workflow-execute.js for the registry CALL and skips the
#                            leg with the build command when it is not there (the added
#                            scheduler-registry.js file survives an unpatched rebuild, so its
#                            mere existence proves nothing).
#   workflow                 none — n8n-workflow never constructs a WorkflowScheduler, so the
#                            leg is reported **not applicable** rather than run as the legacy
#                            path under another name.
#
# Not applicable and skipped do not set the exit status; they are printed, not hidden.
#
#   1. scripts/verify-patch.sh puts the patches onto the pinned commit in .n8n/
#      (skipped with --skip-patch; the tree must then already be patched). With --typecheck
#      it also typechecks and builds n8n-core, @n8n/engine and the compat package on the
#      patched tree first.
#   2. For each engine, the suite runs with CI=true (junit reporter on) and
#      N8N_EXECUTION_ENGINE=<engine>; the junit lands in conformance-results/<label>.junit.xml.
#        legacy    StackScheduler, i.e. n8n's own loop behind the seam. Must be identical to
#                  the unpatched baseline (conformance-results/baseline.junit.xml).
#        libpetri  PetriScheduler, registered through setWorkflowSchedulerFactory() from a
#                  generated vitest setup shim inside the n8n tree — see LIBPETRI_HOOK below.
#                  Skipped until n8n-libpetri's build (typescript/dist) exists.
#      The patched n8n never reads N8N_EXECUTION_ENGINE itself (patch 0002 is a plain
#      registry); the shim does, and registers the PetriScheduler when it is `libpetri`.
#   3. typescript/src/conformance/cli.ts turns baseline + <label>.junit.xml into
#      conformance-results/<label>.matrix.md; the headline is loop-driving cases passed.
#
# The budget leg (milestone M3): --budget=N runs the libpetri engine at concurrency budget
# k = N by exporting N8N_LIBPETRI_BUDGET, which src/n8n-vitest-setup.ts reads and passes to
# registerPetriScheduler(). k = 1 is sequential n8n and keeps the M2 artefact names
# (libpetri.junit.xml / libpetri.matrix.md); k > 1 writes libpetri-k<N>.{junit.xml,matrix.md}
# so the legs do not overwrite each other. Above k = 1 several nodes run at once, so
# ordering-only regressions (divergence rows #5, #11, #12) multiply: read the budget leg's
# matrix for data equivalence, not for n8n's total order.
#
# Which is why a k > 1 leg is NOT compared to the baseline: n8n's own suite asserts its total
# order, so comparing a concurrent run to it fails by construction and the exit status would
# say nothing. It is compared to the k = 1 libpetri leg instead — same engine, same
# divergences, only the budget differs, so a regression there is a real one. When that leg's
# junit is missing the k > 1 matrix is still written, against the baseline, but its result is
# reported as informational and does NOT set the exit status. A k > 1 leg also runs with
# Every libpetri leg runs with N8N_LIBPETRI_DIAGNOSTICS=1 and collects what the engine said
# into conformance-results/<label>.diagnostics.txt, with the compiler's budget restrictions
# split out into <label>.budget.txt: that says how many of n8n's own workflows actually ran
# above k = 1 and how many the k-safety check forced back to 1. The k = 1 leg collects them
# too, because a diagnostic only counts as a k > 1 finding if the k = 1 leg does not emit it.
#
# One of those diagnostics answers "is this leg an engine result at all?". The registered
# factory emits ENGINE_ENTERED_DIAGNOSTIC the first time n8n constructs a scheduler through
# it (src/scheduler/register.ts), so the count of those lines is the number of test files
# that ENTERED the engine. Registering is not entering: a scope whose tests never reach
# processRunExecutionData — packages/workflow, which does not depend on n8n-core at all, and
# packages/cli, whose tests mock n8n-core's WorkflowExecute before they get there — runs
# every case with the engine registered and never constructed. Such a leg is evidence of
# patch neutrality, not of the engine, and the script says so per leg instead of leaving the
# junit to be read as an engine result.
#
# The settlement leg (engine v2, tasks/v2-seam-plan.md step 10). On the engine v2 scopes
# (engine, engine-int, compat, compat-int, cli-v2) there is no v1 scheduler, and the libpetri
# leg is the **settlement leg** instead: the net-backed SettlementPolicy registered through
# patch 0004's setSettlementPolicy() from a second generated shim (.n8n-libpetri-v2-setup.mjs,
# SETTLEMENT_HOOK below), on the module instance the scope's tests build their runtime from —
# `src/execution/settlement-policy-registry.ts` for @n8n/engine's own tests, the `@n8n/engine`
# package (its dist) for compat and cli. The leg's label is libpetri-<scope> (with
# --settlement-mode=M other than primary: libpetri-<scope>-M). It writes, besides the junit and
# the matrix against the unpatched baseline:
#   <label>.ledger.jsonl  one record per case: how often the policy was entered in it, per file
#                         whether it registered and what ran outside every case, every error
#   <label>.entered.md    the junit joined with the ledger: the headline is policy-entering
#                         cases passed, and every case that never entered is labelled as such
# Registering is not entering (F5). engine-int and compat-int build runtimes through
# createEngineRuntime and settle steps, so a leg there with no entered case exits non-zero; on
# engine, compat and cli-v2 no case settles a step through such a runtime (cli-v2 mocks
# @n8n/engine), the count is reported and the leg is evidence of neutrality with the policy
# registered, not of the policy. Neither kind is a conformance number for engine v1.
#
# Exit status: non-zero when the legacy run is not identical to the baseline, when the
# libpetri run regresses a case its comparison leg passes, when a settlement leg that must
# enter the policy never did, or when a run fails to produce junit.
#
# Flags: --skip-patch --typecheck --engines=legacy,libpetri --budget=N --scope=NAME
#        --settlement-mode=primary|shadow|primary-shadowed -h|--help
# Env:   N8N_DIR (default <repo>/.n8n), N8N_RESULTS (default <repo>/conformance-results),
#        N8N_TEST_FILTER (overrides the scope's path filters;
#        space-separated, each one a vitest path filter),
#        LIBPETRI_HOOK (default <repo>/typescript/dist/n8n-vitest-setup.js),
#        SETTLEMENT_HOOK (default <repo>/typescript/dist/n8n-v2-vitest-setup.js)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_DIR="${N8N_DIR:-$ROOT/.n8n}"
RESULTS="${N8N_RESULTS:-$ROOT/conformance-results}"
CLI="$ROOT/typescript/src/conformance/cli.ts"
# shellcheck source=pg-stamp.sh
. "$ROOT/scripts/pg-stamp.sh"

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
# Set per scope by scope_table(); these are the execution-engine defaults.
LIBPETRI_SHIM_REL="packages/core/.n8n-libpetri-setup.mjs"
LIBPETRI_CFG_REL="packages/core/vitest.libpetri.config.mts"
LIBPETRI_BASE_CFG=./vite.config
# The settlement leg's hook: the tsup entry `n8n-v2-vitest-setup`.
SETTLEMENT_HOOK="${SETTLEMENT_HOOK:-$ROOT/typescript/dist/n8n-v2-vitest-setup.js}"
SETTLEMENT_CLI="$ROOT/typescript/src/conformance/v2/entered-cli.ts"
# ---------------------------------------------------------------------------------------------

SKIP_PATCH=0; TYPECHECK=0; ENGINES="legacy,libpetri"; BUDGET=1; SCOPE=execution-engine; SETTLEMENT_MODE=primary
for arg in "$@"; do
  case "$arg" in
    --settlement-mode=*) SETTLEMENT_MODE="${arg#--settlement-mode=}" ;;
    --skip-patch) SKIP_PATCH=1 ;;
    --typecheck)  TYPECHECK=1 ;;
    --engines=*)  ENGINES="${arg#--engines=}" ;;
    --budget=*)   BUDGET="${arg#--budget=}" ;;
    --scope=*)    SCOPE="${arg#--scope=}" ;;
    -h|--help)    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# scope_table <name> — sets SCOPE_PKG / SCOPE_DIR / SCOPE_FILTER / SCOPE_SUFFIX / SCOPE_SEAM /
# SCOPE_BUILD (the turbo target to rebuild before the legs, empty for none) and FILTER_ARGS,
# plus SCOPE_SCRIPT (the package script, `test` unless set), SCOPE_ARGS (vitest flags after the
# filters) and SCOPE_PG (1: the suite starts Postgres through testcontainers; see pg-stamp.sh).
# Kept identical to the one in bootstrap-n8n.sh: a leg and the baseline it is compared to
# must be the same package and the same filter, or the matrix compares two case sets.
scope_table() {
  SCOPE_SCRIPT=test; SCOPE_ARGS=; SCOPE_PG=0
  case "$1" in
    execution-engine) SCOPE_PKG=n8n-core;     SCOPE_DIR=packages/core;     SCOPE_FILTER=src/execution-engine; SCOPE_SUFFIX=;           SCOPE_SEAM=alias;   SCOPE_BUILD= ;;
    core)             SCOPE_PKG=n8n-core;     SCOPE_DIR=packages/core;     SCOPE_FILTER=;                     SCOPE_SUFFIX=-core;      SCOPE_SEAM=alias;   SCOPE_BUILD= ;;
    workflow)         SCOPE_PKG=n8n-workflow; SCOPE_DIR=packages/workflow; SCOPE_FILTER=;                     SCOPE_SUFFIX=-workflow;  SCOPE_SEAM=none;    SCOPE_BUILD= ;;
    cli)              SCOPE_PKG=n8n;          SCOPE_DIR=packages/cli;      SCOPE_FILTER=;                     SCOPE_SUFFIX=-cli;       SCOPE_SEAM=package; SCOPE_BUILD=n8n ;;
    engine)           SCOPE_PKG=@n8n/engine;  SCOPE_DIR=packages/@n8n/engine; SCOPE_FILTER=;                  SCOPE_SUFFIX=-engine;    SCOPE_SEAM=none;    SCOPE_BUILD=@n8n/engine ;;
    compat)           SCOPE_PKG=@n8n/node-engine-compatibility; SCOPE_DIR=packages/@n8n/node-engine-compatibility; SCOPE_FILTER=; SCOPE_SUFFIX=-compat; SCOPE_SEAM=none; SCOPE_BUILD=@n8n/node-engine-compatibility ;;
    # vitest path filters are substrings of the file path; the dispatcher's test is under __tests__.
    cli-v2)           SCOPE_PKG=n8n;          SCOPE_DIR=packages/cli;      SCOPE_FILTER="src/modules/engine-v2 src/services/__tests__/engine-v2-dispatcher"; SCOPE_SUFFIX=-cli-v2; SCOPE_SEAM=none; SCOPE_BUILD=n8n ;;
    # The integration configs (`test:integration`, vitest.integration.config.ts). One file at a
    # time: each Postgres file starts its own container, and --maxWorkers=1 keeps it to one
    # Postgres at a time on a small Docker VM. It changes scheduling, not the case set.
    engine-int)       SCOPE_PKG=@n8n/engine;  SCOPE_DIR=packages/@n8n/engine; SCOPE_FILTER=;                  SCOPE_SUFFIX=-engine-int; SCOPE_SEAM=none;  SCOPE_BUILD=@n8n/engine
                      SCOPE_SCRIPT=test:integration; SCOPE_ARGS=--maxWorkers=1; SCOPE_PG=1 ;;
    compat-int)       SCOPE_PKG=@n8n/node-engine-compatibility; SCOPE_DIR=packages/@n8n/node-engine-compatibility; SCOPE_FILTER=; SCOPE_SUFFIX=-compat-int; SCOPE_SEAM=none; SCOPE_BUILD=@n8n/node-engine-compatibility
                      SCOPE_SCRIPT=test:integration; SCOPE_ARGS=--maxWorkers=1; SCOPE_PG=1 ;;
    *) echo "unknown --scope: $1 (execution-engine, core, workflow, cli, engine, compat, cli-v2, engine-int, compat-int, all)" >&2; exit 2 ;;
  esac
  # Where the generated shim and the generated vitest config live, and which config they
  # extend: n8n-core's is `./vite.config`, packages/cli's is `./vitest.config`.
  LIBPETRI_SHIM_REL="$SCOPE_DIR/.n8n-libpetri-setup.mjs"
  LIBPETRI_CFG_REL="$SCOPE_DIR/vitest.libpetri.config.mts"
  [ "$SCOPE_DIR" = packages/cli ] && LIBPETRI_BASE_CFG=./vitest.config || LIBPETRI_BASE_CFG=./vite.config
  SCOPE_FILTER="${N8N_TEST_FILTER:-$SCOPE_FILTER}"
  # One vitest positional argument per filter; none at all is the package's whole suite.
  read -r -a FILTER_ARGS <<< "$SCOPE_FILTER"
  read -r -a SCOPE_ARG_LIST <<< "$SCOPE_ARGS"
}
# settlement_table <name> — the settlement leg's columns, which bootstrap-n8n.sh does not need:
#   SETTLE_SEAM      where the shim imports @n8n/engine's registry from: `src` (the package's own
#                    tests load the engine from source), `package` (`@n8n/engine`, i.e. its dist),
#                    or empty (no engine v2 in the scope: no settlement leg)
#   SETTLE_ENTERS    1: the scope builds runtimes through createEngineRuntime and settles steps,
#                    so a leg that enters the policy in no case is F5 and fails the run
#   SETTLE_BASE_CFG  the vitest config the scope's script runs, which the leg's config extends
settlement_table() {
  SETTLE_SEAM=; SETTLE_ENTERS=0; SETTLE_BASE_CFG=./vitest.config
  case "$1" in
    engine)     SETTLE_SEAM=src ;;
    engine-int) SETTLE_SEAM=src;     SETTLE_ENTERS=1; SETTLE_BASE_CFG=./vitest.integration.config ;;
    compat)     SETTLE_SEAM=package ;;
    compat-int) SETTLE_SEAM=package; SETTLE_ENTERS=1; SETTLE_BASE_CFG=./vitest.integration.config ;;
    cli-v2)     SETTLE_SEAM=package ;;
  esac
}
case "$SCOPE" in
  all) SCOPES=(execution-engine core workflow) ;;
  *)   scope_table "$SCOPE"; SCOPES=("$SCOPE") ;;
esac

case "$SETTLEMENT_MODE" in
  primary|shadow|primary-shadowed) ;;
  *) echo "--settlement-mode must be primary, shadow or primary-shadowed, got '$SETTLEMENT_MODE'" >&2; exit 2 ;;
esac
case "$BUDGET" in
  ''|*[!0-9]*) echo "--budget must be a positive integer, got '$BUDGET'" >&2; exit 2 ;;
  0)           echo "--budget must be at least 1" >&2; exit 2 ;;
esac
log() { printf '[conformance %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "error: $*" >&2; exit 1; }
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

# run_suite <engine> <label> [extra vitest args...] → junit at $RESULTS/<label>.junit.xml
run_suite() {
  local engine=$1 label=$2; shift 2
  local junit="$N8N_DIR/$SCOPE_DIR/junit.xml" rc=0 t0 diagnostics=0
  rm -f "$junit"
  t0=$(date +%s)
  # Diagnostics on for every libpetri leg (see the header): the per-workflow budget
  # restrictions are the only way to see what actually ran concurrently, and the rest of the
  # engine's diagnostics — a stranded token, a refused waitTill claim, a decode warning — are
  # only meaningful against the k = 1 leg's set, so both legs have to emit them.
  [ "$engine" = libpetri ] && diagnostics=1
  # CI=true: @n8n/vitest-config adds the junit reporter (outputFile ./junit.xml, relative to
  # the package root). `pnpm --filter <pkg> run test <path>` passes the path filter to vitest;
  # an empty filter is passed as no argument at all, which is the package's whole suite.
  # N8N_LIBPETRI_BUDGET is read by setupN8nVitest() in the shim; the legacy leg ignores it.
  [ "$SCOPE_PG" -eq 0 ] || pg_watch_begin "$RESULTS/$label.pg-events.txt"
  # SUITE_SH (the settlement leg): the package script's own command line with its --config
  # replaced, run through `pnpm exec sh -c` — vitest refuses a second --config, and the
  # integration scripts already carry one.
  if [ -n "${SUITE_SH:-}" ]; then
    (cd "$N8N_DIR" && CI=true N8N_EXECUTION_ENGINE="$engine" \
        pnpm --filter "$SCOPE_PKG" exec sh -c "$SUITE_SH \"\$@\"" sh ${FILTER_ARGS[@]+"${FILTER_ARGS[@]}"} \
          ${SCOPE_ARG_LIST[@]+"${SCOPE_ARG_LIST[@]}"} "$@") \
      > "$RESULTS/$label.test.log" 2>&1 || rc=$?
  else
    (cd "$N8N_DIR" && CI=true N8N_EXECUTION_ENGINE="$engine" N8N_LIBPETRI_BUDGET="$BUDGET" \
        N8N_LIBPETRI_DIAGNOSTICS="$diagnostics" \
        pnpm --filter "$SCOPE_PKG" run "$SCOPE_SCRIPT" ${FILTER_ARGS[@]+"${FILTER_ARGS[@]}"} \
          ${SCOPE_ARG_LIST[@]+"${SCOPE_ARG_LIST[@]}"} "$@") \
      > "$RESULTS/$label.test.log" 2>&1 || rc=$?
  fi
  pg_watch_end
  [ -f "$junit" ] || die "$label: vitest produced no junit.xml (rc=$rc); see $RESULTS/$label.test.log"
  mv "$junit" "$RESULTS/$label.junit.xml"
  if [ "$SCOPE_PG" -eq 1 ]; then
    pg_stamp "$N8N_DIR/$SCOPE_DIR" "$RESULTS/$label.pg-events.txt" "$RESULTS/$label.pg-stamp.txt"
    log "$label: Postgres stamp → $RESULTS/$label.pg-stamp.txt (server $(grep -o 'PostgreSQL) [0-9.]*' "$RESULTS/$label.pg-stamp.txt" | sed 's/PostgreSQL) //' | paste -sd, -))"
  fi
  if [ "$diagnostics" -eq 1 ]; then
    # The shim's one-per-worker registration line is not a diagnostic; everything else with
    # the prefix is one the engine chose to emit.
    grep -F '[n8n-libpetri] ' "$RESULTS/$label.test.log" | grep -vF 'PetriScheduler registered' \
      | sort | uniq -c | sort -rn > "$RESULTS/$label.diagnostics.txt" || true
    grep -F 'budget:' "$RESULTS/$label.diagnostics.txt" > "$RESULTS/$label.budget.txt" || true
    log "$label: $(wc -l < "$RESULTS/$label.diagnostics.txt" | tr -d ' ') distinct diagnostic(s), $(wc -l < "$RESULTS/$label.budget.txt" | tr -d ' ') of them budget restriction(s) → $RESULTS/$label.diagnostics.txt"
    # Registered is not entered: count the files in which n8n actually constructed a
    # scheduler through the factory. A leg with none measured n8n, not this engine.
    local entered
    entered=$(grep -cF 'engine entered' "$RESULTS/$label.test.log" || true)
    if [ "${entered:-0}" -eq 0 ]; then
      log "$label: WARNING — the engine was REGISTERED BUT NEVER ENTERED: no test file constructed a" \
          "scheduler through the factory, so this leg is evidence of patch neutrality, not an engine result"
    else
      log "$label: the engine was entered in $entered test file(s)"
    fi
  fi
  log "$label: vitest rc=$rc in $(( $(date +%s) - t0 ))s → $RESULTS/$label.junit.xml"
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
  # Which specifiers the shim imports the seam from. `alias`: n8n-core's own `@/` path alias,
  # i.e. the source modules its tests load. `package`: the `n8n-core` package entry, which is
  # what packages/cli loads — `workspaceDistExternals` (vitest.config.base.ts) resolves every
  # workspace package to its built dist and marks it external, so the source modules are a
  # different instance there and registering into them would do nothing. The dist must
  # therefore be built from the *patched* tree; the cli guard below checks that.
  local registry_from='@/execution-engine/scheduler-registry' stack_from='@/execution-engine/stack-scheduler'
  if [ "$SCOPE_SEAM" = package ]; then registry_from='n8n-core'; stack_from='n8n-core'; fi
  cat > "$shim" <<SHIM
// Generated by n8n-libpetri/scripts/run-conformance.sh — do not edit, do not commit
// (listed in .git/info/exclude). Runs as a vitest setupFile in every $SCOPE_PKG test worker.
// Everything n8n-specific is imported here, where it resolves, and injected into
// n8n-libpetri; the PetriScheduler is registered only when N8N_EXECUTION_ENGINE=libpetri.
//
// The imports are **dynamic, inside beforeAll**, not top-level. A setup file's top-level
// import of '@/execution-engine/*' pulls n8n-core's error-reporter — and with it the real
// '@sentry/node' — into the module registry before the test file's own \`vi.mock\` factory
// is applied, so \`src/errors/__tests__/error-reporter.test.ts\` saw the unmocked module and
// two of its cases failed under any engine (measured: they fail with
// N8N_EXECUTION_ENGINE=legacy under this config too, i.e. with nothing registered).
// beforeAll runs after the test module is loaded and its mocks are in place, and it still
// runs before every test in the file, which is all the registry needs. The module registry
// is per test file, so this is the same instance WorkflowExecute loads.
import { beforeAll } from 'vitest';
import { setupN8nVitest } from '${hook_url}';

beforeAll(async () => {
  let mods;
  try {
    mods = {
      NodeHelpers: (await import('n8n-workflow')).NodeHelpers,
      setWorkflowSchedulerFactory: (await import('${registry_from}')).setWorkflowSchedulerFactory,
      StackScheduler: (await import('${stack_from}')).StackScheduler,
    };
  } catch (error) {
    // A test file that replaces one of these with \`vi.mock\` (packages/cli's
    // agent-sse-stream.test.ts mocks 'n8n-workflow' without NodeHelpers) would otherwise
    // fail here and take its whole suite with it. Such a file is not running a workflow,
    // so leaving it on the injected StackScheduler is right — but it is reported, never
    // silent: a file that *does* run workflows and lands here would be measuring the
    // legacy engine under the libpetri label. The count is in <label>.diagnostics.txt.
    process.stderr.write('[n8n-libpetri] shim: seam not resolvable in this file, engine not '
      + 'registered (' + String(error && error.message).split('\\n')[0] + ')\\n');
    return;
  }
  const result = setupN8nVitest(mods);
  if (result.engine === 'libpetri' && !globalThis.__n8nLibpetriAnnounced) {
    globalThis.__n8nLibpetriAnnounced = true;
    process.stderr.write('[n8n-libpetri] PetriScheduler registered (pid ' + process.pid + ')\\n');
  }
});
SHIM
  # Next to the package's own config so `vitest/config` and the base config resolve from
  # there; mergeConfig appends our setup file after the package's own.
  cat > "$cfg" <<CFG
import { mergeConfig } from 'vitest/config';
import base from '$LIBPETRI_BASE_CFG';
export default mergeConfig(base, { test: { setupFiles: ['./.n8n-libpetri-setup.mjs'] } });
CFG
  log "libpetri: shim $shim → $hook_url"
}

# write_settlement_shim — generate the settlement leg's setup shim and vitest config (see the
# header). Both are listed in .n8n/.git/info/exclude, like the v1 shim.
SETTLE_SHIM_NAME=.n8n-libpetri-v2-setup.mjs
SETTLE_CFG_NAME=vitest.libpetri-v2.config.mts
write_settlement_shim() {
  local shim="$N8N_DIR/$SCOPE_DIR/$SETTLE_SHIM_NAME" cfg="$N8N_DIR/$SCOPE_DIR/$SETTLE_CFG_NAME" hook_url
  local registry_from policy_from
  hook_url=$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$SETTLEMENT_HOOK")
  exclude_in_clone "$SCOPE_DIR/$SETTLE_SHIM_NAME" "$SCOPE_DIR/$SETTLE_CFG_NAME"
  # Which instance of the registry: the one createEngineRuntime reads in this scope's tests.
  # @n8n/engine's own tests import the runtime from src (relative imports, no alias), so the
  # registry is the source file; the compat package and packages/cli resolve `@n8n/engine` to
  # its `main`, dist/index.js (cli's workspaceDistExternals marks it external), so it is the
  # package. Registering on the other one is accepted and never read — F5, which the ledger
  # shows as a leg in which no case entered the policy.
  case "$SETTLE_SEAM" in
    src)     registry_from='./src/execution/settlement-policy-registry.ts'; policy_from='./src/execution/settlement-policy.ts' ;;
    package) registry_from='@n8n/engine'; policy_from='@n8n/engine' ;;
    *)       die "write_settlement_shim: scope $SCOPE has no settlement seam" ;;
  esac
  cat > "$shim" <<SHIM
// Generated by n8n-libpetri/scripts/run-conformance.sh — do not edit, do not commit (listed in
// .git/info/exclude). Runs as a vitest setupFile in every $SCOPE_PKG test file of the settlement
// leg: registers the net-backed SettlementPolicy on @n8n/engine's registry ($SETTLE_SEAM:
// $registry_from) when N8N_SETTLEMENT_POLICY=libpetri, and records per case how often it
// was entered (N8N_SETTLEMENT_LEDGER). The engine is imported dynamically inside beforeAll, as in
// the v1 shim, so a test file's own vi.mock of '@n8n/engine' is in place first; such a file is
// recorded as not registered, with the reason, never silently.
import { relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { createSettlementVitestSession } from '${hook_url}';

const session = createSettlementVitestSession();
let file = '';
let registry = null;

// vitest 5 hands hooks a fixture context, which must be destructured: no positional suite.
// The file is junit's classname, the test path relative to the package root (vitest's root).
beforeAll(async () => {
  file = relative(process.cwd(), String(expect.getState().testPath ?? ''));
  if (session.engine !== 'libpetri') return;
  let reason;
  try {
    const reg = await import('$registry_from');
    const pol = await import('$policy_from');
    const candidate = {
      setSettlementPolicy: reg.setSettlementPolicy,
      getSettlementPolicy: reg.getSettlementPolicy,
      resetSettlementPolicy: reg.resetSettlementPolicy,
      defaultSettlementPolicy: pol.defaultSettlementPolicy,
    };
    if (typeof candidate.setSettlementPolicy !== 'function' || typeof candidate.getSettlementPolicy !== 'function') {
      reason = 'the imported module has no setSettlementPolicy/getSettlementPolicy (patch 0004 missing, or mocked)';
    } else {
      registry = candidate;
    }
  } catch (error) {
    reason = 'import failed: ' + String(error && error.message).split('\\n')[0];
  }
  session.registerFile(file, registry, reason);
});
beforeEach(({ task }) => { session.beginCase(task); });
afterEach(({ task }) => { session.endCase(task); });
afterAll(() => {
  session.endFile(file);
  if (registry !== null && typeof registry.resetSettlementPolicy === 'function') registry.resetSettlementPolicy();
});
SHIM
  cat > "$cfg" <<CFG
import { mergeConfig } from 'vitest/config';
import base from '$SETTLE_BASE_CFG';
export default mergeConfig(base, { test: { setupFiles: ['./$SETTLE_SHIM_NAME'] } });
CFG
  log "settlement: shim $shim ($SETTLE_SEAM) → $hook_url"
}

# settlement_script — the scope's package script with its --config replaced by the settlement
# config (appended when it names none): the command line the leg runs instead of the script.
settlement_script() {
  node -e '
    const [pkgJson, name, cfg] = process.argv.slice(1);
    const script = require(pkgJson).scripts[name];
    if (typeof script !== "string") { console.error("no script " + name + " in " + pkgJson); process.exit(1); }
    if (/[;&|`$]/.test(script)) { console.error("script " + name + " is not a plain command line: " + script); process.exit(1); }
    const re = /--config[ =]\S+/;
    process.stdout.write(re.test(script) ? script.replace(re, "--config " + cfg) : script + " --config " + cfg);
  ' "$N8N_DIR/$SCOPE_DIR/package.json" "$SCOPE_SCRIPT" "$SETTLE_CFG_NAME"
}

# run_settlement_leg <label> — the settlement leg over the current scope (see the header).
run_settlement_leg() {
  # SUITE_SH is local, so run_suite sees it (dynamic scope) and no later leg does.
  local label=$1 ledger="$RESULTS/$1.ledger.jsonl" rc=0 expect=() SUITE_SH=
  [ -f "$SETTLEMENT_HOOK" ] || { log "settlement: skipped — hook not present: $SETTLEMENT_HOOK (run npm run build in typescript/)"; return 0; }
  # The engine dist has to carry patch 0004 for the package seam: setSettlementPolicy is
  # exported from it, and createEngineRuntime reads it.
  if [ "$SETTLE_SEAM" = package ] \
     && ! grep -q getSettlementPolicy "$N8N_DIR/packages/@n8n/engine/dist/runtime/create-engine-runtime.js" 2>/dev/null; then
    log "settlement: skipped — packages/@n8n/engine/dist does not read the patch 0004 registry; build the patched tree first"
    status=1; return 0
  fi
  write_settlement_shim
  rm -f "$ledger"
  SUITE_SH=$(settlement_script) || die "settlement: cannot derive the leg's command line from $SCOPE_PKG's $SCOPE_SCRIPT script"
  log "== settlement leg $label (net-backed SettlementPolicy, mode $SETTLEMENT_MODE): $SUITE_SH"
  export N8N_SETTLEMENT_POLICY=libpetri N8N_SETTLEMENT_MODE="$SETTLEMENT_MODE" N8N_SETTLEMENT_LEDGER="$ledger"
  run_suite settlement "$label"
  unset N8N_SETTLEMENT_POLICY N8N_SETTLEMENT_MODE N8N_SETTLEMENT_LEDGER
  [ -f "$ledger" ] || : > "$ledger"
  rc=0; matrix "$label" "$RESULTS/baseline$SCOPE_SUFFIX.junit.xml" baseline || rc=$?
  if [ "$rc" -eq 0 ]; then log "$label: no regression against baseline"
  elif [ "$rc" -eq 2 ]; then log "$label: the matrix could not read its input (exit 2)"; status=1
  else log "$label: regressions against baseline; see $RESULTS/$label.matrix.md"; status=1
  fi
  [ "$SETTLE_ENTERS" -eq 1 ] && expect=(--expect-entering)
  rc=0
  (cd "$ROOT/typescript" && node_modules/.bin/tsx "$SETTLEMENT_CLI" "$RESULTS/$label.junit.xml" "$ledger" \
      --label "$label" --out "$RESULTS/$label.entered.md" ${expect[@]+"${expect[@]}"}) || rc=$?
  if [ "$rc" -eq 1 ]; then
    log "$label: F5 — REGISTERED BUT NEVER ENTERED in a scope that settles steps through createEngineRuntime"; status=1
  elif [ "$rc" -ne 0 ]; then
    log "$label: the entered report could not read its input (exit $rc)"; status=1
  elif [ "$SETTLE_ENTERS" -eq 0 ]; then
    log "$label: this scope settles no step through a runtime createEngineRuntime builds; the leg is" \
        "neutrality with the policy registered, not a policy result (see $RESULTS/$label.entered.md)"
  fi
}

# matrix <label> <reference-junit> <reference-label> [cli flags...]
#   → $RESULTS/<label>.matrix.md; returns the cli's exit code
matrix() {
  local label=$1 reference=$2 reference_label=$3; shift 3
  (cd "$ROOT/typescript" && node_modules/.bin/tsx "$CLI" "$reference" "$RESULTS/$label.junit.xml" \
      --baseline-label "$reference_label" --candidate-label "$label" --out "$RESULTS/$label.matrix.md" "$@")
}

status=0
IFS=',' read -r -a engines <<< "$ENGINES"

# run_scope <scope> — every requested engine over one scope's suite.
run_scope() {
  local scope=$1 engine label reference reference_label gates settle_label=
  scope_table "$scope"
  local baseline="$RESULTS/baseline$SCOPE_SUFFIX.junit.xml"
  local legacy_label="legacy$SCOPE_SUFFIX" k1_label="libpetri$SCOPE_SUFFIX" libpetri_label
  # k = 1 keeps the scope's plain label; every larger budget gets its own artefacts.
  if [ "$BUDGET" -eq 1 ]; then libpetri_label="$k1_label"; else libpetri_label="$k1_label-k$BUDGET"; fi
  log "===== scope $scope ($SCOPE_PKG $SCOPE_SCRIPT, filter '${SCOPE_FILTER:-<whole package>}')"
  [ -f "$baseline" ] \
    || die "no $baseline; run scripts/bootstrap-n8n.sh --scope=$scope on the unpatched tree first"
  [ "$SCOPE_PG" -eq 0 ] || pg_preflight
  # packages/cli, compat and engine load workspace packages from their built dist, so the
  # dist has to match the patch state the legs run under — otherwise the run silently
  # compares the wrong tree. turbo caches on content, so this is a replay (seconds) when
  # nothing changed.
  if [ -n "$SCOPE_BUILD" ]; then
    local build_log="$RESULTS/${SCOPE_BUILD//\//_}$SCOPE_SUFFIX.build.log"
    log "$scope: building the $SCOPE_BUILD chain so its dists match the patched tree"
    (cd "$N8N_DIR" && DO_NOT_TRACK=1 TURBO_TELEMETRY_DISABLED=1 \
        pnpm exec turbo run build --filter="$SCOPE_BUILD" --output-logs=errors-only) \
      > "$build_log" 2>&1 \
      || die "$scope: turbo build failed; see $build_log"
  fi

  for engine in "${engines[@]}"; do
    case "$engine" in
      legacy)
        log "== legacy (StackScheduler behind the seam)"
        run_suite legacy "$legacy_label"
        # A pure refactor: same cases, same outcomes as the unpatched baseline.
        rc=0; matrix "$legacy_label" "$baseline" baseline --require-identical || rc=$?
        if [ "$rc" -eq 0 ]; then
          log "$legacy_label: identical to baseline"
        elif [ "$rc" -eq 2 ]; then
          log "$legacy_label: the matrix could not read its input (exit 2; the reason is above)"; status=1
        else
          log "$legacy_label: NOT identical to baseline; see $RESULTS/$legacy_label.matrix.md"; status=1
        fi
        ;;
      libpetri)
        # Engine v2 scopes: the settlement leg (see the header) instead of the v1 scheduler.
        settlement_table "$scope"
        if [ "$SCOPE_SEAM" = none ] && [ -n "$SETTLE_SEAM" ]; then
          settle_label="$k1_label"
          [ "$SETTLEMENT_MODE" = primary ] || settle_label="$k1_label-$SETTLEMENT_MODE"
          run_settlement_leg "$settle_label"
          continue
        fi
        # No seam reachable from this package: say so, do not invent a leg.
        if [ "$SCOPE_SEAM" = none ]; then
          log "libpetri: not applicable to scope $scope — the scheduler seam is in packages/core," \
              "and $SCOPE_PKG never constructs a WorkflowScheduler; a leg here would be the legacy path"
          continue
        fi
        # `package` seam: cli loads n8n-core from its dist, so the dist has to carry patch 0002.
        # Check the CALL SITE, not the added file: `scheduler-registry.js` is a file patch 0002
        # adds, and neither `tsc -p tsconfig.build.json` nor a turbo cache restore prunes stale
        # outputs, so it survives a rebuild of the unpatched tree — a guard on its existence
        # passes while `WorkflowExecute` still does `new StackScheduler()`, and the leg would be
        # labelled libpetri while running the legacy loop. `getWorkflowSchedulerFactory` appears
        # in the built `workflow-execute.js` only when patch 0002 is in the tree it was built from.
        if [ "$SCOPE_SEAM" = package ] \
           && ! grep -q getWorkflowSchedulerFactory "$N8N_DIR/packages/core/dist/execution-engine/workflow-execute.js" 2>/dev/null; then
          log "libpetri: skipped — $SCOPE_PKG loads n8n-core from packages/core/dist and that dist's" \
              "workflow-execute.js does not call the patch 0002 registry. Build the patched tree first:" \
              "(cd $N8N_DIR && pnpm exec turbo run build --filter=n8n)"
          continue
        fi
        log "== libpetri (PetriScheduler, budget k=$BUDGET)"
        if [ ! -f "$LIBPETRI_HOOK" ]; then
          log "libpetri: skipped — hook not present: $LIBPETRI_HOOK (run npm run build in typescript/)"
          continue
        fi
        write_libpetri_shim
        run_suite libpetri "$libpetri_label" --config "$N8N_DIR/$LIBPETRI_CFG_REL"
        # k = 1 is compared to the unpatched baseline and gates. k > 1 is compared to the k = 1
        # libpetri leg of the same scope — comparing a concurrent run to n8n's own total-order
        # assertions fails by construction (see the header) — and only gates when it exists.
        reference="$baseline"; reference_label=baseline; gates=1
        if [ "$BUDGET" -gt 1 ]; then
          if [ -f "$RESULTS/$k1_label.junit.xml" ]; then
            reference="$RESULTS/$k1_label.junit.xml"; reference_label="$k1_label"
          else
            gates=0
            log "$libpetri_label: no k=1 leg at $RESULTS/$k1_label.junit.xml; comparing to the baseline for information only"
          fi
        fi
        # The matrix exits 1 on a regression and 2 when it could not read its input; an input
        # error fails the run even on an ungated leg, and names no matrix that was never written.
        rc=0; matrix "$libpetri_label" "$reference" "$reference_label" || rc=$?
        if [ "$rc" -eq 0 ]; then
          log "$libpetri_label: no regression against $reference_label"
        elif [ "$rc" -eq 2 ]; then
          log "$libpetri_label: the matrix could not read its input (exit 2; the reason is above)"; status=1
        elif [ "$gates" -eq 1 ]; then
          log "$libpetri_label: regressions against $reference_label; see $RESULTS/$libpetri_label.matrix.md"; status=1
        else
          log "$libpetri_label: differences against $reference_label (informational, not gated); see $RESULTS/$libpetri_label.matrix.md"
        fi
        ;;
      *) die "unknown engine: $engine" ;;
    esac
  done

  for engine in "${engines[@]}"; do
    label="$engine$SCOPE_SUFFIX"
    [ "$engine" = libpetri ] && label=$libpetri_label
    # The settlement leg's headline is its entered report's; its matrix's loop-driving line is
    # the v1 classification, which says nothing about engine v2.
    if [ "$engine" = libpetri ] && [ -n "${settle_label:-}" ]; then
      if [ -f "$RESULTS/$settle_label.entered.md" ]; then log "$settle_label: $(sed -n '3p' "$RESULTS/$settle_label.entered.md")"; fi
      continue
    fi
    # An `if`, not `[ … ] && …`: a leg that wrote no matrix (not applicable, skipped) would
    # otherwise end the function with status 1, and errexit turns that into the run's exit.
    if [ -f "$RESULTS/$label.matrix.md" ]; then log "$label: $(sed -n '3p' "$RESULTS/$label.matrix.md")"; fi
  done
}

for scope in "${SCOPES[@]}"; do run_scope "$scope"; done
exit $status
