#!/usr/bin/env bash
# make-gifs.sh — turn the recordings under .testbed/video/ into the GIFs the docs embed.
#
# GIF rather than the WebM itself, because GitHub sanitises <video> out of Markdown: a committed
# WebM renders as a download link, while a GIF plays inline in the README, on the repository page
# and in the mobile app.
#
#   scripts/testbed/make-gifs.sh                    # every clip listed below
#   scripts/testbed/make-gifs.sh concurrency-showcase
#
# Records first if a clip is missing? No — this only converts. Record with:
#   scripts/testbed/record-demo.sh --attach --workflow="<name>"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/.testbed/video"
OUT="$ROOT/docs/media"
WIDTH=900
FPS=10

# clip:hold — `hold` is the seconds the final frame is held before the GIF loops. A GIF restarts
# with no pause, so a run would reach its result and immediately throw it away. The recording
# already ends on 1.5 s of the finished canvas, so this adds a second beat rather than the only
# one. Cloned frames are identical, so the hold costs almost nothing in file size.
CLIPS="
concurrency-showcase:1.5
resilient-fan-out:1.5
agent-tool-deadline:1.5
agent-nested-agents:1.5
agent-escalation-ladder:1.5
"

log() { printf '[gifs] %s\n' "$*"; }
die() { printf '[gifs] error: %s\n' "$*" >&2; exit 1; }

command -v ffmpeg >/dev/null || die "ffmpeg is not installed"
mkdir -p "$OUT"

wanted="${1:-}"
made=0

for pair in $CLIPS; do
  name="${pair%%:*}"; hold="${pair##*:}"
  [ -z "$wanted" ] || [ "$wanted" = "$name" ] || continue

  src="$SRC/$name-libpetri-k4.webm"
  if [ ! -f "$src" ]; then
    log "skipping $name: no recording at ${src#$ROOT/}"
    continue
  fi

  # One palette per clip, generated from the same filter chain the encode uses. A shared or
  # default palette bands the editor's flat greys, which is most of every frame.
  chain="fps=$FPS,scale=$WIDTH:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=$hold"
  palette="$(mktemp -t gifpal).png"
  ffmpeg -loglevel error -i "$src" -vf "$chain,palettegen=stats_mode=diff" -y "$palette" \
    || die "could not build a palette for $name"
  ffmpeg -loglevel error -i "$src" -i "$palette" \
    -lavfi "$chain[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" -y "$OUT/$name.gif" \
    || die "could not encode $name"
  rm -f "$palette"

  secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$name.gif" | cut -d. -f1)
  log "$(printf '%-26s %ss  %s' "$name.gif" "${secs:-?}" "$(du -h "$OUT/$name.gif" | cut -f1)")"
  made=$((made + 1))
done

[ "$made" -gt 0 ] || die "nothing to convert${wanted:+ (no clip called '$wanted')}"
log "$made GIF(s) in ${OUT#$ROOT/}"
