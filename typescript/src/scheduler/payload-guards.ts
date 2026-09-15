/**
 * The runtime guards of the token vocabulary in `payloads.ts`. Every payload is discriminated
 * on its `kind`, so each guard is the one test {@link hasKind} makes. The actions narrow what a
 * firing consumed through them (`take`), and the marking codec reads the marking back with them.
 */
import type {
  DispatchPayload, EdgePayload, EntryPayload, OkPayload, RequestPayload, RetryPayload, RoundPayload, RunPayload,
  StoppedPayload, WaitingPayload,
} from './payloads.js';

/** Whether `v` is an object whose `kind` is `kind`: the discriminant every payload carries. */
function hasKind(v: unknown, kind: string): boolean {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === kind;
}

export function isRoundPayload(v: unknown): v is RoundPayload {
  return hasKind(v, 'round');
}

export function isRequestPayload(v: unknown): v is RequestPayload {
  return hasKind(v, 'request');
}

export function isDispatchPayload(v: unknown): v is DispatchPayload {
  return hasKind(v, 'dispatch');
}

export function isRunPayload(v: unknown): v is RunPayload {
  return hasKind(v, 'run');
}

export function isRetryPayload(v: unknown): v is RetryPayload {
  return hasKind(v, 'retry');
}

export function isOkPayload(v: unknown): v is OkPayload {
  return hasKind(v, 'ok');
}

export function isWaitingPayload(v: unknown): v is WaitingPayload {
  return hasKind(v, 'waiting');
}

export function isStoppedPayload(v: unknown): v is StoppedPayload {
  return hasKind(v, 'stopped');
}

export function isEdgePayload(v: unknown): v is EdgePayload {
  return hasKind(v, 'edge');
}

export function isEntryPayload(v: unknown): v is EntryPayload {
  return hasKind(v, 'entry');
}
