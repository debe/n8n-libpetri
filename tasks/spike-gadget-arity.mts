/**
 * Does a gadget's class count move with the budget iff it has two or more input groups?
 *
 * Proposed by the libpetri review after reading `spike-open-net-gadget.mts`: arrivals enter the
 * contract as one `arrive(1, ...)` per **input port group**, so a gadget's arrival count is its
 * input arity, and class count should track `min(budget, arity)` — moving up to that point and
 * flat after it. The corollary is that the 478 non-movers are the single-input nodes, where
 * `min(budget, 1) = 1` makes the budget unobservable at any size.
 *
 * Two falsifiers, both run here:
 *  1. cross-tabulate movers against input-group count — if the movers are not exactly the
 *     multi-input gadgets, the law is wrong;
 *  2. sweep budgets 1, 2, 4, 8 rather than 1 and 4, so the *plateau* is visible — a two-input
 *     gadget should move 1→2 and then be flat.
 *
 * It also tests the competing explanation for cost. I reported that cost tracks port count; the
 * review measured class count flat from 11 to 59 places and 9 to 57 ports and argues ports are
 * free, because a compiled node's outgoing edges are correlated (one `xor` picks data for all or
 * empty for all), so edges add places without adding choices.
 *
 *   npx tsx tasks/spike-gadget-arity.mts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { PetriNet } from '../typescript/node_modules/libpetri/dist/index.js';
import { flatten, OpenNetContract, verifyOpenNet }
  from '../typescript/node_modules/libpetri/dist/verification/index.js';
import { analyse } from '../typescript/src/compiler/graph.js';
import { compile } from '../typescript/src/compiler/compile.js';
import { composeNet } from '../typescript/src/compiler/compile/compose.js';
import { mapNet } from '../typescript/src/compiler/compile/mapping.js';
import { bindActions } from '../typescript/src/compiler/compile/bind.js';
import { placeholderActions } from '../typescript/src/compiler/actions.js';
import { REST_ROLES, PAUSE_REST_ROLES, HALT_REST_ROLES } from '../typescript/src/verify/state-space/roles.js';
import { describeWorkflowJson, parseNodeTypesFile } from '../typescript/src/verify/workflow-json.js';

const DIR = new URL('../.templates/', import.meta.url).pathname;
const nodeTypes = parseNodeTypesFile(JSON.parse(readFileSync(
  new URL('../.node-types/catalogue.json', import.meta.url).pathname, 'utf8')));
const BUDGETS = [1, 2, 4, 8];

function gadgetOf(wf: any, node: any, budget: number) {
  const analysis = analyse(wf);
  const full = composeNet(wf, analysis);
  const fullMap = mapNet(full.structural as any, full.shared as any, full.builds as any);
  const build: any = full.builds.find((b: any) => b.prefix === node.id);
  if (build === undefined) throw new Error('no gadget');
  const structural = PetriNet.builder(`g:${node.name}`)
    .compose(build.def.instantiate(build.prefix), new Map(build.ports)).build();
  const fallback = placeholderActions();
  const net = bindActions(structural as any, fullMap as any, (i: any, m: any) => fallback(i, m));
  const byName = new Map<string, any>();
  for (const p of flatten(net as any).places) byName.set((p as any).name, p);
  const roles = new Map<string, string>();
  for (const pi of (fullMap as any).places) if (byName.has(pi.place.name)) roles.set(pi.place.name, pi.role);
  const compiled: any = compile(wf, { budget: Math.max(budget, 1), maxAgentToolCalls: 4 } as any);
  const seed = new Map<string, number>();
  for (const [pl, toks] of compiled.initialMarking(null)) {
    if (byName.has((pl as any).name)) seed.set((pl as any).name, (toks as any[]).length);
  }
  seed.set('_budget', budget);
  return { build, net, byName, roles, seed, prefix: node.id as string };
}

/**
 * `inputs` counts distinct **edge** groups; `indices` counts distinct input **indices**.
 *
 * They differ exactly where it matters. Two input indices is a *join*: both are required, so the
 * node runs once however large the budget. Two producer edges on ONE index is an *OR*: two
 * arrivals, so two activations can be in flight and the budget binds. Counting "input groups"
 * conflates them, which is why the law held in one direction and not the other.
 */
function groups(build: any) {
  const inputs = new Map<string, string[]>(); const outputs = new Map<string, string[]>();
  for (const [port] of build.ports) {
    if (port === 'budget' || port === 'halt' || port === 'pause') continue;
    const base = port.replace(/_empty$/, '');
    const b = base.startsWith('out') ? outputs : inputs;
    b.set(base, [...(b.get(base) ?? []), port]);
  }
  const indices = new Set<string>();
  for (const base of inputs.keys()) indices.add(/^in(\d+)_/.exec(base)?.[1] ?? base);
  return { inputs, outputs, indices };
}

function contractFor(g: ReturnType<typeof gadgetOf>) {
  const { build, byName, roles, seed, prefix } = g;
  const host = (p: string) => byName.get(build.ports.get(p).name);
  const local = (s: string) => byName.get(`${prefix}/${s}`);
  const withRole = (set: ReadonlySet<any>, minus?: ReadonlySet<any>) =>
    [...roles].filter(([, r]) => set.has(r) && !(minus?.has(r) ?? false)).map(([n]) => byName.get(n));
  const { inputs } = groups(build);
  const inPlaces = new Set([...inputs.values()].flat().map((p) => build.ports.get(p).name));
  const b: any = OpenNetContract.builder().initialMarking((m: any) => {
    for (const [n, c] of seed) if (!inPlaces.has(n)) m.tokens(byName.get(n), c);
  });
  for (const ports of inputs.values()) b.arrive(1, ...ports.map(host));
  if (local('idle') !== undefined) b.expect('idle returned', 1, local('idle'));
  b.expect('budget returned', seed.get('_budget') ?? 0, byName.get('_budget'));
  b.rest(...withRole(REST_ROLES));
  if (byName.get('_halt')) b.terminal(byName.get('_halt'), ...withRole(HALT_REST_ROLES, REST_ROLES));
  if (byName.get('_pause')) b.terminal(byName.get('_pause'), ...withRole(PAUSE_REST_ROLES, REST_ROLES));
  return b.requireTermination(true).build();
}

interface Row { key: string; type: string; inputs: number; outputs: number; indices: number;
  liveEdges: number; liveIndices: number; exclusive: boolean; loopBack: boolean;
  ports: number; places: number; classes: number[] }

/**
 * Producer edges whose producer can actually fire, grouped by input index.
 *
 * The review's falsifier for the flat ORs: a gadget is an OR *on paper* when an index has two
 * producer edges, but if one producer is unreachable from any start node it can never deliver,
 * the gadget has one live arrival, and the law correctly predicts it is flat. Counting raw
 * edges conflates declared arity with live arity.
 */
/** Nodes reachable from one specific output of a router, cached per (node, output). */
const reachCache = new Map<string, Set<string>>();
function reachFromOutput(analysis: any, node: string, out: number): Set<string> {
  const key = `${node}#${out}`;
  const hit = reachCache.get(key);
  if (hit !== undefined) return hit;
  const seen = new Set<string>();
  const stack = (analysis.outgoing.get(node) ?? []).filter((e: any) => e.outputIndex === out).map((e: any) => e.to);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of analysis.outgoing.get(n) ?? []) stack.push(e.to);
  }
  reachCache.set(key, seen);
  return seen;
}

/**
 * Are two producers **mutually exclusive** — descendants of different outputs of one router?
 *
 * The review's mechanism: an empty takes the skip path and a skip spends no budget, so several
 * arrivals that cannot all carry data are still one activation, and the budget has nothing to
 * cap. Exclusivity is a consequence of upstream XOR routing, which a gadget-local contract
 * cannot see — so this is a graph query, not a property of the subnet.
 */
function mutuallyExclusive(analysis: any, p1: string, p2: string): boolean {
  for (const a of analysis.nodes) {
    const outs = a.outputCount ?? 1;
    if (outs <= 1) continue;
    for (let i = 0; i < outs; i++) {
      for (let j = i + 1; j < outs; j++) {
        const ri = reachFromOutput(analysis, a.node.name, i);
        const rj = reachFromOutput(analysis, a.node.name, j);
        if (ri.has(p1) && !rj.has(p1) && rj.has(p2) && !ri.has(p2)) return true;
        if (ri.has(p2) && !rj.has(p2) && rj.has(p1) && !ri.has(p1)) return true;
      }
    }
  }
  return false;
}

/** Does this node take an edge from its own SCC — a loop-back, so it can re-activate itself? */
function hasLoopBack(analysis: any, name: string): boolean {
  const scc = analysis.sccOf.get(name);
  return [...(analysis.incoming.get(name) ?? [])].some((e: any) =>
    e.from === name || (analysis.cyclic.has(name) && analysis.sccOf.get(e.from) === scc));
}

/** All producer pairs on one index mutually exclusive? */
function allExclusive(analysis: any, name: string): boolean {
  const byIndex = new Map<number, string[]>();
  for (const e of analysis.incoming.get(name) ?? []) {
    byIndex.set(e.inputIndex, [...(byIndex.get(e.inputIndex) ?? []), e.from]);
  }
  for (const ps of byIndex.values()) {
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        if (!mutuallyExclusive(analysis, ps[i]!, ps[j]!)) return false;
      }
    }
  }
  return true;
}

function liveArity(analysis: any, nodeName: string) {
  const byIndex = new Map<number, number>();
  for (const e of analysis.incoming.get(nodeName) ?? []) {
    if (!analysis.reachable.has(e.from)) continue;
    byIndex.set(e.inputIndex, (byIndex.get(e.inputIndex) ?? 0) + 1);
  }
  let edges = 0;
  for (const n of byIndex.values()) edges += n;
  return { liveEdges: edges, liveIndices: byIndex.size };
}
const rows: Row[] = [];

for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json')).sort().slice(0, Number(process.env.LIMIT ?? 25))) {
  let description: any;
  try { description = describeWorkflowJson(JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')), { nodeTypes }).description; }
  catch { continue; }
  for (const node of description.nodes) {
    const classes: number[] = []; let meta: any = null;
    for (const budget of BUDGETS) {
      try {
        const g = gadgetOf(description, node, budget);
        const flat = flatten(g.net as any);
        const r: any = await verifyOpenNet(g.net as any, contractFor(g), { maxClasses: 50_000, smt: false });
        const gr = groups(g.build);
        meta ??= { ports: g.build.ports.size, places: flat.places.length, inputs: gr.inputs.size, outputs: gr.outputs.size, indices: gr.indices.size };
        classes.push(r.classCount);
      } catch { classes.push(-1); }
    }
    if (meta === null || classes.some((c) => c < 0)) continue;
    const an = analyse(description);
    const live = liveArity(an, node.name);
    const cls = { exclusive: allExclusive(an, node.name), loopBack: hasLoopBack(an, node.name) };
    rows.push({ key: `${f}|${node.name}`, type: String(node.type).replace('n8n-nodes-base.', ''), ...meta, ...live, ...cls, classes });
  }
}

const moved = (r: Row) => new Set(r.classes).size > 1;
const movers = rows.filter(moved); const flatRows = rows.filter((r) => !moved(r));
console.log(`gadgets: ${rows.length}  movers: ${movers.length}  flat: ${flatRows.length}\n`);

console.log('--- FALSIFIER 1: movers vs input-group count ---');
const tab = new Map<number, { moved: number; flat: number }>();
for (const r of rows) {
  const e = tab.get(r.inputs) ?? { moved: 0, flat: 0 };
  if (moved(r)) e.moved++; else e.flat++;
  tab.set(r.inputs, e);
}
console.log('  inputs | movers | flat');
for (const [n, e] of [...tab].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(n).padStart(6)} | ${String(e.moved).padStart(6)} | ${String(e.flat).padStart(4)}`);
}
const law = rows.every((r) => moved(r) === (r.inputs >= 2));
console.log(`  law "moves iff edge-groups >= 2": ${law ? 'HOLDS' : 'REFUTED'}`);
// The discriminator: more edges than indices means some index has several producers — an OR,
// where two arrivals mean two activations. Equal counts is a join: every index required once.
const orLike = (r: Row) => r.inputs > r.indices;
const law2 = rows.filter((r) => r.classes[0]! < 50_000).every((r) => moved(r) === orLike(r));
console.log(`  law "moves iff some index has >1 producer (OR, not join)": ${law2 ? 'HOLDS' : 'REFUTED'}`
  + '  [capped rows excluded: they are truncated, not flat]');
const tab2 = new Map<string, { moved: number; flat: number }>();
for (const r of rows) {
  if (r.classes[0]! >= 50_000) continue;
  const k = `${orLike(r) ? 'OR  ' : 'join'} idx=${r.indices} edges=${r.inputs}`;
  const e = tab2.get(k) ?? { moved: 0, flat: 0 };
  if (moved(r)) e.moved++; else e.flat++;
  tab2.set(k, e);
}
for (const [k, e] of [...tab2].sort()) console.log(`    ${k}: movers ${e.moved}, flat ${e.flat}`);

// The review's second falsifier: flat <=> all producers mutually exclusive AND no loop-back.
const predictFlat = (r: Row) => r.exclusive && !r.loopBack;
const ors = rows.filter((r) => r.inputs > r.indices && r.classes[0]! < 50_000);
const lawX = ors.every((r) => !moved(r) === predictFlat(r));
console.log(`\n  law "flat <=> all-exclusive AND no loop-back", over ${ors.length} ORs: ${lawX ? 'HOLDS' : 'REFUTED'}`);
{
  const t = new Map<string, number>();
  for (const r of ors) t.set(`excl=${r.exclusive} loop=${r.loopBack} moved=${moved(r)}`,
    (t.get(`excl=${r.exclusive} loop=${r.loopBack} moved=${moved(r)}`) ?? 0) + 1);
  for (const [k, n] of [...t].sort()) console.log(`    ${k}: ${n}`);
  for (const r of ors.filter((x) => !moved(x) !== predictFlat(x)).slice(0, 6)) {
    console.log(`    MISS ${r.type.padEnd(16)} excl=${r.exclusive} loop=${r.loopBack}`
      + ` moved=${moved(r)} classes=[${r.classes}]`);
  }
}

// The review's first falsifier: re-test with LIVE producers only.
const liveOr = (r: Row) => r.liveEdges > r.liveIndices;
const uncapped = rows.filter((r) => r.classes[0]! < 50_000);
const law3 = uncapped.every((r) => moved(r) === liveOr(r));
console.log(`\n  law "moves iff some index has >1 LIVE producer": ${law3 ? 'HOLDS' : 'REFUTED'}`);
const survivors = uncapped.filter((r) => moved(r) !== liveOr(r));
console.log(`  exceptions: ${survivors.length} (was ${uncapped.filter((r) => moved(r) !== orLike(r)).length} on declared edges)`);
for (const r of survivors.slice(0, 8)) {
  console.log(`    ${r.type.padEnd(18)} declared idx=${r.indices}/edges=${r.inputs}`
    + ` live idx=${r.liveIndices}/edges=${r.liveEdges} moved=${moved(r)} classes=[${r.classes}]`);
}
if (!law) {
  for (const r of rows.filter((x) => moved(x) !== (x.inputs >= 2)).slice(0, 8)) {
    console.log(`    counterexample: ${r.type} inputs=${r.inputs} classes=[${r.classes}]`);
  }
}

console.log('\n--- FALSIFIER 2: where does it plateau? (budgets 1,2,4,8) ---');
for (const r of movers.slice(0, 12)) {
  const plateau = BUDGETS[r.classes.findIndex((c, i) => i > 0 && c === r.classes[r.classes.length - 1]!)] ?? '?';
  console.log(`  ${r.type.padEnd(22)} inputs=${r.inputs} classes=[${r.classes.join(', ')}] flat from k=${plateau}`);
}

console.log('\n--- the competing cost story: classes vs size, at budget 1 ---');
for (const bucket of [[0, 15], [15, 25], [25, 40], [40, 1e9]]) {
  const r = rows.filter((x) => x.places >= bucket[0]! && x.places < bucket[1]!);
  if (r.length === 0) continue;
  const cls = r.map((x) => x.classes[0]!).sort((a, b) => a - b);
  const inp = r.map((x) => x.inputs).sort((a, b) => a - b);
  console.log(`  ${bucket[0]}-${bucket[1] === 1e9 ? '∞' : bucket[1]} places: n=${r.length}`
    + ` classes med=${cls[cls.length >> 1]} max=${cls.at(-1)}  inputs med=${inp[inp.length >> 1]} max=${inp.at(-1)}`);
}
const byInputs = new Map<number, number[]>();
for (const r of rows) byInputs.set(r.inputs, [...(byInputs.get(r.inputs) ?? []), r.classes[0]!]);
console.log('  classes at budget 1, grouped by INPUT COUNT:');
for (const [n, cs] of [...byInputs].sort((a, b) => a[0] - b[0])) {
  const s = cs.sort((a, b) => a - b);
  console.log(`    inputs=${n}: n=${s.length} med=${s[s.length >> 1]} max=${s.at(-1)}`);
}
