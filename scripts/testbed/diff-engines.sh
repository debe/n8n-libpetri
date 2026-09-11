#!/usr/bin/env bash
# diff-engines.sh — run the seeded demo workflows under n8n's own scheduler and under the net,
# in a real n8n server, and compare what came out.
#
# This is the leg the conformance suite cannot supply. `scripts/run-conformance.sh` measures
# n8n's test cases against `FakeHost`; `docs/state-of-the-project.md` records the `cli` scope as
# "registered, never entered". Here the engine is entered by the process n8n ships, with its own
# editor, node types, task runner, credentials and persistence in place.
#
#   scripts/testbed/diff-engines.sh                       # legacy, libpetri k=1, libpetri k=4
#   scripts/testbed/diff-engines.sh --budgets=1,2,4,8
#   scripts/testbed/diff-engines.sh --repeat=3            # three runs per leg, best wall clock
#   scripts/testbed/diff-engines.sh --workflows="Concurrency Showcase"
#
# Only the workflows both engines finish the same way are comparable, and that is what
# `--workflows` defaults to. Most of the rest of the seed exists to show a *difference* — the
# tool-deadline agent is canceled at n8n's execution timeout, the waiting child suspends for
# seventy seconds, the failure-policy workflow declares a chain n8n's own fields do not carry —
# so a leg-against-leg diff of those compares two intended outcomes and reports the feature as a
# failure. Name one explicitly to run it anyway.
#
# The engine is fixed when the process starts (the preload reads N8N_EXECUTION_ENGINE once), so
# each leg is its own server: boot, seed, run every workflow, stop.
#
# Output: a Markdown table per workflow on stdout, captures under .testbed/runs/.
# Exit 1 if any leg's data differs from the legacy leg's, or if any happens-before edge inverted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/testbed"
TESTBED="$ROOT/.testbed"
RUNS="$TESTBED/runs"
PORT=5678; LLM_PORT=5699; BUDGETS="1,4"; REPEAT=1
WORKFLOWS="Concurrency Showcase,Agent · Two Tools,Agent · Nested Agents"

for arg in "$@"; do
  case "$arg" in
    --budgets=*) BUDGETS="${arg#--budgets=}" ;;
    --port=*)    PORT="${arg#--port=}" ;;
    --llm-port=*) LLM_PORT="${arg#--llm-port=}" ;;
    --repeat=*)  REPEAT="${arg#--repeat=}" ;;
    --workflows=*) WORKFLOWS="${arg#--workflows=}" ;;
    -h|--help)   sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log() { printf '[diff %s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die() { log "error: $*"; exit 1; }

rm -rf "$RUNS"; mkdir -p "$RUNS"
trap '"$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true' EXIT

# leg <label> <engine> <budget> — one server, every workflow, then stop.
leg() {
  local label=$1 engine=$2 budget=$3
  log "leg $label: booting n8n (engine=$engine, budget=$budget)"
  "$HERE/n8n-testbed.sh" --daemon --engine="$engine" --budget="$budget" \
      --port="$PORT" --llm-port="$LLM_PORT" >/dev/null 2>&1 \
    || die "leg $label failed to boot; see $TESTBED/n8n.log"

  if [ "$engine" = libpetri ]; then
    grep -q 'scheduler registered' "$TESTBED/n8n.log" || die "leg $label: no scheduler registered"
  fi

  # The seeded names, filtered to the ones asked for — and a name that was not seeded is an
  # error rather than a silent skip, because the alternative is a table with a row missing.
  local names; names=$(node -e '
    const ids = require(process.argv[1]);
    const seeded = new Set(ids.workflows.map((w) => w.name));
    const wanted = process.argv[2].split(",").map((s) => s.trim()).filter(Boolean);
    const missing = wanted.filter((name) => !seeded.has(name));
    if (missing.length) {
      console.error(`not seeded: ${missing.join(", ")}`);
      process.exit(1);
    }
    process.stdout.write(wanted.join("\n"));
  ' "$TESTBED/ids.json" "$WORKFLOWS") || die "leg $label: see above"

  local name slug best out attempt
  while IFS= read -r name; do
    slug=$(printf '%s' "$name" | tr -cs '[:alnum:]' '-' | tr '[:upper:]' '[:lower:]' | sed 's/-*$//')
    out="$RUNS/$slug.$label.json"
    attempt="$RUNS/$slug.$label.attempt.json"   # .json, so `node -e require()` parses it as data
    best=""
    for _ in $(seq 1 "$REPEAT"); do
      TESTBED_BASE_URL="http://127.0.0.1:$PORT" TESTBED_DIR="$TESTBED" \
        node "$HERE/run.mjs" "$name" "$attempt" >&2 || die "leg $label: '$name' did not succeed"
      # Keep the fastest attempt: the wall clock is the number this leg is measured on, and a
      # cold first run pays for the task runner's start-up rather than for the scheduler.
      local elapsed; elapsed=$(node -e 'console.log(require(process.argv[1]).elapsedMs)' "$attempt")
      if [ -z "$best" ] || [ "$elapsed" -lt "$best" ]; then best=$elapsed; mv "$attempt" "$out"; else rm -f "$attempt"; fi
    done
    log "leg $label: $name -> ${best} ms"
  done <<< "$names"

  "$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true
  sleep 1
}

leg "legacy" legacy 1
LABELS=("legacy")
IFS=',' read -r -a budgets <<< "$BUDGETS"
for k in "${budgets[@]}"; do
  leg "libpetri-k$k" libpetri "$k"
  LABELS+=("libpetri-k$k")
done

# --- compare -----------------------------------------------------------------------------------
status=0
for reference in "$RUNS"/*.legacy.json; do
  slug=$(basename "$reference" .legacy.json)
  candidates=()
  for label in "${LABELS[@]:1}"; do candidates+=("$RUNS/$slug.$label.json"); done
  (cd "$ROOT/typescript" && node_modules/.bin/tsx tests/testbed/compare-run.ts "$reference" "${candidates[@]}") || status=1
done

echo
if [ $status -eq 0 ]; then
  echo "All legs agree with n8n's own scheduler on data, and no dependency edge inverted."
else
  echo "At least one leg differs from n8n's own scheduler; see the notes above." >&2
fi
exit $status
