/**
 * Reading the P-invariants libpetri handed the encoder (VER-007): the canonical count lines of
 * its report, a law as place-weight terms, and the two-phase budget semiflow.
 *
 * A leaf, deliberately. The SMT query runner (`route.ts`) needs {@link unionedSemiflows} to
 * know whether a cached invariant list carries the semiflow union, the budget family needs
 * {@link budgetSemiflowOf} for its structural row, and the report assembly in `verify.ts`
 * needs both the counts and {@link renderInvariant}. Kept in `verify.ts` it would be imported
 * back by the modules `verify.ts` imports.
 */
import type { Place } from 'libpetri';
import type { FlatNet, PInvariant } from 'libpetri/verification';
import { assertProfile, type NetMapView, type NodeGadget } from '../compiler/index.js';

/**
 * libpetri's canonical report lines (VER-013 fixes them byte for byte across the four
 * implementations), which is the only public way to read the **post-validation** counts:
 * the exact BigInt re-check that drops a row runs inside `verify()` and its helper is not
 * package API. Re-deriving them here with `computePInvariants` would report rows libpetri
 * then discarded — an over-count, on exactly the reset-arc chains this net has.
 */
export const FOUND_LINE = /^ {2}Found: (\d+) P-invariant\(s\)$/m;
export const SEMIFLOW_LINE = /^ {2}Semiflows encoded as invariants: (\d+)$/m;

/** The count one of the canonical lines carries, `null` when the report has no such line. */
export function countFrom(report: string, pattern: RegExp): number | null {
  const m = pattern.exec(report);
  return m === null ? null : Number(m[1]);
}

/**
 * Whether `report` came from a run that actually unioned the semiflows into the invariants.
 *
 * **The presence of the line is the signal; its value is not.** libpetri pushes
 * `Semiflows encoded as invariants: N` only inside `if (unionWanted)`, and `N` is the count of
 * semiflows that were not already identical to a basis row. So `0` is the ordinary case "the
 * union ran and the basis already covered every law it found" — reading it as "no union" makes
 * `collectInvariants` (`route.ts`) decline its own cache and re-run the whole pipeline on every
 * net whose semiflows happen to be in the basis.
 *
 * `SEMIFLOW_LINE` carries `m` but not `g`, so `test` keeps no `lastIndex` between calls.
 */
export function unionedSemiflows(report: string): boolean {
  return SEMIFLOW_LINE.test(report);
}

/** Place name → weight for one invariant, over the flattened net's place order. */
export function invariantTerms(invariant: PInvariant, flat: FlatNet): Map<string, number> {
  const terms = new Map<string, number>();
  for (const index of invariant.support) {
    const place = flat.places[index];
    if (place === undefined) continue;
    terms.set(place.name, invariant.weights[index] ?? 0);
  }
  return terms;
}

/** `2*_budget + 2*A/running + A/ok_0 + … = 2` — the same shape libpetri prints. */
export function renderInvariant(invariant: PInvariant, flat: FlatNet): string {
  const parts: string[] = [];
  for (const [name, weight] of [...invariantTerms(invariant, flat)].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (weight === 0) continue;
    parts.push(weight === 1 ? name : `${weight}*${name}`);
  }
  return `${parts.join(' + ')} = ${invariant.constant}`;
}

/**
 * The two-phase budget semiflow, if the verifier kept it: a law giving `_budget` and every
 * `X/running` the same positive weight `w`, summing to `w·k`, and touching at least one
 * in-flight place of every node that has one (`X/routed`, the per-output-routing
 * `X/ok_o` / `X/routed_o`, or `X/retry`). A node holds its unit from `X_start` to
 * `X_done`, so those places are exactly where the unit sits while it is not in `_budget`
 * (ADR 0004).
 *
 * "At least one", not "all": a node with more than `SPLIT_ROUTING_ABOVE` connected outputs
 * routes per output, and the Farkas enumeration then returns **one law per output** —
 * `_budget + … + X/ok_o + X/routed_o + X/running + … = w·k` for each `o` — rather than one
 * law folding all `n` in at weight `w/n`. Every one of them is the conservation law; the
 * first is returned. A workflow with no such node yields the single folded law
 * `_budget + Σ_X(X/running + X/retry + X/routed) = k` — one term per node, since every node
 * has an `X/routed`.
 */
export function budgetSemiflowOf(
  invariants: readonly PInvariant[], flat: FlatNet, map: NetMapView, budget: number,
): PInvariant | null {
  // An `engineV2` net has no `_budget` (`tasks/v2-profile-plan.md` decisions 3 and 18): the
  // question is not "no law found", so it is refused rather than answered `null`.
  assertProfile('budgetSemiflowOf', 'v1', map.profile);
  for (const invariant of invariants) {
    const terms = invariantTerms(invariant, flat);
    const w = terms.get(map.shared.budget.name) ?? 0;
    if (w <= 0 || invariant.constant !== w * budget) continue;
    if (map.nodes.every((g) => nodeCarriesUnit(g, terms, w))) return invariant;
  }
  return null;
}

function nodeCarriesUnit(g: NodeGadget, terms: ReadonlyMap<string, number>, w: number): boolean {
  if ((terms.get(g.running.name) ?? 0) !== w) return false;
  const inFlight: Place<unknown>[] = [
    ...(g.routing.kind === 'collapsed' ? [g.routing.routed] : g.routing.outputs.flatMap((o) => [o.ok, o.routed])),
    ...(g.retry === null ? [] : [g.retry.retry]),
    // An agent holds its unit on `A/routed_req` between the request outcome and `A_done_req`,
    // exactly as any node holds it on `X/routed` between `X_run` and `X_done` (ADR 0004), and on
    // `A/running_failed` between `A_calls_out` and `A_run_failed`.
    ...(g.agent === null ? [] : [g.agent.routedRequest, g.agent.runningFailed]),
  ];
  return inFlight.length === 0 || inFlight.some((p) => (terms.get(p.name) ?? 0) > 0);
}
