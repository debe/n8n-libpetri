/**
 * Seeds a freshly booted testbed instance over n8n's REST API: the instance owner, the stub
 * OpenAI credential, and the demo workflows. Writes `.testbed/ids.json`, which the launcher
 * prints and `diff-engines.sh` reads to pick the `n8n execute --id` targets.
 *
 * REST rather than the `import:workflow` / `import:credentials` CLI commands, for one reason:
 * both refuse to run without an instance owner, and the only way to create one is
 * `POST /rest/owner/setup` (`owner.controller.ts`, the sole `skipAuth: true` route here). One
 * mechanism that can do all three beats two mechanisms plus an ordering constraint.
 *
 * Idempotent: a second run against the same `.testbed/home` finds the owner already set up,
 * logs in, and reuses the credential and workflows it finds by name.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.TESTBED_BASE_URL ?? 'http://127.0.0.1:5678';
const rest = `${base}/rest`;
const email = process.env.TESTBED_EMAIL ?? 'testbed@n8n-libpetri.local';
const password = process.env.TESTBED_PASSWORD ?? 'Testbed-libpetri-1';
const llmPort = process.env.STUB_LLM_PORT ?? '5699';
const out = resolve(process.env.TESTBED_DIR ?? resolve(here, '../../.testbed'), 'ids.json');

let cookie = '';

async function call(method, path, body) {
  const response = await fetch(`${rest}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'browser-id': 'n8n-libpetri-testbed', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const value of setCookie) if (value.startsWith('n8n-auth=')) cookie = value.split(';')[0];
  const text = await response.text();
  // A 200 whose body is HTML is n8n's editor SPA catch-all answering while the REST
  // controllers are still mounting. Treated as a failure rather than as data: read as JSON it
  // yields `undefined` for every field, which is how the first run of this script "created"
  // two workflows whose ids were `undefined`.
  const json = (response.headers.get('content-type') ?? '').includes('application/json');
  let payload;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    payload = text;
  }
  return { ok: response.ok && (text === '' || json), status: response.status, payload };
}

/** n8n wraps every REST body in `{ data: … }`. */
const dataOf = (result) => result.payload?.data ?? result.payload;

function fail(what, result) {
  const rendered = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
  throw new Error(`${what} failed (${result.status}): ${String(rendered).slice(0, 400)}`);
}

/** An id n8n did not assign is a silent no-op dressed as a success. */
function idOf(what, result) {
  const id = dataOf(result)?.id;
  if (typeof id !== 'string' || id === '') fail(`${what} returned no id`, result);
  return id;
}

async function authenticate() {
  const setup = await call('POST', '/owner/setup', { email, firstName: 'Test', lastName: 'Bed', password });
  if (setup.ok) {
    console.log(`[seed] instance owner created: ${email}`);
    return;
  }
  const login = await call('POST', '/login', { emailOrLdapLoginId: email, password });
  if (!login.ok) fail('owner setup and login both', setup.status === 400 ? login : setup);
  console.log(`[seed] signed in as existing owner: ${email}`);
}

async function credential() {
  const file = JSON.parse(await readFile(resolve(here, 'credentials/stub-openai.json'), 'utf8'));
  const [wanted] = file;
  // The port is authoritative here, not in the committed JSON: the launcher may have been
  // given --llm-port, and a credential pointing at a dead port fails as an opaque agent error.
  const data = { ...wanted.data, url: `http://127.0.0.1:${llmPort}/v1` };

  const existing = dataOf(await call('GET', '/credentials'));
  const found = Array.isArray(existing) ? existing.find((c) => c.name === wanted.name) : undefined;
  if (found) {
    const patched = await call('PATCH', `/credentials/${found.id}`, { name: wanted.name, type: wanted.type, data });
    if (!patched.ok) fail('credential update', patched);
    console.log(`[seed] credential reused: ${wanted.name} (${found.id}) -> ${data.url}`);
    return { id: found.id, name: wanted.name };
  }
  const created = await call('POST', '/credentials', { name: wanted.name, type: wanted.type, data });
  if (!created.ok) fail('credential create', created);
  const id = idOf('credential create', created);
  console.log(`[seed] credential created: ${wanted.name} (${id}) -> ${data.url}`);
  return { id, name: wanted.name };
}

/** Repoints every credential reference in the workflow at the id n8n actually assigned. */
function rebind(workflow, cred) {
  for (const node of workflow.nodes) {
    // The stub's port is chosen by the launcher (`--llm-port`), so a workflow that calls it
    // carries a placeholder rather than a hardcoded number — the same reason the credential's
    // `url` is rewritten below.
    if (typeof node.parameters?.url === 'string') {
      node.parameters.url = node.parameters.url.replace('__LLM_PORT__', llmPort);
    }
    if (!node.credentials) continue;
    for (const type of Object.keys(node.credentials)) {
      node.credentials[type] = { id: cred.id, name: cred.name };
    }
  }
  return workflow;
}

async function workflow(file, cred) {
  const parsed = rebind(JSON.parse(await readFile(resolve(here, 'workflows', file), 'utf8')), cred);
  const body = {
    name: parsed.name,
    nodes: parsed.nodes,
    connections: parsed.connections,
    settings: parsed.settings,
  };

  const existing = dataOf(await call('GET', '/workflows?includeScopes=false'));
  const list = existing?.data ?? existing;
  const found = Array.isArray(list) ? list.find((w) => w.name === parsed.name) : undefined;
  if (found) {
    const updated = await call('PATCH', `/workflows/${found.id}`, { ...body, versionId: found.versionId });
    if (!updated.ok) fail(`workflow update ${parsed.name}`, updated);
    console.log(`[seed] workflow updated: ${parsed.name} (${found.id})`);
    return { name: parsed.name, id: found.id, file };
  }
  const created = await call('POST', '/workflows', body);
  if (!created.ok) fail(`workflow create ${parsed.name}`, created);
  const id = idOf(`workflow create ${parsed.name}`, created);
  console.log(`[seed] workflow created: ${parsed.name} (${id})`);
  return { name: parsed.name, id, file };
}

await authenticate();
const cred = await credential();
const workflows = [];
for (const file of ['concurrency-showcase.json', 'agent-two-tools.json', 'agent-budget-showcase.json', 'agent-tool-deadline.json', 'failure-policy-showcase.json', 'resilient-fan-out.json']) {
  workflows.push(await workflow(file, cred));
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ base, email, password, credential: cred, workflows }, null, 2) + '\n');
console.log(`[seed] wrote ${out}`);
for (const w of workflows) console.log(`[seed]   ${w.name}: ${base}/workflow/${w.id}`);
