# ADR 0011 — The composition theorem: per-gadget contracts to a whole-workflow claim

Status: **proposed** (2026-09-16). Depends on [ADR 0010](0010-bounds-at-the-entry.md), which
removes the one obstacle that would make this argument much harder. Nothing here is built. The
coverage numbers are measured; the proof is a sketch, not mechanised.

## Context

[ADR 0010](0010-bounds-at-the-entry.md)'s spike 3 established that a node gadget verifies alone,
completely, in 1–17 ms: `fanOut8/W0` is 12 places and 7 transitions, `proven` in 10 classes,
against a whole net that truncates at 200,000 classes. libpetri's VER-022 (`verifyOpenNet`)
supplies the per-gadget verdict and says outright that the rest is ours —
*"turning those proofs into a claim about the composed net is the caller's own theorem"*.

Without that theorem, per-gadget proofs are 502 facts about 502 small nets and say nothing about
any workflow. This ADR is the theorem.

It also has to explain a **measured false `violated`**. On `or-round-overflow.json` the verifier
reports a stranding on a graph that closes — an exact verdict over the abstraction — and every
real run of both engines completes with identical data at k = 1, 4 and 8
([`docs/verification.md`](../verification.md), "That caveat has teeth"). Any composition
argument that would have licensed that report is the wrong argument.

## Decision

### 1. The interface is narrow, and that is what makes the argument possible

Measured on real gadgets: a gadget's entire port list is the shared markers plus its edge
places. `fanOut8/W0` has five ports — `budget`, `halt`, `pause`, `in`, `in_empty`. No reference
ports, no tool ports. Under ADR 0010 the budget port goes and two remain, both **monotone**:
`_halt` and `_pause` are written and never consumed, read only by inhibitors.

So the composed net is gadgets fused on edge places, plus two write-once flags. Each edge place
has exactly one producing gadget and one consuming gadget, by construction — the consumer owns
it and the producer binds an output port to it.

### 2. Arrivals are a **sum of activation counts**, never a count of edges

This is the content of the theorem, and the thing the OR-round bug got wrong.

By ADR 0002's emission rule every activation of a producer writes exactly one token on each of
its outgoing tree edges — `data` on the selected output, `empty` on the others. Therefore, for a
consumer `C` and input index `i`:

```
arrivals(C, i)  =  Σ over edges e into (C, i)  of  activations(producer(e))
```

**not** the number of edges into `(C, i)`. The two coincide only when every producer fires
exactly once. `compiler/gadget/input-or.ts:31` declares the OR round as the edge count, and
`verify/families/arrival-bound.ts` then checks `placeBound(ready_i, round)` against it — which is
why a producer that runs twice reports an overflow that is not one.

`activations(X)` is itself derived, in topological order: a start node has the one seeded
arrival; a join fires once per complete tuple, so `min` over its required inputs; every other
form fires once per arrival. Acyclicity is what makes this a terminating fixpoint rather than a
recurrence, which is exactly why cycles are excluded below.

### 3. The theorem

> **Let** `W` be a workflow whose graph is acyclic, in which every join input has at least one
> producer, and which contains no agent. **Let** each node `X` carry a contract `C_X` stated at
> the derived `arrivals(X, i)` of §2, guaranteeing: given those arrivals, `X` reaches quiescence
> having consumed them, returned to `idle`, and written exactly one token on each outgoing tree
> edge per activation — and, under a designed terminal, having left residue only on the places
> that terminal excuses.
>
> **Then** the composed net has proper completion: every quiescent marking reachable from the
> initial marking holds tokens only on rest places, or on the residue a marked `_halt` / `_pause`
> excuses.

**Proof sketch.** Induct over a topological order of the nodes. The start node receives the one
seeded token. For `X`, every producer precedes it, so by the induction hypothesis each has
completed and written exactly its contracted tokens; summing over the edges into `(X, i)` gives
precisely `arrivals(X, i)`, which is what `C_X` is stated at. So `C_X` applies: `X` consumes
them all and leaves its own places empty. At quiescence every gadget is idle and every edge
place has been drained by its unique consumer, so no token is stranded.

For the halted case: `_halt` and `_pause` are monotone and every transition that starts an
activation inhibits on them, so once marked no new activation begins and no gadget can un-halt
another. The composed residue is then the union of the per-gadget terminal clauses — a
*union*, not an interaction, which is what makes the halted case compose at all.

**Where ADR 0010 earns its keep.** Keeping a global `_budget` adds an obligation this induction
cannot discharge: a gadget's contract silently assumes a unit is available to it. Seeded at 0,
`fanOut8/W0` — the simplest gadget in the repo — is `violated`, stranding its own input. That
assumption is a global claim (no cycle of gadgets holds-and-waits on the counter), it is not a
per-gadget fact, and it is *k*-dependent in general. Without the counter it does not arise.

### 4. What the theorem does not license

It is a statement over the same priority-blind, value-blind abstraction as everything else
(VER-004). It therefore inherits the candidate/finding distinction: a composed `violated` is a
candidate until replayed against the executor. It cannot repair the false `violated`; it
explains it, by showing the bound was derived wrongly in the first place.

## Consequences

### Measured coverage — the theorem is a foundation, not the answer

On the 200-template corpus (`tasks/spike-composition-conditions.mts`):

| condition | templates | share |
|---|---:|---:|
| acyclic | 139 | 69.5% |
| no agents | 140 | 70.0% |
| every join input has a producer | 199 | 99.5% |
| **all three — the theorem applies** | **81** | **40.5%** |

What excludes the rest: 58 cyclic, 57 agents, 3 both, 1 join without a producer.

**40.5% is the honest headline.** A composition theorem scoped to acyclic agent-free workflows
covers two in five real ones. The two extensions are worth more than the core:

- **Cycles (58 templates).** Needs ADR 0010's declared loop bound to make `activations` a
  terminating fixpoint. Until then the derivation does not even have a value to state a contract
  at.
- **Agents (57 templates).** ADR 0008 makes a tool round a round *in the net*, so an agent alone
  quiesces mid-round with `dispatched` / `drained` / `outstanding` marked — correct for an open
  net whose environment does nothing. An agent and its tools must be one verification group with
  a declared environment, not separate gadgets.

### It predicts the OR-round defect independently

Deriving `arrivals` and comparing it with the declared round finds **15 inputs across 10
templates (5%)** where arrivals exceed the round — including `5841.json`'s
`Create a post[0] round=2 arrivals=3`, the case reduced to `or-round-overflow.json` and
disproved on a live server. The derivation was written from the emission rule, not from the
testbed result, and it picks the same nodes out. Two consequences: `arrival-bound.ts` is checking
the wrong quantity, and the fix is to state the bound at the derived arrival count.

Also worth stating plainly: 10 templates is fewer than the 25 that report a violation, so the OR
round explains at most 40% of them. The rest are still untriaged.

## Evidence

- Port narrowness and per-gadget cost: ADR 0010, spike 3; `tasks/spike-open-net-gadget.mts`.
- Per-gadget cost at corpus scale: `tasks/spike-open-net-corpus.mts` — 1,004 verifications, 502
  gadgets, cost tracking port count rather than budget.
- Graph conditions and the arrival derivation: `tasks/spike-composition-conditions.mts`.
- The false `violated` and its live-server disproof: `docs/verification.md`, and
  `scripts/testbed/workflows/or-round-overflow.json`.

**Owed before this moves past `proposed`:**

1. State `C_X` formally per input form — direct, join, OR, choose-branch, tool — rather than as
   the one generic contract the spikes use. The generic one is already known to be wrong for a
   node that can skip.
2. Mechanise the derivation of `arrivals` in the compiler, so a contract is generated rather
   than hand-written. The spikes hand-write it and got it wrong twice.
3. Fix `arrival-bound.ts` to check the derived count. This is independent of the rest and can
   land first.
4. The cyclic extension, with the declared loop bound.
5. The agent group, with `OpenNetContract.environment(...)` modelling a tool reply.
