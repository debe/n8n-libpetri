/**
 * Structural workflow fixtures for the compiler suite. Each is a `WorkflowDescription`
 * (no n8n dependency) with canvas positions chosen so the expected declaration order is
 * unambiguous, plus the hand-derived facts the tests assert against.
 *
 * Node ids are derived from names (`id:<name>`); they must not contain `/` (MOD-010).
 */
import type {
  MainConnection, NodeDescription, NodeTypeShape, ToolConnection, WorkflowDescription,
} from '../../src/compiler/index.js';

export const SHAPES = {
  trigger: { inputCount: 0, outputCount: 1 },
  set: { inputCount: 1, outputCount: 1 },
  if: { inputCount: 1, outputCount: 2, outputNames: ['true', 'false'] },
  switch20: { inputCount: 1, outputCount: 20 },
  merge: { inputCount: 2, outputCount: 1 },
  mergeChoose: { inputCount: 2, outputCount: 1, requiredInputs: [0, 1] },
  loop: { inputCount: 1, outputCount: 2, loopNode: true, outputNames: ['loop', 'done'] },
  /** A three-output router: at `SPLIT_ROUTING_ABOVE`, so it still routes inside `X_run`. */
  switch3: { inputCount: 1, outputCount: 3 },
  /** A four-output router: above `SPLIT_ROUTING_ABOVE`, so it routes per output. */
  switch4: { inputCount: 1, outputCount: 4 },
  /** Merge v3 chooseBranch with `numberInputs: 3`: `requiredInputs` stays `[0, 1]`. */
  merge3Choose: { inputCount: 3, outputCount: 1, requiredInputs: [0, 1] },
  /**
   * An AI Agent: one `main` in, one `main` out. Its `ai_tool` inputs are connections, not
   * shape — `NodeHelpers.getNodeInputs` is filtered to `main` before the compiler sees it,
   * exactly as the adapter filters it.
   */
  agent: { inputCount: 1, outputCount: 1 },
  /** A tool node: no `main` port at either end; it is reached only over `ai_tool`. */
  tool: { inputCount: 0, outputCount: 0 },
} as const satisfies Record<string, NodeTypeShape>;

export type ShapeName = keyof typeof SHAPES;

export function idOf(name: string): string {
  return `id:${name.replace(/\//g, '_')}`;
}

export function node(
  name: string,
  type: ShapeName,
  position: readonly [number, number],
  extra: Partial<Omit<NodeDescription, 'id' | 'name' | 'type' | 'position'>> = {},
): NodeDescription {
  return { id: idOf(name), name, type, typeVersion: 1, position, ...extra };
}

export function conn(from: string, outputIndex: number, to: string, inputIndex: number): MainConnection {
  return { from, outputIndex, to, inputIndex };
}

/** An `ai_tool` connection, named the way n8n wires it: from the tool, into the agent. */
export function tool(toolNode: string, agent: string): ToolConnection {
  return { agent, tool: toolNode };
}

export interface FixtureOptions {
  readonly references?: Readonly<Record<string, readonly string[]>>;
  readonly shapes?: Readonly<Record<string, NodeTypeShape>>;
  readonly toolConnections?: readonly ToolConnection[];
}

export function workflow(
  name: string,
  nodes: readonly NodeDescription[],
  connections: readonly MainConnection[],
  startNode: string,
  options: FixtureOptions = {},
): WorkflowDescription {
  return {
    name,
    nodes,
    connections,
    toolConnections: options.toolConnections,
    startNode,
    nodeTypes: (n) => options.shapes?.[n.name] ?? SHAPES[n.type as ShapeName],
    expressionReferences: options.references === undefined
      ? undefined
      : (n) => options.references?.[n.name] ?? [],
  };
}

// ==================== The fixtures ====================

/** Trigger → A → B → C. */
export const linear = workflow('linear', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
  node('B', 'set', [400, 0]),
  node('C', 'set', [600, 0]),
], [
  conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0), conn('B', 0, 'C', 0),
], 'Trigger');

/**
 * Trigger fans out to three siblings. Declared out of canvas order on purpose: expected
 * canvas order is A (y 0), Trigger (y 100, x 0), B (y 100, x 200), C (y 200).
 */
export const fanOut = workflow('fan-out', [
  node('C', 'set', [200, 200]),
  node('A', 'set', [200, 0]),
  node('Trigger', 'trigger', [0, 100]),
  node('B', 'set', [200, 100]),
], [
  conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0), conn('Trigger', 0, 'C', 0),
], 'Trigger');

/** Trigger → IF; IF.true → A → Merge.0; IF.false → B → Merge.1; Merge → End. */
export const diamond = workflow('diamond', [
  node('Trigger', 'trigger', [0, 0]),
  node('IF', 'if', [200, 0]),
  node('A', 'set', [400, -100]),
  node('B', 'set', [400, 100]),
  node('Merge', 'merge', [600, 0]),
  node('End', 'set', [800, 0]),
], [
  conn('Trigger', 0, 'IF', 0),
  conn('IF', 0, 'A', 0), conn('IF', 1, 'B', 0),
  conn('A', 0, 'Merge', 0), conn('B', 0, 'Merge', 1),
  conn('Merge', 0, 'End', 0),
], 'Trigger');

/** Trigger → Switch with 20 outputs, each connected to its own node S0…S19. */
export const switch20 = workflow('switch-20', [
  node('Trigger', 'trigger', [0, 0]),
  node('Switch', 'switch20', [200, 0]),
  ...Array.from({ length: 20 }, (_, i) => node(`S${i}`, 'set', [400, i * 100])),
], [
  conn('Trigger', 0, 'Switch', 0),
  ...Array.from({ length: 20 }, (_, i) => conn('Switch', i, `S${i}`, 0)),
], 'Trigger');

/** Trigger → IF; both branches into a Merge in chooseBranch mode (all inputs required). */
export const chooseBranch = workflow('choose-branch', [
  node('Trigger', 'trigger', [0, 0]),
  node('IF', 'if', [200, 0]),
  node('Merge', 'mergeChoose', [400, 0]),
  node('End', 'set', [600, 0]),
], [
  conn('Trigger', 0, 'IF', 0),
  conn('IF', 0, 'Merge', 0), conn('IF', 1, 'Merge', 1),
  conn('Merge', 0, 'End', 0),
], 'Trigger');

/** Trigger → A, B; both A and B feed the single input of C (input-side OR). */
export const multiProducer = workflow('multi-producer', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, -100]),
  node('B', 'set', [200, 100]),
  node('C', 'set', [400, 0]),
], [
  conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0),
  conn('A', 0, 'C', 0), conn('B', 0, 'C', 0),
], 'Trigger');

/** Loop Over Items: Trigger → Loop.0; Loop.loop → Body → Loop.0; Loop.done → After. */
export const loopOverItems = workflow('loop-over-items', [
  node('Trigger', 'trigger', [0, 0]),
  node('Loop', 'loop', [200, 0]),
  node('After', 'set', [400, -100]),
  node('Body', 'set', [400, 100]),
], [
  conn('Trigger', 0, 'Loop', 0),
  conn('Loop', 0, 'Body', 0), conn('Body', 0, 'Loop', 0),
  conn('Loop', 1, 'After', 0),
], 'Trigger');

/** A user cycle without a loop node: Trigger → A → B → A, and B → Exit. */
export const userCycle = workflow('user-cycle', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
  node('B', 'set', [400, 0]),
  node('Exit', 'set', [600, 0]),
], [
  conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0), conn('B', 0, 'A', 0), conn('B', 0, 'Exit', 0),
], 'Trigger');

/** Two triggers; Merge.1 is fed only by the trigger that is not the start node. */
export const twoTriggers = workflow('two-triggers', [
  node('TrigA', 'trigger', [0, 0]),
  node('TrigB', 'trigger', [0, 100]),
  node('Merge', 'merge', [200, 50]),
  node('End', 'set', [400, 50]),
], [
  conn('TrigA', 0, 'Merge', 0), conn('TrigB', 0, 'Merge', 1), conn('Merge', 0, 'End', 0),
], 'TrigA');

/** B references `$('A')` across the IF's branches. */
export const expressionRef = workflow('expression-ref', [
  node('Trigger', 'trigger', [0, 0]),
  node('IF', 'if', [200, 0]),
  node('A', 'set', [400, -100]),
  node('B', 'set', [400, 100]),
], [
  conn('Trigger', 0, 'IF', 0), conn('IF', 0, 'A', 0), conn('IF', 1, 'B', 0),
], 'Trigger', { references: { B: ['A'] } });

/** Trigger → A (retryOnFail, maxTries 3, waitBetweenTries 10 ms) → B. */
export const retry = workflow('retry', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 3, waitBetweenTries: 10 }),
  node('B', 'set', [400, 0]),
], [
  conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0),
], 'Trigger');

/** Trigger → A (continueErrorOutput): A.0 → B, A.1 (the appended error output) → Err. */
export const continueErrorOutput = workflow('continue-error-output', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0], { onError: 'continueErrorOutput' }),
  node('B', 'set', [400, -100]),
  node('Err', 'set', [400, 100]),
], [
  conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0), conn('A', 1, 'Err', 0),
], 'Trigger');

/** Trigger → IF with only the true output connected (unconnected outputs get no places). */
export const ifHalf = workflow('if-half', [
  node('Trigger', 'trigger', [0, 0]),
  node('IF', 'if', [200, 0]),
  node('A', 'set', [400, 0]),
], [
  conn('Trigger', 0, 'IF', 0), conn('IF', 0, 'A', 0),
], 'Trigger');

/**
 * OR input: both IF outputs feed C's single input; C → Merge.0, Trigger → Merge.1. The
 * pattern behind README "OR-inputs": one run per data arrival, one skip per all-empty round.
 */
export const ifBothOutputs = workflow('if-both-outputs', [
  node('Trigger', 'trigger', [0, 0]),
  node('IF', 'if', [200, 0]),
  node('C', 'set', [400, 0]),
  node('Merge', 'merge', [600, 0]),
  node('End', 'set', [800, 0]),
], [
  conn('Trigger', 0, 'IF', 0),
  conn('IF', 0, 'C', 0), conn('IF', 1, 'C', 0),
  conn('C', 0, 'Merge', 0), conn('Trigger', 0, 'Merge', 1),
  conn('Merge', 0, 'End', 0),
], 'Trigger');

/**
 * A three-output router: the largest node that still routes inside `X_run`
 * ({@link SPLIT_ROUTING_ABOVE}). Not in {@link ALL} — it exists to measure the threshold
 * against `fanOut4`, its one-output-wider twin (`tests/compiler/routing.test.ts`).
 */
export const fanOut3 = workflow('fan-out-3', [
  node('Trigger', 'trigger', [0, 0]),
  node('Q', 'switch3', [200, 0]),
  ...Array.from({ length: 3 }, (_, i) => node(`S${i}`, 'set', [400, i * 100])),
], [
  conn('Trigger', 0, 'Q', 0),
  ...Array.from({ length: 3 }, (_, i) => conn('Q', i, `S${i}`, 0)),
], 'Trigger');

/** Trigger → Q (four connected outputs, routed per output) → S0…S3. */
export const fanOut4 = workflow('fan-out-4', [
  node('Trigger', 'trigger', [0, 0]),
  node('Q', 'switch4', [200, 0]),
  ...Array.from({ length: 4 }, (_, i) => node(`S${i}`, 'set', [400, i * 100])),
], [
  conn('Trigger', 0, 'Q', 0),
  ...Array.from({ length: 4 }, (_, i) => conn('Q', i, `S${i}`, 0)),
], 'Trigger');

/** Merge v3 chooseBranch with three inputs (`requiredInputs: [0, 1]`), every input wired. */
export const partialRequired = workflow('partial-required', [
  node('T', 'trigger', [0, 0]),
  node('A', 'set', [100, -100]),
  node('B', 'set', [100, 0]),
  node('Cc', 'set', [100, 100]),
  node('M', 'merge3Choose', [200, 0]),
  node('End', 'set', [300, 0]),
], [
  conn('T', 0, 'A', 0), conn('T', 0, 'B', 0), conn('T', 0, 'Cc', 0),
  conn('A', 0, 'M', 0), conn('B', 0, 'M', 1), conn('Cc', 0, 'M', 2),
  conn('M', 0, 'End', 0),
], 'T');

// ==================== Agent tool dispatch ====================

// The agent fixtures declare a small `maxToolCalls`: the verifier explores every round size up
// to it (the count is a path through `A_dispatch`), so a budget is the width of the claim and
// the cost of the graph — four here keeps every agent fixture complete in milliseconds. The
// runtime default is 64, which no fixture relies on.

/** Trigger → Agent → End, with one tool wired in over `ai_tool`. The smallest round there is. */
export const agentOneTool = workflow('agentOneTool', [
  node('Trigger', 'trigger', [0, 0]),
  node('Agent', 'agent', [200, 0], { maxRounds: 3, maxToolCalls: 4 }),
  node('End', 'set', [400, 0]),
  node('Calculator', 'tool', [200, 200]),
], [
  conn('Trigger', 0, 'Agent', 0), conn('Agent', 0, 'End', 0),
], 'Trigger', { toolConnections: [tool('Calculator', 'Agent')] });

/** Two tools on one agent: `A_dispatch`'s `xor` has two arms, and a round may call either or both. */
export const agentTwoTools = workflow('agentTwoTools', [
  node('Trigger', 'trigger', [0, 0]),
  node('Agent', 'agent', [200, 0], { maxRounds: 2, maxToolCalls: 4 }),
  node('End', 'set', [400, 0]),
  node('Calculator', 'tool', [200, 200]),
  node('Search', 'tool', [200, 400]),
], [
  conn('Trigger', 0, 'Agent', 0), conn('Agent', 0, 'End', 0),
], 'Trigger', { toolConnections: [tool('Calculator', 'Agent'), tool('Search', 'Agent')] });

/** One tool shared by two agents: `T/idle` serialises it, and `T_run`'s outcome is an `xor`. */
export const agentSharedTool = workflow('agentSharedTool', [
  node('Trigger', 'trigger', [0, 0]),
  node('A1', 'agent', [200, 0], { maxRounds: 2, maxToolCalls: 4 }),
  node('A2', 'agent', [400, 0], { maxRounds: 2, maxToolCalls: 4 }),
  node('End', 'set', [600, 0]),
  node('Calculator', 'tool', [300, 200]),
], [
  conn('Trigger', 0, 'A1', 0), conn('A1', 0, 'A2', 0), conn('A2', 0, 'End', 0),
], 'Trigger', { toolConnections: [tool('Calculator', 'A1'), tool('Calculator', 'A2')] });

/** An agent whose `maxIterations` was an expression: the compiler falls back and says so. */
export const agentAssumedRounds = workflow('agentAssumedRounds', [
  node('Trigger', 'trigger', [0, 0]),
  node('Agent', 'agent', [200, 0]),
  node('Calculator', 'tool', [200, 200]),
], [
  conn('Trigger', 0, 'Agent', 0),
], 'Trigger', { toolConnections: [tool('Calculator', 'Agent')] });

/**
 * An agent whose tool declares an `onFailure` chain (ADR 0009). The policy is on the *tool*,
 * which is the node that actually calls the flaky service — n8n has `retryOnFail` there and no
 * deadline at any level.
 *
 * A tool's outcome is not a main edge but its agent's `A/response`, so only three of the four
 * actions mean anything on one: `retry` re-runs it, `stop` halts the execution, and `continue`
 * is n8n's own default for a failing tool (`workflow-execute.ts`: "AI tools default to
 * continue-on-fail so the agent receives the error as a tool response"). `route` has nowhere to
 * go and the compiler refuses it.
 */
export function agentToolPolicy(executionPolicy: NodeDescription['executionPolicy']): WorkflowDescription {
  return workflow('agentToolPolicy', [
    node('Trigger', 'trigger', [0, 0]),
    node('Agent', 'agent', [200, 0], { maxRounds: 3, maxToolCalls: 8 }),
    node('End', 'set', [400, 0]),
    node('Calculator', 'tool', [200, 200], executionPolicy === undefined ? {} : { executionPolicy }),
  ], [
    conn('Trigger', 0, 'Agent', 0), conn('Agent', 0, 'End', 0),
  ], 'Trigger', { toolConnections: [tool('Calculator', 'Agent')] });
}

/**
 * A nested agent: `B` is wired as an `ai_tool` of `A` and has a tool of its own. That is n8n's
 * `AgentToolV3` — `outputs: [NodeConnectionTypes.AiTool]`, every input `ai_*`, and
 * `toolsAgentExecute` for a body, so it emits an `EngineRequest` exactly as a top-level agent
 * does. After the adapter filters inputs to `main` its shape is a tool's: no `main` port at
 * either end.
 *
 * `B` is therefore the one node that is `isTool` *and* an agent at once, and the two gadgets
 * meet in its `X_run` outcome: the tool branch writes its agent's `A/response`, the request
 * branch writes its own `B/routed_req`. Delegation is two levels deep, which n8n's own agent
 * runtime refuses — `SUB_AGENT_TASK_PATH_PATTERN = /^\/root(?:\/[a-z0-9_]+)?$/` caps a task
 * path at depth 1, by parse failure.
 */
export const agentNested = workflow('agentNested', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'agent', [200, 0], { maxRounds: 2, maxToolCalls: 2 }),
  node('End', 'set', [400, 0]),
  node('Calculator', 'tool', [200, 200]),
  node('B', 'tool', [400, 200], { maxRounds: 2, maxToolCalls: 2 }),
  node('Code', 'tool', [400, 400]),
], [
  conn('Trigger', 0, 'A', 0), conn('A', 0, 'End', 0),
], 'Trigger', {
  toolConnections: [tool('Calculator', 'A'), tool('B', 'A'), tool('Code', 'B')],
});

export const AGENTS = { agentOneTool, agentTwoTools, agentSharedTool, agentAssumedRounds } as const;

/**
 * An `onFailure` chain (ADR 0009): `A` retries twice on its own delay, then routes the failure
 * down its second output, with a per-attempt deadline. Trigger -> A.0 -> Ok, A.1 -> Fallback.
 *
 * Deliberately the shape with every chain place in it — three `running`, three `failed`, three
 * `timedout` — so the codec round trip and the structural counts both see the full gadget.
 */
export const failurePolicy = workflow('failure-policy', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'if', [200, 0], {
    executionPolicy: {
      timeoutMs: 30_000,
      onFailure: [
        { action: 'retry', waitMs: 10 },
        { action: 'retry', waitMs: 20 },
        { action: 'route', output: 'false' },
      ],
    },
  }),
  node('Ok', 'set', [400, -100]),
  node('Fallback', 'set', [400, 100]),
], [
  conn('Trigger', 0, 'A', 0), conn('A', 0, 'Ok', 0), conn('A', 1, 'Fallback', 0),
], 'Trigger');

export const ALL = {
  linear, fanOut, diamond, switch20, chooseBranch, multiProducer, loopOverItems, userCycle,
  twoTriggers, expressionRef, retry, continueErrorOutput, ifHalf, ifBothOutputs, fanOut4, partialRequired,
  failurePolicy,
} as const;
