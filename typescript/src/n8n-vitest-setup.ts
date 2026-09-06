/**
 * The vitest setup entry `scripts/run-conformance.sh` wires into n8n-core's suite. The
 * shim it generates inside the n8n tree (`packages/core/.n8n-libpetri-setup.mjs`, where
 * `n8n-workflow` and `@/execution-engine/*` resolve) imports n8n's `NodeHelpers`,
 * `setWorkflowSchedulerFactory` and `StackScheduler` and calls {@link setupN8nVitest} with
 * them; the PetriScheduler is registered only when `N8N_EXECUTION_ENGINE === 'libpetri'`,
 * so the same shim is inert under the legacy engine.
 */
import type { NodeHelpersLike, SetWorkflowSchedulerFactory, WorkflowScheduler } from './n8n/host.js';
import { registerPetriScheduler, type PetriSchedulerRegistration } from './scheduler/register.js';

export { registerPetriScheduler };

export interface N8nVitestSetupDeps {
  readonly setWorkflowSchedulerFactory: SetWorkflowSchedulerFactory;
  readonly NodeHelpers: NodeHelpersLike;
  readonly StackScheduler: new () => WorkflowScheduler;
}

export interface N8nVitestSetupResult {
  readonly engine: 'libpetri' | 'legacy';
  readonly registration: PetriSchedulerRegistration | null;
}

/** The environment variable the conformance script sets per engine leg. */
export const ENGINE_ENV = 'N8N_EXECUTION_ENGINE';

export function setupN8nVitest(
  deps: N8nVitestSetupDeps,
  env: Record<string, string | undefined> = process.env,
): N8nVitestSetupResult {
  if (env[ENGINE_ENV] !== 'libpetri') return { engine: 'legacy', registration: null };
  const budget = Number.parseInt(env.N8N_LIBPETRI_BUDGET ?? '1', 10);
  const registration = registerPetriScheduler({
    setWorkflowSchedulerFactory: deps.setWorkflowSchedulerFactory,
    nodeHelpers: deps.NodeHelpers,
    StackScheduler: deps.StackScheduler,
    budget: Number.isInteger(budget) && budget >= 1 ? budget : 1,
    // `process.stderr.write`, not `console.warn`: n8n-core's vitest config does not print
    // captured console output, so a diagnostic written through the console never reaches
    // `conformance-results/<label>.test.log` — which is where the budget leg reads the
    // per-workflow k-safety restrictions from (`scripts/run-conformance.sh`).
    ...(env.N8N_LIBPETRI_DIAGNOSTICS === '1'
      ? { onDiagnostic: (m: string) => process.stderr.write(`[n8n-libpetri] ${m}\n`) }
      : {}),
  });
  return { engine: 'libpetri', registration };
}
