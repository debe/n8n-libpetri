#!/usr/bin/env bash
#
# neutrality.sh — the release-neutrality run for one n8n release (tasks/inject-plan.md step 9):
# does n8n, at a released tag, behave as stock with patches 0001/0002 applied and nothing
# registered? It is the evidence a seam manifest's `neutrality` record points at.
#
#   scripts/release/neutrality.sh n8n@<version> [--keep | --summary-only]
#
# --summary-only rewrites summary.json from the artefacts of an earlier run, without a clone.
#
# Steps, all in a throwaway clone under /private/tmp (never in .n8n):
#
#   1. `git clone --local --no-checkout .n8n`, then a detached checkout of the tag. A clone,
#      not a worktree: a worktree registers itself in .n8n/.git, a local clone changes nothing
#      there. .n8n's HEAD and `git status` are recorded before and checked after.
#   2. scripts/bootstrap-n8n.sh in the clone (N8N_DIR, N8N_BOOTSTRAP_COMMIT): pnpm through
#      corepack at the tag's pin, install, build, and the **unpatched baseline** of the
#      execution-engine suite.
#   3. `git apply` of 0001 and 0002, exact context (no fuzz: a patch that does not apply as
#      written fails the run).
#   4. `pnpm --filter n8n-core typecheck` on the patched tree (the shipped seams are a type-blind
#      transpile, so this is where a type error would show).
#   5. scripts/run-conformance.sh --skip-patch in the clone, both legs:
#        legacy    the patched tree with nothing registered (n8n's loop behind the seam), which
#                  must be identical to the baseline: the neutrality leg, and the pass criterion
#        libpetri  PetriScheduler registered: an engine leg, reported, not a pass criterion
#   6. Results to conformance-results/release/<version>/ (gitignored), a summary.json the
#      manifest record is written from, and the clone removed (unless --keep).
#
# Reporting (CLAUDE.md): the legacy leg is a patch-neutrality leg. Its headline is loop-driving
# cases identical to the baseline, with pure-helper cases stated separately.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAG="${1:?usage: neutrality.sh n8n@<version> [--keep | --summary-only]}"
KEEP=0; SUMMARY_ONLY=0
case "${2:-}" in --keep) KEEP=1 ;; --summary-only) SUMMARY_ONLY=1; KEEP=1 ;; esac
VERSION="${TAG#n8n@}"
SOURCE="$ROOT/.n8n"
CLONE="/private/tmp/n8n-libpetri-neutrality-$VERSION"
RESULTS="$ROOT/conformance-results/release/$VERSION"
PATCHES=("$ROOT/patches/n8n/0001-extract-scheduler-loop.patch" "$ROOT/patches/n8n/0002-scheduler-registry.patch")

log() { printf '[neutrality %s %s] %s\n' "$VERSION" "$(date '+%H:%M:%S')" "$*"; }
die() { log "FAIL: $*" >&2; exit 1; }

source_state() { printf '%s\n' "$(git -C "$SOURCE" rev-parse HEAD)"; git -C "$SOURCE" status --porcelain=v1 | shasum -a 256; }
BEFORE="$(source_state)"
cleanup() {
  local rc=$?
  if [ $KEEP -eq 0 ] && [ -d "$CLONE" ]; then rm -rf "$CLONE"; fi
  if [ "$(source_state)" != "$BEFORE" ]; then log "FAIL: .n8n changed during the run"; rc=1; fi
  exit $rc
}
trap cleanup EXIT

git -C "$SOURCE" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "no tag $TAG in .n8n"
COMMIT="$(git -C "$SOURCE" rev-parse "refs/tags/$TAG^{commit}")"
if [ $SUMMARY_ONLY -eq 1 ]; then
  PREV="$RESULTS/summary.json"
  [ -f "$PREV" ] || die "no $PREV to re-summarise"
  CORE_VERSION="$(node -p "require('$PREV').n8nCore")"
  TYPECHECK="$(node -p "require('$PREV').typecheck")"
  CONFORMANCE_RC="$(node -p "require('$PREV').conformanceExit")"
else
  [ ! -e "$CLONE" ] || die "$CLONE exists; remove it first"
  mkdir -p "$RESULTS"

  log "1. clone .n8n at $TAG ($COMMIT) into $CLONE"
  git clone --quiet --local --no-checkout "$SOURCE" "$CLONE"
  git -C "$CLONE" -c advice.detachedHead=false checkout --quiet --detach "$COMMIT"
  CORE_VERSION="$(node -p "require('$CLONE/packages/core/package.json').version")"
  log "   n8n-core $CORE_VERSION"

  log "2. bootstrap: install, build, unpatched baseline"
  N8N_DIR="$CLONE" N8N_RESULTS="$RESULTS" N8N_BOOTSTRAP_COMMIT="$COMMIT" N8N_BOOTSTRAP_TAG="$TAG" \
    "$ROOT/scripts/bootstrap-n8n.sh" > "$RESULTS/bootstrap.log" 2>&1 || die "bootstrap failed; see $RESULTS/bootstrap.log"

  log "3. apply 0001/0002 (exact context)"
  for p in "${PATCHES[@]}"; do
    git -C "$CLONE" apply --check "$p" || die "$(basename "$p") does not apply to $TAG"
    git -C "$CLONE" apply "$p"
  done
  git -C "$CLONE" diff --stat > "$RESULTS/patched.stat.txt"
  git -C "$CLONE" status --porcelain=v1 >> "$RESULTS/patched.stat.txt"

  log "4. typecheck n8n-core on the patched tree"
  TYPECHECK=passed
  (cd "$CLONE" && PATH="$RESULTS/.corepack-bin:$PATH" pnpm --filter n8n-core typecheck) > "$RESULTS/typecheck.log" 2>&1 || TYPECHECK=failed
  log "   typecheck $TYPECHECK"

  log "5. execution-engine suite: legacy (neutrality) and libpetri (engine) legs"
  CONFORMANCE_RC=0
  N8N_DIR="$CLONE" N8N_RESULTS="$RESULTS" "$ROOT/scripts/run-conformance.sh" --skip-patch --engines=legacy,libpetri \
    > "$RESULTS/conformance.log" 2>&1 || CONFORMANCE_RC=$?

fi

log "6. summary"
node - "$RESULTS" "$TAG" "$COMMIT" "$CORE_VERSION" "$TYPECHECK" "$CONFORMANCE_RC" > "$RESULTS/summary.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [dir, tag, commit, core, typecheck, rc] = process.argv.slice(2);
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
// Attribute values may contain '>' (case names like "a > b"), so attributes are matched as
// quoted strings. A case can repeat under one key (vitest projects), so outcomes are kept as
// a multiset per key.
const cases = (xml) => {
  const out = [];
  for (const m of xml.matchAll(/<testcase\s((?:[^>"]|"[^"]*")*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (n) => (m[1].match(new RegExp(`(?:^|\\s)${n}="([^"]*)"`)) ?? [])[1] ?? '';
    const body = m[3] ?? '';
    const status = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    out.push([`${attr('classname')} > ${attr('name')}`, status]);
  }
  return out;
};
const matrix = (label) => {
  const md = read(`${label}.matrix.md`);
  return md === null ? null : md.split('\n').filter((l) => /loop-driving|helper|identical|regress|headline/i.test(l)).slice(0, 12);
};
const base = read('baseline.junit.xml');
const legacy = read('legacy.junit.xml');
const libpetri = read('libpetri.junit.xml');
const b = base ? cases(base) : [];
const l = legacy ? cases(legacy) : [];
const p = libpetri ? cases(libpetri) : [];
// Per key, the sorted outcomes; a key whose outcomes differ between baseline and legacy differs.
const byKey = (list) => list.reduce((m, [k, s]) => m.set(k, [...(m.get(k) ?? []), s].sort()), new Map());
const bk = byKey(b);
const lk = byKey(l);
const differs = [...new Set([...bk.keys(), ...lk.keys()])].filter((k) => JSON.stringify(bk.get(k)) !== JSON.stringify(lk.get(k)));
const count = (list, s) => list.filter(([, v]) => v === s).length;
const summary = {
  tag, commit, n8nCore: core, date: new Date().toISOString().slice(0, 10),
  patches: ['0001-extract-scheduler-loop.patch', '0002-scheduler-registry.patch'],
  typecheck,
  suite: 'packages/core src/execution-engine (vitest, CI=true junit)',
  baseline: { cases: b.length, passed: count(b, 'pass'), failed: count(b, 'fail'), skipped: count(b, 'skip') },
  legacy: { cases: l.length, passed: count(l, 'pass'), failed: count(l, 'fail'), skipped: count(l, 'skip'), differingFromBaseline: differs, matrix: matrix('legacy') },
  libpetri: { cases: p.length, passed: count(p, 'pass'), failed: count(p, 'fail'), skipped: count(p, 'skip'), matrix: matrix('libpetri') },
  conformanceExit: Number(rc),
};
summary.passed = typecheck === 'passed' && b.length > 0 && l.length === b.length && differs.length === 0;
console.log(JSON.stringify(summary, null, 2));
NODE
cat "$RESULTS/summary.json"
node -e "process.exit(require('$RESULTS/summary.json').passed ? 0 : 1)" || die "not neutral; see $RESULTS"
log "neutral: the patched $TAG with nothing registered is identical to its unpatched baseline"
