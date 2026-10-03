#!/usr/bin/env bash
#
# e2e-npm.sh — n8n-libpetri's installer against a real `npm i -g n8n@<version>`, end to end
# (tasks/inject-plan.md step 8, the local leg). An integration result, never a conformance number.
#
#   scripts/release/e2e-npm.sh <work-dir> <tarball.tgz> [n8n-version]
#
# <work-dir> must already hold `prefix/` with `npm i -g n8n@<version> --prefix <work-dir>/prefix`
# done (about 2.4 GB; it is not repeated here), and the `node` on PATH must be one n8n supports
# (Node 24: n8n's native deps have no Node 26 prebuilds). The legs, in order:
#
#   1. npm i -g <tarball> into the same prefix; `n8n-libpetri status` finds n8n on PATH: stock
#   2. `install` (the shipped seams carry a passing neutrality record, so no flag) installs and
#      the record is not `unverified`; a second install is a no-op; `status` reports installed
#   3. engine on (`eval "$(n8n-libpetri env)"`): n8n starts, logs `scheduler registered`; one
#      workflow (a fan-out joined by a Merge) runs through POST /rest/workflows/:id/run and
#      succeeds, and the log then shows `engine entered`
#   4. engine off, same database: the same workflow's run data equals leg 3's; no
#      `[n8n-libpetri]` line in the log
#   5. N8N_EXECUTION_ENGINE=libpetrx: n8n refuses to start, with our message
#   6. `uninstall`; every file under n8n-core hashes as before leg 2 (byte-identical restore)
#
# Writes only under <work-dir>. Stops any n8n it started on exit.
set -euo pipefail

WORK="$(cd "${1:?work dir}" && pwd)"
TGZ="${2:?tarball}"
N8N_VERSION="${3:-2.41.6}"
PREFIX="$WORK/prefix"
PORT="${E2E_PORT:-5681}"
export PATH="$PREFIX/bin:$PATH"
LOGS="$WORK/logs"
mkdir -p "$LOGS"
N8N_PID=""

log() { printf '[e2e-npm %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "FAIL: $*" >&2; exit 1; }
stop_n8n() {
  if [ -n "$N8N_PID" ] && kill -0 "$N8N_PID" 2>/dev/null; then
    kill "$N8N_PID" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$N8N_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$N8N_PID" 2>/dev/null || true
  fi
  N8N_PID=""
}
trap stop_n8n EXIT

CORE="$PREFIX/lib/node_modules/n8n/node_modules/n8n-core"
[ -d "$CORE" ] || die "no n8n-core at $CORE; run npm i -g n8n@$N8N_VERSION --prefix $PREFIX first"
hash_tree() { (cd "$1" && find . -type f -not -path './.n8n-libpetri/*' -print0 | sort -z | xargs -0 shasum -a 256); }

log "node $(node --version), n8n $(node -p "require('$PREFIX/lib/node_modules/n8n/package.json').version")"
log "n8n-core copies under n8n: $(find "$PREFIX/lib/node_modules/n8n" -type d -name n8n-core -path '*node_modules*' | wc -l | tr -d ' ')"
hash_tree "$CORE" > "$WORK/core-before.sha"

# --- 1 ---------------------------------------------------------------------------------------
log "leg 1: npm i -g $(basename "$TGZ")"
npm i -g "$TGZ" --prefix "$PREFIX" --no-audit --no-fund >"$LOGS/pack-install.log" 2>&1 || die "npm i -g of the tarball failed; see $LOGS/pack-install.log"
command -v n8n-libpetri >/dev/null || die "n8n-libpetri is not on PATH after the install"
status_out="$(n8n-libpetri status)" || die "status exited $?"
echo "$status_out" | sed 's/^/    /'
echo "$status_out" | grep -q '^state: stock$' || die "status before install is not stock"

# --- 2 ---------------------------------------------------------------------------------------
log "leg 2: install"
n8n-libpetri install | tee "$LOGS/install.log" | sed 's/^/    /'
grep -q 'unverified' "$LOGS/install.log" && die "install reports unverified seams; the shipped manifests carry neutrality records"
n8n-libpetri install | grep -q 'already installed' || die "a second install was not a no-op"
n8n-libpetri status > "$LOGS/status-installed.txt" || die "status after install exited $?"
grep -q '^state: installed$' "$LOGS/status-installed.txt" || die "status after install is not installed"
grep -q 'with --allow-unverified' "$LOGS/status-installed.txt" && die "status reports an unverified install"
node -e "const c=require('$CORE'); if (typeof c.setWorkflowSchedulerFactory!=='function') process.exit(1)" || die "require('n8n-core').setWorkflowSchedulerFactory is not a function"
log "  installed; require('n8n-core').setWorkflowSchedulerFactory is a function"

# --- n8n -------------------------------------------------------------------------------------
HOME_DIR="$WORK/home"
mkdir -p "$HOME_DIR"
start_n8n() { # <log> [env assignments...]
  local out="$1"; shift
  env N8N_USER_FOLDER="$HOME_DIR" N8N_PORT="$PORT" N8N_LISTEN_ADDRESS=127.0.0.1 N8N_SECURE_COOKIE=false \
      N8N_ENCRYPTION_KEY=n8n-libpetri-e2e-key N8N_DIAGNOSTICS_ENABLED=false N8N_VERSION_NOTIFICATIONS_ENABLED=false \
      N8N_TEMPLATES_ENABLED=false N8N_PERSONALIZATION_ENABLED=false \
      "$@" n8n start >"$out" 2>&1 &
  N8N_PID=$!
}
wait_rest() { # <log>
  for _ in $(seq 1 240); do
    kill -0 "$N8N_PID" 2>/dev/null || return 1
    if curl -fsS -o /dev/null -w '%{content_type}' "http://127.0.0.1:$PORT/rest/settings" 2>/dev/null | grep -q json; then return 0; fi
    sleep 0.5
  done
  return 1
}
run_workflow() { # <out.json>
  E2E_BASE="http://127.0.0.1:$PORT" E2E_WORK="$WORK" node "$(dirname "${BASH_SOURCE[0]}")/e2e-run.mjs" "$1"
}

# --- 3 ---------------------------------------------------------------------------------------
log "leg 3: engine on"
eval "$(n8n-libpetri env)"
[ "$N8N_EXECUTION_ENGINE" = libpetri ] || die "env did not set N8N_EXECUTION_ENGINE"
start_n8n "$LOGS/n8n-on.log" N8N_EXECUTION_ENGINE="$N8N_EXECUTION_ENGINE" EXTERNAL_HOOK_FILES="$EXTERNAL_HOOK_FILES"
wait_rest || die "n8n did not come up with the engine on; see $LOGS/n8n-on.log"
grep -q '\[n8n-libpetri\] scheduler registered' "$LOGS/n8n-on.log" || die "no 'scheduler registered' in $LOGS/n8n-on.log"
log "  $(grep -m1 'scheduler registered' "$LOGS/n8n-on.log")"
run_workflow "$WORK/run-on.json" || die "the workflow run failed with the engine on"
for _ in $(seq 1 20); do grep -q 'engine entered' "$LOGS/n8n-on.log" && break; sleep 0.25; done
grep -q '\[n8n-libpetri\] engine entered' "$LOGS/n8n-on.log" || die "the run did not enter the engine"
log "  $(grep -m1 'engine entered' "$LOGS/n8n-on.log")"
stop_n8n
unset N8N_EXECUTION_ENGINE EXTERNAL_HOOK_FILES

# --- 4 ---------------------------------------------------------------------------------------
log "leg 4: engine off"
start_n8n "$LOGS/n8n-off.log"
wait_rest || die "n8n did not come up with the engine off; see $LOGS/n8n-off.log"
run_workflow "$WORK/run-off.json" || die "the workflow run failed with the engine off"
stop_n8n
if grep -q '\[n8n-libpetri\]' "$LOGS/n8n-off.log"; then die "n8n-libpetri lines with the engine off"; fi
node -e '
  const strip = (f) => { const r = require(f).execution.data.resultData.runData;
    return Object.fromEntries(Object.entries(r).map(([k, runs]) => [k, runs.map((x) => ({ data: x.data, source: x.source, executionStatus: x.executionStatus }))])); };
  const a = JSON.stringify(strip(process.argv[1])), b = JSON.stringify(strip(process.argv[2]));
  if (a !== b) { console.error("run data differs:\n" + a + "\n" + b); process.exit(1); }
  console.log("  run data equal across engine on/off (" + Object.keys(JSON.parse(a)).length + " nodes)");
' "$WORK/run-on.json" "$WORK/run-off.json" || die "run data differs between engine on and off"

# --- 5 ---------------------------------------------------------------------------------------
log "leg 5: N8N_EXECUTION_ENGINE=libpetrx"
start_n8n "$LOGS/n8n-typo.log" N8N_EXECUTION_ENGINE=libpetrx EXTERNAL_HOOK_FILES="$PREFIX/lib/node_modules/n8n-libpetri/hook/n8n-hook.cjs"
for _ in $(seq 1 120); do kill -0 "$N8N_PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$N8N_PID" 2>/dev/null; then die "n8n kept running with N8N_EXECUTION_ENGINE=libpetrx"; fi
N8N_PID=""
grep -q "must be 'libpetri' or unset, got 'libpetrx'" "$LOGS/n8n-typo.log" || die "the typo refusal does not name the value; see $LOGS/n8n-typo.log"
log "  refused: $(grep -m1 'refusing to start' "$LOGS/n8n-typo.log")"

# --- 6 ---------------------------------------------------------------------------------------
log "leg 6: uninstall"
n8n-libpetri uninstall | sed 's/^/    /'
[ ! -e "$CORE/.n8n-libpetri" ] || die "the state directory is still there"
hash_tree "$CORE" > "$WORK/core-after.sha"
diff -q "$WORK/core-before.sha" "$WORK/core-after.sha" >/dev/null || { diff "$WORK/core-before.sha" "$WORK/core-after.sha" | head; die "n8n-core is not byte-identical to before the install"; }
log "  n8n-core byte-identical to stock: $(wc -l < "$WORK/core-after.sha" | tr -d ' ') files"
n8n-libpetri status | grep -q '^state: stock$' || die "status after uninstall is not stock"
log "all legs passed"
