/**
 * The local (pre-composition) shapes of the gadget's parts: its edges, input side, outputs and
 * routing, `onFailure` attempts, retry and agent places, over the subnet's own places. The
 * materialised {@link NodeGadget} has the same shapes over the canonical places.
 */
import type { Place } from 'libpetri';
import type { EdgeRef, EdgeSlot, InputGadgetCommon, OrSlot, ReadySlot, SplitReadySlot } from '../types.js';

/**
 * One edge as the gadget sees it: its local port places (`empty` only where this side declares
 * the port) and the consumer-owned host slot `compile` created, which is what the materialised
 * gadget reports — for an output edge too, where a cyclic producer without a skip writes no
 * empty but the consumer still owns one.
 */
export interface LocalEdge {
  readonly edge: EdgeRef;
  readonly data: Place<unknown>;
  readonly empty: Place<unknown> | null;
  readonly host: EdgeSlot;
}

/** The common input fields over local (subnet) edge places; the slot places are the local ones too. */
export type LocalInputCommon = Omit<InputGadgetCommon, 'edges'> & { readonly edges: readonly LocalEdge[] };
export type LocalOrInput = LocalInputCommon & OrSlot;
export type LocalReadyInput = LocalInputCommon & ReadySlot;
export type LocalSplitReadyInput = LocalInputCommon & SplitReadySlot;
export type LocalJoinInput = LocalReadyInput | LocalSplitReadyInput;

export interface LocalDirectSide { readonly form: 'direct'; readonly in: Place<unknown>; readonly inEmpty: Place<unknown> | null }
export interface LocalOrSide { readonly form: 'or'; readonly input: LocalOrInput }
export interface LocalJoinSide { readonly form: 'join'; readonly hasdata: Place<unknown>; readonly inputs: readonly LocalReadyInput[] }
export interface LocalChooseBranchSide { readonly form: 'choose-branch'; readonly inputs: readonly LocalJoinInput[] }
export interface LocalToolSide { readonly form: 'tool'; readonly inTool: Place<unknown> }
/** The input side, by form, over local places (the shape {@link NodeGadget} takes after composition). */
export type LocalInputSide = LocalDirectSide | LocalOrSide | LocalJoinSide | LocalChooseBranchSide | LocalToolSide;

export interface LocalOutputCommon {
  readonly index: number;
  readonly edges: readonly LocalEdge[];
  readonly nil: Place<unknown> | null;
}
export type LocalCollapsedOutput = LocalOutputCommon & { readonly routing: 'collapsed' };
export type LocalSplitOutput = LocalOutputCommon & { readonly routing: 'split'; readonly ok: Place<unknown>; readonly routed: Place<unknown> };
export type LocalOutput = LocalCollapsedOutput | LocalSplitOutput;
export type LocalRouting =
  | { readonly kind: 'collapsed'; readonly routed: Place<unknown>; readonly outputs: readonly LocalCollapsedOutput[] }
  | { readonly kind: 'split'; readonly outputs: readonly LocalSplitOutput[] };

export interface LocalAttemptCommon {
  readonly index: number;
  readonly running: Place<unknown>;
  readonly failed: Place<unknown>;
  readonly timedOut: Place<unknown> | null;
}
export type LocalAttempt = LocalAttemptCommon & (
  | { readonly action: 'retry'; readonly waitMs: number; readonly next: Place<unknown> }
  | { readonly action: 'route'; readonly outputIndex: number }
  | { readonly action: 'stop' | 'continue' }
);

export interface LocalRetry {
  readonly retry: Place<unknown>;
  readonly tries: Place<unknown>;
  readonly maxTries: number;
  readonly waitBetweenTries: number;
}

export interface LocalAgent {
  readonly routedRequest: Place<unknown>;
  readonly queue: Place<unknown>;
  readonly calls: Place<unknown>;
  readonly drained: Place<unknown>;
  readonly outstanding: Place<unknown>;
  readonly dispatched: Place<unknown>;
  readonly rounds: Place<unknown>;
  readonly response: Place<unknown>;
  readonly tools: readonly [string, ...string[]];
  readonly maxRounds: number;
  readonly roundsAssumed: boolean;
  readonly maxToolCalls: number;
  readonly toolCallsAssumed: boolean;
}
