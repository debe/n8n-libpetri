# ADR 0012: Engine v2 as a second target: model first, seam second

Status: **proposed** (2026-09-25). Nothing here is built. The v2 facts below were read at n8n
master `c88df6f9c7d6341e3e596f86a2e8fdec07b48075`. The v1 facts are at the pin, `n8n@2.41.3`.

## Context

n8n is building a second execution engine: **engine v2**, package `packages/@n8n/engine`, plus
`packages/@n8n/node-engine-compatibility` and `packages/cli/src/modules/engine-v2/`. It ships in
`n8n@2.40.7` and `n8n@2.41.3`, **off by default**. To turn it on, a workflow sets
`settings.engineType: 'v2'` (declared in `packages/workflow/src/interfaces.ts`, and the editor
never sets it), the host sets `N8N_ENABLED_MODULES=engine-v2`, and a separate data-plane
Postgres is configured at `N8N_ENGINE_DATABASE_URL`.

- Only `manual`, `webhook` and `trigger` runs are routed to it (`ROUTED_MODES`,
  `engine-v2-dispatcher.service.ts`).
- Queue mode is refused, and there is no fallback to v1.
- 77 engine commits landed between our old pin `441970b` (2026-09-04) and master on 2026-09-25.
- Its own documentation still calls it "in development".

v2 is a durable step scheduler. Every node activation is a row keyed
`(execution_id, node_id, iteration)`. A `step:settled` message makes `StepSettledHandler` plan
the settled step's direct successors. The plan comes from one pure function,
`decideSuccessors` in `execution/settlement.ts`, together with `decisionKeys`, which names the
rows that function must read. The rule, from that file's own comment:

1. An edge is **live** iff its source step completed and filled the edge's output slot.
2. A step is **decidable** once every step its incoming edges read has settled.
3. Decidable with at least one live input → `queued`. Decidable with none → `skipped`, and the
   skip is itself announced as `step:settled`, so a dead region cascades one hop per event.

Completion is `countExpectedSettledSteps` in `completion.ts`. It compares settled rows with
the rows owed: every node reachable from the trigger, adjusted per batch loop.

What v2 leaves out or does differently from v1, each read in the source:

- Branches run in no fixed order. The converter says this "diverges from v1". `executionOrder`
  is never read.
- A failed step fails the whole execution. `onError: continueRegularOutput` passes items
  through inside the step executor. `continueErrorOutput` is rejected.
- There is **no retry**: `api.types.ts` says "has no retry mechanism".
- **Agents are accepted, and then fail at their first tool call.** The converter roots the
  graph at the fired trigger through `main` connections only (`rootAt`). Sub-nodes such as
  models, tools and memory are only ever the *source* of `ai_*` connections, so they are dropped
  before the connection-type check runs, and the agent becomes an ordinary `v1-node` step. When
  it returns a tool call, `V1StepExecutor` throws `EngineRequestNotSupportedError`
  (`v1-step-executor.ts`), and `continueOnFail` cannot catch it. v2 has no counterpart yet to
  ADR 0008's round. (This corrects the first reading of the converter, which said it rejects
  `ai_tool`: `UnsupportedConnectionTypeError` fires only for an `ai_*` connection leaving a node
  the trigger reaches through `main`.) Sub-workflow and `wait` step types throw
  `UnimplementedError`.
- The only loop is Split In Batches v3 with a literal batch size. A cycle without a batch node
  is rejected (`graph/loops.ts`, `validate-executable-graph.ts`).
- A v1 node runs through `V1StepExecutor` (`node-engine-compatibility`), which calls
  `nodeType.execute` itself. It does **not** go through `WorkflowExecute`, so patches 0001 and
  0002 do not reach it.

`decideSuccessors` is pure, but **it is not injected**. `StepSettledHandler` imports it, and
imports `countExpectedSettledSteps` from `completion.ts` as well. `createEngineRuntime` builds
the handler inline and takes no option that would replace either. The package's `AGENTS.md`
sets the design rule that would make it injectable: "a pure core that decides, with every
effect handed in as an injected interface".

## Decision

### 1. v2 is a second compilation target, not a re-pin

The v1 and v2 rules are different semantics. v1 uses depth-first stack order, R6
partial-fires a stuck join, and runs its retry chain and error output. v2 has none of these.
The compiler therefore gets an **`engineV2` profile**, as an option of the same compiler:

- no ordering priorities;
- no retry or error-output gadgets;
- a whole-execution failure sink;
- the batch loop as the only admitted cycle.

The profile rejects exactly what `V1WorkflowConverter` and `validateExecutableGraph` reject,
each as a `CompileError`. One net still serves execution and verification: the profile changes
what the compiler emits, and nothing builds a second net.

The mapping onto what we already have:

| v2 | net |
|---|---|
| live edge / dead edge | `data` / `empty` token on the edge place (ADR 0002) |
| decidable, ≥ 1 live → queued | the join gadget's all-inputs-arrived, any-data fire (ADR 0003) |
| decidable, none live → skipped, announced | the empty-propagation firing, which forwards `empty` |
| completion count | the terminal marking. It must equal what the net reaches |
| batch loop, terminal iteration | a bounded cycle with the loop slot as the exit test |

### 2. The model and the differential come before any n8n patch

We do not ask n8n for a seam before there is evidence that the net states v2's rule exactly.
The evidence has three parts.

- **A differential against n8n's own function.** `decideSuccessors`, `decisionKeys` and
  `countExpectedSettledSteps` are pure and have no `n8n-workflow` dependency, so a harness under
  `src/conformance/v2/` imports them from the pinned checkout. The harness enumerates settlement
  sequences: seeded interleavings, and every live/dead combination of the outputs. At each step
  it compares the net's fired and skipped set with `toQueue` / `toSkip`, and at the end it
  compares the settled count with `countExpectedSettledSteps`. The corpus is `node-engine-compatibility`'s
  `m1-acceptance.integration.test.ts` workflows, our fixtures, and the 200-template survey
  filtered to what the converter accepts.
- **Verification over v2 nets.** The existing families run under the profile: completion
  reached, no step left undecidable, and the reachable settled set checked against the
  completion count. A disagreement is a finding about either side. Per VER-004, a witness in the
  abstraction is reported as a witness, never as a proof.
- **A stateless planner spike.** v2 re-plans from rows. Reconciliation (CAT-2938, not yet built)
  depends on that, and so does the unique key that makes a duplicate planner a no-op. Our
  scheduler holds a live marking. The spike rebuilds a marking from `StepSummary` rows, in the
  manner of the codec (ADR 0005), and answers from enabledness. If a row set does not determine
  a marking, the net cannot be a v2 planner, and we want to learn that before writing a patch.

### 3. Then the seam, in the shape of 0001/0002

Once §2 is green, two patches against a pinned master SHA. v2 moves too fast for a release tag,
and suspend/resume exists only on master. The patches:

- **0003** extracts a `SettlementPolicy` (`decisionKeys`, `decideSuccessors`,
  `countExpectedSettledSteps`, `validateGraph`) with no behaviour change, and gives
  `StepSettledHandler` the policy as a constructor argument. The `deriveLoops` /
  `loadTerminalIterations` pre-reads move behind it. Input gathering (`gatherInputs` /
  `resolveInputReads` in `StepReadyHandler`) uses the same edge-to-iteration mapping; whether it
  joins the policy is decided in the patch, with a reason.
- **0004** adds `EngineRuntimeOptions.settlementPolicy?` and threads it through
  `createEngineRuntime`. It also passes through `StartExecutionService`'s existing, unused
  `validateGraph` argument.

The neutrality gate runs unchanged: the engine package's tests, `m1-acceptance`, and the
Playwright `engine-v2:e2e` parity project. `verify-patch.sh`'s scope grows to
`packages/@n8n/engine/src`.

### 4. Upstream: lead with the differential, not with a scheduler

- **Contribution terms come first.** Read n8n's CLA, and how the Sustainable Use License
  applies to contributed code, before anything is offered. The CAT-xxxx tickets are internal,
  so the entry points are GitHub discussions and the forum.
- **The first offer is the property test.** "`decideSuccessors` agrees with a formal model, and
  completion equals the reachable settled set", together with any disagreement found. It costs
  n8n nothing, and a model backs it.
- **The seam RFC is framed as the package's own rule applied.** It carries a no-behaviour-change
  proof and follows this project's framing: an alternative scheduler, not a replacement.
- **The v1 asks in `tasks/todo.md` §4b are restated for v2.**
  - An engine-owned counter slot becomes a step-row column or a planner-owned row.
  - Per-node cancellation already has a `cancelled` step status.
  - ADR 0009's `onFailure` is a proposal for the retry model v2 does not yet have. This is the
    strongest contribution candidate.
- **Patches 0001/0002 stay a local integration** unless n8n signals interest in them. n8n's
  investment is in v2.

## Consequences

- Two targets means two semantics under one compiler. The profile boundary has to stay
  explicit: every place where v1 and v2 differ is a named profile decision with a test, never an
  `if` buried in a gadget.
- v2's rule is structurally simpler than v1's: no stack order, no R6, no retries. Its nets should
  be smaller and verify faster. That is a hypothesis, and §2 measures it.
- Until 0003/0004 exist, the net can **model and check** v2 but not **drive** it.
- v2's surface is moving. The drift script (`scripts/check-n8n-drift.sh`) lists engine v2
  commits since the pin, so a change to `settlement.ts` is seen, not stumbled on.

## Evidence

**The reference side of §2 exists: `tasks/spike-v2-settlement.mts` (2026-09-25).** It runs the
event loop `StepSettledHandler` runs, on n8n's own compiled `decideSuccessors`, `decisionKeys`,
`countExpectedSettledSteps`, `deriveLoops`, `exitSourcesInto` and `validateExecutableGraph`,
loaded from the pinned checkout. It uses no database and no queue, and the next event is drawn
at random from every pending `step:ready` and `step:settled`. The v2 core is identical at
`n8n@2.41.3` and master `c88df6f9c7`, so the release pin serves the v2 work too.

Measured on the 200-template corpus plus the 11 testbed workflows, one graph per trigger that
can fire, 20 behaviours × 20 orders each:

| | |
|---|---:|
| (workflow, fired trigger) entries | 310 |
| accepted by converter + `validateExecutableGraph` | 209 (20 with a batch loop) |
| of those, in a workflow with an `ai_tool` connection | 85, which fail at the first tool call |
| randomized runs | 83,600 |
| drained without finishing, finished with a queued step, or settled ≠ expected | **0** |
| failure-free behaviours whose fates differ between orders | **0** |

So on this corpus n8n's settlement rule is confluent and completes, as `settlement.ts` claims.
It is a sampled result, not a proof. That is precisely the gap the formal model in §2 would
close, and it is the property test §4 offers.

What the converter refuses, by kind, over the 101 rejected entries:

- 32: more than one edge into input slot 0 (converging branches). v1 and our net handle this
  pattern (ADR 0003's arm form).
- 29: a cycle without a batch node, or other loop shapes.
- 23: `onError: continueErrorOutput`.
- 9: a Merge mode that needs every input.
- 8: other shapes.

**The net side of §2 answers the question (step 10 of `tasks/v2-profile-plan.md`, 2026-09-25).**
The question: for every row set S that n8n's loop reaches, is `planFromMarking(decodeStepRows(S))`
equal to R(S), n8n's own answer?

`tasks/v2-differential.mts` injects n8n's dist into the reference loop, as the spike does. It
compiles each converted graph under `profile: 'engineV2'` (stage 1, `graphToDescription`) and
runs the net on `PrecompiledNetExecutor`. The net's step outcomes are drawn from the same seeded
function as the reference's, and its actions wait seeded macrotask delays.

Setup:
- the corpus above: 209 entries, all compiled;
- 20 behaviours × 20 orders;
- an empty `[null, null]` batch terminal with chance 0.25;
- `pFail` 0.05 on every fourth behaviour.

Stamp: `n8n@2.41.3` (settlement.js `8b7fe1d317aa`, loop-ledger.js `affbe650919e`, completion.js
`3d3c53f9902c`) and libpetri 7.0.0 from the registry.

| Leg | Compared | Disagreements |
|---|---:|---:|
| (a) planner on decoded rows vs R(S), at every reference state | 972,945 state reports; they are **33,367 distinct row sets**, of which 25,222 have a non-empty R(S). The reports include 210,183 with a `running` row, 82 `cancelled`, 2,788 `failed` and 1,988 with an empty terminal. | **0** (0 `CodecError`s) |
| (b) lockstep net run vs reference run: fates, slots, ends, settled = `countExpectedSettledSteps` | 83,600 pairs: 81,040 failure-free (595,840 steps); 2,560 failed (10,660 steps decided by both) | **0** |
| (c) at every row-set point of a net run: decoded marking = executor marking, planner = libpetri's enabled starts and skips | 836,272 points from 901,968 firings | **0** |

The run took 322 s of wall clock.

So on this corpus the `engineV2` net *is* a v2 planner. At no row set the sampled reference
reached does it plan anything other than what `decideSuccessors` plans, so §2's stop condition is
not met.

This is settlement-level evidence, not a conformance number, and leg (a) rests on sampled
interleavings. The sampled reference never produces a failed batch row, because its seeded
outcome never fails a batch step. Step 12's `settlement` family checks invariants of the net over
all its interleavings, but it never compares the planner with R(S), so it does not close the
sampling gap for the planner question.

**What does close it, on small graphs: `tasks/spike-v2-exhaustive.mts`.** Written by the
adversarial review, it explores n8n's handler loop depth-first through every event order and
every step outcome, driven by n8n's own `decideSuccessors`: every filling of the output slots,
failure, batch failure, all three batch terminals, and up to 4 passes. After a failure, running
steps still settle. At every distinct row set it compares `planFromMarking(decodeStepRows(S))`
with R(S), and also decodes the rows in reverse order.

Reproduced on 2026-09-25 with `npx --prefix typescript tsx tasks/spike-v2-exhaustive.mts 4 1000000 14`, in 51 s:
- 196 graphs, 21 of them with a loop: the golden's graphs plus every accepted corpus entry
  with at most 14 nodes and output arity at most 3;
- 1,816,621 handler states and 123,142 distinct row sets;
- **0 disagreements**, and reversed-order decoding agrees everywhere.

Only 16,493 of the row sets have a non-empty R(S), because the enumeration spends much of its
state space after a failure, where both answers are empty. One graph (`7154.json`) hit the 1M
cap and is covered only up to it. On the graphs it covers, the planner question is answered for
every interleaving and every outcome, not for a sample.

Sensitivity check: with B's back start dropped from a copy of the planner, the same run reports
70 disagreements.

CI replays a recorded slice of this with no `.n8n` (step 11): `tests/fixtures/v2/settlement-golden.json`,
stamped with the pin, the full sha256 of the six dist files, and libpetri. It covers 19 committed
graphs (7 testbed workflows n8n accepts, and the 12 v2 fixture graphs), 664 row sets with n8n's
R(S), and 456 of n8n's runs for the net to reproduce. There were 0 findings at recording. The
`m1-acceptance` workflows are n8n's test suite inside `.n8n/`, not committed here, so the golden
does not hold them.

**The verification families exist (step 12, 2026-09-25).** `verify(…, { profile: 'engineV2' })`
and the CLI's `--profile engineV2` run the `settlement` family over the net's state-class graph.
It checks that a node's start and skip are never co-enabled, that each arrival and each running
place holds at most one token, that nothing is pending at a halt-free rest, that every node
outside a loop is decided exactly once, and that every loop ends exactly once. On the 12 v2
fixture graphs and the 8 accepted v1 fixtures that close, every check is proven over a complete
graph, loops included: a folded loop has finite markings. `switch20` truncates, and all its
checks are `unknown`. v1's `budget` and `retry-bound` are reported "not applicable under
engineV2", never passed.

**The "smaller nets" hypothesis, measured** (`tests/verify/measure-v2.ts`, libpetri 7.0.0 from the
registry):
- Places and transitions: v2 nets have about half the places on every subject.
- State classes against v1 at equal concurrency (budget = node count): v2 is smaller wherever
  v1 closes, and it closes on `chain40` and `wide8`, where v1 truncates at 200,000.
- State classes against v1's default budget 1: the hypothesis is **refuted on 4 of 16 closing
  subjects**, all fan-out or long-chain shapes. `fanOut4` has 2,182 classes against 1,807,
  `chain40` 983 against 407, `wide8` 24,315 against 5,894, and `switchFanOut` 14,294 against
  8,463.

v2 has no budget to serialise concurrent steps, so "smaller" holds for the net and not for its
state space under v1's default. The tables are in the plan's Step 12 entry.

Still open: the converter port (step 13), and an SMT fallback for the `engineV2` families.

