/**
 * n8n workflow → one libpetri `PetriNet` per execution.
 *
 * Takes a structural description of the workflow (nodes, main connections, the start node,
 * a node-type resolver yielding inputs / outputs / requiredInputs, and an optional
 * `$('X')` reference resolver) and produces a `CompiledWorkflow`: the net, its memoised
 * `PrecompiledNet` program, a stable structural hash and a `NetMap` (transition ↔ node,
 * place ↔ (node, port)). No n8n runtime dependency; the adapter from `n8n-workflow`'s
 * `Workflow` object is milestone M2's job (see `types.ts`).
 *
 * Milestone M1, track A. The emission rule, per-node gadget, join gadget, retry gadget,
 * halt + reap, expression read arcs, unreachable-input seeding and the k-safety check are
 * specified in README.md ("The model") and ADRs 0002–0004.
 */
export { compile, kSafety } from './compile.js';
export {
  analyse, isAllRequired, joinFormOf, requiredInputsOf, retryParamsOf,
  DEFAULT_MAX_TRIES, DEFAULT_WAIT_BETWEEN_TRIES_MS, MIN_MAX_TRIES, MAX_MAX_TRIES, MAX_WAIT_BETWEEN_TRIES_MS,
} from './graph.js';
export { SPLIT_ROUTING_ABOVE } from './gadget.js';
export type {
  AnalysedNode, MultiProducerInput, ReferenceKind, ResolvedReference, RetryParams, WorkflowAnalysis,
} from './graph.js';
export { structuralHash } from './hash.js';
export { NetMap } from './net-map.js';
export { placeholderActions, forwardAllActions, routingActions, structuralActions } from './actions.js';
export type { RoutingMode, RoutingPolicy } from './actions.js';
export type {
  ActionBinder, BudgetRestriction, CompileOptions, CompiledWorkflow, EdgeKind, EdgeRef, EdgeSlot,
  ExpressionReferences, InputGadget, JoinForm, JoinReadyPlaces, MainConnection, NetMapView, NodeDescription, NodeGadget,
  NodeGadgetTransitions, NodeTypeResolver, NodeTypeShape, OnError, OutputGadget, PlaceInfo, PlaceRole,
  SharedPlaces, TransitionInfo, TransitionRole, UnmetReferencePayload, Variant, WorkflowDescription,
} from './types.js';
