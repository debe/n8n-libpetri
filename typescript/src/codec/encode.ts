/**
 * Encoding: the quiescent marking → n8n's `nodeExecutionStack`, `waitingExecution` and
 * `waitingExecutionSource` (ADR 0005; the encode table, the modes and the error convention are
 * in `src/codec.ts`). The places a quiesced net has drained are checked first; then every node
 * writes its own activations, the agent round it holds, and its input side, dispatched on its
 * gadget form.
 */
import type { Marking, Place } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import type { CompiledWorkflow, NodeGadget } from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import type { ExecutionDataState } from '../n8n/host.js';
import { activationsOf } from './activations.js';
import { roundEntriesOf } from './agent-round.js';
import { encodeDirect } from './direct.js';
import { CodecError } from './errors.js';
import { encodeJoin } from './join.js';
import { encodeOr } from './or-round.js';
import { collectRouted, type RoutedArrival } from './routed.js';
import { noop } from './shared.js';
import { EncodeTarget, type EncodeMode, type NodeWriter } from './writer.js';

export type { EncodeMode } from './writer.js';

export interface EncodeOptions {
  /** Default `'pause'`. */
  readonly mode?: EncodeMode;
  /** Receives one line per dropped or stranded token, naming node and place. */
  readonly onDiagnostic?: (message: string) => void;
  /**
   * The live `INode` object of a node name (`workflow.nodes[name]`), which n8n puts on
   * every stack entry (`handleWaitingState` flips `nodeExecutionStack[0].node.disabled` on
   * it). Without it the encoder reuses the object of any entry already naming the node and
   * otherwise a name-only stub.
   */
  readonly node?: (name: string) => IExecuteData['node'] | undefined;
}

export function encodeMarking(
  compiled: CompiledWorkflow,
  marking: Marking,
  executionData: ExecutionDataState,
  options: EncodeOptions = {},
): ExecutionDataState {
  const mode = options.mode ?? 'pause';
  const diag = options.onDiagnostic ?? noop;
  const nodes = compiled.netMap.nodes;
  assertDrained(nodes, marking, mode);

  const routed = collectRouted(marking, nodes, diag);
  const target = new EncodeTarget({ compiled, marking, mode, diag, executionData, resolveNode: options.node });
  for (const [canvas, g] of nodes.entries()) encodeNode(target.writerFor(g, canvas), routed.get(g.node) ?? []);
  return target.writeTo(executionData);
}

/** One node: its own activations, the agent round it holds, then its input side by gadget form. */
function encodeNode(w: NodeWriter, routedHere: readonly RoutedArrival[]): void {
  const { g } = w;

  // ---- the node's own activations: waiting first, then the ones cancellation caught ----
  const activations = activationsOf(w);
  for (const a of activations) w.push(a.executionData, a.waiting);

  // ---- an agent round the pause or the halt caught mid-flight ----
  for (const e of roundEntriesOf(g, w.marking, w.diag)) w.push(e);

  // ---- the input side ----
  switch (g.form) {
    case 'direct': encodeDirect(w, g, routedHere); break;
    case 'or': encodeOr(w, g, activations.map((a) => a.executionData), routedHere); break;
    case 'join':
    case 'choose-branch': encodeJoin(w, g, routedHere); break;
    case 'tool': break; // its dispatch is part of the agent round above
    default: assertNever(g, 'gadget form');
  }
}

/** The places of `g` a transition consumes in the firing after the one that marks them, whatever stopped the net. */
function inFlightPlaces(g: NodeGadget): Array<Place<unknown> | null> {
  // `A/routed_req` belongs here with `X/routed`: both are the marker `X_run` writes in the
  // firing that ends an activation, and both are consumed one cycle later by a transition
  // that inhibits on nothing — so a quiesced net has drained them whatever stopped it.
  const inFlight: Array<Place<unknown> | null> = [
    g.running,
    ...(g.routing.kind === 'collapsed' ? [g.routing.routed] : g.routing.outputs.flatMap((o) => [o.ok, o.routed])),
    g.agent?.routedRequest ?? null,
    g.form === 'direct' ? g.inEmpty : null,
    // An `onFailure` chain's later attempts are `X/running` for every purpose here, and its
    // deadline funnel inhibits `_halt` alone — so a *paused* net has already moved every
    // `X/timedout_i` on to `X/failed_i` and only a halted one can still hold it
    // (ADR 0009 §3).
    ...g.attempts.slice(1).map((a) => a.running),
    ...g.attempts.map((a) => a.timedOut),
  ];
  if (g.form === 'or') for (const e of g.inputs[0].edges) inFlight.push(e.data, e.empty);
  return inFlight;
}

/** A pending retry, which `stranded` cannot write: `X/retry`, and `X/failed_i`, which is `X/retry` for a chain. */
function retryPlaces(g: NodeGadget): Array<Place<unknown>> {
  return [...(g.retry !== null ? [g.retry.retry] : []), ...g.attempts.map((a) => a.failed)];
}

/**
 * The places the net drains on its own before it quiesces: a token on one is a
 * {@link CodecError} naming node and place, except under `cancelled`, the one mode that
 * legitimately sees them.
 */
function assertDrained(nodes: readonly NodeGadget[], marking: Marking, mode: EncodeMode): void {
  for (const g of nodes) {
    const drained = [...(mode !== 'cancelled' ? inFlightPlaces(g) : []), ...(mode === 'stranded' ? retryPlaces(g) : [])];
    for (const p of drained) {
      if (p === null || marking.tokenCount(p) === 0) continue;
      throw new CodecError(
        `node '${g.node}': ${marking.tokenCount(p)} token(s) on '${p.name}' — the net must be drained before ` +
        `encoding (mode '${mode}')`);
    }
  }
}
