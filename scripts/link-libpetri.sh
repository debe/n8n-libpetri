#!/usr/bin/env bash
#
# Point `typescript/node_modules/libpetri` at the libpetri working tree.
#
# The two repositories are developed together, and this one is periodically the first consumer
# of a libpetri verification surface that has not shipped yet. That was the state until
# 2026-09-17: VER-018 / VER-019 / VER-022 were measured here against the tree, then released as
# libpetri 6.0.0.
#
# **A registry install is now the correct state.** `package.json` asks for `^6.0.0`, the lock
# pins it, and nothing here needs the link. Use this script only when the tree is again ahead of
# a release — and unlink before measuring anything you intend to report, because a number
# produced against a linked tree is not comparable with one produced against the registry.
#
# Idempotent. Run it after any `npm ci` / `npm install`, which restore the registry copy.
#
#   scripts/link-libpetri.sh              # link the sibling checkout
#   LIBPETRI=/path/to/libpetri  scripts/link-libpetri.sh
#   scripts/link-libpetri.sh --unlink     # go back to the registry copy
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
libpetri="${LIBPETRI:-$(cd "$here/.." && pwd)/libpetri}/typescript"
nm="$here/typescript/node_modules/libpetri"
backup="$here/typescript/node_modules/.libpetri-registry"

if [ "${1:-}" = "--unlink" ]; then
  [ -L "$nm" ] && rm -f "$nm"
  if [ -d "$backup" ] && [ ! -e "$nm" ]; then mv "$backup" "$nm"; fi
  echo "libpetri: registry copy restored"
  exit 0
fi

[ -d "$libpetri" ] || { echo "no libpetri checkout at $libpetri (set LIBPETRI)" >&2; exit 1; }

if [ ! -d "$libpetri/dist/verification" ]; then
  echo "libpetri: dist/ missing, building the working tree"
  (cd "$libpetri" && npm run build >/dev/null)
fi

# Keep the registry copy the first time, so --unlink has something to go back to.
if [ -d "$nm" ] && [ ! -L "$nm" ] && [ ! -e "$backup" ]; then mv "$nm" "$backup"; fi
[ -L "$nm" ] && rm -f "$nm"
[ -e "$nm" ] && rm -rf "$nm"
ln -s "$libpetri" "$nm"

# The link is worth nothing if the tree predates the surface the verifier needs; say so here
# rather than leaving it to the first report.
(cd "$here/typescript" && node --input-type=module -e "
import { SmtVerifier } from 'libpetri/verification';
import * as v from 'libpetri/verification';
const proto = SmtVerifier.prototype;
const missing = ['sinkPlacesWhen','stateEquation','enumerationMaxClasses','stateEquationPhase','firingBound']
  .filter((m) => typeof proto[m] !== 'function');
if (missing.length > 0) { console.error('libpetri tree is missing: ' + missing.join(', ')); process.exit(1); }
console.log('libpetri: linked to the working tree; VER-018/019 present'
  + (typeof v.verifyOpenNet === 'function' ? ', VER-022 present' : ', VER-022 absent'));
")
