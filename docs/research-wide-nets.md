# Proving wide nets: what the literature offers, and what fits this one

Written 2026-09-09, after the measurement in `tasks/todo.md` that put a number on the problem:
`switch20` (22 nodes, 238 places, a wide fan of independent branches) is **still truncated at a
400,000-class cap after 183.6 s and 4.07 GB**, aborts a 12 GB heap at 1,000,000 classes, and is
decided only by the solver, at 351–442 s. Breadth is the one shape where every mechanism this
project has is slow or absent. Depth is not: a 41-node chain enumerates in 0.11 s.

This surveys what the field does about that, filtered against **these** nets rather than Petri
nets in general. The filter matters more than the survey: several famous techniques are ruled
out or complicated by two features of the compiled net — **inhibitor arcs** (halt/pause gating on
every start transition) and a property that is not plain deadlock-freedom but a *conditional*
predicate over quiescent markings, whose rest set widens when `_pause` or `_halt` is marked.

## 0. The one structural fact that decides most of this

**Proper completion is a property of quiescent markings only.** The question is *"does any
reachable marking in which no transition is enabled hold a token outside the rest set?"* A
marking that is not quiescent is irrelevant to it, whatever it holds.

That matters because the classical partial-order reduction results are stated exactly for this
class: a deadlock-preserving reduction preserves *the set of deadlock markings*, not the paths
to them. Our predicate is then evaluated on the preserved markings unchanged. So the strongest
family of breadth-attacking techniques is sound here for the headline property — which is not
obvious, and is the single most useful thing in this document.

It does **not** transfer to the other families. `placeBound` and `mutualExclusion` are properties
of *all* reachable markings, and a deadlock-preserving reduction says nothing about those. Any
reduction has to be enabled per property, not per net.

## 1. Structural reduction

Collapse the net before searching it: fuse a place whose only producer feeds only it into its
consumer, agglomerate transition sequences that cannot interleave observably, delete places no
query mentions. The rules trace to Berthelot; the modern suites are much larger.

**Evidence.** Yann Thierry-Mieg, *Symbolic and Structural Model-Checking*, Fundamenta
Informaticae 183(3–4):319–343, 2021 ([arXiv:2005.12911](https://arxiv.org/abs/2005.12911))
presents **22 structural reduction rules** combined with an SMT over-approximation and a
memory-less random under-approximation, and reports that the combination "was able to win by a
clear margin the model checking contest 2020 for reachability queries as well as deadlock
detection". Its stated complexity argument is the one that matters for us: the techniques "stay
in complexity proportional to the size of the net structure rather than to the state-space size".

Bønneland, Dyhr, Jensen, Johannsen and Srba, *Stubborn Versus Structural Reductions for Petri
Nets*, JLAMP 2019 ([PDF](https://homes.cs.aau.dk/~srba/files/BDJJS:JLAMP:19.pdf)) implements both
in TAPAAL, and finds "that both methods provide significant state space reductions and, even more
importantly, that their combination is indeed beneficial as a further nontrivial state space
reduction can be achieved", solving more MCC'17 reachability queries than LoLA, the previous
winner.

**Fit here: excellent, and probably under-appreciated.** These nets are *machine-generated from a
fixed gadget*, so they are unusually rich in exactly the structure these rules target: every node
contributes intermediate places (`in`/`in_empty`, `routed`, per-output `ok_o`) that exist to
phase the budget refund and are read by no query. A rule set that agglomerates a node's
`start → run → route → done` chain where no other transition competes would shrink the net
before any search, and it helps *both* existing routes — fewer classes to enumerate, fewer
variables and constraints for the solver.

**The catch specific to us.** Reductions must preserve the property, and ours reads places most
rules would happily fuse away (the rest set is most of the net's places). Thierry-Mieg's paper is
explicit that a small *support* — the set of places the property actually mentions — is what
enables reductions: "A small support means more potential reductions, as rules mostly cannot
apply to observed places or their neighborhood." Our support is large by construction. The
reductions available to us are therefore the ones that fuse places *outside* the rest set, and
the honest expectation is a solid constant factor rather than a changed exponent.

## 2. Partial-order reduction (stubborn sets)

Expand only a sufficient subset of enabled transitions at each state, chosen so that what is
omitted cannot change the property. Valmari's stubborn sets are the Petri-net-native
formulation; LoLA is the reference implementation
([Wolf, *Petri Net Model Checking with LoLA 2*, Petri Nets 2018](https://link.springer.com/chapter/10.1007/3-540-44988-4_27)).

**Fit here: the best match for the failing shape, and sound for the headline property.** Breadth
*is* interleaving of independent branches, which is precisely what POR removes, and §0 says the
deadlock-preserving variant preserves what proper completion asks about. The TAPAAL paper above
is the direct precedent for the awkward part: it extends stubborn sets "for the application on
Petri nets with weighted arcs and weighted inhibitor arcs", so our halt/pause gating is not a
blocker — someone has already done that work and proved it correct.

**Caveats to settle before building it.** The reduction must be computed against *our* enabling
rules, which include priorities and inhibitor arcs; a stubborn set computed ignoring priority
would be unsound. And it buys nothing for `placeBound` or `mutualExclusion`, so it is a
per-property route, not a global switch.

## 3. Unfoldings and finite complete prefixes

Represent concurrency directly as a partial order instead of enumerating its interleavings.
McMillan's construction, improved by Esparza, Römer and Vogler
([*An Improvement of McMillan's Unfolding Algorithm*](https://link.springer.com/article/10.1023/A:1014746130920)),
builds a finite complete prefix that "can be much smaller than the state space of the system",
with deadlock detection reading deadlocked markings off the prefix and cut-off events
distinguishing real deadlocks from artifacts of truncation.

**Fit here: theoretically the ideal answer, practically the worst blocked.** For a net whose
difficulty is *only* independent concurrency, the prefix is where the exponential goes away —
this is the technique that most directly targets our exact failure. Two obstacles, both real:

- **Inhibitor arcs are outside the classical theory.** Unfolding extends cleanly to read arcs
  (contextual nets), and inhibitor arcs need further machinery still. Our gadget inhibits on
  `_halt` and `_pause` at every start, so this is not a corner case we could avoid.
- **Deadlock checking on the prefix is NP-complete** even though the prefix is small, so the
  saving is in memory rather than uniformly in time.

Worth keeping on the list precisely because it attacks the exponent, but it is a research project
rather than a feature.

## 4. Symbolic state spaces and saturation

Represent the reachable set as a decision diagram and apply the next-state function with the
saturation strategy (Ciardo et al.; ITS-tools, SMART/Meddly). Saturation is the technique of
record for very large asynchronous state spaces, and Thierry-Mieg's symbolic work above sits in
that lineage.

**Fit here: changes the exponent, at the highest implementation cost.** Decision diagrams handle
inhibitor arcs without special pleading, and a wide net with many independent components is the
case they are designed for. But this is a new engine — a diagram library plus a saturation
schedule — in a TypeScript codebase that today has an explicit graph and a Horn encoder. It is
the right answer for a tool whose primary job is verifying large nets, and probably not the right
next step for this one.

## 5. Symmetry reduction

Quotient the state space by an automorphism group: markings that permute interchangeable
components are one orbit. `tasks/todo.md` already carries this for the agent's per-tool counters,
where the tools are identical gadgets differing only in name.

**Fit here: narrow but cheap where it applies.** `switch20`'s branches are *not* symmetric in
general — different node types, different downstream structure — so this does not solve breadth.
It solves the specific case of repeated identical subnets, which is worth having for agents with
many tools and is not the general answer.

## 6. What we already do, and what the winners add to it

Our SMT route is the same shape as the MCC-winning recipe: reduce deadlock to safety, over-
approximate with a state equation and invariants, let the solver prove unreachability. Thierry-
Mieg's paper describes exactly this reduction — "we consider the invariant I asserting that at
least one transition is enabled … and thus reduce the Deadlock problem to Safety" — and the
constraint families it feeds the solver are the ones we feed it: generalized flows, **trap
constraints**, the state equation, read arc constraints.

Two of those we do not have:

- **Trap constraints.** We compute P-invariants and P-semiflows; we do not add trap constraints,
  though libpetri exposes `findMaximalTrapIn` and `findMinimalSiphons`. Traps are the classic
  strengthening for exactly the case where conservation laws are too weak, and they were the
  missing ingredient in the earlier cliff investigation before the state equation closed it.
- **A guided under-approximation.** The winning recipe pairs the over-approximation with fast
  random sampling to *find* witnesses. That is precisely the direction our surface is weakest in:
  proofs are strong, witness search returns nothing at all on three fixtures that genuinely
  strand. A memory-less random explorer over the compiled net is cheap to write and needs no
  solver.

## 7. Can we design the inhibitors away?

Since inhibitor arcs are what block unfoldings and complicate the rest, the fair question is
whether the compiler needs them. Measured across the whole fixture set (24 workflows, 675
transitions):

| Inhibited place | Arcs | Share |
|---|---:|---:|
| `_halt` | 354 | 63% |
| `_pause` | 158 | 28% |
| `A/outstanding` | 15 | 3% |
| `X/hasdata`, `hasdata_0` | 18 | 3% |
| `A/calls`, `A/rounds` | 10 | 2% |
| `X/ran_0`, `X/tries` | 3 | <1% |

**558 arcs, and 92% of them test one of two shared markers.** 52% of all transitions carry an
inhibitor. So this is not a scattered feature; it is two global gates plus a handful of local
zero-tests.

### The 92% is the easy case

`_halt` and `_pause` are **write-only latches**: measured at k = 1 and k = 4 on three fixtures,
both have many producers and **zero consumers** (`diamond`: `_halt` +6/−0, `_pause` +12/−0).
Nothing ever removes them, so "is it marked" is monotone.

For a place bounded by a compile-time constant, an inhibitor is removable by the classical
complement-place construction: keep a place `p̄` with `M(p) + M(p̄) = k` invariant, and replace
`inhibitor(p)` with a **read arc requiring all k tokens of `p̄`**. Here the bound is the
concurrency budget itself: each activation can produce at most one terminal marker, and once one
is produced no new activation starts, so at most `k` terminal events ever occur. Concretely:

- add `_gate`, seeded with `k` tokens;
- every branch that produces `_halt` or `_pause` also consumes one `_gate`;
- every start / start-unmet / retry-wait transition replaces `inhibitor(_halt), inhibitor(_pause)`
  with a read arc of weight `k` on `_gate`.

"`_gate` holds all `k`" is then exactly "no terminal event has occurred", with **no latency and no
change of semantics** — the disabling happens in the same firing, as the inhibitor does now. At
the default `k = 1` it degenerates to a single-token read arc. It also *adds* a conservation law,
`_gate + terminals = k`, which the solver can use.

The remaining 8% are genuine zero-tests on places the compiler already bounds: `A/outstanding`
and `A/calls` by `maxToolCalls`, `A/rounds` by `maxIterations`, and `hasdata` / `ran` / `tries`
are 1-safe. Each complements the same way with its own constant. **So an inhibitor-free encoding
is available for every inhibitor in the net**, which is the useful half of the answer.

### What it would actually buy — and the part that reframes the question

- **Unfoldings: yes.** Read arcs are contextual nets, which have a developed unfolding theory;
  inhibitor arcs do not. This is the change that moves unfoldings from "blocked" to "available",
  and unfoldings are the technique aimed squarely at breadth.
- **Structural reduction: partly.** Fewer special cases, though TAPAAL's rules already handle
  weighted inhibitor arcs, so this is convenience rather than capability.
- **Partial-order reduction: probably nothing, and the reason matters more than the answer.**

The coupling the inhibitors express is *real*, not an encoding artifact: any node may halt the
execution, and that stops every other start. No encoding removes a semantic dependency. But
neither form couples starts *to each other* — both couple starts to the transitions that produce
a terminal — so this is not what makes `switch20` explode.

**The `_budget` place is the more likely POR blocker.** Every start consumes a token from one
shared place, so at `k = 1` every enabled start conflicts pairwise with every other. Firing one
disables the rest, and the strong stubborn set condition then forces all of them into the
stubborn set, which is precisely the case where the reduction yields nothing. A bounded shared
resource read and written by everything is the classic POR-hostile structure, and this net has
one by design — it is the project's central mechanism. That is an argument rather than a
measurement, and the TAPAAL line has refinements aimed at this exact difficulty (write-up/down
sets, the closure procedure, attractor sets), so it is a question to settle rather than a verdict.

**The reframing**: inhibitors are the *unfolding* blocker; the shared budget place is the
suspected *POR* blocker. They are different obstacles for different techniques, and removing the
first does not address the second.

## Ranked recommendation

1. **Structural reduction on the compiled net.** Cheapest to build, helps both existing routes,
   and these nets are generated from a gadget so the reducible structure is systematic rather
   than incidental. Expect a large constant factor, not a changed exponent, because our property's
   support covers most places. *Cost: moderate — a rule set plus a proof obligation per rule.*
2. **Deadlock-preserving stubborn sets for proper completion only.** The one technique that
   attacks the exponent on the shape that actually fails, sound for our headline property by §0,
   with the inhibitor-arc extension already published and implemented by TAPAAL. **Check §7's
   objection before building it**: every start consumes the one shared `_budget` token, so all
   enabled starts conflict pairwise and the basic stubborn set collapses to "everything". Settle
   that on paper or on a toy net first; it is cheap to check and it decides whether this item is
   first or last. *Cost: moderate to high; the correctness argument must also account for our
   priorities.*
3. **Trap constraints and a random under-approximation in the SMT route.** Not a breadth
   technique, but it is the missing half of the recipe that wins MCC, and the under-approximation
   targets our weakest direction. *Cost: low.*
4. **Saturation over decision diagrams.** The strongest asymptotic answer and the largest build.
   Revisit if wide workflows become the common case rather than the hard case. *Cost: high.*

Unfoldings are deliberately fifth: the best theoretical fit for breadth, blocked by inhibitor
arcs, and a research project rather than an increment.

## The three sharpest open questions

1. **How much do structural reductions actually shrink a compiled workflow net?** Implement three
   or four classical rules, run them on `switch20` and `layers`, and report places, transitions
   and class count before and after. This is a day's work and it decides whether item 1 is a
   constant factor or a rout. It also has a clean falsifier: if our property's support blocks
   most rules, the numbers will say so immediately.
2. **Does the shared `_budget` place defeat partial-order reduction here?** Take a net of `m`
   independent branches, compute a strong stubborn set at the initial marking by hand, and see
   whether it is a proper subset of the enabled starts. If it is not, the classic formulation
   buys nothing on these nets and the question becomes which refinement (write-up/down sets,
   attractor sets) recovers it — or whether the budget place should be encoded differently for
   the verification net. This subsumes the priority question below and should be answered first.
3. **Does a deadlock-preserving stubborn set stay sound under our priority semantics?** The
   published extensions cover weighted and inhibitor arcs; priority is the part we added.
   Concretely: does the reduction preserve the *set* of quiescent markings when enabling depends
   on priority as well as on tokens, and if not, what side condition restores it?
4. **Would a random under-approximation find the witnesses the solver cannot?** `unbalancedJoin`,
   `ifBothOutputs` and `cyclicStranding` all genuinely strand and all return no witness at any
   budget. A memory-less explorer that fires randomly from the initial marking is a few dozen
   lines and needs no solver. If it finds those strandings in milliseconds, the weakest direction
   of this surface closes without touching the prover.

## Provenance

The delegated research agents for this document were cut off by a rate limit before reporting;
this is a direct synthesis from the primary sources cited inline, plus the measurements in
`docs/verification.md` and `tasks/todo.md`. The MCC results pages
([2025](https://mcc.lip6.fr/2025/results.php), [2024](https://mcc.lip6.fr/2024/results.php)) are
the place to check which tools currently dominate; the two papers above are the ones whose
techniques are directly transferable here. Claims about *our* nets are measured; claims about the
literature are cited; the applicability judgements between them are argument, and the open
questions above are how to settle them.
