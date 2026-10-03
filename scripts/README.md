# Scripts

These scripts manage the ignored `.n8n/` reference checkout and write evidence to the
ignored `conformance-results/` directory.

| Script | Purpose |
|---|---|
| `bootstrap-n8n.sh` | Fetch, install, build and test the pinned unpatched n8n commit. |
| `verify-patch.sh` | Reset the patch scope, apply both integration patches and optionally build it. |
| `check-n8n-drift.sh` | Read-only: dry-run the patches against the pin, `stable`, `beta`, the newest release and master, and list what touched the seam or engine v2 since the pin. |
| `n8n-pin.sh` | The pin (`N8N_TAG`, `N8N_COMMIT`), sourced by the three scripts above. |
| `pg-stamp.sh` | Docker preflight and the Postgres stamp for the integration scopes, sourced by `bootstrap-n8n.sh` and `run-conformance.sh`. |
| `run-conformance.sh` | Run selected n8n suites under the legacy or Petri scheduler and compare junit results. |
| `release/build-seams.mjs` | Build the installer's seams (`typescript/seams/n8n-core/<version>/`) for released n8n tags from patches 0001/0002, gated on reproducing the published n8n-core JS byte for byte; `--check` compares with the committed seams. Reads `.n8n`'s object database only. |
| `release/neutrality.sh` | The release-neutrality run for one n8n tag: a throwaway clone of `.n8n` under `/private/tmp` at the tag, bootstrap and unpatched baseline, 0001/0002 applied exactly, n8n-core typecheck, then the execution-engine suite with nothing registered (must be identical to the baseline) and under `PetriScheduler`. Writes `conformance-results/release/<version>/summary.json`, the source of a manifest's `neutrality` record (`docs/conformance-release.md`). A patch-neutrality leg. |
| `release/e2e-npm.sh` | The installer end to end against a real `npm i -g n8n@<version>`: install, activate, one REST run with and without the engine, a refused typo, uninstall to the stock bytes. An integration result, not a conformance number. |
| `docker/build.sh` | Build a local image `n8n-libpetri:<version>-n8n<n8n version>` from `docker/Dockerfile` on the official `n8nio/n8n` image, with an `npm pack` of this repository installed (v1 path only); `--allow-unverified` only for seams without a neutrality record. Never pushes. |
| `docker/smoke.sh` | Seven legs against a built image, one container at a time under `--memory=700m`: status, engine off, engine on with data equal to off, a refused typo, an overdue wait at boot (measured), uninstall to the base image's bytes, a queue-mode worker boot. Removes every container, volume and network it made. An integration result, not a conformance number. |
| `testbed/` | Boot the real n8n editor with the Petri scheduler installed, seed two demo workflows, and compare both engines in a live server. See [`testbed/README.md`](testbed/README.md). |

All scripts use `set -euo pipefail`, validate their postconditions and fail if expected junit
or build artifacts are missing.

## Bootstrap

```bash
scripts/bootstrap-n8n.sh
```

The default run:

1. creates a shallow checkout at
   the pin (`scripts/n8n-pin.sh`, currently n8n master `944afe5`) in `.n8n/`;
2. resolves the pnpm version from n8n's `packageManager` field through corepack;
3. installs the workspace closure of `n8n-nodes-base` plus the repository root;
4. builds that closure through turbo;
5. runs the unpatched execution-engine suite and stores its junit baseline.

`n8n-nodes-base` is the minimum useful build target. The core test helpers import several
real nodes and `known/nodes.json`; building only the `n8n-core` dependency chain leaves six
test files unloadable.

Options:

| Option | Effect |
|---|---|
| `--skip-install` | Reuse the existing installation. |
| `--skip-build` | Reuse existing build output. |
| `--skip-test` | Do not create a baseline. |
| `--full-install` | Install the whole n8n monorepo. |
| `--allow-dirty` | Permit tracked changes in `.n8n/`; the result is not a clean baseline. |
| `--scope=NAME` | Select `execution-engine`, `core`, `workflow`, `cli`, `engine`, `compat`, `cli-v2`, `engine-int` or `compat-int`. |

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `N8N_DIR` | `<repo>/.n8n` | Reference checkout path. |
| `N8N_RESULTS` | `<repo>/conformance-results` | Where baselines, junit files and matrices go (`release/neutrality.sh` gives each release its own directory). |
| `N8N_BOOTSTRAP_COMMIT`, `N8N_BOOTSTRAP_TAG` | the pin | Bootstrap only: a checkout already at another commit, so the checkout step checks that HEAD is it (`release/neutrality.sh`). |
| `N8N_TEST_FILTER` | Scope-specific | Override the vitest path filters (space-separated). |
| `COREPACK_VERSION` | `0.36.0` | Fallback corepack package when no binary is on `PATH`. |
| `COREPACK_HOME` | Corepack default | Corepack cache. |

Scopes and baselines:

| Scope | Package and filter | Baseline |
|---|---|---|
| `execution-engine` | `n8n-core`, `src/execution-engine` | `baseline.junit.xml` |
| `core` | all of `n8n-core` | `baseline-core.junit.xml` |
| `workflow` | all of `n8n-workflow` | `baseline-workflow.junit.xml` |
| `cli` | all of `n8n` | `baseline-cli.junit.xml` |
| `engine` | `@n8n/engine`, unit config | `baseline-engine.junit.xml` |
| `compat` | `@n8n/node-engine-compatibility`, unit config | `baseline-compat.junit.xml` |
| `cli-v2` | `n8n`, `src/modules/engine-v2` and `src/services/__tests__/engine-v2-dispatcher` | `baseline-cli-v2.junit.xml` |
| `engine-int` | `@n8n/engine`, integration config (`test:integration`) | `baseline-engine-int.junit.xml` |
| `compat-int` | `@n8n/node-engine-compatibility`, integration config | `baseline-compat-int.junit.xml` |

The CLI scope needs a wider install and build because its vitest setup resolves workspace
packages from built `dist` output.

`engine`, `compat` and `cli-v2` are the engine v2 scopes that need no Postgres. They run each
package's own `test` script, whose `vitest.config.ts` already excludes
`**/*.integration.test.ts`. That leaves out the engine's 6 integration files (5 start Postgres
through testcontainers, one needs none but shares the config) and compat's
`m1-acceptance.integration.test.ts` (16 cases, Postgres). `bootstrap-n8n.sh --help` lists them.
None of the three constructs a `WorkflowExecute`, so they have no v1 scheduler leg; their
`legacy` leg is a neutrality leg, and their `libpetri` leg is the settlement leg (below).

`engine-int` and `compat-int` run those integration files: the same packages'
`test:integration` script and `vitest.integration.config.ts`. They need Docker, because n8n's own
testcontainers code starts a Postgres per file; nothing in it is changed. They run with
`--maxWorkers=1`, so one file and one Postgres at a time, which keeps a small Docker VM within its
memory. That changes scheduling, not the case set. Every baseline and leg writes
`<label>.pg-stamp.txt` through `pg-stamp.sh`: the Docker server, each image the tests name with
its image id and `postgres -V`, and the containers Docker started during the run (streamed from
`docker events`). Both scripts refuse to start when `docker info` does not answer. Like `engine`
and `compat`, their `legacy` leg is a neutrality leg and their `libpetri` leg is the settlement leg.

**The settlement leg** (`tasks/v2-seam-plan.md` step 10). On the five engine v2 scopes,
`--engines=libpetri` registers the net-backed `SettlementPolicy` through patch 0004's
`setSettlementPolicy()`, from a generated setup shim (`.n8n-libpetri-v2-setup.mjs` and
`vitest.libpetri-v2.config.mts` in the package, both in `.n8n/.git/info/exclude`). The shim
imports the registry from the instance the scope's tests build their runtime from: the engine's
`src` for `engine` and `engine-int`, the `@n8n/engine` package (its `dist`) for `compat`,
`compat-int` and `cli-v2`. The hook is the tsup entry `n8n-v2-vitest-setup`
(`typescript/dist/n8n-v2-vitest-setup.js`, `SETTLEMENT_HOOK`). The leg runs the package script's
command line with its `--config` replaced, because vitest refuses a second `--config`. Besides
the junit and the matrix against the baseline it writes `<label>.ledger.jsonl` (per case, how
often the policy was entered) and `<label>.entered.md`, whose headline is policy-entering cases
passed; every case that never entered is labelled. `engine-int` and `compat-int` settle steps
through `createEngineRuntime`, so a leg there that enters in no case is F5 and fails the run.
`--settlement-mode=shadow|primary-shadowed` runs the shadow modes and labels the leg
`libpetri-<scope>-<mode>`.

Common reruns:

```bash
# Recreate only the execution-engine baseline
scripts/bootstrap-n8n.sh --skip-install --skip-build

# Prepare the CLI suite
scripts/bootstrap-n8n.sh --scope=cli --full-install
```

A warm full bootstrap takes roughly 90 seconds with a cold turbo cache. An unchanged rerun
takes about 20 seconds; a test-only rerun about 14 seconds on the recorded machine. Treat
these as operational estimates, not benchmarks.

## Drift check

```bash
scripts/check-n8n-drift.sh             # fetches tags and master first
scripts/check-n8n-drift.sh --no-fetch
```

Each ref is read into a throwaway index (`GIT_INDEX_FILE` in a temp dir) and the patches are
applied to it in order, so the checkout, `HEAD` and the working tree are never touched. It exits
1 when any ref does not apply. A re-pin starts here: move `scripts/n8n-pin.sh`, rebase the
patches as `patches/n8n/README.md` describes, then bootstrap and run the conformance legs.

## Patch verification

```bash
scripts/verify-patch.sh
scripts/verify-patch.sh --typecheck --build --lint
scripts/verify-patch.sh --restore
```

The script checks that `.n8n/` is exactly at the pinned commit, resets the patch scope
(`packages/core/src` and `packages/@n8n/engine/src`), removes untracked files inside that
scope, then applies `patches/n8n/*.patch` in lexical order. Files outside the patch scope are
left alone.

This reset is destructive to manual edits under `.n8n/packages/core/src` and
`.n8n/packages/@n8n/engine/src`. Keep patch work in commits or exported patch files before
running it.

Options:

| Option | Effect |
|---|---|
| `--typecheck` | Run `pnpm --filter <pkg> typecheck` for `n8n-core`, `@n8n/engine` and `@n8n/node-engine-compatibility`. |
| `--build` | Build the same three packages, in that order, after applying the patches. |
| `--lint` | Run `@n8n/engine`'s own `lint` (oxlint) and `format:check` (`biome ci src`). |
| `--restore` | Return the patch scope to the pristine commit after checking. |

By default the tree remains patched because the conformance runner needs it.

## Conformance

Build this package first so the n8n vitest setup can import the scheduler:

```bash
cd typescript
npm ci
npm run build
cd ..

scripts/run-conformance.sh --engines=legacy,libpetri
```

Options:

| Option | Effect |
|---|---|
| `--engines=legacy,libpetri` | Comma-separated scheduler selection. |
| `--budget=N` | Requested Petri concurrency budget. Default 1. |
| `--scope=NAME` | `execution-engine`, `core`, `workflow`, `cli`, `engine`, `compat`, `cli-v2`, `engine-int`, `compat-int` or `all`. |
| `--skip-patch` | Use the existing patched tree. |
| `--typecheck` | Typecheck and build the patch before running. |
| `--settlement-mode=M` | The settlement leg's mode: `primary` (default), `shadow` or `primary-shadowed`. |

`all` covers execution-engine, core and workflow. CLI is separate because its complete
build takes materially longer.

The legacy leg must match the unpatched baseline exactly. The k=1 Petri leg is compared to
that baseline and classified through the conformance matrix. A k>1 Petri leg is compared to
the k=1 Petri leg because n8n's suite asserts total order and would otherwise report expected
concurrent reordering as a regression.

```bash
# Default execution-engine matrix
scripts/run-conformance.sh --engines=legacy,libpetri

# Petri budget two
scripts/run-conformance.sh --engines=libpetri --budget=2

# Broader package scopes
scripts/run-conformance.sh --scope=all --engines=legacy,libpetri
scripts/run-conformance.sh --scope=cli --engines=legacy,libpetri
```

The runner records two distinct facts:

- `PetriScheduler registered` means the setup hook installed the factory.
- `engine entered` means a test actually constructed and ran the scheduler.

Workflow and CLI suites can register the engine without entering it. Those legs demonstrate
patch neutrality, not Petri scheduler behaviour.

## Artifacts

Important files under `conformance-results/`:

| File | Contents |
|---|---|
| `baseline*.junit.xml` | Unpatched suite baseline per scope. |
| `<label>.junit.xml` | One scheduler leg. |
| `<label>.matrix.md` | Case comparison and classification. |
| `<label>.test.log` | Full vitest output. |
| `<label>.diagnostics.txt` | Deduplicated scheduler diagnostics. |
| `<label>.budget.txt` | Workflows whose effective budget was lowered. |
| `bootstrap-env.txt` | Tool versions and pinned commit. |
| `bootstrap-timings.tsv` | Step timings and failure codes. |

Junit comparison ignores timing, host names, suite completion order and captured streams that
contain checkout-specific paths. It compares suite names, case names and outcomes.

## Failure notes

- Node 25 and newer may not ship corepack. The bootstrap uses
  `npx corepack@0.36.0` without installing it globally.
- `CI=true` is required. It enables n8n's junit reporter and prevents its prepare script from
  installing repository hooks.
- Turbo needs a `pnpm` executable on `PATH`. The bootstrap creates matching shims in
  `conformance-results/.corepack-bin/`.
- `git fetch` uses the full commit SHA. An abbreviated SHA is not resolved by the remote.
- A patched `.n8n/` checkout is dirty by design. Restore it before creating a new unpatched
  baseline, or use `--allow-dirty` only when that distinction is intentional.
