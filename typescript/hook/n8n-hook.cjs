'use strict';
/**
 * n8n-libpetri's `EXTERNAL_HOOK_FILES` entry (`tasks/inject-plan.md` decision 7): the check that
 * the scheduler is registered, not the registration.
 *
 * `hook/n8n-preload.mjs` registers the scheduler from `NODE_OPTIONS`, before n8n runs anything.
 * n8n `require()`s every hook file in `ExternalHooks.init()`, in each command that runs
 * executions (`start`, `worker`, `webhook`, `execute`, `execute-batch`), and a file that throws
 * stops that command. In `start` that is after the `WaitTracker` may have resumed an overdue
 * wait (divergence row 40), so registering here would be too late. This file registers no hooks
 * (it exports `{}`); requiring it calls `confirmBooted` (`dist/n8n/boot.js`), which throws when
 * the engine is requested and the preload did not register, so a missing preload stops n8n
 * instead of running n8n's own loop under `N8N_EXECUTION_ENGINE=libpetri`.
 *
 * With `N8N_EXECUTION_ENGINE` unset or empty the dist is not even loaded. Any refusal is
 * written to stderr before it is rethrown, because n8n reports a failing hook file as
 * "Problem loading external hook file" and keeps the reason in the error's `extra`.
 *
 * `require()` of the ESM dist needs Node's synchronous `require(esm)` (Node >= 22.12, which n8n's
 * own `engines` floor of 24 covers) and a dist without top-level `await`.
 */
const value = process.env.N8N_EXECUTION_ENGINE;
if (value !== undefined && value !== '') {
  try {
    const { confirmBooted } = require('../dist/n8n/boot.js');
    confirmBooted();
  } catch (error) {
    process.stderr.write(`[n8n-libpetri] refusing to start n8n: ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}

module.exports = {};
