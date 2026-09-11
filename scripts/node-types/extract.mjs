/**
 * Build a `--node-types` catalogue from n8n's own generated type descriptions, so the verify
 * CLI stops guessing port counts from connections.
 *
 * The source is `dist/types/nodes.json` in `nodes-base` and `@n8n/nodes-langchain` — the file
 * n8n's build emits and its editor loads, so the counts are n8n's, not ours. A guess is only
 * ever a lower bound: an unconnected output is invisible in an export, and the compiler
 * appends the error output at `outputCount`, so one miscounted port changes the net.
 *
 * Three kinds of entry come out:
 *
 * - **Static** — `inputs` / `outputs` are arrays. Counted, keyed `type@version` for every
 *   version the entry declares, plus a bare `type` key when all versions agree.
 * - **Tool variants** — n8n synthesises `<name>Tool` for every node with `usableAsTool`, and
 *   those never appear in `nodes.json`. A tool has no `main` port at either end (it is reached
 *   over `ai_tool`), which is the compiler's `tool` shape: 0 in, 0 out.
 * - **Dynamic, but invariant in `main`** — `inputs` or `outputs` is an expression, and those
 *   are full JavaScript IIFEs over `$parameter`, not a readable subset. So they are *run*, on a
 *   probe set of parameter objects that exercises every knob n8n's own expressions branch on
 *   (`numberInputs`, `mode`, `rules`, `httpMethod`, `numberOutputs`, `hasOutputParser`, …). Most
 *   of the AI nodes turn out to vary only in their `ai_*` ports — an Agent's inputs expression is
 *   about its Chat Model and Tools — so their `main` count is the same for every probe and is
 *   emitted like a static one. That is the difference between guessing and measuring.
 * - **Dynamic in `main`** — the probe disagrees with itself: Merge's input count, Switch's rule
 *   outputs, Webhook's method outputs. Deliberately **not** emitted; a shape exists only against
 *   a specific node's parameters. `BUILT_IN_SHAPES` in `verify/workflow-json.ts` covers those by
 *   hand, parameter-aware, and is reached because a type missing here falls through to it.
 *
 * Each entry also carries **`canWait`**: whether an activation of this type can suspend the
 * execution. It is derived, not listed — `known/nodes.json` maps every node to the file its
 * build emitted, and that directory is searched for `putExecutionToWait`, so the answer comes
 * from the code that will actually run and cannot drift from it. `executeWorkflow` is the one
 * addition by hand, with a reason: a sub-workflow that waits suspends its *parent* too
 * (`base-execute-context.ts:193`), and the call is in the engine rather than in the node.
 * The flag is what lets a compiler stop offering a `waiting` outcome to the ~94% of nodes that
 * can never take one — an over-approximation that manufactures reachable paused markings.
 *
 * Only `main` ports are counted, because that is the graph the scheduler sees: the adapter
 * filters `NodeHelpers.getNodeInputs` to `main` before the compiler is handed a shape, and
 * `ai_*` connections are resolved by `supplyData` inside `runNode` (ADR 0008).
 *
 *   node scripts/node-types/extract.mjs                      # -> .node-types/catalogue.json
 *   node scripts/node-types/extract.mjs --out=<file> --quiet
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const outArg = args.find((a) => a.startsWith('--out='));
const out = resolve(root, outArg ? outArg.slice('--out='.length) : '.node-types/catalogue.json');

/** The two packages n8n ships node types in, with the prefix each one's `name` gets. */
const SOURCES = [
  {
    prefix: 'n8n-nodes-base.',
    pkg: '.n8n/packages/nodes-base',
    file: '.n8n/packages/nodes-base/dist/types/nodes.json',
    known: '.n8n/packages/nodes-base/dist/known/nodes.json',
  },
  {
    prefix: '@n8n/n8n-nodes-langchain.',
    pkg: '.n8n/packages/@n8n/nodes-langchain',
    file: '.n8n/packages/@n8n/nodes-langchain/dist/types/nodes.json',
    known: '.n8n/packages/@n8n/nodes-langchain/dist/known/nodes.json',
  },
];

/**
 * A sub-workflow that suspends suspends its caller, and that call is in the engine
 * (`base-execute-context.ts:193`) rather than in the node — so the directory search below
 * cannot see it.
 */
const WAITS_INDIRECTLY = new Set(['n8n-nodes-base.executeWorkflow']);

/** Does any file under `dir` mention `putExecutionToWait`? Cached — nodes share directories. */
const waitCache = new Map();
async function directoryCanWait(dir) {
  const cached = waitCache.get(dir);
  if (cached !== undefined) return cached;
  let found = false;
  const walk = async (at, depth) => {
    if (found || depth > 4) return;
    let entries;
    try { entries = await readdir(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found) return;
      const full = join(at, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!entry.name.endsWith('.js')) continue;
      try {
        if ((await readFile(full, 'utf8')).includes('putExecutionToWait')) found = true;
      } catch { /* unreadable file: not evidence either way */ }
    }
  };
  await walk(dir, 0);
  waitCache.set(dir, found);
  return found;
}

/**
 * `main` ports in one `inputs` / `outputs` value, with their display names.
 *
 * The value is an array whose entries are either the bare connection type (`'main'`) or an
 * object carrying `type` and, for outputs, the `displayName` the editor draws on the port —
 * which is what a `route` step in an `executionPolicy` names, so it is worth keeping.
 * Returns `null` for an expression: that is the dynamic case, and a count would be a fiction.
 */
function mainPorts(value) {
  if (typeof value === 'string') return null;
  if (!Array.isArray(value)) return { count: 0, names: [] };
  const names = [];
  let count = 0;
  for (const entry of value) {
    const type = typeof entry === 'string' ? entry : entry?.type;
    if (type !== 'main') continue;
    count += 1;
    names.push(typeof entry === 'object' && entry !== null && typeof entry.displayName === 'string'
      ? entry.displayName : null);
  }
  return { count, names };
}

/**
 * Structural values to try in a parameter slot. An expression's `main` count usually varies
 * either with the *length* of a list it maps over or with a *specific string* it compares
 * against, so both are represented — and the strings are taken from the expression's own
 * source, because `'checkIfEvaluating'` is not a value any generic probe would invent.
 */
const STRUCTURAL_VALUES = [
  undefined, '', 0, 2, true, [],
  [{}, {}, {}],
  {},
  { values: [{}, {}, {}], rules: [{}, {}, {}], categories: [{}, {}, {}] },
];

/** Every `parameters.x`, `parameters?.x` and `parameters['x']` an expression reads. */
function parametersRead(expression) {
  const names = new Set();
  for (const m of expression.matchAll(/parameters\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of expression.matchAll(/parameters\s*\??\.?\[\s*['"]([^'"]+)['"]\s*\]/g)) names.add(m[1]);
  names.delete('map'); names.delete('filter'); names.delete('length');
  return [...names];
}

/** Every string literal in an expression — the values its own branches compare against. */
function literalsIn(expression) {
  const found = new Set();
  for (const m of expression.matchAll(/'([^'\n]{1,40})'|"([^"\n]{1,40})"/g)) {
    const v = m[1] ?? m[2];
    if (v !== undefined && v !== '') found.add(v);
  }
  return [...found].slice(0, 60);
}

/**
 * Probe objects for one expression: every parameter it actually reads, varied one at a time
 * over the structural values and over the expression's own string literals, plus the
 * all-defaults object. One-at-a-time rather than a cross product, which would explode; it is
 * enough to catch a count that depends on a knob, which is the only thing being asked.
 */
function probesFor(expression) {
  const names = parametersRead(expression);
  const values = [...STRUCTURAL_VALUES, ...literalsIn(expression)];
  const probes = [{}];
  for (const name of names) {
    for (const value of values) probes.push({ [name]: value });
    // A nested read (`parameters.options?.fallback`, `parameters.categories?.categories`) needs
    // the *inner* slot filled, so offer each read name as a sub-key of each read name too.
    for (const inner of names) {
      if (inner === name) continue;
      probes.push({ [name]: { [inner]: [{}, {}, {}] } });
    }
  }
  return probes;
}

/**
 * Run one `={{ … }}` expression against a parameter object and count its `main` ports.
 *
 * `runInNewContext` with a bare sandbox and a 500 ms cap: the source is n8n's own generated
 * dist, so this is not a trust boundary, but a node type that loops would otherwise hang the
 * build. A throw is an answer too — it means this probe is not a shape, not that the type has
 * none — so it is reported as `null` and disagrees with nothing.
 */
function evaluatePorts(expression, parameters) {
  const body = expression.trim();
  if (!body.startsWith('={{') || !body.endsWith('}}')) return null;
  try {
    const value = runInNewContext(`(${body.slice(3, -2)})`, { $parameter: parameters }, { timeout: 500 });
    return mainPorts(value);
  } catch {
    return null;
  }
}

/**
 * A dynamic side's shape when it has one: the `main` count every probe agrees on, or `null`
 * when they disagree or none of them produced a value.
 *
 * The probes come from the expression, so "invariant" means *this expression's own knobs, at
 * its own literal values, do not move the count* — not "the fixed list I thought of happens to
 * agree", which is how `textClassifier` (0 outputs until `categories` is set) and `evaluation`
 * (2 outputs only at `operation: 'checkIfEvaluating'`) were first catalogued wrong.
 */
function invariantPorts(expression) {
  const seen = [];
  for (const probe of probesFor(expression)) {
    const ports = evaluatePorts(expression, probe);
    if (ports !== null) seen.push(ports);
  }
  if (seen.length === 0) return null;
  const first = seen[0];
  // Names disagreeing only means the names are not a property of the type — the *count* still
  // has to be checked against every remaining probe, so this must not return early. Returning
  // on the first name mismatch is what catalogued Webhook as one output: its second probe
  // renames the port, and the probe that empties it never ran.
  let namesAgree = true;
  for (const ports of seen) {
    if (ports.count !== first.count) return null;
    if (JSON.stringify(ports.names) !== JSON.stringify(first.names)) namesAgree = false;
  }
  return namesAgree ? first : { count: first.count, names: [] };
}

const types = {};
const stats = { entries: 0, static: 0, evaluated: 0, dynamic: 0, toolVariants: 0, conflicts: 0, canWait: 0 };
const dynamicTypes = new Set();
/** Node type -> whether it can suspend the execution, from n8n's own built output. */
const canWait = new Map();

for (const { prefix, pkg, file, known } of SOURCES) {
  try {
    const map = JSON.parse(await readFile(resolve(root, known), 'utf8'));
    for (const [name, entry] of Object.entries(map)) {
      const source = entry?.sourcePath;
      if (typeof source !== 'string') continue;
      if (await directoryCanWait(resolve(root, pkg, dirname(source)))) canWait.set(prefix + name, true);
    }
  } catch (error) {
    console.error(`[node-types] cannot read ${known}: ${error.message} — canWait will be omitted`);
  }
}

for (const type of WAITS_INDIRECTLY) canWait.set(type, true);

for (const { prefix, file } of SOURCES) {
  const path = resolve(root, file);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.error(`[node-types] cannot read ${file}: ${error.message}`);
    console.error('[node-types] run scripts/bootstrap-n8n.sh first — the catalogue is built from n8n\'s own dist');
    process.exit(1);
  }

  for (const entry of parsed) {
    stats.entries += 1;
    const type = prefix + entry.name;

    // A node with `usableAsTool` gets a synthesised `<name>Tool` type at load time, which is
    // never in this file. It is reached only over `ai_tool`, so it has no `main` port at all.
    if (entry.usableAsTool) {
      const toolType = `${type}Tool`;
      if (types[toolType] === undefined) {
        types[toolType] = { inputCount: 0, outputCount: 0 };
        stats.toolVariants += 1;
      }
    }

    const staticInputs = mainPorts(entry.inputs);
    const staticOutputs = mainPorts(entry.outputs);
    const inputs = staticInputs ?? invariantPorts(entry.inputs);
    const outputs = staticOutputs ?? invariantPorts(entry.outputs);
    if (inputs === null || outputs === null) {
      stats.dynamic += 1;
      dynamicTypes.add(type);
      continue;
    }
    if (staticInputs === null || staticOutputs === null) stats.evaluated += 1;
    else stats.static += 1;

    const shape = { inputCount: inputs.count, outputCount: outputs.count };
    if (canWait.get(type) === true) { shape.canWait = true; stats.canWait += 1; }
    // Only when every port is named: a partial list would be read as a full one by the
    // `route` lookup, and an unnamed output is better addressed by index than by a guess.
    if (outputs.names.length > 0 && outputs.names.every((n) => n !== null)) {
      shape.outputNames = outputs.names;
    }

    const versions = Array.isArray(entry.version) ? entry.version : [entry.version];
    for (const version of versions) {
      if (version === undefined || version === null) continue;
      const key = `${type}@${version}`;
      const seen = types[key];
      if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(shape)) stats.conflicts += 1;
      types[key] = shape;
    }
  }
}

// A bare `type` key for the versions that agree, so a workflow whose `typeVersion` is newer
// than this checkout still resolves. Versions that disagree get no bare key: falling through
// to a reported guess beats silently answering with another version's ports.
const byType = new Map();
for (const [key, shape] of Object.entries(types)) {
  const at = key.lastIndexOf('@');
  if (at < 0) continue;
  const type = key.slice(0, at);
  const shapes = byType.get(type) ?? [];
  shapes.push(JSON.stringify(shape));
  byType.set(type, shapes);
}
let bare = 0;
for (const [type, shapes] of byType) {
  if (types[type] !== undefined) continue;
  if (new Set(shapes).size !== 1) continue;
  types[type] = JSON.parse(shapes[0]);
  bare += 1;
}

// A dynamic type must not pick up a bare key from a *static* sibling entry of the same name
// (an old version of Switch is static, the current one is not) — the parameter-aware
// `BUILT_IN_SHAPES` has to be reached instead.
let withheld = 0;
for (const type of dynamicTypes) {
  if (types[type] !== undefined) { delete types[type]; withheld += 1; }
}

/**
 * Anchors, checked on every run. The catalogue is generated, so nothing else would notice a
 * probe that starts calling a router's variable output count invariant — which is exactly the
 * mistake this file made first, and which turned two real templates into compile failures
 * (`Text Classifier.0 -> …: output index out of range (node has 0 outputs)`). Each entry is
 * either a shape that must be present and exact, or a type that must be withheld as dynamic.
 */
const ANCHORS = {
  present: {
    'n8n-nodes-base.if@2': { inputCount: 1, outputCount: 2 },
    'n8n-nodes-base.splitInBatches@3': { inputCount: 1, outputCount: 2 },
    'n8n-nodes-base.splitInBatches@1': { inputCount: 1, outputCount: 1 },
    'n8n-nodes-base.stickyNote': { inputCount: 0, outputCount: 0 },
    'n8n-nodes-base.httpRequestTool': { inputCount: 0, outputCount: 0 },
    '@n8n/n8n-nodes-langchain.agent': { inputCount: 1, outputCount: 1 },
    '@n8n/n8n-nodes-langchain.toolCalculator': { inputCount: 0, outputCount: 0 },
  },
  /**
   * Version keys whose `main` count moves with a parameter, so a shape would be a fiction —
   * named per version, because an *older* version of the same node is often genuinely static
   * (`switch@1` really does have four outputs) and catalguing that one is right.
   * `BUILT_IN_SHAPES` handles the dynamic ones that matter, parameter-aware.
   */
  withheld: [
    'n8n-nodes-base.merge@3.2', 'n8n-nodes-base.switch@3.4', 'n8n-nodes-base.switch@2',
    'n8n-nodes-base.webhook@2', 'n8n-nodes-base.webhook@1',
    'n8n-nodes-base.respondToWebhook@1.4', 'n8n-nodes-base.evaluation@4.8',
    '@n8n/n8n-nodes-langchain.textClassifier@1.1',
    // Bare keys too: a bare key answers for a `typeVersion` this checkout has never seen.
    'n8n-nodes-base.merge', 'n8n-nodes-base.switch', 'n8n-nodes-base.webhook',
    'n8n-nodes-base.respondToWebhook', 'n8n-nodes-base.evaluation',
    '@n8n/n8n-nodes-langchain.textClassifier',
  ],
};

const failures = [];
for (const [key, want] of Object.entries(ANCHORS.present)) {
  const got = types[key];
  if (got === undefined) { failures.push(`${key}: missing`); continue; }
  if (got.inputCount !== want.inputCount || got.outputCount !== want.outputCount) {
    failures.push(`${key}: ${got.inputCount}/${got.outputCount}, expected ${want.inputCount}/${want.outputCount}`);
  }
}
for (const key of ANCHORS.withheld) {
  if (types[key] !== undefined) {
    failures.push(`${key}: catalogued as ${JSON.stringify(types[key])}, but its main port count depends on parameters`);
  }
}
if (failures.length > 0) {
  console.error('[node-types] anchor check failed — the catalogue would mis-shape real workflows:');
  for (const f of failures) console.error(`[node-types]   ${f}`);
  process.exit(1);
}

// `canWait` also as a flat list, because a type whose ports are dynamic gets no `types` entry
// at all and would otherwise lose the flag — `respondToWebhook` is both. Whether a node can
// suspend an execution has nothing to do with how many ports it has, so it is recorded
// separately rather than hidden inside a shape.
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ types, canWait: [...canWait.keys()].sort() }, null, 1) + '\n');

if (!quiet) {
  console.log(`[node-types] ${stats.entries} entries from ${SOURCES.length} package(s)`);
  console.log(`[node-types]   static        ${stats.static}`);
  console.log(`[node-types]   evaluated     ${stats.evaluated} (expression, but invariant in main across every probe)`);
  console.log(`[node-types]   dynamic       ${stats.dynamic} (${dynamicTypes.size} type(s), left to BUILT_IN_SHAPES)`);
  console.log(`[node-types]   tool variants ${stats.toolVariants}`);
  console.log(`[node-types]   canWait       ${stats.canWait} entr(ies), ${canWait.size} type(s) that can suspend an execution`);
  console.log(`[node-types] ${Object.keys(types).length} key(s): ${bare} bare type key(s), ${withheld} withheld as dynamic`);
  if (stats.conflicts > 0) console.log(`[node-types]   ${stats.conflicts} version key(s) written twice with different ports`);
  console.log(`[node-types] -> ${out}`);
}
