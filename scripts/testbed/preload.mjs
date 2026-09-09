/**
 * The `--import` preload that registers `PetriScheduler` with a **running** n8n process.
 *
 * `scripts/run-conformance.sh` wires the engine in through a vitest `setupFiles` shim; a server
 * has no such seam, so this is its equivalent. It is the server-side counterpart of
 * `typescript/src/n8n-vitest-setup.ts` and gates on the same variable, `N8N_EXECUTION_ENGINE`,
 * so the same launcher runs the legacy engine with this file inert.
 *
 * Three things make it work, and each is deliberate:
 *
 * 1. **`createRequire`, not `import`.** n8n-core builds to CommonJS (`"main": "dist/index"`) and
 *    n8n-libpetri is ESM-only. The registry has to be the *same module instance* the CLI loads,
 *    so we resolve `n8n-core` from `packages/cli`'s own resolution root. Node resolves pnpm's
 *    symlinks to their realpath (`--preserve-symlinks` is off by default), so that instance and
 *    the CLI's `require('n8n-core')` are one and the same CJS module.
 * 2. **`--import`, not `NODE_OPTIONS`.** `packages/cli/bin/n8n` never re-execs, so a preload on
 *    the command line covers the whole process. `NODE_OPTIONS` would additionally leak this file
 *    into the internal task-runner child, which never constructs a `WorkflowExecute`.
 * 3. **No fallback.** If anything here fails the preload throws and n8n does not start. A testbed
 *    that quietly falls back to n8n's stack loop while claiming to run the net is worse than one
 *    that refuses to boot.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ENGINE_ENV = 'N8N_EXECUTION_ENGINE';

if (process.env[ENGINE_ENV] === 'libpetri') {
  const resolveFrom = process.env.N8N_LIBPETRI_RESOLVE_FROM;
  const hook = process.env.N8N_LIBPETRI_HOOK;
  if (!resolveFrom) throw new Error('N8N_LIBPETRI_RESOLVE_FROM is not set (expected .n8n/packages/cli/package.json)');
  if (!hook) throw new Error('N8N_LIBPETRI_HOOK is not set (expected typescript/dist/index.js)');

  const req = createRequire(resolveFrom);
  const core = req('n8n-core');
  const { NodeHelpers } = req('n8n-workflow');

  // Patch 0002's seam. Its absence means `.n8n/packages/core/dist` was built from an unpatched
  // tree — the one failure mode that would otherwise look like a working legacy run.
  if (typeof core.setWorkflowSchedulerFactory !== 'function') {
    throw new Error(
      'n8n-core exports no setWorkflowSchedulerFactory: packages/core/dist predates patch 0002. ' +
        'Run scripts/verify-patch.sh, then rebuild packages/core.',
    );
  }

  const { registerPetriScheduler } = await import(pathToFileURL(hook).href);

  const integer = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got '${raw}'`);
    return value;
  };

  registerPetriScheduler({
    setWorkflowSchedulerFactory: core.setWorkflowSchedulerFactory,
    StackScheduler: core.StackScheduler,
    nodeHelpers: NodeHelpers,
    budget: integer('N8N_LIBPETRI_BUDGET', 1),
    maxAgentRounds: integer('N8N_LIBPETRI_MAX_AGENT_ROUNDS', undefined),
    maxAgentToolCalls: integer('N8N_LIBPETRI_MAX_AGENT_TOOL_CALLS', undefined),
    // stderr, not console: n8n installs its own logger over the console early in boot, and the
    // launcher greps this prefix out of .testbed/n8n.log to prove the engine was entered.
    onDiagnostic: (message) => process.stderr.write(`[n8n-libpetri] ${message}\n`),
  });

  // Two distinct claims, deliberately two lines. This one says the factory was *installed*,
  // which is true at boot. `ENGINE_ENTERED_DIAGNOSTIC` — emitted by the factory itself the
  // first time n8n constructs a scheduler through it — says the engine was *entered*, which
  // only an execution can establish. `docs/conformance-final.md` keeps the same distinction
  // for the same reason: a registered engine is not a run engine.
  process.stderr.write(
    `[n8n-libpetri] scheduler registered: budget=${integer('N8N_LIBPETRI_BUDGET', 1)}, hook=${hook}\n`,
  );
}
