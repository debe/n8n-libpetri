/**
 * Runs one seeded workflow through the **manual execution** path — `POST /rest/workflows/:id/run`
 * with a `triggerToStartFrom`, which is exactly what the editor's "Execute workflow" button
 * sends — then polls the execution until it finishes and writes it to a file.
 *
 * REST rather than `n8n execute --id`, for two reasons. The CLI prints its `--rawOutput` JSON
 * through n8n's logger, so it disappears under any log level that silences the noise the task
 * runner writes to the same stream; and it needs the sqlite database to itself, which means
 * stopping and restarting the server between legs. This drives the running server the browser
 * drives, once per engine.
 *
 *   node run.mjs <workflow-name-or-id> <output.json>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// n8n stores `execution.data` in `flatted`'s deduplicated form, not as plain JSON — `JSON.parse`
// on it yields the raw string table, not the run data. Its own frontend unflattens the same way.
const { parse: unflatten } = createRequire(resolve(here, '../../.n8n/packages/cli/package.json'))('flatted');
const testbed = resolve(process.env.TESTBED_DIR ?? resolve(here, '../../.testbed'));
const ids = JSON.parse(await readFile(resolve(testbed, 'ids.json'), 'utf8'));
const base = process.env.TESTBED_BASE_URL ?? ids.base;
const timeoutMs = Number.parseInt(process.env.TESTBED_RUN_TIMEOUT_MS ?? '120000', 10);

const [target, outPath] = process.argv.slice(2);
if (!target || !outPath) {
  console.error('usage: node run.mjs <workflow-name-or-id> <output.json>');
  process.exit(2);
}

let cookie = '';
async function call(method, path, body) {
  const response = await fetch(`${base}/rest${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'browser-id': 'n8n-libpetri-testbed', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    if (value.startsWith('n8n-auth=')) cookie = value.split(';')[0];
  }
  const text = await response.text();
  const json = (response.headers.get('content-type') ?? '').includes('application/json');
  let payload;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    payload = text;
  }
  if (!response.ok || (text !== '' && !json)) {
    throw new Error(`${method} ${path} failed (${response.status}): ${String(text).slice(0, 300)}`);
  }
  return payload?.data ?? payload;
}

const entry = ids.workflows.find((w) => w.id === target || w.name === target);
if (!entry) throw new Error(`no seeded workflow called '${target}'; have: ${ids.workflows.map((w) => w.name).join(', ')}`);

await call('POST', '/login', { emailOrLdapLoginId: ids.email, password: ids.password });

const workflow = await call('GET', `/workflows/${entry.id}`);
const trigger = workflow.nodes.find((n) => /trigger$/i.test(n.type));
if (!trigger) throw new Error(`workflow '${entry.name}' has no trigger node`);

const started = Date.now();
const { executionId } = await call('POST', `/workflows/${entry.id}/run`, { triggerToStartFrom: { name: trigger.name } });
if (!executionId) throw new Error('the manual run returned no executionId');

let execution;
for (;;) {
  execution = await call('GET', `/executions/${executionId}?includeData=true`);
  if (execution?.finished === true || (execution?.status && !['running', 'new', 'waiting'].includes(execution.status))) break;
  if (Date.now() - started > timeoutMs) throw new Error(`execution ${executionId} did not finish within ${timeoutMs} ms`);
  await new Promise((r) => setTimeout(r, 100));
}
const elapsedMs = Date.now() - started;

if (typeof execution.data === 'string') execution.data = unflatten(execution.data);

await mkdir(dirname(resolve(outPath)), { recursive: true });
await writeFile(resolve(outPath), JSON.stringify({ workflow: entry.name, executionId, elapsedMs, execution }, null, 2) + '\n');
console.log(`[run] ${entry.name}: execution ${executionId} ${execution.status} in ${elapsedMs} ms -> ${outPath}`);
if (execution.status !== 'success') process.exitCode = 1;
