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
 *
 * With `TESTBED_ENGINE_V2=1` (`n8n-testbed.sh --v2`) every workflow is seeded with
 * `settings.engineType: "v2"`, which is what `EngineV2Dispatcher.handlesWorkflow` routes on, and
 * only the workflows engine v2 can start are seeded: each is put through n8n's own
 * `V1WorkflowConverter` (what the dispatcher calls) and the engine's `validateExecutableGraph`
 * (what `StartExecutionService.start` calls), both resolved from `packages/cli`. A workflow either
 * refuses is skipped and its reason is written to `ids.json`, so nothing is seeded that every run
 * would refuse before a single settlement. The v2-only workflows (`workflows-v2/`) are added.
 * The REST path's acceptance of `engineType` is checked, not assumed: each workflow is read back
 * after the write, and a setting that did not stick fails the seed.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.TESTBED_BASE_URL ?? 'http://127.0.0.1:5678';
const rest = `${base}/rest`;
const email = process.env.TESTBED_EMAIL ?? 'testbed@n8n-libpetri.local';
const password = process.env.TESTBED_PASSWORD ?? 'Testbed-libpetri-1';
const llmPort = process.env.STUB_LLM_PORT ?? '5699';
const out = resolve(process.env.TESTBED_DIR ?? resolve(here, '../../.testbed'), 'ids.json');
const engineV2 = process.env.TESTBED_ENGINE_V2 === '1';

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
function rebind(workflow, cred, seeded) {
  for (const node of workflow.nodes) {
    // A workflow that calls another one cannot know its id until that one is seeded, so it
    // carries `__WORKFLOW_ID:<name>__` and the loop below seeds callees first. Same reason as
    // the port and the credential: nothing in `workflows/` may hardcode instance state.
    const ref = node.parameters?.workflowId;
    if (ref && typeof ref.value === 'string' && ref.value.startsWith('__WORKFLOW_ID:')) {
      const wanted = ref.value.slice('__WORKFLOW_ID:'.length, -2);
      const target = seeded.find((w) => w.name === wanted);
      if (!target) throw new Error(`${workflow.name}: no seeded workflow called '${wanted}' to bind to`);
      node.parameters.workflowId = { __rl: true, mode: 'list', value: target.id, cachedResultName: wanted };
    }
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

/**
 * Why engine v2 would refuse `parsed` before its first settlement, or `null`. The same two calls
 * the server makes, from the same module instances.
 */
let v2Checks;
function v2Refusal(parsed) {
  if (v2Checks === undefined) {
    const resolveFrom = process.env.TESTBED_RESOLVE_FROM ?? resolve(here, '../../.n8n/packages/cli/package.json');
    const req = createRequire(resolveFrom);
    const { V1WorkflowConverter } = req('@n8n/node-engine-compatibility');
    // Not on the package's root export, so its built file: the package has no `exports` map, and
    // `start-execution.service.js` reaches the same file through `../graph`.
    const { validateExecutableGraph } = req('@n8n/engine/dist/graph/validate-executable-graph.js');
    if (typeof validateExecutableGraph !== 'function') throw new Error('@n8n/engine/dist/graph/validate-executable-graph.js exports no validateExecutableGraph');
    v2Checks = { V1WorkflowConverter, validateExecutableGraph };
  }
  let graph;
  try {
    graph = new v2Checks.V1WorkflowConverter().convert({ id: 'seed-check', ...parsed });
  } catch (error) {
    return `V1WorkflowConverter refuses it: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    v2Checks.validateExecutableGraph(graph);
  } catch (error) {
    return `validateExecutableGraph refuses the converted graph: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/**
 * Where a seeded file lives. The v2-only workflows are in `workflows-v2/`, not `workflows/`:
 * `tests/compiler/v1-identity.test.ts` fingerprints every file in `workflows/` under the v1
 * profile, and these are not v1 testbed workflows.
 */
const sourceOf = (file) => resolve(here, file.startsWith('v2-') ? 'workflows-v2' : 'workflows', file);

async function workflow(file, cred, seeded) {
  const parsed = rebind(JSON.parse(await readFile(sourceOf(file), 'utf8')), cred, seeded);
  const body = {
    name: parsed.name,
    nodes: parsed.nodes,
    connections: parsed.connections,
    settings: engineV2 ? { ...parsed.settings, engineType: 'v2' } : parsed.settings,
  };

  const existing = dataOf(await call('GET', '/workflows?includeScopes=false'));
  const list = existing?.data ?? existing;
  const found = Array.isArray(list) ? list.find((w) => w.name === parsed.name) : undefined;
  let id;
  if (found) {
    const updated = await call('PATCH', `/workflows/${found.id}`, { ...body, versionId: found.versionId });
    if (!updated.ok) fail(`workflow update ${parsed.name}`, updated);
    id = found.id;
    console.log(`[seed] workflow updated: ${parsed.name} (${id})`);
  } else {
    const created = await call('POST', '/workflows', body);
    if (!created.ok) fail(`workflow create ${parsed.name}`, created);
    id = idOf(`workflow create ${parsed.name}`, created);
    console.log(`[seed] workflow created: ${parsed.name} (${id})`);
  }
  if (engineV2) {
    // Read back: the settings schema is `passthrough()` today, but a schema that started
    // stripping unknown keys would seed v1 workflows under a v2 name, and every run would
    // silently take engine v1's path.
    const stored = await call('GET', `/workflows/${id}`);
    if (!stored.ok) fail(`workflow read-back ${parsed.name}`, stored);
    const engineType = dataOf(stored)?.settings?.engineType;
    if (engineType !== 'v2') fail(`workflow ${parsed.name} stored settings.engineType=${JSON.stringify(engineType)}, not "v2"; the REST path did not keep it`, stored);
  }
  // A Webhook trigger is published, so its production URL is registered: a manual run of it would
  // only open a test webhook and wait. `diff-engines-v2.sh` reads `webhook` to call it and to keep
  // it out of the manual runs.
  const hook = parsed.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  if (engineV2 && hook) {
    const stored = dataOf(await call('GET', `/workflows/${id}`));
    const activated = await call('POST', `/workflows/${id}/activate`, { versionId: stored.versionId });
    if (!activated.ok) fail(`workflow activate ${parsed.name}`, activated);
    const active = dataOf(activated);
    if (active?.active !== true && !active?.activeVersionId) fail(`workflow ${parsed.name} did not become active`, activated);
    const webhook = {
      method: hook.parameters.httpMethod ?? 'GET',
      path: hook.parameters.path,
      responseMode: hook.parameters.responseMode ?? 'onReceived',
      url: `${base}/webhook/${hook.parameters.path}`,
    };
    console.log(`[seed] workflow activated: ${parsed.name} -> ${webhook.method} ${webhook.url} (${webhook.responseMode})`);
    return { name: parsed.name, id, file, webhook };
  }
  return { name: parsed.name, id, file };
}

await authenticate();
const cred = await credential();
const workflows = [];
const skipped = [];
// Order matters where one workflow calls another: `waiting-child` before `parent-waits-on-child`.
const files = ['concurrency-showcase.json', 'agent-two-tools.json', 'agent-budget-showcase.json',
  'agent-tool-deadline.json', 'agent-nested.json', 'agent-escalation-ladder.json',
  'failure-policy-showcase.json',
  'resilient-fan-out.json', 'waiting-child.json', 'parent-waits-on-child.json',
  // Not a demo: the shape the verifier reports an OR-round overflow on. A node with two
  // producers runs twice, so a downstream OR input with two producers takes three deliveries
  // against a round of two (`compiler/gadget/input-or.ts`, `verify/families/arrival-bound.ts`).
  // Whether that is a real stranding or our bound being wrong is a question only n8n's own
  // engine answers, which is what this leg is for.
  'or-round-overflow.json'];
if (engineV2) {
  // Engine v2 only (`tasks/v2-seam-plan.md` step 11): a Loop Over Items of 1,000 passes at batch
  // size 1 (F4's workload), an If/Switch diamond into a three-input Merge, and a Stop and Error
  // beside a long sibling chain (the failure race named under F2).
  files.push('v2-loop-over-items.json', 'v2-if-switch-diamond.json', 'v2-stop-and-error-sibling.json',
    // The coverage ADR 0014 left open: a wide fan-out for the concurrent and cancel phases, and
    // production webhooks answered with the last node (`runEnd`) and by a Respond to Webhook node
    // (`stepResponse`). The webhook ones are activated below and never run manually.
    'v2-wide-fan-out.json', 'v2-webhook-last-node.json', 'v2-webhook-two-sinks.json',
    'v2-webhook-respond-node.json', 'v2-webhook-fails.json');
}
for (const file of files) {
  if (engineV2) {
    const parsed = JSON.parse(await readFile(sourceOf(file), 'utf8'));
    const reason = v2Refusal(parsed);
    if (reason !== null) {
      skipped.push({ name: parsed.name, file, reason });
      console.log(`[seed] skipped for engine v2: ${parsed.name}: ${reason}`);
      continue;
    }
  }
  workflows.push(await workflow(file, cred, workflows));
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({
  base, email, password, credential: cred, workflows,
  ...(engineV2 ? { engineType: 'v2', skipped } : {}),
}, null, 2) + '\n');
console.log(`[seed] wrote ${out}`);
for (const w of workflows) console.log(`[seed]   ${w.name}: ${base}/workflow/${w.id}`);
