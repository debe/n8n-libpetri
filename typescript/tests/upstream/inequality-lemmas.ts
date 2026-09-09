/**
 * Root cause B, resolved — the proof needs linear *inequality* invariants.
 *
 * libpetri conjoins only equalities (`y·C = 0`) into the Horn rules. The depth-1 targets
 * need chained sub/super-invariants (`y·C ≤ 0` / `≥ 0`): "the start node holds at most one
 * token", and along every edge "the parent's emissions bound the child's tokens". This
 * script generates those from the workflow's edges, checks each by sign against every flat
 * incidence column (zero weight on consume-all places, constant `y·M0`), conjoins the ones
 * that pass into every rule body of libpetri's own encoding, and runs Spacer with and
 * without them — on a truly unreachable target and on a reachable control.
 *
 * Read z3's answer the way libpetri's runner does: `sat` = an inductive invariant exists =
 * proven; `unsat` = Error derivable = violated.
 */
import { flatten, IncidenceMatrix, computePInvariants, computePSemiflows, strengthenWithSemiflows, canonicalInvariantOrder, ignore, encode, resolveZ3, runZ3Text, unreachable } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { markingStateOf } from '../../src/verify/verify.js';
import { node, conn, workflow } from '../fixtures/workflows.js';
const depthNet = (d: number) => {
  const nodes = [node('T', 'trigger', [0, 0]), node('IF', 'if', [200, 0])];
  const conns = [conn('T', 0, 'IF', 0)];
  const chain = (prefix: string, out: number, y: number): [string, number] => {
    let prev: [string, number] = ['IF', out];
    for (let i = 0; i < d; i++) { const n = `${prefix}${i}`; nodes.push(node(n, 'set', [400 + 200 * i, y])); conns.push(conn(prev[0], prev[1], n, 0)); prev = [n, 0]; }
    return prev;
  };
  const [a, ao] = chain('A', 0, -100); const [b, bo] = chain('B', 1, 100);
  nodes.push(node('Merge', 'merge', [400 + 200 * d, 0]));
  conns.push(conn(a, ao, 'Merge', 0), conn(b, bo, 'Merge', 1));
  return workflow(`depth${d}`, nodes, conns, 'T');
};
const timeoutMs = Number(process.argv[2] ?? 60_000);
const solver = resolveZ3();
const TOKEN_ROLES = new Set(['in', 'in_empty', 'running', 'retry', 'routed', 'done', 'skipped', 'waiting', 'stopped']);
type Lemma = { label: string; w: number[]; sense: '<=' | '>='; c: number };
for (const d of [1, 2]) {
  const wf = depthNet(d);
  const c = compile(wf);
  const m0 = markingStateOf(c.initialMarking(null));
  const flat = flatten(c.net, new Set(), ignore());
  const matrix = IncidenceMatrix.from(flat);
  const inc = matrix.incidence();
  const names = flat.places.map((p) => p.name.replace(/^id:/, ''));
  const byName = (re: RegExp) => names.map((n, i) => (re.test(n) ? i : -1)).filter((i) => i >= 0);
  const sumOf = (n: string) => names.map((x, i) => (x.startsWith(n + '/') && TOKEN_ROLES.has(x.slice(n.length + 1)) ? i : -1)).filter((i) => i >= 0);
  const emitted = (n: string) => byName(new RegExp(`^${n}/(routed|done|skipped)$`));
  const arrival = (join: string, k: number) => byName(new RegExp(`^${join}/(in${k}_e\\d+(_empty)?|ready_${k})$`));
  const lemma = (label: string, sense: '<=' | '>=', plus: number[], minus: number[]): Lemma => {
    const w = new Array<number>(names.length).fill(0);
    for (const i of plus) w[i]! += 1; for (const i of minus) w[i]! -= 1;
    let k = 0; for (let i = 0; i < w.length; i++) k += w[i]! * m0.tokens(flat.places[i]!);
    return { label, w, sense, c: k };
  };
  // Structural rule: the start node holds at most one token; along every main edge the
  // parent's emissions bound the child's token sum (or, into a join arm, the arm's arrival + ready).
  const isJoin = (n: string) => names.some((x) => x === `${n}/ready_0`);
  const start = wf.startNode!;
  const candidates: Lemma[] = [lemma(`${start}-sum <= 1`, '<=', sumOf(start), [])];
  for (const e of wf.connections) {
    if (isJoin(e.to)) candidates.push(lemma(`emitted_${e.from} - arrival_${e.to}[${e.inputIndex}] >= 0`, '>=', emitted(e.from), arrival(e.to, e.inputIndex)));
    else candidates.push(lemma(`emitted_${e.from} - ${e.to}-sum >= 0`, '>=', emitted(e.from), sumOf(e.to)));
  }
  const valid: Lemma[] = [];
  for (const L of candidates) {
    const bad: string[] = [];
    for (let t = 0; t < inc.length; t++) { let dot = 0; for (let p = 0; p < names.length; p++) dot += L.w[p]! * inc[t]![p]!; if ((L.sense === '<=' && dot > 0) || (L.sense === '>=' && dot < 0)) bad.push(`${flat.transitions[t]!.name}(${dot})`); }
    if (bad.length === 0) valid.push(L); else console.log(`  FAIL ${L.label}: ${bad.slice(0, 5).join(', ')}`);
  }
  console.log(`depth=${d}: ${valid.length}/${candidates.length} structural inequality lemmas pass the sign check`);
  const invariants = canonicalInvariantOrder(strengthenWithSemiflows(computePInvariants(matrix, flat, m0), computePSemiflows(matrix, flat, m0)).invariants);
  const p = (n: string) => c.netMap.place(n)!.place;
  const anchor = ')\n      (Reachable m0p m1p';
  const conj = valid.map((L) => `(${L.sense} (+ ${L.w.map((w, i) => (w === 0 ? null : `(* ${w} m${i}p)`)).filter(Boolean).join(' ')}) ${L.c})`).join(' ');
  const targets: [string, string[]][] = [
    ['{ready_0, ready_1, _halt}  (the cliff; truly unreachable)', ['id:Merge/ready_0', 'id:Merge/ready_1', '_halt']],
    ['{ready_0, ready_1}  (control; reachable)', ['id:Merge/ready_0', 'id:Merge/ready_1']],
  ];
  await Promise.all(targets.flatMap(([label, tgt]) => [false, true].map(async (withLemmas) => {
    const enc = encode(flat, m0, unreachable(new Set(tgt.map(p))), invariants, new Set(), false);
    const script = withLemmas ? enc.smt2.split(anchor).join(` ${conj})\n      (Reachable m0p m1p`) : enc.smt2;
    const t0 = performance.now();
    const reply = await runZ3Text(solver, script, 'ineq2', timeoutMs, ['fp.engine=spacer']);
    const lines = reply.stdout.trim().split('\n');
    const verdict = lines.find((l) => /^(sat|unsat|unknown)$/.test(l.trim())) ?? lines[0] ?? '';
    console.log(`  ${verdict.padEnd(8)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s  depth ${d} ${withLemmas ? 'WITH lemmas   ' : 'without lemmas'} ${label}`);
  })));
}
console.log('(z3 on this HORN encoding: sat = an inductive invariant exists = PROVEN; unsat = Error derivable = VIOLATED)');
