#!/usr/bin/env bash
# n8n-testbed.sh — boot the real n8n editor with the PetriScheduler installed, seed the demo
# workflows, and hand you a URL.
#
# Everything the conformance suite measures runs against `FakeHost`, a structural mirror of
# patch 0001. This is the other half: the engine inside the process n8n actually ships, with
# n8n's own editor, node types, task runner, credentials and persistence around it.
#
#   scripts/testbed/n8n-testbed.sh                     # libpetri, k = 4, port 5678
#   scripts/testbed/n8n-testbed.sh --budget=1          # the same workflows, sequentially
#   scripts/testbed/n8n-testbed.sh --engine=legacy     # n8n's own stack loop, for comparison
#   scripts/testbed/n8n-testbed.sh --seed-only         # boot, seed, stop
#   scripts/testbed/n8n-testbed.sh --daemon            # boot, seed, return (diff-engines.sh)
#   scripts/testbed/n8n-testbed.sh --stop              # stop a --daemon instance
#
# Flags: --engine=libpetri|legacy  --budget=N  --port=N  --llm-port=N
#        --fresh (wipe .testbed first)  --no-seed  --no-build  --seed-only  --daemon  --stop
#
# State lives in .testbed/ (gitignored): the sqlite database under home/, n8n.log, stub-llm.log,
# ids.json. Nothing is written under .n8n/packages/core/src, which verify-patch.sh destroys.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
N8N_DIR="$ROOT/.n8n"
TESTBED="$ROOT/.testbed"
HERE="$ROOT/scripts/testbed"

ENGINE=libpetri; BUDGET=4; PORT=5678; LLM_PORT=5699
FRESH=0; SEED=1; BUILD=1; SEED_ONLY=0; DAEMON=0; STOP=0
for arg in "$@"; do
  case "$arg" in
    --engine=*)   ENGINE="${arg#--engine=}" ;;
    --budget=*)   BUDGET="${arg#--budget=}" ;;
    --port=*)     PORT="${arg#--port=}" ;;
    --llm-port=*) LLM_PORT="${arg#--llm-port=}" ;;
    --fresh)      FRESH=1 ;;
    --no-seed)    SEED=0 ;;
    --no-build)   BUILD=0 ;;
    --seed-only)  SEED_ONLY=1 ;;
    --daemon)     DAEMON=1 ;;
    --stop)       STOP=1 ;;
    -h|--help)    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done
case "$ENGINE" in libpetri|legacy) ;; *) echo "--engine must be libpetri or legacy" >&2; exit 2 ;; esac
case "$BUDGET" in ''|*[!0-9]*|0) echo "--budget must be a positive integer" >&2; exit 2 ;; esac

log()  { printf '[testbed %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die()  { log "error: $*" >&2; exit 1; }

[ -d "$N8N_DIR/.git" ] || die "$N8N_DIR is not a checkout; run scripts/bootstrap-n8n.sh"

if [ $STOP -eq 1 ]; then
  for name in n8n stub-llm; do
    pidfile="$TESTBED/$name.pid"
    [ -f "$pidfile" ] || continue
    pid="$(cat "$pidfile")"
    if kill "$pid" 2>/dev/null; then
      # Wait for the process to actually go, not just for the signal to be delivered: the next
      # leg of diff-engines.sh binds the same port, and a half-dead server gives it EADDRINUSE.
      for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      log "stopped $name (pid $pid)"
    else
      log "$name (pid $pid) was not running"
    fi
    rm -f "$pidfile"
  done
  exit 0
fi

# An instance already on the port would make n8n fail to bind and `wait_rest` time out 180 s
# later with a message about the REST API; worse, `--fresh` would wipe the database out from
# under it first. Say the real thing instead.
for taken in "$PORT:n8n" "$LLM_PORT:the stub LLM"; do
  if lsof -nP -iTCP:"${taken%%:*}" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port ${taken%%:*} is already in use (${taken#*:}); stop it with 'scripts/testbed/n8n-testbed.sh --stop', or pass --port / --llm-port"
  fi
done

# --- 1. our build ------------------------------------------------------------------------------
HOOK="$ROOT/typescript/dist/index.js"
if [ $BUILD -eq 1 ] && [ ! -f "$HOOK" ]; then
  log "building typescript/ (no dist yet)"
  (cd "$ROOT/typescript" && npm run build >/dev/null)
fi
[ -f "$HOOK" ] || die "$HOOK missing; run 'npm run build' in typescript/"

# --- 2. the patched n8n-core ------------------------------------------------------------------
# The server loads packages/core/dist, not src, so a dist older than the patch runs an older
# scheduler seam. `planEngineRequest` is patch 0001's M7 addition and the agent round needs it.
CORE="$N8N_DIR/packages/core"
BUILT="$CORE/dist/execution-engine/workflow-execute.js"
if [ $BUILD -eq 1 ] && { [ ! -f "$BUILT" ] || [ "$CORE/src/execution-engine/workflow-execute.ts" -nt "$BUILT" ]; }; then
  log "rebuilding packages/core (dist is older than the patched source)"
  (cd "$CORE" \
    && "$N8N_DIR/node_modules/.bin/tsc" -p tsconfig.build.json \
    && "$N8N_DIR/node_modules/.bin/tsc-alias" -p tsconfig.build.json) || die "packages/core build failed"
fi
for symbol in getWorkflowSchedulerFactory planEngineRequest; do
  grep -q "$symbol" "$BUILT" \
    || die "$symbol is absent from the built n8n-core; re-apply patches (scripts/verify-patch.sh) and rebuild"
done
log "n8n-core carries the scheduler seam and planEngineRequest"

# --- 3. state ----------------------------------------------------------------------------------
[ $FRESH -eq 1 ] && { log "wiping $TESTBED"; rm -rf "$TESTBED"; }
mkdir -p "$TESTBED/home"

# --- 4. children -------------------------------------------------------------------------------
STUB_PID=""; N8N_PID=""
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  [ -n "$N8N_PID" ] && kill "$N8N_PID" 2>/dev/null || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit $code
}
trap cleanup EXIT INT TERM

# Waits for the REST API, not for /healthz. n8n answers /healthz (and /healthz/readiness)
# while its controllers are still being mounted, and the editor's SPA catch-all answers 200
# with HTML in the meantime — so an early POST /rest/owner/setup "succeeds", creates nothing,
# and the seeding that follows writes ids of `undefined`. Measured, not theorised: that is
# exactly what the first run of this script did. The gate is therefore a REST route that
# returns JSON only once the controllers exist.
wait_rest() { # wait_rest <seconds>
  local deadline=$(( $(date +%s) + $1 )) type
  until type="$(curl -fsS -o /dev/null -w '%{content_type}' "http://127.0.0.1:$PORT/rest/settings" 2>/dev/null)" \
        && [ "${type#application/json}" != "$type" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || die "n8n's REST API did not come up on port $PORT; see $TESTBED/n8n.log"
    kill -0 "$N8N_PID" 2>/dev/null || die "n8n exited during startup; see $TESTBED/n8n.log"
    sleep 1
  done
}

log "starting the stub LLM on 127.0.0.1:$LLM_PORT"
STUB_LLM_PORT="$LLM_PORT" node "$HERE/stub-llm.mjs" >"$TESTBED/stub-llm.log" 2>&1 &
STUB_PID=$!

log "starting n8n on 127.0.0.1:$PORT (engine=$ENGINE, budget=$BUDGET)"
(
  cd "$N8N_DIR"
  export N8N_USER_FOLDER="$TESTBED/home" \
         N8N_PORT="$PORT" N8N_LISTEN_ADDRESS=127.0.0.1 N8N_SECURE_COOKIE=false \
         N8N_ENCRYPTION_KEY=n8n-libpetri-testbed-key \
         N8N_DIAGNOSTICS_ENABLED=false N8N_VERSION_NOTIFICATIONS_ENABLED=false \
         N8N_TEMPLATES_ENABLED=false N8N_PERSONALIZATION_ENABLED=false \
         N8N_ONBOARDING_FLOW_DISABLED=true N8N_HIRING_BANNER_ENABLED=false \
         N8N_EXECUTION_ENGINE="$ENGINE" N8N_LIBPETRI_BUDGET="$BUDGET" \
         N8N_LIBPETRI_HOOK="$HOOK" \
         N8N_LIBPETRI_RESOLVE_FROM="$N8N_DIR/packages/cli/package.json"
  # --import, not NODE_OPTIONS: bin/n8n never re-execs, and NODE_OPTIONS would additionally
  # load the preload into the internal task-runner child, which never runs a scheduler.
  exec node --import "$HERE/preload.mjs" "$N8N_DIR/packages/cli/bin/n8n" start
) >"$TESTBED/n8n.log" 2>&1 &
N8N_PID=$!

wait_rest 180
log "n8n's REST API is up"

if [ "$ENGINE" = libpetri ]; then
  grep -q 'scheduler registered' "$TESTBED/n8n.log" \
    || die "the preload did not register a scheduler; see $TESTBED/n8n.log"
  log "$(grep -m1 'scheduler registered' "$TESTBED/n8n.log")"
fi

# --- 5. seed -----------------------------------------------------------------------------------
if [ $SEED -eq 1 ]; then
  TESTBED_BASE_URL="http://127.0.0.1:$PORT" TESTBED_DIR="$TESTBED" STUB_LLM_PORT="$LLM_PORT" \
    node "$HERE/seed.mjs" || die "seeding failed"
fi

if [ $SEED_ONLY -eq 1 ]; then
  log "--seed-only: stopping"
  exit 0
fi

if [ $DAEMON -eq 1 ]; then
  echo "$N8N_PID" >"$TESTBED/n8n.pid"
  echo "$STUB_PID" >"$TESTBED/stub-llm.pid"
  trap - EXIT INT TERM   # the point of --daemon is that the children outlive this shell
  log "--daemon: n8n (pid $N8N_PID) and the stub LLM (pid $STUB_PID) left running on port $PORT"
  log "stop them with: scripts/testbed/n8n-testbed.sh --stop"
  exit 0
fi

# --- 6. hand over ------------------------------------------------------------------------------
cat <<BANNER

  n8n is running at   http://127.0.0.1:$PORT/
  sign in with        $(node -e 'const f=require(process.argv[1]);console.log(f.email, "/", f.password)' "$TESTBED/ids.json" 2>/dev/null || echo "see $TESTBED/ids.json")
  engine              $ENGINE$([ "$ENGINE" = libpetri ] && echo " (k = $BUDGET)")

$(node -e '
  try {
    const f = require(process.argv[1]);
    for (const w of f.workflows) console.log(`  ${w.name.padEnd(22)} ${f.base}/workflow/${w.id}`);
  } catch { console.log("  (no ids.json; run without --no-seed)"); }
' "$TESTBED/ids.json" 2>/dev/null)

  Open a workflow and press "Execute workflow". Then, to prove the net ran it rather than
  n8n's stack loop:

    grep 'engine entered' $TESTBED/n8n.log

  Logs: $TESTBED/n8n.log, $TESTBED/stub-llm.log.  Ctrl-C stops both processes.

BANNER

wait "$N8N_PID"
