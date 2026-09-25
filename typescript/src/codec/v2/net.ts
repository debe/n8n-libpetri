/**
 * Unit-token markings of an `engineV2` net, and the two things the stateless planner does with
 * them: judge a transition enabled, and fire it along a branch the caller names. Every place of an
 * `engineV2` net holds unit tokens (`tasks/v2-profile-plan.md` decision 3), so a marking is a count
 * per place, and places are keyed by name (CORE-002: a place's identity is its name).
 *
 * Enabledness is written out by hand from the arcs, the rule libpetri's executors and its
 * state-class graph apply to an untimed, all-immediate net: every input arc has at least
 * `requiredCount` tokens (`all()` needs one), every read arc one, every inhibitor arc none. Reset
 * arcs do not enable or disable. `tests/codec/v2-step-rows.test.ts` checks the result against
 * `StateClassGraph`'s own initial class on every marking it decodes.
 */
import { consumptionCount, enumerateBranches, requiredCount } from 'libpetri';
import type { Place, Token, Transition } from 'libpetri';
import { InternalCompilerError } from '../../compiler/index.js';
import type { CompiledWorkflow } from '../../compiler/index.js';
import { units } from '../../internal/tokens.js';

/** Tokens per place name; a place absent from the map holds none. */
export class TokenCounts {
  private readonly counts = new Map<string, number>();

  /** The counts of a marking as the executors take and return it. */
  static of(marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): TokenCounts {
    const c = new TokenCounts();
    for (const [p, tokens] of marking) c.add(p, tokens.length);
    return c;
  }

  get(p: Place<unknown>): number {
    return this.counts.get(p.name) ?? 0;
  }

  add(p: Place<unknown>, n: number): void {
    const next = this.get(p) + n;
    if (next < 0) throw new InternalCompilerError(`internal: place '${p.name}' would hold ${next} tokens`);
    if (next === 0) this.counts.delete(p.name);
    else this.counts.set(p.name, next);
  }

  /** `(place name, count)` for every marked place, by name. */
  entries(): [string, number][] {
    return [...this.counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The marking as the executors take it: `n` unit tokens on each marked place of `compiled.net`. */
  toMarking(compiled: CompiledWorkflow): Map<Place<unknown>, Token<unknown>[]> {
    const byName = new Map([...compiled.net.places].map((p) => [p.name, p as Place<unknown>]));
    const marking = new Map<Place<unknown>, Token<unknown>[]>();
    for (const [name, n] of this.entries()) {
      const p = byName.get(name);
      if (p === undefined) throw new InternalCompilerError(`internal: the net has no place '${name}'`);
      marking.set(p, units(n));
    }
    return marking;
  }
}

/** Whether `t` is enabled at `counts`: its input, read and inhibitor arcs (see the module doc). */
export function isEnabled(t: Transition, counts: TokenCounts): boolean {
  for (const spec of t.inputSpecs) if (counts.get(spec.place) < requiredCount(spec)) return false;
  for (const arc of t.reads) if (counts.get(arc.place) < 1) return false;
  for (const arc of t.inhibitors) if (counts.get(arc.place) > 0) return false;
  return true;
}

/**
 * The branch of `t`'s `Out` spec (IO-016) whose places are exactly `places`. Throws
 * `InternalCompilerError` when there is none: the caller derived the branch from the gadget, so a
 * miss means the caller and the compiler disagree about the net.
 */
export function branchOf(t: Transition, places: ReadonlySet<string>): ReadonlySet<Place<unknown>> {
  if (t.outputSpec === null) throw new InternalCompilerError(`internal: transition '${t.name}' has no Out spec`);
  const want = [...places].sort().join('\0');
  for (const branch of enumerateBranches(t.outputSpec)) {
    if ([...branch].map((p) => p.name).sort().join('\0') === want) return branch as ReadonlySet<Place<unknown>>;
  }
  throw new InternalCompilerError(`internal: transition '${t.name}' has no branch writing exactly {${[...places].sort().join(', ')}}`);
}

/**
 * Fires enabled transition `t` at `counts`: consumes what its input arcs take (`all()` takes every
 * token present), clears its reset places and writes one unit on each place of `branch` except
 * those in `withhold`, which the caller deposits later itself.
 */
export function fire(
  t: Transition,
  counts: TokenCounts,
  branch: ReadonlySet<Place<unknown>>,
  withhold: ReadonlySet<string> = new Set(),
): void {
  if (!isEnabled(t, counts)) throw new InternalCompilerError(`internal: transition '${t.name}' fired while not enabled`);
  for (const spec of t.inputSpecs) counts.add(spec.place, -consumptionCount(spec, counts.get(spec.place)));
  for (const arc of t.resets) counts.add(arc.place, -counts.get(arc.place));
  for (const p of branch) if (!withhold.has(p.name)) counts.add(p, 1);
}
