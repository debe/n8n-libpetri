/**
 * The graph shapes engine v2 refuses, as `CompileError`s (`tasks/v2-profile-plan.md` step 4):
 * what `V1WorkflowConverter.markBackEdges` (`node-engine-compatibility`
 * `v1-workflow-converter.ts`), `validateLoops` (`@n8n/engine` `graph/loops.ts`) and
 * `validateExecutableGraph` (`@n8n/engine` `graph/validate-executable-graph.ts`) throw on,
 * checked in the order n8n reaches them, each predicate as n8n writes it.
 *
 * | code | n8n |
 * |---|---|
 * | `v2-trigger-count` | `validateExecutableGraph`: no trigger, or more than one |
 * | `v2-unbatched-cycle` | `markBackEdges` → `UnsupportedCycleError`; `validateLoops` rule 1 |
 * | `v2-loop-shape` | `markBackEdges` → `UnsupportedLoopEntryError`; every other `validateLoops` throw |
 * | `v2-unreachable-feeder` | `validateExecutableGraph`: an edge from a node the trigger cannot reach |
 * | `output-` / `input-index-out-of-range` | `validateExecutableGraph`: a slot above `MAX_SLOT_INDEX` |
 * | `v2-converging-input` | `validateExecutableGraph`: two non-back edges into one input slot |
 *
 * `validateLoops`' own prerequisites (unique ids, edges between known nodes) and the
 * non-negative-integer slot rule are the v1 validation's already (`duplicate-node-id`,
 * `unknown-connection-node`, the index range checks), which runs first. Two `validateLoops`
 * throws cannot fire on marks {@link markV2BackEdges} made — a return edge into a node that is
 * not a batch node, or from outside its loop — so they are `InternalCompilerError`s here.
 * The per-node refusals (`continueErrorOutput`, a chooseBranch Merge, a disabled node, a step
 * with no executor) are `nodes.ts`'s.
 *
 * **What is mirrored exactly is accept versus refuse, not which code a refusal carries.** A graph
 * with one defect gets the code of that defect. A graph with several gets the first one this
 * module meets, and that need not be the one n8n throws first: `markBackEdges` and
 * `validateLoops` visit components in their own Tarjan order, which depends on node and edge
 * order, while {@link componentsOf} runs over canvas order. Measured in review of steps 1–7 on
 * 20,000 random graphs against n8n's own converter and validator: the code differed on 16, each
 * a graph with several defects, and accept versus refuse on none. Chasing n8n's order would tie the
 * refusal to an iteration order n8n does not specify; step 13's acceptance leg compares
 * verdicts on every entry and codes only on single-defect graphs.
 */
import { CompileError, InternalCompilerError } from '../../errors.js';
import type { EdgeRef, EngineV2Analysis, NodeDescription, V2EdgeClass, V2Loop, WorkflowDescription } from '../../types.js';
import { reachFrom } from '../reachability.js';
import { DONE_SLOT, hasLiteralBatchSize, isV2BatchNode, LOOP_SLOT, MAX_SLOT_INDEX } from './batch.js';
import {
  classifyV2Edge, componentsOf, deriveV2Loops, isCyclicComponent, markV2BackEdges,
} from './loops.js';

/**
 * The trigger of an `engineV2` description: its one start node. `validateExecutableGraph`
 * refuses a graph with no trigger and one with several, and the converter makes exactly the
 * fired trigger a `trigger` step, so a description names one start node or it is refused.
 * Checked before the v1 start-node validation, so that none at all is this refusal too.
 */
export function v2TriggerOf(workflow: WorkflowDescription): string {
  const declared = new Set(workflow.startNodes ?? (workflow.startNode === undefined ? [] : [workflow.startNode]));
  const [trigger] = declared;
  if (trigger === undefined || declared.size > 1) {
    throw new CompileError('v2-trigger-count',
      `compile: engine v2 starts from exactly one trigger, and the workflow declares ${declared.size} start nodes` +
      (declared.size > 1 ? ` (${[...declared].join(', ')})` : '') +
      ' (validateExecutableGraph, validate-executable-graph.ts)');
  }
  return trigger;
}

/** What {@link checkV2Shape} reads: the nodes in canvas order, the analysis's edges, the trigger. */
export interface V2ShapeInput {
  readonly nodes: readonly NodeDescription[];
  readonly edges: readonly EdgeRef[];
  readonly trigger: string;
}

/** An accepted graph's facts: the compiled node set and the loops. */
export interface V2Shape {
  /** The trigger and its descendants over every edge (`getDescendantNodeIds`). */
  readonly reachable: ReadonlySet<string>;
  readonly engineV2: EngineV2Analysis;
}

const refuse = (code: 'v2-unbatched-cycle' | 'v2-loop-shape' | 'v2-converging-input' | 'v2-unreachable-feeder',
  message: string, node: string): never => {
  throw new CompileError(code, `compile: ${message}`, node);
};

/**
 * Refuses what engine v2 refuses (see the module table) and returns the loops and edge classes
 * of what it accepts.
 */
export function checkV2Shape({ nodes, edges, trigger }: V2ShapeInput): V2Shape {
  const names = nodes.map((n) => n.name);
  const batchNodes = new Set(nodes.filter(isV2BatchNode).map((n) => n.name));
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const list = (members: readonly string[]): string => [...members].sort().join(', ');

  // ---- markBackEdges (the converter), before the engine sees the graph ----
  const marking = markV2BackEdges(names, edges, batchNodes);
  if (marking.kind === 'unbatched-cycle') {
    refuse('v2-unbatched-cycle',
      `nodes ${list(marking.members)} form a cycle with no batch node; engine v2 loops only through ` +
      'a Split In Batches v3 (UnsupportedCycleError, v1-workflow-converter.ts)', marking.members[0]!);
  }
  if (marking.kind === 'ambiguous-entry') {
    refuse('v2-loop-shape',
      `the loop of ${list(marking.members)} is entered through ${list(marking.entries)}; a loop needs exactly ` +
      'one way in, through its batch node (UnsupportedLoopEntryError, v1-workflow-converter.ts)', marking.members[0]!);
  }
  const back = marking.kind === 'marked' ? marking.back : new Set<number>();
  const isBack = (e: EdgeRef): boolean => back.has(e.id);

  // ---- validateLoops (graph/loops.ts) ----
  // Rule 1: with the back edges removed, nothing is cyclic. Marks made by `markBackEdges`
  // always leave an acyclic rest; checked because it is n8n's rule, not ours.
  const forward = edges.filter((e) => !isBack(e));
  for (const members of componentsOf(names, forward)) {
    if (isCyclicComponent(members, forward)) {
      refuse('v2-unbatched-cycle',
        `nodes ${list(members)} form a cycle with no back-edge to close it, so none of them can ever become ` +
        'runnable (validateLoops rule 1, graph/loops.ts)', members[0]!);
    }
  }
  const loops = deriveV2Loops(names, edges, back);
  const loopByBatch = new Map(loops.map((loop) => [loop.batchNode, loop]));
  // Rule 3, the "none" case, over batch nodes: one with no return edge heads no loop.
  for (const b of names) {
    if (batchNodes.has(b) && !loopByBatch.has(b)) {
      refuse('v2-loop-shape',
        `batch node '${b}' has no back-edge returning to it, so its loop could never advance ` +
        '(validateLoops rule 3, graph/loops.ts)', b);
    }
  }
  for (const loop of loops) checkLoop(loop, edges, isBack, batchNodes, byName, trigger);

  // ---- validateExecutableGraph (graph/validate-executable-graph.ts) ----
  const succ = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of edges) succ.get(e.from)!.push(e.to);
  const reachable = reachFrom([trigger], succ, null);
  for (const e of edges) {
    if (reachable.has(e.to) && !reachable.has(e.from)) {
      refuse('v2-unreachable-feeder',
        `edge ${e.from} -> ${e.to} feeds a node the trigger reaches from one it cannot reach, so '${e.to}' ` +
        `would wait on '${e.from}' forever (validateExecutableGraph, validate-executable-graph.ts)`, e.from);
    }
  }
  for (const e of edges) {
    if (e.outputIndex > MAX_SLOT_INDEX) {
      throw new CompileError('output-index-out-of-range',
        `compile: edge ${e.from} -> ${e.to} has slot index ${e.outputIndex}; engine v2 supports no slot above ` +
        `${MAX_SLOT_INDEX} (validateExecutableGraph, validate-executable-graph.ts)`, e.from);
    }
    if (e.inputIndex > MAX_SLOT_INDEX) {
      throw new CompileError('input-index-out-of-range',
        `compile: edge ${e.from} -> ${e.to} has slot index ${e.inputIndex}; engine v2 supports no slot above ` +
        `${MAX_SLOT_INDEX} (validateExecutableGraph, validate-executable-graph.ts)`, e.to);
    }
  }
  const seenSlots = new Set<string>();
  for (const e of forward) {
    const slot = `${e.to}#${e.inputIndex}`;
    if (seenSlots.has(slot)) {
      refuse('v2-converging-input',
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
  if (!batchNodes.has(b)) {
    throw new InternalCompilerError(`internal: engineV2 marked a back edge into '${b}', which is not a batch node`);
  }
  if (!hasLiteralBatchSize(byName.get(b)!)) {
    refuse('v2-loop-shape', `batch node '${b}' has no batch size, and it must be a whole number of at least 1 ${at}`, b);
  }
  if (members.has(trigger)) {
    refuse('v2-loop-shape', `trigger '${trigger}' is inside the loop of '${b}', so that loop could never start ${at}`, b);
  }
  for (const m of members) {
    if (m !== b && batchNodes.has(m)) {
      refuse('v2-loop-shape',
        `batch node '${m}' sits inside the loop of '${b}'; engine v2 does not support nested loops ` +
        `(UnimplementedError) ${at}`, m);
    }
  }
  // Rule 2's slot and direction: a return arrives on slot 0, from a member.
  for (const e of loop.backEdges) {
    if (e.inputIndex !== 0) {
      refuse('v2-loop-shape',
        `back-edge ${e.from} -> ${e.to} feeds input slot ${e.inputIndex}; returns feed the batch node's slot 0 ${at}`, b);
    }
    if (!members.has(e.from)) {
      throw new InternalCompilerError(`internal: engineV2 marked ${e.from} -> ${e.to} a back edge from outside its loop`);
    }
  }
  // Rule 3, the "several" case.
  if (loop.backEdges.length > 1) {
    refuse('v2-loop-shape',
      `batch node '${b}' has ${loop.backEdges.length} back-edges; engine v2 does not converge returns on one ` +
      `input slot (UnimplementedError) ${at}`, b);
  }
  // Rule 4: the batch node's own slots, whether or not the edge crosses the loop boundary.
  for (const e of edges) {
    if (e.to === b && !isBack(e) && e.inputIndex !== 0) {
      refuse('v2-loop-shape',
        `edge ${e.from} -> ${e.to} feeds input slot ${e.inputIndex} of a batch node, which has only slot 0 ${at}`, b);
    }
    if (e.from === b && e.outputIndex !== DONE_SLOT && e.outputIndex !== LOOP_SLOT) {
      refuse('v2-loop-shape',
        `edge ${e.from} -> ${e.to} leaves output slot ${e.outputIndex} of a batch node, which has only done ` +
        `(${DONE_SLOT}) and loop (${LOOP_SLOT}) ${at}`, b);
    }
  }
  // One entry edge, after rule 4 so an impossible slot is reported as such.
  if (loop.entryEdges.length > 1) {
    refuse('v2-loop-shape',
      `batch node '${b}' has ${loop.entryEdges.length} entry edges; engine v2 does not converge entries on its ` +
      `input slot (UnimplementedError) ${at}`, b);
  }
  // Rule 5, the way out: only the done slot of the batch node leaves the loop.
  for (const e of loop.exitEdges) {
    if (e.from !== b) {
      refuse('v2-loop-shape',
        `edge ${e.from} -> ${e.to} leaves the loop of '${b}' mid-body; engine v2 does not support dangling ` +
        `body branches (UnimplementedError) ${at}`, e.from);
    }
    if (e.outputIndex !== DONE_SLOT) {
      refuse('v2-loop-shape',
        `edge ${e.from} -> ${e.to} leaves the loop from the loop slot; only the done slot (${DONE_SLOT}) exits ${at}`, b);
    }
  }
  for (const e of edges) {
    // Rule 5, where the done slot may point, marked edges included.
    if (e.from === b && e.outputIndex === DONE_SLOT && members.has(e.to)) {
      refuse('v2-loop-shape',
        `done slot of '${b}' feeds '${e.to}', a member of its own loop; a node cannot run both per iteration ` +
        `and after the loop ${at}`, b);
    }
    // Rule 5, the way in: the batch node is the only entrance to the body.
    if (!isBack(e) && members.has(e.to) && e.to !== b && !members.has(e.from)) {
      refuse('v2-loop-shape',
        `edge ${e.from} -> ${e.to} enters the loop of '${b}' mid-body; the batch node is the only way in ${at}`, e.to);
    }
  }
}
