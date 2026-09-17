/**
 * Are the compiled nets free-choice — and would removing `_budget` make them so?
 *
 * This is the question the whole net→workflow-net challenge turns on. Blondin, Mazowiecki and
 * Offtermatt (CAV 2022) prove that for **free-choice** workflow nets, 1-, generalised,
 * structural and continuous soundness all coincide, which is what would make k-independence a
 * theorem rather than a measurement. Outside free-choice the result degrades to necessary
 * conditions only, and the challenge is worth much less.
 *
 * A net is free-choice when any two transitions sharing an input place share their **whole**
 * preset: `•t1 ∩ •t2 ≠ ∅  ⟹  •t1 = •t2`.
 *
 * `_budget` is known to break it — every `X_start` consumes it with a different preset. The
 * question this settles is whether it is the *only* thing breaking it, because if so ADR 0010
 * buys the property, and if not the challenge should be re-scoped before anyone writes code.
 *
 * ## Answered 2026-09-16: no, and the reason is structural
 *
 * Violations as-is / ignoring `_budget` / ignoring all three shared places:
 *
 * | fixture | as-is | no `_budget` | no shared |
 * |---|---:|---:|---:|
 * | `linear` | 6 | 0 | 0 |
 * | `fanOut` | 6 | 0 | 0 |
 * | `ifHalf` | 3 | 0 | 0 |
 * | `diamond` | 19 | **4** | 4 |
 * | `agentOneTool` | 24 | **9** | 9 |
 *
 * On 60 corpus templates with all three shared places ignored — the best case, ADR 0010 already
 * done — **16 are free-choice and 44 are not**. The places that break it, by local name:
 * `ready` in 134 workflows, `free` in 87, `idle` in 46, `retry` in 29, `queue` / `dispatched` /
 * `drained` in 19 each.
 *
 * `ready` and `free` are the join gadget's slot places (ADR 0003): an arm and a skip consume the
 * same slot with different presets. That is not a refactorable accident. Free-choice forbids a
 * place that arbitrates between structurally different alternatives, and **a join arbitrates** —
 * as does an `idle` with both a `start` and a `resume`. A workflow language with joins, retries
 * and agents cannot have a free-choice image, and a version that could would not be able to
 * express those three things.
 *
 * So the 16 are not a beachhead. They are free-choice *because* they have no joins, no retries
 * and no agents — the property and the triviality have the same cause, and growing the fragment
 * means adding back exactly what breaks it. The CAV 2022 payoff (generalised soundness, i.e.
 * k-independence as a theorem) is therefore **anti-correlated with need**: free on the nets that
 * already verify in milliseconds, worth nothing on every net that motivated the question.
 *
 * That killed the net→workflow-net transformation before it was written. This file is kept as
 * the answer, because the next reader of the CAV result will have the same idea.
 *
 * What survives: the paper's **necessary conditions** hold on any net, free-choice or not, and
 * do not depend on the transformation at all. Integer unboundedness is a polynomial LP
 * (`∃x ≥ 0 : Σ x[t]·Δ(t) > 0`); it *may* be the Farkas dual of libpetri's VER-019 ranking
 * condition, which would make it free — **unverified**, the dual has not been written out.
 *
 *   npx tsx tasks/spike-free-choice.mts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { flatten } from '../typescript/node_modules/libpetri/dist/verification/index.js';
import { compile } from '../typescript/src/compiler/index.js';
import * as F from '../typescript/tests/fixtures/workflows.js';
import { describeWorkflowJson, parseNodeTypesFile } from '../typescript/src/verify/workflow-json.js';

/** The preset of a transition, as place names, optionally ignoring some shared places. */
function preset(t: any, ignore: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const spec of t.source.inputSpecs ?? []) {
    const name = spec.place?.name;
    if (typeof name === 'string' && !ignore.has(name)) out.add(name);
  }
  return out;
}

const eq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Free-choice violations: pairs sharing an input place but not their whole preset. */
function violations(net: any, ignore: ReadonlySet<string>) {
  const flat: any = flatten(net);
  const pres = flat.transitions.map((t: any) => ({ name: t.name, pre: preset(t, ignore) }));
  const byPlace = new Map<string, number[]>();
  pres.forEach((p: any, i: number) => {
    for (const place of p.pre) byPlace.set(place, [...(byPlace.get(place) ?? []), i]);
  });
  const found: { place: string; a: string; b: string }[] = [];
  const culprits = new Map<string, number>();
  for (const [place, idx] of byPlace) {
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        const a = pres[idx[x]!]!; const b = pres[idx[y]!]!;
        if (eq(a.pre, b.pre)) continue;
        found.push({ place, a: a.name, b: b.name });
        culprits.set(place, (culprits.get(place) ?? 0) + 1);
      }
    }
  }
  return { found, culprits, transitions: flat.transitions.length };
}

const SHARED = new Set(['_budget', '_halt', '_pause']);

console.log('=== fixtures: free-choice with and without the shared places ===\n');
for (const [name, wf] of [['linear', F.linear], ['diamond', F.diamond], ['fanOut', F.fanOut],
  ['ifHalf', F.ifHalf], ['agentOneTool', F.agentOneTool]] as any[]) {
  const c: any = compile(wf, { budget: 1, maxAgentToolCalls: 4 } as any);
  const all = violations(c.net, new Set());
  const noBudget = violations(c.net, new Set(['_budget']));
  const noShared = violations(c.net, SHARED);
  console.log(`${name.padEnd(14)} t=${String(all.transitions).padStart(3)}  `
    + `violations: as-is ${String(all.found.length).padStart(4)} | no _budget ${String(noBudget.found.length).padStart(4)}`
    + ` | no shared ${String(noShared.found.length).padStart(4)}`);
  const top = [...noShared.culprits].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length > 0) {
    console.log(`               still broken by: ${top.map(([p, n]) => `${p.split('/').pop()} x${n}`).join(', ')}`);
    const ex = noShared.found[0]!;
    console.log(`               e.g. ${ex.a} vs ${ex.b} share ${ex.place}`);
  }
}

console.log('\n=== the 200-template corpus, shared places ignored (the ADR 0010 world) ===');
const DIR = new URL('../.templates/', import.meta.url).pathname;
const nodeTypes = parseNodeTypesFile(JSON.parse(readFileSync(new URL('../.node-types/catalogue.json', import.meta.url).pathname, 'utf8')));
let clean = 0; let dirty = 0; let failed = 0;
const culpritRoles = new Map<string, number>();
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json')).sort().slice(0, Number(process.env.LIMIT ?? 60))) {
  try {
    const { description } = describeWorkflowJson(JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')), { nodeTypes });
    const c: any = compile(description, { budget: 1 } as any);
    const v = violations(c.net, SHARED);
    if (v.found.length === 0) clean++; else {
      dirty++;
      for (const [p] of v.culprits) {
        const role = p.includes('/') ? p.split('/').pop()!.replace(/_\d+$/, '') : p;
        culpritRoles.set(role, (culpritRoles.get(role) ?? 0) + 1);
      }
    }
  } catch { failed++; }
}
console.log(`  free-choice even without the shared places: ${clean}`);
console.log(`  still not free-choice:                      ${dirty}`);
console.log(`  did not compile:                            ${failed}`);
console.log(`  places breaking it, by local name:`);
for (const [r, n] of [...culpritRoles].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    ${r.padEnd(16)} in ${n} workflows`);
}
