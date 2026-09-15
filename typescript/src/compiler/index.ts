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
export { compile, readyPlacesOf, readySlot } from './compile.js';
export { analyse, reachableFrom, DEFAULT_MAX_AGENT_ROUNDS, DEFAULT_MAX_AGENT_TOOL_CALLS } from './graph.js';
export type { AnalysisOptions } from './graph.js';
export { parseExecutionPolicy, mergePolicies, PolicyError, POLICY_SCHEMA_VERSION } from './policy.js';
export type { ExecutionPolicy, FailureAction, FailureStep, PolicyParse } from './policy.js';
export { structuralHash } from './hash.js';
export { CompileError, InternalCompilerError } from './errors.js';
export type { CompileErrorCode } from './errors.js';
export { NetMap } from './net-map.js';
export type { RoutingMode, RoutingPolicy } from './actions.js';
// test-facing: the suites pin these facts of the model directly; no other layer reads them.
export { kSafety } from './compile.js';
export { isAllRequired, joinFormOf, requiredInputsOf, retryParamsOf } from './graph.js';
export { SPLIT_ROUTING_ABOVE } from './gadget.js';
export { placeholderActions, forwardAllActions, routingActions } from './actions.js';
export type {
  ActionBinder, BudgetRestriction, CompileOptions, CompiledWorkflow, EdgeRef, EdgeSlot,
  InputGadget, JoinForm, JoinReadyPlaces, MainConnection, NetMapView, NodeDescription, NodeGadget,
  AttemptGadget, NodeTypeShape, OnError, OutputGadget,
  PlaceInfo, PlaceRole,
  SharedPlaces, ToolConnection, TransitionInfo, TransitionRole, UnmetReferencePayload, Variant,
  WorkflowDescription,
  // Analysis vocabulary (moved from graph.ts; the names are unchanged).
  AnalysedNode, FailureChain, MultiProducerInput, ReferenceKind, ResolvedReference, ResolvedStep,
  ResolvedRetryStep, ResolvedRouteStep, ResolvedStepCommon, ResolvedTerminalStep, RetryParams, WorkflowAnalysis,
  // Gadget union members.
  NodeGadgetCommon, DirectGadget, OrGadget, JoinGadget, ChooseBranchGadget, ToolGadget, SlottedGadget,
  RetryGadget, AgentGadget, RoutingGadget,
  InputGadgetCommon, InputSlot, OrSlot, ReadySlot, SplitReadySlot, OrInput, ReadyInput, SplitReadyInput,
  OutputGadgetCommon, CollapsedOutput, SplitOutput,
  AttemptGadgetCommon, RetryAttempt, RouteAttempt, TerminalAttempt,
  // Transition union members.
  TransitionInfoCommon, TransitionInfoOf, StartTransition, StartUnmetTransition, RunTransition, RouteTransition,
  DoneTransition, SkipTransition, ArmTransition, ClearTransition, RetryTransition, ExhaustedTransition,
  SinkTransition, AttemptTransition, DeadlineTransition, DoneRequestTransition, DispatchTransition,
  CollectTransition, ResumeTransition, RoundsOutTransition, CallsOutTransition,
} from './types.js';
