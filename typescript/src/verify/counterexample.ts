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
import type { NetMapView } from '../compiler/index.js';
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
    ...(info?.port === undefined ? {} : { port: info.port }),
    ...(info?.variant === undefined ? {} : { variant: info.variant }),
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

/** `Merge input 0 (id:Merge/ready_0) x1` per marked place, for the report's stuck-marking list. */
export function renderMarkedPlace(p: MarkedPlace): string {
  const where = p.node === null
    ? p.place
    : `${p.node}${p.port === null ? '' : ` port ${p.port}`} ${p.role ?? 'place'} (${p.place})`;
  return p.tokens === 1 ? where : `${where} x${p.tokens}`;
}
