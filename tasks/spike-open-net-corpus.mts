/**
 * A `verifyOpenNet` (VER-022) cost corpus, built from real n8n workflows.
 *
 * libpetri asked for one: as of 2026-09-16 no test there varies token count, budget or
 * concurrency and reports cost, so VER-022 has no scaling evidence. This sweeps every node
 * gadget of every template it is pointed at, verifies each one **alone** against a generic
 * admission contract, and prints cost against gadget size and against the budget the
 * environment lends it.
 *
 * The contract is deliberately generic and is *not* right for every shape — a node that can
 * skip writes its output edge zero times, and an agent needs `environment(...)` to model a
 * tool replying. Those come back `violated`; that is a fact about this contract, not about
 * the gadget, and the interesting column here is **cost**, not verdict.
 *
 * `verifyOpenNet` (VER-022) shipped in libpetri 6.0.0, which is the floor, so this runs against
 * an ordinary install. It needed the linked working tree when it was written.
 *
 * *Corrected 2026-09-16.* An earlier reading of this sweep reported that cost "tracks port
 * count, not budget and not node type". The port half was confounded: in this sample the
 * high-port gadgets are also the high-arity ones, and the expensive 23-port / 50-place merge is
 * the **arity-9** gadget. Grouped properly, class count at budget 1 is monotonic in arrival
 * count (1 → med 12, 2 → 119, 3 → 973, 4 → 1 842, 6 → 6 409) and *non*-monotonic in size (the
 * 15-25 place bucket has a lower median than the 0-15 one). libpetri's own curve puts it
 * beyond doubt: 30 classes flat from 1 to 25 outgoing edges, 11 places to 59. **Ports are
 * free; arrivals are not.** See `spike-gadget-arity.mts` for the cross-tabulation.
 *
 *   npx tsx tasks/spike-open-net-corpus.mts            # the default template sample
 *   LIMIT=40 BUDGETS=1,2,4,8 npx tsx tasks/spike-open-net-corpus.mts
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
const CAT = new URL('../.node-types/catalogue.json', import.meta.url).pathname;
const LIMIT = Number(process.env.LIMIT ?? 25);
const BUDGETS = (process.env.BUDGETS ?? '1,4').split(',').map(Number);

const nodeTypes = parseNodeTypesFile(JSON.parse(readFileSync(CAT, 'utf8')));

interface Row {
  template: string; node: string; type: string; budget: number;
  places: number; transitions: number; ports: number;
  verdict: string; route: string; classes: number; complete: boolean; ms: number;
}

/** One node's gadget, instantiated alone with its ports left open. */
function gadgetOf(wf: any, node: any, budget: number) {
  const analysis = analyse(wf);
  const full = composeNet(wf, analysis);
  const fullMap = mapNet(full.structural as any, full.shared as any, full.builds as any);
  // The gadget prefix is the node's **id** (MOD-010), not its name: a real export's ids are
  // arbitrary, so keying on the name only ever worked for the hand-written fixtures.
  const build: any = full.builds.find((b: any) => b.prefix === node.id);
  if (build === undefined) throw new Error(`no gadget for ${node.name} (${node.id})`);
  const structural = PetriNet.builder(`gadget:${node.name}`)
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

/** The generic admission contract: one arrival per input edge, everything returned at rest. */
function contractFor(g: ReturnType<typeof gadgetOf>) {
  const { build, byName, roles, seed, prefix } = g;
  const host = (port: string) => byName.get(build.ports.get(port).name);
  const local = (s: string) => byName.get(`${prefix}/${s}`);
  const withRole = (set: ReadonlySet<any>, minus?: ReadonlySet<any>) =>
    [...roles].filter(([, r]) => set.has(r) && !(minus?.has(r) ?? false)).map(([n]) => byName.get(n));

  const inputs = new Map<string, string[]>();
  const outputs = new Map<string, string[]>();
  for (const [port] of build.ports) {
    if (port === 'budget' || port === 'halt' || port === 'pause') continue;
    const base = port.replace(/_empty$/, '');
    (base.startsWith('out') ? outputs : inputs).set(base, [...((base.startsWith('out') ? outputs : inputs).get(base) ?? []), port]);
  }
  const inputPlaces = new Set([...inputs.values()].flat().map((p) => build.ports.get(p).name));

  const b: any = OpenNetContract.builder().initialMarking((m: any) => {
    for (const [name, n] of seed) if (!inputPlaces.has(name)) m.tokens(byName.get(name), n);
  });
  for (const ports of inputs.values()) b.arrive(1, ...ports.map(host));
  if (local('idle') !== undefined) b.expect('idle returned', 1, local('idle'));
  b.expect('budget returned', seed.get('_budget') ?? 0, byName.get('_budget'));
  b.rest(...withRole(REST_ROLES));
  if (byName.get('_halt') !== undefined) b.terminal(byName.get('_halt'), ...withRole(HALT_REST_ROLES, REST_ROLES));
  if (byName.get('_pause') !== undefined) b.terminal(byName.get('_pause'), ...withRole(PAUSE_REST_ROLES, REST_ROLES));
  return b.requireTermination(true).build();
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().slice(0, LIMIT);
const rows: Row[] = [];

for (const f of files) {
  let description: any;
  try {
    description = describeWorkflowJson(JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')), { nodeTypes }).description;
  } catch { continue; }
  for (const node of description.nodes) {
    for (const budget of BUDGETS) {
      try {
        const g = gadgetOf(description, node, budget);
        const flat = flatten(g.net as any);
        const t0 = performance.now();
        const r: any = await verifyOpenNet(g.net as any, contractFor(g), { maxClasses: 50_000, smt: true });
        rows.push({
          template: f, node: node.name, type: String(node.type).replace('n8n-nodes-base.', ''), budget,
          places: flat.places.length, transitions: flat.transitions.length, ports: g.build.ports.size,
          verdict: r.verdict.type, route: r.route, classes: r.classCount, complete: r.graphComplete,
          ms: Math.round(performance.now() - t0),
        });
      } catch (e) { if (process.env.DEBUG) console.log('  skip', node.name, (e as Error).message.slice(0,150)); }
    }
  }
}

console.log(`gadgets verified: ${rows.length} from ${files.length} templates, budgets ${BUDGETS.join('/')}\n`);

console.log('--- cost against BUDGET (the question VER-022 has no answer for) ---');
for (const budget of BUDGETS) {
  const r = rows.filter((x) => x.budget === budget);
  if (r.length === 0) continue;
  const cls = r.map((x) => x.classes).sort((a, b) => a - b);
  const ms = r.map((x) => x.ms).sort((a, b) => a - b);
  console.log(`  budget ${budget}: n=${r.length} classes med=${cls[cls.length >> 1]} max=${cls.at(-1)}`
    + `  ms med=${ms[ms.length >> 1]} max=${ms.at(-1)}  complete=${r.filter((x) => x.complete).length}/${r.length}`);
}

console.log('\n--- identical gadget, budget 1 vs the rest (k-independence, per gadget) ---');
const byKey = new Map<string, Row[]>();
for (const r of rows) byKey.set(`${r.template}|${r.node}`, [...(byKey.get(`${r.template}|${r.node}`) ?? []), r]);
let same = 0, moved = 0;
for (const group of byKey.values()) {
  if (group.length < 2) continue;
  const c = new Set(group.map((g) => g.classes));
  if (c.size === 1) same++; else moved++;
}
console.log(`  gadgets whose class count is IDENTICAL across budgets: ${same}`);
console.log(`  gadgets whose class count MOVED with the budget:       ${moved}`);

console.log('\n--- VERDICT DISTRIBUTION (budget 1): does the generic contract actually hold? ---');
const b1v = rows.filter((x) => x.budget === BUDGETS[0]);
const byVerdict = new Map<string, number>();
for (const r of b1v) byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1);
for (const [v, c] of [...byVerdict].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.padEnd(10)} ${String(c).padStart(4)}  ${((100*c)/b1v.length).toFixed(1)}%`);
}
const provenTypes = new Map<string, [number, number]>();
for (const r of b1v) {
  const e = provenTypes.get(r.type) ?? [0, 0];
  provenTypes.set(r.type, [e[0] + (r.verdict === 'proven' ? 1 : 0), e[1] + 1]);
}
console.log('  by node type (proven/total), most common first:');
for (const [t, [p, n2]] of [...provenTypes].sort((a, b) => b[1][1] - a[1][1]).slice(0, 10)) {
  console.log(`    ${t.padEnd(26)} ${String(p).padStart(3)}/${String(n2).padStart(3)}`);
}

console.log('\n--- cost against gadget SIZE (budget 1) ---');
const b1 = rows.filter((x) => x.budget === BUDGETS[0]).sort((a, b) => a.places - b.places);
for (const bucket of [[0, 15], [15, 25], [25, 40], [40, 1e9]]) {
  const r = b1.filter((x) => x.places >= bucket[0]! && x.places < bucket[1]!);
  if (r.length === 0) continue;
  const cls = r.map((x) => x.classes).sort((a, b) => a - b);
  const ms = r.map((x) => x.ms).sort((a, b) => a - b);
  console.log(`  ${bucket[0]}-${bucket[1] === 1e9 ? '∞' : bucket[1]} places: n=${r.length}`
    + ` classes med=${cls[cls.length >> 1]} max=${cls.at(-1)} ms med=${ms[ms.length >> 1]} max=${ms.at(-1)}`);
}

console.log('\n--- the ten largest gadgets by class count (budget 1) ---');
for (const r of [...b1].sort((a, b) => b.classes - a.classes).slice(0, 10)) {
  console.log(`  ${r.type.padEnd(22)} ${String(r.places).padStart(3)}p/${String(r.transitions).padStart(3)}t`
    + ` ports=${String(r.ports).padStart(2)} classes=${String(r.classes).padStart(6)} ${String(r.ms).padStart(5)}ms`
    + ` ${r.verdict}/${r.route}${r.complete ? '' : ' TRUNCATED'}`);
}
