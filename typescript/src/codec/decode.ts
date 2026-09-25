/**
 * Decoding: n8n's `executionData` → the initial marking (ADR 0005; the decode table and the
 * error convention are in `src/codec.ts`). Every stack entry and every `waitingExecution` row
 * is dispatched on its node's gadget form; the per-form modules collect what cannot be placed
 * until everything is read — join queues, OR round deliveries, agent rounds — and place it
 * afterwards, followed by the `X/done` and `Y/skipped` markers.
 */
import { tokenOf, type Place, type Token } from 'libpetri';
import type { IExecuteData, IRunData } from 'n8n-workflow';
import { assertProfile, type CompiledWorkflow, type NodeGadget } from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import type { ExecutionDataState } from '../n8n/host.js';
import type { EntryPayload } from '../scheduler/payloads.js';
import { isRoundResume, RoundAssembly } from './agent-round.js';
import { decodeDirectRow } from './direct.js';
import { CodecError } from './errors.js';
import { decodeJoinEntry, decodeJoinRow, JoinQueues } from './join.js';
import { addMarkers, hasRunIn } from './markers.js';
import { decodeOrEntry, decodeOrRow, RoundDeliveries } from './or-round.js';
import { add, noop, type Diagnostic, type MarkingMap, type WaitingRow } from './shared.js';
import { waitingRows } from './waiting-rows.js';

export interface DecodeOptions {
  /** `resultData.runData`: every node with a recorded run gets its `X/done` marker (and an open OR round its `X/ran_i`). */
  readonly runData?: IRunData;
  /** Receives one line per foreign slot decode had to drop (shapes n8n itself never writes). */
  readonly onDiagnostic?: (message: string) => void;
}

/** What one decode reads into: the marking, and what the per-form modules place once everything is read. */
interface DecodeState {
  readonly compiled: CompiledWorkflow;
  readonly marking: MarkingMap;
  readonly diag: Diagnostic;
  readonly joins: JoinQueues;
  readonly rounds: RoundDeliveries;
  readonly agentRounds: RoundAssembly;
  /** Nodes with a decoded activation: what the resumed execution can still reach starts here. */
  readonly pendingNodes: Set<string>;
}

/**
 * n8n's `executionData` as a marking of `compiled`. A v1 codec: an `engineV2` net is refused with
 * `ProfileMismatchError` (`tasks/v2-profile-plan.md` decision 14); its marking comes from engine
 * v2's step rows instead.
 */
export function decodeExecutionData(
  compiled: CompiledWorkflow,
  executionData: ExecutionDataState,
  options: DecodeOptions = {},
): Map<Place<unknown>, Token<unknown>[]> {
  assertProfile('decodeExecutionData', 'v1', compiled.netMap.profile);
  const diag = options.onDiagnostic ?? noop;
  const marking = compiled.sharedMarking();
  const hasRun = hasRunIn(compiled, options.runData);
  const d: DecodeState = {
    compiled, marking, diag,
    joins: new JoinQueues(), rounds: new RoundDeliveries(), agentRounds: new RoundAssembly(), pendingNodes: new Set(),
  };

  // ---- nodeExecutionStack: one activation per entry, in stack order ----
  for (const entry of executionData.nodeExecutionStack) decodeEntry(d, entry);

  // ---- agent rounds: reassemble what the encoder wrote back ----
  d.agentRounds.materialise(marking, diag, d.pendingNodes);

  // ---- waitingExecution: partial slots, per node in ascending run index ----
  for (const { g, row } of waitingRows(executionData, (name) => nodeOf(compiled, name), diag)) decodeRow(d, g, row);

  // ---- join inputs: the head takes the slot, the rest queue behind free_i ----
  d.joins.materialise(marking);

  // ---- OR rounds: the deliveries, and the marker of a round the node already ran in ----
  d.rounds.materialise(marking, compiled.netMap.nodes, hasRun);

  // ---- markers: done from runData, skipped for references nothing pending can satisfy ----
  addMarkers(compiled, marking, d.pendingNodes, hasRun);
  return marking;
}

function nodeOf(compiled: CompiledWorkflow, name: string): NodeGadget {
  const g = compiled.netMap.tryNode(name);
  if (g === undefined) throw new CodecError(`executionData names node '${name}', which the compiled workflow does not have`);
  return g;
}

/** One stack entry: an agent's round re-entry, else one activation dispatched on its node's gadget form. */
function decodeEntry(d: DecodeState, entry: IExecuteData): void {
  const { compiled, marking, rounds, joins, agentRounds } = d;
  const g = nodeOf(compiled, entry.node.name);
  d.pendingNodes.add(g.node);
  const payload: EntryPayload = { kind: 'entry', executionData: entry };
  const token = tokenOf<unknown>(payload);
  if (isRoundResume(g, entry)) {
    agentRounds.resume(g, entry);
    return;
  }
  switch (g.form) {
    case 'direct': add(marking, g.in, token); break;
    case 'or': decodeOrEntry(compiled, g, token, entry, marking, rounds); break;
    case 'join':
    case 'choose-branch': decodeJoinEntry(g, token, joins); break;
    case 'tool': agentRounds.toolCall(g, entry); break;
    default: assertNever(g, 'gadget form');
  }
}

/** One `waitingExecution` row, dispatched on its node's gadget form. */
function decodeRow(d: DecodeState, g: NodeGadget, row: WaitingRow): void {
  const { compiled, marking, rounds, joins, pendingNodes } = d;
  switch (g.form) {
    case 'direct': decodeDirectRow(compiled, g, row, marking, pendingNodes); break;
    case 'or': decodeOrRow(compiled, g, row, marking, rounds, pendingNodes); break;
    case 'join':
    case 'choose-branch': decodeJoinRow(g, row, joins, pendingNodes); break;
    // A tool has no main input for n8n to have written; whatever is here is foreign.
    case 'tool': row.foreign(() => false); break;
    default: assertNever(g, 'gadget form');
  }
}
