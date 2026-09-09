# The live testbed

Everything else in this repository measures the engine against `FakeHost` — a structural mirror
of patch 0001, good enough to run n8n's own execution-engine cases and to diff two schedulers
against each other, and deliberately not n8n. `docs/conformance-final.md` records the `cli`
scope as **registered, never entered**: the engine had never once been constructed by the
process n8n actually ships.

The testbed closes that gap. It boots the real `packages/cli`, with the real editor, the real
node types, the real task runner, real credentials and real persistence, and installs
`PetriScheduler` into it. Two workflows are seeded so there is something to press.

```bash
scripts/testbed/n8n-testbed.sh                 # libpetri, k = 4, http://127.0.0.1:5678
scripts/testbed/diff-engines.sh                # both engines, headless, compared
scripts/testbed/browser-check.sh               # drive the editor, screenshot the canvas
```

## What it is, and what it is not

It is an **integration and demonstration harness**. It is not a conformance measurement, and no
number here belongs in a headline: `scripts/run-conformance.sh` remains the authority on case
counts, and the reporting rule in `CLAUDE.md` applies to it, not to this. What the testbed adds
is a different kind of evidence — that the seam holds in the process that has n8n's own
dependency injection, module loading, credential decryption and task-runner IPC around it.

## How the engine gets in

n8n does not read `N8N_EXECUTION_ENGINE`; patch 0002 exposes `setWorkflowSchedulerFactory` and
nothing more, and an external process decides whether to call it. The conformance suite calls it
from a generated vitest `setupFiles` shim. A server has no such seam, so the testbed calls it
from an `--import` preload, `scripts/testbed/preload.mjs`:

```
node --import scripts/testbed/preload.mjs .n8n/packages/cli/bin/n8n start
```

Three details decide whether that works.

**`createRequire`, not `import`.** `packages/core` builds to CommonJS and `n8n-libpetri` is
ESM-only, so the preload resolves `n8n-core` and `n8n-workflow` through a `require` rooted at
`packages/cli/package.json`. Node resolves pnpm's symlinks to their realpath, so the registry
the preload writes to is the same CJS module instance `WorkflowExecute` later reads from.

**`--import`, not `NODE_OPTIONS`.** `bin/n8n` never re-execs, so a command-line preload covers
the process. `NODE_OPTIONS` would also load it into the internal task-runner child, which never
constructs a scheduler.

**No fallback.** If any of that fails the preload throws and n8n does not start. A testbed that
quietly runs n8n's stack loop while claiming to run the net would be worse than one that
refuses to boot. Both directions are checked:

```
$ N8N_EXECUTION_ENGINE=legacy   node --import scripts/testbed/preload.mjs -e "0"
                                                     # inert, exits clean
$ N8N_EXECUTION_ENGINE=libpetri node --import scripts/testbed/preload.mjs -e "0"
Error: N8N_LIBPETRI_RESOLVE_FROM is not set          # refuses rather than degrades
```

### Two claims, two lines

The log carries them separately, because they are not the same statement:

```
[n8n-libpetri] scheduler registered: budget=4, hook=…/typescript/dist/index.js
[n8n-libpetri] engine entered: n8n constructed a scheduler through the registered factory
```

Registration is true at boot. **Entry** is `ENGINE_ENTERED_DIAGNOSTIC`, emitted by the factory
itself the first time n8n constructs a scheduler through it, and only an execution can
establish it. `docs/conformance-final.md` keeps the same distinction for the same reason.

### `packages/core` must be rebuilt

The server loads `packages/core/dist`, not `src`. A `dist` older than the patch runs an older
seam — and since M7, patch 0001 adds `planEngineRequest`, which the agent round calls. The
launcher rebuilds when `dist` is older than the patched source and then asserts both
`getWorkflowSchedulerFactory` and `planEngineRequest` are in the built file. The rebuild is
shared state with `scripts/run-conformance.sh --scope=cli`, whose own guard greps the same
built file; rebuilding from the patched source can only make that leg more correct.

## The two workflows

Both set `settings.executionOrder: "v1"`. Without it `PetriScheduler` delegates straight to
n8n's `StackScheduler` (divergence #3) and the testbed would silently demonstrate the thing it
replaces.

### Concurrency Showcase — 13 nodes

```
Manual Trigger → Seed → Route (If)
  false → Skipped
  true  → Fan → Fetch A | Fetch B | Fetch C | Fetch D     (Code, each sleeps 1.2 s)
Fetch A, Fetch B → Merge AB        Fetch C, Fetch D → Merge CD
Merge AB, Merge CD → Merge All → Summarise
```

Acyclic, with one producer per input index — which is what the k-safety check needs to leave
the budget alone. A cyclic SCC or a multi-producer index lowers the effective budget to 1, so
`Skipped` is a terminal node of its own rather than a second producer into `Merge All`: wiring
it there would have deleted the concurrency without saying so.

Every payload is deterministic. The legs return `{ leg: 'A' }` and not a timestamp, and
`Summarise` reports `{ legs: 4, order: 'A,B,C,D' }` — `append` concatenates input 0 then input 1
whatever order the branches finished in. The wall clock is measured from outside, so nothing
time-dependent has to travel through the data channel that the legacy/libpetri comparison reads.

### Agent · Two Tools — 6 nodes

```
Manual Trigger → AI Agent (typeVersion 3.1, options.maxIterations 4) → Answer
Stub Chat Model  --ai_languageModel-->  AI Agent
Calculator       --ai_tool---------->   AI Agent
Fact_Lookup      --ai_tool---------->   AI Agent
```

`maxIterations` is the number the compiler seeds `A/rounds` from (ADR 0008 §2), which is what
makes the round cycle bounded. Two tools rather than one, because one exercises the round and
two exercise the **pending marker** — `A_dispatch` fires per call, `A/pending` counts them, and
`A_collect` closes the round when the last lands. Not the shared-tool shape: `agentSharedTool`
verifies as `violated` and it is a false alarm (`tasks/todo.md`).

The model is `scripts/testbed/stub-llm.mjs`, a local OpenAI-compatible server — no key, no
bill, no network, and a fixed script: the first call returns one `tool_calls` message naming
every tool the agent offered, the second returns a plain answer. Tool names and arguments are
read off the request's own `tools` array, so renaming a node cannot desynchronise the stub.

Two configuration details are load-bearing. n8n reaches the stub through the **credential's**
`url`, because `LmChatOpenAi` only validates `options.baseURL` and takes `credentials.url`
unguarded. And `responsesApiEnabled` defaults to **true** at typeVersion ≥ 1.3, so the workflow
turns it off explicitly; otherwise the node calls `POST /v1/responses` rather than chat
completions.

## What was measured

n8n 2.37.0 at the pin `441970b2`, Node 26.8.1, macOS, k as shown, best of two runs per leg,
2026-09-10. `diff-engines.sh` produced this.

| Workflow | leg | wall clock | data vs n8n | happens-before | order |
| --- | --- | --- | --- | --- | --- |
| Concurrency Showcase | legacy (reference) | 4944 ms | — | 14 edges ok | — |
| | libpetri k = 1 | 4944 ms | identical | 14 edges ok | same |
| | libpetri k = 4 | **1284 ms** | identical | 14 edges ok | **reordered** |
| Agent · Two Tools | legacy (reference) | 131 ms | — | 2 edges ok | — |
| | libpetri k = 1 | 129 ms | identical | 2 edges ok | same |
| | libpetri k = 4 | 130 ms | identical | 2 edges ok | same |

Four independent 1.2 s legs, so 5 s sequentially and 1.2 s four-wide: the net returns 1284 ms
against n8n's 4944 ms, and costs nothing measurable at k = 1 — 4944 ms, the same figure to the
millisecond. The reorder is the whole difference —

```
n8n            … Fan → Fetch A → Fetch B → Merge AB → Fetch C → Fetch D → Merge CD → …
libpetri k = 4 … Fan → Fetch A → Fetch B → Fetch C  → Fetch D → Merge AB → Merge CD → …
```

n8n enqueues `Merge AB` as soon as its two inputs have arrived and runs it before it starts
`Fetch C`; the net starts all four legs, because nothing orders them. Every node still runs
exactly once with the same payload, and every realised dependency edge is still respected.

### How each column is decided

The three are kept apart on purpose, because the claim is that **the data is identical and the
order is not** — folding them into one verdict would report the feature as a failure.

- **Data** compares each node's `ITaskData` field by field, minus `startTime`, `executionTime`
  and `executionIndex`. That field list mirrors `comparableTask` in `src/conformance/differ.ts`,
  which leaves the same three out for the same reason: they are clocks and positions, not data.
- **Happens-before** takes `dependencyEdges` from the same module — the *realised* dependency
  graph, read off the `source` n8n stamps on every task — and checks each edge inside each leg.
  The observation is n8n's own per-task clock, since a live server produces no `runNode` trace;
  an edge holds when the producer's `startTime + executionTime` is at or before the consumer's
  `startTime`. Independent activations are free to be unordered: that is the concurrency.
- **Order** is `executionOrder` over n8n's own `executionIndex`. Reported, never asserted.

## Caveats

- **Divergence #17 is not reachable here.** Neither workflow uses a `responseMode: responseNode`
  webhook, which is the one k > 1 behaviour change with a user-visible shape. A green table here
  is not a general licence to raise `k`.
- **At k > 1 the agent's tools run concurrently** where n8n runs them one at a time (divergence
  #23). That is why the agent leg is run at k = 1 and k = 4 both. The stub sorts the tool
  results it echoes so that collection order cannot leak into the data channel — otherwise an
  ordering difference would be reported as a data difference.
- **The captures are the figure's only source.** `docs/img/gen-fanout.py` reads
  `.testbed/runs/concurrency-showcase.{legacy,libpetri-k4}.json` and draws the README's animated
  timeline from them — bars, totals, ratio and captions alike — so re-measuring and regenerating
  belong in one step. `.testbed/` is gitignored, so that script is where those numbers enter the
  repository.
- **The browser timings are demonstration figures.** `browser-check.sh` brackets the round trip
  as well as the execution. `diff-engines.sh` is where the wall clock is measured.
- **State is disposable.** Everything lives in `.testbed/` (gitignored): the sqlite database, the
  logs, the captures, the screenshots. `--fresh` wipes it. The encryption key is a fixed
  testbed constant, and the stub credential holds a fake key pointing at localhost.
