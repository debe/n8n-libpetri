/**
 * n8n-libpetri's `--import` preload, the entry that registers the scheduler (divergence row 40).
 *
 *   export N8N_EXECUTION_ENGINE=libpetri
 *   export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=/path/to/n8n-libpetri/hook/n8n-preload.mjs"
 *   export EXTERNAL_HOOK_FILES=/path/to/n8n-libpetri/hook/n8n-hook.cjs   # `n8n-libpetri env` prints all three
 *
 * Node runs it before n8n's entry module, so the scheduler is registered before n8n can start
 * any execution, an overdue wait resumed at boot included. `n8n-hook.cjs` then confirms the
 * registration and refuses to start n8n without it.
 *
 * With `N8N_EXECUTION_ENGINE` unset or empty the dist is not loaded. In any process that is not
 * n8n's own command on its main thread (a script an Execute Command node runs, a worker thread)
 * it does nothing (`preloadFromEnv`). A refusal is written to stderr and rethrown, and Node then
 * exits before n8n starts.
 */
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const value = process.env.N8N_EXECUTION_ENGINE;
if (value !== undefined && value !== '') {
  try {
    const { preloadFromEnv } = await import('../dist/n8n/boot.js');
    preloadFromEnv({ isMainThread, loader: fileURLToPath(import.meta.url) });
  } catch (error) {
    process.stderr.write(`[n8n-libpetri] refusing to start n8n: ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}
