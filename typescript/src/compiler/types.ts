/**
 * Structural input and compiled output of the n8n → libpetri compiler.
 *
 * The compiler never sees n8n. It takes a {@link WorkflowDescription} — nodes, main
 * connections, the start node, a node-type resolver and an optional expression-reference
 * resolver — and produces one flat libpetri `PetriNet` per workflow (MOD-023) together with
 * the maps the scheduler, the marking codec and the verifier need.
 *
 * Building a `WorkflowDescription` from an `n8n-workflow` `Workflow` object is milestone
 * M2's adapter: `INode` JSON supplies {@link NodeDescription}, `NodeHelpers.getNodeInputs`
 * / `getNodeOutputs` (evaluated against the node's parameters) supply {@link NodeTypeShape},
 * `connectionsBySourceNode[*].main` supplies {@link MainConnection}, and
 * `node-reference-parser-utils` supplies {@link ExpressionReferences}. The shapes below are
 * what that adapter must produce; nothing here imports n8n.
 *
 * The declarations live in `types/`, split by audience — `input.ts` (the description),
 * `analysis.ts` (what `analyse()` derives), `netmap.ts` (transition and place roles) and
 * `output.ts` (gadgets, `CompiledWorkflow`, binders and `CompileOptions`). This module
 * re-exports all of them, so every importer keeps one path.
 */
export type * from './types/input.js';
export type * from './types/analysis.js';
export type * from './types/netmap.js';
export type * from './types/output.js';
