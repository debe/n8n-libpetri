# ADR 0003 — The join gadget and the `requiredInputs` mapping

Status: accepted (2026-09-04)

## Context

n8n represents a multi-input node's pending arrivals as `waitingExecution[node][runIndex].main`,
an array with one slot per input holding `INodeExecutionData[]`, `[]` or `null` (not arrived).
`addNodeToBeExecuted` (`workflow-execute.ts` @ `441970b`, lines 440–851) allocates the
*first run index whose slot for this input is still free* (lines 476–504, `waitingNodeIndex`;
a fresh index when none is free, 501–504), writes the arrival into that slot (810–826) and
pushes the node onto the stack once no slot is missing (828). Because v1 never emits an
empty output (ADR 0002), joins with a starved branch never fill, and the loop falls back to
**R6** (lines 2582–2740), which runs only when `nodeExecutionStack.length === 0 &&
waitingNodes.length` (2586–2588) and is the *only* consumer of `requiredInputs`
(2608–2631, 2664–2680):

- `requiredInputs` is read from the node description, evaluated as an expression against
  `$parameter` if it is a string (2608–2620).
- If it is an array whose length equals the input count, or the number equal to the input
  count, the node is skipped by R6 entirely — "all inputs are required, but not all have data"
  (2623–2631). Merge `chooseBranch` (`[0, 1]`) is this case.
- Otherwise R6 takes the earliest run index (2645–2650), computes `inputsWithData` as the
  non-`null` slots — an empty `[]` counts (2654–2660) — and requires every listed index
  (array form, 2664–2675) or at least `n` of them (number form, 2678). `null` slots become
  `[]` (2688) and the node fires only if at least one input is non-empty (2691, 2728).

Two things in that code are artifacts, not semantics. R6 fires with whatever subset has
arrived because the stack happens to be empty, and the slot allocator pairs arrivals by
scanning run indexes for a free slot rather than by arrival order, re-initialising the chosen
index through `prepareWaitingToExecution` (421–437, every slot reset to `null`) before writing
the slot array back (817–826). Divergence #4 records the slot-overwrite defect reported
against this allocator; the net never allocates a run index, so the question does not arise.

## Decision

Every node with k ≥ 2 inputs, or with an input fed by several producer connections, compiles to
the **join gadget**:

```
per input i:  X/free_i (1 token)
per edge e into input i:
  arm_e_data:  one(e/data)  one(X/free_i) → and(X/ready_i, X/hasdata)
  arm_e_empty: one(e/empty) one(X/free_i) → X/ready_i
X_start: one(X/ready_0)…one(X/ready_k-1) all(X/hasdata) one(_budget) one(X/idle) inhibitor(_halt)
         → and(X/running, X/free_0 … X/free_k-1)
X_skip:  one(X/ready_0)…one(X/ready_k-1) inhibitor(X/hasdata) → and(empty edges…, X/skipped, X/free_*)
```

- **A slot is the set of `ready_i` tokens.** `free_i` is taken by the arm and returned by
  `X_start` / `X_skip`, so a second arrival on input i waits in its edge place until the current
  slot is consumed. Pairing is FIFO per input (EXEC-010), which is n8n's first-free-slot
  allocator without the overwrite.
- **`all(X/hasdata)`** requires at least one token (IO-003 AC3) and drains all of them, so
  "at least one non-empty input" is structural and `hasdata` counts one slot only.
  `X_skip` carries `inhibitor(X/hasdata)` (CORE-031); start and skip are mutually exclusive
  with no priority involved.
- **Input-side OR** (several producers into one input) is one arm transition per edge, all
  competing for the same `free_i`.

The `requiredInputs` mapping:

| n8n `requiredInputs` | R6 behaviour | Net |
|---|---|---|
| `undefined` (default) | fire when ≥ 1 arrived slot is non-empty, after the stack drains | `X_start` as above: every input has arrived (data or empty), ≥ 1 non-empty |
| number `n < inputs` | ≥ n arrivals (`[]` counts), ≥ 1 non-empty | same as default — with explicit empties every input arrives, so the n-of-k threshold is always met by the time the join can fire |
| number `= inputs` | never partial-fire | same as default (all `ready_i` are consumed) |
| array `= all inputs` (Merge `chooseBranch`, always `[0, 1]`) | never partial-fire | `X_start` enumerates the four data/empty combinations explicitly; no `all()`, no priority reliance |

n8n's partial fire on an arrival-count mismatch (two producers on one input, one on the
other) is **not** reproduced. The second slot's `ready_0` token has no partner and stays;
the verifier flags it statically and the runtime reports it (divergence #2).

## Consequences

- A join fires exactly once per slot and never loses data; the R3 overwrite cannot happen
  because the arm waits on `free_i` instead of allocating a run index.
- Proper completion is `joinedOrDeadLettered(X/ready_i)` with **no sinks declared**, per join
  input. The query on the *edge* place is not enough: the arm drains an edge into `ready_i` as
  soon as `free_i` returns, so the stranded token lives one place downstream of the edge. M4
  must run the property on every `ready_i` (and on edge places for single-input nodes).
- `X_start` for a k-input node consumes k + 3 places; the arms are microsecond structural
  firings. For Merge `chooseBranch` the four explicit branches keep the verifier exact.
- The marking codec (ADR 0005) maps slots to `waitingExecution` entries slot-by-slot from
  the `ready_i` FIFO queues: `data` tokens as the items, `empty` tokens as `[]`, and a missing
  `ready_i` as `null`.

## Evidence

- `typescript/tests/spikes/join-gadget.test.ts` — two arrivals per input: `X_start` fires
  twice, pairs `(a1, b1)` then `(a2, b2)`, `hasdata` is 2 in each slot (never 3 or 4), the
  second arm on each input starts only after the first `X_start`; an all-empty slot takes
  `X_skip`; one data + one empty takes `X_start` with `hasdata = 1`; mixed slots decide
  exactly once per slot; `free_i`, `budget`, `idle` are all back at the end.
- `typescript/tests/spikes/verification.test.ts` — with z3: unbalanced join (2 producers on
  input 0, 1 on input 1) is `violated` on `X/ready_0` with a counterexample trace and
  `proven` on the input-0 edge place; the balanced diamond is `proven` on the edge place and
  on both `ready_i`.

## Amendment (2026-09-05)

"One arm per incoming edge" remains the model for join inputs (slot semantics). For a
**single-input** node fed by several empty-capable producer edges it is superseded by the
round form in README "OR-inputs": one run per data arrival, one skip only when every producer
delivered empty, with `read(X/idle)` on the skip and clear transitions. Reason: per-edge skips
emitted one empty per producer and stranded the downstream join in the common "IF both
outputs into one node" pattern (review finding, pinned in `tests/compiler/or-input.test.ts`).

