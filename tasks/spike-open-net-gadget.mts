/**
 * ADR 0010 spike 3: verify ONE node gadget in isolation against an admission contract.
 *
 * The gadget is taken from the real compiled workflow, instantiated on its own with its
 * ports left open, and checked against a contract: one arrival per input, and at every
 * quiescence the gadget is idle, the budget is back, it completed exactly once, and each
 * outgoing edge carries exactly one of data / empty.
 */
import { PetriNet } from '/Users/db/repositories/n8n-libpetri/typescript/node_modules/libpetri/dist/index.js';
import { flatten, OpenNetContract, verifyOpenNet }
  from '/Users/db/repositories/n8n-libpetri/typescript/node_modules/libpetri/dist/verification/index.js';
import { analyse } from '/Users/db/repositories/n8n-libpetri/typescript/src/compiler/graph.js';
import { compile } from '/Users/db/repositories/n8n-libpetri/typescript/src/compiler/compile.js';
import { composeNet } from '/Users/db/repositories/n8n-libpetri/typescript/src/compiler/compile/compose.js';
import { mapNet } from '/Users/db/repositories/n8n-libpetri/typescript/src/compiler/compile/mapping.js';
import { bindActions } from '/Users/db/repositories/n8n-libpetri/typescript/src/compiler/compile/bind.js';
import { placeholderActions } from '/Users/db/repositories/n8n-libpetri/typescript/src/compiler/actions.js';
import { REST_ROLES, PAUSE_REST_ROLES, HALT_REST_ROLES }
  from '/Users/db/repositories/n8n-libpetri/typescript/src/verify/state-space/roles.js';
import * as F from '/Users/db/repositories/n8n-libpetri/typescript/tests/fixtures/workflows.js';
import { generateFanOut } from '/Users/db/repositories/n8n-libpetri/typescript/tests/verify/support.js';

function gadgetOf(wf: any, nodeName: string, budget: number) {
  const analysis = analyse(wf);
  const full = composeNet(wf, analysis);
  const fullMap = mapNet(full.structural as any, full.shared as any, full.builds as any);
  const build: any = full.builds.find((x: any) => x.prefix === `id:${nodeName}`);
  if (build === undefined) throw new Error(`no gadget for ${nodeName}`);
  const structural = PetriNet.builder(`gadget:${nodeName}`)
    .compose(build.def.instantiate(build.prefix), new Map(build.ports))
    .build();
  const fallback = placeholderActions();
  const net = bindActions(structural as any, fullMap as any, (i: any, m: any) => fallback(i, m));
  const byName = new Map<string, any>();
  for (const p of flatten(net as any).places) byName.set((p as any).name, p);
  // The gadget's own starting resources, taken from the compiler rather than hand-rolled:
  // a join begins holding its slot tokens (ADR 0003) and an agent its round / call budgets.
  const compiled: any = compile(wf, { budget, maxAgentToolCalls: 4 } as any);
  const seed = new Map<string, number>();
  for (const [pl, toks] of compiled.initialMarking(null)) {
    if (byName.has((pl as any).name)) seed.set((pl as any).name, (toks as any[]).length);
  }
  const roles = new Map<string, string>();
  for (const pi of (fullMap as any).places) {
    if (byName.has(pi.place.name)) roles.set(pi.place.name, pi.role);
  }
  return { build, net, byName, seed, roles };
}

/** Input ports grouped by input index; output ports paired data/empty. */
function portGroups(build: any) {
  const inputs = new Map<string, string[]>();
  const outputs = new Map<string, string[]>();
  for (const [port] of build.ports) {
    if (port === 'budget' || port === 'halt' || port === 'pause') continue;
    const base = port.replace(/_empty$/, '');
    const bucket = base.startsWith('out') ? outputs : inputs;
    bucket.set(base, [...(bucket.get(base) ?? []), port]);
  }
  return { inputs, outputs };
}

async function run(label: string, wf: any, nodeName: string, budget: number) {
  const { build, net, byName, seed, roles } = gadgetOf(wf, nodeName, budget);
  const withRole = (set: ReadonlySet<any>, minus?: ReadonlySet<any>) =>
    [...roles].filter(([, r]) => set.has(r) && !(minus?.has(r) ?? false)).map(([n]) => byName.get(n));
  const host = (port: string) => byName.get(build.ports.get(port).name);
  const local = (suffix: string) => byName.get(`id:${nodeName}/${suffix}`);
  const someLocal = (...s: string[]) => s.map(local).filter((p: any) => p !== undefined);

  const { inputs, outputs } = portGroups(build);
  const inputPortNames = new Set([...inputs.values()].flat().map((p) => build.ports.get(p).name));
  const b: any = OpenNetContract.builder()
    .initialMarking((m: any) => {
      for (const [name, n] of seed) {
        // An arrival is the contract's business, not the initial marking's.
        if (!inputPortNames.has(name)) m.tokens(byName.get(name), n);
      }
    });

  for (const ports of inputs.values()) b.arrive(1, ...ports.map(host));
  b.expect('idle returned', 1, local('idle'));
  b.expect('budget returned', budget, byName.get('_budget'));
  b.expect('completed exactly once', 1, ...someLocal('done', 'skipped'));
  for (const [base, ports] of outputs) b.expect(`edge ${base} written exactly once`, 1, ...ports.map(host));
  // The rest set and the two widenings, exactly as `completionSinksOf` declares them for the
  // whole net (ADR 0005, VER-014) — the point of the spike is that the same vocabulary works
  // per gadget without change.
  b.rest(...withRole(REST_ROLES));
  b.terminal(byName.get('_halt'), ...withRole(HALT_REST_ROLES, REST_ROLES));
  b.terminal(byName.get('_pause'), ...withRole(PAUSE_REST_ROLES, REST_ROLES));
  b.requireTermination(true);

  const t0 = performance.now();
  const r: any = await verifyOpenNet(net as any, b.build(), { maxClasses: 50_000, smt: true });
  const ms = Math.round(performance.now() - t0);
  const flat = flatten(net as any);
  console.log(`\n=== ${label}  budget=${budget} ===`);
  console.log(`  subnet ${flat.places.length}p/${flat.transitions.length}t, ports ${build.ports.size}`);
  console.log(`  ${String(r.verdict.type).toUpperCase()}  route=${r.route} classes=${r.classCount} `
    + `complete=${r.graphComplete}  ${ms}ms`);
  for (const v of (r.violations ?? []).slice(0, 5)) {
    const nm = v.place?.name ?? '';
    console.log(`  violation: ${v.kind ?? '?'} ${nm}${nm ? ` [role ${roles.get(nm) ?? '?'}]` : ''} `
      + `${String(v.detail ?? v.message ?? '').slice(0, 130)}`);
  }
}

for (const budget of [1, 4]) {
  await run('fanOut8 / W0  (leaf set node)', generateFanOut(8), 'W0', budget);
  await run('diamond / Merge  (two-input join)', F.diamond, 'Merge', budget);
  await run('agentTwoTools / Agent', F.agentTwoTools, 'Agent', budget);
}
