/**
 * Counterexample decoding: a libpetri `SmtVerificationResult` back into workflow terms.
 *
 * The SMT route reports a violation as a list of **flat** transition names and a list of
 * `MarkingState`s. Flat names are the net's own transition names, with a `_b<k>` suffix on
 * every XOR branch the flattener expanded (IO-016). Stripping that suffix lands on a
 * transition `NetMap` knows, which carries the owning node, the role and the port — so a
 * counterexample prints as a path through the user's nodes rather than through
 * `id:<uuid>/route_2`.
 *
 * Order is only meaningful when libpetri's abstract replay confirmed a firing sequence
 * (`counterexampleConfirmed === true`). Otherwise the decoded states are an order-free set
 * walked in derivation-tree traversal order, and {@link Counterexample.ordered} says so.
 */
import type { NetMapView, PlaceRole } from '../compiler/index.js';
import type { MarkingState, SmtVerificationResult } from 'libpetri/verification';
import type { Counterexample, CounterexampleStep, MarkedPlace } from './types.js';

/** `name_b3` → `name`. The flattener appends `_b<index>` only when a transition has >1 branch. */
export function stripBranch(flatName: string): string {
  const m = /^(.*)_b\d+$/.exec(flatName);
  return m === null ? flatName : m[1]!;
}

/** One flat transition name put back in workflow terms. */
export function decodeStep(flatName: string, map: NetMapView): CounterexampleStep {
  const source = stripBranch(flatName);
  const info = map.transition(source);
  return {
    transition: flatName,
    source,
    node: info?.node ?? null,
    role: info?.role ?? null,
    ...(info !== undefined && 'port' in info ? { port: info.port } : {}),
    ...(info?.role === 'arm' ? { variant: info.variant } : {}),
  };
}

/** Every place holding a token in `state`, in workflow terms, sorted by place name. */
export function decodeMarking(state: MarkingState | undefined, map: NetMapView): MarkedPlace[] {
  if (state === undefined) return [];
  const out: MarkedPlace[] = [];
  for (const place of state.placesWithTokens()) {
    const tokens = state.tokens(place);
    if (tokens <= 0) continue;
    const info = map.place(place.name);
    out.push({
      place: place.name,
      tokens,
      node: info?.node ?? null,
      role: info?.role ?? null,
      port: info?.port ?? null,
    });
  }
  return out.sort((a, b) => a.place.localeCompare(b.place));
}

/**
 * The violating marking of a trace. Confirmed traces are in firing order, so the violating
 * state is the last one; an unconfirmed decode is an order-free set, and the state that
 * satisfies the property's error condition is not identifiable from outside libpetri — the
 * last decoded state is reported either way, and `ordered` warns which case this is.
 */
function violatingState(result: SmtVerificationResult): MarkingState | undefined {
  return result.counterexampleTrace[result.counterexampleTrace.length - 1];
}

/**
 * `null` when the result carries no witness at all (a `proven` or `unknown` verdict, or a
 * violation Spacer reported without a derivation the decoder could read).
 */
export function decodeCounterexample(result: SmtVerificationResult, map: NetMapView): Counterexample | null {
  const steps = result.counterexampleTransitions.map((name) => decodeStep(name, map));
  const stuckMarking = decodeMarking(violatingState(result), map);
  if (steps.length === 0 && stuckMarking.length === 0) return null;
  const nodePath: string[] = [];
  for (const s of steps) {
    if (s.node !== null && !nodePath.includes(s.node)) nodePath.push(s.node);
  }
  return {
    nodePath,
    steps,
    stuckMarking,
    confirmed: result.counterexampleConfirmed,
    ordered: result.counterexampleConfirmed === true,
  };
}

/** `Trigger → IF → A → Merge`, or `(no node transitions in the witness)`. */
export function renderNodePath(cex: Counterexample): string {
  if (cex.nodePath.length === 0) return '(no node transitions in the witness)';
  return cex.nodePath.join(cex.ordered ? ' -> ' : ', ');
}

/**
 * Roles whose `PlaceInfo.port` is an **input** index; every other ported role (`ok`,
 * `routed`, `nil`) carries an output index (`compiler/types.ts`). Getting this wrong would
 * print "Switch input 3" for a token on the fourth *output*, which is the kind of wrong that
 * sends a reader to the wrong end of the node. An `engineV2` edge's `arrived` place belongs to
 * the edge's consumer and carries its input slot.
 */
const INPUT_SIDE_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  'in-data', 'in-empty', 'edge-data', 'edge-empty', 'ready', 'hasdata', 'ran', 'free', 'arrived',
]);

/**
 * One marked place in workflow terms — `Merge input 0 ready (id:Merge/ready_0)`,
 * `Switch output 3 ok (id:Switch/ok_3)`, `_budget x2` — and the only renderer a report uses
 * for one: the stuck marking of a finding and the stranded places of the whole-net row's
 * explanation both go through here. The port is named by the side of the node it is on, so a
 * join input reads the same wherever the page mentions it.
 */
export function renderMarkedPlace(p: MarkedPlace): string {
  const count = p.tokens === 1 ? '' : ` x${p.tokens}`;
  if (p.node === null) return `${p.place}${count}`;
  const port = p.port === null
    ? ''
    : p.role !== null && INPUT_SIDE_ROLES.has(p.role) ? ` input ${p.port}` : ` output ${p.port}`;
  return `${p.node}${port} ${p.role ?? 'place'} (${p.place})${count}`;
}
