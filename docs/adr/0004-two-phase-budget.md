# ADR 0004 — Two-phase start/run, the routed outcome, and the concurrency budget

Status: accepted (2026-09-04); **amended in M4** (2026-09-06), see "M4 amendment: the refund
moved to `X_done`"; **amended again on libpetri 5.0.0** (2026-09-07), see "M6 amendment: the
routing moved back into `X_run`". The shape in the second amendment is the one `README.md`
"Per-node gadget" documents.

## Context

n8n's loop is sequential: one node runs at a time because the loop `await`s `runNode()`.
Concurrency is the first reason this project exists, and it has to be a *net* fact —
provable, not a scheduler option — because libpetri's TypeScript port has no
concurrency-limit option (`PrecompiledNetExecutorOptions`; CONC-012 is MAY and unimplemented)
and because "the net decides what runs" is a hard rule.

Three facts about **libpetri 4.1.0** shape the design. The third of them is a bug that
libpetri 5.0.0 fixed; the M6 amendment below removes what it forced.

1. **A self-loop is invisible to the verifier.** The SMT encoding is atomic per firing
   (VER-004). A transition that consumes `_budget` and refunds it in its own output spec has a
   zero incidence column for `_budget`; `placeBound(_budget, k)` is proven trivially and
   nothing expresses "this node is in flight", so mutual exclusion of two nodes is not even
   stateable (`verification.test.ts`, self-loop case).
2. **A transition is at most once in flight** (`inFlightFlags[tid]` in
   `PrecompiledNetExecutor`). No requirement guarantees it, and the verifier cannot see it:
   without an explicit mutex `placeBound(X/running, 1)` is `violated` even though the
   executor never actually overlaps two firings (`budget.test.ts` control, `verification.test.ts`).
3. **An inner `xor` with no written child throws** *(fixed in libpetri 5.0.0; see the M6
   amendment)*. `validateOutSpec` raises `OutViolationError("XOR violation - no branch
   produced")` when it walks a nested `xor` none of whose children received a token; it does
   not report the enclosing branch as unsatisfied the way `and` does. Consequently the
   README's `xor( and(per-edge xor…, budget, idle, done), and(retry, …), and(halt, …) )`
   cannot take its retry or halt branch: validation aborts inside the success branch first
   (`out-spec.test.ts`, "nested under a xor branch"). The one escape is an artifact:
   `and` short-circuits on its first unsatisfied child, so declaring `X/done` (written only
   on success) *before* the per-edge `xor`s makes the retry branch validate, and moving
   the `xor` first rejects the identical write set (`out-spec.test.ts`, "depends on child
   order"). IO-015 defines `And` as a predicate over all children with no order, so a
   design that depended on that would rest on the TypeScript validator's loop order.

## Decision

Each node is a **two-phase** gadget with the outcome **routed** through `X/ok` so that no
`xor` is nested under another `xor` *(the indirection is removed by the M6 amendment; the
two-phase start/run and `X_done` are not)*:

```
X_start:      one(X/in) one(_budget) one(X/idle) inhibitor(_halt) inhibitor(_halted) → X/running
                                                                        priority = depth(X)
X_run:        one(X/running) → and( xor( X/ok, [X/retry], and(_halt, _budget) ), X/idle )
              action: host.runNode(...)                                 priority = depth(X) + 1
X_route_o:    one(X/ok_o) → and( xor(and(data edges_o), and(empty|nil edges_o)), X/routed_o )
              one per connected output                                  priority = depth(X) + 1
X_done:       one(X/routed_0) … one(X/routed_k-1) → and( _budget, X/done )
                                                                        priority = depth(X) + 1
X_retry_wait: one(X/retry) one(X/tries) one(X/idle) inhibitor(_halt) inhibitor(_halted)
              timing delayed(waitBetweenTries) → X/running              priority = depth(X)
X_exhausted:  one(X/retry) inhibitor(X/tries) → xor( X/ok, and(_halt, _budget) )
```

- **The budget is held from `X_start` until `X_done`**, one transition *after* the edge
  tokens are deposited (success); it is refunded on the halt branch by `X_run` /
  `X_exhausted` and on the two pause outcomes, and it is held across the retry wait.
  `_budget + Σ_X(X/running + X/retry + inflight_X) = k` is the P-semiflow, `inflight_X` being
  `X/ok_o + X/routed_o` for one output `o` of a split node (one law per output) and, since
  M6, the single `X/routed` for every node that routes inside `X_run`.
  Refunding after `X_run` rather than in it is what makes depth-first work at all: a
  successor's `X_start` and a budget-blocked sibling's `X_start` must become evaluable in the
  same scheduling cycle, so that **priority alone** picks the successor. Refunding one
  transition *earlier* (in `X_run`) lets the sibling take the budget before the successor's
  edge exists, which breaks depth-first at k = 1. Refunding one transition *later* than the
  edge deposit is the M4 amendment below — the original `X_route` refund was one cycle too
  early for a join / OR consumer, whose `arm` has to fire before its `X_start` can be
  evaluated at all.
- **`X/idle`** is the explicit per-node mutex. It makes `X/idle + X/running = 1` a found
  P-invariant and `placeBound(X/running, 1)` provable.
- **Priority = depth** (longest path from the trigger, back edges ignored) on `X_start`,
  depth + 1 on `X_run` / `X_route_o` / `X_done`. With equal priorities the executor falls back to
  declaration order (EXEC-002 AC3; the all-immediate fast path fires in declaration order
  outright), and declaration order is canvas order.
- **The action never throws.** A node failure is the `X/retry` or halt branch; the halt
  branch refunds the budget itself. A rejected action would lose the budget for the rest of
  the run (EXEC-030/031).
- **Halt.** `_halt` inhibits every `X_start` and `X_retry_wait`; `_halt_reap: one(_halt)
  reset(edge, ready and in places) → _halted` clears the net in one firing (CORE-034,
  EXEC-013); starts also inhibit on `_halted`. In-flight actions complete (EXEC-040) and
  `X_route_o` still records their output, which lands *after* the reap and stays in the
  marking; the scheduler reports it as such. **Superseded — see the M6 amendment below,
  "The reap is gone".**

## M4 amendment: the refund moved from `X_route` to `X_done`, for every node with an output

The reasoning above is unchanged and the conclusion needed one more step. The refund has to
land in the cycle in which **both** candidate `X_start`s are evaluable, and that is one cycle
later than this ADR assumed for a join or OR consumer.

libpetri's executor collects its ready set from the enablement flags **before** the firing
pass, and only `updateDirtyTransitions()` sets them (`precompiled-net-executor.ts`,
`fireReadyGeneral`), so a transition another firing enables *during* that pass fires no
earlier than the next cycle. A direct consumer's `X_start` is enabled by the edge token
itself; a join / OR consumer's needs its `arm` to fire first, one cycle later. With the
refund in `X_route`, the shallower budget-blocked sibling was evaluable a full cycle before
the armed deeper consumer and took the unit — breadth-first, exactly where priority = DAG
depth was meant to give n8n's depth-first order (divergence #20).

So `SPLIT_ROUTING_ABOVE` moved from 3 to **0**: every node with at least one connected output
uses the split shape this ADR's block now shows — `X_route_o` deposits the edge tokens and
marks `X/routed_o`, and `X_done` refunds `_budget` one cycle later, which is the cycle the
`arm` fires in. Both candidate `X_start`s then land in one ready set and priority decides. A
node with no connected output keeps a single `X_route` that refunds the budget itself: it has
no edge token to deposit and no `arm` to wait for.

A priority band was tried first — give every structural transition a priority above every
start — and **measured to change nothing**, for the reason above: priority orders the
snapshot, it does not extend it.

Cost: one place and one transition per node with an output, and one extra (synchronous)
executor cycle per node completion. The flatteners get *cheaper*: the `and` of `k` `xor`s
that IO-016 expands into `2^k` virtual transitions becomes `k` transitions of one `xor`.
Measured: n8n's own `v1 execution order > should execute nodes in the correct order,
depth-first & the most top-left one first` fails without the change and passes with it, and
the differ goes from 46 pass / 23 divergent to 49 / 20 — with one honest cost, a
destination-stop fixture that now leaves a sibling unrun (divergence #13). Full evidence in
[`docs/conformance-final.md`](../conformance-final.md).

## M6 amendment: the routing moved back into `X_run`, and `X/ok` is gone

libpetri 5.0.0 made [IO-015] an **exact-explanation search**: `And` is genuinely unordered,
an inner `Xor` no longer pre-empts an enclosing one, and an unselected subtree is never
evaluated. Fact 3 in the Context above is therefore no longer true, and the reason `X/ok`
existed at all is gone. `tests/spikes/out-spec.test.ts` pins the corrected semantics on the
minimal shape; `tests/spikes/collapsed-outcome.test.ts` pins the gadget's real spec — the
routing of every connected output nested inside the outcome `xor` — across 58 shapes (0-3
outputs × cyclic/acyclic × with/without retry × with/without halt), firing every branch and
asserting zero `transition-failed` events and the exact resulting marking.

So `X_run` routes:

```
X_run: one(X/running)
    -> and( xor( and( per connected output o:
                        xor( and(data edges_o), and(empty edges_o) | X/nil_o ),
                      X/routed ),
                 [X/retry], [and(_halt, _budget)],
                 [and(X/waiting, _pause, _budget)], [and(X/stopped, _pause, _budget)] ),
            X/idle )
X_done: one(X/routed) -> and( _budget, X/done )
```

`X/ok(_o)` and `X_route(_o)` disappear, and so does the per-output `X/routed_o`: a node has
one `X/routed`, whatever its output count. A node with no connected output succeeds into the
bare `X/routed` — the same topology it had before, renamed.

**What did *not* change is the M4 phase.** `X_done` still consumes `X/routed` one scheduling
cycle after the edge tokens land, so the refund still lands in the cycle a join / OR
consumer's `arm` fires in and both candidate `X_start`s still reach one ready set. The whole
chain simply moved one cycle earlier: `X_run` completes → (cycle N) edge tokens + `X/routed`
→ (N+1) `arm` and `X_done` → (N+2) the starts. Before, the same sequence took N through N+3
with `X/ok` in front. Every relative phase is preserved, and n8n's `v1 execution order >
depth-first & the most top-left one first` still passes.

### `SPLIT_ROUTING_ABOVE` goes back to 3, for the reason it had originally

Collapsing costs flattening. The SMT and SCG flatteners expand an `and` of `k` `xor`s into
`2^k` virtual transitions (IO-016), so the outcome costs `2^k + 4` flat branches routed
inside `X_run` against `2k + 5` split across `X_run` and its `X_route_o`s — neither figure
counts `X_done`, which both shapes have. Measured with `enumerateBranches`:

| connected outputs | routed in `X_run` | split per output |
|---|---|---|
| 1 | **6** | 7 |
| 2 | **8** | 9 |
| 3 | 12 | **11** |
| 4 | 20 | **13** |
| 6 | 68 | **17** |
| 10 | 1028 | **25** |
| 20 | *the flattener overflows its stack* | **45** |

The collapse wins outright at one and two outputs. **Three is a trade, and it is measured
rather than argued:** the split is one flat branch cheaper there, while the collapse removes
five places and three transitions — and on a three-output fan-out that is 46 places / 19
transitions / **360 state classes** collapsed against 51 / 22 / **461** split, so one branch
buys 22 % of the graph. From four outputs the branch count runs away and the split wins on
every axis. Hence **more than three** connected outputs keeps `X/ok_o`, `X_route_o` and
`X/routed_o`, and everything else routes in `X_run`.

This is the value `SPLIT_ROUTING_ABOVE` had before M4, but it is now purely the IO-016
threshold: M4's scheduling reason for lowering it to 0 was really about `X_done`, which is
now unconditional, so nothing regresses by raising it again. `switch20`'s Switch and
`fanOut4`'s Q are the only fixtures above it; `fanOut3` exists to measure the boundary.

### The reap is gone: `_halt` is the terminal marker

Collapsing the routing broke the reap, and the fix is to delete it rather than to time it.

The old shape had the halting node's `_halt` and a sibling's *outcome* land in the same
phase-1 batch, but the sibling's outcome landed on `X/ok_o`, which the reap did not touch;
`X_route_o` deposited the edge tokens a cycle later, after the reap, and they survived. That
is the "lands *after* the reap" sentence in the Decision above, and it was load-bearing. With
`X_run` routing its own outcome the edge tokens land **in** that batch, so the reap destroyed
them — and the marking snapshot the scheduler took to put them back was taken inside the
halting action, i.e. *before* the batch. The activation was in neither: no diagnostic, no
`transition-failed`, just an entry missing from `nodeExecutionStack`. Reachable at k ≥ 2 and
deterministic (`tests/scheduler/control.test.ts`, "resolves in the same executor cycle").

Timing the snapshot better does not fix it. The reap's reset arcs are applied at firing time,
**before** its own action could run (EXEC-013), so the reap cannot read what it destroys; and
a snapshot taken by any transition firing *earlier* leaves a window for whatever the next
cycle's completions deposit. The only instant that works is "the pre-reset marking of the
reap's own firing", which needs a second one-shot token and a second transition — measurably
worse: an extra place and transition per net, and 47 → 51 classes on `linear`, 6150 → 7175 on
`wide8`, more than undoing the collapse's saving.

So the destruction goes instead:

- `_halt_reap` and `_halted` are **deleted**; `_halt` is written by the halt branch of
  `X_run` / `X_exhausted` and **never consumed**. It is the halted run's terminal marker.
- Every transition that could move a pending activation on — `X_start`, `X_start_unmet`,
  `X_retry_wait`, `X_exhausted`, `X_skip`, the arms and now `X_clear` — inhibits on it, so
  the run quiesces with each arrival exactly where it was delivered.
- The scheduler encodes the quiescent marking directly. `state.haltMarking`, `haltStarts`,
  `haltPending`, `REAPED_ROLES` and the start-count drop are gone, and with them ADR 0006's
  "the snapshot is a lower bound on what the reap destroys" caveat: there is nothing to be a
  lower bound of.
- `verify/state-class.ts` moves `halt` into `REST_ROLES`. The residue a halted terminal now
  holds is exactly `HALT_REST_ROLES`, which already admitted the `in` / edge / `ready` /
  `hasdata` places because post-reap arrivals rested there before.

It is also strictly cheaper: one place and one transition fewer per net, and the halted
terminals no longer fan out through an intermediate `_halt` → `_halted` step, so every
fixture's class count falls (the table below counts it).

There was one live reason for the reap that had to be replaced rather than dropped. The
executor re-evaluates enablement *inside* a firing pass, so between `_halt` leaving the
marking and `_halted` entering it one phase later an `X_start` whose input place still held a
token would fire — the reset arcs closed that window by emptying those places in the same
firing. A `_halt` that is never consumed closes it by construction.

### What it bought

One place and one transition per node (`2k − 1` places and `k` transitions for a `k`-output
node that collapses), and a smaller state-class graph everywhere it was measured at k = 1:

The table below is the whole of M6 — the collapse *and* the halt change below it — against
M5:

| fixture | places | transitions | classes before → after | graph wall clock |
|---|---|---|---|---|
| linear (4 nodes) | 41 → 37 | 19 → 15 | 50 → **43** | 11 → 10 ms |
| diamond (6) | 70 → 62 | 34 → 27 | 393 → **330** | 14 → 8 ms |
| fanOut (4) | 39 → 37 | 17 → 15 | 99 → **90** | 1 → 1 ms |
| multiProducer (4) | 46 → 42 | 24 → 20 | 245 → **218** | 8 → 4 ms |
| chooseBranch (4) | 51 → 45 | 26 → 21 | 108 → **77** | 2 → 1 ms |
| ifBothOutputs (5) | 65 → 58 | 34 → 28 | 889 → **732** (violated) | 29 → 15 ms |
| chain40 (41) | 411 → 370 | 204 → 163 | 2048 → **1967** | 124 → 111 ms |
| wide8 (9) | 84 → 82 | 37 → 35 | 6151 → **5894** | 177 → 90 ms |
| switch20 (22) | 240 → 238 | 109 → 107 | truncated either way | 38.4 → 35.3 s |
| loopOverItems (4) | 48 → 42 | 25 → 20 | bounded (k = 21) either way | 4.1 → 4.1 s |

and at k = 2, where the budget lets branches interleave: diamond 1551 → **1094** (−29 %),
chain40 31448 → **29767**. Every verdict is unchanged. `wide8` and `switch20` barely move
because their class count is dominated by independent-branch interleaving (NU-053), not by
the per-node chain; `chooseBranch` and the k = 2 diamond move most, because there the
per-activation chain *is* the state space. One check improved: `placeBound(Loop/ready_0, 1)`
on `loopOverItems` now closes as `proven` under the SMT arm where it previously did not.

### The timeout is n8n's, not the net's

libpetri 5.0.0 also added `run(timeoutMs, 'close')`, which rejects **and** stops the loop
(the old `run(timeoutMs)` left the losing loop running, which is why CLAUDE.md forbade it).
The prohibition's *reason* is gone, but the scheduler still does not use it, and this is a
design decision rather than a leftover:

- n8n's workflow timeout is `WorkflowExecute.shouldStopExecuting()`, which is not a pure
  predicate. It sets `this.status = 'canceled'` and `this.timedOut = true`, and
  `processRunExecutionData` reads exactly those two fields afterwards to decide between
  `TimeoutExecutionCancelledError` and `ManualExecutionCancelledError` — and, before that,
  whether the execution is persisted as cancelled at all. A deadline enforced inside
  libpetri never calls it, so a timed-out execution would be saved as a **success**.
- n8n polls it **between** activations (`executionLoop` lines 49-51), never inside one, and
  the scheduler polls it in exactly the same place: once per activation, at the top of
  `attempt` (`src/scheduler/actions.ts`). A wall-clock deadline handed to `run()` would stop
  the net at an arbitrary instant instead, so an activation n8n would have let finish could
  be recorded differently — a data difference, which is always a defect here.
- `run(ms, 'close')` **rejects**, so it returns no quiescent marking. `finish()` needs one to
  write `IRunExecutionData` back, and the only other source is
  `PrecompiledNetExecutor.getMarking()`, which caches on its first call — the scheduler
  already depends on taking exactly one snapshot, inside the halting action.
- The hard deadline n8n actually enforces reaches us as `host.abortSignal` (n8n's
  `setupCancellation` → `PCancelable.cancel()`), and that is already wired to
  `executor.close()`.

So the poll stays. What is deleted is the *reason* CLAUDE.md gave for it. `run(ms, 'close')`
is the right tool for a harness safety valve — the differ's candidate leg has no timeout at
all (`tasks/todo.md` §5) — which is a separate change in a file this ADR does not own.

## Consequences

- At k = 1 two 200 ms nodes take ~400 ms and at k = 2 ~200 ms, with the budget back at k
  either way. `placeBound(_budget, k)` is proven; `mutualExclusion(A/running, B/running)` is
  proven at k = 1 and violated at k = 2, so the exclusion proof is real.
- One extra structural transition per node, `X_done` (plus one `X_route_o` per output above
  `SPLIT_ROUTING_ABOVE`); they fire in microseconds, and per-output routing keeps the flat
  transition count linear in the output count instead of `2^(outputs)` where it matters.
  There is no host-level transition at all: since M6 every transition of the flat net belongs
  to a node.
- Retries hold the budget while waiting. The README refunds `_budget` on the retry branch
  and re-acquires it in `X_retry_wait`; with the routed outcome that would also require
  `X_exhausted` to acquire `_budget` (its success token reaches `X_done`, which refunds), so
  an exhausted node would queue for a slot merely to declare exhaustion, and forgetting that
  arc inflates the budget by one per exhaustion. Holding the budget keeps the semiflow
  `_budget + Σ_X(running + retry + in-flight) = k` and is n8n's k = 1 behaviour (retries happen
  inside `runNode`). At k > 1 it is a policy choice; revisit if retry-heavy workflows
  starve siblings.
- `README.md` "Per-node gadget" documents this shape, both amendments included.
- The nested-`xor` behaviour was reported upstream to libpetri as a finding: IO-015's text
  ("Xor — satisfied iff exactly one child is satisfied") reads as a per-node predicate that an
  enclosing `xor` should be able to select over, while the outcome depended on child order
  inside the enclosing `and`. **libpetri 5.0.0 fixed it** — see the M6 amendment.

## Evidence

- `typescript/tests/spikes/budget.test.ts` — k = 1 vs k = 2 timings and in-flight maxima;
  budget and idle back after the ok, exhausted-retry and halt outcomes; with idle the second
  activation waits for the first to finish, without it the second `X_start` fires during the
  first `X_run`.
- `typescript/tests/spikes/priority-depth.test.ts` — `A, A2, B` with priority = depth;
  `A, B, A2` with all-zero priorities (fast path) and with equal non-zero priorities (sorted
  path, equal timestamps).
- `typescript/tests/spikes/out-spec.test.ts` — on libpetri 5.0.0 the nested `X_run` shape
  validates on the success branch **and** on the retry branch, and validation no longer
  depends on child order inside the enclosing `and` ([IO-015] exact explanation). The 4.1.0
  behaviour this ADR's Context describes is what the file used to pin.
- `typescript/tests/spikes/collapsed-outcome.test.ts` — the gadget's real collapsed spec
  across 58 shapes × every branch: zero `transition-failed`, the exact marking per branch,
  and the `enumerateBranches` table that fixes `SPLIT_ROUTING_ABOVE` at 3.
- `typescript/tests/spikes/retry.test.ts` — `tries` seeded 2: three attempts, then
  `X_exhausted` routes; ≥ 100 ms between the first and third attempt under
  `delayed(50)`; success on the second attempt leaves a try over; `onExhausted: 'halt'`
  deposits `_halt` and refunds the budget.
- `typescript/tests/spikes/halt.test.ts` — the M4 shape, kept as a spike: `_halt` stops the
  pending node, a reap clears its input and deposits `_halted`, the in-flight node completes
  and its routed output lands after the reap. The compiler has no reap since M6 (above); the
  spike still pins libpetri's reset-arc and inhibitor semantics, which is what it was for.
- `typescript/tests/scheduler/control.test.ts` — "a sibling that resolves in the same
  executor cycle as the halt keeps its arrivals (k = 4)" and its join twin: the two cases the
  reap lost, deterministic over five runs, plus `tokensResting(_halt) === 1` wherever a halt
  is asserted.
- `typescript/tests/compiler/emission.test.ts` — "nothing consumes `_halt` and nothing
  resets", over `retry`, `twoTriggers` and `multiProducer`.
- `typescript/tests/spikes/verification.test.ts` — with z3: `placeBound(_budget, k)` proven
  at k = 1, 2; `mutualExclusion` proven at k = 1 / violated at k = 2 with the
  `X/idle + X/running = 1` invariants found; `placeBound(A/running, 1)` proven with idle,
  violated without; the self-loop budget proven trivially with `_budget = 1` as a
  single-place invariant and no `running` place in the net.
