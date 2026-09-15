/**
 * A node's own activations as the encoder writes them back: the tokens on its waiting,
 * stopped, retry, running and `onFailure`-chain places that carry the payload the gadget puts
 * there, each as the stack entry it goes back as ({@link activationsOf}).
 */
import type { Place } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import { isRetryPayload, isRunPayload, isStoppedPayload, isWaitingPayload } from '../scheduler/payloads.js';
import type { NodeWriter } from './writer.js';

/** One of a node's own activations, as the stack entry it goes back as. */
export interface Activation {
  readonly executionData: IExecuteData;
  readonly waiting: boolean;
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

/**
 * A node's own activations in stack order: waiting first, then the ones cancellation caught
 * — stopped before it ran, retrying, running — and its `onFailure` chain in the same order
 * and for the same reason: a failure whose step has not acted (`X/failed_i`), an attempt a
 * deadline abandoned in a halted net (`X/timedout_i`), and a later attempt cancellation
 * caught mid-run (`X/running_i`). Each becomes an ordinary stack entry and the activation
 * re-runs from its first attempt — n8n has nowhere to persist the position, which
 * `tasks/todo.md` §4b records.
 */
export function activationsOf(w: NodeWriter): Activation[] {
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
