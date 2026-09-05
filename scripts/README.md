# scripts/

Operational scripts around the gitignored n8n clone (`.n8n/`, Sustainable Use License, never
committed). Everything here is bash (`set -euo pipefail`), idempotent, and writes its artefacts
to the gitignored `conformance-results/`.

| Script | Purpose | Status |
|---|---|---|
| `bootstrap-n8n.sh` | Clone n8n at the pinned commit, pnpm via corepack, install, build, unpatched junit baseline | done (M1, track C1) |
| `run-conformance.sh` | Run the execution-engine suite under both schedulers and emit the matrix | done |
| `verify-patch.sh` | Re-apply `patches/n8n/*.patch` to the pinned commit; fail on drift | done |

## bootstrap-n8n.sh

```bash
scripts/bootstrap-n8n.sh                        # everything; ~90 s with a warm pnpm store
scripts/bootstrap-n8n.sh --skip-install --skip-build   # only re-run the baseline (~15 s)
scripts/bootstrap-n8n.sh --help
```

Flags: `--skip-install`, `--skip-build`, `--skip-test`, `--full-install` (whole monorepo
instead of the filtered closure), `--allow-dirty` (run the baseline although tracked files
under `.n8n/` are modified; the result is then not an unpatched baseline).
Env: `N8N_DIR` (default `.n8n`), `N8N_TEST_FILTER` (default `src/execution-engine`),
`COREPACK_VERSION` (default `0.36.0`, used only when no `corepack` is on `PATH`), `COREPACK_HOME`.

A single shell call in the agent harness is capped at 10 minutes; the script is well below that
but prints progress, so the safe pattern is to background it and poll:

```bash
scripts/bootstrap-n8n.sh > conformance-results/bootstrap.log 2>&1 &
tail -f conformance-results/bootstrap.log
```

### What it does, exactly

| # | Step | Command (run from `.n8n/`) |
|---|---|---|
| 1 | checkout | `git init && git remote add origin https://github.com/n8n-io/n8n.git && git fetch --depth 1 origin 441970b211d13a3ce547916b2b8ee93677b620e9 && git checkout --detach FETCH_HEAD` |
| 2 | corepack | `npx --yes corepack@0.36.0 pnpm --version` → must equal `package.json#packageManager` (`pnpm@11.25.0`) |
| 3 | install | `CI=true corepack pnpm install --frozen-lockfile --filter 'n8n-nodes-base...' --filter n8n-monorepo` |
| 4 | build | `corepack pnpm exec turbo run build --filter=n8n-nodes-base --output-logs=new-only` |
| 5 | baseline | `CI=true corepack pnpm --filter n8n-core run test src/execution-engine` → `packages/core/junit.xml` → `conformance-results/baseline.junit.xml` |

`corepack pnpm …` above means `corepack` if one is on `PATH`, else `npx --yes corepack@0.36.0`.
The version pnpm runs at is always resolved by corepack from `packageManager`; the script only
reads the field to verify (`COREPACK_ENABLE_STRICT=1`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`).
Step 2 also runs `corepack enable --install-directory conformance-results/.corepack-bin pnpm`
and prepends that directory to `PATH`, so turbo's per-package `pnpm run build` finds the same
pinned pnpm.

Postconditions checked: `HEAD == 441970b…`, no tracked modifications in `.n8n/` (the baseline
is *unpatched* by construction), pnpm version equals the pin, `packages/{workflow,core}/dist`,
`packages/@n8n/vitest-config/dist/node-decorators.js`, `packages/nodes-base/dist/known/nodes.json`
and `dist/nodes/If/If.node.js` exist, `junit.xml` was produced. Non-zero vitest exit still
copies the junit, then fails the script.

### Artefacts (`conformance-results/`, gitignored)

- `baseline.junit.xml` — vitest junit of the unpatched execution-engine suite.
- `baseline.summary.txt` — totals plus per-file case counts, derived from the junit.
- `bootstrap-env.txt` — versions used (node, npm, corepack, pnpm, git, turbo, vitest, commit).
- `bootstrap-timings.tsv` — one row per step per run (`utc  step  seconds  status`); a failed
  step's row carries `rc=<code>` and is the last row of that run.
- `.corepack-bin/{pnpm,pnpx}` — corepack shims, regenerated each run (see pitfalls).

### Toolchain used for the recorded runs

| Tool | Version | Note |
|---|---|---|
| macOS | Darwin 25.5.0 arm64 | 10 cores, 32 GB |
| node | v26.8.1 | Homebrew; **ships no corepack** (dropped in Node 25) |
| npm | 11.19.0 | only used for `npx corepack` |
| corepack | 0.36.0 | via `npx --yes corepack@0.36.0`; cache in `~/.cache/node/corepack` (21 MB) |
| pnpm | 11.25.0 | from `packageManager`; store `~/Library/pnpm/store/v11` (1.0 GB after bootstrap) |
| turbo | 2.9.15 | n8n root devDependency |
| vitest | 4.1.9 | n8n catalog |
| tsc | TypeScript 7.0.2 (tsgo) | n8n `typescript` catalog; the type-checked build is already fast |
| n8n | `441970b211d13a3ce547916b2b8ee93677b620e9` | master 2026-09-04T16:58:49Z, "feat(core): Log a decision audit line when a policy blocks an action (no-changelog) (#37880)", version 2.37.0 |

### Wall-clock timings (2026-09-04 and 2026-09-05, this machine)

| Run | checkout | corepack | install | build | baseline | total |
|---|---|---|---|---|---|---|
| 1. cold pnpm store, `n8n-core...` closure only (26 pkgs, 25 turbo tasks) | 17 s | 3 s | 65 s | 18 s | 6 test files fail to load (see below) | — |
| 2. incremental: add `n8n-nodes-base...` closure (29 pkgs, 27 tasks; 25 cached) | 1 s | 3 s | 11 s | 34 s | 12 s | 61 s |
| 3. **from scratch** (`rm -rf .n8n`), pnpm store warm, turbo cache cold | 16 s | 2 s | 11 s | 46 s (turbo 40.6 s) | 13 s | **88 s** |
| 4. idempotent re-run, nothing changed (turbo `FULL TURBO`, 27/27 cached) | 1 s | 2 s | 4 s | 2 s | 11 s | 20 s |
| 5. `--skip-install --skip-build` | 0 s | 3 s | — | — | 11 s | 14 s |
| 7. (09-05) failure path: `N8N_TEST_FILTER=no-such-dir --skip-install --skip-build` | 0 s | 3 s | — | — | 5 s, `rc=1` | exit 1 |
| 8. (09-05) **cold, final script**: `N8N_DIR=<scratch>/n8n-fresh` (no clone, pnpm store warm, turbo cache cold; 27/27 tasks built, turbo 40.55 s) | 15 s | 2 s | 13 s | 47 s | 14 s | **91 s** |
| 9. (09-05) canonical re-run on `.n8n/`, nothing changed (27/27 cached, FULL TURBO 1.3 s) | 1 s | 3 s | 4 s | 3 s | 13 s | 24 s |

Runs 7–9 were made with the final script (errexit-preserving `step`, see pitfalls). Run 8's
junit (`run8-fresh.junit.xml`) and run 9's (`baseline.junit.xml`) agree on every suite and
case: 75 files, 1657 cases, 0 failures, 0 skipped, 208 `workflow-execute` cases. The suite
order is identical (vitest's junit reporter emits suites in path order); the two files differ
only in `time`/`timestamp`/`hostname` attributes and in the absolute checkout path inside
stack traces that tests print to the console (`<system-out>`; 18 lines). With those normalised the
files are byte-identical, so a comparison of two junit files (baseline vs patched, later both
engines) should strip timing attributes and `<system-out>`/`<system-err>` and compare per
suite name and case name. `.n8n/` stays `git status`-clean and the scratch clone was deleted
after run 8.

Disk: `.n8n/` 1.7 GB of which `node_modules/` 1.1 GB (filtered install); pnpm store 1.0 GB.
A cold pnpm store on this network added about a minute to the install (run 1 vs run 3).
The vitest run itself is ~7 s (`import` dominates at ~25 s CPU across 5 forks; `CI=true`
caps `maxWorkers` at 50 % of the cores per `@n8n/vitest-config`).

### Baseline result (unpatched `441970b`, reproduced 2026-09-04 and 2026-09-05)

```
files     75        (all *.test.ts under packages/core/src/execution-engine, recursively)
tests     1657
failures  0
errors    0
skipped   0
workflow-execute files 4, cases 208
```

By directory: `__tests__/` 20 files / 633 cases, `partial-execution-utils/__tests__/` 14 / 118,
`node-execution-context/__tests__/` 11 / 310, `node-execution-context/utils/__tests__/` 25 / 523,
`node-execution-context/utils/request-helpers/__tests__/` 5 / 73.

Files whose name contains `workflow-execute`: `workflow-execute.test.ts` (125),
`workflow-execute-run-node.test.ts` (46), `workflow-execute-process-process-run-execution-data.test.ts`
(21), `workflow-execute-node-error-reporting.test.ts` (16). Which of these drive the
`executionLoop` (the ~19 loop-driving cases in `CLAUDE.md`'s reporting rule) is classified by
`src/conformance`, not here.

### The minimal package set, and why it is not the n8n-core chain

`packages/core/test/helpers/constants.ts` imports six node classes from
`../../../nodes-base/dist/nodes/{If,ManualTrigger,Merge,NoOp,Set,SplitInBatches}/*.node`
and `test/helpers/index.ts` reads `nodes-base/dist/known/nodes.json` (written by
`n8n-generate-metadata`, an `n8n-core` bin that loads every node). With only the `n8n-core...`
chain built, six execution-engine files fail at import time (`requests-response`,
`routing-node`, `sub-node-error-metadata`, `webhook-respond-branch-order`,
`workflow-execute-process-process-run-execution-data`, `workflow-execute`) and the junit shows
1461 cases / 6 failures. The correct minimal target is therefore **`n8n-nodes-base`**: its
turbo `build` (`dependsOn: ["^build"]`) builds the whole n8n-core chain first, then nodes-base
itself (`tsc --build` of ~4200 node/credential files under tsgo, `copy-nodes-json`,
`tsc-alias`, `n8n-copy-static-files`, `n8n-generate-translations`, `n8n-generate-metadata`,
`n8n-generate-node-defs`). 27 turbo tasks in total; the two on top of the core chain are
`n8n-nodes-base` and `@n8n/imap`. `n8n-containers` is in the install closure (devDependency of
nodes-base) but has no build script.

Install is filtered to that closure plus the workspace root (`--filter n8n-monorepo`, which
provides `turbo`, `tsc-alias`, root `typescript`). This keeps `cli`, the frontend and every
native module out: the full tree allows `sqlite3`, `isolated-vm` and
`@confluentinc/kafka-javascript` builds, which on Node 26 would compile from source and are
needed by nothing the conformance run touches. `--full-install` exists for the day the `n8n`
CLI package itself is needed.

Why turbo rather than `pnpm --filter 'n8n-nodes-base...' run build`: identical graph, but turbo
runs with concurrency 10 (pnpm defaults to 4), and its local cache
(`packages/**/.turbo`, `node_modules/.cache/turbo`) makes re-runs and partial rebuilds after a
patch cost only the changed package. `build:unchecked` (`tsc --noCheck`) was not needed: with
TypeScript 7 the checked build of all 27 tasks is 40 s.

### Pitfalls met, so nobody meets them twice

- **`set -e` is silently off inside `fn || rc=$?`, `if fn`, and `[ skip ] && log || step fn`.**
  The first version of this script timed each step with `"$fn" || rc=$?`, which makes bash
  ignore `errexit` for the whole step body: a failed `pnpm install` or `turbo run build` fell
  through to the postcondition checks, which a stale `dist/` from an earlier run satisfies,
  and the row said `ok`. Steps are now invoked as plain commands under `errexit`, and an `EXIT`
  trap writes the `rc=<code>` row for the step that was open. Verified two ways: a synthetic
  step whose function runs `(exit 3)` followed by an echo (the echo is never reached, exit 3,
  on bash 5.3 and macOS `/bin/bash` 3.2), and `N8N_TEST_FILTER=no-such-dir
  scripts/bootstrap-n8n.sh --skip-install --skip-build` (vitest exits 1, TSV row
  `baseline 5s rc=1`, script exit 1; log kept as `bootstrap-run7-failure-path.log`).
  Related: `"${empty[@]}"` is an unbound-variable error under `set -u` on bash 3.2, so the
  install filter expands as `${filter[@]+"${filter[@]}"}`; the shebang is `/usr/bin/env bash`
  and both interpreters pass `bash -n`.
- **No corepack on Node ≥ 25.** Homebrew's node 26 has no `corepack` binary and `pnpm` is not
  installed globally. `npx --yes corepack@0.36.0 pnpm …` runs the real corepack from the npm
  cache; nothing is installed globally and nothing is written into the repo. If you want a
  plain `pnpm` on your `PATH`: `npm i -g corepack && corepack enable` (touches
  `/opt/homebrew/bin`; the script neither needs nor does this).
- **`git fetch` needs the full sha.** `git fetch --depth 1 origin 441970b` fails
  (abbreviations are resolved client-side only) and even `gh api repos/n8n-io/n8n/commits/441970b`
  answers `422 No commit found` for the 7-character form. The full id
  `441970b211d13a3ce547916b2b8ee93677b620e9` is pinned in the script; it fetches in ~16 s
  (shallow, single commit, no tags).
- **`CI=true` is load-bearing twice.** `@n8n/vitest-config/node.ts` adds the junit reporter
  (`outputFile: { junit: './junit.xml' }`, i.e. `packages/core/junit.xml`) only when
  `process.env.CI === 'true'`; and n8n's root `prepare` script skips `pnpm lefthook install`
  under `CI`, which keeps git hooks out of `.n8n/.git`. pnpm also switches to the append-only
  reporter, which is what you want in a log file.
- **`pnpm --filter <pkg> run test <path>`** is how to pass vitest's path filter through pnpm
  without pnpm eating flags; `--filter` is a pnpm option, so `pnpm test --filter …` would not
  do what you mean. `pnpm exec turbo run build --filter=…` is fine because pnpm stops parsing at
  the command name.
- **Turbo needs a `pnpm` on `PATH` to run package scripts** (`Unable to find package manager
  binary: cannot find binary path` otherwise; verified by calling `node_modules/.bin/turbo`
  with a bare `PATH`). Neither a bundled corepack without `corepack enable` nor the npx route
  guarantees one, so the script runs `corepack enable --install-directory
  conformance-results/.corepack-bin pnpm` on every run and prepends that directory: two
  symlinks, `pnpm` and `pnpx`, pointing at whichever corepack ran (`…/corepack/dist/pnpm.js`),
  which again resolves the pinned version from `packageManager`. Reuse it by hand:
  `PATH="$PWD/conformance-results/.corepack-bin:$PATH"` then `cd .n8n && pnpm …`.
- **Install warnings that are fine.** `Failed to create bin at …/.bin/workflow-sdk` — the
  `@n8n/workflow-sdk` CLI bin is linked before its `dist/` exists; nothing here uses it.
  `Tarball download average speed … is below 50 KiB/s` and `Request took …ms` are registry
  latency notes. `[DEP0169] url.parse()` during the tests is Node 26 deprecation noise from a
  dependency.
- **`git status` in `.n8n/` stays empty.** `node_modules`, `dist`, `.turbo` and `junit.xml` are
  all in n8n's `.gitignore`; the script moves the junit out anyway. The dirty-tree check uses
  `git diff --quiet HEAD --` (tracked files only), so patches applied by `verify-patch.sh` will
  make the bootstrap refuse to call its run a baseline until `git -C .n8n checkout -- .`.
