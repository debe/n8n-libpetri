/**
 * The v1 net fingerprint: every place, transition, arc, `Out` spec, priority and timing of a
 * compiled workflow, as one line each, so a changed net shows up as a line diff.
 *
 * ADR 0012 §1 adds a second compile target beside the v1 one, and v1 nets must stay
 * byte-identical while it lands (`tasks/v2-profile-plan.md`, decision 1). This module is what
 * "identical" means: `tests/fixtures/v1-fingerprint.json` holds these lines for every subject
 * below as the compiler produced them before the profile existed, and
 * `tests/compiler/v1-identity.test.ts` recompiles every subject and compares.
 *
 * What a line covers, and why:
 *
 * - **places** in the net's declaration order. The order is part of the net: the precompiled
 *   program indexes places by it, and a reorder is a different program (EXEC-002 AC3).
 * - **transitions** in declaration order, each with its priority and timing (EXEC-002,
 *   TIME-001), its `In` specs with their cardinality (IO-006), its read, inhibitor and reset
 *   arcs, its `Out` spec rendered as the whole and/xor tree (IO-015), its action timeout and
 *   its correlation keys (NU-020).
 * - **terminals** (EXEC-042), and the token count per place of both `sharedMarking()` and
 *   `initialMarking(…)` (CORE-072). The budget is not in the structural hash, but it is in the
 *   marking, and so is every seeded `empty` and `Y/skipped`.
 *
 * What it leaves out: actions (they are bound, not structural), the structural hash (the
 * profile plumbing bumps its version on purpose, and only the pinned hashes may move),
 * diagnostics (text, not net) and the `NetMap`, which is derived from the same gadgets and
 * pinned by `structure.test.ts`.
 *
 * Subjects: every fixture in `tests/fixtures/workflows.ts` — `ALL`, the ones kept out of it
 * (`fanOut3`, the agent fixtures, `agentNested`) and `agentToolPolicy` under each policy the
 * scheduler suite runs it with — compiled with default options, as the compiler suite
 * compiles them; and every committed workflow under `scripts/testbed/workflows/`, read the way
 * the verify CLI reads a file given no `--node-types` (`parseWorkflowJson`, then
 * `compile(…, { budget: 1 })` as `verify()` does). That is the CLI path CI can reproduce: the
 * node-type catalogue is generated from a local `.n8n` build, so these nets use
 * `BUILT_IN_SHAPES` and the connection heuristic, and the shape guesses are part of what is
 * pinned. A subject that does not compile pins its refusal instead.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { In, Out, Timing, Transition } from 'libpetri';
import {
  CompileError, PolicyError, compile, type CompiledWorkflow, type WorkflowDescription,
} from '../../src/compiler/index.js';
import { parseWorkflowJson } from '../../src/verify/workflow-json.js';
import {
  agentAssumedRounds, agentNested, agentOneTool, agentSharedTool, agentToolPolicy, agentTwoTools,
  chooseBranch, continueErrorOutput, diamond, expressionRef, failurePolicy, fanOut, fanOut3, fanOut4,
  ifBothOutputs, ifHalf, linear, loopOverItems, multiProducer, partialRequired, retry, switch20,
  twoTriggers, userCycle,
} from '../fixtures/workflows.js';

/** Where the committed testbed workflows live, from this file. */
export const TESTBED_WORKFLOWS = new URL('../../../scripts/testbed/workflows/', import.meta.url);

/** Where the recorded fingerprint lives, from this file. */
export const FINGERPRINT_FILE = new URL('../fixtures/v1-fingerprint.json', import.meta.url);

/** One subject's recorded fingerprint: its lines, or the code of the error it compiles to. */
export type FingerprintEntry =
  | { readonly source: string; readonly lines: readonly string[] }
  | { readonly source: string; readonly error: string };

export interface FingerprintFile {
  readonly comment: string;
  /** The libpetri the fingerprint was recorded against: information, not a precondition. */
  readonly libpetri: string;
  readonly subjects: Readonly<Record<string, FingerprintEntry>>;
}

interface Subject {
  readonly key: string;
  readonly source: string;
  readonly compile: () => CompiledWorkflow;
}

// ==================== rendering ====================

function renderIn(spec: In): string {
  switch (spec.type) {
    case 'one': return `one(${spec.place.name})`;
    case 'exactly': return `exactly(${spec.count}, ${spec.place.name})`;
    case 'all': return `all(${spec.place.name})`;
    case 'at-least': return `atLeast(${spec.minimum}, ${spec.place.name})`;
  }
}

/** The whole `Out` tree, children in declaration order (IO-015: the branches are the claim). */
export function renderOut(spec: Out): string {
  switch (spec.type) {
    case 'place': return spec.place.name;
    case 'and': return `and(${spec.children.map(renderOut).join(', ')})`;
    case 'xor': return `xor(${spec.children.map(renderOut).join(', ')})`;
    case 'timeout': return `timeout(${spec.afterMs}, ${renderOut(spec.child)})`;
    case 'forward-input': return `forward(${spec.from.name} -> ${spec.to.name})`;
  }
}

function renderTiming(timing: Timing): string {
  switch (timing.type) {
    case 'immediate': return 'immediate';
    case 'deadline': return `deadline(${timing.byMs})`;
    case 'delayed': return `delayed(${timing.afterMs})`;
    case 'window': return `window(${timing.earliestMs}, ${timing.latestMs})`;
    case 'exact': return `exact(${timing.atMs})`;
  }
}

function transitionLines(t: Transition): string[] {
  const at = `transition ${t.name}`;
  const lines = [`${at} priority ${t.priority} timing ${renderTiming(t.timing)}`];
  for (const spec of t.inputSpecs) lines.push(`${at} in ${renderIn(spec)}`);
  for (const arc of t.reads) lines.push(`${at} read ${arc.place.name}`);
  for (const arc of t.inhibitors) lines.push(`${at} inhibitor ${arc.place.name}`);
  for (const arc of t.resets) lines.push(`${at} reset ${arc.place.name}`);
  lines.push(`${at} out ${t.outputSpec === null ? 'null' : renderOut(t.outputSpec)}`);
  if (t.actionTimeout !== null) lines.push(`${at} action-timeout ${renderOut(t.actionTimeout)}`);
  if (t.matchSpec !== null) {
    lines.push(`${at} match ${t.matchSpec.keys.map((k) => k.place.name).join(', ')}`);
  }
  return lines;
}

function markingLines(label: string, marking: ReadonlyMap<{ readonly name: string }, readonly unknown[]>): string[] {
  const lines: string[] = [];
  for (const [place, tokens] of marking) {
    if (tokens.length > 0) lines.push(`${label} ${place.name} x${tokens.length}`);
  }
  return lines.sort();
}

/** Any value: only the token counts are pinned, and the start node's `in` gets one either way. */
const TRIGGER_ITEMS = [{ json: {} }];

/** The fingerprint lines of one compiled workflow. */
export function fingerprint(c: CompiledWorkflow): string[] {
  const lines = [
    `net ${c.net.name}`,
    `start ${c.startNodes.join(', ')}`,
    `budget requested ${c.requestedBudget} effective ${c.effectiveBudget}`,
  ];
  for (const place of c.net.places) lines.push(`place ${place.name}`);
  for (const place of c.net.terminals) lines.push(`terminal ${place.name}`);
  for (const t of c.net.transitions) lines.push(...transitionLines(t));
  lines.push(...markingLines('shared', c.sharedMarking()));
  lines.push(...markingLines('initial', c.initialMarking(TRIGGER_ITEMS)));
  return lines;
}

// ==================== subjects ====================

function fixture(key: string, workflow: WorkflowDescription): Subject {
  return { key: `fixture:${key}`, source: 'tests/fixtures/workflows.ts', compile: () => compile(workflow) };
}

/** The `agentToolPolicy` variants `tests/scheduler/agent.test.ts` compiles; `route` pins its refusal. */
const TOOL_POLICIES = {
  none: undefined,
  retryRetryContinue: {
    onFailure: [{ action: 'retry', waitMs: 5 }, { action: 'retry', waitMs: 5 }, { action: 'continue' }],
  },
  continue: { onFailure: [{ action: 'continue' }] },
  stop: { onFailure: [{ action: 'stop' }] },
  deadlineContinue: { timeoutMs: 40, onFailure: [{ action: 'continue' }] },
  route: { onFailure: [{ action: 'route', output: 0 }] },
} as const satisfies Record<string, Parameters<typeof agentToolPolicy>[0]>;

function fixtureSubjects(): Subject[] {
  const named: Record<string, WorkflowDescription> = {
    linear, fanOut, diamond, switch20, chooseBranch, multiProducer, loopOverItems, userCycle,
    twoTriggers, expressionRef, retry, continueErrorOutput, ifHalf, ifBothOutputs, fanOut3, fanOut4,
    partialRequired, agentOneTool, agentTwoTools, agentSharedTool, agentAssumedRounds, agentNested,
    failurePolicy,
  };
  return [
    ...Object.entries(named).map(([key, wf]) => fixture(key, wf)),
    ...Object.entries(TOOL_POLICIES).map(([key, policy]) =>
      fixture(`agentToolPolicy.${key}`, agentToolPolicy(policy))),
  ];
}

function testbedSubjects(): Subject[] {
  return readdirSync(TESTBED_WORKFLOWS).filter((f) => f.endsWith('.json')).sort().map((file) => ({
    key: `testbed:${file}`,
    source: `scripts/testbed/workflows/${file}`,
    compile: () => compile(
      parseWorkflowJson(readFileSync(new URL(file, TESTBED_WORKFLOWS), 'utf8')).description,
      { budget: 1 },
    ),
  }));
}

/** Every subject the fingerprint covers, in a stable order. */
export function subjects(): Subject[] {
  return [...fixtureSubjects(), ...testbedSubjects()];
}

/**
 * One subject's current entry: its lines, or the refusal it compiles to — a `CompileError` by
 * its code, a `PolicyError` by its class. Messages are left out: they are prose, not the net.
 */
export function entryOf(subject: Subject): FingerprintEntry {
  try {
    return { source: subject.source, lines: fingerprint(subject.compile()) };
  } catch (e) {
    if (e instanceof CompileError) return { source: subject.source, error: `CompileError ${e.code}` };
    if (e instanceof PolicyError) return { source: subject.source, error: 'PolicyError' };
    throw e;
  }
}

// ==================== diff ====================

/**
 * A readable difference between two line lists: `- line` for each recorded line that is gone,
 * `+ line` for each new one (as multisets), and when both agree as multisets but not as lists,
 * the first position where the order differs. Empty when the lists are equal.
 */
export function diffLines(expected: readonly string[], actual: readonly string[]): string[] {
  const count = (lines: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const want = count(expected);
  const got = count(actual);
  const out: string[] = [];
  for (const l of expected) {
    const n = got.get(l) ?? 0;
    if (n > 0) got.set(l, n - 1);
    else out.push(`- ${l}`);
  }
  for (const l of actual) {
    const n = want.get(l) ?? 0;
    if (n > 0) want.set(l, n - 1);
    else out.push(`+ ${l}`);
  }
  if (out.length > 0) return out;
  const i = expected.findIndex((l, j) => l !== actual[j]);
  return i < 0 ? [] : [`order differs at line ${i}: expected "${expected[i]}", got "${actual[i]}"`];
}
