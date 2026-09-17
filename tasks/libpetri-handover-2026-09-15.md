# Handover to libpetri — prove subnets, exact consume-all, a state-equation phase

Date: 2026-09-15. From: n8n-libpetri (`/Users/db/repositories/n8n-libpetri`). For: a Claude
session working in `/Users/db/repositories/libpetri/typescript`.

Everything below is measured against libpetri 5.1.0 (source commit `f2c559c`) and the
n8n-libpetri working tree of today, which is uncommitted. Paths in libpetri are under
`src/verification/` unless stated otherwise.

## Context in five lines

n8n-libpetri compiles an n8n workflow into one Coloured Time Petri Net built from a fixed
vocabulary of per-node gadgets, composed through one port protocol: a tree edge carries `data`
or `empty`, a cycle edge `data` or `nil`, and `_budget` / `_halt` / `_pause` are shared
terminals. The same net runs and is verified. The verifier asks libpetri "no stranded token at
quiescence" (`deadlockFree()` with `sinkPlacesWhen` conditional sinks) through the state-class
graph first and `SmtVerifier` (IC3 through Z3 Spacer) as fallback.

Where that stands after today's compiler fix (a skip no longer forwards its empties past the
last node that reads them, ADR 0002 amendment):

| Net | State-class graph | Spacer | One-shot marking equation (prototype, below) |
|---|---|---|---|
| chat bot, 37 nodes, agent with 2 tools, k = 1 | truncates at 200,000 classes | proven in 226 s (unknown at 300 s before the fix) | **unsat in ~45 ms** |
| `switch20` | truncates | 277 s | unsat in ~40 ms |
| `chain40` | 407 classes | 410 s | unsat in ~50 ms |
| `diamond` | 295 classes, proven | — | **sat, spurious** (`Merge/hasdata` = 1) |
| `loopOverItems` | bounded | 0.5 s | **sat, spurious** (`Loop/hasdata`) |
| `ifBothOutputs` | 695 classes, violated | — | sat, real (`Merge/hasdata`, `ready_0`, `ready_1`) |

Two facts drive the three asks. Both spurious answers come from places with a consume-all arc,
which `equationPlaces()` (`z3/smt-encoder.ts`) drops from the equation. And what still blows
up the graph is a *product*: an agent's round interleaved with a value-blind router's
branches and with the positions a halt can freeze. Neither factor is large on its own.

A rule we keep on our side and ask you to keep on yours: **a bound is both the runtime cap
and the width of the claim.** n8n-libpetri bounds everything it compiles (budgets, tool calls,
declared loop bounds). Anything unbounded is reported as unproven, and that is the intended
answer, not a gap to close with liveness machinery.

## Ask A — prove subnets: open-net verification against a contract

**What.** A public entry that verifies a subnet in isolation, with its ports treated as the
environment, against a contract. n8n-libpetri will call it once per compiled node gadget, and
carry a composition theorem (an ADR on our side) that turns the whole-net property into a
linear check on the workflow graph when every gadget meets its contract. Cost then grows with
the node count, never with interleavings: an agent gadget with two tools and a budget of four
is a net of a few dozen places on its own.

**What exists.** `analysis/environment-analysis-mode.ts` has `always-available`, `bounded(n)`
and `ignore` for environment places on the plain `StateClassGraph.build`; the SMT encoder has
`resolveEnvInjection`. What is missing is the property and the entry.

**Contract, as we would state it for a node gadget X** (ports: `X/in` or `X/ready_i`,
`_budget`, `_halt`, `_pause`, per outgoing edge `e` the places `e/data` and `e/empty`, and
`X/idle`):

1. Environment: exactly one arrival is injected (`bounded(1)` on the input ports), `_budget`
   is `bounded(k)`, `_halt` and `_pause` are either never or once.
2. Guarantee at every quiescent marking without `_halt`: for every edge `e` exactly one of
   `e/data`, `e/empty` holds one token; `X/idle` holds one; `_budget` holds `k`; every place
   internal to X holds zero.
3. Guarantee with `_halt`: quiescence is reached, and the arrival is still on the place it was
   delivered to (the conditional sink excuse, VER-014, already says which).

Most of this is expressible today as `deadlockFree()` with sinks plus unreachability of
"both `e/data` and `e/empty`" and of "internal place marked at quiescence". A first-class
`contract` property would make the verdict and its witness readable: the report should say
*which* clause a gadget broke and show the port trace.

**Acceptance.** `verifyOpen(net, ports, contract)` (name yours) returns proven, violated with
a decoded witness, or unknown with the reason; runs on the plain graph and on the SMT route;
and a contract violation on a deliberately broken gadget (an edge with neither `data` nor
`empty` written) names the edge.

## Ask B — consume-all exact along the whole SMT route

**Why this is not a join-only problem.** n8n-libpetri uses `all(p)` for the join's `hasdata`
and for OR rounds, and the maintainer uses it in other nets to *queue* tokens and bundle them
once a separate signal arrives. Redesigning the join gadget to avoid the arc is therefore not
the answer. The arc must be provable.

**Where it stands.** The step relation is already exact: `firingConditions` in
`z3/smt-encoder.ts` enables on `m_p ≥ pre` and sets `m'_p = post` for a consume-all or reset
place, so IC3 and the certificate check treat it correctly. Only the marking equation
(VER-016, `equationPlaces`, hypothesis H1) drops these places.

*Corrected 2026-09-15 by the libpetri session, measured with the prototype:* the dropped row
is **not** what makes `diamond` and `loopOverItems` spurious. Both candidates fire `X_skip`
while `X/hasdata` is marked, which the real net forbids through `X_skip`'s inhibitor on
`hasdata`; the equation sees no guards, so it admits any order of `arm_e_data` and `skip`.
Adding the relaxation row changes nothing there, since neither candidate fires a consume-all
transition. Traps cannot refute an ordering fact either. What refutes it is a guard-aware
inductive inequality, for the join `hasdata ≤ ready_0 + ready_1`, inductive only because
`skip` inhibits on `hasdata` and `start` clears it. Piece 1 below stays as the sound row for
consume-all places; the refinement in piece 2 becomes invariant synthesis against the
*guarded* step relation, with trap constraints as one special case.

**Proposal, in four pieces that compose.**

1. **A sound linear relaxation instead of exclusion.** For a place `p` with consume-all or
   reset consumers `A(p)`, and `r_t` = tokens removed by all firings of `t ∈ A(p)`:

   ```
   m_p = M0_p + Σ_t post(t,p)·n_t − Σ_{t∉A(p)} pre(t,p)·n_t − Σ_{t∈A(p)} r_t
   0 ≤ r_t,   r_t ≥ pre(t,p)·n_t   (each firing removed at least what enabled it)
   r_t ≤ M0_p + Σ_t post(t,p)·n_t   (nothing removed that never arrived)
   m_p ≥ 0
   ```

   Every real run satisfies this, so `unsat` stays a proof, and the row is strictly stronger
   than no row.

2. **Trap refinement on a spurious `sat`** (Esparza, Ledesma-Garza, Majumdar, Meyer, Niksic,
   CAV 2014): find a trap `Q` that is marked initially and empty in the candidate, add
   `Σ_{q∈Q} m_q ≥ 1`, ask again. The trap definition needs one generalisation: a transition
   with a consume-all or reset arc on a place of `Q` counts as consuming from `Q`, so it must
   put a token back into `Q` for `Q` to be a trap.

3. **An exact witness.** On a candidate that survives refinement, search for a firing sequence
   under the real semantics (consume-all, inhibitors, and priority if the caller asks),
   guided by the equation's solution as a distance: directed reachability (Blondin, Haase,
   Offtermatt, TACAS 2021). The candidate's firing counts bound the search. Found means
   violated, with the trace. Not found means the candidate is excluded and refinement resumes,
   or the route falls through to Spacer as today.

4. **A completeness backstop under a firing bound.** Because everything we compile is
   bounded, most nets admit a linear ranking function: weights `a ≥ 0` with
   `a·post(t) − a·pre(t) ≤ −1` for every transition (for a consume-all arc use `pre` as the
   lower bound of what is removed). Farkas gives it or refutes it in one LP. When it exists,
   run length is at most `a·M0`, and bounded model checking to that depth with the exact step
   relation *decides* the property, consume-all included. When none exists the net is reported
   as unbounded and stays unproven, which is the answer we want. (Acyclic workflow nets with
   resets are decidable, PSPACE-complete: Blondin and others, FSTTCS 2023. The bound makes it
   practical.)

**Acceptance.** A test net for the queue-and-bundle pattern: a producer fires up to `N` times
into `q`, a signal `s` arrives once, a bundler `t` has `all(q)` and `one(s)`. Properties: `q`
is empty at every quiescence where `s` has arrived (proven, with a certificate), and `q` is
not empty at quiescence when the signal never comes (violated, with the trace). The `diamond`
and `loopOverItems` nets from n8n-libpetri (fixtures below) must stop returning a spurious
`sat`.

## Ask C — a state-equation phase before IC3

**What.** In `SmtVerifier.verify()`, for `deadlockFree` and unreachability properties, before
the IC3 phase: one QF_LIA query of `stateEquationConditions` (with Ask B's relaxation) and
`encodePropertyViolation`, then trap refinement, then the directed witness search, then
Spacer as today. `unsat` is `proven` with method `state-equation`.

**Certificate.** The Farkas dual of the `unsat` is one linear inequality `a·m ≤ b` that holds
initially, is inductive (a·(post − pre) ≤ 0 on every transition, using the relaxation on
consume-all places) and excludes `Bad`. `z3/certificate-checker.ts` already discharges
exactly this kind of candidate against the unstrengthened step relation (VC1–VC3), so the new
phase's proof is checked the same way as an IC3 proof, and the inequality can be printed as
the reason. That is what n8n-libpetri wants to show a user instead of `unknown`.

**Cost.** Encoding was under 15 ms and z3 under 50 ms on every net in the table above; the
chat bot's proof is roughly four orders of magnitude cheaper than through Spacer.

*Delivered and measured 2026-09-15 on the pre-release build (`SmtVerifier.stateEquationPhase`,
`firingBound`, both default on, VER-018/019).* Through n8n-libpetri's own `verify()` deadlockFree
query, the chat bot proves `proven`, method `state-equation`: no-tools k = 1 in 2.2 s, as-is
k = 1 in 2.4 s, as-is k = 4 in 2.3 s (the 2 s over the 45 ms one-shot is the full route's
linear-bound, P-invariant and semiflow passes running first). The full n8n-libpetri suite is
1,064 of 1,065 against the build; the one flip is `tests/verify/properties.test.ts`'s `switch20`
case, which pinned `unknown` at a 2 s Spacer timeout and now proves through the phase — a good
flip, and the pin is updated when the build releases as 5.2.0, not before.

## Ask D — a terminal-marker cut in the state-class graph (smaller)

When a conditional-sink marker such as `_halt` is on, every transition still enabled in our
nets is an in-flight completion: it has exactly one non-marker input place (`X/running`) and
writes only places the marker excuses (everything that starts an activation inhibits on it).
Both facts are checkable structurally. When they hold, the marker successor of a class needs
no expansion: every quiescent marking reachable from it strands exactly the un-excused places
marked now that are not the input of such a completion, so the verdict for the whole
post-marker subtree is a closed-form evaluation of one marking.

What this buys, precisely: the interleavings of in-flight completions after a halt and their
frozen copies, which is a factor of up to 2^k at budget k. It does not reduce the number of
halt points, which is one per failing node completion times the positions of the other
branches. That product is the value-blind router's, and deadlock-preserving stubborn sets
cannot shrink it either, because each frozen marking is a distinct deadlock the reduction must
keep. It is the honest limit of this ask; the router product is Ask A's business.

*Measured 2026-09-15 by the libpetri session, on 21 fixtures against 5.1.0:* at budget 1 the
cut removes **zero** classes everywhere, since a halt at k = 1 leaves nothing in flight. As
written the write condition also fails on every net (`X/run` writes `X/routed`, which no rest
set excuses and `X_done` drains), so the condition must read "an excused place, or the single
input of another completion"; with that it applies to 15 of 21 nets, and split routing and
agents stay outside. Under `_pause` it never applies. Decision: **on hold** until the budget 2
and 4 numbers are in; built only if it removes a meaningful share of the classes on a net
that truncates, otherwise dropped with this note as the record.

*Budget 2, same session, graphs that close:* classes reachable only through a halt-marked
class are `fanOut` 6 of 307, `partialRequired` 14 of 2,164, `diamond` 1 of 935,
`continueErrorOutput` 1 of 219, `failurePolicy` 1 of 373, and 0 on the other eight; outside
the cut's conditions, for scale, `fanOut4` 96 of 8,872 and `agentTwoTools` 162 of 20,791. At
most 2 % where it applies, and the halt-marked classes are almost all halt points, which the
cut cannot touch. **Dropped 2026-09-15.** The router × halt product is Ask A's, by never
composing the gadgets.

## What n8n-libpetri does on its side

- The composition theorem for Ask A, as an ADR: contracts plus graph conditions (every join
  input has a producer, every `$('Y')` reference is upstream, the graph is acyclic outside
  recognised loop forms) imply proper completion of the composed net.
- A declared loop bound in `executionPolicy`, on the model of `maxToolCalls`, so cycles carry
  a bounded claim.
- Reports render "proven for bound K" and "unproven: unbounded" as distinct rows.

## Reproducing the numbers

Fixtures: `typescript/tests/fixtures/workflows.ts` (`diamond`, `ifBothOutputs`,
`agentTwoTools`, `switch20`, `loopOverItems`), `typescript/tests/verify/support.ts`
(`generateChain(40)`, `generateFanOut(8)`). The chat-bot workflow is not in the repo.

The prototype that produced the one-shot column, unchanged except for the paths (needs a
`node_modules` symlink to `n8n-libpetri/typescript/node_modules` next to it, and `z3` on
`PATH`):

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { flatten, deadlockFree } from 'libpetri/verification';
import { stateEquationConditions, encodePropertyViolation, resolveEnvInjection }
  from '<libpetri>/typescript/src/verification/z3/smt-encoder.js';
import { compile, type WorkflowDescription } from '<n8n-libpetri>/typescript/src/compiler/index.js';
import { markingStateOf } from '<n8n-libpetri>/typescript/src/verify/verify.js';
import { completionSinksOf } from '<n8n-libpetri>/typescript/src/verify/routing/completion.js';
import { diamond } from '<n8n-libpetri>/typescript/tests/fixtures/workflows.js';

function oneShot(wf: WorkflowDescription, budget: number): string {
  const compiled = compile(wf, { budget });
  const state = markingStateOf(compiled.initialMarking(null));
  const { sinks, conditional } = completionSinksOf(compiled.netMap);
  const flat = flatten(compiled.net);
  const m = flat.places.map((_, i) => 'm' + i);
  const n = flat.transitions.map((_, j) => 'n' + j);
  const lines = ['(set-logic QF_LIA)'];
  for (const v of [...m, ...n]) lines.push(`(declare-const ${v} Int)`, `(assert (>= ${v} 0))`);
  for (const c of stateEquationConditions(flat, state, n, m)) lines.push(`(assert ${c})`);
  const cond = conditional.map((c) => ({ marker: c.marker, places: new Set(c.places) }));
  lines.push(`(assert ${encodePropertyViolation(flat, deadlockFree(), m, new Set(sinks), resolveEnvInjection(flat), cond)})`);
  lines.push('(check-sat)', '(get-model)');
  writeFileSync('oneshot.smt2', lines.join('\n') + '\n');
  return execFileSync('z3', ['-smt2', '-T:120', 'oneshot.smt2'], { encoding: 'utf8' });
}
console.log(oneShot(diamond, 1).split('\n')[0]); // sat — spurious today, unsat once Ask B lands
```

## Sources

- Esparza, Ledesma-Garza, Majumdar, Meyer, Niksic. An SMT-based approach to coverability
  analysis. CAV 2014. https://teaching.model.in.tum.de/2021ss/petri/material/cav2014-paper.pdf
- Blondin, Haase, Offtermatt. Directed reachability for infinite-state systems. TACAS 2021.
  https://arxiv.org/pdf/2010.07912
- Blondin, Mazowiecki, Offtermatt. Verifying generalised and structural soundness of workflow
  nets via relaxations. CAV 2022. https://arxiv.org/pdf/2206.02606
- Acyclic Petri and workflow nets with resets. FSTTCS 2023.
  https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.FSTTCS.2023.16
- Amat, Dal Zilio, Le Botlan. Leveraging polyhedral reductions for solving Petri net
  reachability problems. STTT 2023. https://arxiv.org/abs/2302.02686 (not asked for here;
  the next lever for the graph once A–D land)
