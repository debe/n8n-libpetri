#!/usr/bin/env bash
# diff-engines-v2.sh — run the engine v2 testbed workflows under each settlement mode, read what the
# engine wrote over SQL, and compare (`tasks/v2-seam-plan.md` step 12).
#
#   scripts/testbed/diff-engines-v2.sh                         # off, primary, shadow, primary-shadowed
#   scripts/testbed/diff-engines-v2.sh --legs=off,primary      # a subset; the first is the reference
#   scripts/testbed/diff-engines-v2.sh --repeat=2 --loop-repeat=3
#   scripts/testbed/diff-engines-v2.sh --workflows="V2 Loop Over Items"
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
# executions and their step rows from the engine's data plane), `settlement.jsonl` (the ledger),
# `n8n.log` and `pg-stamp.txt`. Then `tests/testbed/compare-v2.ts` writes <out>/report.md and
# <out>/summary.json and prints the report.
#
# Default workflows: every seeded one except Waiting Child, which only its parent starts. Workflows
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
    -h|--help)       sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done
for n in "$REPEAT" "$LOOP_REPEAT"; do
  case "$n" in ''|*[!0-9]*|0) echo "--repeat and --loop-repeat must be positive integers" >&2; exit 2 ;; esac
done
IFS=',' read -r -a legs <<< "$LEGS"
for leg in "${legs[@]}"; do
  case "$leg" in off|primary|shadow|primary-shadowed) ;; *) echo "unknown leg: $leg" >&2; exit 2 ;; esac
done

log() { printf '[diff-v2 %s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die() { log "error: $*"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT"
trap '"$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true' EXIT

run_leg() { # run_leg <leg>
  local leg=$1 dir="$OUT/$1"
  mkdir -p "$dir/runs"
  log "leg $leg: booting (fresh sqlite, fresh Postgres, --timing)"
  "$HERE/n8n-testbed.sh" --v2 --settlement="$leg" --timing --fresh --daemon \
      --port="$PORT" --llm-port="$LLM_PORT" --pg-port="$PG_PORT" >"$dir/boot.log" 2>&1 \
    || { cp "$TESTBED/n8n.log" "$dir/" 2>/dev/null || true; die "leg $leg failed to boot; see $dir/boot.log"; }

  local names
  names=$(node -e '
    const ids = require(process.argv[1]);
    const seeded = ids.workflows.map((w) => w.name);
    const asked = process.argv[2] ? process.argv[2].split(",").map((s) => s.trim()).filter(Boolean)
                                  : seeded.filter((n) => n !== "Waiting Child");
    const missing = asked.filter((n) => !seeded.includes(n));
    if (missing.length) { console.error(`not seeded: ${missing.join(", ")}`); process.exit(1); }
    process.stdout.write(asked.join("\n"));
  ' "$TESTBED/ids.json" "$WORKFLOWS") || die "leg $leg: see above"

  local name slug times i out ids=()
  while IFS= read -r name; do
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

  # Executions can still be settling cancelled siblings after the REST status says ended; the
  # handler's last writes are milliseconds behind. Let them land before reading.
  sleep 2
  node "$HERE/dump-v2.mjs" "$("$HERE/pg.sh" url --port="$PG_PORT")" "$dir/sql.json" "${ids[@]}" >&2 \
    || die "leg $leg: the SQL dump failed"
  cp "$TESTBED/pg-stamp.txt" "$dir/"
  # Stop before copying the ledger: the preload flushes its buffer at exit.
  "$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true
  cp "$TESTBED/settlement.jsonl" "$TESTBED/n8n.log" "$dir/"
  log "leg $leg: ${#ids[@]} executions captured"
}

for leg in "${legs[@]}"; do run_leg "$leg"; done

status=0
(cd "$ROOT/typescript" && node_modules/.bin/tsx tests/testbed/compare-v2.ts "$OUT" "${legs[@]}") || status=$?
log "report: $OUT/report.md"
exit $status
