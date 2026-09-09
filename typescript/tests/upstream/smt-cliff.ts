/**
 * Root cause B — IC3/PDR (Spacer) stops proving the n8n gadget at one pipeline stage before
 * a join.
 *
 * The target `unreachable{Merge/ready_0, Merge/ready_1, _halt}` is genuinely unreachable in
 * every net below (a halt consumes what feeds the arms), so the right answer is `proven`.
 * Depth 0 — the join fed straight from the router — proves in 0.1 s. One `set` node on each
 * branch and Spacer answers `unknown` at 60 s and at 300 s.
 *
 * Ruled out by experiment before concluding: the join's `all()` arc (the choose-branch form,
 * with none, fails the same way); the invariant set (the failing net is handed every node's
 * `idle + running = 1`, the two-phase `_budget + Σ(routed + running) = 1` and both slot laws);
 * the semiflow enumeration's 8192-row backstop (`diamond` returns 9); interleaving (on the
 * join-free net `A/done ∧ B/done` is *found* in 14 s). Witnesses are found wherever they exist;
 * proofs of unreachability do not converge. The proof needs an ordering argument — "both slots
 * armed ⇒ every node upstream has run and the join has not started" — that no conservation
 * law over counts states.
 */
import { SmtVerifier, unreachable } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { markingStateOf } from '../../src/verify/verify.js';
import { node, conn, workflow } from '../fixtures/workflows.js';

const depthNet = (d: number) => {
  const nodes = [node('T', 'trigger', [0, 0]), node('IF', 'if', [200, 0])];
  const conns = [conn('T', 0, 'IF', 0)];
  const chain = (prefix: string, out: number, y: number): [string, number] => {
    let prev: [string, number] = ['IF', out];
    for (let i = 0; i < d; i++) {
      const n = `${prefix}${i}`;
      nodes.push(node(n, 'set', [400 + 200 * i, y]));
      conns.push(conn(prev[0], prev[1], n, 0));
      prev = [n, 0];
    }
    return prev;
  };
  const [a, ao] = chain('A', 0, -100);
  const [b, bo] = chain('B', 1, 100);
  nodes.push(node('Merge', 'merge', [400 + 200 * d, 0]));
  conns.push(conn(a, ao, 'Merge', 0), conn(b, bo, 'Merge', 1));
  return workflow(`depth${d}`, nodes, conns, 'T');
};

const timeoutMs = Number(process.argv[2] ?? 60_000);
for (const d of [0, 1, 2]) {
  const c = compile(depthNet(d));
  const p = (n: string) => c.netMap.place(n)!.place;
  const t0 = performance.now();
  const r = await SmtVerifier.forNet(c.net).initialMarking(markingStateOf(c.initialMarking(null)))
    .property(unreachable(new Set([p('id:Merge/ready_0'), p('id:Merge/ready_1'), p('_halt')])))
    .semiflowInvariants(true).timeout(timeoutMs).verify();
  console.log(`depth=${d}: places=${[...c.net.places].length} transitions=${[...c.net.transitions].length}  ${r.verdict.type.padEnd(8)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s  invariants=${r.invariants.length}`);
}
