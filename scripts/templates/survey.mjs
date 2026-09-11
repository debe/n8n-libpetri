/**
 * Compiles and verifies every workflow in `.templates/` and reports what happened, in
 * aggregate — the cheap half of testing this engine against workflows nobody here wrote.
 *
 *   node scripts/templates/survey.mjs [--budget 4] [--timeout 45] [--jobs 4]
 *
 * It drives the shipped `n8n-libpetri verify` CLI, one process per workflow, for two reasons:
 * a workflow that makes the compiler throw takes its own process down and not the survey, and
 * the thing under test is then the entry point a user actually runs.
 *
 * **What this measures and what it does not.** It measures whether real shapes *compile*, what
 * concurrency budget they would get, and what the solver-free route decides about them. It does
 * not run them: no credentials, no services, no data. A workflow that compiles has not been
 * shown to execute correctly — that needs the differ, and the differ needs a workflow that can
 * run offline.
 *
 * Node-type shapes come from `--node-types`, the catalogue `scripts/node-types/extract.mjs`
 * builds out of n8n's own generated `dist/types/nodes.json`. A template export carries no
 * node-type descriptions, so without it every port count is **guessed from the connections**
 * (`verify/workflow-json.ts`) — and a guess is only ever a lower bound, since an unwired output
 * is invisible in an export and one miscounted port changes the compiled net. Pass
 * `--node-types <file>`, or `--no-node-types` to measure the guessing floor deliberately.
 * Whatever is left guessed is still counted and reported; the number is the accuracy caveat.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(root, '.templates');
const cli = resolve(root, 'typescript/dist/verify/main.js');
const outDir = resolve(root, '.templates/.survey');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const budget = arg('budget', '4');
const timeoutSec = Number.parseInt(arg('timeout', '45'), 10);
const jobs = Number.parseInt(arg('jobs', '4'), 10);
const nodeTypes = process.argv.includes('--no-node-types')
  ? null
  : resolve(root, arg('node-types', '.node-types/catalogue.json'));

function runOne(file) {
  return new Promise((done) => {
    const started = Date.now();
    execFile('node', [cli, 'verify', file, '--budget', budget, '--smt-fallback', 'off',
      ...(nodeTypes === null ? [] : ['--node-types', nodeTypes]),
      '--max-classes', '50000', '--json'],
    { timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => {
      const wallMs = Date.now() - started;
      if (error && error.killed) return done({ outcome: 'timeout', wallMs });
      if (!stdout.trim()) {
        const why = (stderr || String(error?.message ?? '')).trim().split('\n').pop() ?? 'no output';
        return done({ outcome: 'refused', why: why.slice(0, 200), wallMs });
      }
      try {
        return done({ outcome: 'verified', report: JSON.parse(stdout), wallMs });
      } catch {
        return done({ outcome: 'unparsable', wallMs });
      }
    });
  });
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => resolve(dir, f));
console.log(`[survey] ${files.length} workflows, budget ${budget}, ${timeoutSec}s each, ${jobs} at a time`);

const rows = [];
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < files.length) {
    const file = files[next++];
    const id = basename(file, '.json');
    let nodes = 0;
    let name = '';
    try {
      const wf = JSON.parse(await readFile(file, 'utf8'));
      nodes = wf.nodes?.length ?? 0;
      name = wf.name ?? '';
    } catch { /* counted as unreadable below */ }
    const result = await runOne(file);
    rows.push({ id, name, nodes, ...result });
    if (rows.length % 25 === 0) console.log(`[survey] ${rows.length}/${files.length}`);
  }
}));

await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'rows.json'), JSON.stringify(rows, null, 1) + '\n');

// ---- aggregate ----
const n = rows.length;
const count = (p) => rows.filter(p).length;
const pct = (k) => `${((k / n) * 100).toFixed(1)}%`;

const verified = rows.filter((r) => r.outcome === 'verified');
const refused = rows.filter((r) => r.outcome === 'refused');

console.log(`\n=== corpus =================================================`);
console.log(`workflows                 ${n}`);
console.log(`  compiled + verified     ${verified.length}  (${pct(verified.length)})`);
console.log(`  refused by the compiler ${refused.length}  (${pct(refused.length)})`);
console.log(`  timed out (${timeoutSec}s)         ${count((r) => r.outcome === 'timeout')}`);

if (refused.length > 0) {
  console.log(`\n=== why the compiler refused ==============================`);
  const why = new Map();
  for (const r of refused) {
    const key = r.why.replace(/'[^']*'/g, "'…'").replace(/\d+/g, 'N').slice(0, 110);
    why.set(key, (why.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}

if (verified.length > 0) {
  console.log(`\n=== concurrency (requested k = ${budget}) =========================`);
  const kept = verified.filter((r) => r.report.budget > 1);
  console.log(`  would run k > 1         ${kept.length}  (${((kept.length / verified.length) * 100).toFixed(1)}% of verified)`);
  const restrict = new Map();
  for (const r of verified.filter((x) => x.report.budget === 1)) {
    const key = r.report.budgetRestriction?.reason ?? r.report.budgetRestriction ?? 'unknown';
    restrict.set(String(key), (restrict.get(String(key)) ?? 0) + 1);
  }
  for (const [k, v] of [...restrict].sort((a, b) => b[1] - a[1])) console.log(`  lowered to 1: ${String(v).padStart(3)}  ${k}`);

  console.log(`\n=== what the solver-free route decided ====================`);
  const byProp = new Map();
  for (const r of verified) {
    for (const c of r.report.checks ?? []) {
      const m = byProp.get(c.property) ?? new Map();
      m.set(c.verdict, (m.get(c.verdict) ?? 0) + 1);
      byProp.set(c.property, m);
    }
  }
  for (const [prop, m] of [...byProp].sort()) {
    const parts = [...m].sort().map(([v, c]) => `${v}=${c}`).join('  ');
    console.log(`  ${prop.padEnd(22)} ${parts}`);
  }

  const violated = verified.filter((r) => (r.report.checks ?? []).some((c) => c.verdict === 'violated'));
  console.log(`\n=== workflows with a VIOLATED check =======================`);
  console.log(`  ${violated.length} of ${verified.length}`);
  for (const r of violated.slice(0, 15)) {
    const bad = r.report.checks.filter((c) => c.verdict === 'violated');
    console.log(`  #${r.id} ${String(r.name).slice(0, 46)} (${r.nodes} nodes)`);
    for (const c of bad.slice(0, 2)) console.log(`      ${c.property}: ${c.name}`);
  }

  const guessed = verified.reduce((a, r) => a + (r.report.shapeWarnings?.length ?? 0), 0);
  const nodesTotal = verified.reduce((a, r) => a + r.nodes, 0);
  console.log(`\n=== accuracy caveat =======================================`);
  console.log(`  node shapes guessed from connections: ${guessed} of ~${nodesTotal} nodes`);
  console.log(`  a guessed shape can change the compiled net (see the module doc)`);
}
console.log(`\nrows: ${resolve(outDir, 'rows.json')}`);
