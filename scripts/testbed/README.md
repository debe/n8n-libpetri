# Testbed

A running n8n — editor, node types, task runner, credentials, persistence — with
`PetriScheduler` installed in place of its execution loop. What it demonstrates, how the engine
gets in, and what was measured is in [`docs/testbed.md`](../../docs/testbed.md).

| File | Purpose |
|---|---|
| `n8n-testbed.sh` | Rebuild the patched `n8n-core` if stale, boot n8n with the preload, seed the workflows, print the URL. |
| `preload.mjs` | The `--import` preload that calls `registerPetriScheduler` in the live process. Inert unless `N8N_EXECUTION_ENGINE=libpetri`. |
| `stub-llm.mjs` | A deterministic OpenAI-compatible chat model on localhost, so the agent round runs with no key and no network. |
| `seed.mjs` | Instance owner, stub credential and both workflows, over REST. Writes `.testbed/ids.json`. |
| `run.mjs` | One manual execution through `POST /rest/workflows/:id/run` — the editor's own path — captured to a file. |
| `diff-engines.sh` | Every workflow under legacy and libpetri, one server per engine, compared on data, happens-before and order. |
| `browser-check.sh` | Drives the editor with `agent-browser`: sign in, execute, wait for the success toast, screenshot. |
| `workflows/`, `credentials/` | The seeded n8n exports. |

`tests/testbed/compare-run.ts` (under `typescript/`, so `npm run check` typechecks it) is the
comparator `diff-engines.sh` calls. It reuses `firstDifference`, `dependencyEdges`,
`activationKey` and `executionOrder` from `src/conformance/differ.ts` rather than restating them.

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
```

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
`stub-llm.log`, `ids.json`, `runs/`, `shots/`. Nothing is written under
`.n8n/packages/core/src`, which `verify-patch.sh` deletes.
