/**
 * Decoding: n8n's `executionData` → the initial marking (ADR 0005; the decode table and the
 * error convention are in `src/codec.ts`). Every stack entry and every `waitingExecution` row
 * is dispatched on its node's gadget form; the per-form modules collect what cannot be placed
 * until everything is read — join queues, OR round deliveries, agent rounds — and place it
 * afterwards, followed by the `X/done` and `Y/skipped` markers.
 */
import { tokenOf, type Place, type Token } from 'libpetri';
import type { IRunData, ISourceData } from 'n8n-workflow';
import { reachableFrom, type CompiledWorkflow, type DirectGadget, type NodeGadget } from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import { unit } from '../internal/tokens.js';
import type { ExecutionDataState } from '../n8n/host.js';
import type { EntryPayload } from '../scheduler/payloads.js';
import { isRoundResume, RoundAssembly } from './agent-round.js';
import { CodecError } from './errors.js';
import { decodeJoinEntry, decodeJoinRow, JoinQueues } from './join.js';
import { decodeOrEntry, decodeOrRow, RoundDeliveries } from './or-round.js';
import {
  add, count, directInputIndex, edgePayload, noop,
  type Diagnostic, type Items, type MarkingMap, type WaitingRow,
} from './shared.js';

export interface DecodeOptions {
  /** `resultData.runData`: every node with a recorded run gets its `X/done` marker (and an open OR round its `X/ran_i`). */
  readonly runData?: IRunData;
  /** Receives one line per foreign slot decode had to drop (shapes n8n itself never writes). */
  readonly onDiagnostic?: (message: string) => void;
}

export function decodeExecutionData(
  compiled: CompiledWorkflow,
  executionData: ExecutionDataState,
  options: DecodeOptions = {},
): Map<Place<unknown>, Token<unknown>[]> {
  const diag = options.onDiagnostic ?? noop;
  const marking = compiled.sharedMarking();
  /**
   * Whether `name` actually executed. A tool node is the one place where having a `runData`
   * entry is not the same thing: `initializeNodeRunData` **reserves** a slot per requested
   * action before the tool runs — n8n's own test asserts `data` is `undefined` for a tool whose
   * round was abandoned — so a reserved-but-unfilled slot must not mark `X/done` or a resumed
   * `$('Tool')` read arc would see a run that never happened.
   */
  const hasRun = (name: string): boolean => {
    const runs = options.runData?.[name] ?? [];
    if (runs.length === 0) return false;
    const isTool = compiled.netMap.tryNode(name)?.form === 'tool';
    return isTool ? runs.some((t) => t.data !== undefined) : true;
  };
  const nodeOf = (name: string): NodeGadget => {
    const g = compiled.netMap.tryNode(name);
    if (g === undefined) throw new CodecError(`executionData names node '${name}', which the compiled workflow does not have`);
    return g;
  };

  const joins = new JoinQueues();
  const rounds = new RoundDeliveries();
  const agentRounds = new RoundAssembly();
  // Nodes with a decoded activation: what the resumed execution can still reach starts here.
  const pendingNodes = new Set<string>();

  // ---- nodeExecutionStack: one activation per entry, in stack order ----
  for (const entry of executionData.nodeExecutionStack) {
    const g = nodeOf(entry.node.name);
    pendingNodes.add(g.node);
    const payload: EntryPayload = { kind: 'entry', executionData: entry };
    const token = tokenOf<unknown>(payload);
    if (isRoundResume(g, entry)) {
      agentRounds.resume(g, entry);
      continue;
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

  // ---- agent rounds: reassemble what the encoder wrote back ----
  agentRounds.materialise(marking, diag, pendingNodes);

  // ---- waitingExecution: partial slots, per node in ascending run index ----
  const waiting = executionData.waitingExecution ?? {};
  const waitingSource = executionData.waitingExecutionSource ?? {};
  for (const [name, slots] of Object.entries(waiting)) {
    if (slots === undefined || slots === null) continue;
    const g = nodeOf(name);
    const keys = Object.keys(slots).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    for (const k of keys) {
      const row = waitingRow(g, k, slots[k]?.main ?? [], waitingSource?.[name]?.[k]?.main ?? [], diag);
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
  }

  // ---- join inputs: the head takes the slot, the rest queue behind free_i ----
  joins.materialise(marking);

  // ---- OR rounds: the deliveries, and the marker of a round the node already ran in ----
  rounds.materialise(marking, compiled.netMap.nodes, hasRun);

  // ---- markers: done from runData, skipped for references nothing pending can satisfy ----
  for (const g of compiled.netMap.nodes) {
    if (hasRun(g.node)) add(marking, g.done, unit());
  }
  const referenced = new Set<string>();
  for (const g of compiled.netMap.nodes) for (const y of g.references) referenced.add(y);
  if (referenced.size > 0) {
    const reach = reachableFrom(compiled.analysis, pendingNodes);
    for (const y of referenced) {
      const g = compiled.netMap.node(y);
      if (g.skipped === null || hasRun(y) || reach.has(y) || count(marking, g.skipped) > 0) continue;
      add(marking, g.skipped, unit());
    }
  }
  return marking;
}

/** Row `k` of `waitingExecution[g]`, read against its `waitingExecutionSource` twin. */
function waitingRow(
  g: NodeGadget,
  k: number,
  main: ReadonlyArray<Items | null | undefined>,
  sources: ReadonlyArray<ISourceData | null | undefined>,
  diag: Diagnostic,
): WaitingRow {
  return {
    k,
    valueAt: (index) => main[index] ?? null,
    sourceAt: (index) => sources[index] ?? null,
    foreign: (owned) => {
      main.forEach((v, index) => {
        if (v !== null && v !== undefined && !owned(index)) {
          diag(`node '${g.node}': waitingExecution[${k}].main[${index}] names an input the node does not have; dropped`);
        }
      });
    },
  };
}

/**
 * A `waitingExecution` row of a direct-form node. n8n never writes a single-input node here;
 * the stranded encoder does (divergence #2). Items go on `X/in`, `[]` on `X/in_empty`; a `[]`
 * for an input with no empty place is the same impossibility a join input refuses.
 */
function decodeDirectRow(
  compiled: CompiledWorkflow, g: DirectGadget, row: WaitingRow, marking: MarkingMap, pendingNodes: Set<string>,
): void {
  const index = directInputIndex(compiled, g);
  row.foreign((idx) => idx === index);
  const v = row.valueAt(index);
  if (v === null) return;
  pendingNodes.add(g.node);
  if (v.length > 0) add(marking, g.in, tokenOf<unknown>(edgePayload(v, row.sourceAt(index))));
  else if (g.inEmpty !== null) add(marking, g.inEmpty, unit());
  else {
    throw new CodecError(
      `node '${g.node}' input ${index}: waitingExecution[${row.k}] holds [] but '${g.in.name}' has no empty place ` +
      `beside it (a cycle edge or a synthetic input cannot carry an empty)`);
  }
}
