#!/usr/bin/env bash
#
# bootstrap-n8n.sh — bring up the n8n reference checkout used for conformance runs.
#
#   1. .n8n/               shallow checkout of exactly N8N_COMMIT
#                          (git init + fetch --depth 1 <sha> + checkout FETCH_HEAD)
#   2. pnpm via corepack   at the version .n8n/package.json#packageManager pins (never hardcoded)
#   3. pnpm install        --frozen-lockfile, restricted to the workspace closure of
#                          n8n-nodes-base (⊃ n8n-core) plus the workspace root (turbo,
#                          tsc-alias); --full-install installs the whole monorepo
#   4. build               turbo `build` for n8n-nodes-base, which through `^build` builds the
#                          n8n-core dependency chain first. packages/core/test/helpers imports
#                          six node classes and known/nodes.json from nodes-base/dist, so the
#                          n8n-core chain alone leaves 6 execution-engine files unloadable.
#   5. baseline            packages/core execution-engine suite with CI=true (junit reporter)
#                          → conformance-results/baseline.junit.xml (+ .summary.txt)
#
# Idempotent: every step checks its postcondition (HEAD sha, pnpm version, turbo cache, …) and a
# re-run is cheap. Long steps print progress; run the whole thing in the background and tail
# conformance-results/bootstrap.log if your shell has a wall-clock cap.
#
# Flags: --skip-install --skip-build --skip-test --full-install --allow-dirty -h|--help
# Env:   N8N_DIR (default <repo>/.n8n), N8N_TEST_FILTER (default src/execution-engine),
#        COREPACK_VERSION (fallback corepack used through npx when none is on PATH; Node ≥ 25 no
#        longer ships one), COREPACK_HOME (corepack's own cache, default ~/.cache/node/corepack).
#
# Never edits anything under .n8n/: the only files it leaves there are pnpm/turbo/tsc outputs
# (all matched by n8n's own .gitignore) and the junit file, which is moved out after the run.
set -euo pipefail

# --- constants -------------------------------------------------------------------------------
N8N_REPO="https://github.com/n8n-io/n8n.git"
# master, 2026-09-04T16:58:49Z, "feat(core): Log a decision audit line when a policy blocks an
# action (no-changelog) (#37880)". Pinned by full sha: `git fetch <sha>` needs the full object id
# (GitHub serves any reachable sha via upload-pack; abbreviations are not resolved server-side).
N8N_COMMIT="441970b211d13a3ce547916b2b8ee93677b620e9"
COREPACK_VERSION="${COREPACK_VERSION:-0.36.0}"
# The package whose turbo `build` (with `^build`) yields everything packages/core's tests load.
BUILD_TARGET="n8n-nodes-base"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_DIR="${N8N_DIR:-$ROOT/.n8n}"
RESULTS="$ROOT/conformance-results"
TIMINGS="$RESULTS/bootstrap-timings.tsv"
N8N_TEST_FILTER="${N8N_TEST_FILTER:-src/execution-engine}"

SKIP_INSTALL=0; SKIP_BUILD=0; SKIP_TEST=0; FULL_INSTALL=0; ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    --skip-test)    SKIP_TEST=1 ;;
    --full-install) FULL_INSTALL=1 ;;
    --allow-dirty)  ALLOW_DIRTY=1 ;;
    -h|--help)      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# --- helpers ---------------------------------------------------------------------------------
log() { printf '[bootstrap %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "error: $*" >&2; exit 1; }

# step <name> <function> — run the step under errexit, time it, append a row to $TIMINGS.
# The step function is invoked as a plain command, never as `fn || rc=$?`, `if fn` or
# `[ skip ] && log || step …`: bash ignores `set -e` inside a function called in any of those
# contexts, and a failed `pnpm install` or `turbo run build` would then fall through to
# postcondition checks that a stale dist/ from an earlier run satisfies. A failing command
# therefore exits the script on the spot, and the EXIT trap writes the row for the open step.
CURRENT_STEP=""; STEP_T0=0
record() { printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" >> "$TIMINGS"; }
on_exit() {
  local rc=$? dt
  if [ $rc -ne 0 ] && [ -n "$CURRENT_STEP" ]; then
    dt=$(( $(date +%s) - STEP_T0 ))
    record "$CURRENT_STEP" "${dt}s" "rc=$rc"
    log "== $CURRENT_STEP: FAILED (rc=$rc) after ${dt}s"
  fi
}
trap on_exit EXIT
step() {
  local name=$1 fn=$2 dt
  CURRENT_STEP=$name; STEP_T0=$(date +%s)
  log "== $name"
  "$fn"
  dt=$(( $(date +%s) - STEP_T0 ))
  record "$name" "${dt}s" ok
  log "== $name: done in ${dt}s"
  CURRENT_STEP=""
}

# pnpm through corepack. corepack resolves the version from the nearest package.json carrying a
# `packageManager` field (walking up from cwd), so every call runs from $N8N_DIR and selects
# packages with --filter / -C rather than cd-ing into them.
pnpm() { (cd "$N8N_DIR" && "${COREPACK[@]}" pnpm "$@"); }

# --- 1. checkout ----------------------------------------------------------------------------
checkout() {
  if [ -e "$N8N_DIR" ] && [ ! -d "$N8N_DIR/.git" ]; then
    die "$N8N_DIR exists but is not a git checkout; move it away and re-run"
  fi
  if [ ! -d "$N8N_DIR/.git" ]; then
    mkdir -p "$N8N_DIR"
    git -C "$N8N_DIR" init -q
    git -C "$N8N_DIR" remote add origin "$N8N_REPO"
  fi
  git -C "$N8N_DIR" config advice.detachedHead false
  local head
  head=$(git -C "$N8N_DIR" rev-parse --verify -q HEAD 2>/dev/null || true)
  if [ "$head" = "$N8N_COMMIT" ]; then
    log "already at $N8N_COMMIT"
  else
    log "fetching $N8N_COMMIT (depth 1)"
    git -C "$N8N_DIR" fetch --depth 1 origin "$N8N_COMMIT"
    git -C "$N8N_DIR" checkout -q --detach FETCH_HEAD
  fi
  head=$(git -C "$N8N_DIR" rev-parse HEAD)
  [ "$head" = "$N8N_COMMIT" ] || die "HEAD is $head, expected $N8N_COMMIT"
  if ! git -C "$N8N_DIR" diff --quiet HEAD -- ; then
    if [ $ALLOW_DIRTY -eq 1 ]; then
      log "warning: tracked files under .n8n/ are modified (--allow-dirty): this is not an unpatched baseline"
    else
      die "tracked files under .n8n/ are modified; the baseline must run on the pristine commit. Reset with: git -C $N8N_DIR checkout -- . (or pass --allow-dirty)"
    fi
  fi
  log "checkout ok: $(git -C "$N8N_DIR" log -1 --format='%h %cI %s' | cut -c1-100)"
}

# --- 2. pnpm through corepack ----------------------------------------------------------------
setup_pnpm() {
  local pin name ver got
  pin=$(node -p "require('$N8N_DIR/package.json').packageManager || ''")
  [ -n "$pin" ] || die "no packageManager field in $N8N_DIR/package.json"
  name=${pin%%@*}; ver=${pin#*@}; ver=${ver%%+*}
  [ "$name" = "pnpm" ] || die "packageManager is $pin, expected pnpm"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0   # non-interactive download of the pinned pnpm
  export COREPACK_ENABLE_STRICT=1            # refuse any pnpm that is not the pinned one
  if command -v corepack >/dev/null 2>&1; then
    COREPACK=(corepack)
    log "corepack $(corepack --version) on PATH"
  else
    # Node ≥ 25 dropped the bundled corepack; use the npm package through npx (cached after the
    # first call, no global install, nothing written outside npm's cache and COREPACK_HOME).
    COREPACK=(npx --yes "corepack@$COREPACK_VERSION")
    log "no corepack on PATH; using npx corepack@$COREPACK_VERSION"
  fi
  got=$(pnpm --version)
  [ "$got" = "$ver" ] || die "corepack ran pnpm $got, package.json pins $ver"
  log "pnpm $got via corepack (packageManager=$pin)"
  # turbo spawns `pnpm run <script>` per package and needs a `pnpm` on PATH; a bundled corepack
  # without `corepack enable`, or the npx route, provides none. `corepack enable` can write its
  # shims anywhere: regenerate pnpm/pnpx symlinks (→ that corepack's dist/pnpm.js, which again
  # resolves the pinned version) in the gitignored results dir and prepend them for children.
  SHIM_DIR="$RESULTS/.corepack-bin"
  mkdir -p "$SHIM_DIR"
  "${COREPACK[@]}" enable --install-directory "$SHIM_DIR" pnpm
  export PATH="$SHIM_DIR:$PATH"
  [ "$(type -P pnpm)" = "$SHIM_DIR/pnpm" ] || die "pnpm shim not first on PATH"   # type -P: skip the pnpm() function
  got=$(cd "$N8N_DIR" && command pnpm --version)
  [ "$got" = "$ver" ] || die "pnpm shim ran $got, package.json pins $ver"
  {
    echo "date            $(date -u +%FT%TZ)"
    echo "os              $(uname -srm)"
    echo "node            $(node --version)"
    echo "npm             $(npm --version)"
    echo "corepack        ${COREPACK[*]} ($("${COREPACK[@]}" --version))"
    echo "pnpm            $got (packageManager=$pin)"
    echo "pnpm shim       $SHIM_DIR/pnpm -> $(readlink "$SHIM_DIR/pnpm")"
    echo "git             $(git --version)"
    echo "n8n commit      $N8N_COMMIT"
  } > "$RESULTS/bootstrap-env.txt"
}

# --- 3. install ------------------------------------------------------------------------------
install_deps() {
  # CI=true: pnpm switches to the append-only reporter and n8n's `prepare` skips `lefthook
  # install` (we never commit in .n8n/) and the dev-metrics opt-in prompt. The lockfile is
  # frozen either way. The default filter installs the workspace closure of $BUILD_TARGET (deps
  # and devDeps, 29 packages) plus the root (turbo, tsc-alias, typescript). It sidesteps the
  # native builds the full tree allows (sqlite3, isolated-vm, kafka) that nothing here needs.
  local filter=(--filter "$BUILD_TARGET..." --filter 'n8n-monorepo')
  if [ $FULL_INSTALL -eq 1 ]; then filter=(); fi
  # ${filter[@]+"${filter[@]}"}: an empty array must expand to nothing under set -u on bash 3.2.
  CI=true pnpm install --frozen-lockfile ${filter[@]+"${filter[@]}"}
  local turbo_v
  turbo_v=$("$N8N_DIR/node_modules/.bin/turbo" --version 2>/dev/null || echo missing)
  echo "turbo           $turbo_v" >> "$RESULTS/bootstrap-env.txt"
  log "install ok (turbo $turbo_v)"
}

# --- 4. build --------------------------------------------------------------------------------
build_chain() {
  # `build` depends on `^build` in turbo.json, so filtering to one package schedules its whole
  # dependency chain: n8n-nodes-base pulls n8n-core, which pulls the 25 packages below it
  # (devDeps such as @n8n/typeorm included). Turbo's local cache (packages/**/.turbo,
  # node_modules/.cache/turbo) turns re-runs into cache replays. tsc in these packages is
  # TypeScript 7 (tsgo) per the `typescript` catalog, so the type-checked build is already fast.
  export DO_NOT_TRACK=1 TURBO_TELEMETRY_DISABLED=1
  pnpm exec turbo run build --filter="$BUILD_TARGET" --output-logs=new-only
  local f
  for f in packages/workflow/dist/cjs/index.js packages/@n8n/vitest-config/dist/node-decorators.js \
           packages/core/dist/index.js packages/nodes-base/dist/known/nodes.json \
           packages/nodes-base/dist/nodes/If/If.node.js; do
    [ -f "$N8N_DIR/$f" ] || die "$f missing after build"
  done
  log "build ok"
}

# --- 5. baseline test run --------------------------------------------------------------------
run_baseline() {
  local junit="$N8N_DIR/packages/core/junit.xml" rc=0 vitest_v
  rm -f "$junit"
  vitest_v=$(pnpm --filter n8n-core exec vitest --version 2>/dev/null | tail -1 || true)
  echo "vitest          $vitest_v" >> "$RESULTS/bootstrap-env.txt"
  # CI=true makes @n8n/vitest-config add the junit reporter (outputFile ./junit.xml, relative to
  # packages/core) and cap the fork pool at 50 % of the cores. Positional arg = path filter.
  CI=true pnpm --filter n8n-core run test "$N8N_TEST_FILTER" || rc=$?
  [ -f "$junit" ] || die "vitest produced no junit.xml (rc=$rc)"
  mv "$junit" "$RESULTS/baseline.junit.xml"
  node - "$RESULTS/baseline.junit.xml" "$N8N_TEST_FILTER" > "$RESULTS/baseline.summary.txt" <<'NODE'
const fs = require('node:fs');
const [file, filter] = process.argv.slice(2);
const xml = fs.readFileSync(file, 'utf8');
const attr = (tag, name) => { const m = tag.match(new RegExp(` ${name}="([^"]*)"`)); return m ? m[1] : ''; };
const root = xml.match(/<testsuites[^>]*>/)?.[0] ?? '';
const suites = [...xml.matchAll(/<testsuite [^>]*>/g)].map((m) => m[0]);
const num = (s, n) => Number(attr(s, n) || 0);
const files = suites.map((s) => ({ name: attr(s, 'name'), tests: num(s, 'tests'), failures: num(s, 'failures'), errors: num(s, 'errors'), skipped: num(s, 'skipped') }));
const sum = (k) => files.reduce((a, f) => a + f[k], 0);
const we = files.filter((f) => f.name.includes('workflow-execute'));
console.log(`filter    ${filter}`);
console.log(`files     ${files.length}`);
console.log(`tests     ${num(root, 'tests')}`);
console.log(`failures  ${num(root, 'failures')}`);
console.log(`errors    ${num(root, 'errors')}`);
console.log(`skipped   ${sum('skipped')}`);
console.log(`workflow-execute files ${we.length}, cases ${we.reduce((a, f) => a + f.tests, 0)}`);
console.log('');
for (const f of files) console.log(`${String(f.tests).padStart(4)} ${f.failures + f.errors ? 'FAIL' : ' ok '} ${f.skipped ? `(${f.skipped} skipped) ` : ''}${f.name}`);
NODE
  cat "$RESULTS/baseline.summary.txt"
  [ $rc -eq 0 ] || die "vitest exited with rc=$rc; junit kept at $RESULTS/baseline.junit.xml"
  log "baseline ok: $RESULTS/baseline.junit.xml"
}

# --- main ------------------------------------------------------------------------------------
mkdir -p "$RESULTS"
touch "$TIMINGS"
log "repo $ROOT"
log "n8n  $N8N_DIR @ $N8N_COMMIT"
T_ALL=$(date +%s)
step checkout checkout
step corepack setup_pnpm
if [ $SKIP_INSTALL -eq 1 ]; then log "== install: skipped (--skip-install)"; else step install install_deps; fi
if [ $SKIP_BUILD -eq 1 ];   then log "== build: skipped (--skip-build)";     else step build build_chain;   fi
if [ $SKIP_TEST -eq 1 ];    then log "== baseline: skipped (--skip-test)";   else step baseline run_baseline; fi
record total "$(( $(date +%s) - T_ALL ))s" ok
log "all done in $(( $(date +%s) - T_ALL ))s; timings in $TIMINGS"
