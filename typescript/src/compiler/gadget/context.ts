/**
 * The state one `buildNodeGadget` call shares across its phases: the node's derived facts
 * (`facts.ts`) and the builder state with the recorders every phase declares through
 * (`builder.ts`) — `port` (MOD-020), `internal` (MOD-010), `hostOwned`, `tinfo` and `emit`. Also the
 * vocabulary the phases share: the local (pre-composition) shapes of the gadget's parts
 * (`local-shapes.ts`) and the two `Out` combinators IO-011 / IO-012 need collapsed (`out-spec.ts`).
 */
import type { Place } from 'libpetri';
import type { AnalysedNode, EdgeSlot, SharedPlaces, WorkflowAnalysis } from '../types.js';
import { createGadgetBuilder, type GadgetBuilder } from './builder.js';
import { deriveGadgetFacts, type GadgetFacts } from './facts.js';

export type { PortDecl, ReferencePort, ToolPort, TransitionBody } from './builder.js';
export type {
  LocalAgent, LocalAttempt, LocalAttemptCommon, LocalCollapsedOutput, LocalEdge, LocalInputCommon, LocalInputSide,
  LocalJoinInput, LocalOrInput, LocalOutput, LocalOutputCommon, LocalReadyInput, LocalRetry, LocalRouting,
  LocalSplitOutput, LocalSplitReadyInput,
} from './local-shapes.js';
export { andOf, xorOf } from './out-spec.js';

/** One node's gadget under construction: its derived facts, the builder state and the recorders. */
export interface GadgetContext extends GadgetFacts, GadgetBuilder {}

/** The node's derived facts and an empty builder, with the recorders closed over it. */
export function createGadgetContext(
  a: AnalysedNode,
  analysis: WorkflowAnalysis,
  edgeSlots: ReadonlyMap<number, EdgeSlot>,
  syntheticIn: Place<unknown> | null,
  host: SharedPlaces,
): GadgetContext {
  const facts = deriveGadgetFacts(a, analysis, edgeSlots, syntheticIn, host);
  return { ...facts, ...createGadgetBuilder(facts.id, facts.name) };
}
