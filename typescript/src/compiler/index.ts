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
export { assertProfile, CompileError, InternalCompilerError, ProfileMismatchError } from './errors.js';
export type { CompileErrorCode } from './errors.js';
export { NetMap } from './net-map.js';
export type { RoutingMode, RoutingPolicy } from './actions.js';
// test-facing: the suites pin these facts of the model directly; no other layer reads them.
export { kSafety } from './compile.js';
export { isAllRequired, joinFormOf, requiredInputsOf, retryParamsOf } from './graph.js';
export { SPLIT_ROUTING_ABOVE } from './gadget.js';
// Engine v2's batch step (`tasks/v2-profile-plan.md` decision 5), shared with the stage-1 input.
export {
  BATCH_OUTPUT_NAMES, DONE_SLOT, isV2BatchNode, LOOP_SLOT, MAX_SLOT_INDEX, SPLIT_IN_BATCHES_TYPE,
  SPLIT_IN_BATCHES_TYPE_VERSION,
} from './analysis/engine-v2/batch.js';
export { isV2UnexecutableStep, V2_STEP_NODE_TYPES } from './analysis/engine-v2/steps.js';
export { DEFAULT_BATCH_SIZE, MERGE_TYPE } from './analysis/engine-v2/nodes.js';
// The engineV2 port of n8n's converter (`tasks/v2-profile-plan.md` step 13): its trigger rule and
// the map of every n8n refusal to its code.
export { isV2TriggerType, V2_TRIGGER_NODE_TYPES } from './analysis/engine-v2/root.js';
export { V2_REFUSALS, v2RefusalOf } from './analysis/engine-v2/refusals.js';
export type { V2Refusal, V2RefusalFile, V2RefusalSite } from './analysis/engine-v2/refusals.js';
export { placeholderActions, forwardAllActions, routingActions } from './actions.js';
export { settlementActions, settlementPlaceholderActions } from './actions/settlement.js';
export type { SettlementPolicy } from './actions/settlement.js';
export type {
  ActionBinder, BatchDescription, BudgetRestriction, CompileOptions, CompileProfile, CompiledWorkflow, EdgeRef, EdgeSlot,
  InputGadget, JoinForm, JoinReadyPlaces, MainConnection, NetMapView, NodeDescription, NodeGadget,
  AttemptGadget, NodeTypeShape, OnError, OutputGadget,
  PlaceInfo, PlaceRole,
  SharedPlaces, StrayConnections, ToolConnection, TransitionInfo, TransitionRole, UnmetReferencePayload, Variant,
  WorkflowDescription,
  // Analysis vocabulary (moved from graph.ts; the names are unchanged).
  AnalysedNode, FailureChain, MultiProducerInput, ReferenceKind, ResolvedReference, ResolvedStep,
  ResolvedRetryStep, ResolvedRouteStep, ResolvedStepCommon, ResolvedTerminalStep, RetryParams, WorkflowAnalysis,
  EngineV2Analysis, V2EdgeClass, V2Loop,
  // The engineV2 settlement gadget (`tasks/v2-profile-plan.md` decision 14).
  SettlementBatch, SettlementEdge, SettlementFailure, SettlementGadget, SettlementOutput, SettlementTransitions,
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
