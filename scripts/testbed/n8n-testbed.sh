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
#   scripts/testbed/n8n-testbed.sh --queue             # queue mode: a main and a worker process
#
#   scripts/testbed/n8n-testbed.sh --llm-latency=1300  # a stub that answers at a real model's pace
#
#   scripts/testbed/n8n-testbed.sh --v2 --settlement=primary   # engine v2, the net-backed policy answers
#   scripts/testbed/n8n-testbed.sh --v2 --settlement=shadow    # engine v2, n8n answers, ours is compared
#   scripts/testbed/n8n-testbed.sh --v2 --settlement=off       # engine v2, patched, nothing registered
#
# Flags: --engine=libpetri|legacy  --budget=N  --port=N  --llm-port=N  --llm-latency=MS
#        --fresh (wipe the state directory first)  --no-seed  --no-build  --seed-only  --daemon
#        --stop  --queue  --redis-port=N
#        --v2  --settlement=off|shadow|primary|primary-shadowed  --pg-port=N  --timing
#
# `--v2` turns on n8n's engine v2 (`N8N_ENABLED_MODULES=engine-v2`, `N8N_ENGINE_MODE=in-process`)
# with its data plane on a Docker Postgres that `pg.sh` starts (`LIBPETRI_PG_URL` overrides it),
# and seeds every testbed workflow engine v2 can start with `settings.engineType: "v2"`, plus
# the v2-only ones (`workflows-v2/`), and publishes the webhook-triggered ones so their production
# URLs answer. `--settlement` picks what answers `decideSuccessors`
# and `isFinished` (patches 0003/0004, `tasks/v2-seam-plan.md` step 11): `off` registers nothing,
# so n8n's default answers in a patched build; `primary` registers the net-backed policy;
# `shadow` and `primary-shadowed` run both and report every call. The boot gates on the preload's
# `settlement policy registered` (or, for `off`, its `settlement policy off` line). The state is
# `.testbed/v2/`, apart from the v1 testbed's, because a seeded `engineType: "v2"` would route the
# v1 testbed's runs to a module it does not load. n8n's main database stays sqlite; only the
# engine's data plane needs Postgres. `--engine` defaults to `legacy` under `--v2`: engine v2 runs
# v1 nodes through `V1StepExecutor`, never through `WorkflowExecute`, so a scheduler would reach
# only what still runs on v1 (a sub-workflow called with Execute Workflow). Pass
# `--engine=libpetri` to have both. `--timing` (needs `--v2`) installs the preload's settlement
# timing instrument in any mode: per `step:settled` event, the handler's wall time, its store
# calls, each policy call's time, reader calls and round trips, and the `ended` lastStep, all into
# `.testbed/v2/settlement.jsonl` (`diff-engines-v2.sh` turns it on for every leg).
#
# `--queue` runs n8n the way production does: `n8n start` enqueues onto Redis and a separate
# `n8n worker` process dequeues and executes. The engine has to reach that *worker*, because
# that is where `WorkflowExecute.processRunExecutionData()` is called
# (`packages/cli/src/scaling/job-processor.ts`) — the main process never constructs a scheduler
# for a queued execution. Needs a Redis on --redis-port (default 6399); start one with
#   redis-server --port 6399 --save '' --appendonly no --daemonize yes
#
# State lives in .testbed/ (gitignored): the sqlite database under home/, n8n.log, stub-llm.log,
# ids.json. Nothing is written under .n8n/packages/core/src, which verify-patch.sh destroys.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
N8N_DIR="$ROOT/.n8n"
TESTBED_V1="$ROOT/.testbed"
TESTBED_V2="$ROOT/.testbed/v2"
HERE="$ROOT/scripts/testbed"

ENGINE=""; BUDGET=4; PORT=5678; LLM_PORT=5699; REDIS_PORT=6399; LLM_LATENCY=0
FRESH=0; SEED=1; BUILD=1; SEED_ONLY=0; DAEMON=0; STOP=0; QUEUE=0
V2=0; SETTLEMENT=""; PG_PORT=55432; TIMING=0
for arg in "$@"; do
  case "$arg" in
    --engine=*)   ENGINE="${arg#--engine=}" ;;
    --v2)         V2=1 ;;
    --settlement=*) SETTLEMENT="${arg#--settlement=}" ;;
    --pg-port=*)  PG_PORT="${arg#--pg-port=}" ;;
    --timing)     TIMING=1 ;;
    --budget=*)   BUDGET="${arg#--budget=}" ;;
    --port=*)     PORT="${arg#--port=}" ;;
    --llm-port=*) LLM_PORT="${arg#--llm-port=}" ;;
    --llm-latency=*) LLM_LATENCY="${arg#--llm-latency=}" ;;
    --fresh)      FRESH=1 ;;
    --no-seed)    SEED=0 ;;
    --no-build)   BUILD=0 ;;
    --seed-only)  SEED_ONLY=1 ;;
    --daemon)     DAEMON=1 ;;
    --stop)       STOP=1 ;;
    --queue)      QUEUE=1 ;;
    --redis-port=*) REDIS_PORT="${arg#--redis-port=}" ;;
    -h|--help)    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done
[ -n "$ENGINE" ] || { [ $V2 -eq 1 ] && ENGINE=legacy || ENGINE=libpetri; }
case "$ENGINE" in libpetri|legacy) ;; *) echo "--engine must be libpetri or legacy" >&2; exit 2 ;; esac
case "$BUDGET" in ''|*[!0-9]*|0) echo "--budget must be a positive integer" >&2; exit 2 ;; esac
if [ $V2 -eq 1 ]; then
  [ -n "$SETTLEMENT" ] || SETTLEMENT=primary
  case "$SETTLEMENT" in off|shadow|primary|primary-shadowed) ;; *) echo "--settlement must be off, shadow, primary or primary-shadowed" >&2; exit 2 ;; esac
  case "$PG_PORT" in ''|*[!0-9]*|0) echo "--pg-port must be a positive integer" >&2; exit 2 ;; esac
  # The engine-v2 module throws at init in queue mode (`engine-v2.module.ts`), so the combination
  # would only fail later and less clearly.
  [ $QUEUE -eq 0 ] || { echo "--v2 and --queue cannot be combined: the engine-v2 module refuses queue mode" >&2; exit 2; }
elif [ -n "$SETTLEMENT" ]; then
  echo "--settlement needs --v2" >&2; exit 2
elif [ $TIMING -eq 1 ]; then
  echo "--timing needs --v2" >&2; exit 2
fi

log()  { printf '[testbed %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die()  { log "error: $*" >&2; exit 1; }

[ -d "$N8N_DIR/.git" ] || die "$N8N_DIR is not a checkout; run scripts/bootstrap-n8n.sh"

# --stop stops both testbeds, v1 and v2, whichever flags it is given: a pidfile names exactly the
# processes this script left running, and a v2 instance left behind holds the ports a v1 run needs.
if [ $STOP -eq 1 ]; then
  for dir in "$TESTBED_V1" "$TESTBED_V2"; do
    for name in n8n-worker n8n stub-llm; do
      pidfile="$dir/$name.pid"
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
  done
  # After n8n, so the engine's pool closes against a live server rather than logging errors.
  if [ -f "$TESTBED_V2/pg.managed" ]; then
    "$HERE/pg.sh" stop || true
    rm -f "$TESTBED_V2/pg.managed"
  fi
  exit 0
fi

TESTBED="$TESTBED_V1"; [ $V2 -eq 1 ] && TESTBED="$TESTBED_V2"

# An instance already on the port would make n8n fail to bind and `wait_rest` time out 180 s
# later with a message about the REST API; worse, `--fresh` would wipe the database out from
# under it first. Say the real thing instead.
PREFLIGHT_PORTS=("$PORT:n8n" "$LLM_PORT:the stub LLM")
# Engine v2's data plane and control plane servers. Their defaults (3000, 3001) are moved next to
# the testbed's own ports, so the testbed never takes a common development port.
ENGINE_PORT=$(( PORT + 3 )); ENGINE_CP_PORT=$(( PORT + 4 ))
[ $V2 -eq 1 ] && PREFLIGHT_PORTS+=("$ENGINE_PORT:engine v2's data plane server" "$ENGINE_CP_PORT:engine v2's control plane server")
# The worker runs its own task broker, so in queue mode that port has to be free too — a busy
# one otherwise surfaces only as "the worker exited during startup" and a log dig.
[ $QUEUE -eq 1 ] && PREFLIGHT_PORTS+=("$(( PORT + 2 )):the worker's task broker")
for taken in "${PREFLIGHT_PORTS[@]}"; do
  if lsof -nP -iTCP:"${taken%%:*}" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port ${taken%%:*} is already in use (${taken#*:}); stop it with 'scripts/testbed/n8n-testbed.sh --stop', or pass --port / --llm-port"
  fi
done

# Redis is checked **here**, with the ports, and not beside the queue environment further down.
# The reason is the line this block's own comment warns about: `--fresh` wipes $TESTBED a few
# steps below, and a probe placed after it would destroy the database, the seeded ids and the
# logs on the way to reporting that Redis was never running.
if [ $QUEUE -eq 1 ]; then
  case "$REDIS_PORT" in ''|*[!0-9]*|0) echo "--redis-port must be a positive integer" >&2; exit 2 ;; esac
  # A Redis that is not there presents as n8n retrying a connection forever behind a REST API
  # that never finishes coming up, which `wait_rest` reports 180 s later as "the REST API did
  # not come up". Say the real thing now. This proves a TCP listener, not that it speaks RESP.
  (exec 3<>"/dev/tcp/127.0.0.1/$REDIS_PORT") 2>/dev/null \
    || die "no Redis on 127.0.0.1:$REDIS_PORT; start one with: redis-server --port $REDIS_PORT --save '' --appendonly no --daemonize yes"
fi

# --- 1. our build ------------------------------------------------------------------------------
HOOK="$ROOT/typescript/dist/index.js"
if [ $BUILD -eq 1 ] && [ ! -f "$HOOK" ]; then
  log "building typescript/ (no dist yet)"
  (cd "$ROOT/typescript" && npm run build >/dev/null)
elif [ $BUILD -eq 1 ] && [ -n "$(find "$ROOT/typescript/src" -newer "$HOOK" -name '*.ts' -print -quit)" ]; then
  # A dist older than src would run an older policy under the current name: rebuild it.
  log "rebuilding typescript/ (dist is older than src)"
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

# --- 2b. the patched @n8n/engine (--v2) ----------------------------------------------------------
# The server loads packages/@n8n/engine/dist, not src, so a dist older than patches 0003/0004 runs
# n8n's settlement code with no seam, and the preload's registration would land on nothing. Stale
# means: some non-test source is newer than the stamp written after the last build here (or than
# its own compiled file when there is no stamp), or the dist lacks the 0004 registry. The build is
# the package's own (`tsc -p tsconfig.build.json`), incremental, so an up-to-date tree emits nothing.
if [ $V2 -eq 1 ]; then
  ENGINE_PKG="$N8N_DIR/packages/@n8n/engine"
  ENGINE_STAMP="$ENGINE_PKG/dist/.n8n-libpetri-built"
  engine_stale() {
    [ -f "$ENGINE_PKG/dist/execution/settlement-policy-registry.js" ] || return 0
    grep -q setSettlementPolicy "$ENGINE_PKG/dist/index.js" || return 0
    local src rel out
    while IFS= read -r src; do
      rel="${src#"$ENGINE_PKG/src/"}"; out="$ENGINE_PKG/dist/${rel%.ts}.js"
      if [ -f "$ENGINE_STAMP" ]; then [ "$src" -nt "$ENGINE_STAMP" ] && return 0
      else { [ ! -f "$out" ] || [ "$src" -nt "$out" ]; } && return 0; fi
    done < <(find "$ENGINE_PKG/src" -name '*.ts' -not -path '*/__tests__/*' -not -name '*.test.ts')
    return 1
  }
  if [ $BUILD -eq 1 ] && engine_stale; then
    log "rebuilding packages/@n8n/engine (dist is older than the patched source)"
    (cd "$ENGINE_PKG" && ./node_modules/.bin/tsc -p tsconfig.build.json) || die "packages/@n8n/engine build failed"
    touch "$ENGINE_STAMP"
  fi
  grep -q setSettlementPolicy "$ENGINE_PKG/dist/index.js" \
    || die "setSettlementPolicy is absent from the built @n8n/engine; re-apply patches (scripts/verify-patch.sh) and rebuild"
  log "@n8n/engine carries the settlement seam (patches 0003/0004)"

  V2_HOOK="$ROOT/typescript/dist/n8n-v2.js"
  [ -f "$V2_HOOK" ] || die "$V2_HOOK missing; run 'npm run build' in typescript/"
fi

# --- 3. state ----------------------------------------------------------------------------------
# `--fresh` on the v1 testbed keeps .testbed/v2/: it is another testbed's state, not this one's.
if [ $FRESH -eq 1 ]; then
  log "wiping $TESTBED"
  if [ $V2 -eq 1 ]; then rm -rf "$TESTBED"
  else find "$TESTBED" -mindepth 1 -maxdepth 1 ! -name v2 -exec rm -rf {} + 2>/dev/null || true; fi
fi
mkdir -p "$TESTBED/home"

# --- 3b. the engine's Postgres (--v2) ------------------------------------------------------------
# Started before n8n: `EngineV2Runtime.init` connects and migrates at boot, and n8n does not start
# when it cannot. `--fresh` also empties it, so the data plane never holds executions the wiped
# sqlite database has no workflows for.
ENGINE_DB_URL=""
if [ $V2 -eq 1 ]; then
  if [ -n "${LIBPETRI_PG_URL:-}" ]; then
    log "engine data plane: LIBPETRI_PG_URL (external, not managed)"
  else
    [ $FRESH -eq 1 ] && "$HERE/pg.sh" stop
    "$HERE/pg.sh" start --port="$PG_PORT" || die "the engine's Postgres did not start"
    touch "$TESTBED/pg.managed"
  fi
  ENGINE_DB_URL="$("$HERE/pg.sh" url --port="$PG_PORT")"
  "$HERE/pg.sh" stamp --port="$PG_PORT" >"$TESTBED/pg-stamp.txt" || die "could not stamp the engine's Postgres"
fi

# --- 4. children -------------------------------------------------------------------------------
STUB_PID=""; N8N_PID=""; WORKER_PID=""
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  [ -n "$WORKER_PID" ] && kill "$WORKER_PID" 2>/dev/null || true
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

QUEUE_ENV=()
if [ $QUEUE -eq 1 ]; then
  # Redis was already probed with the ports, above.
  QUEUE_ENV=(EXECUTIONS_MODE=queue
             QUEUE_BULL_REDIS_HOST=127.0.0.1
             QUEUE_BULL_REDIS_PORT="$REDIS_PORT"
             # Its own logical database, so the testbed never collides with another
             # application's Redis. It does **not** isolate one testbed run from the next:
             # `--fresh` wipes the sqlite file and knows nothing about Redis, so a previous
             # run's jobs sit in db 9 until something flushes them.
             QUEUE_BULL_REDIS_DB=9
             # Without this a *manual* execution never reaches the queue at all:
             # `workflow-runner.ts` enqueues only when
             # `mode === 'queue' && executionMode !== 'manual'`, so the main process runs it
             # in-process and the worker sits idle. Everything the testbed drives — `run.mjs`,
             # the editor's Execute button — is a manual execution, so without the flag the
             # whole leg would measure the main process while calling itself queue mode.
             OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true)
  log "queue mode: Redis on 127.0.0.1:$REDIS_PORT (db 9)"
fi

log "starting the stub LLM on 127.0.0.1:$LLM_PORT$([ "$LLM_LATENCY" -gt 0 ] 2>/dev/null && echo " (answering after ${LLM_LATENCY} ms)")"
# Latency is zero unless asked for. Every wall clock this project reports is measured with the
# stub answering instantly; a pause belongs only in a recording, where an agent round needs
# visible beats to be legible at all.
STUB_LLM_PORT="$LLM_PORT" STUB_LLM_LATENCY_MS="$LLM_LATENCY" node "$HERE/stub-llm.mjs" >"$TESTBED/stub-llm.log" 2>&1 &
STUB_PID=$!

V2_ENV=()
if [ $V2 -eq 1 ]; then
  : >"$TESTBED/settlement.jsonl"
  V2_ENV=(N8N_ENABLED_MODULES=engine-v2
          N8N_ENGINE_MODE=in-process
          N8N_ENGINE_DATABASE_URL="$ENGINE_DB_URL"
          N8N_ENGINE_HOST=127.0.0.1
          N8N_ENGINE_PORT="$ENGINE_PORT"
          N8N_ENGINE_CONTROL_PLANE_PORT="$ENGINE_CP_PORT"
          N8N_LIBPETRI_SETTLEMENT="$SETTLEMENT"
          N8N_LIBPETRI_V2_HOOK="$V2_HOOK"
          N8N_LIBPETRI_SETTLEMENT_LEDGER="$TESTBED/settlement.jsonl"
          N8N_LIBPETRI_SETTLEMENT_TIMING="$TIMING")
fi

log "starting n8n on 127.0.0.1:$PORT (engine=$ENGINE, budget=$BUDGET$([ $V2 -eq 1 ] && echo ", engine v2, settlement=$SETTLEMENT"))"
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
  [ ${#QUEUE_ENV[@]} -eq 0 ] || export "${QUEUE_ENV[@]}"
  # Same bash 3.2 guard as the queue array's.
  [ ${#V2_ENV[@]} -eq 0 ] || export "${V2_ENV[@]}"
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

# The v2 gate. The REST API being up is not enough: the engine-v2 module initialises during boot,
# and a module that failed would leave every v2 run refused with "Engine v2 is not available".
if [ $V2 -eq 1 ]; then
  gate='settlement policy registered'; [ "$SETTLEMENT" = off ] && gate='settlement policy off'
  grep -q "$gate" "$TESTBED/n8n.log" \
    || die "the preload did not report '$gate'; see $TESTBED/n8n.log"
  log "$(grep -m1 "$gate" "$TESTBED/n8n.log" | sed 's/^\[n8n-libpetri\] //')"
  grep -q 'Engine v2 listening on' "$TESTBED/n8n.log" \
    || die "engine v2's data plane did not start; see $TESTBED/n8n.log"
  log "$(grep -m1 -o 'Engine v2 listening on.*' "$TESTBED/n8n.log")"
  if [ $TIMING -eq 1 ]; then
    grep -q 'settlement timing installed' "$TESTBED/n8n.log" \
      || die "--timing: the preload did not install the settlement timing instrument; see $TESTBED/n8n.log"
    log "$(grep -m1 'settlement timing installed' "$TESTBED/n8n.log" | sed 's/^\[n8n-libpetri\] //')"
  fi
fi

# --- 4b. the worker ----------------------------------------------------------------------------
# Started after the REST API is up, so the main process has finished running migrations and the
# worker finds a schema rather than racing it.
#
# The worker gets the *same* preload, for the same reason the main process does and with more at
# stake: in queue mode the main process hands the execution to Redis and never constructs a
# scheduler, so `WorkflowExecute.processRunExecutionData()` is called only here
# (`job-processor.ts`). A worker without the preload would run n8n's own stack loop while
# the main process's log still said `scheduler registered` — the exact failure the preload's
# "no fallback" rule exists to prevent, one process over.
if [ $QUEUE -eq 1 ]; then
  log "starting an n8n worker (engine=$ENGINE, budget=$BUDGET)"
  (
    cd "$N8N_DIR"
    export N8N_USER_FOLDER="$TESTBED/home" \
           N8N_ENCRYPTION_KEY=n8n-libpetri-testbed-key \
           N8N_DIAGNOSTICS_ENABLED=false N8N_VERSION_NOTIFICATIONS_ENABLED=false \
           N8N_EXECUTION_ENGINE="$ENGINE" N8N_LIBPETRI_BUDGET="$BUDGET" \
           N8N_LIBPETRI_HOOK="$HOOK" \
           N8N_LIBPETRI_RESOLVE_FROM="$N8N_DIR/packages/cli/package.json"
    # Each n8n process starts its own internal task broker, and the default port is the same
    # one the main process already took — the worker exits with "n8n Task Broker's port 5679 is
    # already in use". A real deployment gives each worker host its own broker (or an external
    # one); here the second port is `--port + 2`, next to n8n's own `--port + 1` default.
    export N8N_RUNNERS_BROKER_PORT=$(( PORT + 2 ))
    # No `${#QUEUE_ENV[@]}` guard here, unlike the main process's export: this branch only runs
    # under `[ $QUEUE -eq 1 ]`, where the array was populated above. The guard matters because
    # macOS's system bash (3.2) treats `"${a[@]}"` on an empty array as an unbound variable
    # under `set -u`; bash 4.4 and later do not. Keep both forms as they are.
    export "${QUEUE_ENV[@]}"
    exec node --import "$HERE/preload.mjs" "$N8N_DIR/packages/cli/bin/n8n" worker
  ) >"$TESTBED/n8n-worker.log" 2>&1 &
  WORKER_PID=$!

  # The gate. A worker that booted without the engine is worse than one that did not boot.
  deadline=$(( $(date +%s) + 120 ))
  until grep -q 'n8n worker is now ready' "$TESTBED/n8n-worker.log" 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || die "the worker did not come up; see $TESTBED/n8n-worker.log"
    kill -0 "$WORKER_PID" 2>/dev/null || die "the worker exited during startup; see $TESTBED/n8n-worker.log"
    sleep 1
  done
  if [ "$ENGINE" = libpetri ]; then
    grep -q 'scheduler registered' "$TESTBED/n8n-worker.log" \
      || die "the worker registered no scheduler; it would run n8n's stack loop. See $TESTBED/n8n-worker.log"
    log "worker: $(grep -m1 'scheduler registered' "$TESTBED/n8n-worker.log")"
  fi
  log "the worker is up"
fi

# --- 5. seed -----------------------------------------------------------------------------------
if [ $SEED -eq 1 ]; then
  TESTBED_BASE_URL="http://127.0.0.1:$PORT" TESTBED_DIR="$TESTBED" STUB_LLM_PORT="$LLM_PORT" \
    TESTBED_ENGINE_V2="$V2" TESTBED_RESOLVE_FROM="$N8N_DIR/packages/cli/package.json" \
    node "$HERE/seed.mjs" || die "seeding failed"
fi

if [ $SEED_ONLY -eq 1 ]; then
  log "--seed-only: stopping"
  exit 0
fi

if [ $DAEMON -eq 1 ]; then
  echo "$N8N_PID" >"$TESTBED/n8n.pid"
  echo "$STUB_PID" >"$TESTBED/stub-llm.pid"
  # Written when there is a worker, **removed when there is not**. The other two pidfiles are
  # rewritten on every run and so cannot go stale; this one can. A `--queue --daemon` instance
  # killed without `--stop` leaves its pidfile behind, and a later plain `--daemon` run would
  # then hand `--stop` a pid the operating system has since given to something else.
  if [ -n "$WORKER_PID" ]; then
    echo "$WORKER_PID" >"$TESTBED/n8n-worker.pid"
  else
    rm -f "$TESTBED/n8n-worker.pid"
  fi
  trap - EXIT INT TERM   # the point of --daemon is that the children outlive this shell
  log "--daemon: n8n (pid $N8N_PID)${WORKER_PID:+, the worker (pid $WORKER_PID)} and the stub LLM (pid $STUB_PID) left running on port $PORT"
  log "stop them with: scripts/testbed/n8n-testbed.sh --stop"
  exit 0
fi

# --- 6. hand over ------------------------------------------------------------------------------
cat <<BANNER

  n8n is running at   http://127.0.0.1:$PORT/
  sign in with        $(node -e 'const f=require(process.argv[1]);console.log(f.email, "/", f.password)' "$TESTBED/ids.json" 2>/dev/null || echo "see $TESTBED/ids.json")
  engine              $ENGINE$([ "$ENGINE" = libpetri ] && echo " (k = $BUDGET)")$([ $V2 -eq 1 ] && echo "; engine v2 with settlement=$SETTLEMENT")

$(node -e '
  try {
    const f = require(process.argv[1]);
    for (const w of f.workflows) console.log(`  ${w.name.padEnd(22)} ${f.base}/workflow/${w.id}`);
  } catch { console.log("  (no ids.json; run without --no-seed)"); }
' "$TESTBED/ids.json" 2>/dev/null)

  Open a workflow and press "Execute workflow". Then, to prove the net ran it rather than
  n8n's own code:

    grep '$([ $V2 -eq 1 ] && echo 'settlement policy entered' || echo 'engine entered')' $TESTBED/n8n.log

  Logs: $TESTBED/n8n.log, $TESTBED/stub-llm.log.  Ctrl-C stops both processes.

BANNER

wait "$N8N_PID"
