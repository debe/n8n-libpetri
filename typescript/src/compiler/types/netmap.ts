/**
 * The vocabulary `NetMap` speaks: the role of every transition and place of the flat net
 * (MOD-023), the edge an arm or an edge place serves, and the `data` / `empty` variant.
 * Read by the scheduler's action binders, the marking codec and the verifier.
 */
import type { Place } from 'libpetri';

/**
 * Transition roles of the per-node gadget (README "Per-node gadget", ADR 0004):
 * - `start` / `start-unmet`: `X_start` and its per-reference twin that fires when the
 *   referenced node was skipped (the running token then carries the unmet reference);
 * - `run`: the node action, which routes every output in its own `Out` spec unless the node
 *   has more than {@link SPLIT_ROUTING_ABOVE} connected outputs; `route`: per-output
 *   routing under that split shape only (one per connected output, carrying `port`);
 *   `done`: the `X_done` that refunds the budget once the outcome is routed — **every**
 *   node has one, which is what puts the refund one scheduling cycle after the edge tokens;
 * - `skip`: an empty activation; `arm`: an edge arrival of a join / OR input; `clear`:
 *   the OR-input round closer (a genuine sink, CORE-043 AC4);
 * - `retry` (`X_retry_wait`), `exhausted`, `sink` (`nil` drain);
 * - `attempt`: one step of a declared `onFailure` policy (ADR 0009). It is what `retry` and
 *   `exhausted` become when the allowance is a chain rather than a counter: the *i*-th step
 *   consumes `X/failed_i` and either escalates to `X/running_{i+1}` or takes a terminal arm;
 * - `deadline`: the funnel that turns an expired per-attempt deadline (`X/timedout_i`) into the
 *   ordinary failure (`X/failed_i`), so one step answers both.
 */
export type TransitionRole =
  | 'start' | 'start-unmet' | 'run' | 'run-failed' | 'route' | 'done' | 'skip' | 'arm' | 'clear' | 'retry' | 'exhausted'
  | 'sink' | 'attempt' | 'deadline'
  | 'done-request' | 'dispatch' | 'collect' | 'resume' | 'rounds-out' | 'calls-out';

/**
 * Place roles. Besides the per-node gadget places (README "Per-node gadget"):
 * - `waiting`: the node put the execution to wait (n8n `waitTill`) and must re-run on
 *   resume; the token carries the node's input `executionData` (n8n's `pushExecutionStack`);
 * - `stopped`: the destination node ran and its successors must not be enqueued (or the
 *   execution was cancelled before the node ran); never routed;
 * - `pause`: the shared control terminal `_pause` a `waiting` / `stopped` outcome deposits.
 *   Every start, start-unmet and retry-wait inhibits on it; routes, skips, arms, clears,
 *   done and exhausted do not, so a paused net drains its structural transitions and
 *   quiesces with every token on an in / ready / hasdata / waiting place.
 *
 * The agent round adds its own (README "Agent tool dispatch"). `in-tool`, `queue`, `drained`,
 * `outstanding` and `dispatched` are **a round in flight**: a net that quiesces holding one of
 * them has a tool call or a re-entry the codec must write back, so they join the codec's rest
 * set inside a designed terminal exactly as `in-data` and `ready` do. `rounds` and `calls` are
 * budgets, consumed like `_budget` and never pending.
 *
 * A declared `onFailure` policy adds `failed` (ADR 0009): `X/failed_i` holds the *i*-th
 * attempt's failure until its step acts on it. It is `retry`'s analogue and classifies like it
 * — pending work, so a quiescent marking holding one is a stranding unless the class is a
 * designed terminal, where the codec writes it back.
 *
 * An `engineV2` net has its own three (`tasks/v2-profile-plan.md` decisions 3 and 5), besides
 * `running`, `done`, `skipped`, `ok` and `halt`, which mean there what they mean in a v1 net:
 * - `arrived`: `e{id}/arrived`, one unit when edge `id`'s source step has settled, live or not
 *   (`decideNodeFate`'s "every step its incoming edges read has settled", rule 3 of
 *   `packages/@n8n/engine/src/execution/settlement.ts`). The trigger's synthetic arrival is one
 *   too, with no `edge`;
 * - `live`: `X/live`, one unit per incoming edge whose source completed and filled the edge's
 *   slot (`isLive`, rule 2). `X_start` takes them all, `X_skip` is inhibited by any;
 * - `ended`: `B/ended`, a batch loop's end marker, written by the batch node's terminal pass — a
 *   skip, a run that filled no loop slot, or a failed run (`isTerminalStep`,
 *   `execution/loop-ledger.ts`; decision 5).
 */
export type PlaceRole =
  | 'in-data' | 'in-empty' | 'edge-data' | 'edge-empty' | 'nil' | 'ready' | 'hasdata' | 'ran' | 'free'
  | 'idle' | 'running' | 'ok' | 'routed' | 'done' | 'skipped' | 'retry' | 'tries' | 'waiting' | 'stopped'
  | 'budget' | 'halt' | 'pause' | 'failed'
  | 'in-tool' | 'routed-request' | 'queue' | 'drained' | 'outstanding' | 'response'
  | 'dispatched' | 'rounds' | 'calls' | 'running-failed'
  | 'arrived' | 'live' | 'ended';

/** `tree`: the two ends are in different SCCs; `cycle`: both ends share one SCC. */
export type EdgeKind = 'tree' | 'cycle';

/** `data` / `empty` variant of an arm, a ready place or an enumerated join combination. */
export type Variant = 'data' | 'empty';

/** One (deduplicated) main connection with its SCC classification. */
export interface EdgeRef {
  /** Stable index of the edge in canonical order (producer canvas index, output, consumer canvas index, input). */
  readonly id: number;
  readonly from: string;
  readonly outputIndex: number;
  readonly to: string;
  readonly inputIndex: number;
  readonly kind: EdgeKind;
}

/** The fields every transition of the flat net carries. */
export interface TransitionInfoCommon {
  /** Full transition name in the flat net (`nodeId/start`, `nodeId/run`, …). */
  readonly name: string;
  /** Owning node name; every transition of the flat net belongs to one. */
  readonly node: string;
}

export interface StartTransition extends TransitionInfoCommon {
  readonly role: 'start';
}

export interface StartUnmetTransition extends TransitionInfoCommon {
  readonly role: 'start-unmet';
  /** The referenced node this twin reports as unmet. */
  readonly reference: string;
}

export interface RunTransition extends TransitionInfoCommon {
  readonly role: 'run';
  /**
   * 1-based attempt this run serves (ADR 0009). `1` on a policy-free node, whose only run is
   * its first attempt; `X_run_i` of an `onFailure` chain carries its own *i*.
   */
  readonly attempt: number;
}

export interface RunFailedTransition extends TransitionInfoCommon {
  /**
   * `A_run_failed`: an agent's budget-exceeded re-entry (ADR 0008). It runs the node off
   * `A/running_failed`, which only `A_calls_out` writes, so the primary run is structurally
   * unreachable from `A_calls_out` — no inhibitor, so a linear ranking can bound the round.
   * Its out spec is the non-agent outcome, with no request branch.
   */
  readonly role: 'run-failed';
}

export interface RouteTransition extends TransitionInfoCommon {
  readonly role: 'route';
  /** Output index of this per-output `X_route_o`. */
  readonly port: number;
}

export interface DoneTransition extends TransitionInfoCommon {
  readonly role: 'done';
}

export interface SkipTransition extends TransitionInfoCommon {
  readonly role: 'skip';
  /**
   * Per-input variants of an enumerated (chooseBranch) skip, listed inputs only; empty for
   * the single skip of every other form.
   */
  readonly combination: readonly Variant[];
}

export interface ArmTransition extends TransitionInfoCommon {
  readonly role: 'arm';
  /** The edge this arm serves. */
  readonly edge: EdgeRef;
  /** `data` / `empty`. */
  readonly variant: Variant;
}

export interface ClearTransition extends TransitionInfoCommon {
  readonly role: 'clear';
  /** Input index of the OR input this `X_clear_i` closes. */
  readonly port: number;
}

export interface RetryTransition extends TransitionInfoCommon {
  readonly role: 'retry';
}

export interface ExhaustedTransition extends TransitionInfoCommon {
  readonly role: 'exhausted';
}

export interface SinkTransition extends TransitionInfoCommon {
  readonly role: 'sink';
}

export interface AttemptTransition extends TransitionInfoCommon {
  readonly role: 'attempt';
  /** 1-based attempt whose failure this step answers (ADR 0009). */
  readonly attempt: number;
}

export interface DeadlineTransition extends TransitionInfoCommon {
  readonly role: 'deadline';
  /** 1-based attempt whose expired deadline this funnel turns into its failure (ADR 0009). */
  readonly attempt: number;
}

export interface DoneRequestTransition extends TransitionInfoCommon {
  readonly role: 'done-request';
}

export interface DispatchTransition extends TransitionInfoCommon {
  readonly role: 'dispatch';
}

export interface CollectTransition extends TransitionInfoCommon {
  readonly role: 'collect';
}

export interface ResumeTransition extends TransitionInfoCommon {
  readonly role: 'resume';
}

export interface RoundsOutTransition extends TransitionInfoCommon {
  readonly role: 'rounds-out';
}

export interface CallsOutTransition extends TransitionInfoCommon {
  readonly role: 'calls-out';
}

/** One transition of the flat net, discriminated on {@link TransitionRole}. */
export type TransitionInfo =
  | StartTransition | StartUnmetTransition | RunTransition | RunFailedTransition | RouteTransition | DoneTransition | SkipTransition
  | ArmTransition | ClearTransition | RetryTransition | ExhaustedTransition | SinkTransition
  | AttemptTransition | DeadlineTransition
  | DoneRequestTransition | DispatchTransition | CollectTransition | ResumeTransition | RoundsOutTransition
  | CallsOutTransition;

/** The member of {@link TransitionInfo} carrying `role`. */
export type TransitionInfoOf<R extends TransitionRole> = Extract<TransitionInfo, { role: R }>;

export interface PlaceInfo {
  readonly name: string;
  readonly role: PlaceRole;
  /** Owning node name; `null` for `_budget`, `_halt`, `_pause`. Edge places belong to their consumer. */
  readonly node: string | null;
  /** Input index for input-side places, output index for `nil` / `ok_o` / `routed_o`; `null` otherwise (`X/routed` included). */
  readonly port: number | null;
  /** The canonical `Place` object of the flat net. */
  readonly place: Place<unknown>;
  /** The edge an edge/in place carries (absent for a synthetic `in`). */
  readonly edge?: EdgeRef;
  /** `data` / `empty` for an enumerated join's `ready` places. */
  readonly variant?: Variant;
}

/** A {@link PlaceInfo} before the canonical place object is known (the gadget's own record). */
export type PendingPlace = Omit<PlaceInfo, 'place'>;

/**
 * One edge of an `engineV2` net (`tasks/v2-profile-plan.md` decision 3): its `arrived` place and
 * the consumer's `live` place, which a live settlement of the source also writes.
 */
export interface SettlementEdge {
  readonly edge: EdgeRef;
  /** `e{id}/arrived`: the source step has settled. */
  readonly arrived: Place<unknown>;
  /** `edge.to`'s `X/live`: written beside `arrived` when the source filled the edge's slot. */
  readonly live: Place<unknown>;
}

/** One connected output slot of an `engineV2` node. */
export interface SettlementOutput {
  readonly index: number;
  /** The slot's edges in edge order, every one live or every one dead (`isLive`). */
  readonly edges: readonly SettlementEdge[];
  /** `X/ok_o`, which `X_run` writes and `X_route_o` routes, under split routing; `null` otherwise. */
  readonly ok: Place<unknown> | null;
}

/**
 * Whether a node's run can end in a failure, which halts the execution (decision 8):
 * - `never`: the trigger, which `ExecutionStartHandler` records `completed` at birth (decision 7);
 * - `possible`: every node that runs an executor.
 *
 * A `wait` or `subworkflow` step, which v2 has no executor for, is refused at compile time
 * (`v2-unsupported-step`), so no node has a run that always fails.
 */
export type SettlementFailure = 'never' | 'possible';

/**
 * The flat-net names of an `engineV2` node's transitions: `X_start`, `X_skip` (none on the
 * trigger, which nothing can skip), `X_run`, and one `X_route_o` per connected output under split
 * routing. On a batch node `start` / `skip` are `B_start_entry` / `B_skip_entry`, the pass-0 pair;
 * the back-edge pair is {@link SettlementBatch}`.transitions`.
 */
export interface SettlementTransitions {
  readonly start: string;
  readonly skip: string | null;
  readonly run: string;
  readonly routes: readonly string[];
}

/**
 * What a batch node adds to its {@link SettlementGadget} (`tasks/v2-profile-plan.md` decision 5):
 * the two edges into its slot 0, which never apply at one pass (`resolveInputReads`,
 * `execution/step-ready-handler.ts`), the start and skip of the back edge, and the loop's end
 * marker.
 */
export interface SettlementBatch {
  /** The one edge into the batch node from outside its loop (`entry`, or `exit` of an earlier loop): pass 0. */
  readonly entry: SettlementEdge;
  /** The loop's one return edge (`isBackEdge`): pass `p` of its source decides pass `p + 1`. */
  readonly back: SettlementEdge;
  /** `B/ended`, written by the terminal pass. */
  readonly ended: Place<unknown>;
  /** `B_start_back` and `B_skip_back`. */
  readonly transitions: { readonly startBack: string; readonly skipBack: string };
}

/**
 * One node of an `engineV2` net (`tasks/v2-profile-plan.md` decisions 3, 4, 7 and 8), over the
 * flat net's canonical places. It is not a {@link NodeGadget}: an `engineV2` node has no budget,
 * idle marker, input form, retry or agent side, and the v1 consumers read those, so the two are
 * kept apart by type rather than by an empty field (decision 14).
 */
export interface SettlementGadget {
  readonly node: string;
  readonly id: string;
  readonly type: string;
  readonly typeVersion: number;
  /** v2's one `trigger` step. */
  readonly isTrigger: boolean;
  readonly failure: SettlementFailure;
  /** The trigger's seeded synthetic arrival `T/in`; `null` on every other node. */
  readonly in: Place<unknown> | null;
  /** `X/live`; `null` on the trigger, which nothing feeds. */
  readonly live: Place<unknown> | null;
  /** The incoming edges `X_start` and `X_skip` wait on, in edge order. */
  readonly incoming: readonly SettlementEdge[];
  readonly running: Place<unknown>;
  /** `X/done`, written by every run; `null` on a loop member (decision 6). */
  readonly done: Place<unknown> | null;
  /** `X/skipped`, written by `X_skip`; `null` on the trigger and on a loop member. */
  readonly skipped: Place<unknown> | null;
  /**
   * `collapsed`: `X_run` routes every connected output in its own `Out` spec; `split`: it writes
   * `X/ok_o` per connected output, and `X_route_o` routes each (decision 4); `batch`: `B_run` fills
   * the loop slot, the done slot or neither, never both (`runBatchStep`, decision 5).
   */
  readonly routing: 'collapsed' | 'split' | 'batch';
  /** The connected output slots, ascending. */
  readonly outputs: readonly SettlementOutput[];
  readonly transitions: SettlementTransitions;
  /** The batch node of the loop this node is a member of (decision 6), itself on a batch node; `null` outside a loop. */
  readonly loop: string | null;
  /** A batch node's entry and back pair and end marker; `null` on every other node. */
  readonly batch: SettlementBatch | null;
}
