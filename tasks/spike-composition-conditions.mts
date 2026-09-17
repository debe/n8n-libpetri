/**
 * How much of the real corpus would a composition theorem cover, and where does the derived
 * arrival count diverge from the bound the compiler declares?
 *
 * The theorem (ADR 0010 follow-up) is a flow-conservation argument over the workflow DAG:
 * every activation of a producer writes exactly one token on each outgoing tree edge (ADR 0002's
 * emission rule), so a consumer's arrival count on input `i` is the SUM of its producers'
 * activation counts — not the number of edges into it. This measures both halves:
 *
 *  1. the graph conditions the induction needs (acyclic, every join input has a producer, ...)
 *  2. **derived arrivals vs the declared OR round**, which is the gap the measured false
 *     `violated` came from (`docs/verification.md`, "That caveat has teeth")
 *
 *   npx tsx tasks/spike-composition-conditions.mts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { analyse } from '../typescript/src/compiler/graph.js';
import { describeWorkflowJson, parseNodeTypesFile } from '../typescript/src/verify/workflow-json.js';

const DIR = new URL('../.templates/', import.meta.url).pathname;
const CAT = new URL('../.node-types/catalogue.json', import.meta.url).pathname;
const nodeTypes = parseNodeTypesFile(JSON.parse(readFileSync(CAT, 'utf8')));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .slice(0, Number(process.env.LIMIT ?? 1e9));

interface Verdict {
  file: string; nodes: number;
  acyclic: boolean; agents: boolean;
  joinWithoutProducer: number;
  multiProducerInputs: number;
  /** OR inputs where the derived arrival count exceeds the round the gadget declares. */
  orOverflow: string[];
  covered: boolean;
}

const out: Verdict[] = [];

for (const f of files) {
  let a: any;
  try {
    const { description } = describeWorkflowJson(JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')), { nodeTypes });
    a = analyse(description);
  } catch { continue; }

  // Activations per node, by flow conservation over the DAG. Only meaningful when acyclic;
  // on a cyclic workflow the fixpoint does not terminate without a declared loop bound, which
  // is precisely why the theorem excludes cycles.
  const activations = new Map<string, number>();
  const order = [...a.nodes].sort((x: any, y: any) =>
    (a.depth.get(x.node.name) ?? 0) - (a.depth.get(y.node.name) ?? 0));
  for (const n of order) {
    const name = n.node.name;
    if (a.startNodeSet.has(name)) { activations.set(name, 1); continue; }
    const incoming: any[] = [...(a.incoming.get(name) ?? [])];
    if (incoming.length === 0) { activations.set(name, 0); continue; }
    const perInput = new Map<number, number>();
    for (const e of incoming) {
      // Each activation of the producer writes one token on this edge (ADR 0002).
      const d = activations.get(e.from) ?? 0;
      perInput.set(e.inputIndex, (perInput.get(e.inputIndex) ?? 0) + d);
    }
    // A join fires once per complete tuple; everything else fires once per arrival.
    const counts = [...perInput.values()];
    activations.set(name, n.allRequired && counts.length > 1 ? Math.min(...counts) : Math.max(...counts));
    (n as any)._arrivals = perInput;
  }

  const orOverflow: string[] = [];
  let joinWithoutProducer = 0;
  for (const n of a.nodes) {
    const name = n.node.name;
    const arrivals: Map<number, number> | undefined = (n as any)._arrivals;
    const incoming: any[] = [...(a.incoming.get(name) ?? [])];
    for (let i = 0; i < (n.shape.inputCount ?? 1); i++) {
      const producers = incoming.filter((e) => e.inputIndex === i).length;
      if (producers === 0 && n.shape.inputCount > 1 && a.reachable.has(name)) joinWithoutProducer++;
      if (producers <= 1) continue;
      // The gadget's OR round is the number of edges that can carry an `empty`; the arrivals
      // the graph actually delivers is the sum of the producers' activation counts.
      const round = producers;
      const got = arrivals?.get(i) ?? 0;
      if (got > round) orOverflow.push(`${name}[${i}] round=${round} arrivals=${got}`);
    }
  }

  const v: Verdict = {
    file: f, nodes: a.nodes.length,
    acyclic: !a.hasCycle, agents: a.hasAgents,
    joinWithoutProducer,
    multiProducerInputs: a.multiProducerInputs.length,
    orOverflow,
    covered: !a.hasCycle && !a.hasAgents && joinWithoutProducer === 0,
  };
  out.push(v);
}

const n = out.length;
const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
console.log(`templates analysed: ${n}\n`);
console.log('--- graph conditions the induction needs ---');
console.log(`  acyclic:                       ${out.filter((v) => v.acyclic).length}  ${pct(out.filter((v) => v.acyclic).length)}`);
console.log(`  no agents (ADR 0008 group):    ${out.filter((v) => !v.agents).length}  ${pct(out.filter((v) => !v.agents).length)}`);
console.log(`  every join input has a producer:${out.filter((v) => v.joinWithoutProducer === 0).length}  ${pct(out.filter((v) => v.joinWithoutProducer === 0).length)}`);
console.log(`  ALL THREE (theorem applies):   ${out.filter((v) => v.covered).length}  ${pct(out.filter((v) => v.covered).length)}`);

const overflow = out.filter((v) => v.orOverflow.length > 0);
console.log('\n--- derived arrivals vs the declared OR round ---');
console.log(`  templates with at least one overflow: ${overflow.length}  ${pct(overflow.length)}`);
console.log(`  total overflowing inputs:             ${overflow.reduce((s, v) => s + v.orOverflow.length, 0)}`);
console.log(`  of the acyclic ones:                  ${overflow.filter((v) => v.acyclic).length}`);
for (const v of overflow.slice(0, 12)) {
  console.log(`   ${v.file.padEnd(14)} ${v.orOverflow.slice(0, 2).join(' | ')}`);
}

console.log('\n--- what excludes the rest ---');
const why = new Map<string, number>();
for (const v of out) {
  if (v.covered) continue;
  const reasons = [!v.acyclic ? 'cyclic' : null, v.agents ? 'agents' : null,
    v.joinWithoutProducer > 0 ? 'join without producer' : null].filter(Boolean).join(' + ');
  why.set(reasons, (why.get(reasons) ?? 0) + 1);
}
for (const [k, c] of [...why].sort((x, y) => y[1] - x[1])) console.log(`  ${String(c).padStart(3)}  ${k}`);
