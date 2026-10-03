# Testbed

A running n8n — editor, node types, task runner, credentials, persistence — with
`PetriScheduler` installed in place of its execution loop. What it demonstrates, how the engine
gets in, and what was measured is in [`docs/testbed.md`](../../docs/testbed.md).

| File | Purpose |
|---|---|
| `n8n-testbed.sh` | Rebuild the patched `n8n-core` if stale, boot n8n with the preload, seed the workflows, print the URL. With `--v2`, engine v2 with the settlement policy (below). |
| `preload.mjs` | The `--import` preload. It calls `registerPetriScheduler` when `N8N_EXECUTION_ENGINE=libpetri`, and `registerSettlementPolicy` on `@n8n/engine` when `N8N_LIBPETRI_SETTLEMENT` is set. With `N8N_LIBPETRI_SETTLEMENT_TIMING=1` (`--timing`) it also installs the settlement timing instrument. Otherwise inert. |
| `pg.sh` | The Docker Postgres for engine v2's data plane: `start`, `stop`, `url`, `status`, `stamp`. `LIBPETRI_PG_URL` replaces it. |
| `stub-llm.mjs` | A deterministic OpenAI-compatible chat model on localhost, so the agent round runs with no key and no network. |
| `seed.mjs` | Instance owner, stub credential and both workflows, over REST. Writes `.testbed/ids.json`. |
| `run.mjs` | One manual execution through `POST /rest/workflows/:id/run` — the editor's own path — captured to a file. |
| `diff-engines.sh` | Every workflow under legacy and libpetri, one server per engine, compared on data, happens-before and order. |
| `diff-engines-v2.sh` | Engine v2 under `--settlement=off`, `primary`, `shadow` and `primary-shadowed`, one fresh server and Postgres per leg, all with `--timing`; compared by `tests/testbed/compare-v2.ts`. |
| `dump-v2.mjs` | Reads executions and their step rows from engine v2's data plane over SQL, with the engine's own `pg`. |
| `browser-check.sh` | Drives the editor with `agent-browser`: sign in, execute, wait for the success toast, screenshot. |
| `workflows/`, `credentials/` | The seeded n8n exports. `workflows-v2/` holds the three seeded only with `--v2`; it is apart so that `v1-identity` does not fingerprint them. |

`tests/testbed/compare-run.ts` (under `typescript/`, so `npm run check` typechecks it) is the
comparator `diff-engines.sh` calls. It reuses `firstDifference`, `dependencyEdges`,
`activationKey` and `executionOrder` from `src/conformance/differ.ts` rather than restating them.
`tests/testbed/compare-v2.ts` is `diff-engines-v2.sh`'s comparator; its pure parts are pinned by
`tests/testbed/compare-v2.test.ts`.

## Usage

```bash
scripts/testbed/n8n-testbed.sh                   # libpetri, k = 4, port 5678, stays in the foreground
scripts/testbed/n8n-testbed.sh --budget=1        # the same workflows, sequentially
scripts/testbed/n8n-testbed.sh --engine=legacy   # n8n's own stack loop, for comparison
scripts/testbed/n8n-testbed.sh --fresh           # wipe .testbed/ first
scripts/testbed/n8n-testbed.sh --daemon          # boot and return
scripts/testbed/n8n-testbed.sh --stop            # stop a --daemon instance

scripts/testbed/diff-engines.sh --repeat=2 --budgets=1,4
scripts/testbed/browser-check.sh --attach        # against a server that is already running

scripts/testbed/n8n-testbed.sh --v2 --settlement=primary --daemon   # engine v2, the net-backed policy answers
scripts/testbed/n8n-testbed.sh --v2 --settlement=shadow --daemon    # n8n answers, ours is compared
scripts/testbed/n8n-testbed.sh --v2 --settlement=off --daemon       # patched, nothing registered
TESTBED_DIR=.testbed/v2 node scripts/testbed/run.mjs "V2 If Switch Diamond" .testbed/v2/runs/diamond.json
grep 'settlement policy entered' .testbed/v2/n8n.log

scripts/testbed/diff-engines-v2.sh                              # four legs; report in .testbed/v2-diff/report.md
scripts/testbed/diff-engines-v2.sh --legs=off,primary --repeat=2 --loop-repeat=3
```

`--v2` needs Docker (or `LIBPETRI_PG_URL`). It cannot be combined with `--queue`, because the
engine-v2 module refuses queue mode. `--engine` defaults to `legacy` under `--v2`, since engine v2
runs v1 nodes without `WorkflowExecute`. See `docs/testbed.md`, "Engine v2".

Sign in with the credentials `n8n-testbed.sh` prints; they are also in `.testbed/ids.json`.

## Preconditions

- `.n8n/` bootstrapped and patched (`scripts/bootstrap-n8n.sh`, `scripts/verify-patch.sh`).
  The launcher rebuilds `packages/core` itself when its `dist` is older than the patched source,
  and refuses to start if the built file lacks `getWorkflowSchedulerFactory` or
  `planEngineRequest`.
- `typescript/dist` built. The launcher runs `npm run build` if it is missing.
- `agent-browser` on `PATH`, for `browser-check.sh` only.

No pnpm needed: the `packages/core` rebuild goes through `.n8n/node_modules/.bin/tsc` and
`tsc-alias` directly.

## State

Everything runtime lives in `.testbed/` (gitignored) — `home/` (the sqlite database), `n8n.log`,
`stub-llm.log`, `ids.json`, `runs/`, `shots/`. The `--v2` testbed has the same layout under
`.testbed/v2/`, plus `settlement.jsonl` (every policy diagnostic and shadow report) and
`pg-stamp.txt` (the Postgres image id and server version). `diff-engines-v2.sh` writes each leg
to `.testbed/v2-diff/<leg>/` and the report to `.testbed/v2-diff/report.md`. The `--v2` testbed's
Postgres outlives a foreground run and is removed by `--stop`, or by the next `--fresh`. Nothing is written under
`.n8n/packages/core/src` or `.n8n/packages/@n8n/engine/src`, which `verify-patch.sh` resets. The
engine rebuild leaves one marker file, `packages/@n8n/engine/dist/.n8n-libpetri-built`, in the
gitignored `dist`.
