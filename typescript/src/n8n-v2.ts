/**
 * The engine v2 entry point (`n8n-libpetri/n8n-v2`): the net-backed `SettlementPolicy` for
 * `@n8n/engine` with patches 0003 and 0004 applied (`tasks/v2-seam-plan.md` step 6), and what a
 * host needs to plug it in. Nothing here imports n8n: the host passes the engine's module to
 * {@link registerSettlementPolicy}, and the types it is checked against are the mirrors in
 * `n8n/v2-host.ts` and `n8n/v2-graph.ts`.
 */
export { registerSettlementPolicy, SETTLEMENT_MODES } from './settlement/register.js';
export type { RegisterOptions, SettlementMode } from './settlement/register.js';
export { createSettlementPolicy, decideFromRows, finishedFromRows } from './settlement/policy.js';
export type { SettlementDiagnostic, SettlementMethod, SettlementPolicyOptions } from './settlement/policy.js';
export { createShadowPolicy } from './settlement/shadow.js';
export type { ShadowOptions, ShadowReport } from './settlement/shadow.js';
export { canonicalJson, compileGraph, createCompileCache, graphKey, SettlementCompileRefusal } from './settlement/compile-cache.js';
export type { CompileCache, CompileCacheOptions, CompileCacheStats, CompiledGraph } from './settlement/compile-cache.js';
export { readSnapshot, SettlementSnapshotError } from './settlement/rows.js';
export type { Snapshot } from './settlement/rows.js';
export type {
  V2SettlementPolicy, V2SettlementReader, V2SettlementRegistry, V2StepKey, V2StepSummary, V2SuccessorDecisions,
} from './n8n/v2-host.js';
export type { V2Edge, V2Graph, V2Node, V2StepType } from './n8n/v2-graph.js';
