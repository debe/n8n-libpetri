/**
 * Encoding: the quiescent marking → n8n's `nodeExecutionStack`, `waitingExecution` and
 * `waitingExecutionSource` (ADR 0005; the encode table, the modes and the error convention are
 * in `src/codec.ts`). The places a quiesced net has drained are checked first; then every node
 * writes its own activations, the agent round it holds, and its input side, dispatched on its
 * gadget form.
 */
import type { Marking, Place } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import type { CompiledWorkflow, DirectGadget, NodeGadget } from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import type { ExecutionDataState } from '../n8n/host.js';
import { isRetryPayload, isRunPayload, isStoppedPayload, isWaitingPayload } from '../scheduler/payloads.js';
import { roundEntriesOf } from './agent-round.js';
import { CodecError } from './errors.js';
import { encodeJoin } from './join.js';
import { encodeOr } from './or-round.js';
import { assertDirectArrival, collectRouted, type RoutedArrival } from './routed.js';
import { directInputIndex, noop } from './shared.js';
import { EncodeTarget, type Cell, type EncodeMode, type NodeWriter } from './writer.js';

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
  for (const [canvas, g] of nodes.entries()) {
    const w = target.writerFor(g, canvas);
    const routedHere = routed.get(g.node) ?? [];

    // ---- the node's own activations: waiting first, then the ones cancellation caught ----
    const activations = activationsOf(w);
    for (const a of activations) w.push(a.executionData, a.waiting);

    // ---- an agent round the pause or the halt caught mid-flight ----
    for (const e of roundEntriesOf(g, marking, diag)) w.push(e);

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
  return target.writeTo(executionData);
}

/**
 * The places the net drains on its own before it quiesces: a token on one is a
 * {@link CodecError} naming node and place, except under `cancelled`, the one mode that
 * legitimately sees them.
 */
function assertDrained(nodes: readonly NodeGadget[], marking: Marking, mode: EncodeMode): void {
  const undrained = (g: NodeGadget, place: Place<unknown>): CodecError => new CodecError(
    `node '${g.node}': ${marking.tokenCount(place)} token(s) on '${place.name}' — the net must be drained before ` +
    `encoding (mode '${mode}')`);
  for (const g of nodes) {
    if (mode !== 'cancelled') {
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
      for (const p of inFlight) if (p !== null && marking.tokenCount(p) > 0) throw undrained(g, p);
    }
    if (mode === 'stranded') {
      if (g.retry !== null && marking.tokenCount(g.retry.retry) > 0) throw undrained(g, g.retry.retry);
      // `X/failed_i` is `X/retry` for a chain: a pending activation, not residue.
      for (const a of g.attempts) if (marking.tokenCount(a.failed) > 0) throw undrained(g, a.failed);
    }
  }
}

/**
 * The tokens on one of the node's places that carry the payload the gadget puts there. A
 * token of any other shape is reported by node and place and skipped: the encoder writes
 * n8n's state from what a token says, so a token that says nothing cannot become a stack entry.
 */
function payloadsOn<T>(w: NodeWriter, place: Place<unknown>, guard: (v: unknown) => v is T, expected: string): T[] {
  const out: T[] = [];
  for (const t of w.marking.peekTokens(place)) {
    if (guard(t.value)) out.push(t.value);
    else w.diag(`node '${w.g.node}': token on '${place.name}' carries no ${expected}; dropped`);
  }
  return out;
}

/** One of a node's own activations, as the stack entry it goes back as. */
interface Activation {
  readonly executionData: IExecuteData;
  readonly waiting: boolean;
}

/**
 * A node's own activations in stack order: waiting first, then the ones cancellation caught
 * — stopped before it ran, retrying, running — and its `onFailure` chain in the same order
 * and for the same reason: a failure whose step has not acted (`X/failed_i`), an attempt a
 * deadline abandoned in a halted net (`X/timedout_i`), and a later attempt cancellation
 * caught mid-run (`X/running_i`). Each becomes an ordinary stack entry and the activation
 * re-runs from its first attempt — n8n has nowhere to persist the position, which
 * `tasks/todo.md` §4b records.
 */
function activationsOf(w: NodeWriter): Activation[] {
  const { g } = w;
  const out: Activation[] = [];
  const own = (list: ReadonlyArray<{ readonly executionData: IExecuteData }>, waiting = false): void => {
    for (const v of list) out.push({ executionData: v.executionData, waiting });
  };
  own(payloadsOn(w, g.waiting, isWaitingPayload, 'waiting activation'), true);
  own(payloadsOn(w, g.stopped, isStoppedPayload, 'stopped activation').filter((v) => !v.ran));
  if (g.retry !== null) own(payloadsOn(w, g.retry.retry, isRetryPayload, 'retry'));
  own(payloadsOn(w, g.running, isRunPayload, 'run'));
  for (const a of g.attempts) {
    own(payloadsOn(w, a.failed, isRetryPayload, 'retry'));
    if (a.timedOut !== null) own(payloadsOn(w, a.timedOut, isRunPayload, 'run'));
    if (a.index > 1) own(payloadsOn(w, a.running, isRunPayload, 'run'));
  }
  return out;
}

/**
 * A direct-form node's pending arrivals, `X/in` then the routed ones, as stack entries
 * (stranded: rows). A pending empty is dropped with a report: n8n never enqueues one.
 */
function encodeDirect(w: NodeWriter, g: DirectGadget, routedHere: readonly RoutedArrival[]): void {
  const { compiled, marking, mode } = w;
  for (const r of routedHere) assertDirectArrival(compiled, g, r);
  const inputIndex = directInputIndex(compiled, g);
  const arrivals: Cell[] = [
    ...marking.peekTokens(g.in).map((t): Cell => ({ value: t.value, place: g.in })),
    ...routedHere.filter((r) => r.payload !== null).map((r): Cell => ({ value: r.payload, place: g.in })),
  ];
  for (const a of arrivals) {
    const e = w.entryOf(inputIndex, a.value, a.place);
    if (e === null) continue;
    if (mode === 'stranded') w.strand(inputIndex, e, a.place);
    else w.push(e);
  }
  if (g.inEmpty !== null && marking.tokenCount(g.inEmpty) > 0) {
    w.diag(`node '${g.node}': ${marking.tokenCount(g.inEmpty)} pending empty token(s) on '${g.inEmpty.name}'; n8n never enqueues an empty, dropped`);
  }
}
