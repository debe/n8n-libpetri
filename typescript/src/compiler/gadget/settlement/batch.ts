/**
 * An `engineV2` batch node's transitions (`tasks/v2-profile-plan.md` decisions 5 and 6): engine
 * v2's `batch` step, a Split In Batches v3 (`isV2BatchNode`), which heads the one loop engine v2
 * admits. Its slot 0 has two edges that never apply at one pass (`resolveInputReads`,
 * `execution/step-ready-handler.ts`): the entry `E` at pass 0 and the return `K` at every later
 * pass (`sourceRow`, `execution/iteration-mapping.ts`). Each gets its own start and skip, over the
 * one `B/live`:
 *
 * ```
 * B_start_entry: one(E/arrived), all(B/live)  inhibitor(_halt)        → B/running
 * B_skip_entry:  one(E/arrived)  inhibitor(B/live) inhibitor(_halt)    → and(x/arrived per exit x, B/ended)
 * B_start_back:  one(K/arrived), all(B/live)  inhibitor(_halt)        → B/running
 * B_skip_back:   one(K/arrived)  inhibitor(B/live) inhibitor(_halt)    → and(x/arrived per exit x, B/ended)
 * B_run:         one(B/running) → xor(loop, doneData, doneEmpty, halt)
 * ```
 *
 * | `B_run` branch | writes | `runBatchStep` (`execution/batch-step.ts`) |
 * |---|---|---|
 * | `loop` | every loop-slot edge's `arrived`, and its consumer's `live` | `[null, slice]`: a pass |
 * | `doneData` | every exit's `arrived` and its consumer's `live`, `B/ended` | `[accumulated, null]` |
 * | `doneEmpty` | every exit's `arrived`, `B/ended` | `[null, null]`: nothing accumulated |
 * | `halt` | `_halt`, `B/ended` | the step failed (`runBatchNode` runs inside the step's `try`) |
 *
 * That is `batchStepDecides` (`execution/settlement.ts`): a batch step decides one side of its
 * loop only. A pass that filled the loop slot decides the body and leaves the exits undecided; a
 * terminal step — settled with its loop slot unfilled (`isTerminalStep`,
 * `execution/loop-ledger.ts`): a skip, a completion on the done slot or on neither, a failure —
 * decides the exits and writes nothing into the body, which is `isPastLoopEnd`: body steps exist
 * for running passes only. A consumer of an exit waits on its `arrived` like on any edge, so it
 * stays undecided until the loop has ended, which is `sourceRow`'s `pending`.
 *
 * `B/ended` is the loop's terminal row, and the loop's only marker: the batch node and its members
 * carry no `done` / `skipped` (decision 6, `places.ts`). The halt branch writes it too, because a
 * failed batch step is settled and its loop slot unfilled, so `isTerminalStep` holds, as a failed
 * row writes `X/done` outside a loop. With no exit edge (`validateLoops` allows a loop with no
 * way out), `doneData` and `doneEmpty` write the same places and are one branch.
 *
 * On a self loop (`B`'s loop slot is its own return edge) the loop branch writes `K/arrived` and
 * `B/live`, which `B_start_back` consumes: `bind` gives each place one `inout` port.
 */
import { Transition, all, one, outPlace } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { assertNever } from '../../../internal/assert.js';
import { DONE_SLOT, LOOP_SLOT } from '../../analysis/engine-v2/batch.js';
import { InternalCompilerError } from '../../errors.js';
import { PLACE, TRANSITION } from '../../names.js';
import type { EdgeRef } from '../../types.js';
import { andOf, xorOf } from '../out-spec.js';
import type { SettlementNodeNames } from './node.js';
import { arrivedOf, haltOf, liveHostOf, type SettlementContext, type SettlementMarkers } from './places.js';
import { arrivalsOf, livesOf, type SettlementRouting } from './routing.js';

/** What {@link buildBatchNode} declared and emitted, over local places. */
export interface BatchNode {
  /** `start` / `skip` are the entry pair `B_start_entry` / `B_skip_entry`. */
  readonly names: SettlementNodeNames;
  readonly startBack: string;
  readonly skipBack: string;
  readonly entry: EdgeRef;
  readonly back: EdgeRef;
  readonly ended: Place<unknown>;
  /** Kind `batch`: the connected slots of {@link DONE_SLOT} and {@link LOOP_SLOT}, ascending. */
  readonly routing: SettlementRouting;
}

/** The loop's one edge of `what`, which `validateLoops` and decision 9 leave exactly one of. */
function onlyEdge(edges: readonly EdgeRef[], what: string, node: string): EdgeRef {
  const [e] = edges;
  if (e === undefined || edges.length !== 1) {
    throw new InternalCompilerError(`internal: batch node '${node}' is compiled with ${edges.length} ${what} edges`);
  }
  return e;
}

/** Batch node `ctx.name`'s places past the markers, and its five transitions in declaration order. */
export function buildBatchNode(ctx: SettlementContext, markers: SettlementMarkers): BatchNode {
  const { name, loop, incoming, outgoing, emit } = ctx;
  if (loop === null || loop.batchNode !== name) {
    throw new InternalCompilerError(`internal: batch node '${name}' heads no loop`);
  }
  // `validateLoops`: exactly one return edge. A compiled batch node is reached from the trigger,
  // which is outside the loop, and a way into the body other than the batch node is refused, so
  // the entry exists and is unique too. Nothing else feeds slot 0, the only slot (rule 4).
  const back = onlyEdge(loop.backEdges, 'back', name);
  const entry = onlyEdge(loop.entryEdges, 'entry', name);
  const ids = new Set(incoming.map((e) => e.id));
  if (ids.size !== 2 || !ids.has(back.id) || !ids.has(entry.id)) {
    throw new InternalCompilerError(`internal: batch node '${name}' has incoming edges other than its entry and return`);
  }
  // Rule 4: only the done and the loop slot; rule 5: only the done slot leaves the loop.
  const exits = outgoing.filter((e) => e.outputIndex === DONE_SLOT);
  const body = outgoing.filter((e) => e.outputIndex === LOOP_SLOT);
  if (exits.length + body.length !== outgoing.length) {
    throw new InternalCompilerError(`internal: batch node '${name}' has an edge from a slot other than done and loop`);
  }

  const ended = ctx.internal(PLACE.ended, 'ended', null);
  const halt = haltOf(ctx);
  const live = ctx.bind(liveHostOf(ctx, name), PLACE.live, 'input');
  const terminal = (): Out => andOf([...arrivalsOf(ctx, exits), outPlace(ended)]);

  // ---- the start and skip of each edge into slot 0 ----
  const pair = (e: EdgeRef, startName: string, skipName: string): { start: string; skip: string } => ({
    start: emit(Transition.builder(startName)
      .inputs(one(arrivedOf(ctx, e, 'input')), all(live))
      .inhibitor(halt)
      .outputs(outPlace(markers.running))
      .build(), { role: 'start' }),
    skip: emit(Transition.builder(skipName)
      .inputs(one(arrivedOf(ctx, e, 'input')))
      .inhibitors(live, halt)
      .outputs(terminal())
      .build(), { role: 'skip', combination: [] }),
  });
  const onEntry = pair(entry, TRANSITION.startEntry, TRANSITION.skipEntry);
  const onBack = pair(back, TRANSITION.startBack, TRANSITION.skipBack);

  // ---- B_run: one side of the loop ----
  const pass = andOf([...arrivalsOf(ctx, body), ...livesOf(ctx, body)]);
  const done: Out[] = exits.length === 0
    ? [terminal()]
    : [andOf([...arrivalsOf(ctx, exits), ...livesOf(ctx, exits), outPlace(ended)]), terminal()];
  const halted = andOf([outPlace(halt), outPlace(ended)]);
  let outcome: Out;
  switch (ctx.failure) {
    case 'never': outcome = xorOf([pass, ...done]); break;
    case 'possible': outcome = xorOf([pass, ...done, halted]); break;
    default: outcome = assertNever(ctx.failure, 'settlement failure');
  }
  const run = emit(Transition.builder(TRANSITION.run)
    .inputs(one(markers.running))
    .outputs(outcome)
    .build(), { role: 'run', attempt: 1 });

  const slots = [{ index: DONE_SLOT, edges: exits }, { index: LOOP_SLOT, edges: body }].filter((s) => s.edges.length > 0);
  return {
    names: { start: onEntry.start, skip: onEntry.skip, run },
    startBack: onBack.start,
    skipBack: onBack.skip,
    entry,
    back,
    ended,
    routing: { kind: 'batch', outputs: slots.map((s) => ({ ...s, ok: null })) },
  };
}
