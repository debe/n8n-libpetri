#!/usr/bin/env bash
# browser-check.sh — drive the real editor: sign in, open each seeded workflow, press
# "Execute workflow", wait for n8n's own success toast, and save a screenshot of the canvas.
#
# The headless leg (diff-engines.sh) proves the data. This proves the thing you actually see:
# n8n's editor, its canvas, its execution toast — with the net underneath.
#
#   scripts/testbed/browser-check.sh                  # boots its own server at k = 4
#   scripts/testbed/browser-check.sh --budget=1
#   scripts/testbed/browser-check.sh --attach         # use a server that is already running
#
# Screenshots: .testbed/shots/<workflow>-<engine>-k<budget>.png
# Exit 1 if a workflow does not report success, or if the engine was never entered.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/testbed"
TESTBED="$ROOT/.testbed"
SHOTS="$TESTBED/shots"
ENGINE=libpetri; BUDGET=4; PORT=5678; ATTACH=0

for arg in "$@"; do
  case "$arg" in
    --engine=*) ENGINE="${arg#--engine=}" ;;
    --budget=*) BUDGET="${arg#--budget=}" ;;
    --port=*)   PORT="${arg#--port=}" ;;
    --attach)   ATTACH=1 ;;
    -h|--help)  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log() { printf '[browser %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "error: $*" >&2; exit 1; }
command -v agent-browser >/dev/null || die "agent-browser is not installed"

# A named session, so this never steals the browser another agent (or the human) is using.
export AGENT_BROWSER_SESSION="${AGENT_BROWSER_SESSION:-n8n-libpetri-testbed}"

if [ $ATTACH -eq 0 ]; then
  "$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true
  log "booting n8n (engine=$ENGINE, budget=$BUDGET)"
  "$HERE/n8n-testbed.sh" --daemon --engine="$ENGINE" --budget="$BUDGET" --port="$PORT" >/dev/null \
    || die "n8n did not boot; see $TESTBED/n8n.log"
  trap '"$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true; agent-browser close >/dev/null 2>&1 || true' EXIT
fi

BASE="http://127.0.0.1:$PORT"
[ -f "$TESTBED/ids.json" ] || die "$TESTBED/ids.json is missing; run n8n-testbed.sh first"
mkdir -p "$SHOTS"

# ref <role> <name> — the last matching ref in the current snapshot. The canvas repeats some
# names (a node carries its own "Execute workflow" button as well as the toolbar's), and the
# toolbar's is the one rendered last.
# `|| true`: no match is an answer ("that control is not on this page"), not a failure, and
# under `set -e` a bare grep miss inside a command substitution aborts the script.
ref() {
  agent-browser snapshot -i -c 2>/dev/null \
    | grep -oE "$1 \"$2\" \[ref=e[0-9]+\]" | tail -1 | grep -oE 'e[0-9]+' || true
}

log "signing in at $BASE"
agent-browser open "$BASE/signin" >/dev/null
agent-browser wait --load networkidle >/dev/null
email=$(ref textbox Email); password=$(ref textbox Password); submit=$(ref button "Sign in")
if [ -n "$email" ]; then
  [ -n "$password" ] && [ -n "$submit" ] || die "the sign-in form did not render as expected"
  agent-browser fill "@$email" "$(node -e 'console.log(require(process.argv[1]).email)' "$TESTBED/ids.json")" >/dev/null
  agent-browser fill "@$password" "$(node -e 'console.log(require(process.argv[1]).password)' "$TESTBED/ids.json")" >/dev/null
  agent-browser click "@$submit" >/dev/null
  agent-browser wait --url "**/home/**" >/dev/null || die "sign-in did not reach the workflow list"
  log "signed in"
else
  log "already signed in"
fi

status=0
while IFS=$'\t' read -r name id; do
  slug=$(printf '%s' "$name" | tr -cs '[:alnum:]' '-' | tr '[:upper:]' '[:lower:]' | sed 's/-*$//')
  shot="$SHOTS/$slug-$ENGINE-k$BUDGET.png"
  log "opening '$name'"
  agent-browser open "$BASE/workflow/$id" >/dev/null
  agent-browser wait --load networkidle >/dev/null
  button=$(ref button "Execute workflow")
  [ -n "$button" ] || { log "error: no Execute workflow button on '$name'"; status=1; continue; }

  # node, not `date +%s%3N`: BSD date has no %N and silently emits a literal "N". This clock
  # brackets the browser round trip as well as the execution, so it is a demonstration figure —
  # diff-engines.sh is where the wall clock is actually measured.
  started=$(node -e 'console.log(Date.now())')
  agent-browser click "@$button" >/dev/null
  if agent-browser wait --text "Workflow executed successfully" >/dev/null 2>&1; then
    finished=$(node -e 'console.log(Date.now())')
    log "'$name' succeeded in about $(( finished - started )) ms (browser round trip included)"
  else
    log "error: '$name' did not report success"; status=1
  fi
  # The toast fires when the execution finishes; the canvas repaints its per-node results a
  # beat later. Without this settle the screenshot catches half-painted nodes.
  agent-browser wait --load networkidle >/dev/null 2>&1 || true
  agent-browser wait 700 >/dev/null 2>&1 || true
  agent-browser screenshot body "$shot" >/dev/null && log "screenshot: $shot"
done < <(node -e '
  for (const w of require(process.argv[1]).workflows) console.log(`${w.name}\t${w.id}`);
' "$TESTBED/ids.json")

if [ "$ENGINE" = libpetri ]; then
  grep -q 'engine entered' "$TESTBED/n8n.log" \
    || die "the workflows ran, but nothing entered the engine — n8n used its own scheduler"
  log "$(grep -m1 'engine entered' "$TESTBED/n8n.log")"
fi

exit $status
