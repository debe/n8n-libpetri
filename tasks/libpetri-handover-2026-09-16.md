# Handover to libpetri — release 5.2.0, then the witness direction

Date: 2026-09-16. From: n8n-libpetri (`/Users/db/repositories/n8n-libpetri`). For: a Claude
session working in `/Users/db/repositories/libpetri/typescript`.

Follow-up to [`libpetri-handover-2026-09-15.md`](libpetri-handover-2026-09-15.md), which asked
for open-net contracts (A), exact consume-all (B), a state-equation phase (C) and a
terminal-marker cut (D). A, B and C are implemented in the libpetri working tree and
unreleased; D was dropped on measurement. This document reports what that build does when
n8n-libpetri drives it, and what is left.

Everything below is measured through n8n-libpetri's own `verify()` against the libpetri working
tree at `f2c559c` + uncommitted changes, built with `npm run build`, symlinked into
`typescript/node_modules/libpetri`. The npm baseline is 5.1.0. Paths in libpetri are under
`src/verification/` unless stated otherwise.

## The headline: the phase does what it claims, and the release is the ask

Proper-completion family, per-check verdicts, 30 s per-query timeout, default 200,000-class cap.

| Net | k | npm 5.1.0 | working tree |
|---|---:|---|---|
| `chain40` | 4 | **0 proven / 42 unknown**, 55 s | **42 proven**, 37 s |
| `chain40` | 8 | **0 proven / 42 unknown**, 68 s | **42 proven**, 53 s |
| `switch20` | 1 | **0 proven / 23 unknown**, 86 s | **23 proven**, 63 s |
| `switch20` | 4 | **0 proven / 23 unknown**, 99 s | **23 proven**, 76 s |
| `switch20` | 8 | **0 proven / 23 unknown**, 99 s | **23 proven**, 76 s |
| `fanOut8` | 4 | 10 proven, 15.5 s | 10 proven, 18.5 s |
| `fanOut12` | 4 | 14 proven, 17.5 s | 14 proven, 18.6 s |
| `agentTwoTools` | 1–8 | 4 proven (graph closes) | 4 proven (graph closes) |
| `diamond` | 1–8 | 12 proven (graph closes) | 12 proven (graph closes) |

Every `unknown` in the baseline column became `proven`. Nothing regressed in verdict.

**Every fallback proof carried method `state-equation`.** Six nets × four budgets, and not one
`bounded-model-check` and not one Spacer proof. VER-019 never fired on our nets; VER-018
answered everything the graph did not close. The gating we were warned about — flat path only,
`searchWithinCounts` inert under environment injection — does not bite on compiled n8n nets.

So the single highest-value action is **cut 5.2.0**. It is the difference between "the verifier
says nothing about this workflow" and "proven", and it is sitting uncommitted.

## Why concurrency was the trigger, and why the phase is the right answer

The compiled net is **invariant in k**. `fanOut8` is 82 places and 63 transitions at k = 1, 2, 4
and 8; `agentTwoTools` 51/50; `switch20` 238/194. The concurrency budget is one integer in the
initial marking vector.

So the state-class graph is exponential in concurrent width while every route whose cost is a
function of `|P| + |T|` is flat. Measured, `fanOut8`: 5,894 classes at k=1, 56,069 at k=2,
truncating at 200,000 from k=3 — at which point, on 5.1.0 with the graph alone, every check
goes `unknown`. With the graph capped to 2,000 so the algebra decides, the working tree proves
the same nets flat in k: `fanOut8` 0.20–0.24 s across k = 1…8, `fanOut12` 0.34–0.44 s,
`switch20` 1.30–1.45 s, `chain40` 4.6–4.9 s.

That last column is a policy change on our side, not an ask — see the end.

## Ask A — the witness direction, now the only weak one left

**What.** A counterexample for a reachability-safety property that the graph would have found,
on a net whose graph does not close.

**Why now.** VER-018 made proof nearly free. That makes the asymmetry total rather than
merely uncomfortable: we can prove almost anything and explain almost nothing. A user whose
workflow *is* broken is the user who most needs an answer, and is the one who gets `unknown`.

**Evidence.** Asking the SMT route alone (`maxClasses: 0`, `smtFallback: 'force'`) on nets whose
graph closes, so the graph verdict is exact and available to diff against:

| Fixture | checks | SMT agrees | SMT downgrades a graph verdict to `unknown` |
|---|---:|---:|---:|
| `linear` | 5 | 5 | 0 |
| `fanOut` | 5 | 5 | 0 |
| `diamond` | 12 | 12 | 0 |
| `unbalancedJoin` | 11 | 4 | **7** |
| `ifBothOutputs` | 14 | 5 | **9** |

The pattern is exact: the two nets that lose checks are the two that genuinely strand. On nets
that hold, the routes agree everywhere. Never a false proof — always a downgrade. This matches
what `docs/verification.md` has recorded since M5: on `ifBothOutputs`, `unbalancedJoin` and
`cyclicStranding`, all of which do strand, *no witness comes back at any budget tried, with or
without the state equation*.

**The lead you already have.** `searchWithinCounts` (`z3/parikh-search.ts:56-58`) returns
`exhausted` immediately on any net with environment injection, so the directed-reachability leg
of VER-018 (Blondin, Haase, Offtermatt, TACAS 2021) never runs on our nets. That looks like the
cheapest place to start.

**Acceptance.** On `unbalancedJoin` and `ifBothOutputs` with `maxClasses: 0`, the whole-net
`deadlockFree` query returns `violated` with a decoded stuck marking, and the per-place rows the
witness strands become findings. A downgrade is acceptable; a false `violated` is not (see
"What we fixed on our side").

## Ask B — `verifyOpenNet` has no scaling evidence at all

VER-022 is the lever that would make k-independence *structural* rather than empirical, and the
only route that survives the SMT refusal ceiling our side enforces (450 flat places, 12 join
inputs — `switch20` is already 238 places). It is implemented and, as far as we can find,
unmeasured: no test varies token count, budget or concurrency and reports cost; VER-022's spec
section carries no timing and no class count; `open-net.test.ts` asserts verdicts and one
class-count equality.

**Ask.** A cost curve for `verifyOpenNet`, against subnet size and against tokens in a budget
place. We can generate the nets if that helps — say the word and we will hand over a corpus of
compiled node gadgets rather than ask you to invent one.

We still owe the composition theorem; `verify-open-net.ts:13-15` is right that it is ours.

## Ask C — surface, all small

- `StateClassGraphOptions` is declared in the emitted `.d.ts` but exported by no index
  (`analysis/index.ts` untouched), so `{ untimed: true }` is passable structurally and
  unnameable.
- The six new `z3/` modules are internal; `open-net/smt-route.ts` reaches them by deep path.
- `verifyOpenNet` returns `inductiveInvariant: null` at both `proven` sites
  (`verify-open-net.ts:87`, `:101`) even when its sub-queries produced certificates.
- A count clause with `min === 0 && max === Infinity` is skipped entirely on the SMT route
  (`smt-route.ts:128`).

## A negative result, so nobody spends it twice

**The untimed state-class graph buys nothing on our nets.** `StateClassGraph.build(…, { untimed:
true })` against the timed build, same net and same budget: **1.0× on every net at every k** —
`fanOut4`, `fanOut8`, `agentTwoTools` and `partialRequired`, k = 1, 2, 3, 4, 8, identical class
counts in every one of the twenty pairs, and wall times within noise of each other. The blowup
is genuinely distinct discrete markings, not clock domains.

This also caps what partial-order reduction could give here, and for the same reason Ask D was
dropped: `fanOut8` at k=2 already has 19,205 *distinct quiescent* markings, and a
deadlock-preserving reduction must keep every one of them.

## What we fixed on our side, because it was ours

Widening `unbalancedJoin` with four independent branches produces a net that both strands and
truncates. At a 2,000-class cap our verifier reported **seven** violations where the graph,
closing at 12,679 classes, reports **four** — including `Trigger.0 -> W0.0`, which the complete
graph *proves*. A false `violated`.

Not libpetri's. The whole-net verdict was correct (`M/in0_e0`, role `edge-data`, is unexcused
under `_pause` and really does strand). Our per-place attribution asked "is this place marked in
the witness?" when it had to ask "is it marked **and** unexcused?" — the same VER-014 widening
the whole-net verdict was judged with. `W0/in` has role `in-data`, which `PAUSE_REST_ROLES`
excuses because mode `pause` writes that entry back onto `nodeExecutionStack` (ADR 0005).

Fixed in `src/verify/routing/completion.ts` (`witnessMarks` → `witnessStrands`), pinned by a
regression case in `tests/verify/smt-fallback-violation.test.ts`. After the fix every remaining
route disagreement is a downgrade to `unknown`, never a contradiction. Suite 1,067 of 1,067.

It is worth one line of yours, though: `strandedPlaces(m, sinkPlaces, conditional)`, newly
exported from `rest-set.ts`, computes exactly this predicate. Had it been in 5.1.0 we would have
called it instead of hand-rolling the test. Keep it exported.

## Still ours, not yours

- The composition theorem for VER-022, as an ADR.
- The graph's class cap is a constant (`state-space/cap.ts`), so at k ≥ 3 on a wide net we spend
  13–19 s enumerating into a guaranteed truncation before asking a question the algebra answers
  in a fraction of a second (`fanOut8`, cap 2,000, working tree: 0.20 s at k=4). It should be a
  prediction from concurrent width × k, or the routes should race.
  **Blocked on Ask A**: capping low moves checks onto the route that cannot produce witnesses,
  so until that lands a low cap trades findings for speed.
- Reports render "proven for bound K" and "unproven: unbounded" as distinct rows.

## Reproducing the numbers

Fixtures: `typescript/tests/fixtures/workflows.ts` (`diamond`, `ifBothOutputs`, `agentTwoTools`,
`switch20`, `partialRequired`), `typescript/tests/verify/support.ts` (`generateChain(40)`,
`generateFanOut(n)`, `unbalancedJoin`, `cyclicStranding`). The wide-and-violated net is
`unbalancedJoin` plus *n* `set` nodes wired from the trigger and nowhere else.

Link the working tree rather than installing it, and restore afterwards — the version string is
still `5.1.0`, so an accidental publish of the link is invisible:

```bash
cd typescript
mv node_modules/libpetri node_modules/.libpetri-npm-backup
ln -s /Users/db/repositories/libpetri/typescript node_modules/libpetri
# ... measure ...
rm node_modules/libpetri && mv node_modules/.libpetri-npm-backup node_modules/libpetri
```

Confirm the link took before believing any number:

```js
import { SmtVerifier } from 'libpetri/verification';
typeof new SmtVerifier().stateEquationPhase === 'function';  // false ⇒ still on npm 5.1.0
```

`verify()`'s `check.query.route` and `check.query.method` are what distinguish
`state-class-graph` from `smt:state-equation`, `smt:bounded-model-check` and `smt:IC3/PDR`.
Reading only verdicts hides which phase answered.

## Sources

Unchanged from the 2026-09-15 handover. The one still unclaimed:

- Amat, Dal Zilio, Le Botlan. Leveraging polyhedral reductions for solving Petri net
  reachability problems. STTT 2023. https://arxiv.org/abs/2302.02686 — the only lever in the
  reading that attacks the discrete marking product itself. Given the state-equation phase, it
  is a "later", not a "now".
