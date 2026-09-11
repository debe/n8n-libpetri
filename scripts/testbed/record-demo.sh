#!/usr/bin/env bash
# record-demo.sh — record a WebM of one seeded workflow running in the real editor.
#
# browser-check.sh proves the canvas with a screenshot; this captures the thing a screenshot
# cannot: four branches lighting up at once, one of them retrying and one of them giving up on a
# deadline, and the run finishing anyway. The engine underneath is the Petri net.
#
#   scripts/testbed/record-demo.sh                          # Resilient Fan-Out at k = 4
#   scripts/testbed/record-demo.sh --workflow="Agent · Two Tools"
#   scripts/testbed/record-demo.sh --budget=1 --attach
#   scripts/testbed/record-demo.sh --fps=4                  # play the time-lapse back faster
#   scripts/testbed/record-demo.sh --viewport=1920x1200     # wider frame for a big canvas
#   scripts/testbed/record-demo.sh --llm-latency=1300       # a stub that answers at a model's pace
#
# `--llm-latency` is what makes an agent clip legible. The stub answers instantly, so an agent
# round — model, tool, model again — lands inside a single frame and the canvas turns green all
# at once. At 1300 ms the beats separate and the recording shows the round unfolding. It changes
# no outcome, and it is off everywhere a wall clock is reported.
#
# One screenshot costs about 1.2 s of CLI round trip, so this is a *time-lapse* of real editor
# frames rather than a smooth screencast: a five-second run yields four or five frames of it.
# That is enough to show the shape — every branch dispatched at once, one of them ending red,
# the workflow finishing anyway — and every frame is the real thing.
#
# Video: .testbed/video/<workflow>-<engine>-k<budget>.webm
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/testbed"
TESTBED="$ROOT/.testbed"
VIDEO="$TESTBED/video"
ENGINE=libpetri; BUDGET=4; PORT=5678; LLM_PORT=5699; ATTACH=0; FPS=2; WORKFLOW="Resilient Fan-Out"
LLM_LATENCY=0
VIEWPORT=1600x1000

for arg in "$@"; do
  case "$arg" in
    --engine=*)   ENGINE="${arg#--engine=}" ;;
    --budget=*)   BUDGET="${arg#--budget=}" ;;
    --port=*)     PORT="${arg#--port=}" ;;
    --llm-port=*) LLM_PORT="${arg#--llm-port=}" ;;
    --llm-latency=*) LLM_LATENCY="${arg#--llm-latency=}" ;;
    --workflow=*) WORKFLOW="${arg#--workflow=}" ;;
    --fps=*)      FPS="${arg#--fps=}" ;;
    --viewport=*) VIEWPORT="${arg#--viewport=}" ;;
    --attach)     ATTACH=1 ;;
    -h|--help)    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log() { printf '[record %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[record] error: %s\n' "$*" >&2; exit 1; }

command -v agent-browser >/dev/null || die "agent-browser is not installed"

if [ $ATTACH -eq 0 ]; then
  "$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true
  log "booting n8n (engine=$ENGINE, budget=$BUDGET$([ "$LLM_LATENCY" -gt 0 ] 2>/dev/null && echo ", llm latency ${LLM_LATENCY} ms"))"
  "$HERE/n8n-testbed.sh" --daemon --engine="$ENGINE" --budget="$BUDGET" --port="$PORT" \
    --llm-port="$LLM_PORT" --llm-latency="$LLM_LATENCY" >/dev/null \
    || die "n8n did not boot; see $TESTBED/n8n.log"
  trap '"$HERE/n8n-testbed.sh" --stop >/dev/null 2>&1 || true; agent-browser close >/dev/null 2>&1 || true' EXIT
fi

BASE="http://127.0.0.1:$PORT"
[ -f "$TESTBED/ids.json" ] || die "$TESTBED/ids.json is missing; run n8n-testbed.sh first"
mkdir -p "$VIDEO"

id=$(node -e '
  const ids = require(process.argv[1]);
  const w = ids.workflows.find((w) => w.name === process.argv[2]);
  if (!w) { console.error(`no seeded workflow named "${process.argv[2]}"`); process.exit(1); }
  console.log(w.id);
' "$TESTBED/ids.json" "$WORKFLOW") || die "workflow '$WORKFLOW' is not seeded"

slug=$(printf '%s' "$WORKFLOW" | tr -cs '[:alnum:]' '-' | tr '[:upper:]' '[:lower:]' | sed 's/-*$//')
OUT="$VIDEO/$slug-$ENGINE-k$BUDGET.webm"
RAW="$VIDEO/.raw-$slug-$ENGINE-k$BUDGET.webm"

# Same ref helper as browser-check.sh: the last match wins, because the canvas repeats some
# names and the toolbar's control is rendered last.
ref() {
  agent-browser snapshot -i -c 2>/dev/null \
    | grep -oE "$1 \"$2\" \[ref=e[0-9]+\]" | tail -1 | grep -oE 'e[0-9]+' || true
}

# `wait --load networkidle` never settles here: the editor holds a push connection open, and in
# a *recording* context (a fresh browser) there is no cached bundle to shorten the wait either.
# Poll the accessibility tree for the control instead — that is the thing being waited for.
refWithin() {
  local role="$1" name="$2" deadline=$(( SECONDS + ${3:-30} )) found=''
  while [ $SECONDS -lt $deadline ]; do
    found=$(ref "$role" "$name")
    [ -n "$found" ] && { printf '%s' "$found"; return 0; }
    sleep 1
  done
  return 1
}

# `wait --url` / `wait --text` carry a fixed 25 s budget, and a *recording* context is a cold
# browser: no cached bundle, so the editor's first paint and its first execution both run long.
# Poll instead, with a budget this script controls.
urlLeaves() {
  local pattern="$1" deadline=$(( SECONDS + ${2:-60} ))
  while [ $SECONDS -lt $deadline ]; do
    case "$(agent-browser get url 2>/dev/null | tail -1)" in *"$pattern"*) sleep 1 ;; *) return 0 ;; esac
  done
  return 1
}

textWithin() {
  local needle="$1" deadline=$(( SECONDS + ${2:-90} ))
  while [ $SECONDS -lt $deadline ]; do
    agent-browser get text 2>/dev/null | grep -qF "$needle" && return 0
    sleep 1
  done
  return 1
}

# n8n binds its auth JWT to a browser id it keeps per context, so `agent-browser record`'s
# fresh context lands back on the login page however faithfully it copies cookies. Its
# screencast is also change-driven: it collapsed a five-second execution into a two-frame
# flipbook, which is the one thing this video exists to show.
#
# So the capture is done by hand: click Execute, then screenshot the viewport on a fixed
# interval until n8n says the run finished, and let ffmpeg assemble the frames. What comes out
# is a real recording of the real editor at a known frame rate.
# A fixed frame, so every clip in a set is the same size and a wide workflow is not cropped to
# whatever the browser defaulted to.
agent-browser viewport "${VIEWPORT%x*}" "${VIEWPORT#*x}" >/dev/null 2>&1 || true
COOKIE=$(node -e '
  const ids = require(process.argv[1]);
  fetch(`${ids.base}/rest/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "browser-id": "recorder" },
    body: JSON.stringify({ emailOrLdapLoginId: ids.email, password: ids.password }),
  }).then((r) => {
    const jar = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(";")[0]);
    console.log(jar.join("; "));
  }).catch(() => console.log(""));
' "$TESTBED/ids.json")
[ -n "$COOKIE" ] || die "could not authenticate against the REST API to poll the execution"

# --- the recording ------------------------------------------------------------------------------
# `agent-browser record start` opens its **own** browser context, which carries none of this
# machine's cookies — it lands on /signin. So the sign-in happens inside the recording and is
# cut off the front afterwards, rather than being done first and lost.
# Seed before recording as well as after. The restore below guarantees the *fixture* is left
# clean; this guarantees the *canvas in the video* starts clean, which is a different promise —
# a recording that began after a dirtied save would show the dirt however tidy the database is
# by the time it ends.
TESTBED_BASE_URL="$BASE" TESTBED_DIR="$TESTBED" STUB_LLM_PORT="$LLM_PORT" \
  node "$HERE/seed.mjs" >/dev/null 2>&1 || log "warning: could not re-seed before recording"

log "recording '$WORKFLOW'"
agent-browser record start "$RAW" "$BASE/signin" >/dev/null 2>&1 || die "could not start recording"
REC_T0=$(node -e 'console.log(Date.now())')

email=$(refWithin textbox Email 45 || true)
if [ -n "$email" ]; then
  password=$(ref textbox Password); submit=$(ref button "Sign in")
  [ -n "$password" ] && [ -n "$submit" ] || die "the sign-in form did not render as expected"
  agent-browser fill "@$email" "$(node -e 'console.log(require(process.argv[1]).email)' "$TESTBED/ids.json")" >/dev/null
  agent-browser fill "@$password" "$(node -e 'console.log(require(process.argv[1]).password)' "$TESTBED/ids.json")" >/dev/null
  agent-browser click "@$submit" >/dev/null
  urlLeaves "/signin" 90 || die "sign-in did not leave the login page"
fi

agent-browser open "$BASE/workflow/$id" >/dev/null
button=$(refWithin button "Execute workflow" 60 || true)
[ -n "$button" ] || die "no Execute workflow button on '$WORKFLOW'"
agent-browser wait 1200 >/dev/null

# Frame the canvas. n8n's own "Zoom to Fit" control rather than its keyboard shortcut: the
# shortcut only lands when focus is already on the canvas pane, and after a page load it is not.
# A fresh snapshot first, because refs go stale across a navigation.
agent-browser snapshot -i >/dev/null 2>&1 || true
fit=$(ref button "Zoom to Fit" 2>/dev/null || true)
if [ -n "$fit" ]; then
  agent-browser click "@$fit" >/dev/null 2>&1 || true
  agent-browser wait 900 >/dev/null
else
  log "no Zoom to Fit control found; recording at whatever zoom the editor restored"
fi
agent-browser wait 900 >/dev/null   # a beat of the framed idle canvas before anything moves

# Everything before this instant is sign-in and navigation, and gets trimmed off the front.
TRIM_MS=$(( $(node -e 'console.log(Date.now())') - REC_T0 ))
started=$(node -e 'console.log(Date.now())')
agent-browser click "@$button" >/dev/null

# n8n's success toast auto-dismisses and `get text` does not always carry it, so the run is
# considered finished when the *execution* is — read from n8n's own REST API, not the DOM.
finishedRun() {
  node -e '
    const ids = require(process.argv[1]);
    fetch(`${ids.base}/rest/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId: process.argv[2] }))}&limit=1`,
      { headers: { cookie: process.argv[3], "browser-id": "recorder" } })
      .then((r) => r.json())
      .then((j) => {
        const e = (j.data?.results ?? j.data ?? [])[0];
        process.exit(e && e.status !== "running" && e.status !== "new" ? 0 : 1);
      })
      .catch(() => process.exit(1));
  ' "$TESTBED/ids.json" "$id" "$COOKIE" 2>/dev/null
}

deadline=$(( SECONDS + 180 ))
while [ $SECONDS -lt $deadline ]; do
  finishedRun && break
  agent-browser wait 400 >/dev/null 2>&1 || sleep 1
done
finished=$(node -e 'console.log(Date.now())')
log "'$WORKFLOW' finished in about $(( finished - started )) ms (browser round trip included)"

agent-browser wait 1500 >/dev/null   # hold on the result, so the video ends on the outcome.
                                     # Short, because make-gifs.sh holds the last frame again
                                     # before the loop restarts — the two holds add up.
agent-browser record stop >/dev/null 2>&1 || die "could not stop recording"

# Restore the fixture. n8n saves a workflow before every manual execute, so whatever the editor
# held — including anything a mis-landed click added — is written back to the database by the
# act of running it. The canvas controls put "Add sticky note" in the same group as "Zoom to
# Fit", and a stale ref between snapshot and click has hit it. Re-seeding after each recording
# makes that harmless instead of permanent: the committed JSON is the authority, and a recording
# must not be able to edit the thing it is recording.
TESTBED_BASE_URL="$BASE" TESTBED_DIR="$TESTBED" STUB_LLM_PORT="$LLM_PORT" \
  node "$HERE/seed.mjs" >/dev/null 2>&1 || log "warning: could not re-seed after recording"

# The file is flushed asynchronously once the recording context closes, so wait for it to stop
# growing rather than merely to exist. `[ -s ]` turns true on the first byte, while the encoder is
# still writing the container — trimming that produced a 480-byte file with no decodable stream,
# and the failure was silent because ffmpeg happily re-encodes an empty input.
prev=-1; stable=0
for _ in $(seq 1 60); do
  cur=$(wc -c <"$RAW" 2>/dev/null | tr -d ' ' || echo 0)
  if [ "${cur:-0}" -gt 4096 ] && [ "$cur" = "$prev" ]; then
    stable=$((stable + 1)); [ "$stable" -ge 2 ] && break
  else
    stable=0
  fi
  prev="$cur"; sleep 0.5
done
[ -s "$RAW" ] || die "no video was written to $RAW"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW" >/dev/null 2>&1 \
  || die "the recording at $RAW has no decodable stream (it was read before the encoder finished)"

# Drop the sign-in and the navigation, keeping a second of framed idle canvas before the click.
# Re-encoded rather than stream-copied: a copy can only cut on a keyframe, and at 10 fps with
# long GOPs that rounds the cut to somewhere unhelpful.
skip=$(node -e "console.log(Math.max(0, ($TRIM_MS - 1000) / 1000).toFixed(2))")
ffmpeg -y -v error -ss "$skip" -i "$RAW" -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 0 -crf 34 \
  -an "$OUT" 2>/dev/null || die "ffmpeg could not trim the recording"
rm -f "$RAW"
secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null | cut -d. -f1)
[ -n "$secs" ] && [ "$secs" -ge 1 ] 2>/dev/null \
  || die "the trimmed video at $OUT is empty; the trim point (${skip}s) may be past its end"
log "video: $OUT ($(du -h "$OUT" | cut -f1), ${secs:-?} s, sign-in trimmed at ${skip}s)"

if [ "$ENGINE" = libpetri ]; then
  grep -q 'engine entered' "$TESTBED/n8n.log" \
    || die "the workflow ran, but nothing entered the engine — n8n used its own scheduler"
  log "$(grep -m1 'engine entered' "$TESTBED/n8n.log")"
fi
