# Scripts

These scripts manage the ignored `.n8n/` reference checkout and write evidence to the
ignored `conformance-results/` directory.

| Script | Purpose |
|---|---|
| `bootstrap-n8n.sh` | Fetch, install, build and test the pinned unpatched n8n commit. |
| `verify-patch.sh` | Reset the patch scope, apply both integration patches and optionally build it. |
| `run-conformance.sh` | Run selected n8n suites under the legacy or Petri scheduler and compare junit results. |

All scripts use `set -euo pipefail`, validate their postconditions and fail if expected junit
or build artifacts are missing.

## Bootstrap

```bash
scripts/bootstrap-n8n.sh
```

The default run:

1. creates a shallow checkout at
   `441970b211d13a3ce547916b2b8ee93677b620e9` in `.n8n/`;
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
| `--scope=NAME` | Select `execution-engine`, `core`, `workflow` or `cli`. |

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `N8N_DIR` | `<repo>/.n8n` | Reference checkout path. |
| `N8N_TEST_FILTER` | Scope-specific | Override the vitest path filter. |
| `COREPACK_VERSION` | `0.36.0` | Fallback corepack package when no binary is on `PATH`. |
| `COREPACK_HOME` | Corepack default | Corepack cache. |

Scopes and baselines:

| Scope | Package and filter | Baseline |
|---|---|---|
| `execution-engine` | `n8n-core`, `src/execution-engine` | `baseline.junit.xml` |
| `core` | all of `n8n-core` | `baseline-core.junit.xml` |
| `workflow` | all of `n8n-workflow` | `baseline-workflow.junit.xml` |
| `cli` | all of `n8n` | `baseline-cli.junit.xml` |

The CLI scope needs a wider install and build because its vitest setup resolves workspace
packages from built `dist` output.

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

## Patch verification

```bash
scripts/verify-patch.sh
scripts/verify-patch.sh --typecheck --build
scripts/verify-patch.sh --restore
```

The script checks that `.n8n/` is exactly at the pinned commit, resets
`packages/core/src`, removes untracked files inside that scope, then applies
`patches/n8n/*.patch` in lexical order. Files outside the patch scope are left alone.

This reset is destructive to manual edits under `.n8n/packages/core/src`. Keep patch work in
commits or exported patch files before running it.

Options:

| Option | Effect |
|---|---|
| `--typecheck` | Run `pnpm --filter n8n-core typecheck`. |
| `--build` | Build `n8n-core` after applying the patches. |
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
| `--scope=NAME` | `execution-engine`, `core`, `workflow`, `cli` or `all`. |
| `--skip-patch` | Use the existing patched tree. |
| `--typecheck` | Typecheck and build the patch before running. |

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
