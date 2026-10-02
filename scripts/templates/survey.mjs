/**
 * Compiles and verifies every workflow in `.templates/` and reports what happened, in
 * aggregate — the cheap half of testing this engine against workflows nobody here wrote.
 *
 *   node scripts/templates/survey.mjs [--profile engineV2|v1] [--budget 4] [--timeout 45] [--jobs 4]
 *
 * `--profile` is the compile target, handed to the CLI by name on every run, never left to its
 * default. It defaults to `engineV2`, the CLI's own default since ADR 0013 (decision 2): the
 * survey runs the `settlement` family and has no budget, so `--budget` is refused beside it.
 * `--profile v1` is the survey recorded before ADR 0013 (`docs/conformance-2.41.3.md`, "Template
 * survey"), with the same CLI arguments as then, so that survey stays reproducible; its rows go
 * to `rows.v1.json`, the engineV2 survey's to `rows.engineV2.json`.
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
 * **A report is not a verification.** A run that printed a report has compiled; it has verified
 * something only if at least one check came back `proven`, `violated` or `bounded`. A report
 * whose checks are all `unknown` (the state-class graph did not close, and under v1 the SMT route
 * is off here) decided nothing, and is counted as `undecided`, apart from `verified`
 * (`survey-outcome.mjs`, which says why the counts decide and not the exit code).
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
import { outcomeOf } from './survey-outcome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(root, '.templates');
const cli = resolve(root, 'typescript/dist/verify/main.js');
const outDir = resolve(root, '.templates/.survey');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const profile = arg('profile', 'engineV2');
if (profile !== 'v1' && profile !== 'engineV2') {
  console.error(`--profile must be v1 or engineV2, got '${profile}'`);
  process.exit(2);
}
const v1 = profile === 'v1';
if (!v1 && process.argv.includes('--budget')) {
  console.error('--budget is the v1 concurrency budget; engine v2 has none. Pass --profile v1 to use it.');
  process.exit(2);
}
const budget = arg('budget', '4');
const timeoutSec = Number.parseInt(arg('timeout', '45'), 10);
const jobs = Number.parseInt(arg('jobs', '4'), 10);
const nodeTypes = process.argv.includes('--no-node-types')
  ? null
  : resolve(root, arg('node-types', '.node-types/catalogue.json'));

function runOne(file) {
  return new Promise((done) => {
    const started = Date.now();
    // v1: the arguments of the survey recorded before ADR 0013, unchanged. engineV2: no budget and
    // no SMT route to turn off; the state-class cap bounds the settlement family's graph.
    const target = v1 ? ['--profile', 'v1', '--budget', budget, '--smt-fallback', 'off'] : ['--profile', 'engineV2'];
    execFile('node', [cli, 'verify', file, ...target,
      ...(nodeTypes === null ? [] : ['--node-types', nodeTypes]),
      '--max-classes', '50000', '--json'],
    { timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => {
      const wallMs = Date.now() - started;
      const exitCode = typeof error?.code === 'number' ? error.code : 0;
      done({
        ...outcomeOf({ killed: Boolean(error?.killed), exitCode, stdout, stderr, errorMessage: error?.message }),
        wallMs,
      });
    });
  });
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => resolve(dir, f));
console.log(`[survey] ${files.length} workflows, profile ${profile}${v1 ? `, budget ${budget}` : ''}, ${timeoutSec}s each, ${jobs} at a time`);

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
const rowsFile = resolve(outDir, `rows.${profile}.json`);
await writeFile(rowsFile, JSON.stringify(rows, null, 1) + '\n');

// ---- aggregate ----
const n = rows.length;
const count = (p) => rows.filter(p).length;
const pct = (k) => `${((k / n) * 100).toFixed(1)}%`;

const verified = rows.filter((r) => r.outcome === 'verified');
const undecided = rows.filter((r) => r.outcome === 'undecided');
// Every run that produced a report compiled; the sections below read all of them.
const reported = [...verified, ...undecided];
const refused = rows.filter((r) => r.outcome === 'refused');

console.log(`\n=== corpus =================================================`);
console.log(`workflows                 ${n}`);
console.log(`  compiled                ${reported.length}  (${pct(reported.length)})`);
console.log(`    verified              ${verified.length}  (${pct(verified.length)}; at least one check proven, violated or bounded)`);
console.log(`    decided nothing       ${undecided.length}  (${pct(undecided.length)}; every check unknown${v1 ? '' : ', CLI exit 3'})`);
console.log(`  refused by the compiler ${refused.length}  (${pct(refused.length)})`);
const unparsable = count((r) => r.outcome === 'unparsable');
if (unparsable > 0) console.log(`  unparsable output       ${unparsable}`);
console.log(`  timed out (${timeoutSec}s)         ${count((r) => r.outcome === 'timeout')}`);

if (refused.length > 0) {
  console.log(`\n=== why the compiler refused ==============================`);
  const why = new Map();
  for (const r of refused) {
    // The CLI prefixes the file it read; the reason is what follows. An engineV2 refusal names
    // n8n's error class in parentheses, and node names can hold quotes, so the class is the key
    // when there is one.
    const reason = r.why.replace(/^.*?\.json: /, '');
    const errorClass = /\((\w+Error)\b/.exec(reason)?.[1];
    const key = errorClass ?? reason.replace(/'[^']*'/g, "'…'").replace(/\d+/g, 'N').slice(0, 110);
    why.set(key, (why.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}

if (reported.length > 0 && v1) {
  console.log(`\n=== concurrency (requested k = ${budget}) =========================`);
  const kept = reported.filter((r) => r.report.budget > 1);
  console.log(`  would run k > 1         ${kept.length}  (${((kept.length / reported.length) * 100).toFixed(1)}% of compiled)`);
  const restrict = new Map();
  for (const r of reported.filter((x) => x.report.budget === 1)) {
    const key = r.report.budgetRestriction?.reason ?? r.report.budgetRestriction ?? 'unknown';
    restrict.set(String(key), (restrict.get(String(key)) ?? 0) + 1);
  }
  for (const [k, v] of [...restrict].sort((a, b) => b[1] - a[1])) console.log(`  lowered to 1: ${String(v).padStart(3)}  ${k}`);
}

if (reported.length > 0) {
  console.log(`\n=== what the solver-free route decided ====================`);
  const byProp = new Map();
  for (const r of reported) {
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

  const guessed = reported.reduce((a, r) => a + (r.report.shapeWarnings?.length ?? 0), 0);
  const nodesTotal = reported.reduce((a, r) => a + r.nodes, 0);
  console.log(`\n=== accuracy caveat =======================================`);
  console.log(`  node shapes guessed from connections: ${guessed} of ~${nodesTotal} nodes`);
  console.log(`  a guessed shape can change the compiled net (see the module doc)`);
}
console.log(`\nrows: ${rowsFile}`);
