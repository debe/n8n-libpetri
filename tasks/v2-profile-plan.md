# Plan: engineV2 compile profile and stateless planner

Synthesized on 2026-09-25 by a design workflow: four codebase readers, three independent designs (minimal delta, semantics first, evidence first) and a judge who checked the disputed claims against the code. It implements ADR 0012 §2. The judge's text follows unchanged. Deviations made during implementation are recorded at the end.

## Claims checked against the code (no files edited)

Where the three plans disagreed, I read the code at `.n8n` n8n@2.41.3 and in `typescript/`:

- **`all()` needs at least one token.** In libpetri 7.0.0 (registry install, not linked), `requiredCount({type:'all'})` returns 1. So `X_start` taking `all(X/live)` and `X_skip` taking `inhibitor(X/live)` are never enabled together. The semantics plan's open risk is closed.
- **`waiting` is not a v2 step status at 2.41.3.** `STEP_STATUSES` is queued, running, completed, failed, skipped and cancelled. The semantics and evidence plans map `waiting`; the decoder should refuse it instead.
- **A batch step has three terminal shapes.** `runBatchStep` returns `[null, slice]` for a normal pass, `[acc, null]` when the loop ends with results, and `[null, null]` when it ends with nothing accumulated. The spike's `outcome()` never produces `[null, null]`.
- **The trigger has no step to run.** `ExecutionStartHandler` writes the trigger's row as `completed` at birth. It cannot fail.
- **After any failure, nothing more is planned.** `StepSettledHandler` stops when the settled row failed, and also when any row has failed (`hasFailedSteps`), before planning. `cancelQueuedSteps` cancels only queued rows, so running steps still finish.
- **Only two Merge cases are refused.** `assertSupportedMergeMode` rejects mode `chooseBranch`, and a mode written as an expression at typeVersion ≥ 2. The minimal plan's `requiredInputsOf(shape) !== null` is the wrong test.
- **Splicing out disabled nodes can leave a node that nothing reaches.** Only edges into input slot 0 are joined. A node reached only through slot 1 of a disabled node stays in the graph with no incoming edge. `countExpectedSettledSteps` counts only the trigger's descendants, so that node never gets a row. None of the three plans handles this.
- **Our loop test fixture has the outputs in the wrong order.** `tests/fixtures/workflows.ts` `SHAPES.loop` has `outputNames: ['loop','done']`. n8n has done = 0 and loop = 1 (`loop-ledger.ts`, and our own `verify/workflow-json/shapes.ts`). The minimal plan is right about this.
- **ADR 0002's chain40 figure went down, not up.** It fell from 1,967 to 407 classes, so always forwarding skips moves it back toward 1,967. The minimal plan has the direction right; the evidence plan states it backwards.
- **A single `and` of k `xor`s blows up.** It flattens to 2^k branches (`SPLIT_ROUTING_ABOVE = 3`, IO-016). The semantics gadget's `X_run` is exactly that shape, and the plan does not split it.
- **`NodeGadget` has 36 consumer files outside `compiler/gadget`**, across the codec, the scheduler and `verify/invariants.ts`. `transitions.done: string` is required on every node. The semantics plan does not address this.
- **`buildNodeGadget` (`compiler/gadget.ts:134`) is the one place to switch** between the v1 gadget and a v2 one.

## Scores

| Plan | Matches decideSuccessors (rules 1–5) | CLAUDE.md hard rules | Feasibility / size | Testability (CI vs local) | Serves the stateless planner | Overall |
|---|---|---|---|---|---|---|
| minimal | 6 | 7 | 6 | 8 | 6 | **6.5** |
| semantics | 9 | 8 | 6 | 8 | 9 | **8.0** |
| evidence | 7 | 7 | 6 | 9 | 7 | **7.2** |

- **minimal (6.5).**
  - Strengths: it stages the work well, stamps goldens with the dist hashes, and gets the slot order right.
  - Weaknesses:
    - It reuses the v1 gadget with 10 flags spread over about 15 files, which risks v1 byte identity.
    - It keeps `_budget` and `idle` as gates v2 does not have.
    - Its Merge refusal predicate is wrong.
    - Its state-equation decoder ignores that `all()` consumes a count fixed only at firing time.
- **semantics (8.0, the winner).**
  - Strengths:
    - The gadget is rules 1–3 directly: every edge arrived, and at least one live.
    - The batch branches match `runBatchStep` and `isPastLoopEnd`.
    - There are no hidden counters, and v1 stays untouched behind one switch.
  - Weaknesses:
    - Routing blows up to 2^k branches.
    - A node with no incoming edge gets a skip that fires forever.
    - It maps a `waiting` status that does not exist.
    - It ignores the `NodeGadget` typing ripple.
    - Its decoder hand-ports `targetKey` instead of letting the net decide.
- **evidence (7.2).**
  - Strengths:
    - Its section 0 is the best statement of what the planner needs.
    - Its reference answer R(S) is correct, including ∅ after a failure.
    - The acceptance leg compares node and edge sets, including `isBackEdge`.
    - `skipIf(dist)` is a sensible way to split local and CI.
  - Weaknesses: it stays on the v1 gadget with its silent closure, and it has the `waiting` and chain40 errors.

## Decisions

1. **Profile option.** Add `CompileOptions.profile?: 'v1' | 'engineV2'`, defaulting to `'v1'`, and the same field on `AnalysisOptions` and `WorkflowAnalysis`. Add `profile` to `structuralHash` and bump `v` from 13 to 14.
   - Reason: one compiler and one net per target, as ADR 0012 §1 decides.
   - v1 nets must stay byte-identical. A fingerprint recorded at HEAD proves it.
2. **One switch point.** `buildNodeGadget` sends a node to `buildSettlementGadget` in `compiler/gadget/settlement/` when `analysis.profile === 'engineV2'`. No v1 gadget file changes, and no priority call site changes.
   - Reason: ADR 0012 Consequences say the profile boundary must be a named decision, never an `if` buried in a gadget. With one switch, a v1 regression cannot happen by construction.
3. **The settlement gadget.** All tokens are unit tokens. Data stays in v2's rows, because v2's planner reads only `StepSummary` flags.
   - Places:
     - `e{id}/arrived` for each edge, as a host place created in `compile/edge-places.ts`;
     - `X/live` for each node, as a host place, since producers write it;
     - `X/running` for each node;
     - the markers `X/done` and `X/skipped`, for nodes outside loops only.
   - Transitions:
     - `X_start`: `one(e/arrived)` for every incoming edge, plus `all(X/live)`, with `inhibitor(_halt)`. Out: `X/running`.
     - `X_skip`: `one(e/arrived)` for every incoming edge, with `inhibitor(X/live)` and `inhibitor(_halt)`. Out: `and(f/arrived for every out-edge f, X/skipped)`.
     - `X_run`: `one(X/running)`. Out:

       ```
       xor(_halt, and_o xor(and(f/arrived, f.to/live for f ∈ out(o)), and(f/arrived for f ∈ out(o))))
       ```

       plus `X/done` for a node outside a loop.
   - This is rules 1–3 exactly:
     - a live edge is `arrived` plus `live`;
     - a node is decidable when every `arrived` is marked;
     - it is queued when `live` holds at least one token.
   - Every priority is 0, and there are no `_budget`, `_pause`, `idle`, arm, retry, chain or agent transitions.
4. **Split routing above three outputs.** For more than `SPLIT_ROUTING_ABOVE` connected outputs:
   - `X_run` success writes `X/ok_o` for every output;
   - `X_route_o` takes `one(X/ok_o)` and writes the per-output `xor(live, dead)`.
   - Reason: the IO-016 flattening is 2^k (a 10-output Switch gives 1,028 branches). Each `X_route_o` is the only consumer of its place, so replay stays confluent.
5. **The batch node.** A batch node is `type === 'n8n-nodes-base.splitInBatches' && typeVersion === 3`, which is v2's `type: 'batch'`. `loopNode` alone does not identify it. Slots follow n8n's `DONE_SLOT = 0` and `LOOP_SLOT = 1`.
   - Transitions: `B_start_entry` and `B_skip_entry` on `E/arrived`, and `B_start_back` and `B_skip_back` on `K/arrived`, all sharing `B/live`.
   - `B_run` Out is `xor(_halt, loop, doneData, doneEmpty)`:

     | Branch | Writes | v2 meaning |
     |---|---|---|
     | `loop` | loop-slot edges: arrived and live | a normal pass |
     | `doneData` | exit edges: arrived and live, plus `L/ended` | terminal, done slot filled |
     | `doneEmpty` | exit edges: arrived only, plus `L/ended` | terminal, `[null, null]` |

   - `B_skip_*` writes the exit edges' arrived and `L/ended`.
   - Reason: this follows `batchStepDecides` (a step decides one side only), `isTerminalStep` and `runBatchStep`. A terminal firing writes nothing into the body, which is `isPastLoopEnd`.
   - v2 tests use the real shape `['done','loop']`, never the fixture `SHAPES.loop`.
6. **Loops are folded, not unrolled.** Loop members carry no markers.
   - The iteration of any node is its number of existing rows. That is 0 outside a loop, the pass p for a member, and the next pass for B.
   - Reason: `validateLoops` guarantees one back edge, one entry, no exit from mid-body and no nesting. So pass p settles completely before B at p+1 is decided, and at most one step per node is in flight.
7. **The trigger is an ordinary node.** It has a seeded synthetic `T/in`, and its `X_run` has a success branch only, with no halt branch.
   - Reason: `ExecutionStartHandler` records it `completed` at birth. Its output slots still go through the live/dead `xor`, because `triggerOutputs` can leave slots empty.
8. **Failure.** Every other `X_run` has the halt branch. Close-function errors, `EngineRequestNotSupportedError` and `UnsupportedNodeTypeError` all get past `continueOnFail`. `continueRegularOutput` is an ordinary success.
   - `_halt` inhibits only start and skip, so an `X_run` already in flight still fires, as running steps do in v2.
   - "Queued but not yet running is cancelled" is not modelled. It is recorded in `docs/divergences.md`.
9. **The compiled node set** is the trigger plus its descendants in the converted graph.
   - Any other node with no incoming edge raises `InternalCompilerError`. Such a node would get an `X_skip` whose only arcs are inhibitors, and it would fire forever.
   - Reason: this is the orphan that disabled-node splicing produces (see the checks above).
10. **Two stages of input.**
    - Stage 1 compiles from n8n's own converted `WorkflowGraph` through `graphToDescription`. That is exact on the 209 accepted entries and needs no port.
    - Stage 2 ports `rootAt`, disabled-node splicing, `markBackEdges`, `validateLoops` and `validateExecutableGraph`.
    - Reason: the planner question does not depend on the port, and the port is then measured by an acceptance leg rather than trusted.
11. **Refusals mirror the converter's predicates literally.** For example, Merge is refused on `type === merge` with mode `'chooseBranch'`, or with a mode starting `=` at typeVersion ≥ 2.
    - `requiredInputs`, `retryOnFail`, `executionPolicy`, references and tools are ignored under the profile, each with a diagnostic.
    - This needs three new `NodeDescription` fields: `mergeMode`, `batch: {typeVersion, batchSize: number | 'expression', optionsExpression, reset}` and `aiOutputs`.
12. **The decoder replays the rows through the net (guided replay).** It does not use the closed formula or the state equation.
    - It repeatedly applies any unapplied row whose start or skip is enabled, taking the branch the row fixes. Rows of one node are applied in iteration order. Halt deposits from failed rows are applied last. Rows left over are a `CodecError`.
    - Reason: `all(X/live)` consumes a count that is fixed only at firing time. Replay also makes the net itself detect an inconsistent row set, instead of a port of `classifyEdge` detecting it.
    - Uniqueness is tested by replaying in random orders.
13. **Planner and reference answer.**
    - The planner is the set of enabled starts and skips at the decoded marking, keyed `(node, rowCount(node))`. `_halt` makes the answer ∅ through the inhibitors, with no special case.
    - The reference is R(S): ∅ if any row failed; otherwise the union of `decideSuccessors(r, S, terminalIterations(S))` over the completed and skipped rows r. `terminalIterations` comes from each batch node's latest row, as the spike's `latestTerminal` computes it.
14. **Typing of `NodeGadget` and its consumers.**
    - A new `SettlementGadget` type goes in `types/netmap.ts`, served by `NetMap.settlement(name)`.
    - The v1 accessors throw `InternalCompilerError` on an engineV2 net.
    - `PetriScheduler`, `encodeExecutionData`, `decodeExecutionData`, `scheduler/deposits.ts` and the v1 families in `verify/invariants.ts` check the profile at entry.
    - Reason: 36 consumer files are v1-shaped. Faking `transitions.done` would put wrong data into all of them.
15. **The reference is injected, not imported.** `src/conformance/v2/reference.ts` takes a `SettlementReference` record: `decideSuccessors`, `decisionKeys`, `countExpectedSettledSteps`, `deriveLoops`, `isTerminalStep`, `exitSourcesInto`, `stepKeyId`. `src/` never imports `.n8n`; only the `tasks/` scripts load the dist.
16. **Pins and reporting.**
    - Goldens are stamped with `n8n@2.41.3`, the sha256 of the dist files `settlement.js`, `iteration-mapping.js`, `completion.js`, `loop-ledger.js`, `loops.js` and `v1-workflow-converter.js`, and the libpetri source (registry 7.0.0).
    - Results are reported as settlement-level evidence, never as conformance numbers.
17. **Interleavings.**
    - In the lockstep runs, the binder's `X_run` action awaits a seeded number of macrotask ticks, which gives real interleavings.
    - All interleavings of the abstraction are covered by the state-class graph (Step 11), not by sampling.
18. **Verification.** New `verify/families/v2-settlement.ts`. The v1 `budget` and `retry-bound` families report "not applicable under engineV2" explicitly, never a silent pass. A witness stays a witness (VER-004).

## Implementation steps

1. **Fingerprint v1 before anything changes.**
   - Files: `tests/compiler/v1-identity.test.ts`, and `tests/fixtures/v1-fingerprint.json`, generated at HEAD.
   - Content: for every fixture in `tests/fixtures/workflows.ts` and every committed workflow, the place and transition names, arcs and `Out` shapes.
   - Done when the test is green at HEAD and committed.
2. **Profile plumbing.**
   - Files: `compiler/types/output.ts` (`CompileOptions.profile`, and `CompileProfile` exported from `compiler/index.ts`), `graph.ts`, `types/analysis.ts`, `compile/options.ts` `analysisOf`, and `hash.ts` (v14 plus `profile`).
   - `analysisOf` refuses a precomputed analysis with a different profile, and `budget` or `maxAgent*` under engineV2, all as `invalid-options`.
   - Tests: `tests/compiler/v2/options.test.ts`.
   - Done when the fingerprint is unchanged and only the pinned hashes move.
3. **Graph input (stage 1).**
   - `src/conformance/v2/graph.ts`:
     - `graphToDescription(graph: V2Graph): {description: WorkflowDescription, startNode: string}`;
     - local `V2Graph` and `V2Edge` types (with `isBackEdge`), so there is no `.n8n` import.
   - Batch nodes become splitInBatches v3 with outputs `['done','loop']` and a literal `batch.batchSize`. Other nodes get output count = max `outputIndex` + 1.
   - Tests: a hand-written graph round-trips.
4. **v2 analysis.**
   - `compiler/analysis/engine-v2/loops.ts` `deriveV2Loops`: SCC per batch node, and the edge classes plain, entry, intra, back and exit, ported from `classifyEdge`.
   - `compiler/analysis/engine-v2/shape.ts` `checkV2Shape`: the `validateLoops` and `validateExecutableGraph` refusals, as new `CompileErrorCode`s in `errors.ts`:

     | Code | Refuses |
     |---|---|
     | `v2-trigger-count` | other than exactly one trigger |
     | `v2-unbatched-cycle` | a cycle with no batch node |
     | `v2-loop-shape` | a `validateLoops` rule broken; the message names which |
     | `v2-converging-input` | more than one non-back edge into one slot |
     | `v2-unreachable-feeder` | an edge from a node the trigger cannot reach |

   - Under the profile, `analyse()` sets `reachable` to the trigger plus its descendants. It skips references, dead inputs, skip observers, tools, depth, k-safety, retry and failure policy, and asserts decision 9.
   - Tests:
     - `tests/compiler/v2/loops.test.ts`: our back edges equal n8n's `isBackEdge` on graphs written by hand;
     - `tests/compiler/v2/refusals.test.ts`: one case per code, each citing its n8n throw site.
5. **Settlement gadget, nodes outside loops.**
   - Files: `compiler/gadget/settlement/{places.ts,node.ts,routing.ts,index.ts}` with `buildSettlementGadget(ctx)`; the switch in `gadget.ts` `buildNodeGadget`; `v2EdgePlaces` in `compile/edge-places.ts`; `names.ts` additions; NetMap place roles `arrived`, `live` and `ended`.
   - Split routing above 3 outputs (decision 4). The trigger has a success-only Out (decision 7).
   - Tests:
     - `tests/compiler/v2/structure.test.ts`: every `Out` is non-null, every priority is 0, there is no `_budget` or `_pause`, NetMap covers everything, and a Switch with more than 3 outputs splits;
     - `tests/compiler/v2/settlement.test.ts`: diamond, 3-input Merge, switch fan-out, chain. Every combination of filled slots is run on the executor and compared with a table written from `settlement.ts` rules 2–4.
6. **Batch gadget.**
   - `compiler/gadget/settlement/batch.ts`, as in decision 5.
   - Tests: `tests/compiler/v2/batch-loop.test.ts`:
     - 0 to 3 passes;
     - `[null,null]` terminal;
     - dead entry;
     - dead back edge in the middle of the list (terminal skip, exits dead);
     - an exit into a Merge that also has a plain edge;
     - two loops in sequence (an edge that is both an exit and an entry).
7. **Typing boundary.**
   - `SettlementGadget` and `NetMap.settlement()`; v1 accessors throw on an engineV2 net; profile checks at the entry of `PetriScheduler`, `codec/encode.ts`, `codec/decode.ts`, `scheduler/deposits.ts` and `verify/invariants.ts`.
   - Tests: each of these refuses an engineV2 compiled workflow with a named error.
   - Done when `npm run check` is clean and the fingerprint is unchanged.
8. **Decoder and planner.**
   - `src/codec/v2/step-rows.ts` `decodeStepRows(compiled, rows: StepRow[]): Map<Place, Token[]>`. It uses guided replay and raises `CodecError` for:
     - an unknown status;
     - a gap in iterations;
     - a row that is not enabled;
     - a batch row with `[true,true]`;
     - a member row at a terminal pass;
     - a cancelled row with no failed row.
   - `src/codec/v2/plan.ts` `planFromMarking(compiled, marking): {toQueue: StepKey[]; toSkip: StepKey[]}`. It checks enabledness by hand with `requiredCount`, reads and inhibitors.
   - Tests: `tests/codec/v2-step-rows.test.ts`:
     - for every prefix of an executor trace, decoding its rows gives the executor's marking;
     - 20 random replay orders give the same marking;
     - the `CodecError` cases;
     - the hand-written enabledness check equals `buildStateClassGraph(net, state, 1).initialClass.enabledTransitions`.
9. **Reference module.**
   - Move `hash`, `rng`, `outcome`, `simulate` and `latestTerminal` from `tasks/spike-v2-settlement.mts` into `src/conformance/v2/reference.ts`. It takes the injected `SettlementReference` and gets an `onState(rows)` hook.
   - The spike imports the module.
   - Done when the spike reprints exactly 310 / 209 / 83,600 / 0 / 0.
   - Then add a seeded `[null,null]` terminal to the batch `outcome()` and record the new numbers.
10. **Local differential.**
    - Files:
      - `src/conformance/v2/binder.ts` `v2Actions(seed)`: `X_run` draws `outcome(node, rowCount, seed)` after a seeded tick delay;
      - `src/conformance/v2/net-run.ts` `runV2(compiled, seed)` on `PrecompiledNetExecutor`, turning firings into rows;
      - `tasks/v2-differential.mts`.
    - Three legs:
      - (a) at every `onState` state: `planFromMarking(decodeStepRows(S))` equals R(S);
      - (b) lockstep: the multiset of fates equals the reference's, and settled equals `countExpectedSettledSteps`, compared up to the first failure;
      - (c) after every net firing, the planner on the trace's rows equals the net's next enabled set of starts and skips.
    - Done when there are 0 disagreements on the 209 accepted entries, or every disagreement is listed.
11. **Goldens for CI.**
    - `tasks/record-v2-golden.mts` writes `tests/fixtures/v2/settlement-golden.json` from committed workflows only (`scripts/testbed/workflows`, our fixtures, the m1-acceptance workflows). It holds the converted graph, the seed, per-state `{rows, R(S)}`, the fates and the expected count, plus the decision 16 stamp. It refuses to overwrite when the stamp differs.
    - Replayed by `tests/conformance/v2-planner-golden.test.ts`, with no `.n8n` needed.
12. **Verification families.**
    - `verify/families/v2-settlement.ts`:
      - start and skip are mutually exclusive, per node and for B's entry and back pairs;
      - `arrived` ≤ 1 and `running` ≤ 1;
      - a quiescent class without `_halt` has no `arrived`, `live` or `running` tokens left;
      - done + skipped = 1 for every node outside a loop;
      - `L/ended` is marked at quiescence.
    - `VerifyOptions.profile`, `verify/verify.ts:166`, and a `--profile engineV2` flag in `verify/cli.ts`.
    - Measure class counts against v1 on the fixtures (ADR 0012's hypothesis).
    - Tests: `tests/verify/v2-families.test.ts`, behind the z3 gate.
13. **Converter port (stage 2).**
    - Files:
      - `compiler/analysis/engine-v2/root.ts`: `rootAtTrigger`, `spliceDisabled` (slot-0 joins) and `dedupeEdges`;
      - `compiler/analysis/engine-v2/refusals.ts`: `V2_REFUSALS`, mapping each n8n error class to our code;
      - the new `NodeDescription` fields, filled in `n8n/adapter/shape.ts` and `verify/workflow-json/shapes.ts`;
      - `tasks/v2-acceptance.mts`.
    - The acceptance script checks three things:
      - the verdicts agree on all 310 entries;
      - when both sides accept, the node and edge sets are equal, `isBackEdge` included;
      - a drift guard lists every `throw new` site in the converter and validator and compares it with `V2_REFUSALS`.
    - Done when all 310 verdicts match.
14. **Documents.**
    - `docs/divergences.md` gets a new "engine v2 target" section:
      - queued rows that v2 cancels still run in the net;
      - the `$('Y')` race is not modelled;
      - agents halt at their first tool call;
      - wait and sub-workflow steps halt.
    - The ADR 0012 Evidence section gets the Step 10 and Step 12 results, and `tasks/todo.md` is updated.

## Deferred

- **An `X_cancel` transition and cancelled-row semantics beyond decoding.** v2 cancels only after a failure, and every comparison stops at the first failure.
- **Nested loops and several back edges.** v2 rejects both (`UnimplementedError`). Supporting them would need an iteration colour.
- **Agent tool rounds.** v2 fails an agent at its first tool call, which is the halt branch here. An ADR 0008-style round waits until v2 has one.
- **Seam patches 0003 and 0004, and driving v2 from the net.** ADR 0012 §3 puts them after §2 is green.
- **Data-carrying tokens.** v2 gathers node inputs from its own rows, so the planner never needs values.
- **An exact count of steps per loop.** Termination depends on the data, so only the linear form (`terminal + 1 + terminal · (|members| − 1)`) is stated, on bounded runs.
- **Skip-forwarding reduction for v2.** v2's rule announces every skip, so being faithful comes before any state-space saving.

## Falsifiers

- `planFromMarking(decodeStepRows(S))` differs from R(S) on any state the reference reaches. The net is then not a v2 planner, which is the ADR 0012 §2 stop condition.
- A consistent reference row set leaves rows unapplied in replay, or two replay orders give different markings. Rows then do not determine a marking.
- In the lockstep runs, the fate multiset differs from the reference's, or settled differs from `countExpectedSettledSteps`.
- The state-class graph finds any of:
  - `X_start` and `X_skip` enabled together;
  - `arrived` above 1, or `running` above 1;
  - a quiescent class without `_halt` that still holds `arrived`, `live` or `running` tokens.
- A reference run has two steps of one node in flight at once. Folding the loop is then wrong and needs an iteration colour.
- A reference row does not match its branch: a batch row with `[true,true]`, or a member row at a pass whose batch step is terminal.
- After Step 13, the acceptance leg finds a disagreement, or the drift guard finds a new throw site.
- The v1 fingerprint changes at any step.
- v2 nets have more state classes than v1 on the acyclic fixtures. That refutes ADR 0012's "smaller nets" hypothesis, not this design, and is reported as such.

Key paths:
- `/Users/db/repositories/n8n-libpetri/typescript/src/compiler/gadget.ts`
- `/Users/db/repositories/n8n-libpetri/typescript/src/compiler/compile/edge-places.ts`
- `/Users/db/repositories/n8n-libpetri/typescript/src/compiler/types/output.ts`
- `/Users/db/repositories/n8n-libpetri/typescript/src/compiler/hash.ts`
- `/Users/db/repositories/n8n-libpetri/typescript/src/compiler/errors.ts`
- `/Users/db/repositories/n8n-libpetri/typescript/src/scheduler/deposits.ts`
- `/Users/db/repositories/n8n-libpetri/typescript/tests/fixtures/workflows.ts`
- `/Users/db/repositories/n8n-libpetri/tasks/spike-v2-settlement.mts`
- `/Users/db/repositories/n8n-libpetri/.n8n/packages/@n8n/engine/src/execution/settlement.ts`
- `/Users/db/repositories/n8n-libpetri/.n8n/packages/@n8n/engine/src/execution/batch-step.ts`
- `/Users/db/repositories/n8n-libpetri/.n8n/packages/@n8n/engine/src/execution/step-settled-handler.ts`
- `/Users/db/repositories/n8n-libpetri/.n8n/packages/@n8n/node-engine-compatibility/src/v1-workflow-converter.ts`

## Deviations during implementation

- **Step 2.** `CompileProfile` is declared in `compiler/types/analysis.ts`, not `types/output.ts`: `WorkflowAnalysis.profile` needs it, and `analysis.ts` does not import `output.ts`. It is still exported from `compiler/index.ts`. The profile is also validated at run time (`profileOf` in `analysis/validate.ts`), so an unknown value is `invalid-options` rather than a silent v1 compile, and `analyse()` refuses `maxAgent*` under engineV2 itself, not only `analysisOf`. Under engineV2 any explicit `budget` is refused, `budget: 1` included, before the v1 `invalid-budget` check. No test pinned a hash literal, so the v13 → v14 bump moved no expectation.
- **Step 3.** `NodeDescription.batch` is `{ batchSize: number | 'expression' }` only (`BatchDescription` in `compiler/types/input.ts`). Decision 11's `typeVersion` is `NodeDescription.typeVersion` already, and `optionsExpression` / `reset` arrive with the converter port (step 13): a converted graph has had both refused by `toBatchConfig`. The field is not hashed, because batch identity is `type` + `typeVersion` and the size changes no place or transition. `graphToDescription` drops `isBackEdge` (a `MainConnection` has no such field; step 4 derives it again), refuses with `V2GraphError` a graph the converter cannot produce (repeated id or name, not exactly one trigger, an unknown endpoint, a slot that is not a non-negative integer, a batch config failing `isBatchStepConfig`, a batch edge from output ≥ 2, a v1 node without a `V1NodeStepConfig` or of type Split In Batches, a step type after the pin), and gives `wait` / `subworkflow` steps the synthetic types `@n8n/engine.wait` / `@n8n/engine.subworkflow`, since v2 has no executor for either. `validateExecutableGraph` / `validateLoops` refusals are left to step 4, so both input stages meet one refusal surface.
- **Step 4.** `analyse()` switches once, after node and connection validation, to `analysis/engine-v2/analyse.ts`; the v1 phases are untouched. Besides `loops.ts` and `shape.ts` there is `batch.ts`, which now owns the batch-step constants (`SPLIT_IN_BATCHES_TYPE`, `_VERSION`, `BATCH_OUTPUT_NAMES`, `DONE_SLOT`, `LOOP_SLOT`, `MAX_SLOT_INDEX`, `isV2BatchNode`); `conformance/v2/graph.ts` imports and re-exports them. Because a description has no `isBackEdge`, `loops.ts` also ports the converter's `markBackEdges` / `resolveSingleBatchEntry` (`markV2BackEdges`), not only `deriveLoops` and `classifyEdge`; its two throws map to `v2-unbatched-cycle` (`UnsupportedCycleError`) and `v2-loop-shape` (`UnsupportedLoopEntryError`). A slot above `MAX_SLOT_INDEX` is refused with the existing `output-` / `input-index-out-of-range` rather than a sixth code. `v2-trigger-count` is checked before v1's start-node validation, so no start node at all is `v2-trigger-count`, not `no-start-node`. Two `validateLoops` throws (a return into a non-batch node, a return from outside the loop) cannot fire on derived marks and are `InternalCompilerError`s. A batch size of `'expression'` is `v2-loop-shape` (`validateLoops`' "no batch size"); `toBatchConfig`'s own refusal is step 13's. The facts land on a new `WorkflowAnalysis.engineV2` (`trigger`, `loops`, `loopOf`, `edgeClass`; `null` under v1, not hashed). `analysis.nodes` still lists every node: the compiled set is `reachable`, and an unreachable node gets a diagnostic, so step 5 must build gadgets for `reachable` only. `kSafety` returns `null` under engineV2. `tarjan` in `analysis/scc.ts` is exported for reuse. Tests: `loops.test.ts` and `refusals.test.ts` as planned, plus `analysis.test.ts` (compiled set, skipped phases, diagnostics) and the shared builders in `tests/fixtures/v2-graphs.ts`. Step 2's hash test in `options.test.ts` now skips the five `ALL` fixtures v2 refuses (pinned in `refusals.test.ts`).
- **Step 5.** The settlement gadget is `compiler/gadget/settlement/{places,node,routing,index}.ts`. `buildNodeGadget` in `gadget.ts` is the switch. It now takes host places tagged with a profile (overloads: `V1NodeHost` → `GadgetBuild`, `SettlementNodeHost` → `SettlementBuild`), and the v1 body is unchanged as `buildV1NodeGadget`. A few compile stages still differ by profile, one named branch each, because an `engineV2` net has other host places, no `_budget` / `_pause` and no `NodeGadget`s:
  - `composeNet` → `composeSettlementNet`: `v2EdgePlaces`, `_halt` only, `analysis.reachable` only;
  - `mapNet` → `mapSettlementNet`;
  - `CompiledWorkflow.sharedMarking` / `initialMarking`: nothing, then one unit on `T/in`. `triggerItems` is not carried (decision 3);
  - `compile()`'s placeholder: `settlementPlaceholderActions()` in the new `compiler/actions/settlement.ts`, beside `settlementActions(policy)`. The policy decides fail or not, and filled slots.

  Part of step 7 had to come forward so that a v2 net has a `NetMap` at all. `SettlementGadget` (with `SettlementEdge`, `SettlementOutput`, `SettlementFailure`, `SettlementTransitions`) is in `types/netmap.ts`. `NetMap` has `profile`, `halt`, `settlements` and `settlement(name)`. `NetMapView` gets the same fields. `NetMap.shared` becomes a getter that throws `InternalCompilerError` on an `engineV2` map, and `nodes` is empty there. The other v1 accessors (`node()`, the derived place collections) and the consumer entry checks are still step 7's.

  **Split routing also applies when two fillings of a node's slots would write the same places.** An example is If → Merge on both outputs: filling slot 0, slot 1 or both each writes `{e…/arrived, M/live}`. The executor refuses such an `Out` as ambiguous (`validateOutSpec`), and to the net it is a single outcome. `declareRouting` checks the ≤ 2^3 fillings exactly. The existing fixture `chooseBranch` splits for this reason.

  Other points:
  - `X/done` is written on the halt branch too, because a failed row is a settled row.
  - The trigger's `T/in` has role `arrived` with no `edge`.
  - Names: `e{id}/arrived` and `X/live` are host places, bound through the ports `arrived_e{id}`, `live` (the node's own) and `live_{id}` (a successor's). One port is used per host place, and it is widened to `inout` when a node both reads and writes the place, which the batch self loop in step 6 needs. Ports are created on first use.
  - No transition role is new: start, skip, run (`attempt: 1`) and route. `ended` is added to `PlaceRole` for step 6.
  - `wait` / `subworkflow` steps (superseded by the review fixes below: they are now refused): `SettlementFailure` is `'always'`, so the halt branch is the only one. `V2_STEP_NODE_TYPES` moved to `compiler/analysis/engine-v2/steps.ts`, and `conformance/v2/graph.ts` re-exports it. At the pin, `StepReadyHandler.executorFor` throws *before* the step's `try`, so v2 never records such a step failed: it stays `running`. Halting is a divergence for step 14 to record.
  - A batch node is refused with a new `CompileError` code, `v2-batch-not-compiled`, until step 6 retires it.
  - No hash moved: `engineV2` hashes were introduced in this series and never released.

  Tests:
  - `structure.test.ts` covers 18 subjects: the 7 shapes in `SETTLEMENT_SHAPES`, which is new in `tests/fixtures/v2-graphs.ts`, and the 11 `ALL` fixtures v2 accepts. It also tests the trigger, failure, routing, and what is not compiled.
  - `settlement.test.ts` runs every filling of five shapes on both executors: diamond, 3-input Merge, 5-output Switch, chain, and If into one Merge. It compares each run with a fate table computed in the test from rules 2–4, and with a literal diamond table. It also covers failure: a halted chain, a trigger that cannot fail, a wait step, a run in flight after `_halt`, and a start or skip stopped by `_halt`.
- **Step 6.** The batch gadget is `compiler/gadget/settlement/batch.ts`; `buildSettlementGadget` sends a node there on `isV2BatchNode` and asserts that it heads its loop with exactly one entry and one back edge. `v2-batch-not-compiled` is retired, with the step 5 test that pinned it.
  - `L/ended` is the batch node's local place `B/ended` (`PLACE.ended`, role `ended`), not a host place: the batch node is its only writer.
  - `B_run`'s halt branch writes `B/ended` beside `_halt`. A failed batch row is settled with its loop slot unfilled, so `isTerminalStep` holds, as a failed row writes `X/done` outside a loop.
  - A loop with no exit (`noExit`) has one done branch: `doneData` and `doneEmpty` would write the same places, which the executor refuses as ambiguous.
  - Loop members, the batch node included, have no `done` / `skipped` (decision 6). A member is the ordinary node gadget without them; its skip only forwards dead arrivals.
  - Names: `B/start_entry`, `B/skip_entry`, `B/start_back`, `B/skip_back` (`TRANSITION.startEntry` …), with the roles `start` and `skip`; no new role.
  - `SettlementGadget` gains `loop` (the batch node of the node's loop, or `null`) and `batch: SettlementBatch | null` (`entry`, `back`, `ended`, and the back pair's names). On a batch node `transitions.start` / `skip` are the entry pair, and `routing` is the new kind `batch`.
  - `SettlementPolicy.fails` / `filled` take the row's iteration. `settlementActions` counts each node's rows (a start or a skip is one), restarting when the trigger starts, so a policy can script passes. A batch run asks both slots: loop filled is a pass, otherwise the done slot decides `doneData` / `doneEmpty`; both filled throws, since `runBatchStep` never returns `[x, y]`.
  - Tests: `tests/compiler/v2/batch-loop.test.ts`, 59 cases: structure over the six loop graphs of `ACCEPTED`, the batch gadget's arcs and branches (with self loop and no exit), and runs on both executors: 0 to 3 passes, `[null, null]` at pass 0 and after passes, dead entry, dead back edge mid-list (directly and through a skip cascade in `diamondBody`), an exit into a Merge beside a plain edge (held until the loop ends), two loops in sequence, failure of a body row and of a batch row. Every failure-free run is checked against `countExpectedSettledSteps`' linear form.
- **Step 7.** Two layers, two errors. The `NetMap` and `CompiledWorkflow` accessors are profile-bound and throw `InternalCompilerError` on the other profile's net: `shared`, `nodes` (now a getter), `node`, `hasNode`, `tryNode` and the four derived collections (`joinInputPlaces`, `joinReadyPlaces`, `edgeDataPlaces`, `runningPlaces`) on an `engineV2` net; and, symmetrically, `settlements` / `settlement` on a v1 net, which used to answer `[]` / `unknown-node`. The consumers refuse at entry with a new named error, `ProfileMismatchError` (`consumer`, `expected`, `actual`) in `compiler/errors.ts`, raised by `assertProfile`; both are exported from `compiler/index.ts`. A caller handing a net to the wrong consumer is not a compiler bug, so the entry refusal is not an `InternalCompilerError`.
  - Entry checks: `encodeMarking` and `decodeExecutionData` (the plan's `encodeExecutionData` is `encodeMarking` in the code), `deposits`, `budgetSemiflowOf`, `verifyCompiled` (before `assertLibpetriSurface`; `verify(workflow)` always compiles v1), and `PetriScheduler.compileDescription`, after the cache lookup: the scheduler's own compiles are v1 by construction, so a caller's cache is the only way an `engineV2` net reaches `run()`, which then rejects before it decodes or pops anything.
  - Beyond the plan's list, the action binders check too: `structuralActions` (and so `placeholderActions`, `forwardAllActions`, `routingActions`) and `schedulerActions` refuse an `engineV2` map, `settlementActions` a v1 map. They are consumers of the map, and a v1 binder on an `engineV2` compile used to fail with `unknown-node`.
  - The v1 families' "not applicable under engineV2" report (decision 18) stays step 12's: until then `verifyCompiled` refuses the whole net.
  - Tests: `tests/compiler/v2/boundary.test.ts`, 28 cases. `structure.test.ts`'s "no v1 node gadget" case now expects the throws instead of `[]`.
- **Review fixes after step 7.** An adversarial review of steps 1–7 found five defects; each fix has its own test.
  - **`wait` / `subworkflow` steps are refused, not halted.** At the pin, `StepReadyHandler.executorFor` throws before the step's `try`, so v2 writes no failed row: the step stays `running`, its siblings go on settling, and the execution never finishes. Halting changed sibling fates (`T.0 → W`, `T.1 → A → B → C`: the net left B and C undecided, n8n completes them). No fate models "never settles", so the `engineV2` analysis refuses a reached one with a new code, `v2-unsupported-step` (`analysis/engine-v2/nodes.ts` `checkV2Steps`), after the shape refusals, because n8n validates the graph before it runs a step. `SettlementFailure` loses `'always'` and every branch on it (the gadget, batch, routing and the binder). `waitStep` leaves `SETTLEMENT_SHAPES` and becomes the refusal fixture. Step 14's divergence "wait and sub-workflow steps halt" no longer exists.
  - **Refusal codes on graphs with several defects.** Accept versus refuse is mirrored exactly. The code can differ when a graph has several defects: `markBackEdges` / `validateLoops` visit components in n8n's Tarjan order, and `componentsOf` runs in canvas order. The review measured 16 of 20,000 random graphs, all multi-defect, and no verdict differed. We do not chase n8n's order. Step 13's acceptance leg compares verdicts on every entry, and codes only on single-defect graphs. This is documented in `shape.ts`'s module doc and `loops.ts`.
  - **Disabled nodes are refused.** Until stage 2 ports `spliceOutDisabledNodes`, a disabled node the trigger reaches is refused with `v2-disabled-node`, naming the node. It used to be compiled as if it ran. A disabled node the trigger does not reach is left alone, because `rootAt` drops it first. The check follows `toGraphNode`'s refusals, which see only live nodes, and comes before every edge check, since those read the spliced graph.
  - **The converter's node refusals.** These are `v2-continue-error-output` (`toGraphNode`: `onError: 'continueErrorOutput'`) and `v2-merge-mode` (`assertSupportedMergeMode`), in `nodes.ts` `checkV2ConvertedNodes`. They cover reached, live nodes other than the trigger, in canvas order, before the disabled-node check and the shape refusals. A description does not carry the Merge `mode` yet, so chooseBranch is read from the evaluated `requiredInputs`:
    - on `n8n-nodes-base.merge` (`MERGE_TYPE`), a non-null `requiredInputsOf` is exactly chooseBranch, because Merge v2 and v3 declare `mode === "chooseBranch" ? [0, 1] : 1`;
    - on any other type, it counts when those inputs make v1's `choose-branch` join. The fixtures `mergeChoose` / `merge3Choose` are caught this way. No other n8n type is: CompareDatasets' `requiredInputs: 1` names no input, and ModelSelector has one main input. (Superseded by the review fixes after step 13: a node of another type is never refused, and the two fixtures are accepted.)

    The expression-mode case (a mode starting `=` at typeVersion ≥ 2) needs step 13's `NodeDescription.mergeMode` and is not refused yet. The fixtures `chooseBranch` and `partialRequired` are now `v2-merge-mode`, and `continueErrorOutput` is `v2-continue-error-output`. `analysis.test.ts` shows the `requiredInputs` diagnostic on a Merge in append mode (`requiredInputs: 1`).
  - **The refusal tests no longer claim parity they lack.** `refusals.test.ts` says what each case claims:
    - `twoTriggers` is not n8n's verdict: `rootAt` would drop TrigB and accept. Our `v2-unreachable-feeder` there is the stage-1 rule applied ahead of stage 2's `rootAt`.
    - A Split In Batches v2 loop is refused by n8n in `toBatchConfig`, not by `markBackEdges`. The verdict is the same and the code is not.

    Both wait for step 13 (`rootAt`, `toBatchConfig`). Until then a Split In Batches at another version *outside* a cycle is accepted as an ordinary node, where n8n refuses it.
  - **The public verify exports refuse `engineV2` nets.** `StateSpace.explore`, `loopTransitions` and `alternativeEntryReach` now refuse with `ProfileMismatchError`, as `verifyCompiled` does. Before this, `strandedPlaces()` reported an `engineV2` net's `arrived` / `live` tokens as stranded under v1 rest roles. The other exports are profile-neutral: the counterexample decoders, the renderers, the role sets, `producersOf`, `smtRefusalFor`, `markingStateOf` and the workflow-JSON readers. `renderMarkedPlace` now counts `arrived` as an input-side role, so an `engineV2` edge's place prints its input slot. `truncationShapeOf` is internal and already throws through `NetMap.nodes`. Tests are in `boundary.test.ts`.
- **Node order when several nodes would be refused (verifier, after the review fixes).**
  `checkV2ConvertedNodes` walks nodes in canvas order, while n8n's `convert` walks
  `workflow.nodes` in array order. With two refusable nodes we can name a different one than
  n8n does, and with two different defects we can report a different code. Measured on
  `.templates/9200.json`: n8n names `Merge1` and we name another chooseBranch Merge; the code is
  the same. This is the same class as finding 2. Accept-versus-refuse is mirrored, and step 13's
  acceptance leg compares codes and node names only on single-defect graphs.
- **The raw-JSON route is not yet an acceptance path** (superseded by step 13, below: 0 verdict disagreements). Going through `describeWorkflowJson` and
  the catalogue, then engineV2, still refuses 75 entries n8n accepts: 25 `v2-loop-shape`, 23
  `v2-converging-input`, 21 `v2-unreachable-feeder`, 5 `v2-unbatched-cycle` and 1
  `v2-disabled-node`. The cause is that rooting at the fired trigger, disabled-node splicing and
  back-edge marking are not ported yet (step 13). Stage 1 (`graphToDescription` from n8n's own
  converted graph) compiles all 209 n8n-accepted entries and refuses none.
- **Step 8.** The decoder is `src/codec/v2/step-rows.ts`, the planner `src/codec/v2/plan.ts`, and both share a third module, `src/codec/v2/net.ts`: unit-token counts per place name (`TokenCounts`), hand enabledness (`isEnabled`: `requiredCount` per input arc, reads, inhibitors), `branchOf` (the enumerated `Out` branch writing exactly a given place set) and `fire`. Both entry points call `assertProfile` first. Neither is exported from the package's `codec` entry yet.
  - **`decodeStepRows` returns the row counts beside the marking.** It returns `StepMarking { marking: Map<Place, Token[]>, rowCounts }`, and `planFromMarking(compiled, decoded)` takes that, so `planFromMarking(compiled, decodeStepRows(compiled, rows))` composes. The reason is that a folded loop's marking does not hold iterations (decision 6), and the planner keys its answers `(node, rowCount(node))`. `enabledTransitions(compiled, marking)` is also exported, for the state-class cross-check.
  - **The row types are local mirrors.** `StepRow` / `StepKey` / `V2_STEP_STATUSES` mirror `StepSummary`, `StepKey` and `STEP_STATUSES` at the pin, with no `.n8n` import. `StepRow.status` is typed loosely so that a status the pin lacks, such as `waiting`, reaches the decoder's `CodecError`.
  - **What each row fires.** `queued`, `running` and `cancelled` fire the start only, so the step is in flight. `completed` fires the start, then `X_run`'s success branch for exactly its `filledOutputSlots`, then every `X_route_o` under split routing. `failed` fires the start and the halt branch. `skipped` fires the skip. A batch node uses its entry pair at iteration 0 and its back pair after. Its completed row takes the `loop` branch when the loop slot is filled, `doneData` when the done slot is, and `doneEmpty` when neither is; on `noExit` those last two are one branch.
    - A row is applied whole (start, run, routes).
    - Rows are tried in input order in repeated passes, so permuting the input varies the replay order.
    - The `_halt` of failed rows is withheld and deposited after replay.
  - **Cancelled rows.** A cancelled row stays in flight in the marking (`X/running`), because the net does not model the cancellation (decision 8's divergence).
  - **Queued or running trigger rows.** The decoder accepts a trigger row that is queued or running. v2 never writes one, but it is the net's state between `T_start` and `T_run`, and executor traces pass through it.
  - **Refusals beyond the plan's six.** The decoder also raises `CodecError` for:
    - a node the net does not compile;
    - a repeated `(node, iteration)`;
    - an iteration that is not a non-negative integer;
    - a second row on a node outside every loop;
    - a failed or skipped trigger row;
    - a filled slot on a row that did not complete.
  - **The prefix test runs on row-set points, not on every prefix.** An executor trace passes through markings that are not row sets: a transition in flight (its tokens consumed, none deposited), and a split run whose routes have not all fired (`X/ok_o` marked). The test decodes at every point after a completed firing where neither holds. Traces use both executors, with seeded 0–3 macrotask delays in every action so that firings interleave.
  - **Answer order.** Answers come in net declaration order, not `decideSuccessors`' edge order. Comparisons are of sets.
  - Tests: `tests/codec/v2-step-rows.test.ts`, 50 cases. It covers 12 graphs (`SETTLEMENT_SHAPES` ∪ `ACCEPTED`), 12 seeded behaviours each (a third of them with run failures), and both executors: 2,164 row-set points. At each point the decoded marking equals the executor's, and the hand enabled set equals `StateClassGraph.build(net, M, 1).initialClass.enabledTransitions`. The file also has:
    - 20 permutations of two row sets per behaviour, which decode to one marking;
    - plans written from rules 2–4;
    - every refusal.
  - **A preliminary differential, not step 10's.** A scratch probe (not committed) ran the spike's reference loop on the 209 accepted entries, 8 behaviours × 4 orders each, and compared `planFromMarking(decodeStepRows(S))` with R(S) at every reference state (decision 13). Over 61,497 states it found **0 disagreements and 0 `CodecError`s**. The spike's `outcome()` has no `[null, null]` terminal, no failed batch row and no `running` or `cancelled` rows, so those shapes are covered by the unit tests only. Step 10's harness is still owed.
- **Step 9.** The reference is `src/conformance/v2/reference.ts`: `hash`, `rng`, `outcome`, `simulate`, `latestTerminal`, plus `terminalIterations` and `referenceAnswer` (R(S)). n8n's code comes in as a `SettlementReference` with the ten functions the loop calls: decision 15's seven, and `findTriggerNode`, `getDescendantNodeIds` and `getSuccessorNodeIds`. The module imports only types from `codec/v2/step-rows.ts` (`StepKey`, `V2StepStatus`) and `conformance/v2/graph.ts`. It declares `V2Loop` (`batchNodeId` and `memberIds`, the fields it reads) and `ReferenceRow` (`StepSummary`); n8n's loop objects pass through it untouched. It is not exported from the `conformance` barrel. `tests/codec/v2-step-rows.test.ts` now imports `hash` and `rng` from it rather than keeping its own copies.
  - **API shape.** `outcome(graph, node, iteration, behaviour)` and `simulate(ref, graph, behaviour, order, options)` take a `Behaviour { seed, pFail, emptyTerminal }` in place of the spike's positional `seed, pFail`. `SimulateOptions` has `onState(rows)` and `maxEvents`, whose default is `MAX_EVENTS` = 20,000, as in the spike. The option exists so a test can reach the guard without running 20,000 O(rows) events. `RunResult` also carries the final `rows`, for step 10's fate comparison.
  - **When `onState` fires.** It fires once for the trigger's birth row and then after every event that changed a row. Each call receives a snapshot the caller may keep.
  - **Two row states the spike did not have.** Neither draws a random number, so no run's order, end or event count moves.
    - A `running` row between claim and settle. `StepReadyHandler` claims `queued → running` before it runs a step.
    - `cancelled` rows after a failure. `failExecution` calls `cancelQueuedSteps`, so a failed run's queued rows now end `cancelled`, not `queued`. That changes the fate strings and `settled`/`leftQueued` of failed runs only. Those are never compared: confluence and the completion checks read failure-free and completed runs.
  - **R(S)** follows decision 13. It is ∅ if any row failed. Otherwise it is the union over completed and skipped rows of `decideSuccessors(graph, loops, r, S, terminalIterations(S))`, where `steps` is the whole row set and `terminalIterations` covers every loop. Both are supersets of what the handler loads, with the same value for each entry. Keys that already have a row are left out. `decideSuccessors` already skips those, and `createSteps` would insert a key only once. If two rows disagree about a key, R(S) keeps it in both lists, so the disagreement shows up in a comparison and is not resolved here.
  - **Baseline proven unchanged.** The spike imports the module. `--baseline` turns off the `[null,null]` draw and the new per-state checks. Its output is byte-identical to the pre-move spike's: 211 workflows, 310 entries, 209 accepted (20 with a batch loop), the same 101 rejections by kind, runs 83,600 (completed 81,040, failed 2,560, drained-unfinished 0), findings 0.
    - A scratch comparison (not committed) also ran the pre-move `simulate` and the module's side by side on every one of the 83,600 runs. End, event count and fates (with `cancelled` read as `queued`) were equal on all of them. `settled`, `expected` and `leftQueued` were equal on every completed run.
  - **The seeded `[null,null]` terminal.** `outcome` ends a batch node's terminal step with `[false,false]` with chance `emptyTerminal` per (behaviour, batch node). The draw is `rng(hash(seed, node.id, 'empty-terminal'))`, so it moves no other draw. The spike's default is 0.25. Without `--baseline` it also checks every reference state for two steps of one node in flight (the plan's folding falsifier) and for an R(S) that both queues and skips one key.
    - New numbers at n8n@2.41.3, registry libpetri 7.0.0: entries 310, accepted 209, runs 83,600 (completed 81,040, failed 2,560, drained-unfinished 0).
    - 600 runs have a loop that ended empty.
    - There are 972,945 reference states: 210,183 with a `running` row and 82 with a `cancelled` row.
    - Findings: 0. There is no non-confluence, no two steps in flight and no queue/skip split.
    - Completed and failed counts do not move, because an empty terminal fails nothing.
    - Most loop runs never reach a completed terminal. Of 8,000 loop runs, 4,080 skip the batch node at its entry, and many more end by a skipped back pair. That is why only 600 end empty.
  - **A preliminary differential again, not step 10's.** A scratch probe (not committed) compiled all 209 accepted entries through `graphToDescription` (0 compile errors). It ran the module with n8n's dist injected, 20 behaviours × 20 orders, `emptyTerminal` 0.25, and compared `planFromMarking(decodeStepRows(S))` with `referenceAnswer` at every `onState` state.
    - It covered 972,945 states, of which 1,988 hold an empty terminal, 210,183 a `running` row and 82 a `cancelled` row.
    - It found **0 disagreements and 0 `CodecError`s**.
    - A failed batch row is still never produced, because `outcome` never fails a batch step. That shape is covered only by the step 6 and step 8 unit tests.
  - Tests: `tests/conformance/v2/reference.test.ts`, 23 cases, with no `.n8n`. n8n is replaced by a stub that implements rules 2–4 of `settlement.ts` for graphs without a loop, and no claim about n8n rests on it.
    - Pinned `hash`/`rng`.
    - `outcome`: arity, failure, batch passes, the empty terminal and its independent draw, and the 0.25 rate.
    - `simulate`: birth state first, every step reads queued → running → settled, snapshots are not touched later, determinism, cancellation after a failure, and the termination guard.
    - `referenceAnswer`: union, ∅ after a failure, existing keys left out, and a split kept in both lists.
    - `latestTerminal` and `terminalIterations`.
    - On the six `SETTLEMENT_SHAPES`, every state the loop reports decodes, and the planner equals the stub's R(S).
- **Step 10.** The differential is `tasks/v2-differential.mts`. Its parts live in `src/conformance/v2/`: `binder.ts`, `net-run.ts`, and a third module the plan did not name, `differential.ts`. That module holds the three leg comparisons as pure functions, so the suite can check them without `.n8n`. None of the three is exported from the `conformance` barrel.
  - **Binder.** The signature is `v2Actions(graph, behaviour, delaySeed)`, not `v2Actions(seed)`, because `outcome()` needs the graph and the whole `Behaviour`. The binder is `settlementActions(outcomePolicy(graph, behaviour))` wrapped in `delayed(…)`.
    - The trigger fills slot 0 only, as `ExecutionStartHandler` writes it, and `outcome` is never asked about it.
    - **Every** action waits 0 to 3 seeded macrotask ticks: start, skip, run and route, not only `X_run`. A start or skip in flight is a net state too, and delaying it widens the interleavings.
    - The net run of pair (b, o) uses the delay seed `hash(seed, 'net-order', o)`.
  - **`runV2(compiled, actions)`** takes a binder rather than a seed, and runs on `PrecompiledNetExecutor`. **Rows are read from what each firing wrote, not from the policy.** libpetri 7.0.0 emits a firing's `token-added` events immediately before its `transition-completed`, so the last `producedTokens.length` added places are that firing's outputs.
    - A slot is filled when every `live` its edges write was written. This test is exact under collapsed routing, because the compiler splits any node whose fillings collide.
    - `B_run` filled its loop slot when it wrote no `B/ended`.
    - A started step reads `running`: the net does not tell queued from running.
    - As in step 8, row-set points are taken after completed firings with nothing in flight and no split route pending.
  - **Leg (b) with a failure.** Here "compared up to the first failure" means three things:
    1. The ends agree: the net holds `_halt` exactly when the reference ended `failed`.
    2. On every key both runs have a row for, the step was queued in one exactly when it was queued in the other (any status but `skipped` counts as queued).
    3. A step settled `completed` or `failed` in both has the same status and slots.

    The two runs stop planning at different moments, so keys only one side decided are counted, not treated as disagreements. After `_halt`, the net finishes its in-flight starts, and the reference cancels its queued rows.

    Failure-free, the comparison is the full fate multiset (`name#iteration=status`) plus every connected slot of every completed step. It also checks that no step is left `running`, and that settled equals `countExpectedSettledSteps` (from n8n, on the net's own rows) and equals the reference's settled count.
  - **Leg (c).** The "net's next enabled set" is libpetri's own `StateClassGraph.build(net, M, 1).initialClass.enabledTransitions` at the **executor's** marking, keyed `(node, rowCount)` from the trace. The executor exposes no enabled set and emits no disable event, so the event stream cannot give it. The leg also checks that the decoded marking equals the executor's marking at every point.
  - **The script.** It reads the spike's corpus with the same trigger rule. It prints decision 16's stamp (the pin, sha256 prefixes of the six dist files, and libpetri's version and whether it is linked). `--net-behaviours` and `--net-orders` bound the net legs, `--json` dumps the counts and findings, and the exit code is 1 on any finding.
  - **Measured.** Run on 2026-09-25 at `n8n@2.41.3` (settlement.js `8b7fe1d317aa`, iteration-mapping.js `b020437a1dc2`, completion.js `3d3c53f9902c`, loop-ledger.js `affbe650919e`, loops.js `942db20c8af8`, v1-workflow-converter.js `6b2d8ba8518a`), against libpetri 7.0.0 from the registry. Setup: 20 behaviours × 20 orders on every leg, `emptyTerminal` 0.25, and `pFail` 0.05 on every fourth behaviour.
    - Corpus: 310 entries, 209 accepted, 209 compiled (20 with a batch loop), 0 compile errors.
    - **(a) state:** 83,600 reference runs and 972,945 state reports (33,367 distinct row sets, 25,222 with a non-empty R(S); review count). Of those states, 210,183 have a `running` row, 82 a `cancelled` row, 2,788 a `failed` row and 1,988 an empty terminal. **0 disagreements, 0 `CodecError`s.** The state counts equal step 9's probe, so both ran the same reference runs.
    - **(b) lockstep:** 83,600 pairs.
      - 81,040 pairs are failure-free, with 595,840 steps compared.
      - 2,560 pairs failed. In those, 10,660 steps were decided by both runs and compared; 102 were decided by the net only and 35 by the reference only.
      - **0 disagreements.**
    - **(c) firing:** 901,968 net firings, of which 836,272 were row-set points. **0 disagreements**: 0 `CodecError`s and 0 marking mismatches.
    - Wall clock: 322 s in all. Leg (a) took 41 s, the net runs 234 s and leg (c) 44 s. The full test suite ran concurrently for part of that time.
  - **Limits.**
    - `outcome()` never fails a batch step, so no run produces a failed batch row. That shape is covered only by the step 6 and step 8 unit tests.
    - On a `noExit` loop the done slot has no edge, so the net's rows read it unfilled. The reference fills it, and nothing reads it.
    - These are sampled interleavings. All interleavings of the abstraction are the state-class graph's, in step 12 (decision 17 says step 11, but the verification families are step 12).
  - **Tests.** `tests/conformance/v2/differential.test.ts` has 56 cases and needs no `.n8n`.
    - `outcomePolicy` against `outcome`.
    - `runV2` on all 13 fixture graphs, 12 seeds each: every settled row is `outcome()`'s, read back from the written places, and the run halts exactly when a step failed.
    - Leg (c) at every point of those runs.
    - Legs (a) and (b) on the six loop-free shapes, with the stub reference.
    - Each comparison catching a doctored input: a reference that never skips, rows that do not decode, a dropped row, a flipped slot, a wrong end, and a marking with an extra `_halt`.

    The stub moved from `reference.test.ts` to `tests/fixtures/v2-stub-reference.ts`, and both suites import it from there.
- **Step 11.** The recorder is `tasks/record-v2-golden.mts`, the golden `typescript/tests/fixtures/v2/settlement-golden.json`, and the replay `typescript/tests/conformance/v2-planner-golden.test.ts` (47 cases, no `.n8n`). A module the plan did not name, `src/conformance/v2/golden.ts`, holds the format (`SettlementGolden`, `GoldenEntry`, `GoldenRun`, `GoldenState`, `GoldenStamp`) and its pure helpers (`encodeRow` / `decodeRows`, `runResultOf`, `fatesOf`, `stateKey`, `selectStates`, `stampDifferences`, `asGolden`), so the recorder and the test share one definition and it is type-checked. It is not exported from the `conformance` barrel.
  - **Corpus: committed graphs only.** `scripts/testbed/workflows` gives 7 entries: of 11 workflows, n8n's converter refuses 4 (3 `onError: continueErrorOutput`, 1 converging edges into slot 0), and the refusals are recorded under `skipped` with n8n's message. The fixtures give 12: `SETTLEMENT_SHAPES` ∪ `ACCEPTED`, each passed through n8n's `validateExecutableGraph` first. That makes 19 entries, 5 of them with a batch loop. **No `m1-acceptance` workflows exist in this repository:** they are n8n's own test suite inside `.n8n/`, so they are not a committed source, and the recorder says so in its output.
  - **What is recorded is n8n's.** R(S), the ends, the final rows and `countExpectedSettledSteps` come from n8n's dist injected into the reference loop. The net is only the side being checked. A failing replay is a finding about the net and is never fixed by re-recording.
  - **Format.**
    - A row is a tuple `[node index, iteration, status, slots]`: the node is its index in the entry's `graph.nodes`, and the slots are a `0`/`1` string.
    - A plan is `PlanKeys` (sorted `nodeId@iteration`), the form leg (a) compares.
    - A run stores its final rows, not the fate string. The fates are `fatesOf(rows)`, and the recorder throws unless that equals `simulate`'s `fates`.
    - One node, edge, behaviour, run or state per line.
  - **Size and cap.** Per entry: 12 behaviours × 8 reference orders. `pFail` is 0.2 on every 4th behaviour, not the differential's 0.05, because the golden has few runs and failed and cancelled row sets are the rarest. `emptyTerminal` is 0.25. States are deduplicated as row sets and capped at 60 per entry by `selectStates`. The cap is stratified by kind (failed, cancelled, running, empty terminal, plain), with an equal share per kind and an even spread over the order the states were reported in. Each entry stores `stateCounts {reported, distinct, kept, dropped}`, and the recorder prints the kept and distinct counts by kind for every entry that drops. Totals: 17,574 states reported, 1,159 distinct, **664 kept** (218 with a `running` row, 75 `failed`, 18 `cancelled`, 24 with an empty terminal), 495 dropped. The runs of the first 2 orders are recorded: **456 runs**, 42 of them failed. The file is 262 KiB, 1,900 lines.
  - **Stamp.** Decision 16 as `stamp {n8n, dist, libpetri}`: `n8n@2.41.3`; the **full** sha256 of the six dist files, keyed by path under `packages/@n8n` (the differential prints 12-character prefixes); and libpetri `{version: '7.0.0', linked: false}`. Against an existing golden with a different stamp, the recorder prints each difference and exits 2 without writing, unless `--force`. This was checked on a doctored copy (n8n@2.40.0, libpetri 6.0.0). Re-recording under the same stamp is byte-identical (the recorder reports `unchanged`).
  - **The recorder also checks the net** with n8n's real functions: leg (a) on every distinct state (all 1,159, kept or not) and leg (b) on every recorded run. It exits 1 on a finding, but still writes, because the golden's content is n8n's. At recording: **0 findings**, 0 compile errors.
  - **Leg (b) without `.n8n`.** `differential.ts` gains `compareStateTo(compiled, rows, planKeys)` and `compareRuns(graph, compiled, reference, net, expectedOf)`. `compareState` and `compareLockstep` are now thin wrappers that compute R(S) and `countExpectedSettledSteps` with the injected reference, and their behaviour is unchanged (a 30-workflow smoke run of `tasks/v2-differential.mts` gives 0 findings). The replay passes the count n8n gave on the **reference** run's final rows, where the differential uses n8n's count on the **net's** rows. The two are equal whenever the fates and connected slots agree, which is compared first. The reason: `countExpectedSettledSteps` reads the loops, the reachable set and each batch node's latest row, and a batch row is terminal by its status and loop slot.
  - **The replay.**
    - (a) At every recorded state, `planFromMarking(decodeStepRows(rows))` equals the recorded R(S) (`compareStateTo`).
    - (b) Every recorded run is re-run on the compiled net with `v2Actions(graph, behaviour, netDelaySeed)` and compared by `compareRuns`. The net must end halted exactly when n8n's run failed.
    - The suite also checks:
      - the stamp's shape;
      - that the recorded fixture graphs **equal the current fixtures** and cover all of them, so a changed or added fixture fails until it is re-recorded (which needs `.n8n`);
      - that every testbed entry's source file exists;
      - that at least one kept state of each rare kind is present;
      - the count invariants.
    - A doctored R(S), fate, slot and settled count must each be caught.
    - Leg (c) needs no n8n answer and stays in `tests/conformance/v2/differential.test.ts`.
  - **Measured.** Recorder about 2 s; replay about 0.7 s. Full suite: 93 files, 1,621 tests green, `v1-identity` unchanged. libpetri 7.0.0 from the registry.
  - **Limits.** Still no failed batch row: `outcome()` never fails a batch step, so the golden has none either. The testbed entries have no loop, so all loop coverage comes from the 5 loop fixtures. The golden samples 19 small graphs, while the corpus-scale evidence stays with `tasks/v2-differential.mts` (step 10).
- **Step 12.** The family is `typescript/src/verify/families/v2-settlement.ts`, one property name, `settlement`, with one check per subject. The `engineV2` report is `src/verify/settlement.ts` (`verifySettlement`, `exploreSettlement`). Its one pass over the classes is `src/verify/state-space/settlement-survey.ts`. The not-applicable records are `src/verify/families/not-applicable.ts`. `markingStateOf` moved to `src/verify/marking.ts`, and `verify.ts` re-exports it. None of the new modules is exported from the `verify` barrel. `VerificationReport.profile` and `VerifyOptions.profile` are public.
  - **The checks.** Each is recorded with `QueryRecord.property` naming its graph question.
    - `settlement:start-skip-exclusive`: one check per node with a skip, and two for a batch node (entry pair and back pair).
    - `place-bound` ≤ 1: one per `arrived` place (the trigger's `T/in` included) and one per `X/running`.
    - `settlement:quiescent-without-halt-is-settled`: one whole-net check, over the roles `arrived`, `live`, `running` and `ok`.
    - `settlement:decided-exactly-once`: one per node outside a loop. `done + skipped` is ≤ 1 in every class and = 1 at every halt-free rest.
    - `settlement:loop-ends-exactly-once`: one per batch node. `B/ended` is ≤ 1 everywhere and = 1 at every halt-free rest.
  - **Step 6's open issue.** `B/ended` is also written by a failed batch row. The at-rest claims quantify over halt-free quiescent classes only, and a halted class carries no completion claim. The bounds and the exclusivity still hold over every class. The test shows that `loop`'s graph has halted classes both with and without `B/ended`, and that the loop-end check is proven there.
  - **One route, the state-class graph.** There is no SMT fallback. A truncated graph reports the violations its prefix holds, and everything else comes back `unknown` with the cap in the reason. There is no `bounded` verdict: a folded loop has finite markings, and every loop graph in the fixtures closes. An at-rest claim is `unknown`, not `proven`, when the complete graph reaches no halt-free quiescent class, because it would hold vacuously. A witness is reported only as a class of the priority- and value-blind abstraction (VER-004).
  - **Routing.** `verifyCompiled` reads the profile off the net. An `engineV2` net goes to `verifySettlement` and never reaches a v1 family, and `options.profile`, when set, must match the net (`ProfileMismatchError`). This replaces step 7's whole-net refusal: `boundary.test.ts` now expects the refusal only for `{ profile: 'v1' }`. `verify(workflow, { profile: 'engineV2' })` compiles without a budget option. An explicit `budget` or agent bound is passed through and refused by the compiler. `timeoutMs`, `smtFallback`, `semiflowInvariants` and `triggerItems` are ignored under the profile.
  - **"Not applicable", as a verdict.** It is `unknown` with a reason starting `not applicable under engineV2: `, route `none`, one check per family asked for. It is not a new `CheckVerdict`, because the counts record and every renderer would have changed for v1 too. As a consequence, `--strict` fails on it. The default property list under `engineV2` is `['settlement']`, so the not-applicable checks appear only when asked for: `--property budget`, `retry-bound`, or `--mutex` / `--all-pairs`.
    - Decision 18 names only `budget` and `retry-bound`. `no-double-activation` and `proper-completion` are also not applicable, and their reasons name the settlement check that asks the analogous question. `dead-nodes` and `mutual-exclusion` are "not ported".
    - `settlement` asked of a v1 net is not applicable under v1, symmetrically.
  - **Report shape under `engineV2`.**
    - `budget` / `requestedBudget` carry the compiler's unused default 1.
    - `invariants` are all zero, `timeoutMs` is 0, and `solver` is informational only.
    - `stateSpace.terminal` counts halted classes, and `strandedPlaces` counts the places that some halt-free quiescent class holds pending work on.
    - The header prints "profile engineV2", "budget none" and "solver not used".
    - Exit code 3 applies only to v1 reports (`cli/exit-code.ts`), because no `engineV2` check is solver-backed.
  - **CLI.** `--profile v1|engineV2`. The raw-JSON route is not yet an acceptance path (the deviation above): a workflow n8n accepts can be refused with the `CompileError`, exit 2. The test pins one such case, two triggers, which n8n roots at the fired one. This is documented in `cli.ts` and `docs/verification.md`.
  - **Measured: class counts, v1 against `engineV2`** (`tests/verify/measure-v2.ts`, libpetri 7.0.0 from the registry, cap 200,000). The subjects are the acyclic `ALL` fixtures the profile accepts, plus the generated `chain40` and `wide8`. `+` means truncated.

    | workflow | v1 k=1 P/T | v1 k=1 classes | v1 k=n classes | v2 P/T | v2 classes |
    |---|---|---:|---:|---|---:|
    | linear | 37/15 | 37 | 119 | 19/11 | 21 |
    | fanOut | 37/15 | 90 | 707 | 19/11 | 64 |
    | diamond | 62/27 | 295 | 1,785 | 30/17 | 92 |
    | switch20 | 238/107 | 200,015+ | 200,004+ | 129/85 | 200,005+ |
    | expressionRef | 37/16 | 69 | 181 | 19/11 | 45 |
    | retry | 30/13 | 62 | 149 | 14/8 | 14 |
    | ifHalf | 28/11 | 27 | 55 | 14/8 | 14 |
    | fanOut4 | 62/27 | 1,807 | 33,141 | 33/21 | 2,182 |
    | failurePolicy | 45/23 | 88 | 689 | 19/11 | 45 |
    | chain40 | 370/163 | 407 | 200,000+ | 204/122 | 983 |
    | wide8 | 82/35 | 5,894 | 200,008+ | 44/26 | 24,315 |

    The v2 fixture graphs, compiled through `graphToDescription` for all three nets (a scratch run, not committed), give these class counts:

    | graph | v1 k=1 | v1 k=n | v2 |
    |---|---:|---:|---:|
    | chain | 27 | 55 | 14 |
    | branchDiamond | 295 | 1,785 | 92 |
    | threeInputMerge | 746 | 4,543 | 134 |
    | switchFanOut | 8,463 | 200,002+ | 14,294 |
    | longChain | 37 | 119 | 21 |
    | ifIntoMerge | 71 | 179 | 27 |

    **Reading, in the direction the numbers allow:**
    - Every v2 net has about half the places and fewer transitions.
    - Against v1 at equal concurrency (k = node count, since v2 has no budget), v2 has fewer classes wherever v1 closes. It also closes on `chain40` and `wide8`, where v1 truncates.
    - Against v1's default k = 1, which runs one node at a time, the hypothesis is **refuted on 4 of the 16 closing subjects**: `fanOut4` (2,182 against 1,807), `chain40` (983 against 407), `wide8` (24,315 against 5,894) and `switchFanOut` (14,294 against 8,463). These are fan-out and long-chain shapes, where v2 runs every queued step concurrently, or where the chain's dead-slot skips interleave with no budget to serialise them.
    - `switch20` truncates under all three nets. Under `engineV2` its report is 0 proven, 0 violated, all `unknown`.
    - This refutes ADR 0012's "smaller nets" as a claim about state classes against v1's default budget. It does not refute the design. The report wall clocks follow the class counts: v2 is 3.5 s on `wide8` against 181 ms for v1 k=1, and 39 ms against 33 ms on `chain40`.
  - **Tests.** `tests/verify/v2-families.test.ts` has 71 cases and needs no z3 (nothing in it is solver-dependent, so it is not behind the gate).
    - Every check is proven on 20 nets: the 12 v2 graphs and the 8 `ALL` fixtures the profile accepts, `switch20` excepted. On each net the graph is complete, halted classes are present, and the number of checks per question matches the net's structure.
    - Nine class counts are pinned.
    - The halted-loop carve-out is covered.
    - Each claim is broken on purpose, from a doctored initial marking (a second unit on `T/in`, a stale Merge arrival, a pre-marked `B/ended` or `A/done`), or on a hand-built net for the exclusivity. Each yields `violated` with a decoded firing path.
    - It covers truncation (`switch20` at a 2,000 cap, cause `parallelism`), `maxClasses: 0`, and the vacuity guard.
    - It covers profile routing, the not-applicable records under both profiles, exit code 3 not applying, and the CLI: `--profile engineV2` end to end, `--strict` with a v1 family, `--budget` refused, a raw-JSON refusal, and a bad profile name.
- **Step 13.** The port is `compiler/analysis/engine-v2/root.ts` (`isV2TriggerType`, `firedTriggerNameOf`, `resolveFiredTrigger`, `rootAtTrigger`, `dedupeEdges`, `spliceDisabled`, and `convertV2`, which runs `convert`'s steps in its order) and `refusals.ts` (`V2_REFUSALS`, `refuseV2`, `v2RefusalOf`). `nodes.ts` now holds `toGraphNode`'s checks per node (`checkV2ConvertedNode`: `onError`, then the Merge mode, then `toBatchConfig`) and `checkV2ConnectionTypes`; `shape.ts` is `validateLoops` and `validateExecutableGraph` only, on the converted graph with the converter's marks. The drift guard's parser is `src/conformance/v2/drift.ts` (`throwSitesIn`, `refusalDrift`), shared by `tasks/v2-acceptance.mts` and a suite; it reads source text handed in, so `src/` still never reads `.n8n`.
  - **`V2_REFUSALS` is the code path, not a table beside it.** Every engine v2 refusal of the analysis goes through `refuseV2(site, …)`, so the code a site maps to is the code thrown. 38 sites: 14 in the converter, 18 in `validateLoops`, 6 in `validateExecutableGraph`. Six have no code, because the port's input cannot reach them, and raise `InternalCompilerError`: `duplicateId` and `unknownEndpoint` (a description's ids are unique and its edges join its nodes), `notBatchTarget` and `backEdgeFromOutside` (marks `markBackEdges` made), `noBatchSize` (`toBatchConfig` refused first) and `severalTriggers` (one trigger step). `V2Refusal.match` is a fragment of the site's source text, and for a class thrown at several sites also of its message, so `v2RefusalOf(class, message)` names the site of an error n8n threw.
  - **The fired trigger.** `AnalysisOptions.trigger`, `CompileOptions.trigger` and `VerifyOptions.trigger`, and the CLI flag `--trigger NODE`, are n8n's `firedTriggerName`. Without the option, a description's one start node is the name; without either, n8n's rule applies: the only enabled node of a trigger type (`isTriggerNodeType`, mirrored as `V2_TRIGGER_NODE_TYPES` / `isV2TriggerType`), several refused. The option is refused under v1, beside a start node it contradicts, and beside a precomputed analysis of another trigger (`invalid-options`). Several declared start nodes stay `v2-trigger-count`: n8n cannot be told several. `describeWorkflowJson(…, { profile: 'engineV2' })` picks no start node and refuses one given; the CLI refuses `--trigger` without `--profile engineV2` and `--start` with it.
  - **Codes.** New: `v2-unknown-trigger`, `v2-not-a-trigger`, `v2-ambiguous-trigger`, `v2-batch-config` (all five `toBatchConfig` throws) and `v2-connection-type`. `v2-disabled-node` is retired: n8n splices and never refuses a disabled node. `v2-trigger-count` now means no trigger at all, raised after the converter's own checks as n8n raises it, or several declared start nodes. A batch size written as an expression is `v2-batch-config` (it was `v2-loop-shape`), and a Split In Batches at another version is `v2-batch-config` wherever the trigger reaches it (outside a cycle it used to be accepted).
  - **The analysis is the converted graph's.** `analysis.nodes` are the graph's nodes (the enabled nodes `rootAt` keeps, orphans of the splice included but not compiled), not every description node; a node `rootAt` drops and a disabled node the splice removes each get a diagnostic. The v1 connection validation (`canonicaliseConnections`, ports against the node type's counts) does not run under engineV2: n8n checks slots only by `validateExecutableGraph`'s rule, which `shape.ts` now applies in n8n's position, negative and fractional slots included, and a gadget reads only its edges. A reference to a node the converter dropped is still diagnosed as ignored.
  - **n8n's orders.** Nodes are visited in description order, which is `workflow.nodes` order on both adapters, and edges in connection order, which is the connections map's order on both; `componentsOf` is the same Tarjan as n8n's, and loops are validated in `deriveLoops`' order (first back edge). So, as far as a description keeps n8n's orders, the code on a multi-defect workflow is n8n's too. One test moved with it: on the nested-loop graph n8n validates Inner's loop first and names Outer inside it. `EngineV2Analysis.loops` stays in canvas order. The connection types are checked per node, not per entry of the connections map, the one order a description does not keep.
  - **Merge.** With `mergeMode` the predicate is literal: type `MERGE_TYPE` and mode `chooseBranch`, or a mode starting `=` at typeVersion ≥ 2. The `requiredInputs` reading of the review fixes remains only for a description without `mergeMode`. (Superseded below: the reading remains only on `MERGE_TYPE`, and both adapters now set `mergeMode` on every Merge, `null` when there is no string mode.)
  - **`NodeDescription` fields.** `mergeMode` (a Merge's string mode), `batch` (`batchSize` as written, `'expression'` for any string — n8n refuses `"10"` too — `NaN` for another value, `null` read as the default 1; `optionsExpression`; `reset` for any value but `false`) and `aiOutputs` (every type key of the node's connections-by-source entry but `main`, empty or not, and the `type` of each connection filed under `main` that is not `main`, `'undefined'` included, as `validateSupportedConnectionType` checks them). A `batch` left out means the parameters were not read, and n8n's default applies. They are filled by `n8n/adapter/engine-v2.ts` (`engineV2FieldsOf`) from `n8n/adapter/node.ts` and `verify/workflow-json/nodes.ts`, not from the shape modules the plan names: they are read off a node's parameters and connections, not off its type. None is hashed.
  - **Node ids.** Two corpus exports carry no usable ids (`4967.json` none, `4506.json` all empty). n8n's converter handed such an export makes every node sharing the trigger's missing id a trigger step, so its verdict on the raw export is an artifact (`4967`: "Graph must have exactly one trigger node"). n8n gives such nodes ids whenever a workflow is created or updated (`addNodeIds`, `cli/src/workflow-helpers.ts`), so the acceptance hands n8n the export with the ids the JSON reader assigns (`nodePrefixOf`) and lists the raw verdicts apart. A repeated non-empty id is not repaired by n8n and is renamed by our readers: that is divergence row 34, which now says so.
  - **Acceptance** (`tasks/v2-acceptance.mts`, n8n@2.41.3, libpetri 7.0.0 from the registry, `.node-types/catalogue.json`; about 6 s):
    - corpus: 310 entries, n8n accepts 209, ours 209. (1) 0 verdict disagreements. (2) 209 both-accept (20 with a batch loop): 0 node-set, edge-set (slots and `isBackEdge`) or compiled-set disagreements, and the compiled net has the same place, transition and arc counts as stage 1's net of n8n's own graph. (3) 101 both-refuse, 101 codes equal (33 `v2-converging-input`, 29 `v2-unbatched-cycle`, 23 `v2-continue-error-output`, 9 `v2-merge-mode`, 5 `v2-loop-shape`, 1 `v2-batch-config`, 1 `v2-trigger-count`), 0 multi-defect differences;
    - a leg the plan did not name, **mutants** (extended by the review fixes below to 12,019): each accepted entry changed in one place at a time — each reached node disabled, given `continueErrorOutput`, or an empty `ai_tool` group; each Merge's mode (`chooseBranch`, an expression at v3 and at v1); each Split In Batches' version, options expression, reset, size expression, size 0, size left out; the fired trigger misnamed. 4,817 mutants, n8n accepts 1,425, ours 1,425: 0 verdict, 0 graph and 0 code disagreements (3,392 both-refuse). In the corpus one accepted entry reaches a disabled node (`5626.json`) and one refused entry a misconfigured Split In Batches, so this leg is what tests the splice and `toBatchConfig`;
    - (4) drift: 38 throw sites in the 3 sources, 38 entries, 0 unmapped, 0 stale; and `isV2TriggerType` answers as n8n's `isTriggerNodeType` on all 853 node types of the corpus and the catalogue;
    - without the catalogue (`--no-catalogue`, every port count guessed) the corpus numbers are the same.

    Code differences on multi-defect workflows are reported apart by repairing n8n's named defect and converting again; none occurred.
  - **Unchanged.** The v1 fingerprint and the CI golden: `tasks/record-v2-golden.mts` re-run reports the golden `unchanged` and 0 findings. A 3 × 3 smoke run of `tasks/v2-differential.mts`: 0 findings.
  - **Tests.** `tests/compiler/v2/root.test.ts` (18: each ported function, citing its n8n rule, and `convertV2`'s refusal order), `tests/compiler/v2/port-golden.test.ts` (23: the port's graph of every committed testbed workflow equals n8n's converted graph recorded in the golden, each refused one gets the code of n8n's recorded refusal, and `--profile engineV2` accepts and refuses the same files, no `.n8n`), `tests/conformance/v2/drift.test.ts` (6: the map, `v2RefusalOf`, the parser, and the guard on n8n's sources, skipped without a checkout). `refusals.test.ts` is rewritten around the port (the fired trigger, splicing, `v2-batch-config`, `v2-connection-type`, the literal Merge mode; `twoTriggers` is now accepted, n8n's verdict); `analysis.test.ts`, `options.test.ts` (the trigger option), `tests/n8n/adapter.test.ts` and `tests/verify/workflow-json.test.ts` (the fields) and `tests/verify/v2-families.test.ts` (the CLI's `--trigger`, splicing, usage) are extended. Suite: 97 files, 1,765 tests.
- **Review fixes after step 13.** A review reproduced three findings against the pinned dist; each fix has a regression test that needs no `.n8n`, and the acceptance script now carries each raw-JSON reading as a mutant.
  - **Finding 1: row 34 claimed node ids were the only input the port did not see as n8n does.** It was false. Five raw-JSON inputs gave n8n's converter and ours different verdicts, because the JSON reader built the scheduler's graph before the port ran. Under `engineV2` the reader now hands the port n8n's workflow (`describeWorkflowJson`, `profile: 'engineV2'`):
    - (a) *a connections key that is no node* (`T → Ghost`, `Ghost → B`): n8n's `rootAt` is `getChildNodes` over the map by name, so it reaches B. New `WorkflowDescription.strayConnections` (`StrayConnections` in `types/input.ts`): `main`, every hop under a `main` key that `connections` cannot hold (a source or target that is no node, or a connection whose own `type` is not `main`, which `getChildNodes` follows too); `sources`, each key that is no node with its non-`main` types, which `toEdgesForSource` checks once the key is rooted (`checkV2StraySources`, after the nodes'). Read by `strayConnectionsIn` (`n8n/adapter/engine-v2.ts`); `rootAtTrigger` walks `connections` and the hops.
    - (b) *a main connection with no `index`, or a string one*: n8n copies it and `validateExecutableGraph` refuses "slot index undefined". `connectionsOf(…, engineV2)` reads a non-number as `NaN`, which the slot rule refuses (`input-index-out-of-range`, the code `V2_REFUSALS` maps). Every other v2 check compares slots with `===` / `!==`, where `NaN` behaves as `undefined` or `'1'` does. v1 still reads 0. (Refined in round 3 below: the written form is kept as `indexKey`, because n8n's dedupe key can drop such an edge first.)
    - (c) *a Merge version written as a string*: n8n's `typeVersion >= 2` converts it, so `'3'` refuses an expression mode, where the reader reads a non-number version as 1. New `NodeDescription.mergeVersion` (`Number(typeVersion)`, set on a Merge only when the version is not a number); the Merge check compares `mergeVersion ?? typeVersion`. The live adapter passes the version through as written. A Split In Batches needs nothing: `'3' !== 3` refuses it, and so does the reader's 1.
    - (d) *a sticky note on the main path* and (e) *a sub-node whose type reads as a trigger*: `nodesOf(root, keepAnnotations)` keeps every named node, and `scheduledNodesOf` is not applied. A nameless note is still dropped: `rootAt` keeps nodes by name and can reach none, and a note fails no converter check. (False, and superseded in round 3 below: a target with no `node` field reaches every nameless node.)

    The same change fixes **finding 2** (the codes on both-refuse cases): with no trigger nothing is rooted and n8n checks a sub-node (`v2-connection-type`, or `v2-continue-error-output` first); a note or sub-node named as the fired trigger is found and is `v2-not-a-trigger`, not `v2-unknown-trigger`. A workflow of notes only is `v2-trigger-count`: `graph.ts` raises `empty-workflow` under v1 only, and under `engineV2` an empty workflow goes to the port, which refuses it as having no trigger, as n8n does. Shapes are now computed for every node under `engineV2`, since a rooted note is converted.
  - **Finding 3: the Merge fallback refused nodes n8n accepts.** `isChooseBranchMerge` read `requiredInputs` on any type, and on a Merge whose reader found no mode. n8n's `assertSupportedMergeMode` runs on `MERGE_TYPE` only and reads `parameters.mode`. Now the fallback is on `MERGE_TYPE` only, and only when `mergeMode` is absent (a hand-written description); both adapters set `mergeMode` on every Merge, `null` when the parameters hold no string mode. `checkV2ConvertedNode` no longer takes the incoming edges. So the compiler fixtures `chooseBranch` and `partialRequired`, whose join is on the test types `mergeChoose` / `merge3Choose`, are now **accepted** under `engineV2` (their `requiredInputs` diagnosed), which is n8n's verdict on a node of a type it does not check; `options.test.ts`, `structure.test.ts` and `v2-families.test.ts` now compile, hash and verify them as subjects (every check proven), and `refusals.test.ts` pins them `accepted`.
  - **Not fixed, recorded in row 34.** A description is keyed by name, so an export with a repeated name, or a nameless node other than a note, is refused by the reader with a plain error, where n8n accepts the repeat (reproduced: `T → A` beside a second `A`, both in its graph) and drops a nameless node the trigger does not reach. Exports n8n's converter crashes on (`TypeError`: a converted Merge with no `parameters`, a reached `null` connections entry or a non-array group) have no throw site to map, and the reader skips what it cannot read; the review's malformed-input fuzz, rerun after the fixes on 40,000 workflows (seeds 7 and 11), leaves only that class: 321 crashes, every one a converted Merge with no `parameters`, one of which the port accepts, and 0 other verdict or code differences; its realistic mode (seed 23, 20,000 workflows) has none. The live adapter still describes the scheduler's graph; no execution path compiles `engineV2` from it, and `tasks/todo.md` keeps it open.
  - **Acceptance** (`tasks/v2-acceptance.mts`, n8n@2.41.3, libpetri 7.0.0 from the registry, catalogue; 11.8 s). New mutations, per reached node: `ghostHop`, `indexMissing`, `indexString`, `mergeVersionString`, `stickyOnPath`, `triggerSubNode`; per entry: `stickyTrigger` (a note added and named as the fired trigger). Corpus unchanged: 310 entries, 209 accepted by both, 0 verdict, graph or code disagreements, 101 codes equal. Mutants: 12,019, n8n accepts 4,558, ours 4,558; 0 verdict, 0 graph, 0 code disagreements (7,461 both-refuse, all codes equal, none multi-defect). Drift: 38 sites, 0 unmapped, 0 stale; trigger rule equal on 853 types. `--no-catalogue`: the same numbers. With the index or stray-connection reading reverted, the first 30 files alone give 517 verdict disagreements (233 `indexMissing`, 233 `indexString`, 51 `ghostHop`), so the leg detects the defects it is there for.
  - **Unchanged.** The v1 fingerprint (`v1-identity.test.ts`), the CI golden `tests/fixtures/v2/settlement-golden.json` (not re-recorded: no committed graph's conversion changed) and `port-golden.test.ts`. Suite: 97 files, 1,795 tests.
- **Review fixes after step 13, round 3.** A third review reproduced five findings against the pinned dist (`/private/tmp/claude-501/r3/cases.mts`, `cases2.mts`). Four are fixed and one is recorded, not reproduced; each has a regression test that needs no `.n8n`. Every verdict below was re-measured against n8n@2.41.3's converter and validator with a scratch harness before the test was written.
  - **Finding 1: `dedupeEdges` keyed by name.** n8n keys `${from}|${to}|${outputIndex}|${inputIndex}` over node **ids**, so ids that hold `|` can print one key for two edges (`x|y → z` and `x → y|z`), and n8n keeps only the later: T, A (`x|y`), B (`z`), C (`x`), D (`y|z`) with T → A, T → C, A → B, C → D is accepted with edges T → A, T → C, C → D, and B never runs. The port keyed by name with a `\u0000` separator and kept all four. Now `dedupeEdges(edges, idOf)` and `spliceDisabled(edges, disabled, idOf)` print n8n's key over the description's ids (`V2IdOf`; a test may key by name, the default), and `convertV2` passes the kept nodes' ids. The value kept is still the key's last, at its first position (`Map.set`), so a spliced edge that collides replaces an earlier one, as in n8n. A reader-renamed id (repeated, missing, or holding `/`) keys differently from n8n: row 34's node-id divergence, which now says so.
  - **Finding 2: an index written `'0'` beside a `0`.** The key prints the index as written, so `'0'` and a later `0` on the same `from → to` output are one key holding the `0`, and n8n accepts; in the other order it refuses ("slot index 0"). The port refused both (`NaN`). New `MainConnection.indexKey` (`String(index)`, set by `connectionsOf` under `engineV2` only when the index is not a number); the dedupe key reads `indexKey ?? inputIndex`, and the splice carries it from the edge out of the disabled node. `[0]` (an array) prints `0` too and is handled alike. Nothing else reads it: the slot rule still sees `NaN`, and the structural hash hashes `inputIndex`. Row 34's rationale ("its slot rule refuses it") was incomplete and now names the dedupe.
  - **Finding 3: a guessed count from a slot no count can hold.** With no catalogue entry (a community node, or `--no-catalogue`), `guessedShapeOf` took `maxInput + 1` from every connection, so a fractional `index` of 1.5 made `inputCount` 2.5 and `validateDescription` refused `invalid-count` — a code outside `V2_REFUSALS`, before the port ran, even on an edge `rootAt` drops (n8n accepts T → A beside an unrooted U → A.1.5). Under `engineV2` the reader now guesses only from connections whose input slot is a non-negative safe integer; a count plays no part in a v2 verdict (the slot rule judges slots, once rooted). v1 is unchanged. The reviewer's slots fuzz without the catalogue (20,000 workflows, seed 15), rerun: 0 verdict and 0 code differences (it was 1 and 1).
  - **Finding 4: nameless sticky notes.** The claim that n8n can never reach one was false. A `main` target with no `node` field makes `getChildNodes` return `undefined`, `rootAt`'s `reachable.has(node.name)` then keeps every node without a name, `toEdges` maps the target to the last of them (`idsByName.get(undefined)`), and `toGraphNode` checks each: n8n accepts T → {no node} beside a nameless note as nodes [T, note] with an edge into it, and refuses it with the note on `continueErrorOutput`. The walk also goes on through the map's key `'undefined'` (`connections[undefined]`) without keeping a node of that name. Now, under `engineV2`, `nodesOf` keeps a note with no `name` field under a name of its own (`(nameless nodes[i])`, primed until no node has it; `JsonNodes.nameless`), `connectionsOf` reads a target with no `node` as naming the last of them, and `strayConnectionsIn` makes such a target a hop to every nameless note and to each `main` target of the key `'undefined'`. A note whose `name` is present but not a non-empty string is still dropped, and a target whose `node` is present but not a string still skipped, both recorded in row 34 (measured: a note named `''`, `null` or `5` on `continueErrorOutput`, reached by a target naming that value, is refused by n8n and accepted by the port); the `''` case would also need the connections key `''` read as that note's, and no export n8n writes has either. v1 still drops every note.
  - **Finding 5: a node named `hasOwnProperty`. Recorded, not reproduced.** n8n's `getConnectedNodes` calls `connections.hasOwnProperty(nodeName)`, so a connections key `hasOwnProperty` makes it throw `TypeError` whenever a fired trigger is rooted — measured: reached or not (T → A beside an unreached `hasOwnProperty → B` crashes too), and not when there is no trigger (`rootAt` does not run). A node the walk visits whose entry has a type key `hasOwnProperty` crashes it too (`connections[nodeName].hasOwnProperty`), where the port refuses `v2-connection-type`. A crash is not a refusal: there is no throw site for `V2_REFUSALS` to map, and the register already treats the converter's `TypeError`s this way, so the port gives the verdict the rest of the workflow earns and row 34 lists it among "Exports n8n's converter crashes on". The test pins the port's verdict so a change to it is seen.
  - **Acceptance** (`tasks/v2-acceptance.mts`, n8n@2.41.3, libpetri 7.0.0 from the registry, catalogue; 19.8 s). New mutations, per reached node: `indexStringFirst` (the first incoming connection preceded by a copy with its index written as a string), `namelessNote` and `namelessNoteErrorOutput` (a nameless note added and a target with no `node` on the node's output 0), `pipeIds` (ids holding `|`, arranged so an added edge prints the key of the node's first incoming edge). A both-accept graph now names a nameless node of n8n's graph by the name the reader gives the node of the same id. Corpus unchanged: 310 entries, 209 accepted by both; 0 verdict, graph or code disagreements; 101 codes equal. Mutants: 17,587, n8n accepts 8,446, ours 8,446; 0 verdict, 0 graph and 0 code disagreements (9,141 both-refuse, all codes equal, none multi-defect). Drift: 38 sites, 0 unmapped, 0 stale; the trigger rule is equal on 853 types. `--no-catalogue`: the same numbers. With the name-keyed dedupe and the dropped nameless notes restored, the first 30 files alone give 941 disagreements (239 `indexStringFirst`, 241 `namelessNote`, 241 `namelessNoteErrorOutput`, 220 `pipeIds`), so the new mutants detect the defects they are there for. Finding 3 has no mutant: no mutation writes a fractional index, and the catalogue gives every corpus type its count.
  - **The reviewer's fuzzers, rerun** (copies in the session scratchpad, so the reviewer's outputs are not overwritten, except one: the first rerun of the slots mode without the catalogue wrote `/private/tmp/claude-501/r3/out-slots-15-nocat.json`): names mode (seed 13, 20,000) and slots mode (seed 12, 20,000, catalogue) 0 differences; slots mode without the catalogue (seed 15) 0; corpus multi-mutation (seed 3, catalogue) 0; its no-catalogue run (seed 4) reports one graph difference on `5385.json`, a harness artifact: n8n names the nameless note `undefined` and ours `(nameless nodes[3])`, the ids are equal (s3 in both, checked), and the harness's stage-1 leg cannot describe n8n's graph with several nameless nodes ("two nodes are named 'undefined'").
  - **Unchanged.** The v1 fingerprint (`v1-identity.test.ts`), the CI golden `tests/fixtures/v2/settlement-golden.json` (not re-recorded: no committed graph's conversion changed) and `port-golden.test.ts`. Suite: 97 files, 1,803 tests.
