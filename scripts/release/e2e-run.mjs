/**
 * e2e-run.mjs — one manual run of a fixed workflow over n8n's REST API, for `e2e-npm.sh`.
 * Sets up the instance owner on first use (`POST /rest/owner/setup`), signs in, creates the
 * workflow once (reused by name), runs it the way the editor's "Execute workflow" does
 * (`POST /rest/workflows/:id/run` with `triggerToStartFrom`), polls until it finishes and writes
 * the execution, its data unflattened, to <out.json>. Exits 1 unless the run succeeded.
 *
 *   E2E_BASE=http://127.0.0.1:5681 E2E_WORK=<dir> node e2e-run.mjs <out.json>
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const base = process.env.E2E_BASE;
const work = process.env.E2E_WORK;
const out = process.argv[2];
if (!base || !work || !out) {
  console.error('usage: E2E_BASE=<url> E2E_WORK=<dir> node e2e-run.mjs <out.json>');
  process.exit(2);
}
// n8n stores execution data in flatted's form; its own copy unflattens it.
const { parse: unflatten } = createRequire(join(work, 'prefix/lib/node_modules/n8n/package.json'))('flatted');
const email = 'e2e@n8n-libpetri.local';
const password = 'E2e-libpetri-1';

let cookie = '';
async function call(method, path, body, { allowFail = false } = {}) {
  const response = await fetch(`${base}/rest${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'browser-id': 'n8n-libpetri-e2e', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const value of response.headers.getSetCookie?.() ?? []) if (value.startsWith('n8n-auth=')) cookie = value.split(';')[0];
  const text = await response.text();
  if (!response.ok && !allowFail) throw new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  const payload = text === '' ? undefined : JSON.parse(text);
  return { ok: response.ok, data: payload?.data ?? payload };
}

const WORKFLOW = {
  name: 'n8n-libpetri e2e fan-out and join',
  nodes: [
    { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'a', name: 'Branch A', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, -100], parameters: { assignments: { assignments: [{ id: 'x1', name: 'branch', value: 'a', type: 'string' }] }, options: {} } },
    { id: 'b', name: 'Branch B', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 100], parameters: { assignments: { assignments: [{ id: 'x2', name: 'branch', value: 'b', type: 'string' }] }, options: {} } },
    { id: 'm', name: 'Join', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [440, 0], parameters: {} },
  ],
  connections: {
    Start: { main: [[{ node: 'Branch A', type: 'main', index: 0 }, { node: 'Branch B', type: 'main', index: 0 }]] },
    'Branch A': { main: [[{ node: 'Join', type: 'main', index: 0 }]] },
    'Branch B': { main: [[{ node: 'Join', type: 'main', index: 1 }]] },
  },
  settings: { executionOrder: 'v1' },
};

const setup = await call('POST', '/owner/setup', { email, firstName: 'E2e', lastName: 'Run', password }, { allowFail: true });
if (!setup.ok) await call('POST', '/login', { emailOrLdapLoginId: email, password });

const list = (await call('GET', '/workflows?includeScopes=false')).data;
const found = (list?.data ?? list ?? []).find((w) => w.name === WORKFLOW.name);
const id = found?.id ?? (await call('POST', '/workflows', WORKFLOW)).data.id;
if (typeof id !== 'string') throw new Error('no workflow id');

const started = Date.now();
const { executionId } = (await call('POST', `/workflows/${id}/run`, { triggerToStartFrom: { name: 'Start' } })).data;
if (!executionId) throw new Error('the run returned no executionId');
let execution;
for (;;) {
  execution = (await call('GET', `/executions/${executionId}?includeData=true`)).data;
  if (execution?.finished === true || (execution?.status && !['running', 'new', 'waiting'].includes(execution.status))) break;
  if (Date.now() - started > 60000) throw new Error(`execution ${executionId} did not finish in 60 s`);
  await new Promise((r) => setTimeout(r, 100));
}
if (typeof execution.data === 'string') execution.data = unflatten(execution.data);
writeFileSync(out, `${JSON.stringify({ workflowId: id, executionId, execution }, null, 2)}\n`);
const runData = execution.data?.resultData?.runData ?? {};
console.log(`  [run] execution ${executionId} ${execution.status}; nodes run: ${Object.keys(runData).join(', ')}; Join items: ${runData.Join?.[0]?.data?.main?.[0]?.length ?? 0}`);
if (execution.status !== 'success') process.exit(1);
