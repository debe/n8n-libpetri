/**
 * The data gate's rule set: which registered row, if any, excuses one data difference
 * ({@link attributeDataDifference}). Each rule is one row, and the list is evaluated in
 * order of specificity.
 */
import type { IRunData } from 'n8n-workflow';
import type { SchedulerOutcome } from '../../scheduler/index.js';
import type { DataDifference } from '../diff-value.js';
import type { EngineName } from '../engines.js';
import { inHaltWindow } from './halt-window.js';
import { divergence, firstMatch, unattributed, type DataAttribution, type Divergence, type Rule } from './vocabulary.js';

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

/** One data difference as the rules read it. */
interface DataCase {
  /** The node it is about, `''` when it is about neither. */
  readonly node: string;
  /**
   * A run count or an entry written back to the resumable state: the only differences rows
   * #1, #2, #13 and #17 can excuse — never what a run produced.
   */
  readonly countLike: boolean;
  readonly n8nRuns: number;
  readonly libpetriRuns: number;
  readonly facts: DataAttributionFacts;
}

/** **#11** — the same activations with the same payloads in the other order. */
function permutedRuns({ node, facts }: DataCase): Divergence | null {
  if (node === '' || !facts.permutedNodes.includes(node)) return null;
  return divergence(11, 'or-input-lifo',
    `'${node}' ran the same activations with the same payloads in the other order: n8n delivers the most recent arrival first (unshift/shift), the net's hasdata place is FIFO`);
}

/**
 * **#2** — the net stranded a join arrival: the join and its descendants run *fewer times*,
 * and the codec writes the arrival back. Never about what a run of them produced.
 */
function strandedJoin({ node, countLike, facts }: DataCase): Divergence | null {
  if (node === '' || !countLike || !facts.strandedClosure.has(node)) return null;
  const cause = facts.strandedNodes.includes(node) ? node : `an upstream join (${facts.strandedNodes.join(', ')})`;
  return divergence(2, 'stranded-join',
    `the net stranded an arrival on ${cause} and reported it, where n8n's quiescence fallback re-runs the join with [] on the input that never arrived`);
}

/** **#1** — n8n left a join in `waitingExecution`; under the net it runs at least as often. */
function starvedJoin({ node, countLike, facts, n8nRuns, libpetriRuns }: DataCase): Divergence | null {
  if (node === '' || !countLike || !facts.starvedClosure.has(node) || libpetriRuns < n8nRuns) return null;
  const cause = facts.starvedNodes.includes(node) ? `'${node}'` : `an upstream join (${facts.starvedNodes.join(', ')})`;
  return divergence(1, 'starved-join',
    `n8n left ${cause} in waitingExecution and never ran it — its R6 fallback fires only at the end of an iteration that ran a node, and a starved input never arrives — where the net propagates an explicit empty token, so its AND-join completes`);
}

/** **#13** — the destination-node stop: an entry still pending when the net paused never runs. */
function destinationStop({ node, countLike, facts, n8nRuns, libpetriRuns }: DataCase): Divergence | null {
  const destination = facts.destinationNode;
  if (destination === undefined || !countLike) return null;
  if (node !== '' && libpetriRuns >= n8nRuns && node !== destination) return null;
  return divergence(13, 'destination-stop',
    `the run stopped at destination node '${destination}': n8n keeps popping the stack after it, the net deposits _pause and quiesces, so an entry still pending then never runs`);
}

/** **#17** — a node that ran more often under the net inside the halt window. */
function haltWindowRuns({ node, facts, n8nRuns, libpetriRuns }: DataCase): Divergence | null {
  if (!inHaltWindow(facts.candidateOutcome) || node === '' || libpetriRuns <= n8nRuns) return null;
  return divergence(17, 'halt-window',
    `the execution ${facts.candidateOutcome} and '${node}' ran under the net only: the net cannot un-start an action, and the halt window runs until _halt reaches the marking, so a sibling in flight finishes and one can even start inside it`);
}

/** **#17** — the entries written back after activations that finished inside the halt window. */
function haltWindowState({ node, countLike, facts }: DataCase): Divergence | null {
  if (!inHaltWindow(facts.candidateOutcome) || !countLike || node !== '') return null;
  return divergence(17, 'halt-window',
    `the execution ${facts.candidateOutcome}: the activations that finished inside the halt window routed, so the entries written back differ from what n8n's break left`);
}

const DATA_RULES: readonly Rule<DataCase, Divergence>[] = [
  permutedRuns, strandedJoin, starvedJoin, destinationStop, haltWindowRuns, haltWindowState,
];

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
  const found = firstMatch(DATA_RULES, {
    node,
    countLike: facts.countDiffers.has(node) || d.path.startsWith('executionData.'),
    n8nRuns: facts.runData.n8n[node]?.length ?? 0,
    libpetriRuns: facts.runData.libpetri[node]?.length ?? 0,
    facts,
  });
  return found ?? unattributed('no docs/divergences.md row covers this difference');
}
