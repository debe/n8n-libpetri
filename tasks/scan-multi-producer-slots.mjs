import { readFileSync, readdirSync } from 'node:fs';
const root = process.argv[2];
const files = [...readdirSync(root + '/.templates').filter(f => f.endsWith('.json')).map(f => root + '/.templates/' + f),
  ...readdirSync(root + '/scripts/testbed/workflows').map(f => root + '/scripts/testbed/workflows/' + f)];
let wfWithShape = 0, slots = 0, ordered = 0, concurrent = 0, sameSourceErrFallback = 0, wfOrdered = 0, wfConc = 0;
for (const f of files) {
  const w = JSON.parse(readFileSync(f, 'utf8'));
  const disabled = new Set((w.nodes ?? []).filter(n => n.disabled).map(n => n.name));
  const edges = [];
  for (const [src, byType] of Object.entries(w.connections ?? {})) {
    if (disabled.has(src)) continue;
    for (const [oi, list] of (byType.main ?? []).entries()) for (const c of list ?? []) if (!disabled.has(c.node)) edges.push({ src, oi, dst: c.node, ii: c.index ?? 0 });
  }
  const succ = new Map(); for (const e of edges) { if (!succ.has(e.src)) succ.set(e.src, new Set()); succ.get(e.src).add(e.dst); }
  const reach = (a, b) => { const seen = new Set([a]); const st = [a]; while (st.length) { const x = st.pop(); for (const y of succ.get(x) ?? []) { if (y === b) return true; if (!seen.has(y)) { seen.add(y); st.push(y); } } } return false; };
  const byDst = new Map(); for (const e of edges) { if (!byDst.has(e.dst)) byDst.set(e.dst, []); byDst.get(e.dst).push(e); }
  let hasO = false, hasC = false;
  for (const [dst, es] of byDst) {
    const inputs = new Set(es.map(e => e.ii)); if (inputs.size < 2) continue;
    for (const ii of inputs) {
      const p = es.filter(e => e.ii === ii); if (p.length < 2) continue;
      slots++;
      // causally ordered: every pair has same source or one source reaches the other
      let ok = true;
      for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
        const a = p[i].src, b = p[j].src;
        if (!(a === b || reach(a, b) || reach(b, a))) ok = false;
      }
      if (ok) { ordered++; hasO = true; } else { concurrent++; hasC = true; }
      // success + error-fallback pattern: some producer X feeds slot directly and X's other output reaches another producer
      for (const e1 of p) for (const e2 of p) if (e1 !== e2 && e1.src !== e2.src && edges.some(e => e.src === e1.src && e.oi !== e1.oi && (e.dst === e2.src || reach(e.dst, e2.src)))) { sameSourceErrFallback++; break; }
    }
  }
  if (hasO || hasC) wfWithShape++; if (hasO) wfOrdered++; if (hasC) wfConc++;
}
console.log({ workflows: files.length, wfWithShape, wfOrdered, wfConc, slots, ordered, concurrent, slotsWithOtherOutputFeedingCoProducer: sameSourceErrFallback });
