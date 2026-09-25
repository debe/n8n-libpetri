/**
 * A family asked of a net of the other profile (`tasks/v2-profile-plan.md` decision 18): one
 * `unknown` check whose reason says the family is not applicable under that profile and why.
 * Never a silent pass, and never dropped: a caller who asked for `budget` on an `engineV2` net
 * sees in the table, the JSON and the unproven list that nothing was proven about it. `--strict`
 * fails on it, as it does on any check that is not a proof.
 */
import { InternalCompilerError, type CompileProfile } from '../../compiler/index.js';
import type { PropertyCheck, PropertyName } from '../types.js';

/** Why each v1 family says nothing about an `engineV2` net. */
const NOT_UNDER_ENGINE_V2: Readonly<Record<Exclude<PropertyName, 'settlement'>, string>> = {
  budget:
    'engine v2 has no concurrency budget: every queued step may run, and an engineV2 net has no _budget ' +
    'place (tasks/v2-profile-plan.md decision 3)',
  'retry-bound':
    'engine v2 has no retry model at the pin: retryOnFail is ignored under the profile with a compiler ' +
    'diagnostic, and an engineV2 net has no X/tries place (decision 11)',
  'no-double-activation':
    'the v1 family reads the X/idle mutex, which an engineV2 net does not have; the settlement family\'s ' +
    '"runs at most once at a time" checks ask the same question of X/running',
  'proper-completion':
    'the v1 family classifies quiescent markings by v1\'s rest roles; the settlement family\'s "every ' +
    'halt-free run ends with nothing pending" check asks the same question in the settlement gadget\'s roles',
  'dead-nodes':
    'not ported to engineV2: the compiled node set is the trigger and its descendants by construction ' +
    '(decision 9), and whether each X_start is reachable is not asked yet',
  'mutual-exclusion': 'not ported to engineV2: no settlement check asks whether two nodes run at once',
};

/** Why the `settlement` family says nothing about a v1 net. */
const NOT_UNDER_V1 =
  'the settlement family reads the settlement gadgets of an engineV2 net, and a v1 net has none; compile ' +
  'with profile engineV2 (CLI --profile engineV2) to ask it';

/** The reason `property` does not apply to a net compiled for `profile`. */
export function notApplicableReason(property: PropertyName, profile: CompileProfile): string {
  if (profile === 'v1') return NOT_UNDER_V1;
  // A caller bug, not an input: `verifySettlement` runs the family itself.
  if (property === 'settlement') throw new InternalCompilerError('the settlement family applies under engineV2');
  return NOT_UNDER_ENGINE_V2[property];
}

/** Records `property` as not applicable under `profile`: one `unknown` check about the whole net. */
export function recordNotApplicable(
  ctx: { readonly checks: PropertyCheck[]; readonly onCheck: ((check: PropertyCheck) => void) | undefined },
  property: PropertyName,
  profile: CompileProfile,
): void {
  const reason = `not applicable under ${profile}: ${notApplicableReason(property, profile)}`;
  const check: PropertyCheck = {
    property,
    name: `${property} is not applicable under ${profile}`,
    subject: { kind: 'net' },
    verdict: 'unknown',
    explanation: `Nothing was proven about ${property}: the family does not apply to a net compiled for ${profile}.`,
    reason,
    counterexample: null,
    elapsedMs: 0,
    query: {
      property: 'none', place: null, verdict: 'unknown', sinks: [], conditionalSinks: [], method: null, route: 'none',
    },
  };
  ctx.checks.push(check);
  ctx.onCheck?.(check);
}
