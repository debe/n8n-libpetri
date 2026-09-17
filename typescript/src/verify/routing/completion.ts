/**
 * Proper completion's route: the graph's own stranding classification first (NU-053), and the
 * whole-net `deadlockFree` query — rest set as sinks, pause / halt widenings as conditional
 * sinks (VER-002, VER-014) — only where the graph did not close.
 */
import type { Place } from 'libpetri';
import { deadlockFree } from 'libpetri/verification';
import type { NetMapView, PlaceRole } from '../../compiler/index.js';
import {
  TERMINAL_WITNESS_REASON, completionUnknownReason, smtFallbackNote, undecidedReason,
} from '../reasons.js';
import { witnessCounterexample } from '../state-space/decode.js';
import {
  HALT_REST_ROLES, PAUSE_REST_ROLES, REST_ROLES, restRolesFor, terminalKindOf,
} from '../state-space/roles.js';
import type { Counterexample, MarkedPlace, QueryRecord } from '../types.js';
import type { Context, Decision } from './context.js';
import { boundedOrUnknown, graphDecision } from './graph.js';
import { smtDecision, type ConditionalSink } from './smt.js';

/** A check's sink declaration by name, exactly as {@link QueryRecord} records it. */
export type SinkRecord = Pick<QueryRecord, 'sinks' | 'conditionalSinks'>;

/**
 * The whole-net completion question's sink declaration (VER-002, VER-014).
 *
 * It is a property of the net, not of any one check, so it is computed once when the context
 * is built rather than rescanned for every completion row, and every proper-completion row's
 * {@link QueryRecord} references the same {@link recorded} name lists rather than copying them.
 * The serialised report is unchanged: each row still carries both lists.
 */
export interface CompletionSinks {
  /**
   * The structural rest set as `Place` objects: the unconditional sink declaration the
   * whole-net `deadlockFree` fallback is asked with (VER-002). It is exactly `REST_ROLES` read
   * off `NetMap`, so the SMT question and the graph's classification start from the same set.
   */
  readonly sinks: readonly Place<unknown>[];
  /**
   * The pause filter as a sink declaration: while `_pause` is marked a token may rest on the
   * places `PAUSE_REST_ROLES` adds to the rest set, and while `_halt` is marked on those
   * `HALT_REST_ROLES` adds. `terminalKindOf` also treats a marked `waiting` / `stopped` place
   * as a pause, and `_pause` alone reproduces that because every branch that produces one
   * produces `_pause` beside it and nothing ever consumes `_pause` (`compiler/gadget.ts`, the
   * waiting and stopped branches). `HALT_REST_ROLES ⊇ PAUSE_REST_ROLES`, so libpetri's union
   * across markers is the graph's halt-over-pause precedence. A net without the marker
   * declares nothing for it.
   */
  readonly conditional: readonly ConditionalSink[];
  /** Both declarations by name, shared by reference by every completion row's query record. */
  readonly recorded: SinkRecord;
}

/** Each designed-terminal marker, in declaration order, with the rest set it widens to. */
const WIDENINGS: readonly (readonly [PlaceRole, ReadonlySet<PlaceRole>])[] = [
  ['pause', PAUSE_REST_ROLES],
  ['halt', HALT_REST_ROLES],
];

/** Builds {@link CompletionSinks} from the net map, once per report. */
export function completionSinksOf(map: NetMapView): CompletionSinks {
  const sinks = map.places.filter((p) => REST_ROLES.has(p.role)).map((p) => p.place);
  const conditional: ConditionalSink[] = [];
  for (const [role, roles] of WIDENINGS) {
    const marker = map.places.find((p) => p.role === role)?.place ?? null;
    if (marker !== null) conditional.push({ marker, places: widened(map, roles) });
  }
  return {
    sinks,
    conditional,
    recorded: {
      sinks: sinks.map((p) => p.name),
      conditionalSinks: conditional.map((c) => ({ marker: c.marker.name, places: c.places.map((p) => p.name) })),
    },
  };
}

/** The places `roles` admits beyond the structural rest set. */
function widened(map: NetMapView, roles: ReadonlySet<PlaceRole>): readonly Place<unknown>[] {
  return map.places.filter((p) => roles.has(p.role) && !REST_ROLES.has(p.role)).map((p) => p.place);
}

/**
 * Does any reachable quiescent marking leave pending work on `place`?
 *
 * Complete graph: exact — `violated` with the stuck marking and the firing path, or
 * `proven`. Truncated graph: a stranding actually found is still a real one (a quiescent
 * class of the explored prefix is quiescent and reachable), so it is reported; the absence
 * of one is **not** a proof and returns `null` so the caller falls back.
 */
export function graphStranding(ctx: Context, place: Place<unknown>): Decision | null {
  if (!ctx.space.usable) return null;
  const stranding = ctx.space.strandedAt(place);
  if (stranding !== null) return graphDecision('violated', witnessCounterexample(stranding));
  if (!ctx.space.complete) return null;
  return graphDecision('proven');
}

/** The rest set the witness marking's own terminal kind is classified against (VER-014). */
function witnessRestRoles(cex: Counterexample): ReadonlySet<PlaceRole> {
  return restRolesFor(terminalKindOf(cex.stuckMarking.map((p) => p.role)));
}

/** Pending work rather than residue `rest` licenses — the per-place stranding test. */
function isStranded(rest: ReadonlySet<PlaceRole>, marked: MarkedPlace): boolean {
  return marked.role === null || !rest.has(marked.role);
}

/** True when every place the witness marking holds is residue its terminal kind excuses. */
function witnessIsExcusedTerminal(cex: Counterexample | null): boolean {
  if (cex === null) return false;
  const rest = witnessRestRoles(cex);
  return !cex.stuckMarking.some((p) => isStranded(rest, p));
}

/**
 * Whether the fallback's witness marking strands **this** place.
 *
 * Marked is not stranded. Inside a designed terminal the rest set widens (VER-014,
 * `roles.ts`) and a token the codec writes back is residue by design — `in-data` is in
 * `PAUSE_REST_ROLES` precisely because mode `pause` pushes that entry back onto
 * `nodeExecutionStack` (ADR 0005). {@link witnessIsExcusedTerminal} lets the whole-net
 * verdict stand as soon as *one* place is unexcused, so attributing that verdict to a row
 * has to apply the same widening. Asking only "is it marked?" reports an excused `X/in`
 * sitting beside a real stranding elsewhere as this row's own violation — a `violated` on a
 * row the complete graph proves, which is the one direction this verifier must never get
 * wrong.
 */
function witnessStrands(cex: Counterexample | null, place: Place<unknown>): boolean {
  if (cex === null) return false;
  const rest = witnessRestRoles(cex);
  return cex.stuckMarking.some((p) => p.place === place.name && isStranded(rest, p));
}

/** The graph first (NU-053); the whole-net `deadlockFree` query only where it truncated. */
export async function decideStranding(ctx: Context, place: Place<unknown>): Promise<Decision> {
  const fromGraph = graphStranding(ctx, place);
  if (fromGraph !== null) return fromGraph;
  const fallback = await smtFallbackCompletion(ctx);
  if (fallback.verdict === 'proven') return fallback;
  // A `violated` that reached here is a stranding the solver found and the pause filter did
  // *not* excuse (`smtFallbackCompletion` downgrades a witness excused end to end). It is
  // about the whole net, so it becomes this row's finding only when its own witness marking
  // strands this place — marked *and* unexcused, the same widening the whole-net verdict was
  // judged with. Otherwise the whole-net row carries it and this row stays undecided, with a
  // reason that says so rather than claiming the fallback decided nothing.
  if (fallback.verdict === 'violated') {
    if (witnessStrands(fallback.counterexample, place)) return fallback;
    return {
      ...fallback,
      verdict: 'unknown',
      reason: undecidedReason(ctx, 'the whole-net deadlockFree fallback found a stranding elsewhere in ' +
        'this net (see the whole-net row), which decides nothing about this place'),
    };
  }
  return boundedOrUnknown(ctx, {
    ...fallback,
    verdict: 'unknown',
    reason: completionUnknownReason(ctx, fallback),
    counterexample: fallback.counterexample,
  }, smtFallbackNote(fallback));
}

/**
 * The whole-net `deadlockFree` fallback with the rest set as sinks and the pause / halt
 * widenings as conditional sinks (VER-002, VER-014), a designed-terminal witness downgraded
 * to `unknown` (`reasons.ts` `TERMINAL_WITNESS_REASON`). Asked at most once per report
 * ({@link Context.completionFallback}).
 *
 * It is asked wherever the graph did not close: with the widenings declared (VER-014) the
 * question is the graph's own, so a reachable designed terminal no longer makes it false,
 * and the gate that skipped it on that ground is gone with the reason it gave.
 */
export function smtFallbackCompletion(ctx: Context): Promise<Decision> {
  ctx.completionFallback ??= (async (): Promise<Decision> => {
    const decision = await smtDecision(ctx, deadlockFree(), ctx.completion.sinks, ctx.completion.conditional);
    if (decision.verdict === 'violated' && witnessIsExcusedTerminal(decision.counterexample)) {
      return { ...decision, verdict: 'unknown', reason: TERMINAL_WITNESS_REASON };
    }
    return decision;
  })();
  return ctx.completionFallback;
}
