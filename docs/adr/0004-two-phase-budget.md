# ADR 0004 — Two-phase start/run, the routed outcome, and the concurrency budget

Status: accepted (2026-09-04). Amends the `X_run` output shape in `README.md`
("Per-node gadget"): the README still shows the single-transition shape this ADR replaces.

## Context

n8n's loop is sequential: one node runs at a time because the loop `await`s `runNode()`.
Concurrency is the first reason this project exists, and it has to be a *net* fact —
provable, not a scheduler option — because libpetri's TypeScript port has no
concurrency-limit option (`PrecompiledNetExecutorOptions`; CONC-012 is MAY and unimplemented)
and because "the net decides what runs" is a hard rule.

Three facts about libpetri 4.1.0 shape the design:

1. **A self-loop is invisible to the verifier.** The SMT encoding is atomic per firing
   (VER-004). A transition that consumes `_budget` and refunds it in its own output spec has a
   zero incidence column for `_budget`; `placeBound(_budget, k)` is proven trivially and
   nothing expresses "this node is in flight", so mutual exclusion of two nodes is not even
   stateable (`verification.test.ts`, self-loop case).
2. **A transition is at most once in flight** (`inFlightFlags[tid]` in
   `PrecompiledNetExecutor`). No requirement guarantees it, and the verifier cannot see it:
   without an explicit mutex `placeBound(X/running, 1)` is `violated` even though the
   executor never actually overlaps two firings (`budget.test.ts` control, `verification.test.ts`).
3. **An inner `xor` with no written child throws.** `validateOutSpec` raises
   `OutViolationError("XOR violation - no branch produced")` when it walks a nested `xor`
   none of whose children received a token; it does not report the enclosing branch as
   unsatisfied the way `and` does. Consequently the README's
   `xor( and(per-edge xor…, budget, idle, done), and(retry, …), and(halt, …) )` cannot
   take its retry or halt branch: validation aborts inside the success branch first
   (`out-spec.test.ts`, "nested under a xor branch"). The one escape is an artifact:
   `and` short-circuits on its first unsatisfied child, so declaring `X/done` (written only
   on success) *before* the per-edge `xor`s makes the retry branch validate, and moving
   the `xor` first rejects the identical write set (`out-spec.test.ts`, "depends on child
   order"). IO-015 defines `And` as a predicate over all children with no order, so a
   design that depended on that would rest on the TypeScript validator's loop order.

## Decision

Each node is a **two-phase** gadget with the outcome **routed** through `X/ok` so that no
`xor` is nested under another `xor`:

```
X_start:      one(X/in) one(_budget) one(X/idle) inhibitor(_halt) inhibitor(_halted) → X/running
                                                                        priority = depth(X)
X_run:        one(X/running) → and( xor( X/ok, [X/retry], and(_halt, _budget) ), X/idle )
              action: host.runNode(...)                                 priority = depth(X) + 1
X_route:      one(X/ok) → and( per output i: xor(and(data edges_i), and(empty|nil edges_i)),
                               _budget, X/done )
              action: route the result                                  priority = depth(X) + 1
X_retry_wait: one(X/retry) one(X/tries) one(X/idle) inhibitor(_halt) inhibitor(_halted)
              timing delayed(waitBetweenTries) → X/running              priority = depth(X)
X_exhausted:  one(X/retry) inhibitor(X/tries) → xor( X/ok, and(_halt, _budget) )
```

- **The budget is held from `X_start` until `X_route`** deposits the edges (success), is
  refunded on the halt branch by `X_run` / `X_exhausted`, and is held across the retry wait.
  `_budget + Σ(X/running + X/ok + X/retry) = k` is the P-semiflow. Refunding in `X_route`
  rather than in `X_run` is deliberate: the refund lands in the same completion as the edge
  tokens, so a successor's `X_start` and a budget-blocked sibling's `X_start` re-enable in
  the same cycle with the same enablement timestamp, and **priority alone** picks the
  successor (depth-first). Refunding one transition earlier lets the sibling take the budget
  before the successor's edge exists, which breaks depth-first at k = 1.
- **`X/idle`** is the explicit per-node mutex. It makes `X/idle + X/running = 1` a found
  P-invariant and `placeBound(X/running, 1)` provable.
- **Priority = depth** (longest path from the trigger, back edges ignored) on `X_start`,
  depth + 1 on `X_run` / `X_route`. With equal priorities the executor falls back to
  declaration order (EXEC-002 AC3; the all-immediate fast path fires in declaration order
  outright), and declaration order is canvas order.
- **The action never throws.** A node failure is the `X/retry` or halt branch; the halt
  branch refunds the budget itself. A rejected action would lose the budget for the rest of
  the run (EXEC-030/031).
- **Halt.** `_halt` inhibits every `X_start` and `X_retry_wait`; `_halt_reap: one(_halt)
  reset(edge, ready and in places) → _halted` clears the net in one firing (CORE-034,
  EXEC-013); starts also inhibit on `_halted`. In-flight actions complete (EXEC-040) and
  `X_route` still records their output, which lands *after* the reap and stays in the
  marking; the scheduler reports it as such.

## Consequences

- At k = 1 two 200 ms nodes take ~400 ms and at k = 2 ~200 ms, with the budget back at k
  either way. `placeBound(_budget, k)` is proven; `mutualExclusion(A/running, B/running)` is
  proven at k = 1 and violated at k = 2, so the exclusion proof is real.
- One extra structural transition (`X_route`) per node; it fires in microseconds and adds
  2^(outputs) flat transitions for the verifier exactly as the README shape would have.
- Retries hold the budget while waiting. The README refunds `_budget` on the retry branch
  and re-acquires it in `X_retry_wait`; with the routed outcome that would also require
  `X_exhausted` to acquire `_budget` (its `X/ok` token reaches `X_route`, which refunds), so
  an exhausted node would queue for a slot merely to declare exhaustion, and forgetting that
  arc inflates the budget by one per exhaustion. Holding the budget keeps the semiflow
  `_budget + Σ(running + ok + retry) = k` and is n8n's k = 1 behaviour (retries happen
  inside `runNode`). At k > 1 it is a policy choice; revisit if retry-heavy workflows
  starve siblings.
- `README.md` must be updated to this shape; until then this ADR is authoritative.
- The nested-`xor` behaviour is reported upstream to libpetri as a finding: IO-015's text
  ("Xor — satisfied iff exactly one child is satisfied") reads as a per-node predicate that an
  enclosing `xor` should be able to select over, the outcome currently depends on child order
  inside the enclosing `and`, and the Java/Rust validators need checking for the same
  behaviour before this shape is used anywhere.

## Evidence

- `typescript/tests/spikes/budget.test.ts` — k = 1 vs k = 2 timings and in-flight maxima;
  budget and idle back after the ok, exhausted-retry and halt outcomes; with idle the second
  activation waits for the first to finish, without it the second `X_start` fires during the
  first `X_run`.
- `typescript/tests/spikes/priority-depth.test.ts` — `A, A2, B` with priority = depth;
  `A, B, A2` with all-zero priorities (fast path) and with equal non-zero priorities (sorted
  path, equal timestamps).
- `typescript/tests/spikes/out-spec.test.ts` — the README `X_run` shape validates on the
  success branch and fails with `XOR violation - no branch produced` on the retry branch;
  with `X/done` declared before the inner `xor` the retry branch validates, with the `xor`
  first the same writes are rejected.
- `typescript/tests/spikes/retry.test.ts` — `tries` seeded 2: three attempts, then
  `X_exhausted` → `X_route`; ≥ 100 ms between the first and third attempt under
  `delayed(50)`; success on the second attempt leaves a try over; `onExhausted: 'halt'`
  deposits `_halt` and refunds the budget.
- `typescript/tests/spikes/halt.test.ts` — `_halt` stops the pending node, the reap clears
  its input and deposits `_halted`, the in-flight node completes and its routed output lands
  after the reap; `_halted` keeps inhibiting after `_halt` is consumed.
- `typescript/tests/spikes/verification.test.ts` — with z3: `placeBound(_budget, k)` proven
  at k = 1, 2; `mutualExclusion` proven at k = 1 / violated at k = 2 with the
  `X/idle + X/running = 1` invariants found; `placeBound(A/running, 1)` proven with idle,
  violated without; the self-loop budget proven trivially with `_budget = 1` as a
  single-place invariant and no `running` place in the net.
