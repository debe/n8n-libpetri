/**
 * The divergence register, as rules. Every difference the differ finds is attributed: to a
 * `docs/divergences.md` row, to the concurrency the budget bought (an ordering move only —
 * concurrency never excuses a data difference), or to nothing, which is `unattributed` and a
 * finding. One vocabulary serves both gates, so a data difference and an ordering move that
 * the same row explains carry the same row and the same mechanism name.
 *
 * Three rule sets, one per thing that can differ: {@link attributeDataDifference} (the data
 * gate), {@link attribute} (a reordered or one-sided activation) and
 * {@link attributeLastNodeExecuted} (`resultData.lastNodeExecuted`). What they read off the
 * workflow's static shape is computed once per fixture ({@link fixtureStatics}).
 */
import type { IRunData } from 'n8n-workflow';
import type { WorkflowDescription } from '../compiler/index.js';
import type { SchedulerOutcome } from '../scheduler/index.js';
import type { DataDifference } from './diff-value.js';
import type { EngineName } from './engines.js';
import { activationNodeOf } from './trace.js';

// ==================== the vocabulary ====================

/**
 * Why a difference is not a defect — or that nothing covers it.
 *
 * - `divergence`: a registered row explains it, and `mechanism` names how. The register's row
 *   **#5** is the umbrella for order: n8n's total order is a LIFO artifact of a stack it
 *   `unshift`s onto and `shift`s from, and this project uses, in place of the total-order
 *   assertion, data equivalence plus happens-before (`docs/divergences.md` #5,
 *   `docs/conformance-m2.md` attributes its two order failures the same way). So an
 *   *order-only* difference — data equal, happens-before intact — is attributed to #5, and the
 *   mechanism that produced it is named separately: #11 and #12 are the two mechanisms already
 *   in the register, and anything else is `novel: true`, which the report lists as a finding
 *   for the register even though the gate passes.
 * - `concurrency`: at k > 1 two independent activations were left unordered, and either
 *   order is correct.
 * - `unattributed`: a finding; the gate fails on it.
 */
export type Attribution =
  | { readonly kind: 'divergence'; readonly row: number; readonly mechanism: string; readonly novel: boolean; readonly why: string }
  | { readonly kind: 'concurrency'; readonly why: string }
  | { readonly kind: 'unattributed'; readonly why: string };

/**
 * The {@link Attribution} of a data difference: never `concurrency`. The budget may reorder
 * activations, never change what one produced, and a registered row excuses the abandonment
 * of an n8n behaviour, never a node's result.
 */
export type DataAttribution = Exclude<Attribution, { readonly kind: 'concurrency' }>;

type Divergence = Extract<Attribution, { readonly kind: 'divergence' }>;

function divergence(row: number, mechanism: string, why: string, novel = false): Divergence {
  return { kind: 'divergence', row, mechanism, novel, why };
}

/**
 * `halted`, `paused` or `cancelled`: the net stopped short of quiescence, so an activation
 * in flight at that moment finished under the net where n8n's `break` left it unrun — the
 * divergence #17 window every stop-aware rule in this module tests for.
 */
export function isStoppedOutcome(outcome: SchedulerOutcome | null | undefined): boolean {
  return outcome === 'halted' || outcome === 'paused' || outcome === 'cancelled';
}

/**
 * Whether divergence #17's halt window can explain a difference in a run that ended with
 * `outcome`. The rule is coarse: in a stopped run, anything the net ran and n8n did not is
 * inside the window. A tighter rule needs the activation's trace start to fall after the
 * halting activation's, and the halting instant is not observable from the trace
 * (`tasks/todo.md`). Every #17 rule asks here, so tightening it is one change.
 */
function inHaltWindow(outcome: SchedulerOutcome | null | undefined): boolean {
  return isStoppedOutcome(outcome);
}

// ==================== what the rules read off the workflow ====================

/** The static main-connection descendants of every node, for the divergence #2 rule. */
export function descendantsOf(workflow: WorkflowDescription): Map<string, Set<string>> {
  const next = new Map<string, string[]>();
  for (const c of workflow.connections) {
    const list = next.get(c.from);
    if (list === undefined) next.set(c.from, [c.to]);
    else list.push(c.to);
  }
  const out = new Map<string, Set<string>>();
  for (const node of workflow.nodes) {
    const seen = new Set<string>();
    const stack = [...(next.get(node.name) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(next.get(n) ?? []));
    }
    out.set(node.name, seen);
  }
  return out;
}

/**
 * Nodes an input of which has more than one producer edge — the OR-input gadget (README
 * "OR-inputs"), whose `arm` transition is what divergence #20 is about.
 */
export function orInputNodesOf(workflow: WorkflowDescription): Set<string> {
  // Node → input index → producer count: nested, so no composite key can collide with an
  // activation key (a node name may contain `#`).
  const producers = new Map<string, Map<number, number>>();
  for (const c of workflow.connections) {
    let inputs = producers.get(c.to);
    if (inputs === undefined) { inputs = new Map(); producers.set(c.to, inputs); }
    inputs.set(c.inputIndex, (inputs.get(c.inputIndex) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [node, inputs] of producers) {
    for (const count of inputs.values()) if (count > 1) out.add(node);
  }
  return out;
}

/**
 * What the attribution rules read off the workflow's *static* shape, independent of the
 * budget: computed once per fixture and shared by every budget it runs at.
 */
export interface FixtureStatics {
  /** {@link descendantsOf}: the divergence #2 closure. */
  readonly descendants: ReadonlyMap<string, ReadonlySet<string>>;
  /** {@link orInputNodesOf}: the divergence #20 gadget's nodes. */
  readonly orInputNodes: ReadonlySet<string>;
}

export function fixtureStatics(workflow: WorkflowDescription): FixtureStatics {
  return { descendants: descendantsOf(workflow), orInputNodes: orInputNodesOf(workflow) };
}

/** `node 'X': stranded token on …` — the runtime half of divergence #2. */
export function strandedNodesOf(diagnostics: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of diagnostics) {
    if (!d.includes('stranded')) continue;
    const match = /node '([^']+)'/.exec(d);
    if (match !== null) out.push(match[1]!);
  }
  return out;
}

// ==================== the data gate ====================

/** What the data-gate rules read besides the difference itself; `compareData` gathers it once. */
export interface DataAttributionFacts {
  /** Nodes whose runs came out permuted: divergence #11's signature. */
  readonly permutedNodes: readonly string[];
  /** Nodes the net reported a stranded token for: divergence #2. */
  readonly strandedNodes: readonly string[];
  /** {@link strandedNodes} and everything downstream of them. */
  readonly strandedClosure: ReadonlySet<string>;
  /** Nodes n8n left in `waitingExecution` and never ran: divergence #1. */
  readonly starvedNodes: readonly string[];
  /** {@link starvedNodes} and everything downstream of them. */
  readonly starvedClosure: ReadonlySet<string>;
  /** Nodes whose run count differs between the two engines. */
  readonly countDiffers: ReadonlySet<string>;
  /** Each engine's `runData`, for the direction of a run-count difference. */
  readonly runData: Readonly<Record<EngineName, IRunData>>;
  /** `PetriScheduler.outcome` of the net's run: a stopped run is the divergence #17 window. */
  readonly candidateOutcome: SchedulerOutcome | null;
  /** `startData.destinationNode.nodeName`, when the run had one: divergence #13. */
  readonly destinationNode: string | undefined;
}

/**
 * Attribute one data difference; `node` is the node it is about, `''` when it is about
 * neither. Only registered rows can excuse one, and each is an abandonment of an n8n
 * behaviour rather than a change of a node's result:
 *
 * - **#11** — a node's runs came out permuted: the same activations with the same payloads
 *   in the other order, because n8n delivers the most recent arrival first.
 * - **#2** — the net stranded a join arrival and said so, where n8n's quiescence fallback
 *   re-runs the join with `[]` on the input that never arrived. The join and everything
 *   downstream of it therefore runs *fewer times* — which is all this row excuses: a run
 *   count, a node missing entirely, and the arrival the codec wrote to `waitingExecution`.
 *   A per-field difference *inside* a run of such a node is a wrong result, not a divergence.
 * - **#1** — the other direction: n8n left a join in `waitingExecution` and never ran it,
 *   where the net's explicit empty token completes the AND-join, so it and its descendants
 *   run *at least as often* under the net.
 * - **#13** — the destination-node stop: the net pauses instead of draining the stack, so an
 *   in-filter entry still pending at that moment never runs.
 * - **#17** — the halt / pause window: an activation the net started or had in flight when
 *   the execution stopped finishes and is recorded, where n8n's `break` left it unrun.
 *
 * Everything else is `unattributed` and fails the gate.
 */
export function attributeDataDifference(d: DataDifference, node: string, facts: DataAttributionFacts): DataAttribution {
  const runsIn = (engine: EngineName): number => facts.runData[engine][node]?.length ?? 0;
  if (node !== '' && facts.permutedNodes.includes(node)) {
    return divergence(11, 'or-input-lifo',
      `'${node}' ran the same activations with the same payloads in the other order: n8n delivers the most recent arrival first (unshift/shift), the net's hasdata place is FIFO`);
  }
  // Row #2 is about a join and its descendants running *fewer times* and about the arrival
  // the codec wrote back instead — never about what a run of them produced.
  const countLike = facts.countDiffers.has(node) || d.path.startsWith('executionData.');
  if (node !== '' && facts.strandedClosure.has(node) && countLike) {
    const cause = facts.strandedNodes.includes(node) ? node : `an upstream join (${facts.strandedNodes.join(', ')})`;
    return divergence(2, 'stranded-join',
      `the net stranded an arrival on ${cause} and reported it, where n8n's quiescence fallback re-runs the join with [] on the input that never arrived`);
  }
  if (node !== '' && facts.starvedClosure.has(node) && countLike && runsIn('libpetri') >= runsIn('n8n')) {
    const cause = facts.starvedNodes.includes(node) ? `'${node}'` : `an upstream join (${facts.starvedNodes.join(', ')})`;
    return divergence(1, 'starved-join',
      `n8n left ${cause} in waitingExecution and never ran it — its R6 fallback fires only at the end of an iteration that ran a node, and a starved input never arrives — where the net propagates an explicit empty token, so its AND-join completes`);
  }
  const destination = facts.destinationNode;
  if (destination !== undefined && countLike && (node === '' || runsIn('libpetri') < runsIn('n8n') || node === destination)) {
    return divergence(13, 'destination-stop',
      `the run stopped at destination node '${destination}': n8n keeps popping the stack after it, the net deposits _pause and quiesces, so an entry still pending then never runs`);
  }
  const stopped = inHaltWindow(facts.candidateOutcome);
  if (stopped && node !== '' && runsIn('libpetri') > runsIn('n8n')) {
    return divergence(17, 'halt-window',
      `the execution ${facts.candidateOutcome} and '${node}' ran under the net only: the net cannot un-start an action, and the halt window runs until _halt reaches the marking, so a sibling in flight finishes and one can even start inside it`);
  }
  if (stopped && countLike && node === '') {
    return divergence(17, 'halt-window',
      `the execution ${facts.candidateOutcome}: the activations that finished inside the halt window routed, so the entries written back differ from what n8n's break left`);
  }
  return { kind: 'unattributed', why: 'no docs/divergences.md row covers this difference' };
}

// ==================== the ordering report ====================

export interface AttributionContext {
  readonly effectiveBudget: number;
  /** Node names whose runs came out permuted: divergence #11's signature. */
  readonly permutedNodes: readonly string[];
  /** Nodes the net stranded an arrival on, plus everything downstream: divergence #2. */
  readonly strandedNodes: readonly string[];
  /** Nodes n8n left in `waitingExecution`, plus everything downstream: divergence #1. */
  readonly starvedNodes?: readonly string[];
  /** Activations whose recorded `source` has more than one input: multi-input joins. */
  readonly joinActivations: ReadonlySet<string>;
  /** `reachableOf` over both engines' realised edges. */
  readonly reachable: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Activations only one engine ran, and which one. They did not *move* — there is no rank
   * to compare — so the concurrency rule must not claim them: "no dependency either way with
   * the activations it passed" is vacuously true over an empty `movedAgainst`, and saying
   * `concurrency` about an activation that exists once is a false correctness claim.
   */
  readonly oneSided?: ReadonlyMap<string, EngineName>;
  /** `PetriScheduler.outcome` of the net's run: a stopped run is the divergence #17 window. */
  readonly candidateOutcome?: SchedulerOutcome | null;
  /** `startData.destinationNode.nodeName`, when the run had one: divergence #13. */
  readonly destinationNode?: string | undefined;
  /** Nodes with more than one producer edge into one input: the divergence #20 gadget. */
  readonly orInputNodes?: ReadonlySet<string>;
}

/**
 * Attribute one reordered activation. Order-only movement is row #5; the rules below only
 * decide which *mechanism* to name, and `novel: true` marks one the register does not have.
 */
export function attribute(
  activation: string,
  movedAgainst: readonly string[],
  ctx: AttributionContext,
): Attribution {
  const node = activationNodeOf(activation);
  const ranIn = ctx.oneSided?.get(activation);
  if (ranIn !== undefined) {
    // Not a move: the activation exists in one engine only. The registered rows that
    // produce one are checked in order of specificity; anything else is a finding.
    if (ctx.strandedNodes.includes(node)) {
      return divergence(2, 'stranded-join',
        `'${activation}' ran in ${ranIn} only: '${node}' is a stranded join or downstream of one, so the two engines ran it a different number of times`);
    }
    if (ranIn === 'libpetri' && (ctx.starvedNodes ?? []).includes(node)) {
      return divergence(1, 'starved-join',
        `'${activation}' ran under the net only: n8n left this join (or its ancestor) in waitingExecution and never ran it, while the net's explicit empty token completes the AND-join`);
    }
    if (ranIn === 'n8n' && ctx.destinationNode !== undefined) {
      return divergence(13, 'destination-stop',
        `'${activation}' ran in n8n only: after destination node '${ctx.destinationNode}' n8n keeps popping the stack, while the net deposits _pause and quiesces`);
    }
    if (ranIn === 'libpetri' && inHaltWindow(ctx.candidateOutcome)) {
      return divergence(17, 'halt-window',
        `'${activation}' ran under the net only and the execution ${ctx.candidateOutcome}: the net cannot un-start an action, and the window lasts until _halt reaches the marking, so a sibling in flight finishes and one can even start inside it`);
    }
    return { kind: 'unattributed', why: `'${activation}' ran in ${ranIn} only, and no registered row explains it` };
  }
  const independent = movedAgainst.every(
    (other) => !(ctx.reachable.get(activation)?.has(other) ?? false)
      && !(ctx.reachable.get(other)?.has(activation) ?? false),
  );
  if (ctx.effectiveBudget > 1 && independent) {
    return {
      kind: 'concurrency',
      why: `k=${ctx.effectiveBudget}: no dependency either way with ${movedAgainst.join(', ') || 'the activations it passed'}, so the net leaves the pair unordered and either order is correct`,
    };
  }
  if (ctx.permutedNodes.includes(node)) {
    return divergence(11, 'or-input-lifo',
      `two runs of '${node}' are a permutation: n8n delivers the most recent arrival first (unshift/shift), the net's hasdata place is FIFO`);
  }
  const joinsInvolved = [activation, ...movedAgainst].filter((k) => ctx.joinActivations.has(k));
  if (joinsInvolved.length > 0) {
    return divergence(12, 'join-unshift',
      `${joinsInvolved.join(', ')} completed a multi-input join: n8n unshifts such an entry so it runs after every queued sibling, the net fires it at priority = depth`);
  }
  // Everything a permuted node's activations passed moved *because* they did: one event.
  const permutedPassed = movedAgainst.filter((o) => ctx.permutedNodes.includes(activationNodeOf(o)));
  if (permutedPassed.length > 0 && permutedPassed.length === movedAgainst.length) {
    return divergence(11, 'or-input-lifo',
      `'${activation}' moved only against ${permutedPassed.join(', ')}, whose node delivers its arrivals in the other order (n8n most-recent-first, the net FIFO)`);
  }
  const orInvolved = [activation, ...movedAgainst].filter((k) => ctx.orInputNodes?.has(activationNodeOf(k)) ?? false);
  if (orInvolved.length > 0) {
    return divergence(20, 'or-input-arm',
      `${orInvolved.join(', ')} is an OR-input node: its arm transition spends one scheduling cycle turning the arrival into X/ready + X/hasdata, and a shallower sibling takes the budget unit in that cycle, so the net runs breadth-first where priority = depth alone would have been depth-first`);
  }
  if (ctx.strandedNodes.includes(node) || movedAgainst.some((o) => ctx.strandedNodes.includes(activationNodeOf(o)))) {
    return divergence(2, 'stranded-join',
      `'${node}' is a stranded join or downstream of one, so the two engines ran it a different number of times`);
  }
  return divergence(5, 'unnamed',
    `order-only: '${activation}' moved relative to ${movedAgainst.join(', ') || '(nothing)'} with equal data — n8n's total order is the LIFO artifact row #5 abandons, but no registered row names this mechanism`,
    true);
}

/**
 * Attribute a difference in `resultData.lastNodeExecuted`; `null` when the two engines name
 * the same node. The field records which node ran last, a function of the execution order
 * alone: row #5 at k = 1, row #16 above it (where the field records the last node to
 * *complete*, its definition under concurrency) — provided both names belong to nodes that
 * ran in both engines. A name that belongs to a node only one engine ran is not a defect
 * when that node's runs are themselves attributed: the field then names the last node of a
 * run that legitimately differs (a starved join the net completed, a sibling that finished
 * inside the halt window, an entry n8n ran after a destination stop). Otherwise it is.
 */
export function attributeLastNodeExecuted(
  last: Readonly<Record<EngineName, string | undefined>>,
  runData: Readonly<Record<EngineName, IRunData>>,
  ctx: AttributionContext,
): Attribution | null {
  const { n8n: lastLeft, libpetri: lastRight } = last;
  if (lastLeft === lastRight) return null;
  const ranInBoth = (name: string | undefined): boolean =>
    name !== undefined && runData.n8n[name] !== undefined && runData.libpetri[name] !== undefined;
  const oneSidedRow = (name: string | undefined): { row: number; mechanism: string } | null => {
    if (name === undefined) return null;
    const inReference = runData.n8n[name] !== undefined;
    const inCandidate = runData.libpetri[name] !== undefined;
    if (inReference === inCandidate) return null;
    if (ctx.strandedNodes.includes(name)) return { row: 2, mechanism: 'stranded-join' };
    if (inCandidate && (ctx.starvedNodes ?? []).includes(name)) return { row: 1, mechanism: 'starved-join' };
    if (inReference && ctx.destinationNode !== undefined) return { row: 13, mechanism: 'destination-stop' };
    if (inCandidate && inHaltWindow(ctx.candidateOutcome)) return { row: 17, mechanism: 'halt-window' };
    return null;
  };
  const oneSided = oneSidedRow(lastLeft) ?? oneSidedRow(lastRight);
  if (oneSided !== null) {
    return divergence(oneSided.row, oneSided.mechanism,
      `'${lastLeft ?? 'undefined'}' / '${lastRight ?? 'undefined'}': the field names the last node to run, and one of them ran in one engine only for the reason divergence #${oneSided.row} records`);
  }
  if (!ranInBoth(lastLeft) || !ranInBoth(lastRight)) {
    return { kind: 'unattributed', why: `'${lastLeft ?? 'undefined'}' / '${lastRight ?? 'undefined'}': one of them never ran in one engine` };
  }
  const k = ctx.effectiveBudget;
  return divergence(k > 1 ? 16 : 5, 'last-node-executed', k > 1
    ? `both '${lastLeft}' and '${lastRight}' ran in both engines; at k=${k} the field records the last node to complete (row #16)`
    : `both '${lastLeft}' and '${lastRight}' ran in both engines: which of them ran *last* is the total order row #5 abandons`);
}
