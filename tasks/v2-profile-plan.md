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
    - on any other type, it counts when those inputs make v1's `choose-branch` join. The fixtures `mergeChoose` / `merge3Choose` are caught this way. No other n8n type is: CompareDatasets' `requiredInputs: 1` names no input, and ModelSelector has one main input.

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
- **The raw-JSON route is not yet an acceptance path.** Going through `describeWorkflowJson` and
  the catalogue, then engineV2, still refuses 75 entries n8n accepts: 25 `v2-loop-shape`, 23
  `v2-converging-input`, 21 `v2-unreachable-feeder`, 5 `v2-unbatched-cycle` and 1
  `v2-disabled-node`. The cause is that rooting at the fired trigger, disabled-node splicing and
  back-edge marking are not ported yet (step 13). Stage 1 (`graphToDescription` from n8n's own
  converted graph) compiles all 209 n8n-accepted entries and refuses none.
