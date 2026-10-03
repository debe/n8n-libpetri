# Release neutrality: patches 0001/0002 at the released n8n versions

The installer adds patches 0001/0002 (the v1 scheduler seam) to a released n8n's `n8n-core`. With
nothing registered, n8n must then behave as stock. This page records the run that shows it for
each shipped seam, at the release tag the seam was built from. Each manifest under
`typescript/seams/n8n-core/` carries the result as its `neutrality` record, and `install`
refuses a manifest without a passing one unless `--allow-unverified` is given.

Measured 2026-10-03 with `scripts/release/neutrality.sh`: macOS arm64, Node 26.8.1, pnpm 12.4.2
through corepack, vitest 4.1.9, typescript/ built against registry libpetri 7.0.0. Raw artefacts
are in the gitignored `conformance-results/release/<version>/`.

## What was run

Per release, in a throwaway clone of `.n8n` under `/private/tmp`, removed afterwards (`.n8n`'s
HEAD and `git status` checked equal before and after):

1. A detached checkout of the release tag. pnpm install, the turbo build of the
   `n8n-nodes-base` chain, and the **unpatched baseline**: `packages/core`, path filter
   `src/execution-engine`, CI junit.
2. `git apply` of 0001 and 0002 exactly as committed (no fuzz).
3. `pnpm --filter n8n-core typecheck` on the patched tree. The shipped seams are a type-blind
   per-file transpile, so this is where a type error would show.
4. The same suite twice on the patched tree, through `scripts/run-conformance.sh --skip-patch`:
   - **legacy**: nothing registered, so n8n's own loop runs behind the seam. This is the
     neutrality leg and the pass criterion. It must be identical to the baseline, case by case.
   - **libpetri**: `PetriScheduler` registered at k = 1. An engine leg, reported here, not a
     criterion.

## Results

The legacy leg is a patch-neutrality leg (CLAUDE.md reporting rule). Its headline is
loop-driving cases identical to the baseline, with pure-helper cases stated separately.

| n8n tag | n8n-core | seams | typecheck | baseline | legacy vs baseline | loop-driving (legacy) | pure-helper (legacy) |
|---|---|---|---|---|---|---|---|
| `n8n@2.41.6` (`f5da43d`) | 2.41.4 | `2.41.4/` | passed | 1,723/1,723 | **identical** (0 cases differ) | 45/45 | 1,678/1,678 |
| `n8n@2.42.2` (`eb8d7c2`) | 2.42.2 | `2.42.2/` | passed | 1,746/1,746 | **identical** (0 cases differ) | 45/45 | 1,701/1,701 |

The 2.41.4 seams also cover n8n 2.41.5, which pins the same `n8n-core` 2.41.4. `packages/core`
is identical between the `n8n@2.41.5` and `n8n@2.41.6` tags (`git diff --quiet`), so the run at
2.41.6 stands for both.

The engine leg, for reference (not a neutrality result):

| n8n tag | libpetri k = 1 | loop-driving | pure-helper | regressions |
|---|---|---|---|---|
| `n8n@2.41.6` | 1,719/1,723 | 41/45 | 1,678/1,678 | the same 4 as at the pin |
| `n8n@2.42.2` | 1,742/1,746 | 41/45 | 1,701/1,701 | the same 4 as at the pin |

The four are the recorded ones ([`conformance-master.md`](conformance-master.md),
[`divergences.md`](divergences.md)): three `v1 execution order` cases (stuck-join handling and
OR/join ordering) and `waiting tools > resets responses between different node executions`.

## What this shows, and what it does not

- It shows that the **source patches**, applied to each release, leave n8n-core's
  execution-engine suite identical with nothing registered, and that the patched tree
  typechecks.
- The installer does not apply the source patches; it applies per-file transpiles of the
  patched source (`scripts/release/build-seams.mjs`). That generator's gate is that the
  unpatched transpile of every touched file reproduces the published JS byte for byte, and
  `build-seams.mjs --check` reproduces the committed seams, records included, byte for byte
  (re-run 2026-10-03). The link from this run to the installed bytes is therefore that gate,
  not a run of the suite against the installed `dist`.
- The scope is n8n-core's execution-engine suite, the scope whose cases drive the scheduler
  loop. The broader `core`, `workflow` and `cli` scopes were run at the master pin, not at the
  release tags.
- Installed-but-inactive behaviour of a real n8n process was checked on single workflows by the
  Docker smoke test and the npm end-to-end script (`docs/install.md`). Those are integration
  results, not conformance numbers.
