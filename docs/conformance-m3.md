# M3 conformance — n8n's execution-engine suite at concurrency budget k = 1, 2 and 4

Produced by `scripts/run-conformance.sh` on the pinned n8n clone (`441970b`, patches 0001 and
0002 applied). Raw artefacts stay in the gitignored `conformance-results/`
(`<label>.junit.xml`, `<label>.matrix.md`, `<label>.test.log`, `<label>.diagnostics.txt`,
`<label>.budget.txt`). [`docs/conformance-m2.md`](conformance-m2.md) is the k = 1 report;
this one is about what raising the budget does to it. (M4 later widened its denominator from
36 to 44 and re-attributed its #12 rows to #20 — see
[`conformance-final.md`](conformance-final.md).)

M3 is the milestone where the engine stops being n8n-sequential. At k = 1 the `_budget` place
holds one token and the net is a re-derivation of n8n's loop, which is what M2 proved. Above 1
several `X_run` actions are in flight at once, which is the point of the project — two
independent 500 ms HTTP calls should take ~500 ms, not ~1 s.

## What the budget leg is compared to, and why

`scripts/run-conformance.sh` compares each k > 1 leg to the **k = 1 libpetri leg**, not to the
unpatched baseline, and does so automatically for `--budget=N` with N > 1. n8n's suite asserts
its own total `nodeExecutionOrder`, so a deliberately concurrent run fails against that
baseline by construction and the exit status would say nothing. Against the k = 1 leg — same
engine, same divergences, only the budget differs — a regression is a real one.

## Headline

| leg | reference | loop-driving | helpers | regressions | fixed |
|---|---|---|---|---|---|
| legacy (`StackScheduler` behind the seam) | baseline | **36 / 36** | 1621 / 1621 | 0 — case set and outcomes *identical* to the unpatched baseline | — |
| libpetri k = 1 | baseline | **26 / 36** | 1619 / 1621 | 12 | 0 |
| libpetri k = 2 | libpetri k = 1 | **25 / 36** | 1618 / 1621 | 2 | 0 |
| libpetri k = 4 | libpetri k = 1 | **26 / 36** | 1618 / 1621 | 2 | 1 |

By pattern:

| leg | execution-order | hook-order | branch-order | waiting | partial |
|---|---|---|---|---|---|
| libpetri k = 1 | 15 / 19 | 6 / 6 | 0 / 0 | 3 / 9 | 2 / 2 |
| libpetri k = 2 | 14 / 19 | 6 / 6 | 0 / 0 | 3 / 9 | 2 / 2 |
| libpetri k = 4 | 15 / 19 | 6 / 6 | 0 / 0 | 3 / 9 | 2 / 2 |

All three legs cover the same 1657 cases: 0 new, 0 missing at every budget. Six of the nine
`waiting` cases and two of the three helper failures are the AI-agent `EngineRequest` /
`EngineResponse` dispatch that is out of scope at every budget (`docs/conformance-m2.md`);
excluding them the engine passes **26 / 30**, **25 / 30** and **26 / 30** loop-driving cases at
k = 1, 2 and 4.

The legacy leg was re-run in this pass and is still byte-identical to the baseline: 36/36,
1621/1621, `identical: true`.

Timings on a machine at load average 3.0–5.1: legacy 8 s, libpetri 10 s per budget leg, the
whole `--budget=1` script 18 s. The suite is load-sensitive (an earlier run took 507 s at load
average > 20 and hit a 5 s vitest timeout), so run it idle.

## Every case that passes at k = 1 and fails above it

Two, and the same two at k = 2 and at k = 4. Both were reproduced as differ fixtures
(`typescript/tests/conformance/differ-fixtures.ts`) so the classification is measured rather
than argued: n8n's suite asserts the total order **first** and stops at the first mismatch, so
its junit can never say whether the *data* still matches. The differ can.

| case (n8n) | class | root cause |
|---|---|---|
| `workflow-execute.test.ts` → `v1 execution order > should run complicated multi node workflow` | **divergence — row #21 (new), under #5** | Ordering only. `Start → {Set1, Set2, Merge4.1}`, `Set1 → {Merge1.0, Set3}`, `Set2 → {Merge1.1, Merge2.1}`, `Set3 → Set4 → Merge3.0`, `Merge1 → Merge2 → Merge3.1 → Merge4.0`. n8n runs `Start, Set1, Set3, Set4, Set2, Merge1, Merge2, Merge3, Merge4`; at k ≥ 2 the net runs `Start, Set1, Set2, Set3, Merge1, Set4, Merge2, Merge3, Merge4`, because `Set2` and the `Set3 → Set4` chain have no dependency either way and the budget lets both go. The assertion that fails is `workflow-execute.test.ts:246`, `nodeExecutionOrder`, and nothing after it runs. Measured by the `complicatedMulti` differ fixture: **`data: equal` at k = 1, 2 and 4**, happens-before respected, all four moved activations attributed to the concurrency itself (`no dependency either way`) — every node still runs exactly once with the same payload |
| `webhook-respond-branch-order.test.ts` → `webhook responseNode branch ordering > skips the Respond node when the work node runs first and fails` | **divergence — registered row #17** | A `responseMode: responseNode` webhook fans out to the work node (y = 500) and a shared Respond node (y = 1000). The work node throws; n8n's loop `break`s and the Respond node never runs, which is what the case asserts. At k ≥ 2 both children take a budget unit in the same scheduling cycle, so `Respond to Webhook` is already in flight when the failure happens and the net cannot un-start an action. It finishes, is recorded, and the caller is answered where n8n would have left it unanswered. Measured by the `webhookRespond` differ fixture: the difference is exactly `runData['Respond to Webhook']` (a run n8n never performed) and the `nodeExecutionStack` length that follows from it — **no run either engine performed carries a different payload**, and the halting error is the same value at every budget (row #19 keeps it write-once) |

Neither is a defect. The rule this milestone is held to — *a data difference at k > 1 that is
not present at k = 1 is always a defect, never a divergence* — has one carve-out, the
registered abandonments, and row #17 is one: `EXEC-040`, in the register since M2's design pass
and stated normatively in the README's "Known limits". It is the only k > 1 behaviour change
a user can observe. **Keep k = 1 for a workflow whose correctness depends on one node's failure
suppressing a sibling that was ready to run.**

At k = 4 one case that fails at k = 1 passes: `v1 execution order > should run complicated multi
node workflow where multiple Merge-Node have missing data and complex dependency structure`.
That is coincidence, not a fix — the wider budget happens to line the net's start order up with
n8n's total order for that graph. The matrix reports it as `fixed`; do not read it as one.

### Nothing else changed character

Every case that fails at k = 1 still fails at k > 1 on the same assertion. Diffing the failure
blocks of `libpetri.test.log` against `libpetri-k2.test.log` and `libpetri-k4.test.log`, every
difference is a permutation inside a `nodeExecutionOrder` array or a timestamp; no case moved
from an order assertion to a data assertion at any budget.

### The engine's own diagnostics

Every libpetri leg now runs with `N8N_LIBPETRI_DIAGNOSTICS=1` (this pass changed
`scripts/run-conformance.sh` so the k = 1 leg collects them too — a diagnostic only counts as a
k > 1 finding if the k = 1 leg does not emit it). Across all 1657 cases:

| diagnostic | k = 1 | k = 2 | k = 4 |
|---|---|---|---|
| `node 'trigger': ensureInputData is false …` (divergence #14) | 1 | 1 | 1 |
| `node 'Merge2': stranded token on '…/ready_0' input 0` (divergence #2) | 1 | 1 | 1 |
| `halted: 1 pending activation(s) written back to nodeExecutionStack (Respond to Webhook)` | 1 | — | — |
| `budget: k=N lowered to 1 (multi-producer-input: Set2.0 has 2 producers)` | — | 1 | 1 |
| `budget: k=N lowered to 1 (cyclic: nodes in a cycle: IF, IF1, Set, Set1)` | — | 1 | 1 |

No new *class* of diagnostic appears above k = 1 — no stranded token, no refused `waitTill`
claim, no decode warning that k = 1 does not also produce. One disappears, and it is the same
event as the second regression above: at k = 1 `Respond to Webhook` is written back as a pending
activation; at k ≥ 2 it actually runs.

Only **two** of n8n's own workflows in the whole suite hit the compiler's k-safety check and
were forced back to k = 1 (one multi-producer input, one cycle). Everything else in the suite
ran at the requested budget.

## Does data equivalence hold at every budget?

**Yes.** Stated precisely, because the claim has a shape:

> For every workflow the compiler leaves above k = 1, the `IRunExecutionData` the engine
> produces at k ∈ {1, 2, 4, 8} is identical — `runData` (payloads, `pairedItem`, `source`,
> `executionStatus`, `metadata`, error shape), the resumable state (`nodeExecutionStack`,
> `waitingExecution`, `waitingExecutionSource`, `contextData`, `waitTill`) and the
> `WorkflowScheduler` contract values (`executionError`, `closeFunction`). The single
> exception is an execution that **halts**, where the set of activations differs by the
> nodes that were in flight when the halt happened (divergence #17) — and even there, no run
> both budgets performed carries a different payload and the halting error is unchanged.

Three independent measurements say so.

1. **n8n's own suite.** Two k > 1-only failures, both classified above, neither a data
   difference in a run both engines performed.
2. **The differential harness**, both engines on the same fixtures, all 23 fixtures × k ∈
   {1, 2, 4} = 69 runs: **0 fail, 0 unattributed differences, 0 novel mechanisms, 0 absent
   happens-before edges** (`conformance-results/differ-m3.md`, regenerate with
   `npx tsx src/conformance/differ-cli.ts tests/conformance/differ-fixtures.ts --budget 1
   --budget 2 --budget 4`). Only two fixtures produce a data difference that k = 1 does not
   also produce, `haltInFlight` and `webhookRespond`, and both are row #17.
3. **The budget-equivalence gate**, the same engine against itself at k = 1 vs k ∈ {2, 4, 8}
   over the whole fixture set: `typescript/tests/conformance/budget-equivalence.test.ts`. This
   is the M3 exit criterion as a test — n8n's ordering artifacts cancel out, so any difference
   is by definition about the budget. It also pins that the equality is not vacuous: which
   fixtures actually ran above k = 1 (all but the five the k-safety check restricts) and which
   ones actually had two or more actions in flight (eleven of twenty-three, `fanOut` and
   `partialRequired` reaching three).

Why this is sound and not luck: the compiler's k-safety check (`src/compiler/compile.ts`,
`kSafety`) leaves a budget above 1 only on a workflow that is acyclic and has at most one
producer per input index. Under that condition every node fires exactly once and its input on
index *i* is exactly its unique producer's output, so `runData` is a function of the graph and
not of the schedule. Everything the schedule *can* still move is an execution-global field, and
each one has a register row: `lastNodeExecuted` (#16), `executionError`'s leftover (#19),
`waitTill`'s claim (#15), the dynamic-credential flags (#18), and the activation set on a halt
(#17).

Beyond the fixed-timing runs, a randomised soak — every fixture at k ∈ {2, 4, 8} with a
per-node jitter of 0–5 ms before and 0–3 ms after each `runNode`, five seeds, ≈2200 runs —
produced **zero** unattributed data differences, happens-before violations or novel mechanisms.
It is not committed (wall-clock-dependent), but it is what makes the claim above about
interleavings rather than about one interleaving.

## What this pass looked for and did not find

The one open k > 1 hazard carried over from M2 is the **halt-snapshot race**: the marking
snapshot is taken inside the halting action, so a transition that consumes a token between that
instant and the moment `_halt` reaches the marking would have its token re-encoded as a pending
entry as well. For `X_start` the scheduler already subtracts it — `PetriScheduler.haltPending`
compares the per-node start counts against the counts at the snapshot and drops that many of
the snapshot's oldest tokens per start-input place, with a diagnostic. `X_skip` has no such
counter, because it is a structural transition with no action to count in.

> **Closed in M6, by removal.** There is no halt snapshot any more: `_halt_reap` and its reset
> arcs are gone, `_halt` is never consumed, and the pending activations rest in the quiescent
> marking, so a token another transition consumed is simply not there to be re-encoded (ADR
> 0004, "The reap is gone"). The `X_skip` window this section left open closed with it.

Two targeted experiments failed to reach the `X_skip` window, so M3 left it open rather than
fixing it blind (a fix would have to bind an action to a structural transition, and nothing here
could pin it with a failing test):

- A join fed by two siblings that both emit an empty output while a third sibling halts,
  400 runs at k = 4 sweeping both sleep durations: exactly three outcomes, all correct and all
  explained by which action finished first — the halting one (`waitingExecution.J` holds the
  join, right), the empty producers (the join skips, nothing pending, right), or a tie (the
  halt wins, deterministically).
- The same fixture with the halting action resolving 0–12 extra microtasks after the empty
  producers, 40 runs per offset: the halt reached the marking first in all 520 runs, so no
  skip ever fired inside the window.

Also unchanged and out of reach from the scheduler: divergence #18 (the dynamic-credential
flags are not node-scoped above k = 1 — keep k = 1 for workflows that resolve credentials
dynamically) and the residual half of #15 (a node that sets `waitTill` and then keeps working
loses the claim to a sibling that finishes first).

## Divergence register

This pass added one row and widened two:

- **#21 (new)** — n8n runs one node at a time, so a workflow's total execution order is a
  property of the graph plus canvas position alone. Above k = 1 `executionIndex` records the
  order the budget allocated. `replaced (k > 1 only)`; the mechanism behind the first
  regression above, where #12 is the k = 1 mechanism behind the same observable and #5 records
  that the assertions themselves are replaced.
- **#17** — now carries the n8n-suite evidence (`webhook-respond-branch-order.test.ts`), the
  statement that the difference is bounded to the activation set and the pending stack, and the
  recommendation to keep k = 1 where a failure must suppress a sibling.
- **#5** — names both mechanisms that produce the LIFO artifact: n8n's stack discipline (#12)
  and the concurrency the budget buys (#21).

## Reproducing

```bash
cd typescript && npm run build          # writes dist/n8n-vitest-setup.js, the hook
scripts/run-conformance.sh --budget=1                            # both engines; gates on the baseline
scripts/run-conformance.sh --engines=libpetri --skip-patch --budget=2
scripts/run-conformance.sh --engines=libpetri --skip-patch --budget=4
```

The k = 1 leg must run first: it writes `conformance-results/libpetri.junit.xml`, which is what
the k > 1 legs are compared to. Without it a k > 1 leg still writes its matrix, against the
baseline, but reports the result as informational and does not set the exit status.
