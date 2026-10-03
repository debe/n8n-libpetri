/**
 * Drives the engine v2 testbed through the three paths ADR 0014 "Open" left unexercised, for
 * `diff-engines-v2.sh`. Each subcommand writes one capture per run into `<out-dir>`, and every
 * capture carries a `key` that is the same in every leg, so the comparator
 * (`tests/testbed/compare-v2-live.ts`) pairs a run with the `off` leg's run of the same key.
 *
 *   node drive-v2.mjs webhook    <out-dir> [--repeat=N]
 *   node drive-v2.mjs concurrent <out-dir> [--rounds=N] [--batch=<name>*<count>,...]
 *   node drive-v2.mjs cancel     <out-dir> [--sweep=<name>@<from>:<to>:<step>,...]
 *
 * - **webhook**: calls every activated webhook workflow's production URL (`ids.json`, written by
 *   `seed.mjs`), one request at a time, each with a body `{ tag }`. The capture keeps the HTTP
 *   status, the headers and the body as received. The execution id is not in the response; the
 *   comparator finds it in the data plane by the tag in the Webhook node's output.
 * - **concurrent**: fires a batch of manual runs (`POST /rest/workflows/:id/run`, what the editor's
 *   button sends) and webhook requests all at once, then waits for every one to end. The engine runs
 *   in-process, so the executions' settlements interleave in one engine process. `--rounds`
 *   repeats the batch.
 * - **cancel**: starts a manual run, waits a delay, and sends `POST /rest/executions/:id/stop` (n8n's
 *   stop button: `ExecutionService.stop` → the data plane's cancel → `CancelExecutionService`). The
 *   delays sweep a range per workflow, so some cancels land while a settlement is in flight. The
 *   capture keeps the stop response and the execution's end as REST reports it.
 *
 * Environment: `TESTBED_DIR` (default `.testbed/v2`), `TESTBED_BASE_URL` (default `ids.base`),
 * `TESTBED_RUN_TIMEOUT_MS` (default 900000). A run that does not end within the timeout fails the
 * subcommand (exit 1); an execution that ends in `error` or `canceled` is an outcome, not a failure.
 *
 * Everything this produces is an integration result: not a conformance number, not a
 * policy-entering case count, not a neutrality leg, not settlement evidence.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testbed = resolve(process.env.TESTBED_DIR ?? resolve(here, '../../.testbed/v2'));
const ids = JSON.parse(await readFile(resolve(testbed, 'ids.json'), 'utf8'));
const base = process.env.TESTBED_BASE_URL ?? ids.base;
const timeoutMs = Number.parseInt(process.env.TESTBED_RUN_TIMEOUT_MS ?? '900000', 10);

const [command, outDir, ...flags] = process.argv.slice(2);
const flag = (name, fallback) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
if (!['webhook', 'concurrent', 'cancel'].includes(command) || !outDir) {
  console.error('usage: node drive-v2.mjs webhook|concurrent|cancel <out-dir> [flags]   (see the file header)');
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
  let payload;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    payload = text;
  }
  return { ok: response.ok, status: response.status, payload, data: payload?.data ?? payload };
}

async function login() {
  const r = await call('POST', '/login', { emailOrLdapLoginId: ids.email, password: ids.password });
  if (!r.ok) throw new Error(`login failed (${r.status})`);
}

const entryOf = (name) => {
  const entry = ids.workflows.find((w) => w.name === name);
  if (!entry) throw new Error(`no seeded workflow called '${name}'; have: ${ids.workflows.map((w) => w.name).join(', ')}`);
  return entry;
};
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
/**
 * A request tag, one length per workflow in every phase: the Webhook node's output keeps the
 * request's `content-length` header, so tags of different lengths would make two otherwise equal
 * runs differ in their outputs after the comparator replaces the tag.
 */
const tagFor = (phase, entry, n) => `${phase}-${slug(entry.name)}-${String(n).padStart(4, '0')}`;

const triggers = new Map();
async function startManual(entry) {
  if (entry.webhook) throw new Error(`'${entry.name}' is webhook-triggered; it has no manual run here`);
  if (!triggers.has(entry.id)) {
    const workflow = await call('GET', `/workflows/${entry.id}`);
    const trigger = workflow.data?.nodes?.find((n) => /trigger$/i.test(n.type));
    if (!trigger) throw new Error(`workflow '${entry.name}' has no manual trigger node`);
    triggers.set(entry.id, trigger.name);
  }
  const started = await call('POST', `/workflows/${entry.id}/run`, { triggerToStartFrom: { name: triggers.get(entry.id) } });
  const executionId = started.data?.executionId;
  if (!started.ok || !executionId) throw new Error(`manual run of '${entry.name}' failed (${started.status}): ${JSON.stringify(started.payload).slice(0, 300)}`);
  return executionId;
}

const ENDED = (e) => e?.finished === true || (e?.status && !['running', 'new', 'waiting'].includes(e.status));
async function waitEnded(executionId, since) {
  for (;;) {
    const r = await call('GET', `/executions/${executionId}`);
    if (ENDED(r.data)) return r.data.status;
    if (Date.now() - since > timeoutMs) throw new Error(`execution ${executionId} did not end within ${timeoutMs} ms`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

async function callWebhook(entry, tag) {
  const t0 = Date.now();
  const response = await fetch(entry.webhook.url.replace(ids.base, base), {
    method: entry.webhook.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  const headers = Object.fromEntries([...response.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  return { status: response.status, headers, body, elapsedMs: Date.now() - t0 };
}

async function write(name, capture) {
  await mkdir(resolve(outDir), { recursive: true });
  await writeFile(resolve(outDir, `${name}.json`), `${JSON.stringify(capture, null, 2)}\n`);
}

/** `name*count,name*count`, names as seeded. */
function parseBatch(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const m = /^(.+)\*(\d+)$/.exec(part);
    if (!m) throw new Error(`--batch: '${part}' is not <name>*<count>`);
    return { name: m[1].trim(), count: Number(m[2]) };
  });
}

await login();

if (command === 'webhook') {
  const repeat = Number(flag('repeat', '5'));
  const hooks = ids.workflows.filter((w) => w.webhook);
  if (hooks.length === 0) throw new Error('no activated webhook workflow in ids.json; was the leg seeded with --v2?');
  for (const entry of hooks) {
    for (let i = 1; i <= repeat; i++) {
      const key = `${slug(entry.name)}.${i}`;
      const tag = tagFor('wh', entry, i);
      const http = await callWebhook(entry, tag);
      await write(key, { phase: 'webhook', key, workflow: entry.name, tag, responseMode: entry.webhook.responseMode, http });
      console.log(`[webhook] ${entry.name} #${i}: ${http.status} in ${http.elapsedMs} ms`);
    }
  }
} else if (command === 'concurrent') {
  const rounds = Number(flag('rounds', '2'));
  const batch = parseBatch(flag('batch',
    'V2 Wide Fan-Out*4,V2 If Switch Diamond*4,V2 Stop And Error Sibling*1,V2 Loop Over Items*1,' +
    'V2 Webhook Two Sinks*3,V2 Webhook Last Node*2,V2 Webhook Respond Node*1'));
  for (let round = 1; round <= rounds; round++) {
    const jobs = batch.flatMap(({ name, count }) => Array.from({ length: count }, (_, k) => ({ entry: entryOf(name), k: k + 1 })));
    const t0 = Date.now();
    // Every request leaves before any is awaited: the batch is in flight at once.
    const results = await Promise.all(jobs.map(async ({ entry, k }) => {
      const key = `${slug(entry.name)}.r${round}.${k}`;
      const since = Date.now();
      if (entry.webhook) {
        const tag = tagFor('cc', entry, round * 100 + k);
        const http = await callWebhook(entry, tag);
        return { phase: 'concurrent', key, round, workflow: entry.name, tag, responseMode: entry.webhook.responseMode, http, startedAtMs: since - t0, elapsedMs: http.elapsedMs };
      }
      const executionId = await startManual(entry);
      const restStatus = await waitEnded(executionId, since);
      return { phase: 'concurrent', key, round, workflow: entry.name, executionId, restStatus, startedAtMs: since - t0, elapsedMs: Date.now() - since };
    }));
    for (const capture of results) await write(capture.key, capture);
    console.log(`[concurrent] round ${round}: ${results.length} runs in flight at once, all ended in ${Date.now() - t0} ms`);
  }
} else {
  const sweep = flag('sweep', 'V2 Wide Fan-Out@0:600:10,V2 If Switch Diamond@0:300:10,V2 Loop Over Items@2000:6000:2000');
  for (const part of sweep.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.+)@(\d+):(\d+):(\d+)$/.exec(part);
    if (!m) throw new Error(`--sweep: '${part}' is not <name>@<from>:<to>:<step>`);
    const entry = entryOf(m[1].trim());
    const [from, to, step] = [Number(m[2]), Number(m[3]), Number(m[4])];
    for (let delay = from; delay <= to; delay += Math.max(step, 1)) {
      const key = `${slug(entry.name)}.d${delay}`;
      const since = Date.now();
      const executionId = await startManual(entry);
      await new Promise((res) => setTimeout(res, delay));
      const stop = await call('POST', `/executions/${executionId}/stop`);
      const stopMs = Date.now() - since;
      const restStatus = await waitEnded(executionId, since);
      await write(key, {
        phase: 'cancel', key, workflow: entry.name, executionId, delayMs: delay, stopAtMs: stopMs,
        stop: { status: stop.status, ok: stop.ok, body: stop.ok ? stop.data : String(stop.payload?.message ?? stop.payload).slice(0, 300) },
        restStatus, elapsedMs: Date.now() - since,
      });
      console.log(`[cancel] ${entry.name} after ${delay} ms: stop ${stop.status}, ended ${restStatus}`);
    }
  }
}
