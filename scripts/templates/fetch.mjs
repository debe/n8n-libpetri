/**
 * Fetches published workflows from n8n's public template API into `.templates/`.
 *
 * The point is to test the compiler and the verifier against workflows *nobody here wrote*.
 * Our own fixtures were built to exercise the gadgets, and the testbed demos were built to show
 * the feature off; neither is evidence about real shapes. These are.
 *
 *   node scripts/templates/fetch.mjs [count]        # default 200
 *
 * Polite by construction: one search page at a time, one workflow at a time, a small delay
 * between requests, and it skips anything already on disk so a re-run costs almost nothing.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, '.templates');
const want = Number.parseInt(process.argv[2] ?? '200', 10);
const API = 'https://api.n8n.io/api/templates';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return await response.json();
}

await mkdir(out, { recursive: true });
const have = new Set((await readdir(out)).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')));
console.log(`[fetch] ${have.size} already on disk, want ${want}`);

const ids = [];
for (let page = 1; ids.length < want * 2 && page <= 40; page++) {
  const { workflows = [] } = await json(`${API}/search?page=${page}&rows=50`);
  if (workflows.length === 0) break;
  for (const w of workflows) ids.push(w.id);
  await sleep(200);
}

let saved = 0;
let failed = 0;
for (const id of ids) {
  if (saved >= want) break;
  if (have.has(String(id))) continue;
  try {
    const body = await json(`${API}/workflows/${id}`);
    const wf = body.workflow?.workflow ?? body.workflow ?? body;
    if (!Array.isArray(wf?.nodes) || wf.nodes.length === 0) { failed++; continue; }
    await writeFile(resolve(out, `${id}.json`), JSON.stringify(wf, null, 1) + '\n');
    saved++;
    if (saved % 25 === 0) console.log(`[fetch] ${saved}/${want}`);
  } catch {
    failed++;
  }
  await sleep(150);
}
console.log(`[fetch] saved ${saved}, skipped ${failed} that did not parse, into ${out}`);
