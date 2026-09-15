/**
 * After quiescence: the marking classified, and what n8n owns written back to it — step 5 of
 * `PetriScheduler.run()` (see `petri-scheduler.ts`). In order: a halt (the host pushed the
 * failed entry, the marking carries the rest), a pause (`_pause` / `X/waiting` / `X/stopped`),
 * a cancellation, natural quiescence.
 */
import type { Marking } from 'libpetri';
import type { Workflow } from 'n8n-workflow';
import { encodeMarking, type EncodeMode } from '../codec.js';
import type { CompiledWorkflow } from '../compiler/index.js';
import type { ExecutionDataState, SchedulerHost } from '../n8n/host.js';
import { isStoppedPayload } from './payloads.js';
import type { SchedulerOutcome } from './scheduler-types.js';
import { UnexpectedTokenError } from './take.js';

/** The outcomes a run that reached quiescence can end on. */
export type QuiescentOutcome = Extract<SchedulerOutcome, 'completed' | 'paused' | 'cancelled' | 'halted' | 'stranded'>;

/** One quiescent run: what the marking is read from and where the write-back goes. */
export interface QuiescentRun {
  readonly compiled: CompiledWorkflow;
  readonly marking: Marking;
  readonly executionData: ExecutionDataState;
  readonly host: SchedulerHost;
  readonly workflow: Workflow;
  readonly cancelled: boolean;
  readonly diagnostic: (message: string) => void;
}

/** Encodes the marking back into `executionData` in `mode`; returns how many diagnostics the codec emitted. */
function encode(run: QuiescentRun, mode: EncodeMode): number {
  let emitted = 0;
  encodeMarking(run.compiled, run.marking, run.executionData, {
    mode,
    node: (name: string) => run.workflow.nodes[name],
    onDiagnostic: (m) => {
      emitted++;
      run.diagnostic(m);
    },
  });
  return emitted;
}

/**
 * The halt. n8n's `handleNodeExecutionError` pushed the failed entry and its loop `break`s, so
 * everything it had not popped stays on the stack — the entries `ExecutionService` replays on
 * "Retry execution". Nothing consumes `_halt` and nothing clears those tokens
 * (`compiler/compile.ts`), so the quiescent marking holds every one of them: the ones that were
 * pending when the halt branch was written, and the ones an in-flight action deposited
 * afterwards (EXEC-040: they finish, and their routes are not halt-inhibited).
 */
function writeBackHalt(run: QuiescentRun): QuiescentOutcome {
  const { executionData } = run;
  const pushed = [...executionData.nodeExecutionStack];
  encode(run, 'cancelled');
  const pending = executionData.nodeExecutionStack;
  executionData.nodeExecutionStack = [...pushed, ...pending];
  if (pending.length > 0) {
    run.diagnostic(`halted: ${pending.length} pending activation(s) written back to nodeExecutionStack ` +
      `(${pending.map((e) => e.node.name).join(', ')})`);
  }
  return 'halted';
}

/** Which kinds of `X/stopped` token the marking holds: a destination stop (`ran: true`), a stop before the run. */
function stopsIn(run: QuiescentRun): { readonly destinationStopped: boolean; readonly stoppedBeforeRun: boolean } {
  let destinationStopped = false;
  let stoppedBeforeRun = false;
  for (const g of run.compiled.netMap.nodes) {
    for (const t of run.marking.peekTokens(g.stopped)) {
      const v = t.value;
      if (!isStoppedPayload(v)) throw new UnexpectedTokenError(g.transitions.run, g.stopped.name);
      if (v.ran) destinationStopped = true;
      else stoppedBeforeRun = true;
    }
  }
  return { destinationStopped, stoppedBeforeRun };
}

/**
 * A pause: a Wait, a destination-node stop, or a stop before the run. A cancellation that
 * arrives while the net is paused leaves the tokens `close()` caught between `X_run` and
 * `X_route` (ENV-013), which only mode `cancelled` can encode — it routes them as `X_route`
 * would have. Encoding those in mode `pause` is a `CodecError`, and the pending state would be
 * lost with it.
 */
function writeBackPause(run: QuiescentRun, waitingNodes: readonly string[], destinationStopped: boolean): QuiescentOutcome {
  const { executionData, cancelled } = run;
  encode(run, cancelled ? 'cancelled' : 'pause');
  if (destinationStopped) {
    // After the destination node n8n keeps popping: an entry outside the run filter is
    // dropped at lines 74–76 without running. The pause left those entries pending;
    // drop them through the same predicate. A waiting node stays: it must re-run.
    executionData.nodeExecutionStack = executionData.nodeExecutionStack.filter(
      (e) => waitingNodes.includes(e.node.name) || !run.host.isNodeFilteredOut(e.node.name));
  }
  // Only `ran: false` stops (the host's `shouldStopExecuting()` was true when `X_run`
  // fired, e.g. the workflow timeout) without a Wait or a destination stop is a
  // cancellation: n8n's loop `return`s and leaves the entry on the stack.
  if (cancelled) return 'cancelled';
  return waitingNodes.length > 0 || destinationStopped ? 'paused' : 'cancelled';
}

/**
 * Classifies the quiescent marking and writes back what n8n owns. In order: a halt (the
 * host pushed the failed entry, the snapshot taken before the reap carries the rest), a
 * pause (`_pause` / `X/waiting` / `X/stopped`), a cancellation, natural quiescence.
 */
export function finish(run: QuiescentRun): QuiescentOutcome {
  const { compiled, marking } = run;
  const shared = compiled.netMap.shared;
  if (marking.tokenCount(shared.halt) > 0) return writeBackHalt(run);

  const waitingNodes = compiled.netMap.nodes.filter((g) => marking.tokenCount(g.waiting) > 0).map((g) => g.node);
  const { destinationStopped, stoppedBeforeRun } = stopsIn(run);
  if (marking.tokenCount(shared.pause) > 0 || waitingNodes.length > 0 || destinationStopped || stoppedBeforeRun) {
    return writeBackPause(run, waitingNodes, destinationStopped);
  }
  if (run.cancelled) {
    encode(run, 'cancelled');
    return 'cancelled';
  }
  return encode(run, 'stranded') > 0 ? 'stranded' : 'completed';
}
