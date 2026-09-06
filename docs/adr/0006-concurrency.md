# ADR 0006 — Payload safety and the k > 1 semantics

Status: accepted (2026-09-06). Milestone M3. Complements
[ADR 0004](0004-two-phase-budget.md), which introduced `_budget`; this one is about what
running two node activations at the same time actually changes.

## Context

`_budget` holds *k* unit tokens. At k = 1 the engine is n8n-sequential and M2 proved it case
for case ([`docs/conformance-m2.md`](../conformance-m2.md)). Above 1 the net fires every
enabled `X_start` a budget unit is free for, so several node actions are in flight at once —
the reason the project exists (two independent 500 ms HTTP calls in ~500 ms, not ~1 s).

The gate for k > 1 is **data equivalence**: `runData` minus the clocks and `executionIndex`
must be exactly what k = 1 produced. Order may differ (divergences #5 / #12); data may not.
Three things could break that, and this ADR settles all three.

1. **Payload aliasing.** A token holds the very `INodeExecutionData[]` array n8n produced,
   and `X_route` hands the *same* `EdgePayload` to every edge of an output
   (`scheduler/actions.ts`, `routeOutput`). Two consumers of one output therefore hold the
   same array and the same item objects. If either of them writes through that reference
   while the other is running, k > 1 is a data race.
2. **Execution-global fields.** `IRunExecutionData` and `IWorkflowExecuteAdditionalData` carry
   fields n8n scopes by "one node runs at a time": `waitTill`, `lastNodeExecuted`,
   `currentNodeExecutionIndex`, `currentNodeUsedDynamicCredentials`.
3. **Arrival order.** A node that is activated more than once takes its payload → `runIndex`
   pairing from the order its inputs arrive, which above k = 1 is completion order.

## Decision

### 1. Payload safety: n8n's own lineage step is the isolation boundary; add nothing

The analysis, read off n8n `441970b`:

| write | where | what it touches |
|---|---|---|
| `addPairedItemLineage` | `workflow-execute.ts:1742-1782`, called at `stack-scheduler.ts:65` | **nothing shared** — it `map`s to a new array of `{ ...item, pairedItem }` shallow copies and the loop assigns the result to `executionData.data` |
| `assignPairedItems` | `:2585-2641`, called at `stack-scheduler.ts:193` | `item.pairedItem` **in place**, on `nodeSuccessData` — the node's own fresh output |
| `normalizeNodeErrors` | `:2132-2147` | `lineResult.json` / `.error` in place, on the same fresh output |
| `handleNodeErrorOutput` | `:2466-2560` | `items.shift()` — destructively empties `nodeSuccessData[o]`, again the node's own output |
| `ensureAlwaysOutputData` | `:1967-1988` | `nodeSuccessData[0]`, one slot of a fresh array |

So the only in-place `pairedItem` write left in n8n is `assignPairedItems`, and it only ever
reaches items the *running node itself* just produced. The three ways a node's "own output"
could be an object another activation holds are `getPinnedOutput` (`[pinData[node.name]]`,
`:1820-1827`), the continue-on-error pass-through (`[executionData.data.main[0]]`, `:2079`)
and a node returning its input array by reference — and all three are per-node objects: the
first is that node's pin data, the other two are that activation's own lineage copies. The
k-safety condition (below) forbids two activations of one node, so no two concurrently
running activations can reach the same item object with a write.

**What is genuinely shared between two concurrent activations** is the producer's
`INodeExecutionData[]` array and, because the lineage copy is shallow, each item's `json` and
`binary` objects. n8n shares exactly the same objects across connections
(`addNodeToBeExecuted` writes `nodeSuccessData[outputIndex]` by reference into every waiting
slot and stack entry, `:534-537` and `:786-800`), so our aliasing profile is n8n's; a node
that mutates its input `json` in place already corrupts its sibling in n8n, sequentially and
deterministically. Concurrency makes that nondeterministic, which is why the payload rule is
stated in the README: **a node's input items are read-only**.

The alternatives, and why they lose:

- **(a) copy at the lineage step** — already implemented upstream. Adopting it means
  *depending* on it, which this ADR does explicitly and
  `typescript/tests/scheduler/payload.test.ts` pins: the same workflow run against a host
  whose lineage step stamps in place races at k = 2 and does not at k = 1.
- **(b) a dedicated token so the net serialises the lineage step** — a place and an arc per
  node, provable with `placeBound`. It protects nothing. `addPairedItemLineage` and
  `assignPairedItems` are both *synchronous*, so in a single-threaded event loop they are
  already atomic; the hazard was never "two lineage steps interleaving", it is "one
  activation writes an object another activation reads later, across an await". A mutex on
  the write does not help — not sharing the written object does. It would also cost two
  transitions' worth of firing per node and would serialise a step that is 19 ns per item.
- **(c) copy the payload at the fan-out** — a deep copy of `json` per edge would additionally
  make a mutating node harmless, at a cost proportional to payload size × fan-out on every
  edge, for a class of bug n8n has anyway. Rejected; the rule is documented instead.

**Cost of (a), measured** (fan-out of 8 consumers, one shallow copy per item per activation,
Node 24 on an idle machine):

| items per activation | lineage copy |
|---|---|
| 1 | 0.0003 ms |
| 100 | 0.0015 ms |
| 1 000 | 0.022 ms |
| 10 000 | 0.19 ms |

Whole-run wall clock for the same fan-out (1 producer → 8 consumers, 9 lineage steps):
10 000 items with no node work, 8.1 ms at k = 1 and 6.8 ms at k = 8 — of which ~1.7 ms is
copying. With 25 ms of node work per consumer: **236 ms at k = 1, 37 ms at k = 8** (6.4×).
The copy is not the thing to optimise; it is what makes the 6.4× safe.

### 2. Execution-global fields

- **`waitTill` (divergence #15).** The claim is made in the same synchronous turn in which
  the node's own `runNode` resolves (`probeWait` / `observeWait` in `scheduler/actions.ts`),
  so claim order is the order the runs finished, not the order the recording paths happen to
  reach the test. A node that *started* after the field was already set never claims
  (`waitTill === before`). A refused claim is reported by diagnostic, and the
  `executionStatus: 'waiting'` that `host.createTaskData` stamped on it — it reads the same
  global field, `:1996` — is corrected to the status the run actually had. What is left is
  genuinely undecidable from outside the node: a node that sets the field and then keeps
  working while a sibling finishes loses the claim to that sibling. Closing that needs a
  write barrier on the field plus `AsyncLocalStorage` around `runNode`; it is registered, not
  built.
- **`lastNodeExecuted`** becomes the last node to *complete* rather than the last to run.
  That is the definition of the field under concurrency, not a corruption; divergence #16.
- **`currentNodeExecutionIndex`** is taken at `createTaskStartedData`, i.e. at start, so
  `executionIndex` is start order. Concurrency moves start order; divergences #5 / #12
  already cover it, and `dataOf` excludes it from the equivalence check.
- **`currentNodeUsedDynamicCredentials` / `…Attempted…`** are reset per node
  (`resetDynamicCredentialsUsage`, `:1717-1726`), written by n8n's credential layer *inside*
  `runNode`, and read back in `createTaskData`. Above k = 1 a sibling's reset can land between
  another node's credential resolution and its own read, so the flags can be lost or
  attributed to the wrong node. Nothing outside `WorkflowExecute` can scope them — the write
  is not ours and the window spans an await we do not own. Registered as divergence #18: do
  not raise k for workflows that use dynamically-resolved credentials.
- **`executionError` (divergence #19).** Not an `IRunExecutionData` field at all: it is one of
  the two `WorkflowScheduler` contract values `processRunExecutionData` reads *after* `run()`
  resolves, and `this.status = 'success'` versus `resultData.error` hangs on it
  (`workflow-execute.ts:2250-2255`). n8n keeps it in a single field (`stack-scheduler.ts:29`)
  cleared at the top of every iteration (`:56`) and every retry (`:107`), which is safe only
  because one node is in flight and the loop `break`s on the halting one. Above k = 1 both
  clears belong to *another* activation, and mirroring them made the value last-writer-wins in
  both directions: a sibling that failed and retried 20 ms after a fatal halt erased the halt
  error (so a halted execution would have been persisted as `finished: true`, `status:
  'success'`), and a sibling that cleared the field before another node wrote a continued
  error left that error standing on a fully successful run. The scheduler keeps **two** values
  instead: `haltError`, written once by the activation whose failure ended the execution and
  never overwritten, and `leftoverError`, what n8n's per-iteration field still held when an
  activation *completed*, overwritten by every completion. The contract value is
  `haltError ?? leftoverError`. Every write happens at the end of one mirrored loop iteration
  — n8n's clear-at-start is deliberately *not* mirrored — so at k = 1 completion order is
  iteration order and the value is byte-identical, including the order-dependent corner where
  a continued error survives because its node was the last thing the loop ran. Above k = 1 the
  leftover follows completion order, exactly as `lastNodeExecuted` does.
- **`closeFunction`**, the other contract value, is written by `processNodeOutput` per node and
  is last-writer-wins by construction in n8n too ("the close function of the last node that
  registered one"); above k = 1 "last" is completion order. No fix; the differ compares whether
  one is present.

### 3. The halt snapshot, and the k-safety condition

**The halt snapshot** (`state.haltMarking`) is taken when the halting action writes its
branch, but `_halt` only reaches the marking when that action *resolves*, so the snapshot is
a lower bound on what `_halt_reap` destroys. The window is small by construction: `_halt_reap`
has priority `maxDepth + 2`, the highest in the net, and its reset arcs empty every
start-input place in the same firing in which it consumes `_halt` (resets are applied at
firing time, `PrecompiledNetExecutor.fireTransition`), so once `_halt` is harvested no further
activation can start. Only the ≤ 2 microtask hops between the snapshot and the halting
action's own completion being enqueued are open, and an `X_start` in that window additionally
needs another node's route to refund a budget unit in an executor cycle that runs inside it.
We could not construct a schedule that does it. The guard is added anyway because it is
almost free: `X_start` increments a per-node counter, the snapshot records those counters, and
`haltPending` drops as many of the snapshot's oldest tokens per start-input place as that node
started since (FIFO, so those are exactly the ones a start took). The invariant it protects —
*a node that ran is never also written back as a pending entry* — is pinned at k = 1, 2 and 4.

**The k-safety condition** stays as it is: `kSafety` forces k = 1 for a cyclic workflow or an
input index with more than one producer. Its stated reason was wrong, though, and this ADR
corrects it. It is **not** that two activations of one node could be in flight at once —
`X/idle` makes that structurally impossible for every workflow at every k
(`X/idle + X/running = 1` is a found P-invariant, ADR 0004, `spikes/budget.test.ts`). It is
that a node with several activations takes its payload → `runIndex` pairing from **arrival
order**, and above k = 1 arrival order is the producers' completion order rather than a
structural fact. The counterexample is pinned in
`typescript/tests/scheduler/concurrency.test.ts`: in the `multi-producer` fixture `C.0` has
two producers, `A` (30 ms) and `B` (instant), and at the forced k = 1 `runData.C[0]` carries
`A`'s payload and `C[1]` carries `B`'s; wire the same two producers to one consumer each so
the workflow is k-safe, and at k = 4 `B` completes first — so an OR round allowed to run at
k > 1 would take its first delivery from `B` and swap the two.

**Can it be relaxed?** A sound relaxation exists in principle but is not implemented here.
The property that matters per input index is *order-determined*: the sequence of deliveries on
it is the same in every schedule. One producer gives it for free. The interesting case is the
canonical Loop Over Items — `Loop.0` has one **tree** producer (`Trigger`) and one **cycle**
producer (`Body`), and the cycle self-serialises through `Loop/idle`, so the deliveries are
totally ordered by structure (trigger first, then one per completed iteration). Making that a
check requires, at minimum: exactly one tree producer, which must itself be single-firing;
exactly one cycle producer; and the SCC must be a simple cycle entered at one node, so that no
iteration can deliver twice. Two cycle producers, two tree producers, or a multi-firing tree
producer all reintroduce schedule-dependent order. That analysis belongs in
`src/compiler/graph.ts` next to the SCC decomposition and changes `effectiveBudget` for
cyclic fixtures, i.e. it is a compiler-model change with its own pinned tests, not a
scheduler fix — so it is specified here and deferred. Note also that it buys concurrency only
*between* the loop and parallel branches: the loop itself stays sequential either way.

## Consequences

- k > 1 is safe for every workflow the compiler leaves above 1, with the payload rule
  ("input items are read-only") and the two registered exceptions above: a Wait node racing a
  sibling that finishes first (#15) and dynamically-resolved credentials (#18).
- `PetriScheduler.maxInFlight` exposes the high-water mark of concurrent runs (`X_run`
  actions), which the suite asserts `<= k` against. It is a *lower bound* on
  `_budget + Σ(running + ok + retry) = k`, not a reading of it: a retry wait and the
  `X_exhausted` recording each hold their budget unit without running the node.
- Retries hold their budget unit across the wait (ADR 0004). At k > 1 that costs one slot for
  the duration, not the whole net: `concurrency.test.ts` pins that two siblings complete while
  a `retryOnFail` node is between tries at k = 2, and that at k = 1 they only run after its
  last try. A workflow that is mostly retrying nodes wants a k above its retry count.
- The `X/idle` mutex, not the budget, is what serialises one node's own activations; k > 1
  never overlaps a node with itself.

## Evidence

- `typescript/tests/scheduler/payload.test.ts` — with n8n's copy-on-write lineage step k = 2
  is byte-identical to k = 1; with an in-place lineage step the two branches race and `A`
  reads back `M`'s stamp; every activation gets its own item objects while the payload array
  and each `json` stay shared; `assignPairedItems` stamps only the node's own output.
- `typescript/tests/scheduler/concurrency.test.ts` — three 60 ms branches in one round at
  k = 3 and three rounds at k = 1; in-flight ≤ k for k ∈ {1, 2, 3, 4, 8}; `dataOf` equality at
  k ∈ {2, 4, 8} against k = 1 for a fan-out, a join and a two-chain fixture where the
  completion order really does flip; cancellation and halt with several nodes in flight; no
  node both recorded and pending after a halt at k ∈ {1, 2, 4}; the `waitTill` claim and its
  residual; the retry-budget cost; the k-safety counterexample.
- `typescript/tests/scheduler/execution-error.test.ts` — the halt error survives a sibling that
  fails and retries after it, at k ∈ {1, 2, 4}; a continued error is cleared by the next
  completion at every k; and a continued error on the *last* completion still stands, which is
  n8n's own k = 1 value.
- `typescript/tests/spikes/budget.test.ts` — the `X/idle` mutex and the k = 1 vs k = 2 timings
  this ADR rests on (ADR 0004's evidence, unchanged).
- Upstream finding: `PrecompiledNetExecutor.getMarking()` caches `this.marking` on its first
  call and never invalidates it, so a *second* mid-run snapshot silently returns the first
  one's marking. The scheduler takes exactly one (`haltMarking ??=`), so it is correct today —
  but only by accident, which is why that guard must stay.
