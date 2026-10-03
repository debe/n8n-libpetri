#!/usr/bin/env bash
# diff-engines-v2.sh — run the engine v2 testbed workflows under each settlement mode, read what the
# engine wrote over SQL, and compare (`tasks/v2-seam-plan.md` step 12).
#
#   scripts/testbed/diff-engines-v2.sh                         # off, primary, shadow, primary-shadowed
#   scripts/testbed/diff-engines-v2.sh --legs=off,primary      # a subset; the first is the reference
#   scripts/testbed/diff-engines-v2.sh --repeat=2 --loop-repeat=3
#   scripts/testbed/diff-engines-v2.sh --workflows="V2 Loop Over Items"
#   scripts/testbed/diff-engines-v2.sh --phases=webhook,concurrent,cancel   # only the live phases
#
# Phases, in this order, on one server per leg:
#   sequential  the seeded manual workflows one at a time (the step-12 comparison; F4 is measured here)
#   webhook     every activated webhook workflow's production URL, --webhook-repeat requests each, one
#               at a time (`responseMode: lastNode` is engine v2's `runEnd`, `responseNode` its
#               `stepResponse`): HTTP status, headers and body, and the rows each run left
#   concurrent  a batch of manual runs and webhook requests in flight at once (--concurrent-batch,
#               --concurrent-rounds), so settlements of different executions interleave
#   cancel      manual runs stopped through `POST /rest/executions/:id/stop` after swept delays
#               (--cancel-sweep), so some cancels land while a settlement is in flight
# The sequential phase is compared by `tests/testbed/compare-v2.ts` (report.md), the three live
# phases by `tests/testbed/compare-v2-live.ts` (live-report.md); the driver is `drive-v2.mjs`.
#
# Legs (each its own server, booted `--fresh`, so each has an empty sqlite and an empty Postgres):
#   off               patched, nothing registered: n8n's `defaultSettlementPolicy` answers
#   primary           the net-backed policy answers
#   shadow            n8n's default answers, ours runs beside it and every call is reported
#   primary-shadowed  ours answers, n8n's runs beside it and every call is reported
#
# Every leg runs with `--timing`, the preload's settlement timing instrument, installed the same way
# in every mode (in `off` it wraps n8n's default policy object in place; nothing is registered).
#
# Per leg, under <out>/<leg>/: `runs/*.json` (run.mjs's captures), `sql.json` (dump-v2.mjs: the
# executions and their step rows from the engine's data plane), `webhook/`, `concurrent/` and
# `cancel/` (drive-v2.mjs's captures), `live-sql.json` (the live phases' executions, webhook runs found
# by workflow), `ids.json`, `settlement.jsonl` (the ledger), `n8n.log` and `pg-stamp.txt`. Then
# `tests/testbed/compare-v2.ts` writes <out>/report.md and <out>/summary.json, and
# `tests/testbed/compare-v2-live.ts` writes <out>/live-report.md and <out>/live-summary.json.
#
# Default workflows: every seeded one except Waiting Child, which only its parent starts, and the
# webhook-triggered ones, which only the webhook and concurrent phases call. Workflows
# engine v2 refuses at a node (Code, AI sub-nodes, Execute Workflow) are kept: they are failure paths
# through the settlement handler.
#
# Everything this produces is an integration result: not a conformance number, not a policy-entering
# case count, not a neutrality leg, not settlement evidence. Wall clocks are not results.
#
# Exit 1 when compare-v2.ts reports a finding; 2 on a usage error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/testbed"
TESTBED="$ROOT/.testbed/v2"
OUT="$ROOT/.testbed/v2-diff"
LEGS="off,primary,shadow,primary-shadowed"
REPEAT=1; LOOP_REPEAT=3; WORKFLOWS=""; PORT=5678; LLM_PORT=5699; PG_PORT=55432
PHASES="sequential,webhook,concurrent,cancel"; WEBHOOK_REPEAT=6; CONCURRENT_ROUNDS=2
CONCURRENT_BATCH=""; CANCEL_SWEEP=""
LOOP=V2\ Loop\ Over\ Items

for arg in "$@"; do
  case "$arg" in
    --legs=*)        LEGS="${arg#--legs=}" ;;
    --repeat=*)      REPEAT="${arg#--repeat=}" ;;
    --loop-repeat=*) LOOP_REPEAT="${arg#--loop-repeat=}" ;;
    --workflows=*)   WORKFLOWS="${arg#--workflows=}" ;;
    --out=*)         OUT="${arg#--out=}" ;;
    --port=*)        PORT="${arg#--port=}" ;;
    --llm-port=*)    LLM_PORT="${arg#--llm-port=}" ;;
    --pg-port=*)     PG_PORT="${arg#--pg-port=}" ;;
    --phases=*)      PHASES="${arg#--phases=}" ;;
    --webhook-repeat=*)    WEBHOOK_REPEAT="${arg#--webhook-repeat=}" ;;
    --concurrent-rounds=*) CONCURRENT_ROUNDS="${arg#--concurrent-rounds=}" ;;
    --concurrent-batch=*)  CONCURRENT_BATCH="${arg#--concurrent-batch=}" ;;
    --cancel-sweep=*)      CANCEL_SWEEP="${arg#--cancel-sweep=}" ;;
    -h|--help)       sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done
for n in "$REPEAT" "$LOOP_REPEAT" "$WEBHOOK_REPEAT" "$CONCURRENT_ROUNDS"; do
  case "$n" in ''|*[!0-9]*|0) echo "--repeat, --loop-repeat, --webhook-repeat and --concurrent-rounds must be positive integers" >&2; exit 2 ;; esac
done
IFS=',' read -r -a phases <<< "$PHASES"
for phase in "${phases[@]}"; do
  case "$phase" in sequential|webhook|concurrent|cancel) ;; *) echo "unknown phase: $phase" >&2; exit 2 ;; esac
done
has_phase() { case ",$PHASES," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
IFS=',' read -r -a legs <<< "$LEGS"
for leg in "${legs[@]}"; do
  case "$leg" in off|primary|shadow|primary-shadowed) ;; *) echo "unknown leg: $leg" >&2; exit 2 ;; esac
done

log() { printf '[diff-v2 %s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die() { log "error: $*"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT"
# Absolute from here on: the `node -e` helpers `require()` paths under it, and Node reads a relative
# path that does not start with `./` as a package name.
OUT="$(cd "$OUT" && pwd)"
trap '"$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true' EXIT

run_leg() { # run_leg <leg>
  local leg=$1 dir="$OUT/$1"
  mkdir -p "$dir/runs"
  log "leg $leg: booting (fresh sqlite, fresh Postgres, --timing)"
  "$HERE/n8n-testbed.sh" --v2 --settlement="$leg" --timing --fresh --daemon \
      --port="$PORT" --llm-port="$LLM_PORT" --pg-port="$PG_PORT" >"$dir/boot.log" 2>&1 \
    || { cp "$TESTBED/n8n.log" "$dir/" 2>/dev/null || true; die "leg $leg failed to boot; see $dir/boot.log"; }

  cp "$TESTBED/ids.json" "$dir/"
  local names=""
  if has_phase sequential; then
    names=$(node -e '
      const ids = require(process.argv[1]);
      const seeded = ids.workflows.map((w) => w.name);
      const manual = ids.workflows.filter((w) => !w.webhook).map((w) => w.name);
      const asked = process.argv[2] ? process.argv[2].split(",").map((s) => s.trim()).filter(Boolean)
                                    : manual.filter((n) => n !== "Waiting Child");
      const missing = asked.filter((n) => !seeded.includes(n));
      if (missing.length) { console.error(`not seeded: ${missing.join(", ")}`); process.exit(1); }
      const hooks = asked.filter((n) => !manual.includes(n));
      if (hooks.length) { console.error(`webhook-triggered, not run manually: ${hooks.join(", ")}`); process.exit(1); }
      process.stdout.write(asked.join("\n"));
    ' "$TESTBED/ids.json" "$WORKFLOWS") || die "leg $leg: see above"
  fi

  local name slug times i out ids=()
  [ -n "$names" ] && while IFS= read -r name; do
    slug=$(printf '%s' "$name" | tr -cs '[:alnum:]' '-' | tr '[:upper:]' '[:lower:]' | sed 's/-*$//')
    times=$REPEAT; [ "$name" = "$LOOP" ] && times=$LOOP_REPEAT
    for i in $(seq 1 "$times"); do
      out="$dir/runs/$slug.$i.json"
      # A run that ends in `error` is an outcome to compare, not a failure of the leg; run.mjs exits 1
      # on it. A run that never ends (its timeout) or never starts writes no capture, and that is fatal.
      TESTBED_BASE_URL="http://127.0.0.1:$PORT" TESTBED_DIR="$TESTBED" TESTBED_RUN_TIMEOUT_MS=900000 \
        node "$HERE/run.mjs" "$name" "$out" >&2 || true
      [ -f "$out" ] || die "leg $leg: '$name' run $i wrote no capture (it did not start, or did not end within the timeout)"
      ids+=("$(node -e 'console.log(require(process.argv[1]).executionId)' "$out")")
    done
  done <<< "$names"

  local url
  url="$("$HERE/pg.sh" url --port="$PG_PORT")"
  if [ ${#ids[@]} -gt 0 ]; then
    # Executions can still be settling cancelled siblings after the REST status says ended; the
    # handler's last writes are milliseconds behind. Let them land before reading.
    sleep 2
    node "$HERE/dump-v2.mjs" "$url" "$dir/sql.json" "${ids[@]}" >&2 || die "leg $leg: the SQL dump failed"
    log "leg $leg: sequential phase, ${#ids[@]} executions captured"
  fi

  # The live phases. A driver failure (a run that never ended, a request that never came back) is
  # fatal: the comparison would be over a partial phase.
  local drive=(env TESTBED_BASE_URL="http://127.0.0.1:$PORT" TESTBED_DIR="$TESTBED" TESTBED_RUN_TIMEOUT_MS=900000 node "$HERE/drive-v2.mjs")
  local live=0
  if has_phase webhook; then
    log "leg $leg: webhook phase"
    "${drive[@]}" webhook "$dir/webhook" --repeat="$WEBHOOK_REPEAT" >&2 || die "leg $leg: the webhook phase failed"
    live=1
  fi
  if has_phase concurrent; then
    log "leg $leg: concurrent phase"
    local conc=(--rounds="$CONCURRENT_ROUNDS")
    [ -z "$CONCURRENT_BATCH" ] || conc+=(--batch="$CONCURRENT_BATCH")
    "${drive[@]}" concurrent "$dir/concurrent" "${conc[@]}" >&2 || die "leg $leg: the concurrent phase failed"
    live=1
  fi
  if has_phase cancel; then
    log "leg $leg: cancel phase"
    local sweep=()
    [ -z "$CANCEL_SWEEP" ] || sweep+=(--sweep="$CANCEL_SWEEP")
    # Same bash 3.2 guard as n8n-testbed.sh's: an empty array under `set -u` is unbound there.
    if [ ${#sweep[@]} -eq 0 ]; then "${drive[@]}" cancel "$dir/cancel" >&2 || die "leg $leg: the cancel phase failed"
    else "${drive[@]}" cancel "$dir/cancel" "${sweep[@]}" >&2 || die "leg $leg: the cancel phase failed"; fi
    live=1
  fi
  if [ $live -eq 1 ]; then
    # A step running at a cancel finishes (CAT-4757) and rows planned after it are cancelled at claim;
    # the Stop And Error Sibling's slow sibling takes 1.5 s. Let all of it land before reading, so a
    # row still `queued` or `running` in the dump is one the engine left, not one in flight.
    sleep 4
    local live_ids
    live_ids=$(node -e '
      const { readdirSync, readFileSync } = require("node:fs");
      const dir = process.argv[1];
      const ids = require(`${dir}/ids.json`);
      const out = new Set(ids.workflows.filter((w) => w.webhook).map((w) => `workflow:${w.id}`));
      for (const phase of ["webhook", "concurrent", "cancel"]) {
        let files = [];
        try { files = readdirSync(`${dir}/${phase}`).filter((f) => f.endsWith(".json")); } catch {}
        for (const f of files) { const c = JSON.parse(readFileSync(`${dir}/${phase}/${f}`, "utf8")); if (c.executionId) out.add(c.executionId); }
      }
      process.stdout.write([...out].join("\n"));
    ' "$dir") || die "leg $leg: could not list the live phases' executions"
    # shellcheck disable=SC2086 # one id per word
    node "$HERE/dump-v2.mjs" "$url" "$dir/live-sql.json" $live_ids >&2 || die "leg $leg: the live SQL dump failed"
  fi

  cp "$TESTBED/pg-stamp.txt" "$dir/"
  # Stop before copying the ledger: the preload flushes its buffer at exit.
  "$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true
  cp "$TESTBED/settlement.jsonl" "$TESTBED/n8n.log" "$dir/"
  log "leg $leg: done"
}

for leg in "${legs[@]}"; do run_leg "$leg"; done

status=0
if has_phase sequential; then
  (cd "$ROOT/typescript" && node_modules/.bin/tsx tests/testbed/compare-v2.ts "$OUT" "${legs[@]}") || status=$?
  log "report: $OUT/report.md"
fi
if has_phase webhook || has_phase concurrent || has_phase cancel; then
  (cd "$ROOT/typescript" && node_modules/.bin/tsx tests/testbed/compare-v2-live.ts "$OUT" "${legs[@]}") || status=$?
  log "live report: $OUT/live-report.md"
fi
exit $status
