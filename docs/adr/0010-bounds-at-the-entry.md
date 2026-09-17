# ADR 0010 — Bounds at the entry, not a global concurrency counter

Status: **proposed** (2026-09-16). Supersedes the *concurrency budget* half of
[ADR 0004](0004-two-phase-budget.md) and the *k-safety* half of
[ADR 0006](0006-concurrency.md); the two-phase start/run shape and the payload-safety
analysis in those records stand unchanged. Nothing here is built. The measurements are real
and cited; the design is not yet pinned by a spike.

## Context

`_budget` is one place holding *k* units. Every `X_start` takes one and every `X_done`
refunds it (ADR 0004). It is the only shared place in the net with `one(...)` input arcs:
`compiler/names/places.ts:10-14` declares exactly three shared places, and the other two —
`_halt`, `_pause` — are monotone markers, written and never consumed, read only by inhibitors.

That one counter is doing three unrelated jobs.

1. **A throttle.** How many node activations may be in flight at once.
2. **An order mode.** At k = 1 the single unit is what makes n8n's depth-first order come
   out: the refund has to land at `X_done`, one cycle after the successor's edge tokens
   exist, so that the successor's `X_start` and a blocked sibling's `X_start` are evaluable
   in the same executor pass and priority alone decides (ADR 0004, "M4 amendment"). The
   depth-first witness fails without that and passes with it.
3. **A decidability lever.** `docs/verification.md` says so outright: it is the budget place
   from the ν-net spec, *"the decidability lever"*, standing in for ν-names we do not compile.

Four measurements say that welding these together is the wrong shape.

**The net does not grow with k.** `fanOut8` is 82 places and 63 transitions at k = 1, 2, 4 and
8; `switch20` 238/194; `agentTwoTools` 51/50. The budget is one integer in the initial marking
vector. So the state-class graph is exponential in concurrent width while every route whose
cost is a function of `|P| + |T|` is flat in k.

**The entry is already bounded.** `compiler/compile/marking.ts:120` seeds the start node with
exactly one token on an ordinary place that drains. For any workflow the k-safety check
already permits above k = 1 — acyclic, at most one producer per input index, every node
firing exactly once — the token content is bounded by the edge count *structurally*, with no
counter involved. `_budget` contributes nothing to boundedness there. It is pure throttle.

**One bad input costs the whole workflow its concurrency.** `compiler/compile.ts:53` reads
`effectiveBudget = restriction === null ? requested : 1`, and
`compiler/compile/k-safety.ts:9-23` sets that restriction for a cycle *anywhere* or a single
input index with more than one producer. ADR 0006:162-174 already corrects the stated reason:
it is **not** that two activations of one node could overlap — `X/idle` makes that
structurally impossible at every k — it is that a node with several activations takes its
payload → `runIndex` pairing from arrival order, which above k = 1 is completion order rather
than a structural fact. That is a property of *one input index*. Collapsing the entire
workflow to k = 1 for it is an artefact of having only one global knob.

**Removing the counter does not shrink the state space.** Measured: `fanOut4` 1,807 classes at
k = 1 rising to 33,141 and saturating at k ≥ 6; `agentTwoTools` 6,318 → 47,129; `fanOut8`
5,894 → 56,069 at k = 2 and truncating at the 200,000 cap from k = 3. No budget place is the
saturated case. The payoff of this ADR is **not** a smaller monolithic graph.

Two constraints from libpetri bound the design.

- **A bound is still required.** `spec/12-nu-nets.md` NU-050 #2: an unbounded-fresh-name net
  *without a budget place* yields `Unknown`, never `Proven`/`Violated`. VER-012 decides
  quiescence "with no budget place required" (AC1) only while the live-name pool is
  **structurally bounded** (AC2). Proper completion is a quiescence property, so this is our
  headline verdict, not a corner.
- **Environment places are the wrong mechanism.** libpetri says it twice —
  `spec/07-verification.md` and `open-net/closure.ts:18-21` — *"Under `alwaysAvailable` or
  `bounded(k)` an environment place never runs dry, so a net with one is never quiescent, and
  every quiescence property holds vacuously."* Even `bounded(k)`. `smt-verifier.ts:876` would
  mark the whole report vacuous. What a bounded contract means there is an **ordinary source
  place that runs dry** — which is exactly what `closeOpenNet` synthesises (`env:arrivals[i]`
  holding `min`, `env:optional[i]` holding `max − min`).

## Decision

### 1. Three bounds, all ordinary draining places, none global

| bound | where | seeded with | refunded |
|---|---|---|---|
| **entry** | the start node's own input place | the arrival count (today: implicitly 1) | never |
| **loop** | one per cycle, at the loop node | the declared loop bound | never |
| **throttle** | optional, author-placed, in front of one node or group | the author's number | on completion |

Never refunding the first two is what keeps the name pool finite, and it is not a new idea
here: `A/calls` and `A/rounds` are already exactly this shape — per-agent, bounded, never
refunded — and `compiler/gadget/agent-places.ts:22-32` documents that never refunding is what
makes the graph explore every round size up to the budget and no further, calling it NU-040's
decidability lever. This ADR generalises the agent gadget's own pattern to the whole net.

The throttle is the only refunding one, because it is a resource and not a claim width.

### 2. No global counter; `_halt` and `_pause` stay

`_budget` is deleted as a shared place. `_halt` and `_pause` remain monotone markers. The net
then has **no shared counter at all**, and a node gadget touches only its own places, its edge
places and two write-once flags.

### 3. k = 1 becomes an explicit compatibility mode, not the backbone

A global budget of 1 is just a local bound whose scope is every node. It is compiled **only**
when the caller asks for n8n-order-faithful execution, and it is named as such. The default is
no global place.

This keeps the leg that gates: `scripts/run-conformance.sh:54-66` compares k = 1 to the
unpatched baseline (35 of 44 loop-driving cases) and compares k > 1 legs to the k = 1 leg
instead, because n8n's suite asserts a total order. Nothing else reproduces that order, and
this ADR does not claim otherwise.

### 4. A multi-producer input is serialised at that input, not at the workflow

The hazard ADR 0006 identified is arrival order at one input index. The fix belongs there —
one slot at that input — and leaves every other node in the workflow fully concurrent. The
sound relaxation ADR 0006:176-189 specifies and defers is the same change seen from the other
side, and it lands in `compiler/graph.ts`.

### 5. Vocabulary

`verify/families/arrival-bound.ts` already means *join / OR input capacity* (ADR 0003). The
entry concept needs its own word — **admission** — and must not reuse "arrival".

## Consequences

**What it unblocks.** With no shared counter, a node gadget is an open net whose only ports
are its edge places and the two markers. That is the precondition for libpetri's VER-022
(`verifyOpenNet`), and it is what makes cost grow with node count rather than with
interleavings. Measured shape of the prize: `fanOut8` is 9 gadgets of 9 places; `switch20` is
22 gadgets, median 9, max 48; `agentTwoTools` is 5, median 7, max 18. Verifying 22 small nets
plus a linear graph check replaces one 238-place net whose graph truncates at 200,000 classes.
The 09-15 handover's contract loses its awkward `_budget is bounded(k)` environment clause.

**What it costs.**

- The monolithic state space becomes the saturated one. This ADR must not land before
  compositional verification, or every net gets strictly worse. Sequencing is not optional.
- NU-050's obligation moves from "one global counter" to "**every** name pool structurally
  bounded". More places to get right; each one local and meaningful.
- `verify/families/budget.ts` goes with the place: `placeBound(_budget, k)` and the semiflow
  `_budget + Σ_X(running + retry + in-flight) = k`. The replacement is one **local**
  P-invariant per gadget, `X/idle + X/running + X/retry + inflight_X = 1`, which is strictly
  more informative and is directly a contract clause.
- `verify/families/mutual-exclusion.ts` becomes trivially false everywhere. Its own docstring
  already calls it "a sanity check of the budget model rather than a workflow property", so it
  goes with the model it checks.
- ν-names, if adopted later, buy the permutation quotient only for *interchangeable*
  concurrency — loop items, tool calls. They do nothing for heterogeneous fan-out, so they are
  not a general answer to width.

**What does not change.** The codec: nothing in `codec.ts` or `codec/` reads or writes
`_budget`; it is in the "discarded, re-seeded on decode" row and `assertDrained` iterates
per-node places only. `A/calls` and `A/rounds` survive untouched; only the incidental
`_budget` arcs on `A_resume`, `A_calls_out` and `A_done_req` go. ADR 0006's payload-safety
analysis stands: the read-only-input rule is what makes concurrency safe, and it never
depended on the counter.

**Sequencing.**

1. Localise the k-safety restriction (ADR 0006:176-189). Independent, and the common
   real-world workflow is fully parallelisable except for one join.
2. Compositional verification: VER-022 plus the composition theorem we owe.
3. Delete `_budget`; make admission and loop bounds explicit; k = 1 becomes a named mode.
4. ν-names last, and only where the quotient pays.

## Evidence

Measured in this repository on 2026-09-16, against libpetri 5.1.0 and the unreleased
working tree (see [`tasks/libpetri-handover-2026-09-16.md`](../../tasks/libpetri-handover-2026-09-16.md)):

- net size invariant in k, and the 3-global-places / per-gadget decomposition above;
- state-class counts saturating in k, with `fanOut8` truncating from k = 3;
- `verify()` proving `fanOut8`, `fanOut12` and `agentTwoTools` flat in k through the algebraic
  route with the graph capped — 0.20–0.24 s across k = 1…8 on `fanOut8`.

Existing behaviour this ADR rests on, already pinned:

- `tests/spikes/budget.test.ts` — the self-loop control, why the two phases exist at all.
- `tests/spikes/priority-depth.test.ts` — priority orders the ready-set snapshot.
- `tests/scheduler/concurrency.test.ts` — the `multi-producer` counterexample: `C.0` fed by a
  30 ms `A` and an instant `B` pairs one way at k = 1 and the other at k = 4.
- `tests/conformance/budget-equivalence.test.ts` — data equivalence at k ∈ {1, 2, 4, 8}.

### Spike 3, run 2026-09-16: a gadget verifies on its own

Done, against the unreleased libpetri working tree. A gadget is taken from the real compiled
workflow, instantiated alone with its ports left open (`composeNet` → one `build.def`
instantiated into a fresh `PetriNet`, actions bound through the full `NetMap`), and checked
with `verifyOpenNet` against an admission contract.

The script is [`tasks/spike-open-net-gadget.mts`](../../tasks/spike-open-net-gadget.mts). It
is not under `typescript/tests/spikes/` because `verifyOpenNet` did not exist in the then-pinned
libpetri 5.1.0. *That blocker is gone:* VER-022 shipped in libpetri 6.0.0 and the floor moved
there on 2026-09-17, so the script runs against an ordinary install and could become a test.
Whether it should is a separate call — it would put open-net verification into CI's budget.

**The ports are what this ADR claims.** `fanOut8/W0` is a standalone net of 12 places and 7
transitions whose *entire* port list is `budget`, `halt`, `pause`, `in`, `in_empty` — the three
shared markers and one edge pair, no reference ports, no tool ports. `diamond/Merge`: 21p/12t,
9 ports (3 markers, 2 input edge pairs, 1 output edge pair). `agentTwoTools/Agent`: 25p/24t,
7 ports plus 2 tool ports — and `A/calls` / `A/rounds` are **internal**, not ports, which is
the local-bound model this ADR generalises, already working.

**The cost is budget-blind above the gadget's arrival count.** Class counts are *identical* at
budget 1 and budget 4 — `W0` 10, `Merge` 33, `Agent` 121 — and a gadget closes completely in
1–10 ms where the whole `fanOut8` net at k = 4 truncates at 200,000 classes in 18.5 s. `W0` is
`proven` at both budgets.

*Corrected 2026-09-16, after the corpus and libpetri's own cost curve.* The first draft read
that as "k-independent" and credited `X/idle`. Both were too strong. Class count tracks
`min(budget, arrivals)` and saturates above it, and the mutex is worth 6–13% of the count
without moving the saturation point at all (libpetri measured 132 → 153 serialised against
132 → 162 not, same plateau). What decides whether a gadget is budget-blind is **join versus
OR**. The two counts must be named apart wherever they both appear, because conflating them is
what made the first two attempts at this law each hold in one direction only: **index arity** is
how many distinct input indices a node has, **edge arity** is how many producer edges arrive at
it. Two indices is a *join* — both required, so it runs once at any budget. Several edges into
one index is an *OR* — several arrivals, and the budget binds up to that count.

The mechanism underneath, which covers both branches: **arrivals are not budget-gated,
activations are.** An arrival is delivered by the environment whenever it likes; an activation
needs a budget token. So a join's cost is its arrivals being simultaneously pending, and an OR's
is its activations in flight.

That makes it a **pair** of statements, with opposite axes, and reporting only the first would
mislead: *a join is budget-blind but arity-expensive; an OR is arity-cheap but budget-sensitive.*
libpetri's synthetic curve gives join cost 30, 42, 66, 210 at index arity 2, 3, 4, 6 — the same
sequence as independent binary choices, shifted by one — while every join is flat across budgets
1/2/4/8. Our arity-9 merge at 9.9 s is what the first statement alone would let someone build.

Measured over 502 real gadgets at budgets 1/2/4/8: **every join is budget-blind, 464 of 464**,
and 24 of 31 ORs move, each stopping at its own arrival count. The three numbers above are all
single-arrival gadgets, which is why they looked k-independent.

**A mechanism that explains and a test that predicts are different artifacts.** The mechanism
above survives; every attempt to turn it into a *structural predictor* over real compiled nets
has failed, and the reason is the same each time — which producers can actually start work is
not visible to a gadget-local contract, because that contract opens every arrival group
independently.

**Seven ORs are flat where the law says they should move. Two explanations were tested and both
refuted**, recorded here so neither is re-run:

1. *"Their second producer is unreachable, so they are ORs on paper with one live arrival."*
   Scoring by live producers instead of declared edges raises the exceptions from **7 to 11** and
   introduces contradictory ones, including gadgets with *zero* reachable producers that move
   anyway — which shows the independent variable is the contract's arrival groups, not the
   graph's producers.
2. *"Flat ⟺ all producers mutually exclusive (siblings of one router) and no loop-back edge."*
   Refuted in **both** directions over the 31 ORs: `googleSheets`, `set` and `code` are
   all-exclusive and loop-free and still move `[119, 137, 137, 137]`, while `emailSend` and `if`
   have concurrent producers and are flat at 25. Six misses.

No explanation currently fits, so the law is reported with its exceptions and the residue stays
unexplained on purpose.

**The rest-set vocabulary transfers unchanged.** Declaring `REST_ROLES` as the contract's rest
set and `HALT_REST_ROLES` / `PAUSE_REST_ROLES` as the two `terminal()` widenings — exactly
`completionSinksOf`'s whole-net declaration — makes the join's refunded slot tokens
(`free_0`, `free_1`) legitimate residue per gadget with no change.

Two corrections the spike forced, both about the *contract*, not the gadget:

1. **The 09-15 handover's clause 2 is wrong.** "For every edge `e` exactly one of `e/data`,
   `e/empty` holds one token" fails on `Merge`, which reaches a quiescent class writing its
   output edge zero times — the node skipped, and since the ADR 0002 amendment a skip stops at
   the last node that reads it. The clause has to be conditional: `done` ⇒ the edge is written
   exactly once, `skipped` ⇒ nothing.
2. **The agent gadget needs a declared environment.** Alone, `Agent` dispatches to `tool_0` and
   nothing ever answers `A/response`, so it quiesces with `dispatched`, `drained` and
   `outstanding` marked. That is correct for an open net whose environment does nothing, and it
   means the agent's contract must use `OpenNetContract.environment(...)` to model a tool
   replying — a direct consequence of ADR 0008 making the round a net round.

**Spikes still owed before this moves past `proposed`:**

1. A net with `_budget` deleted and admission seeded at the entry: assert proper completion is
   still decided, and record the class count against today's saturated figure.
2. The local P-invariant `X/idle + X/running + X/retry + inflight_X = 1` holding per gadget on
   every fixture, as the replacement for the global semiflow.
3. ~~`verifyOpenNet` on one compiled gadget~~ — done, above.
4. A cyclic workflow with a declared loop bound and no global budget, to confirm NU-050 #2 is
   satisfied structurally rather than by the counter.
5. The composition theorem itself: gadget contracts plus the graph conditions implying the
   whole-net property. Spike 3 proves the pieces are cheap; it says nothing about the join.
