'use strict';
/**
 * n8n-libpetri's `EXTERNAL_HOOK_FILES` entry (`tasks/inject-plan.md` decision 7).
 *
 *   export N8N_EXECUTION_ENGINE=libpetri
 *   export EXTERNAL_HOOK_FILES=/path/to/n8n-libpetri/hook/n8n-hook.cjs   # `n8n-libpetri env` prints both
 *
 * n8n `require()`s every hook file in `ExternalHooks.init()`, in each command that runs
 * executions (`start`, `worker`, `webhook`, `execute`, `execute-batch`), and a file that throws
 * stops that command. This one registers no hooks (it exports `{}`); requiring it is what
 * registers the scheduler, through `bootFromEnv` (`dist/n8n/boot.js`), the same boot path the
 * testbed's preload calls.
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
    const { bootFromEnv } = require('../dist/n8n/boot.js');
    bootFromEnv({ mainFilename: require.main ? require.main.filename : undefined, loader: __filename });
  } catch (error) {
    process.stderr.write(`[n8n-libpetri] refusing to start n8n: ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}

module.exports = {};
