#!/usr/bin/env bash
#
# smoke.sh — smoke-test a locally built n8n-libpetri image (tasks/inject-plan.md step 10; v1
# path only). An integration result, never a conformance number.
#
#   scripts/docker/smoke.sh [n8n-version] [--image <tag>] [--legs 1,2,3,4,5,6,7,8] [--out <dir>]
#
# Default n8n version 2.41.6, image n8n-libpetri:<package version>-n8n<version> (build it with
# scripts/docker/build.sh), base image n8nio/n8n:<version>. One n8n container at a time, each
# with --memory=700m and SQLite in a throwaway volume; every container, the volume and the
# network carry a run label and are removed on exit, whatever happened. Legs:
#
#   1. `n8n-libpetri status` in the image reports `installed`
#   2. engine off: import:workflow, then `execute --id` on a fixture with a join and a retry and
#      no Code node; succeeds, and no `[n8n-libpetri]` line appears
#   3. engine on (N8N_EXECUTION_ENGINE=libpetri, plus a user's own EXTERNAL_HOOK_FILES entry):
#      the user's hook still loads, `scheduler registered`, `hook confirmed the preload
#      registration` and `engine entered` appear, and the run data and node order equal leg 2's
#      (error stacks stripped)
#   4. N8N_EXECUTION_ENGINE=libpetrx: n8n refuses to start, with our message
#   5. overdue wait: a Wait-node execution (70 s) put to wait with the engine on, its waitTill
#      passed while no n8n runs, then `n8n start` with the engine on: `scheduler registered` comes
#      before n8n's first line (`Initializing n8n process`), so before the `WaitTracker` can resume
#      anything (divergence row 40), and the resume prints `engine entered` and succeeds
#   6. `uninstall` (as root), then every n8n-core file hashes as in the base image
#   7. queue-mode worker boot: a Redis container plus `n8n worker` with the user's own
#      NODE_OPTIONS (--max-old-space-size=256, which the wrapper appends the preload to) logs
#      `scheduler registered` and the hook's confirmation
#   8. no preload: the entrypoint replaced (`--entrypoint n8n`) and the user's own NODE_OPTIONS
#      without the preload, engine on: the hook finds no registration and n8n refuses to start
#
# Logs and outputs go to --out (default: a fresh directory under ${TMPDIR:-/tmp}).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
N8N_VERSION=2.41.6
IMAGE=""
LEGS="1,2,3,4,5,6,7,8"
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?}"; shift 2 ;;
    --image=*) IMAGE="${1#--image=}"; shift ;;
    --legs) LEGS="${2:?}"; shift 2 ;;
    --legs=*) LEGS="${1#--legs=}"; shift ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --out=*) OUT="${1#--out=}"; shift ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "smoke.sh: unknown flag $1" >&2; exit 2 ;;
    *) N8N_VERSION="$1"; shift ;;
  esac
done
if [ -z "$IMAGE" ]; then
  VERSION="$(node -p "require('$ROOT/typescript/package.json').version")"
  IMAGE="n8n-libpetri:${VERSION}-n8n${N8N_VERSION}"
fi
BASE="n8nio/n8n:${N8N_VERSION}"
OUT="${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/n8n-libpetri-smoke.XXXXXX")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

RUN_ID="lp-smoke-$$-$(date +%s)"
VOLUME="$RUN_ID"
NETWORK="$RUN_ID"
LABEL="n8n-libpetri-smoke=$RUN_ID"
FIXTURES="$ROOT/scripts/docker/fixtures"
CORE_LINK=/usr/local/lib/node_modules/n8n/node_modules/n8n-core
N8N_DIR=/usr/local/lib/node_modules/n8n
MEM=700m

log() { printf '[smoke %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "FAIL: $*" >&2; exit 1; }
want() { case ",$LEGS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

cleanup() {
  local ids
  ids="$(docker ps -aq --filter "label=$LABEL" 2>/dev/null || true)"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no image $IMAGE; build it with scripts/docker/build.sh $N8N_VERSION"
docker volume create --label "$LABEL" "$VOLUME" >/dev/null
docker network create --label "$LABEL" "$NETWORK" >/dev/null

# Every n8n container: the run label, the memory cap, the shared SQLite volume, the fixtures.
N8N_ENV=(
  -e N8N_ENCRYPTION_KEY=n8n-libpetri-smoke-key
  -e N8N_DIAGNOSTICS_ENABLED=false
  -e N8N_VERSION_NOTIFICATIONS_ENABLED=false
  -e N8N_TEMPLATES_ENABLED=false
  -e N8N_PERSONALIZATION_ENABLED=false
)
n8n_run() { # <docker run flags...> -- <image> <args...>
  docker run --label "$LABEL" --memory="$MEM" --network "$NETWORK" \
    -v "$VOLUME:/home/node/.n8n" -v "$FIXTURES:/fixtures:ro" "${N8N_ENV[@]}" "$@"
}
# The JSON object `execute --rawOutput` prints, from its first `{` line to the matching `}` line.
EXTRACT='const t=require("fs").readFileSync(0,"utf8").split("\n");const a=t.indexOf("{"),b=t.indexOf("}",a);if(a<0||b<0)process.exit(1);process.stdout.write(t.slice(a,b+1).join("\n"))'
wait_exit() { # <container> <seconds>: 0 if it exited in time
  local i
  for i in $(seq 1 "$2"); do
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = false ] && return 0
    sleep 1
  done
  return 1
}
wait_log() { # <container> <pattern> <seconds>
  local i
  for i in $(seq 1 "$3"); do
    docker logs "$1" 2>&1 | grep -q -- "$2" && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = true ] || return 1
    sleep 1
  done
  return 1
}

log "image $IMAGE on $BASE; out $OUT"

# --- 1 ---------------------------------------------------------------------------------------
if want 1; then
  log "leg 1: status"
  docker run --rm --label "$LABEL" --entrypoint n8n-libpetri "$IMAGE" status --n8n "$N8N_DIR" > "$OUT/status.txt" 2>&1 || die "status exited $?; see $OUT/status.txt"
  sed 's/^/    /' "$OUT/status.txt"
  grep -qx 'state: installed' "$OUT/status.txt" || die "status does not report installed"
fi

# --- 2 ---------------------------------------------------------------------------------------
if want 2 || want 3; then
  log "leg 2: engine off, import:workflow + execute --id"
  n8n_run --rm "$IMAGE" import:workflow --input=/fixtures/join-retry.json > "$OUT/import.log" 2>&1 || die "import failed; see $OUT/import.log"
  n8n_run --rm "$IMAGE" execute --id=LpSmokeJoinRtry1 --rawOutput > "$OUT/off.stdout" 2> "$OUT/off.stderr" || die "execute with the engine off exited $?; see $OUT/off.*"
  if grep -q '\[n8n-libpetri\]' "$OUT/off.stdout" "$OUT/off.stderr"; then die "n8n-libpetri lines with the engine off"; fi
  node -e "$EXTRACT" < "$OUT/off.stdout" > "$OUT/off.json" || die "no run JSON in $OUT/off.stdout"
  log "  succeeded; no [n8n-libpetri] line"
fi

# --- 3 ---------------------------------------------------------------------------------------
if want 3; then
  log "leg 3: engine on, execute --id"
  n8n_run --rm -e N8N_EXECUTION_ENGINE=libpetri -e EXTERNAL_HOOK_FILES=/fixtures/user-hook.cjs "$IMAGE" \
    execute --id=LpSmokeJoinRtry1 --rawOutput > "$OUT/on.stdout" 2> "$OUT/on.stderr" || die "execute with the engine on exited $?; see $OUT/on.*"
  grep -q '\[smoke\] user hook loaded' "$OUT/on.stderr" || die "the user's own hook file did not load next to ours; see $OUT/on.stderr"
  grep -q '\[n8n-libpetri\] scheduler registered' "$OUT/on.stderr" || die "no 'scheduler registered'; see $OUT/on.stderr"
  grep -q '\[n8n-libpetri\] hook confirmed the preload registration' "$OUT/on.stderr" || die "the hook did not confirm the registration; see $OUT/on.stderr"
  grep -q '\[n8n-libpetri\] engine entered' "$OUT/on.stderr" || die "no 'engine entered'; see $OUT/on.stderr"
  sed 's/^/    /' "$OUT/on.stderr"
  node -e "$EXTRACT" < "$OUT/on.stdout" > "$OUT/on.json" || die "no run JSON in $OUT/on.stdout"
  node - "$OUT/off.json" "$OUT/on.json" <<'EOF' || die "run data differs between engine off and on"
const fs = require('fs');
const [off, on] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
// An error's stack names the frames that ran; everything else in the run data must be equal.
const strip = (v) => Array.isArray(v) ? v.map(strip)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'stack').map(([k, x]) => [k, strip(x)])) : v;
const view = (d) => Object.fromEntries(Object.entries(d.data.resultData.runData)
  .map(([k, runs]) => [k, runs.map((r) => ({ data: strip(r.data), source: r.source, executionStatus: r.executionStatus }))]));
const order = (d) => Object.entries(d.data.resultData.runData).flatMap(([k, runs]) => runs.map((r) => [r.executionIndex, k]))
  .sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' > ');
const a = JSON.stringify(view(off)), b = JSON.stringify(view(on));
for (const [name, d] of [['off', off], ['on', on]]) {
  if (d.status !== 'success') { console.error(`engine ${name}: status ${d.status}`); process.exit(1); }
  const t = d.data.resultData.runData['Unreachable Service']?.[0]?.executionTime ?? 0;
  // Two tries with waitBetweenTries 1000 ms: the node's run spans the wait, so a retry happened.
  if (t < 1000) { console.error(`engine ${name}: Unreachable Service took ${t} ms, so no retry ran`); process.exit(1); }
}
if (a !== b) { console.error(`run data differs:\n  off ${a}\n  on  ${b}`); process.exit(1); }
if (order(off) !== order(on)) { console.error(`node order differs:\n  off ${order(off)}\n  on  ${order(on)}`); process.exit(1); }
const runData = on.data.resultData.runData;
console.log(`    run data equal (${Object.keys(runData).length} nodes, order ${order(on)}); Join items ${runData.Join[0].data.main[0].length}; retry spans ${runData['Unreachable Service'][0].executionTime} / ${off.data.resultData.runData['Unreachable Service'][0].executionTime} ms (on / off)`);
EOF
fi

# --- 4 ---------------------------------------------------------------------------------------
if want 4; then
  log "leg 4: N8N_EXECUTION_ENGINE=libpetrx"
  cid="$(n8n_run -d -e N8N_EXECUTION_ENGINE=libpetrx "$IMAGE" start)"
  wait_exit "$cid" 120 || die "n8n kept running with N8N_EXECUTION_ENGINE=libpetrx"
  docker logs "$cid" > "$OUT/typo.log" 2>&1
  code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
  docker rm -f "$cid" >/dev/null
  [ "$code" != 0 ] || die "n8n exited 0 with N8N_EXECUTION_ENGINE=libpetrx"
  grep -q "must be 'libpetri' or unset, got 'libpetrx'" "$OUT/typo.log" || die "the refusal does not name the value; see $OUT/typo.log"
  log "  refused (exit $code): $(grep -m1 'refusing to start' "$OUT/typo.log")"
fi

# --- 5 ---------------------------------------------------------------------------------------
if want 5; then
  log "leg 5: overdue wait resumed at boot"
  n8n_run --rm "$IMAGE" import:workflow --input=/fixtures/overdue-wait.json > "$OUT/import-wait.log" 2>&1 || die "import failed; see $OUT/import-wait.log"
  n8n_run --rm -e N8N_EXECUTION_ENGINE=libpetri "$IMAGE" execute --id=LpSmokeOverdueW1 --rawOutput > "$OUT/wait-put.stdout" 2> "$OUT/wait-put.stderr" || die "execute of the wait fixture exited $?; see $OUT/wait-put.*"
  put_at="$(date +%s)"
  node -e "$EXTRACT" < "$OUT/wait-put.stdout" > "$OUT/wait-put.json" || die "no run JSON in $OUT/wait-put.stdout"
  wait_till="$(node -p "const d=require('$OUT/wait-put.json'); d.waitTill ?? d.data.waitTill ?? ''")"
  log "  put to wait (status $(node -p "require('$OUT/wait-put.json').status"), waitTill ${wait_till:-?}); no n8n runs until it passes"
  remaining=$(( put_at + 75 - $(date +%s) ))
  [ "$remaining" -le 0 ] || sleep "$remaining"
  cid="$(n8n_run -d -e N8N_EXECUTION_ENGINE=libpetri "$IMAGE" start)"
  query='
    const { createRequire } = require("module");
    const sqlite3 = createRequire("/usr/local/lib/node_modules/n8n/package.json")("sqlite3");
    const db = new sqlite3.Database("/home/node/.n8n/database.sqlite", sqlite3.OPEN_READONLY);
    db.get("SELECT id, status, finished FROM execution_entity WHERE workflowId = ? ORDER BY id DESC LIMIT 1", ["LpSmokeOverdueW1"],
      (e, row) => { if (e) { console.error(e.message); process.exit(1); } console.log(JSON.stringify(row ?? null)); db.close(); });'
  state=""
  for _ in $(seq 1 120); do
    state="$(docker exec "$cid" node -e "$query" 2>/dev/null || true)"
    case "$state" in *'"status":"success"'*|*'"status":"error"'*|*'"status":"crashed"'*) break ;; esac
    sleep 1
  done
  sleep 2
  docker logs "$cid" > "$OUT/wait-resume.log" 2>&1
  docker rm -f "$cid" >/dev/null
  echo "$state" > "$OUT/wait-resume.state"
  case "$state" in *'"status":"success"'*) ;; *) die "the overdue execution did not finish within 120 s: ${state:-no row}; see $OUT/wait-resume.log" ;; esac
  reg_line="$(grep -n '\[n8n-libpetri\] scheduler registered' "$OUT/wait-resume.log" | head -1 | cut -d: -f1)"
  ent_line="$(grep -n '\[n8n-libpetri\] engine entered' "$OUT/wait-resume.log" | head -1 | cut -d: -f1)"
  init_line="$(grep -n 'Initializing n8n process' "$OUT/wait-resume.log" | head -1 | cut -d: -f1)"
  [ -n "$reg_line" ] || die "no 'scheduler registered'; see $OUT/wait-resume.log"
  [ -n "$init_line" ] || die "no 'Initializing n8n process' line to order against; see $OUT/wait-resume.log"
  [ "$reg_line" -lt "$init_line" ] || die "registered at log line $reg_line, after n8n's first line ($init_line): the WaitTracker could resume first; see $OUT/wait-resume.log"
  [ -n "$ent_line" ] || die "the overdue resume ran on n8n's own loop (no 'engine entered'); see $OUT/wait-resume.log"
  log "  registered at log line $reg_line, before n8n's first line ($init_line); engine entered at line $ent_line: $state"
fi

# --- 6 ---------------------------------------------------------------------------------------
if want 6; then
  log "leg 6: uninstall, then compare n8n-core with $BASE"
  hash_core='cd "$(readlink -f '"$CORE_LINK"')" && find . -type f -not -path "./.n8n-libpetri/*" | LC_ALL=C sort | xargs sha256sum'
  docker run --rm --label "$LABEL" --entrypoint sh "$BASE" -c "$hash_core" > "$OUT/core-base.sha" || die "hashing the base image's n8n-core failed"
  docker run --rm --label "$LABEL" --user root --entrypoint sh "$IMAGE" -c \
    "n8n-libpetri uninstall --n8n $N8N_DIR >&2 && n8n-libpetri status --n8n $N8N_DIR >&2 && $hash_core" > "$OUT/core-uninstalled.sha" 2> "$OUT/uninstall.log" \
    || die "uninstall failed; see $OUT/uninstall.log"
  sed 's/^/    /' "$OUT/uninstall.log"
  grep -qx 'state: stock' "$OUT/uninstall.log" || die "status after uninstall is not stock"
  if ! diff -q "$OUT/core-base.sha" "$OUT/core-uninstalled.sha" >/dev/null; then
    diff "$OUT/core-base.sha" "$OUT/core-uninstalled.sha" | head
    die "n8n-core after uninstall differs from $BASE"
  fi
  log "  n8n-core byte-identical to $BASE: $(wc -l < "$OUT/core-base.sha" | tr -d ' ') files"
fi

# --- 7 ---------------------------------------------------------------------------------------
if want 7; then
  log "leg 7: queue-mode worker boot with Redis"
  docker run -d --label "$LABEL" --network "$NETWORK" --network-alias redis --memory=64m redis:7-alpine >/dev/null
  cid="$(n8n_run -d -e N8N_EXECUTION_ENGINE=libpetri -e EXECUTIONS_MODE=queue -e QUEUE_BULL_REDIS_HOST=redis \
    -e NODE_OPTIONS=--max-old-space-size=256 "$IMAGE" worker)"
  ok=0
  wait_log "$cid" 'scheduler registered' 120 && ok=1
  wait_log "$cid" 'n8n worker is now ready' 60 || true
  docker logs "$cid" > "$OUT/worker.log" 2>&1
  mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$cid" 2>/dev/null || true)"
  [ "$ok" = 1 ] || die "the worker did not log 'scheduler registered'; see $OUT/worker.log"
  grep -q '\[n8n-libpetri\] hook confirmed the preload registration' "$OUT/worker.log" || die "the worker's hook did not confirm the registration; see $OUT/worker.log"
  log "  $(grep -m1 'scheduler registered' "$OUT/worker.log")"
  log "  $(grep -m1 'worker is now ready' "$OUT/worker.log" || echo 'no ready line'); memory ${mem:-?}"
fi

# --- 8 ---------------------------------------------------------------------------------------
if want 8; then
  log "leg 8: engine on without the preload (entrypoint replaced, the user's own NODE_OPTIONS)"
  cid="$(n8n_run -d --entrypoint n8n -e N8N_EXECUTION_ENGINE=libpetri -e NODE_OPTIONS=--max-old-space-size=256 "$IMAGE" start)"
  wait_exit "$cid" 120 || die "n8n kept running with the engine on and no preload"
  docker logs "$cid" > "$OUT/no-preload.log" 2>&1
  code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
  docker rm -f "$cid" >/dev/null
  [ "$code" != 0 ] || die "n8n exited 0 with the engine on and no preload"
  grep -q 'no scheduler was registered before n8n started' "$OUT/no-preload.log" || die "the refusal does not name the missing preload; see $OUT/no-preload.log"
  if grep -q '\[n8n-libpetri\] engine entered' "$OUT/no-preload.log"; then die "an execution ran before the refusal"; fi
  log "  refused (exit $code): $(grep -m1 'refusing to start' "$OUT/no-preload.log" | cut -c1-160)"
fi

log "legs $LEGS passed"
