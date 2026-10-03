/**
 * Plugging the net-backed policy into a running engine (`tasks/v2-seam-plan.md` decision 5): the
 * host passes the `@n8n/engine` module its runtime is built from, and the policy is set on that
 * module's registry (patch 0004), which `createEngineRuntime` reads when its options name no
 * policy. A runtime built before the call keeps the policy it was built with.
 *
 * Three modes, for the live testbed's `--settlement=primary|shadow` (steps 11–12):
 * - `primary`: the net-backed policy answers.
 * - `shadow`: n8n's `defaultSettlementPolicy` answers; the net-backed policy runs beside it and
 *   every call is reported (`shadow.ts`).
 * - `primary-shadowed`: the net-backed policy answers; n8n's runs beside it and is reported. The
 *   other direction of the same comparison.
 *
 * The call checks that the registry hands back what was set, and emits `settlement policy
 * registered` only then. A host that registered on one copy of the engine while the runtime is
 * built from another (`src` against `dist`, F5) sees `registered` without ever seeing `entered`.
 */
import type { V2SettlementPolicy, V2SettlementRegistry } from '../n8n/v2-host.js';
import { createSettlementPolicy } from './policy.js';
import type { SettlementPolicyOptions } from './policy.js';
import { createShadowPolicy } from './shadow.js';
import type { ShadowReport } from './shadow.js';

export type SettlementMode = 'primary' | 'shadow' | 'primary-shadowed';

export const SETTLEMENT_MODES: readonly SettlementMode[] = ['primary', 'shadow', 'primary-shadowed'];

export interface RegisterOptions extends SettlementPolicyOptions {
  /** Default `primary`. */
  readonly mode?: SettlementMode;
  /** Every shadowed call, in the two shadow modes. Required there. */
  readonly onShadowReport?: (report: ShadowReport) => void;
}

/** Sets the policy `options.mode` names on `engine`'s registry and returns it (see the module doc). */
export function registerSettlementPolicy(engine: V2SettlementRegistry, options: RegisterOptions = {}): V2SettlementPolicy {
  const mode = options.mode ?? 'primary';
  if (!SETTLEMENT_MODES.includes(mode)) throw new RangeError(`registerSettlementPolicy: mode '${String(mode)}' is not one of ${SETTLEMENT_MODES.join(', ')}`);
  const ours = createSettlementPolicy(options);
  let policy: V2SettlementPolicy = ours;
  if (mode !== 'primary') {
    const onReport = options.onShadowReport;
    if (onReport === undefined) throw new TypeError(`registerSettlementPolicy: mode '${mode}' reports every call, and no onShadowReport was given`);
    const theirs = engine.defaultSettlementPolicy;
    policy = mode === 'shadow'
      ? createShadowPolicy({ primary: theirs, candidate: ours, onReport })
      : createShadowPolicy({ primary: ours, candidate: theirs, onReport });
  }
  engine.setSettlementPolicy(policy);
  if (engine.getSettlementPolicy() !== policy) {
    throw new Error('registerSettlementPolicy: the engine\'s registry does not return the policy just set; it is not the registry createEngineRuntime reads');
  }
  try {
    options.onDiagnostic?.({ kind: 'registered', message: 'settlement policy registered', mode });
  } catch {
    // Diagnostics never change an outcome.
  }
  return policy;
}
