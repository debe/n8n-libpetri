# n8n-libpetri

**n8n-libpetri replaces n8n's intra-workflow scheduler with a Coloured Time Petri Net
engine built on [libpetri](https://github.com/debe/libpetri).** n8n keeps its editor,
workflow JSON, credentials, node ecosystem, persistence, webhooks, hooks and queue mode.
Only the ~490-line `executionLoop` inside `WorkflowExecute.processRunExecutionData()` is
replaced: the loop that pops `nodeExecutionStack`, calls `runNode()`, and hand-manages
`waitingExecution` for multi-input joins. There is no n8n source fork; n8n is cloned at a
pinned commit into a gitignored `.n8n/` and carries two rebasable patches.

This README is the single source of architectural truth. Read it before structural changes.

## Why

1. **Real concurrency.** n8n completes one branch before starting the next. Two independent
   500 ms HTTP calls take ~1 s. Under a net both transitions are enabled at once.
2. **Analysability.** Once a workflow *is* a net, libpetri's `SmtVerifier` (Z3/Spacer
   IC3-PDR) proves proper completion, bounds, exclusion and unreachability before activation,
   and hands back counterexamples that are literal node paths through the same semantics
   production runs.

## Principles

1. **No null output spec, no `skipOutputValidation`.** Every transition declares a real
   `Out` spec the executor validates and the verifier reads. One net serves execution and
   verification. The only null-spec transitions are genuine sinks (libpetri CORE-043 AC4).
2. **The net decides what runs.** Enablement, priority, inhibitors, read arcs, timed
   transitions and ν-minting determine firing. No host-side dispatch queue, permit gating or
   scheduler policy object. Retries, mutexes, concurrency limits and halts are places and arcs.
3. **n8n's legacy behaviour is a candidate for abandonment, not a requirement.** Where n8n
   encodes an artifact we model the correct semantics and record the divergence in
   [`docs/divergences.md`](docs/divergences.md).

The philosophy in one line: the net expresses flow, which can be proven; enablement
describes; it is resource-consumption based; you run when you have everything.

## The model — one net per execution

### Emission rule

An **empty token** asserts "this edge carries nothing for this activation of the producer".
The assertion is only meaningful when the producer cannot be re-activated by its own output,
so after an SCC decomposition of the main-connection graph:

| Edge | Producer fires with data (`X_run`) | Producer skipped (`X_skip`) |
|---|---|---|
| tree edge, producer not in a cycle | `data \| empty` | `empty` |
| tree edge, producer in a cycle | `data \| nil` | `empty` |
| cycle edge (both ends in one SCC) | `data \| nil` | nothing |

`nil` is a per-output local place consumed by a genuine sink transition. This one rule covers
IF/Switch/Filter (routing items, empty is a fact), Loop Over Items (`done` is "not yet" on
intermediate firings), arbitrary user cycles (no empty storms) and skipping a whole loop
(empty flows past it on the exit edge). It is what makes an AND-join always complete in the
acyclic case, which removes the cause of n8n's stuck-join fallback rather than the symptom.

### Per-node gadget

Each n8n node compiles to a libpetri `SubnetDef` instantiated at prefix `node.id`. The
node's outcome is routed through `X/ok`, so `X_run` has the same small spec for every node
and the per-output routing lives on an instantaneous `X_route` (ADR 0004):

```
X_start:      one(X/in) one(_budget) one(X/idle) inhibitor(_halt) inhibitor(_halted)
              [read(Y/done) per $('Y')]                              → X/running     priority depth
X_run:        one(X/running) → and( xor( X/ok, [X/retry], [and(_halt, _budget)] ), X/idle )
              action: host.runNode(...)                                               priority depth + 1
X_route:      one(X/ok) → and( per connected output o: xor( and(data edges_o), and(empty edges_o) | X/nil_o ),
                               _budget, X/done )                                      priority depth + 1
X_skip:       one(X/in_empty) → and( empty tree edges, X/skipped )                    priority depth
X_retry_wait: one(X/retry) one(X/tries) one(X/idle) inhibitor(_halt) inhibitor(_halted)
              delayed(waitBetweenTries) → X/running                                   priority depth
X_exhausted:  one(X/retry) inhibitor(X/tries) → xor( X/ok, [and(_halt, _budget)] )    priority depth + 1
sink_o:       one(X/nil_o)   (no Out spec: a genuine sink, CORE-043 AC4)
```

- The two-phase start/run is textbook duration modelling. It makes
  `_budget + Σ(running + ok + retry) = k` a real P-semiflow and
  `mutualExclusion(A/running, B/running)` provable, with an explicit `X/idle` mutex
  (`X/idle + X/running = 1` is found as a P-invariant) instead of reliance on an executor
  implementation detail.
- The budget is acquired by `X_start`, refunded by `X_route` in the same completion that
  deposits the edge tokens (that is what lets a successor and a budget-blocked sibling
  re-enable in one cycle, so priority alone gives depth-first), or by the halt branch. It is
  **held across a retry wait**, as n8n's own retry loop blocks the run. The action never
  throws (libpetri EXEC-030: a rejected action loses its consumed tokens).
- Why the routed shape and not one nested spec: libpetri's validators (TypeScript and Java
  alike) reject an inner `xor` with no satisfied child before the enclosing `xor` can select
  a sibling branch, and the outcome depends on child order inside `and`. That is reported
  upstream as an IO-015 question; the routed shape does not depend on it.
- **Verifier scaling.** The flatteners expand `and` of `k` `xor`s into `2^k` virtual
  transitions (IO-016), so a node with more than three connected outputs is routed per
  output instead: `X_run`'s success branch produces `X/ok_o` for every output, each
  `X_route_o` routes one output and marks `X/routed_o`, and `X_done` consumes all `routed_o`
  to refund `_budget` and mark `X/done`. Execution and verification stay linear in `k`.
- Priority = DAG depth gives n8n's documented v1 depth-first completion at k = 1;
  declaration order = canvas order (y, then x, ascending) gives sibling order. One exception,
  measured: an OR-input node's `arm` transition costs a scheduling cycle, so a shallower
  sibling takes the budget unit in it and that node runs breadth-first (divergence #20).
- `X/done` and `X/skipped` are markers. Read arcs on `Y/done` make `$('Y')` expression
  dependencies explicit; an unmet one is a stranded token the verifier catches statically.
- `IRunExecutionData` is written exactly as n8n writes it, so `WorkflowDataProxy`, `$node`,
  `$json` and `pairedItem` keep working untouched.

### Join gadget (k ≥ 2 inputs, or an input with several producers)

```
per input i:  X/free_i (1 token)
per edge e into input i:
  arm_e_data:  one(e/data)  one(X/free_i) → and(outPlace(X/ready_i), outPlace(X/hasdata))
  arm_e_empty: one(e/empty) one(X/free_i) → outPlace(X/ready_i)
X_start: one(X/ready_0)…one(X/ready_k-1) all(X/hasdata) one(_budget) one(X/idle) inhibitor(_halt)
         → and(outPlace(X/running), outPlace(X/free_*))
X_skip:  one(X/ready_0)…one(X/ready_k-1) inhibitor(X/hasdata) → and(empty edges…, outPlace(X/free_*))
```

`all()` requires at least one token, so "at least one non-empty input" is structural and
start/skip are mutually exclusive without priority. `free_i` serialises slots so a second
arrival waits until the current slot is consumed, matching n8n's first-free-slot allocator.
Merge chooseBranch (`requiredInputs` naming every input) enumerates its data/empty
combinations. A `requiredInputs` array shorter than the input count (Merge v3 chooseBranch
with extra inputs) requires data on exactly the listed inputs and data-or-empty on the rest.
An all-required node with an unwired lower input compiles to a join that can never complete,
with a diagnostic: n8n pads the lower inputs and never runs such a node, and
`unreachable({X/running})` reports it.

### OR-inputs (several producer edges into one input)

n8n runs a node once per data arrival on an input and never propagates an empty. Deciding
"skip" per empty edge would emit one empty per producer and strand a downstream join, so an
input with `n > 1` empty-capable producer edges aggregates a **round**: one delivery per edge.

```
arm_j_data:  one(e_j/data)  → and( X/ready_i, X/hasdata_i )   [payload on hasdata_i]
arm_j_empty: one(e_j/empty) → X/ready_i
X_start:     one(X/hasdata_i) one(_budget) one(X/idle) …  → X/running, X/ran_i   (one run per data arrival, immediately)
X_skip:      exactly(n, X/ready_i) inhibitor(X/hasdata_i) inhibitor(X/ran_i) read(X/idle) → empty edges, X/skipped
X_clear:     exactly(n, X/ready_i) inhibitor(X/hasdata_i) all(X/ran_i) read(X/idle)   (round closed after ≥ 1 run)
```

`read(X/idle)` is essential: `X_start` consumes `hasdata_i` when it fires but deposits `ran_i`
only when its action completes, so without the idle read an all-delivered round could skip
while the run it had just started was still in flight. `X/idle` is the node's own mutex, taken
by `X_start` and returned by `X_run`, so reading it closes exactly that window.
Edges whose producer is in a cycle carry `nil`, never `empty`, and do not count towards `n`.
The round form applies to single-input nodes; a cyclic producer's runs leave `ran_i` markers
that a later all-empty round does not clear (divergence #10).
Rounds that interleave (one producer delivers twice before its sibling delivers once) are
counted positionally and may skip wrongly; that is the arrival-order class already in the
divergence register, and `placeBound(X/ready_i, n)` proves a workflow free of it. Join inputs
keep their slot semantics (above); this rule is for the direct form.

### Expression references (`$('Y')`)

n8n evaluates `$('Y')` inside the node and throws "node is unexecuted" if `Y` has not run
yet, so whether a cross-branch reference works depends on canvas order. The net makes the
dependency explicit where it is well defined and reports the error where it is not:

- `Y` reachable from the start node on a path avoiding `X`: `X_start` carries `read(Y/done)`,
  and a twin `X_start_unmet: one(X/in) one(_budget) one(X/idle) read(Y/skipped)` (lower
  priority) puts a token in `X/running` tagged with the unmet reference, so the action fails
  with n8n's own error under the node's `onError` policy. `unreachable({X/in, Y/skipped})`
  proves the reference is always satisfied.
- `Y` unreachable from the start node (multi-trigger workflow): `Y/skipped` is seeded in the
  initial marking, so `X` fails exactly as n8n would.
- `Y` reachable only through `X` (self-, downstream- or loop-back reference): no read arc; the
  expression fails inside the action as in n8n. A diagnostic names the pair.

Deliberate divergence: a reference to a node on a parallel branch succeeds once that node
has run, instead of failing or succeeding by canvas order.

### Retries, halt, cancellation

- `retryOnFail`: parameters are read as n8n's `getRetryParams` reads them,
  `maxTries = min(5, max(2, node.maxTries || 3))`, `waitBetweenTries = min(5000, max(0,
  node.waitBetweenTries || 1000))`; `X/tries` seeded with `maxTries − 1`; `X_retry_wait` is a
  `delayed()` transition consuming one try; `X_exhausted` fires under `inhibitor(X/tries)`. The
  net decides retry-vs-exhaust; the verifier proves at most `maxTries` attempts.
- A fatal node error deposits `_halt`. Every start, retry-wait, exhausted, skip and arm
  transition inhibits on `_halt` and `_halted`, in-flight actions finish, and `_halt_reap`
  clears the edge, `in`, `ready` and `hasdata` places with reset arcs so a halted run
  quiesces cleanly. The reap leaves `X/retry` alone: it holds a budget unit, and clearing it
  would break `_budget + Σ(running + ok + retry) = k`. The marking is captured when the halt
  branch is written, i.e. before the reap fires, so the activations it clears are encoded
  back onto `nodeExecutionStack` behind the failed entry the host pushed: n8n's loop `break`s
  and leaves everything it has not popped there, and that stack is what a "Retry execution"
  replays.
- A Wait node (`waitTill`) or a `destinationNode` stop must not `close()` the executor:
  ENV-013 close stops all scheduling, so routes still pending would be lost and the marking
  could not be encoded. Instead `X_run` (and `X_exhausted`) carry two more outcome
  alternatives, `and(X/waiting, _pause, _budget)` (PlaceRole `waiting`: the node put the
  execution to wait and must re-run on resume, n8n's `pushExecutionStack`; the token carries
  the node's input `executionData`) and `and(X/stopped, _pause, _budget)` (PlaceRole
  `stopped`: the destination node ran, its outputs are recorded, its successors must not be
  enqueued). Neither is routed, and both refund the budget since nothing routes afterwards.
  `_pause` is the shared **control terminal** for both: only `X_start`, `X_start_unmet` and
  `X_retry_wait` inhibit on it (in addition to `_halt` / `_halted`); routes, skips, arms,
  clears, done and exhausted are **not** pause-inhibited, so a paused net drains every
  structural transition and quiesces on its own with every token on an `in` / `ready` /
  `hasdata` / `waiting` place, where the marking codec reads it into n8n's own
  `nodeExecutionStack` and `waitingExecution`. For M4 the verifier declares `_pause` and
  `_halted` as sink places (VER-002), so paused and halted markings are terminal and the
  stranded-token queries fire only on genuinely stuck runs.
- Cancellation is `executor.close()`; the workflow timeout stays n8n's own poll plus `close()`.
  A cancellation that arrives while the net is paused encodes in the cancellation mode:
  `close()` is exactly what can leave a completed action's output on `X/ok` with no `X_route`
  left to drain it, and only that mode routes such a token instead of rejecting the marking.

### Concurrency budget and its safety condition

`_budget` holds k unit tokens: k = 1 is sequential n8n, larger k is parallel. Positional
pairing is sound above k = 1 only if every node fires at most once per execution, which the
compiler checks (acyclic, and every input index has at most one producer). Otherwise k = 1.
Lifting that is the genuine use of ν-lineage names and is deferred.

The condition is about **arrival order**, not overlap: `X/idle` already makes two activations
of one node structurally non-overlapping at every k (`X/idle + X/running = 1` is a found
P-invariant). What breaks above k = 1 is that a node activated several times takes its
payload → `runIndex` pairing from the order its inputs arrive, and that order becomes the
producers' completion order rather than a structural fact.

### Concurrency

Above k = 1 several node actions are in flight at once. What makes that safe, what it changes,
and how k is chosen; the analysis and the measurements are in
[ADR 0006](docs/adr/0006-concurrency.md).

**The payload rule: a node's input items are read-only.** A token holds the very
`INodeExecutionData[]` array n8n produced, and `X_route` hands the same array to every edge of
an output — exactly as `addNodeToBeExecuted` writes it by reference into every waiting slot and
stack entry. What keeps two concurrent consumers apart is n8n's own lineage step:
`addPairedItemLineage` returns `{ ...item, pairedItem }` copies rather than stamping in place,
so every activation reads and writes its own item objects, and `assignPairedItems` — the one
in-place `pairedItem` write left — only ever touches the node's own fresh output. We add no
second copy: the lineage step is synchronous, so serialising it in the net would protect
nothing, and it costs 19 ns per item (0.19 ms for 10 000 items). The copy is shallow, so each
item's `json` stays shared; a node that mutates its input `json` in place already corrupts its
sibling in n8n, sequentially — concurrency only makes it nondeterministic.

**The pause claim.** `runExecutionData.waitTill` is one execution-global field, so above k = 1
the scheduler has to decide which node put the execution to wait. The claim is made in the same
synchronous turn in which a node's own `runNode` resolves: a node that started after the field
was already set never claims, and of the nodes that saw it change during their own run the one
whose run finished first keeps it. A refused claim is reported by diagnostic and the
`executionStatus: 'waiting'` that `host.createTaskData` stamped on that run — it reads the same
global field — is corrected to what the run actually was. The residual (a node that sets the
field and then keeps working while a sibling finishes) is divergence #15. `lastNodeExecuted`
becomes the last node to *complete* (#16), a sibling in flight when the execution halts or
pauses — or one that starts inside the halt window, which lasts until `_halt` reaches the
marking — finishes and is recorded (#17), and the dynamic-credentials flags are not node-scoped
above k = 1 (#18) — keep k = 1 for workflows that use dynamically-resolved credentials.

**The error contract.** `WorkflowScheduler.executionError` is the value `processRunExecutionData`
persists the execution as a success or a failure by, and n8n keeps it in one field it clears at
the top of every loop iteration and every retry. The scheduler keeps two instead: the **halt
error**, written once by the activation whose failure ended the execution and never overwritten,
and the **leftover** — an error a node's `onError` policy continued past — which the next
activation to *complete* replaces. `executionError` is `haltError ?? leftoverError`. At k = 1
completion order is n8n's iteration order, so the value is byte-identical; above it the leftover
follows completion order, like `lastNodeExecuted` (#19). Without the split a sibling's catch,
retry or start could erase a halt the net had already taken.

**Choosing k.** `registerPetriScheduler({ budget })`; the vitest/registration hook reads it
from the **`N8N_LIBPETRI_BUDGET`** environment variable (`src/n8n-vitest-setup.ts`), default 1,
and anything not a positive integer falls back to 1. The compiler may lower it: read
`CompiledWorkflow.effectiveBudget` and `budgetRestriction` for what a workflow actually got.
`PetriScheduler.maxInFlight` reports the high-water mark of concurrent runs (`X_run` actions)
of the last execution: a **lower bound** on `_budget + Σ(running + ok + retry) = k`, since a
retry wait and an exhausted recording hold their unit without running the node. A `retryOnFail`
node holds its unit across the retry wait (ADR 0004), so a retry-heavy workflow wants k above
its retry count.

### Initial marking and the marking codec

n8n stays the system of record. Trigger data goes onto the **start node's own `X/in`**: n8n
runs the trigger as `nodeExecutionStack[0]` (a webhook node passes its input through), and
`$('Webhook')` read arcs need `Trigger/done`. Join inputs fed only by nodes unreachable from
the start node are seeded with an empty token; a pre-filled `ready_i` slot withholds its
`free_i` token so `free_i + ready_i ≤ 1` holds from the start. On a Wait node the marking is
serialised into `nodeExecutionStack` and `waitingExecution` in n8n's own shape (empty tokens
as `[]`, not-arrived as `null`); on resume the marking is rebuilt from a non-empty stack.

## Layout

```
typescript/   one npm package, multi-entry: ".", "./compiler", "./verify", "./conformance"
patches/n8n/  0001-extract-scheduler-loop, 0002-scheduler-registry (rebasable, upstream quality)
scripts/      bootstrap-n8n.sh, run-conformance.sh, verify-patch.sh
docs/         adr/, divergences.md, assets/, diagrams/
spec/         n8n concept → libpetri requirement mapping
```

## Status

Milestone M3 (concurrency): the budget runs above 1. Two independent 500 ms branches take
507 ms against n8n's 1006 ms, and every cell of the fan-out benchmark is
`ceil(width / k) x 500 ms`; a chain with no parallelism to win costs the same at every k.
The `IRunExecutionData` a workflow produces is identical at k in {1, 2, 4, 8} — runData,
the resumable state and the scheduler contract — the one exception being a *halting*
execution, where the nodes in flight at the halt still finish (divergence #17). Measured
three ways: n8n's own suite per budget, the differential harness against a port of n8n's
loop, and `tests/conformance/budget-equivalence.test.ts` as a committed gate. Reports:
[`docs/conformance-m3.md`](docs/conformance-m3.md) (per-budget matrix),
[`docs/differential.md`](docs/differential.md) (the differ and the benchmark numbers),
[ADR 0006](docs/adr/0006-concurrency.md) (payload safety and the k > 1 semantics).

Milestone M2 (engine): the `PetriScheduler` runs n8n's execution-engine suite at k = 1 —
26/36 loop-driving cases and 1619/1621 helper cases (26/30 and 1621/1621 excluding the
out-of-scope AI-agent tool dispatch), full matrix in
[`docs/conformance-m2.md`](docs/conformance-m2.md). M0/M1 (scaffold, compiler, patches,
conformance harness) are done. See [`tasks/todo.md`](tasks/todo.md) and
[`CHANGELOG.md`](CHANGELOG.md).

## License

Apache-2.0. n8n itself is under the Sustainable Use License and is never committed here.
