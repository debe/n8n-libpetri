/**
 * The `NodeGadget` of a built subnet, once `compile` has composed it and canonical place objects
 * can be looked up by final name (MOD-010, MOD-020). Every local place is replaced by the
 * canonical one its recorded final name resolves to (`canonical.ts`); the input side and the
 * other parts are converted by `canonical-inputs.ts` and `canonical-parts.ts`.
 */
import type { Place } from 'libpetri';
import type { NodeGadget, NodeGadgetCommon, NodeGadgetTransitions } from '../types.js';
import type { AgentRoundNames } from './agent-round.js';
import { canonOf } from './canonical.js';
import { formFieldsOf } from './canonical-inputs.js';
import { agentGadgetOf, attemptGadgetsOf, retryGadgetOf, routingGadgetOf, skippedMarkerOf } from './canonical-parts.js';
import type { GadgetContext } from './context.js';
import type { FailureChainPlaces } from './failure-chain.js';
import type { SkipDecl } from './input-side.js';
import type { LocalAgent, LocalInputSide, LocalRetry, LocalRouting } from './local-shapes.js';
import type { Markers, ReferencePorts } from './ports.js';

/** The flat-net name of every transition the gadget declared, by the field it fills. */
export interface GadgetTransitionNames extends AgentRoundNames {
  readonly startName: string;
  readonly startUnmetNames: readonly string[];
  readonly runName: string;
  readonly attemptRunNames: readonly string[];
  readonly routeNames: readonly string[];
  readonly doneName: string;
  readonly skipNames: readonly string[];
  readonly armNames: readonly string[];
  readonly clearNames: readonly string[];
  readonly retryWaitName: string | null;
  readonly exhaustedName: string | null;
  readonly attemptStepNames: readonly string[];
  readonly attemptTimeoutNames: readonly string[];
  readonly sinkNames: readonly string[];
}

/** Every local part of a built gadget `materialise` reports. */
export interface GadgetParts {
  readonly markers: Markers;
  readonly side: LocalInputSide;
  readonly skip: SkipDecl;
  readonly routing: LocalRouting;
  readonly references: ReferencePorts;
  readonly retry: LocalRetry | null;
  readonly chain: FailureChainPlaces;
  readonly agent: LocalAgent | null;
  readonly names: GadgetTransitionNames;
}

/** The gadget's transitions, each name under the field it fills. */
function transitionsOf(names: GadgetTransitionNames): NodeGadgetTransitions {
  return {
    start: names.startName, startUnmet: names.startUnmetNames, run: names.runName, routes: names.routeNames,
    done: names.doneName, skip: names.skipNames, arms: names.armNames, clear: names.clearNames,
    retryWait: names.retryWaitName,
    exhausted: names.exhaustedName,
    attemptRuns: names.attemptRunNames,
    attemptSteps: names.attemptStepNames,
    attemptTimeouts: names.attemptTimeoutNames,
    sinks: names.sinkNames,
    doneRequest: names.doneRequestName, dispatch: names.dispatchName, collect: names.collectName, resume: names.resumeName,
    roundsOut: names.roundsOutName, callsOut: names.callsOutName,
  };
}

/** The `materialise` of a built gadget: its `NodeGadget` over canonical places. */
export function materialiser(ctx: GadgetContext, parts: GadgetParts): (lookup: (finalName: string) => Place<unknown>) => NodeGadget {
  const { a, analysis, name, id, depth, cyclic, reachable, isStartNode, skipForwards, agents, finalNames } = ctx;
  const { markers, side, skip, routing, references, retry, chain, agent, names } = parts;
  const { running, idle, done, waiting, stopped } = markers;
  const { referenceNames, unguardedReferences } = references;
  const { attempts, chainTimeoutMs } = chain;

  const materialise = (lookup: (finalName: string) => Place<unknown>): NodeGadget => {
    const c = canonOf(name, finalNames, lookup);
    const { fin } = c;
    const routingGadget = routingGadgetOf(c, a, routing);
    const attemptGadgets = attemptGadgetsOf(c, attempts);
    const retryGadget = retryGadgetOf(c, retry);
    const agentGadget = agentGadgetOf(c, agent);
    const common: NodeGadgetCommon = {
      node: name, id, type: a.node.type, typeVersion: a.node.typeVersion,
      disabled: a.node.disabled === true, loopNode: a.shape.loopNode === true,
      depth, cyclic, reachable, isStart: name === analysis.startNode, isStartNode,
      onError: a.onError, retry: retryGadget,
      running: fin(running), idle: fin(idle),
      routing: routingGadget, done: fin(done),
      skipped: skippedMarkerOf(c, skip),
      skipForwards,
      attempts: attemptGadgets,
      attemptTimeoutMs: chainTimeoutMs,
      waiting: fin(waiting), stopped: fin(stopped),
      agent: agentGadget,
      outputs: routingGadget.outputs,
      references: referenceNames, unguardedReferences,
      transitions: transitionsOf(names),
    };
    return { ...common, ...formFieldsOf(c, side, name, agents) };
  };
  return materialise;
}
