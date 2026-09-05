/**
 * Structural workflow fixtures for the compiler suite. Each is a `WorkflowDescription`
 * (no n8n dependency) with canvas positions chosen so the expected declaration order is
 * unambiguous, plus the hand-derived facts the tests assert against.
 *
 * Node ids are derived from names (`id:<name>`); they must not contain `/` (MOD-010).
 */
import type {
  MainConnection, NodeDescription, NodeTypeShape, WorkflowDescription,
} from '../../src/compiler/index.js';

export const SHAPES = {
  trigger: { inputCount: 0, outputCount: 1 },
  set: { inputCount: 1, outputCount: 1 },
  if: { inputCount: 1, outputCount: 2, outputNames: ['true', 'false'] },
  switch20: { inputCount: 1, outputCount: 20 },
  merge: { inputCount: 2, outputCount: 1 },
  mergeChoose: { inputCount: 2, outputCount: 1, requiredInputs: [0, 1] },
  loop: { inputCount: 1, outputCount: 2, loopNode: true, outputNames: ['loop', 'done'] },
  /** A four-output router: above `SPLIT_ROUTING_ABOVE`, so it routes per output. */
  switch4: { inputCount: 1, outputCount: 4 },
  /** Merge v3 chooseBranch with `numberInputs: 3`: `requiredInputs` stays `[0, 1]`. */
  merge3Choose: { inputCount: 3, outputCount: 1, requiredInputs: [0, 1] },
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

export interface FixtureOptions {
  readonly references?: Readonly<Record<string, readonly string[]>>;
  readonly shapes?: Readonly<Record<string, NodeTypeShape>>;
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

export const ALL = {
  linear, fanOut, diamond, switch20, chooseBranch, multiProducer, loopOverItems, userCycle,
  twoTriggers, expressionRef, retry, continueErrorOutput, ifHalf, ifBothOutputs, fanOut4, partialRequired,
} as const;
