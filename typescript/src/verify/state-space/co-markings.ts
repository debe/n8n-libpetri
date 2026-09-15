/**
 * Which pairs of places some explored class marks **together**, gathered in one pass over
 * the classes so `'all-pairs'` mutual exclusion costs the same as a single pair.
 */
import type { Place } from 'libpetri';
import type { StateClass } from 'libpetri/verification';
import type { Witness } from '../types.js';

/**
 * Which of a set of places some class marks **together**, with the class that does it.
 * Produced by {@link StateSpace.coMarkings} in one pass, so `'all-pairs'` mutual exclusion
 * costs the same as a single pair.
 */
export class CoMarkings {
  private readonly pairs: ReadonlyMap<string, StateClass>;
  private readonly decode: (sc: StateClass) => Witness;

  /** @internal Built by {@link StateSpace.coMarkings}. */
  constructor(pairs: ReadonlyMap<string, StateClass>, decode: (sc: StateClass) => Witness) {
    this.pairs = pairs;
    this.decode = decode;
  }

  /**
   * A class marking `a` and `b` together, decoded; `null` when none does. The pair is stored
   * once, in the order the pass met the two places, so both orders are probed here.
   */
  witness(a: Place<unknown>, b: Place<unknown>): Witness | null {
    const sc = this.pairs.get(`${a.name} ${b.name}`) ?? this.pairs.get(`${b.name} ${a.name}`);
    return sc === undefined ? null : this.decode(sc);
  }
}

/** The first class marking each pair of `places`, keyed by the two names in the order met. */
export function coMarkedPairs(
  classes: readonly StateClass[], places: readonly Place<unknown>[],
): Map<string, StateClass> {
  const wanted = new Set(places.map((p) => p.name));
  const pairs = new Map<string, StateClass>();
  for (const sc of classes) {
    const marked = sc.marking.placesWithTokens().map((p) => p.name).filter((n) => wanted.has(n));
    addPairs(pairs, marked, sc);
  }
  return pairs;
}

/** One key per unordered pair: {@link CoMarkings.witness} probes both orders. */
function addPairs(pairs: Map<string, StateClass>, marked: readonly string[], sc: StateClass): void {
  for (let i = 0; i < marked.length; i++) {
    for (let j = i + 1; j < marked.length; j++) {
      const key = `${marked[i]} ${marked[j]}`;
      if (!pairs.has(key)) pairs.set(key, sc);
    }
  }
}
