/**
 * The `NodeGadget` of a built subnet, once `compile` has composed it and canonical place objects
 * can be looked up by final name (MOD-010, MOD-020). Every local place is replaced by the
 * canonical one its recorded final name resolves to.
 */
import type { Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { InternalCompilerError } from '../errors.js';
import type {
  AgentGadget, AttemptGadget, EdgeSlot, InputGadgetCommon, NodeGadget, NodeGadgetCommon, OrInput, OutputGadgetCommon,
  ReadyInput, RetryGadget, RoutingGadget, SplitReadyInput,
} from '../types.js';
import type { AgentRoundNames } from './agent-round.js';
import type {
  GadgetContext, LocalAgent, LocalEdge, LocalInputCommon, LocalInputSide, LocalOrInput, LocalOutputCommon,
  LocalReadyInput, LocalRetry, LocalRouting, LocalSplitReadyInput,
} from './context.js';
import type { FailureChainPlaces } from './failure-chain.js';
import type { Markers, ReferencePorts } from './ports.js';
import type { SkipDecl } from './input-side.js';

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

/** The `materialise` of a built gadget: its `NodeGadget` over canonical places. */
export function materialiser(ctx: GadgetContext, parts: GadgetParts): (lookup: (finalName: string) => Place<unknown>) => NodeGadget {
  const { a, analysis, name, id, depth, cyclic, reachable, isStartNode, agents, finalNames } = ctx;
  const { markers, side, skip, routing, references, retry, chain, agent, names } = parts;
  const { running, idle, done, waiting, stopped } = markers;
  const { skipped, hostSkippedName } = skip;
  const { referenceNames, unguardedReferences } = references;
  const { attempts, chainTimeoutMs } = chain;
  const {
    startName, startUnmetNames, runName, routeNames, doneName, skipNames, armNames, clearNames, retryWaitName,
    exhaustedName, attemptRunNames, attemptStepNames, attemptTimeoutNames, sinkNames, doneRequestName, dispatchName,
    collectName, resumeName, roundsOutName, callsOutName,
  } = names;

  const materialise = (lookup: (finalName: string) => Place<unknown>): NodeGadget => {
    /** The canonical place of a local one, by the final name recorded when it was declared. */
    const fin = (p: Place<unknown>): Place<unknown> => {
      const finalName = finalNames.get(p);
      if (finalName === undefined) throw new InternalCompilerError(`internal: node '${name}' has no final name for local place '${p.name}'`);
      return lookup(finalName);
    };
    const finOpt = (p: Place<unknown> | null): Place<unknown> | null => (p === null ? null : fin(p));
    /** A host place `compile` created is already under its final name. */
    const slot = (e: LocalEdge): EdgeSlot => ({
      edge: e.edge,
      data: lookup(e.host.data.name),
      empty: e.host.empty === null ? null : lookup(e.host.empty.name),
    });
    const inputCommonOf = (i: LocalInputCommon): InputGadgetCommon => ({
      index: i.index, edges: i.edges.map(slot), wired: i.wired, required: i.required,
      emptyCapable: i.emptyCapable, seedEmpty: i.seedEmpty, unreachableEdges: i.unreachableEdges,
    });
    const readyInput = (i: LocalReadyInput): ReadyInput => ({
      ...inputCommonOf(i), slot: 'ready', free: fin(i.free), ready: fin(i.ready),
    });
    const splitReadyInput = (i: LocalSplitReadyInput): SplitReadyInput => ({
      ...inputCommonOf(i), slot: 'ready-split', free: fin(i.free), readyData: fin(i.readyData), readyEmpty: finOpt(i.readyEmpty),
    });
    const orInput = (i: LocalOrInput): OrInput => ({
      ...inputCommonOf(i), slot: 'or', ready: fin(i.ready), hasdata: fin(i.hasdata), ran: fin(i.ran), round: i.round,
    });
    const outputCommonOf = (o: LocalOutputCommon): OutputGadgetCommon => ({
      index: o.index,
      name: o.index === a.errorOutputIndex ? 'error' : (a.shape.outputNames?.[o.index] ?? null),
      isErrorOutput: o.index === a.errorOutputIndex,
      edges: o.edges.map(slot),
      nil: finOpt(o.nil),
    });
    const routingGadget: RoutingGadget = routing.kind === 'split'
      ? { kind: 'split', outputs: routing.outputs.map((o) => ({ ...outputCommonOf(o), routing: 'split', ok: fin(o.ok), routed: fin(o.routed) })) }
      : { kind: 'collapsed', routed: fin(routing.routed), outputs: routing.outputs.map((o) => ({ ...outputCommonOf(o), routing: 'collapsed' })) };
    const attemptGadgets = attempts.map((att): AttemptGadget => {
      const common = { index: att.index, running: fin(att.running), failed: fin(att.failed), timedOut: finOpt(att.timedOut) };
      switch (att.action) {
        case 'retry': return { ...common, action: 'retry', waitMs: att.waitMs, next: fin(att.next) };
        case 'route': return { ...common, action: 'route', outputIndex: att.outputIndex };
        case 'stop':
        case 'continue': return { ...common, action: att.action };
        default: return assertNever(att, 'attempt');
      }
    });
    const retryGadget: RetryGadget | null = retry === null ? null : {
      retry: fin(retry.retry), tries: fin(retry.tries), maxTries: retry.maxTries, waitBetweenTries: retry.waitBetweenTries,
    };
    const agentGadget: AgentGadget | null = agent === null ? null : {
      routedRequest: fin(agent.routedRequest), queue: fin(agent.queue), calls: fin(agent.calls), drained: fin(agent.drained),
      outstanding: fin(agent.outstanding), response: fin(agent.response), dispatched: fin(agent.dispatched), rounds: fin(agent.rounds),
      tools: agent.tools, maxRounds: agent.maxRounds, roundsAssumed: agent.roundsAssumed,
      maxToolCalls: agent.maxToolCalls, toolCallsAssumed: agent.toolCallsAssumed,
    };
    const common: NodeGadgetCommon = {
      node: name, id, type: a.node.type, typeVersion: a.node.typeVersion,
      disabled: a.node.disabled === true, loopNode: a.shape.loopNode === true,
      depth, cyclic, reachable, isStart: name === analysis.startNode, isStartNode,
      onError: a.onError, retry: retryGadget,
      running: fin(running), idle: fin(idle),
      routing: routingGadget, done: fin(done),
      skipped: skipped !== null ? fin(skipped) : hostSkippedName === null ? null : lookup(hostSkippedName),
      attempts: attemptGadgets,
      attemptTimeoutMs: chainTimeoutMs,
      waiting: fin(waiting), stopped: fin(stopped),
      agent: agentGadget,
      outputs: routingGadget.outputs,
      references: referenceNames, unguardedReferences,
      transitions: {
        start: startName, startUnmet: startUnmetNames, run: runName, routes: routeNames, done: doneName,
        skip: skipNames, arms: armNames, clear: clearNames,
        retryWait: retryWaitName,
        exhausted: exhaustedName,
        attemptRuns: attemptRunNames,
        attemptSteps: attemptStepNames,
        attemptTimeouts: attemptTimeoutNames,
        sinks: sinkNames,
        doneRequest: doneRequestName, dispatch: dispatchName, collect: collectName, resume: resumeName,
        roundsOut: roundsOutName, callsOut: callsOutName,
      },
    };
    switch (side.form) {
      case 'direct':
        return {
          ...common, form: 'direct',
          in: fin(side.in),
          inEmpty: finOpt(side.inEmpty),
          inputs: [],
        };
      case 'or':
        return { ...common, form: 'or', inputs: [orInput(side.input)] };
      case 'join':
        return { ...common, form: 'join', hasdata: fin(side.hasdata), inputs: side.inputs.map(readyInput) };
      case 'choose-branch':
        return {
          ...common, form: 'choose-branch',
          inputs: side.inputs.map((i) => (i.slot === 'ready' ? readyInput(i) : splitReadyInput(i))),
        };
      case 'tool': {
        if (agents === null) throw new InternalCompilerError(`internal: tool '${name}' has no agent`);
        return { ...common, form: 'tool', inTool: fin(side.inTool), agents, inputs: [] };
      }
      default: return assertNever(side, 'input side');
    }
  };
  return materialise;
}
