/**
 * Which places a quiescent class may hold tokens on: the rest sets, one per kind of terminal,
 * and the rule that tells the kinds apart. `state-class.ts` ("What counts as a stranding",
 * "The pause filter") states why there are three sets rather than one.
 */
import type { PlaceRole } from '../../compiler/index.js';
import type { TerminalKind } from '../types.js';

/**
 * Places where a token at rest is legitimate residue of a finished run, never pending work.
 *
 * `idle` / `free` / `tries` / `budget` are the gadget's own resources handed back;
 * `done` / `skipped` / `ran` are markers nothing consumes; `nil` is drained by a genuine
 * sink (CORE-043 AC4); `halt` / `pause` / `waiting` / `stopped` are the designed terminals —
 * `_halt` is never consumed, it *is* the halted run's terminal marker (`compiler/compile.ts`).
 */
export const REST_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  'idle', 'done', 'skipped', 'free', 'tries', 'budget', 'halt', 'pause', 'waiting', 'stopped', 'ran', 'nil',
  // `rounds` and `calls` are budgets, the agent's `tries`: an execution that finishes without
  // spending every round or every tool call it was allowed leaves the rest there, and that is
  // a completed run, not a stranding. Every other agent-round place is pending work — a round
  // in flight — and widens only inside a designed terminal, where the codec writes it back.
  'rounds', 'calls',
]);

/** A marking holding one of these is a *designed* terminal: a paused or halted run. */
export const TERMINAL_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  'pause', 'halt', 'waiting', 'stopped',
]);

/**
 * The rest set inside a **paused** class (`_pause`, `X/waiting`, `X/stopped`): the pending
 * work `encodeMarking` in mode `pause` writes back into n8n's `nodeExecutionStack` and
 * `waitingExecution` (`codec.ts`; ADR 0005). `retry` is in it because `X_retry_wait`
 * inhibits on `_pause` (`gadget.ts`), so its unit rests there by design and the codec pushes
 * the entry back.
 *
 * `in-empty` and the `edge` roles are deliberately **absent**, and that is the half of this
 * set that had to be measured rather than assumed: `X_skip` and the `arm` transitions are
 * *not* pause-inhibited, so those places drain on their own under a pause and a token at
 * rest on one is real pending work — and `encodeMarking` in mode `pause` throws a
 * `CodecError` on `X/in_empty` and on an OR input's edge places rather than writing them
 * `halt` is absent too, and for a different reason: `_halt` at rest is the *halted*
 * terminal, so a marking holding it is classified against {@link HALT_REST_ROLES} instead.
 */
export const PAUSE_REST_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  // `failed` is `retry`'s analogue for an `onFailure` chain (ADR 0009): an attempt that failed
  // and whose step has not acted. Pending work, so it is *not* in `REST_ROLES` — a quiescent
  // marking holding one outside a designed terminal is a stranding and is reported as one —
  // but inside a pause or a halt the codec writes it back, exactly as it does `retry`.
  ...REST_ROLES, 'in-data', 'ready', 'hasdata', 'retry', 'failed',
  // An agent round the pause caught mid-flight: the tool calls not yet dispatched (`queue`) or
  // the mark that there are none (`drained`), the one dispatched but not yet started
  // (`in-tool`), the ones still out (`outstanding`) and the agent's own re-entry
  // (`dispatched`). `encodeMarking` writes every one of them back onto `nodeExecutionStack` in
  // n8n's own shape, so they rest by design — exactly the argument `retry` is in this set for.
  'in-tool', 'queue', 'drained', 'outstanding', 'dispatched',
]);

/**
 * The rest set inside a **halted** class (`_halt`): {@link PAUSE_REST_ROLES} plus the places
 * a halt stops draining and the codec handles in mode `cancelled` — the one mode that
 * legitimately sees an undrained marking (`codec.ts`; the scheduler encodes a halted run
 * with it, `petri-scheduler.ts`). `X_skip` and the arms inhibit on `_halt`, so `X/in_empty`
 * and the `edge` places come to rest; `cancelled` mode drops the empty with a diagnostic
 * ("n8n never enqueues an empty", which is right for a run that is over) and writes the edge
 * arrivals back through `joinQueue`. Every one of these is where a pending activation was
 * *delivered*: since there is no reap, that is exactly where the halted run leaves it.
 */
export const HALT_REST_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  ...PAUSE_REST_ROLES, 'in-empty', 'edge-data', 'edge-empty',
]);

/** The rest set a class of this kind is classified against. */
export function restRolesFor(kind: TerminalKind): ReadonlySet<PlaceRole> {
  switch (kind) {
    case 'halt': return HALT_REST_ROLES;
    case 'pause': return PAUSE_REST_ROLES;
    case 'none': return REST_ROLES;
  }
}

/**
 * Which terminal a marking is: `'halt'` wins over `'pause'`, because a marking holding both
 * is encoded on the halt path (`petri-scheduler.ts` checks `_halt` first).
 */
export function terminalKindOf(roles: Iterable<PlaceRole | null>): TerminalKind {
  let kind: TerminalKind = 'none';
  for (const role of roles) {
    if (role === null) continue;
    if (role === 'halt') return 'halt';
    if (TERMINAL_ROLES.has(role)) kind = 'pause';
  }
  return kind;
}
