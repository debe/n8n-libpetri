/**
 * The graph shapes engine v2 refuses, as `CompileError`s (`tasks/v2-profile-plan.md` step 4):
 * what `validateLoops` (`@n8n/engine` `graph/loops.ts`) and `validateExecutableGraph`
 * (`@n8n/engine` `graph/validate-executable-graph.ts`) throw on, run on the graph the converter
 * port built (`root.ts`, which also marked the back edges and refused what `markBackEdges`
 * refuses), in n8n's order, each predicate as n8n writes it and each refusal by its
 * `V2_REFUSALS` entry (`refusals.ts`).
 *
 * | code | n8n |
 * |---|---|
 * | `v2-unbatched-cycle` | `validateLoops` rule 1 |
 * | `v2-loop-shape` | every other `validateLoops` throw a converted graph can reach |
 * | `v2-unreachable-feeder` | `validateExecutableGraph`: an edge from a node the trigger cannot reach |
 * | `output-` / `input-index-out-of-range` | `validateExecutableGraph`: a slot that is negative, fractional or above `MAX_SLOT_INDEX` |
 * | `v2-converging-input` | `validateExecutableGraph`: two non-back edges into one input slot |
 *
 * `validateExecutableGraph`'s trigger count is `root.ts`'s (the converter makes at most one
 * trigger step). `validateLoops`' prerequisites (unique ids, edges between known nodes) are the
 * v1 validation's already, and four of its throws cannot fire on marks `markBackEdges` made or
 * on batch nodes `toBatchConfig` accepted — a return edge into a node that is not a batch node,
 * or from outside its loop, a batch node without a whole batch size, a second trigger — so they
 * are `InternalCompilerError`s (`refuseV2` on an entry with no code).
 *
 * **With several defects the code is the first n8n meets, as far as the orders agree.** The
 * components are visited in the order n8n's Tarjan visits them: the caller passes the nodes in
 * the converter's node order and the edges in its edge order (`root.ts`), and `componentsOf` is
 * the same Tarjan. Loops come in n8n's order too: `deriveLoops` lists them by the first back
 * edge into each batch node, in edge order.
 */
import type { EdgeRef, EngineV2Analysis, NodeDescription, V2EdgeClass, V2Loop } from '../../types.js';
import { reachFrom } from '../reachability.js';
import { DONE_SLOT, isV2BatchNode, LOOP_SLOT, MAX_SLOT_INDEX } from './batch.js';
import { classifyV2Edge, componentsOf, deriveV2Loops, isCyclicComponent } from './loops.js';
import { DEFAULT_BATCH_SIZE } from './nodes.js';
import { refuseV2 } from './refusals.js';

/** What {@link checkV2Shape} reads: the converted graph and its marks. */
export interface V2ShapeInput {
  /** The graph's nodes, in the converter's order. */
  readonly nodes: readonly NodeDescription[];
  /** The graph's edges, in the converter's order. */
  readonly edges: readonly EdgeRef[];
  readonly trigger: string;
  /** The ids of the edges `markBackEdges` marked `isBackEdge`. */
  readonly back: ReadonlySet<number>;
}

/** An accepted graph's facts: the compiled node set and the loops. */
export interface V2Shape {
  /** The trigger and its descendants over every edge (`getDescendantNodeIds`). */
  readonly reachable: ReadonlySet<string>;
  readonly engineV2: EngineV2Analysis;
}

/**
 * Refuses what engine v2 refuses (see the module table) and returns the loops and edge classes
 * of what it accepts.
 */
export function checkV2Shape({ nodes, edges, trigger, back }: V2ShapeInput): V2Shape {
  const names = nodes.map((n) => n.name);
  const batchNodes = new Set(nodes.filter(isV2BatchNode).map((n) => n.name));
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const list = (members: readonly string[]): string => [...members].sort().join(', ');
  const isBack = (e: EdgeRef): boolean => back.has(e.id);

  // ---- validateLoops (graph/loops.ts) ----
  // Rule 1: with the back edges removed, nothing is cyclic. Marks made by `markBackEdges`
  // always leave an acyclic rest; checked because it is n8n's rule, not ours.
  const forward = edges.filter((e) => !isBack(e));
  for (const members of componentsOf(names, forward)) {
    if (isCyclicComponent(members, forward)) {
      refuseV2('forwardCycle',
        `nodes ${list(members)} form a cycle with no back-edge to close it, so none of them can ever become ` +
        'runnable (validateLoops rule 1, graph/loops.ts)', members[0]);
    }
  }
  const loops = deriveV2Loops(names, edges, back);
  const loopByBatch = new Map(loops.map((loop) => [loop.batchNode, loop]));
  // Rule 3, the "none" case, over batch nodes: one with no return edge heads no loop.
  for (const b of names) {
    if (batchNodes.has(b) && !loopByBatch.has(b)) {
      refuseV2('noBackEdge',
        `batch node '${b}' has no back-edge returning to it, so its loop could never advance ` +
        '(validateLoops rule 3, graph/loops.ts)', b);
    }
  }
  // `deriveLoops` lists the loops by their first back edge, in edge order.
  const position = new Map(edges.map((e, i) => [e.id, i]));
  const firstBack = (loop: V2Loop): number => Math.min(...loop.backEdges.map((e) => position.get(e.id)!));
  for (const loop of [...loops].sort((x, y) => firstBack(x) - firstBack(y))) {
    checkLoop(loop, edges, isBack, batchNodes, byName, trigger);
  }

  // ---- validateExecutableGraph (graph/validate-executable-graph.ts) ----
  const succ = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of edges) succ.get(e.from)!.push(e.to);
  const reachable = reachFrom([trigger], succ, null);
  for (const e of edges) {
    if (reachable.has(e.to) && !reachable.has(e.from)) {
      refuseV2('unreachableFeeder',
        `edge ${e.from} -> ${e.to} feeds a node the trigger reaches from one it cannot reach, so '${e.to}' ` +
        `would wait on '${e.from}' forever (validateExecutableGraph, validate-executable-graph.ts)`, e.from);
    }
  }
  for (const e of edges) {
    for (const side of ['output', 'input'] as const) {
      const index = side === 'output' ? e.outputIndex : e.inputIndex;
      const code = side === 'output' ? 'output-index-out-of-range' : 'input-index-out-of-range';
      const node = side === 'output' ? e.from : e.to;
      if (!Number.isInteger(index) || index < 0) {
        refuseV2('slotNotNonNegative', `edge ${e.from} -> ${e.to} has slot index ${index}; slot indices are ` +
          'non-negative integers (validateExecutableGraph, validate-executable-graph.ts)', node, code);
      }
      if (index > MAX_SLOT_INDEX) {
        refuseV2('slotAboveMax', `edge ${e.from} -> ${e.to} has slot index ${index}; engine v2 supports no slot above ` +
          `${MAX_SLOT_INDEX} (validateExecutableGraph, validate-executable-graph.ts)`, node, code);
      }
    }
  }
  const seenSlots = new Set<string>();
  for (const e of forward) {
    const slot = `${e.to}#${e.inputIndex}`;
    if (seenSlots.has(slot)) {
      refuseV2('convergingInput',
        `node '${e.to}' has more than one edge into input slot ${e.inputIndex}; engine v2 does not converge ` +
        'branches on one slot (validateExecutableGraph, validate-executable-graph.ts)', e.to);
    }
    seenSlots.add(slot);
  }

  const loopOf = new Map<string, V2Loop>();
  for (const loop of loops) for (const m of loop.members) loopOf.set(m, loop);
  const edgeClass = new Map<number, V2EdgeClass>(edges.map((e) => [e.id, classifyV2Edge(e, isBack(e), loops)]));
  return { reachable, engineV2: { trigger, loops, loopOf, edgeClass } };
}

/** `validateLoops`' per-loop rules, in n8n's order. */
function checkLoop(
  loop: V2Loop,
  edges: readonly EdgeRef[],
  isBack: (e: EdgeRef) => boolean,
  batchNodes: ReadonlySet<string>,
  byName: ReadonlyMap<string, NodeDescription>,
  trigger: string,
): void {
  const { batchNode: b, members } = loop;
  const at = '(validateLoops, graph/loops.ts)';
  // Rule 2's target. `markBackEdges` marks only edges into a batch entry.
  if (!batchNodes.has(b)) refuseV2('notBatchTarget', `a back edge returns into '${b}', which is not a batch node ${at}`, b);
  // `toBatchConfig` refused every other size before the converter made this a batch step.
  const size = byName.get(b)!.batch?.batchSize ?? DEFAULT_BATCH_SIZE;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    refuseV2('noBatchSize', `batch node '${b}' has no batch size, and it must be a whole number of at least 1 ${at}`, b);
  }
  if (members.has(trigger)) {
    refuseV2('triggerInLoop', `trigger '${trigger}' is inside the loop of '${b}', so that loop could never start ${at}`, b);
  }
  for (const m of members) {
    if (m !== b && batchNodes.has(m)) {
      refuseV2('nestedLoop',
        `batch node '${m}' sits inside the loop of '${b}'; engine v2 does not support nested loops ` +
        `(UnimplementedError) ${at}`, m);
    }
  }
  // Rule 2's slot and direction: a return arrives on slot 0, from a member.
  for (const e of loop.backEdges) {
    if (e.inputIndex !== 0) {
      refuseV2('backEdgeSlot',
        `back-edge ${e.from} -> ${e.to} feeds input slot ${e.inputIndex}; returns feed the batch node's slot 0 ${at}`, b);
    }
    if (!members.has(e.from)) refuseV2('backEdgeFromOutside', `back-edge ${e.from} -> ${e.to} returns from outside the loop ${at}`, b);
  }
  // Rule 3, the "several" case.
  if (loop.backEdges.length > 1) {
    refuseV2('severalBackEdges',
      `batch node '${b}' has ${loop.backEdges.length} back-edges; engine v2 does not converge returns on one ` +
      `input slot (UnimplementedError) ${at}`, b);
  }
  // Rule 4: the batch node's own slots, whether or not the edge crosses the loop boundary.
  for (const e of edges) {
    if (e.to === b && !isBack(e) && e.inputIndex !== 0) {
      refuseV2('batchInputSlot',
        `edge ${e.from} -> ${e.to} feeds input slot ${e.inputIndex} of a batch node, which has only slot 0 ${at}`, b);
    }
    if (e.from === b && e.outputIndex !== DONE_SLOT && e.outputIndex !== LOOP_SLOT) {
      refuseV2('batchOutputSlot',
        `edge ${e.from} -> ${e.to} leaves output slot ${e.outputIndex} of a batch node, which has only done ` +
        `(${DONE_SLOT}) and loop (${LOOP_SLOT}) ${at}`, b);
    }
  }
  // One entry edge, after rule 4 so an impossible slot is reported as such.
  if (loop.entryEdges.length > 1) {
    refuseV2('severalEntries',
      `batch node '${b}' has ${loop.entryEdges.length} entry edges; engine v2 does not converge entries on its ` +
      `input slot (UnimplementedError) ${at}`, b);
  }
  // Rule 5, the way out: only the done slot of the batch node leaves the loop.
  for (const e of loop.exitEdges) {
    if (e.from !== b) {
      refuseV2('midBodyExit',
        `edge ${e.from} -> ${e.to} leaves the loop of '${b}' mid-body; engine v2 does not support dangling ` +
        `body branches (UnimplementedError) ${at}`, e.from);
    }
    if (e.outputIndex !== DONE_SLOT) {
      refuseV2('loopSlotExit',
        `edge ${e.from} -> ${e.to} leaves the loop from the loop slot; only the done slot (${DONE_SLOT}) exits ${at}`, b);
    }
  }
  for (const e of edges) {
    // Rule 5, where the done slot may point, marked edges included.
    if (e.from === b && e.outputIndex === DONE_SLOT && members.has(e.to)) {
      refuseV2('doneFeedsMember',
        `done slot of '${b}' feeds '${e.to}', a member of its own loop; a node cannot run both per iteration ` +
        `and after the loop ${at}`, b);
    }
    // Rule 5, the way in: the batch node is the only entrance to the body.
    if (!isBack(e) && members.has(e.to) && e.to !== b && !members.has(e.from)) {
      refuseV2('midBodyEntry',
        `edge ${e.from} -> ${e.to} enters the loop of '${b}' mid-body; the batch node is the only way in ${at}`, e.to);
    }
  }
}
