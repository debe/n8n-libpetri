/**
 * Root cause B, isolated — which true-unreachable targets Spacer proves on the depth-1 net.
 *
 * Halt-flavoured targets and the one-branch-only variant prove in well under a second; what
 * stays `unknown` is any target whose proof needs a chain of position facts, the smallest
 * being `{ready_0, T/running}` — two places, no halt. See `inequality-lemmas.ts` for the
 * lemmas that close them.
 */
import { SmtVerifier, unreachable } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { markingStateOf } from '../../src/verify/verify.js';
import { node, conn, workflow } from '../fixtures/workflows.js';
const depthNet = (dA: number, dB: number) => {
  const nodes = [node('T', 'trigger', [0, 0]), node('IF', 'if', [200, 0])];
  const conns = [conn('T', 0, 'IF', 0)];
  const chain = (prefix: string, out: number, y: number, d: number): [string, number] => {
    let prev: [string, number] = ['IF', out];
    for (let i = 0; i < d; i++) { const n = `${prefix}${i}`; nodes.push(node(n, 'set', [400 + 200 * i, y])); conns.push(conn(prev[0], prev[1], n, 0)); prev = [n, 0]; }
    return prev;
  };
  const [a, ao] = chain('A', 0, -100, dA); const [b, bo] = chain('B', 1, 100, dB);
  nodes.push(node('Merge', 'merge', [400 + 200 * Math.max(dA, dB), 0]));
  conns.push(conn(a, ao, 'Merge', 0), conn(b, bo, 'Merge', 1));
  return workflow(`depth${dA}${dB}`, nodes, conns, 'T');
};
const timeoutMs = Number(process.argv[2] ?? 60_000);
const cases: [string, [number, number], string[]][] = [
  ['depth 1|1  {ready_0, ready_1, _halt}   (the cliff)', [1, 1], ['id:Merge/ready_0', 'id:Merge/ready_1', '_halt']],
  ['depth 1|0  {ready_0, ready_1, _halt}   (node on one branch only)', [1, 0], ['id:Merge/ready_0', 'id:Merge/ready_1', '_halt']],
  ['depth 1|1  {ready_0, ready_1, Merge/running}   (ordering, no halt)', [1, 1], ['id:Merge/ready_0', 'id:Merge/ready_1', 'id:Merge/running']],
  ['depth 1|1  {ready_0, T/running}   (ordering, no halt, one arm)', [1, 1], ['id:Merge/ready_0', 'id:T/running']],
  ['depth 1|1  {A0/running, _halt}   (halt stops starts)', [1, 1], ['id:A0/running', '_halt']],
  ['depth 1|1  {Merge/running, _halt}', [1, 1], ['id:Merge/running', '_halt']],
  ['depth 1|1  {T/running, _halt}', [1, 1], ['id:T/running', '_halt']],
  ['depth 1|1  {ready_0, _halt, B0/running}', [1, 1], ['id:Merge/ready_0', '_halt', 'id:B0/running']],
];
const pool = 4; let i = 0;
await Promise.all(Array.from({ length: pool }, async () => {
  while (i < cases.length) {
    const [label, [dA, dB], target] = cases[i++]!;
    const c = compile(depthNet(dA, dB));
    const p = (n: string) => { const pl = c.netMap.place(n); if (!pl) throw new Error('no place ' + n); return pl.place; };
    const t0 = performance.now();
    const r = await SmtVerifier.forNet(c.net).initialMarking(markingStateOf(c.initialMarking(null)))
      .property(unreachable(new Set(target.map(p)))).semiflowInvariants(true).timeout(timeoutMs).verify();
    console.log(`${r.verdict.type.padEnd(9)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${label}${r.verdict.type === 'violated' ? '  confirmed=' + r.counterexampleConfirmed + '  ' + r.counterexampleTransitions.join(' → ') : ''}`);
  }
}));
