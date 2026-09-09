/**
 * Root cause A — `deadlockFree(sinks)` could not excuse a designed terminal; resolved upstream
 * by `SmtVerifier.sinkPlacesWhen(marker, ...places)` (VER-014).
 *
 * Every n8n node can halt or pause, so a halt while a sibling's arrival is still pending is a
 * *real* reachable quiescent marking with a non-rest token. With plain `sinkPlaces` the solver
 * finds it, confirms it by replay, and is right about the question as asked — a designed
 * terminal reported as a stranding. The graph route decides the same question by widening the
 * rest set under a terminal marker (`PAUSE_REST_ROLES`, `HALT_REST_ROLES`); `sinkPlacesWhen`
 * is that widening as a property. With it the question is right; proving it on the agent net
 * still needs the ordering laws only the marking equation states (VER-016,
 * `stateEquation(true)`). This script runs all three forms so each step is visible.
 */
import { SmtVerifier, deadlockFree } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { markingStateOf } from '../../src/verify/verify.js';
import { REST_ROLES, PAUSE_REST_ROLES, HALT_REST_ROLES } from '../../src/verify/state-class.js';
import type { PlaceRole } from '../../src/compiler/types.js';
import { fanOut, agentTwoTools } from '../fixtures/workflows.js';

const timeoutMs = Number(process.argv[2] ?? 120_000);
for (const [label, wf] of [['fanOut', fanOut], ['agentTwoTools (maxToolCalls 64)', { ...agentTwoTools, nodes: agentTwoTools.nodes.map((n) => (n.name === 'Agent' ? { ...n, maxToolCalls: 64 } : n)) }]] as const) {
  const c = compile(wf);
  const byRoles = (roles: ReadonlySet<PlaceRole>) => c.netMap.places.filter((p) => roles.has(p.role)).map((p) => p.place);
  const sinks = byRoles(REST_ROLES);
  const marker = (role: PlaceRole) => c.netMap.places.find((p) => p.role === role)!.place;
  const widened = (roles: ReadonlySet<PlaceRole>) => c.netMap.places.filter((p) => roles.has(p.role) && !REST_ROLES.has(p.role)).map((p) => p.place);
  for (const form of ['sinkPlaces only', 'sinkPlaces + sinkPlacesWhen(pause|halt)', 'sinkPlaces + sinkPlacesWhen(pause|halt) + stateEquation'] as const) {
    let v = SmtVerifier.forNet(c.net).initialMarking(markingStateOf(c.initialMarking(null)))
      .property(deadlockFree()).sinkPlaces(...sinks).semiflowInvariants(true).timeout(timeoutMs);
    if (form !== 'sinkPlaces only') v = v.sinkPlacesWhen(marker('pause'), ...widened(PAUSE_REST_ROLES)).sinkPlacesWhen(marker('halt'), ...widened(HALT_REST_ROLES));
    if (form.endsWith('stateEquation')) v = v.stateEquation(true);
    const t0 = performance.now();
    const r = await v.verify();
    const last = r.counterexampleTrace.at(-1);
    const marked = last === undefined ? [] : c.netMap.places.filter((p) => (last.tokens(p.place) ?? 0) > 0);
    const terminal = marked.some((p) => p.role === 'pause' || p.role === 'halt');
    console.log(`${label} — ${form}: ${r.verdict.type} in ${((performance.now() - t0) / 1000).toFixed(1)}s${r.verdict.type === 'violated' ? `, replay confirmed=${r.counterexampleConfirmed}, witness is a designed terminal: ${terminal}` : r.verdict.type === 'unknown' ? ` (${(r.verdict as { reason?: string }).reason ?? ''})` : ''}`);
    if (r.verdict.type === 'violated') console.log(`  trace: ${r.counterexampleTransitions.join(' → ')}`);
  }
}
