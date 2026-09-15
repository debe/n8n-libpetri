/**
 * The parts of a materialised gadget over the canonical places: its `skipped` marker, routing
 * and outputs, `onFailure` attempts, `retryOnFail` places and agent round places.
 */
import type { Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import type { AgentGadget, AnalysedNode, AttemptGadget, OutputGadgetCommon, RetryGadget, RoutingGadget } from '../types.js';
import type { Canon } from './canonical.js';
import type { SkipDecl } from './input-side.js';
import type { LocalAgent, LocalAttempt, LocalOutputCommon, LocalRetry, LocalRouting } from './local-shapes.js';

/** The `X/skipped` marker: the node's own, or the host-level one of a referenced node without a skip. */
export function skippedMarkerOf(c: Canon, skip: SkipDecl): Place<unknown> | null {
  if (skip.skipped !== null) return c.fin(skip.skipped);
  return skip.hostSkippedName === null ? null : c.lookup(skip.hostSkippedName);
}

function outputCommonOf(c: Canon, a: AnalysedNode, o: LocalOutputCommon): OutputGadgetCommon {
  return {
    index: o.index,
    name: o.index === a.errorOutputIndex ? 'error' : (a.shape.outputNames?.[o.index] ?? null),
    isErrorOutput: o.index === a.errorOutputIndex,
    edges: o.edges.map(c.slot),
    nil: c.finOpt(o.nil),
  };
}

/** The routing shape and its outputs. */
export function routingGadgetOf(c: Canon, a: AnalysedNode, routing: LocalRouting): RoutingGadget {
  return routing.kind === 'split'
    ? { kind: 'split', outputs: routing.outputs.map((o) => ({ ...outputCommonOf(c, a, o), routing: 'split', ok: c.fin(o.ok), routed: c.fin(o.routed) })) }
    : { kind: 'collapsed', routed: c.fin(routing.routed), outputs: routing.outputs.map((o) => ({ ...outputCommonOf(c, a, o), routing: 'collapsed' })) };
}

/** The attempts of an `onFailure` chain, ascending. */
export function attemptGadgetsOf(c: Canon, attempts: readonly LocalAttempt[]): AttemptGadget[] {
  return attempts.map((att): AttemptGadget => {
    const common = { index: att.index, running: c.fin(att.running), failed: c.fin(att.failed), timedOut: c.finOpt(att.timedOut) };
    switch (att.action) {
      case 'retry': return { ...common, action: 'retry', waitMs: att.waitMs, next: c.fin(att.next) };
      case 'route': return { ...common, action: 'route', outputIndex: att.outputIndex };
      case 'stop':
      case 'continue': return { ...common, action: att.action };
      default: return assertNever(att, 'attempt');
    }
  });
}

/** The `retryOnFail` places; `null` without them. */
export function retryGadgetOf(c: Canon, retry: LocalRetry | null): RetryGadget | null {
  return retry === null ? null : {
    retry: c.fin(retry.retry), tries: c.fin(retry.tries), maxTries: retry.maxTries, waitBetweenTries: retry.waitBetweenTries,
  };
}

/** The agent round places; `null` unless the node is an agent. */
export function agentGadgetOf(c: Canon, agent: LocalAgent | null): AgentGadget | null {
  const { fin } = c;
  return agent === null ? null : {
    routedRequest: fin(agent.routedRequest), queue: fin(agent.queue), calls: fin(agent.calls), drained: fin(agent.drained),
    outstanding: fin(agent.outstanding), response: fin(agent.response), dispatched: fin(agent.dispatched), rounds: fin(agent.rounds),
    tools: agent.tools, maxRounds: agent.maxRounds, roundsAssumed: agent.roundsAssumed,
    maxToolCalls: agent.maxToolCalls, toolCallsAssumed: agent.toolCallsAssumed,
  };
}
