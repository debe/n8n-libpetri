/**
 * Structural analysis of the main-connection graph: validation, canvas order, SCC
 * decomposition (Tarjan), edge classification for the emission rule, reachability from the
 * start node, depth (longest path in the SCC condensation, the `X_start` priority under
 * EXEC-002), the classification of `$('Y')` references (README "Expression references"),
 * the required-input facts of the join gadget and the k-safety facts the budget check needs.
 */
import type {
  AnalysedNode, EdgeRef, FailureChain, JoinForm, MultiProducerInput, NodeDescription, NodeTypeShape, OnError,
  ResolvedReference, ResolvedStep, RetryParams, ToolConnection, WorkflowAnalysis, WorkflowDescription,
} from './types.js';
import { isTerminalAction, nonNegativeInt, PolicyError, positiveInt } from './policy.js';
import { assertNever } from '../internal/assert.js';

/**
 * n8n's retry parameters as `WorkflowExecute.getRetryParams` reads them
 * (`workflow-execute.ts` @ `441970b`, lines 1801–1811):
 * `maxTries = min(5, max(2, node.maxTries || 3))`,
 * `waitBetweenTries = min(5000, max(0, node.waitBetweenTries || 1000))`.
 * `0`, `undefined` and `NaN` are falsy and take the default; out-of-range values are
 * clamped; nothing is rejected.
 */
export const DEFAULT_MAX_TRIES = 3;
export const MIN_MAX_TRIES = 2;
export const MAX_MAX_TRIES = 5;
export const DEFAULT_WAIT_BETWEEN_TRIES_MS = 1000;
export const MAX_WAIT_BETWEEN_TRIES_MS = 5000;

/**
 * The seed of `A/rounds` when the adapter could not read `options.maxIterations` statically —
 * n8n's own default for that parameter (`agents/ToolsAgent/options.ts`), so an agent left at
 * the default compiles to the bound it actually runs under.
 *
 * When the fallback is used the agent is marked {@link AnalysedNode.roundsAssumed}: the place
 * might then bind before the node's own `checkMaxIterations` does, so the verifier must not
 * claim a bound it cannot justify. It stays a *runtime* safety net either way — an agent that
 * exhausts an assumed budget stops rather than looping forever.
 */
export const DEFAULT_MAX_AGENT_ROUNDS = 10;

/**
 * The seed of `A/calls` when a workflow declares no `options.maxToolCalls`: the tool calls an
 * agent may dispatch in one execution, across every round. n8n has no such bound, so this is
 * not a fallback for one — it is the bound, and the scheduler's.
 *
 * Two pressures set it, in opposite directions, and the number serves the runtime one.
 *
 * At run time it must not bite a legitimate agent: n8n's `maxIterations` default is 10, a model
 * may make several tool calls per turn, and an agent that trips a cap it never asked for is an
 * agent whose scheduler gets switched off. Sixty-four is above any ordinary execution and still
 * a runaway guard; a run that reaches it fails by name, with the knob in the message.
 *
 * For verification it is far too large. The state-class graph explores every round size up to
 * the budget, and the state space is a product of independent counters — `A/calls`,
 * `A/outstanding`, `A/response`, and `T/in_tool` and `T/done` per tool, each 0…K — so it grows
 * polynomially, about K^3.7 in the budget and m^2.8 in the tool count: on the real two-tool
 * net, K = 4 is 7 968 classes, K = 6 is 41 697, K = 8 is 149 958, and a four-tool agent
 * truncates at 8 (`tests/spikes/agent-round.test.ts`, `docs/verification.md`). So an agent left
 * at this default verifies as `unknown` — truncated, with a report that names the assumed
 * budget and says to declare a small `options.maxToolCalls` for a complete graph. A declared
 * budget is both the runtime cap the workflow chose and the width of the claim its `proven`
 * makes; the compiler marks an assumed one so the verifier never reports a bound it invented.
 */
export const DEFAULT_MAX_AGENT_TOOL_CALLS = 64;

/** Options `analyse` reads. Kept separate from `CompileOptions`, which carries the action binder. */
export interface AnalysisOptions {
  /** Fallback seed for `A/rounds`; default {@link DEFAULT_MAX_AGENT_ROUNDS}. */
  readonly maxAgentRounds?: number;
  /** Default seed for `A/calls`; default {@link DEFAULT_MAX_AGENT_TOOL_CALLS}. */
  readonly maxAgentToolCalls?: number;
}

/** The clamped retry parameters of a `retryOnFail` node (see the constants above). */
export function retryParamsOf(node: Pick<NodeDescription, 'maxTries' | 'waitBetweenTries'>): RetryParams {
  return {
    maxTries: Math.min(MAX_MAX_TRIES, Math.max(MIN_MAX_TRIES, node.maxTries || DEFAULT_MAX_TRIES)),
    waitBetweenTries: Math.min(MAX_WAIT_BETWEEN_TRIES_MS, Math.max(0, node.waitBetweenTries || DEFAULT_WAIT_BETWEEN_TRIES_MS)),
  };
}

/**
 * A node's declared `onFailure` into a {@link FailureChain}, with output names resolved.
 *
 * Rejects rather than guesses in three places, because each would otherwise run a net the
 * workflow did not describe: `onFailure` beside n8n's own `retryOnFail` / `onError` (the two
 * say the same thing at different resolutions), a `route` to an output the node does not have
 * or nobody wired (the emission rule writes connected outputs only, so the step would have
 * nowhere to put its token), and a `timeoutMs` with no chain to receive the expiry.
 *
 * Every fault is a {@link PolicyError}, and the faults of one chain are accumulated the way
 * `parseExecutionPolicy` accumulates its own, so an author sees every bad target at once
 * rather than one per compile.
 */
export function resolveFailureChain(
  node: NodeDescription,
  shape: NodeTypeShape,
  outputCount: number,
  errorOutputIndex: number | null,
  connectedOutputs: ReadonlySet<number>,
  diagnostics: string[],
): FailureChain | null {
  const policy = node.executionPolicy;
  if (policy === undefined) return null;
  const steps = policy.onFailure;
  const where = `node '${node.name}'`;
  const problems: string[] = [];

  if (steps === undefined) {
    if (policy.timeoutMs !== undefined) {
      throw new PolicyError(where, [
        `${where}: executionPolicy.timeoutMs needs an onFailure chain to say what an expired ` +
        'attempt does']);
    }
    return null;
  }
  if (node.retryOnFail === true) {
    problems.push(
      `${where}: executionPolicy.onFailure and retryOnFail both set; onFailure is the same ` +
      'policy at a finer resolution, so declare one of them');
  }
  // `continueErrorOutput` is allowed beside a chain, and is the only way to get a second arc
  // out of a node that has one main output: `NodeHelpers.getNodeOutputs` appends the error
  // output purely on this field, which is what makes the editor draw the port and lets a user
  // wire it. So the two divide cleanly — `onError` declares the *shape*, `onFailure` decides
  // the *policy* — and a `route` step can then name `'error'`.
  //
  // `continueRegularOutput` is refused because it declares no port and claims the terminal the
  // chain already owns.
  if (node.onError !== undefined
    && node.onError !== 'stopWorkflow'
    && node.onError !== 'continueErrorOutput') {
    problems.push(
      `${where}: executionPolicy.onFailure and onError '${node.onError}' both set; the chain's ` +
      "last step is this node's error policy, so declare one of them (onError " +
      "'continueErrorOutput' is the exception: it declares the error output the chain routes to)");
  }

  /** An output name or index into a connected output index; `undefined` records a problem. */
  const outputOf = (raw: string | number, at: string): number | undefined => {
    // A node with no outputs at all cannot route anywhere, and the commonest one by far is an
    // `ai_tool` node — whose result is its agent's response, not a main edge — so the message
    // names that rather than leaving the author to work out why an index is out of range.
    if (outputCount === 0) {
      problems.push(
        `${where}: ${at} declares action 'route', but this node has no output to route to ` +
        "(a tool's result goes to its agent rather than down a main edge). Use 'retry', " +
        "'stop' or 'continue'");
      return undefined;
    }
    let index: number;
    if (typeof raw === 'number') {
      index = raw;
    } else if (raw === 'error' && errorOutputIndex !== null) {
      index = errorOutputIndex;
    } else {
      const named = shape.outputNames?.indexOf(raw) ?? -1;
      if (named < 0) {
        problems.push(
          `${where}: ${at} routes to output '${raw}', which this node type does not name` +
          (shape.outputNames === undefined
            ? ' (the node type declares no output names; use an index)'
            : ` (it names ${shape.outputNames.map((n) => `'${n}'`).join(', ')})`));
        return undefined;
      }
      index = named;
    }
    if (index >= outputCount) {
      problems.push(
        `${where}: ${at} routes to output ${index}, but the node has ${outputCount}`);
      return undefined;
    }
    if (!connectedOutputs.has(index)) {
      problems.push(
        `${where}: ${at} routes to output ${index}, which has no connection; wire it or ` +
        "use 'stop' / 'continue'");
      return undefined;
    }
    return index;
  };

  const resolved: ResolvedStep[] = [];
  steps.forEach((step, i) => {
    const at = `onFailure[${i}]`;
    const attempt = i + 1;
    switch (step.action) {
      case 'retry':
        resolved.push({ attempt, action: 'retry', waitMs: step.waitMs ?? 0, nextAttempt: attempt + 1 });
        break;
      case 'route': {
        const outputIndex = outputOf(step.output, at);
        if (outputIndex !== undefined) resolved.push({ attempt, action: 'route', outputIndex });
        break;
      }
      case 'stop':
      case 'continue':
        resolved.push({ attempt, action: step.action });
        break;
      default: assertNever(step, 'failure step');
    }
  });
  // `parseExecutionPolicy` already truncated at the first terminal, so this is a defence
  // against a hand-built description rather than against a workflow. Checked only once every
  // step resolved: a route step that was dropped is already a problem, and the gap it leaves
  // is not a second one.
  const last = resolved[resolved.length - 1];
  if (resolved.length === steps.length && (last === undefined || !isTerminalAction(last.action))) {
    problems.push(`${where}: executionPolicy.onFailure must end with a terminal step`);
  }
  positiveInt(policy.timeoutMs, `${where} timeoutMs`, problems);
  // `last` is undefined only when a step was dropped or the chain is empty, and both recorded
  // a problem; the second test is the same condition, written so the type says so.
  if (problems.length > 0 || last === undefined) throw new PolicyError(where, problems);
  diagnostics.push(
    `${where}: onFailure declares ${resolved.length} attempt(s)` +
    (policy.timeoutMs === undefined ? '' : ` with a ${policy.timeoutMs} ms deadline each`) +
    `, ending in '${last.action}'`);
  return { steps: resolved, timeoutMs: policy.timeoutMs ?? null };
}

/** Whether `requiredInputs` names every input (n8n `workflow-execute.ts`, the R6 check). */
export function isAllRequired(shape: NodeTypeShape): boolean {
  const r = shape.requiredInputs;
  if (r === undefined) return false;
  if (typeof r === 'number') return r === shape.inputCount;
  return r.length === shape.inputCount;
}

/** The inputs that must carry data (see `AnalysedNode.requiredInputs`). */
export function requiredInputsOf(shape: NodeTypeShape): readonly number[] | null {
  if (isAllRequired(shape)) return Array.from({ length: shape.inputCount }, (_, i) => i);
  const r = shape.requiredInputs;
  if (r === undefined || typeof r === 'number' || r.length === 0) return null;
  return [...new Set(r)].filter((i) => Number.isInteger(i) && i >= 0 && i < shape.inputCount).sort((x, y) => x - y);
}

/**
 * Chooses the input-side gadget. `direct` for at most one producer on one input (dead
 * inputs count as inputs); `or` for one input with several empty-capable (tree) producer
 * edges (README "OR-inputs"; producers inside a cycle carry `nil`, never `empty`, and do
 * not count); otherwise the join gadget, `choose-branch` when some inputs are required.
 */
export function joinFormOf(a: AnalysedNode, incoming: readonly EdgeRef[]): JoinForm {
  // A tool node has no `main` producer by construction (`analyse` only sets `isTool` when
  // `incoming` is empty), so its input side is the agent's dispatch place and nothing else.
  if (a.isTool) return 'tool';
  const indexes = new Set<number>(a.deadInputs);
  for (const e of incoming) indexes.add(e.inputIndex);
  if (indexes.size <= 1) {
    const treeEdges = incoming.filter((e) => e.kind === 'tree').length;
    if (treeEdges > 1) return 'or';
    if (incoming.length <= 1) return 'direct';
    return 'join';
  }
  return a.requiredInputs === null ? 'join' : 'choose-branch';
}

function compareCanvas(a: NodeDescription, b: NodeDescription): number {
  const [ax, ay] = a.position;
  const [bx, by] = b.position;
  if (ay !== by) return ay - by;
  if (ax !== bx) return ax - bx;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * `policy.ts`'s collecting integer check, raised at once: the analysis has no problem list
 * to accumulate into, and a bad count is a description it cannot compile at all.
 */
function raising(
  check: (v: unknown, what: string, problems: string[]) => number | undefined,
): (v: number, what: string) => void {
  return (v, what) => {
    const problems: string[] = [];
    check(v, what, problems);
    const [problem] = problems;
    if (problem !== undefined) throw new Error(problem);
  };
}
const requireNonNegativeInt = raising(nonNegativeInt);
const requirePositiveInt = raising(positiveInt);

/** Nodes reachable from any of `starts` over `succ`, never entering `avoid`. */
function reachFrom(starts: readonly string[], succ: ReadonlyMap<string, readonly string[]>, avoid: string | null): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const start of starts) {
    if (start === avoid || seen.has(start)) continue;
    seen.add(start);
    stack.push(start);
  }
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const m of succ.get(n) ?? []) {
      if (m === avoid || seen.has(m)) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  return seen;
}

/** A validated main connection with the canvas indexes its canonical order sorts on. */
interface RawEdge extends Omit<EdgeRef, 'id' | 'kind'> {
  readonly fromIndex: number;
  readonly toIndex: number;
}

interface RawNode {
  readonly node: NodeDescription;
  readonly shape: NodeTypeShape;
  readonly index: number;
  readonly outputCount: number;
  readonly errorOutputIndex: number | null;
  readonly onError: OnError;
  readonly retry: RetryParams | null;
  /** Existing referenced nodes, resolver order, no duplicates, self included (classified later). */
  readonly rawReferences: readonly string[];
  readonly allRequired: boolean;
  readonly requiredInputs: readonly number[] | null;
}

export function analyse(workflow: WorkflowDescription, options: AnalysisOptions = {}): WorkflowAnalysis {
  // Whatever the adapter already had to say — a policy at a version this build does not know,
  // an unknown key it ignored — carried forward so the CLI and the scheduler report it beside
  // the analysis's own findings instead of the adapter dropping it on the floor.
  const diagnostics: string[] = [...(workflow.diagnostics ?? [])];
  if (workflow.nodes.length === 0) throw new Error('compile: workflow has no nodes');

  // ---- nodes: uniqueness, prefix validity, canvas order ----
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const n of workflow.nodes) {
    if (names.has(n.name)) throw new Error(`compile: duplicate node name '${n.name}'`);
    names.add(n.name);
    if (n.id.length === 0) throw new Error(`compile: node '${n.name}' has an empty id`);
    if (n.id.includes('/')) {
      throw new Error(`compile: node '${n.name}' id '${n.id}' contains '/', the MOD-010 prefix separator`);
    }
    if (ids.has(n.id)) throw new Error(`compile: duplicate node id '${n.id}'`);
    ids.add(n.id);
  }
  const declaredStarts = workflow.startNodes ?? (workflow.startNode === undefined ? [] : [workflow.startNode]);
  if (declaredStarts.length === 0) throw new Error('compile: workflow declares no start node');
  for (const s of declaredStarts) {
    if (!names.has(s)) throw new Error(`compile: start node '${s}' is not in the workflow`);
  }
  const ordered = [...workflow.nodes].sort(compareCanvas);
  // Canonical start list: the primary first (it alone is seeded by initialMarking), the
  // rest in canvas order, so the same set hashes alike whatever order it was listed in.
  const primaryStart = declaredStarts[0]!;
  const startSet = new Set(declaredStarts);
  const startNodes = [primaryStart, ...ordered.map((n) => n.name).filter((n) => n !== primaryStart && startSet.has(n))];

  const raws: RawNode[] = [];
  const rawByName = new Map<string, RawNode>();
  ordered.forEach((node, index) => {
    const shape = workflow.nodeTypes(node);
    requireNonNegativeInt(shape.inputCount, `node '${node.name}' inputCount`);
    requireNonNegativeInt(shape.outputCount, `node '${node.name}' outputCount`);
    const onError: OnError = node.onError ?? 'stopWorkflow';
    const errorOutputIndex = onError === 'continueErrorOutput' ? shape.outputCount : null;
    const retry = node.retryOnFail === true ? retryParamsOf(node) : null;
    const rawReferences: string[] = [];
    for (const ref of workflow.expressionReferences?.(node) ?? []) {
      if (!names.has(ref)) {
        diagnostics.push(`node '${node.name}' references unknown node '${ref}'; ignored`);
        continue;
      }
      if (!rawReferences.includes(ref)) rawReferences.push(ref);
    }
    const r: RawNode = {
      node, shape, index,
      outputCount: shape.outputCount + (errorOutputIndex === null ? 0 : 1),
      errorOutputIndex, onError, retry,
      rawReferences, allRequired: isAllRequired(shape), requiredInputs: requiredInputsOf(shape),
    };
    raws.push(r);
    rawByName.set(node.name, r);
  });

  // ---- connections: validation, deduplication, canonical order ----
  const seen = new Set<string>();
  const raw: RawEdge[] = [];
  for (const c of workflow.connections) {
    const from = rawByName.get(c.from);
    const to = rawByName.get(c.to);
    if (from === undefined) throw new Error(`compile: connection from unknown node '${c.from}'`);
    if (to === undefined) throw new Error(`compile: connection to unknown node '${c.to}'`);
    if (!Number.isInteger(c.outputIndex) || c.outputIndex < 0 || c.outputIndex >= from.outputCount) {
      throw new Error(
        `compile: connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}: ` +
        `output index out of range (node has ${from.outputCount} outputs)`);
    }
    if (!Number.isInteger(c.inputIndex) || c.inputIndex < 0 || c.inputIndex >= to.shape.inputCount) {
      throw new Error(
        `compile: connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}: ` +
        `input index out of range (node has ${to.shape.inputCount} inputs)`);
    }
    const key = `${c.from} ${c.outputIndex} ${c.to} ${c.inputIndex}`;
    if (seen.has(key)) {
      diagnostics.push(`duplicate connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}; ignored`);
      continue;
    }
    seen.add(key);
    raw.push({
      from: c.from, outputIndex: c.outputIndex, to: c.to, inputIndex: c.inputIndex,
      fromIndex: from.index, toIndex: to.index,
    });
  }
  raw.sort((x, y) =>
    (x.fromIndex - y.fromIndex) || (x.outputIndex - y.outputIndex) || (x.toIndex - y.toIndex) || (x.inputIndex - y.inputIndex));

  // ---- ai_tool connections: which agent may dispatch which tool ----
  // Kept out of the main graph deliberately: the SCC decomposition below is what the emission
  // rule reads (ADR 0002), and a dispatch edge is not a data edge, so it must not turn an
  // agent and its tool into one SCC. Reachability and depth are propagated separately below.
  const hasProducer = new Set(raw.map((e) => e.to));
  const toolsOf = new Map<string, string[]>();
  const agentsOf = new Map<string, string[]>();
  const keyedTools: Array<ToolConnection & { readonly agentIndex: number; readonly toolIndex: number }> = [];
  const seenTool = new Set<string>();
  for (const c of workflow.toolConnections ?? []) {
    const agent = rawByName.get(c.agent);
    const tool = rawByName.get(c.tool);
    if (agent === undefined) throw new Error(`compile: ai_tool connection to unknown node '${c.agent}'`);
    if (tool === undefined) throw new Error(`compile: ai_tool connection from unknown node '${c.tool}'`);
    if (c.agent === c.tool) {
      diagnostics.push(`node '${c.agent}' is wired as its own ai_tool; ignored`);
      continue;
    }
    const key = `${c.tool} -> ${c.agent}`;
    if (seenTool.has(key)) {
      diagnostics.push(`duplicate ai_tool connection ${c.tool} -> ${c.agent}; ignored`);
      continue;
    }
    // A tool node has no main producer in n8n: its only input is the agent's dispatch. One that
    // has both is malformed, and half-compiling it would give the agent a branch whose input
    // place is also fed by a main edge. Drop the tool wiring, say so, and let a dispatch naming
    // the node fail by name at run time.
    if (hasProducer.has(c.tool)) {
      diagnostics.push(
        `node '${c.tool}' is wired as an ai_tool of '${c.agent}' but also has a main producer; ` +
        'the tool connection is ignored and a dispatch naming it will fail');
      continue;
    }
    seenTool.add(key);
    keyedTools.push({ agent: c.agent, tool: c.tool, agentIndex: agent.index, toolIndex: tool.index });
  }
  keyedTools.sort((x, y) => (x.agentIndex - y.agentIndex) || (x.toolIndex - y.toolIndex));
  const toolConnections: ToolConnection[] = keyedTools.map(({ agent, tool }) => ({ agent, tool }));
  for (const c of toolConnections) {
    let tools = toolsOf.get(c.agent);
    if (tools === undefined) toolsOf.set(c.agent, tools = []);
    tools.push(c.tool);
    let agents = agentsOf.get(c.tool);
    if (agents === undefined) agentsOf.set(c.tool, agents = []);
    agents.push(c.agent);
  }
  // A tool's result goes to its agent's `A/response` and nowhere else (ADR 0008), so a main
  // edge out of a tool never carries a token. Dropped here rather than modelled: kept, the
  // gadget would declare an output port no transition writes, and above `SPLIT_ROUTING_ABOVE`
  // a per-output routing the tool form cannot take. The consumer keeps its own `in` place and
  // is simply unreachable, which is what it was.
  const toolsWithConsumers = new Set<string>();
  for (const tool of agentsOf.keys()) {
    if (raw.some((e) => e.from === tool)) {
      toolsWithConsumers.add(tool);
      diagnostics.push(
        `ai_tool node '${tool}' has main consumers; a tool's output goes to its agent, ` +
        'so those connections never carry a token; ignored');
    }
  }
  const mainEdges = toolsWithConsumers.size === 0 ? raw : raw.filter((e) => !toolsWithConsumers.has(e.from));

  // ---- SCC decomposition (Tarjan) ----
  const succ = new Map<string, string[]>();
  for (const r of raws) succ.set(r.node.name, []);
  for (const e of mainEdges) succ.get(e.from)!.push(e.to);
  const { sccOf, sccs } = tarjan(raws.map((r) => r.node.name), succ);
  const cyclic = new Set<string>();
  for (const scc of sccs) if (scc.length > 1) for (const n of scc) cyclic.add(n);
  for (const e of mainEdges) if (e.from === e.to) cyclic.add(e.from);

  const edges: EdgeRef[] = mainEdges.map(({ from, outputIndex, to, inputIndex }, id) => ({
    from, outputIndex, to, inputIndex, id, kind: sccOf.get(from) === sccOf.get(to) ? 'cycle' : 'tree',
  }));
  const incoming = new Map<string, EdgeRef[]>();
  const outgoing = new Map<string, EdgeRef[]>();
  for (const r of raws) {
    incoming.set(r.node.name, []);
    outgoing.set(r.node.name, []);
  }
  for (const e of edges) {
    incoming.get(e.to)!.push(e);
    outgoing.get(e.from)!.push(e);
  }

  // ---- reachability from the union of the start nodes ----
  // A tool is reachable exactly when an agent that can dispatch it is: it has no main producer,
  // so nothing else could reach it. Iterated to a fixpoint because a tool may itself be an agent
  // (n8n's AgentTool — an agent used as another agent's tool).
  const reachable = reachFrom(startNodes, succ, null);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of toolConnections) {
      if (reachable.has(c.agent) && !reachable.has(c.tool)) {
        reachable.add(c.tool);
        changed = true;
      }
    }
  }

  // ---- depth: longest path over the condensation from any start node, in topological order ----
  // Tarjan emits SCCs in reverse topological order, so walking them backwards visits every
  // SCC after all of its predecessors.
  const sccDepth = new Array<number>(sccs.length).fill(-1);
  for (const s of startNodes) sccDepth[sccOf.get(s)!] = 0;
  for (let s = sccs.length - 1; s >= 0; s--) {
    const d = sccDepth[s]!;
    if (d < 0) continue;
    for (const n of sccs[s]!) {
      for (const e of outgoing.get(n)!) {
        if (e.kind === 'tree') {
          const t = sccOf.get(e.to)!;
          if (sccDepth[t]! < d + 1) sccDepth[t] = d + 1;
        }
      }
    }
  }
  const depth = new Map<string, number>();
  for (const r of raws) depth.set(r.node.name, Math.max(0, sccDepth[sccOf.get(r.node.name)!]!));
  // A tool is not on the main graph, so the condensation gave it 0. It runs one step below the
  // agent that dispatches it, and `X_start` priority is depth, so it must sort below its agent
  // and above nothing else. Iterated for the agent-as-tool case; `toolConnections.length` passes
  // is enough for any acyclic dispatch graph, and a cyclic one (an agent reachable from its own
  // tool) is diagnosed and left at the depth it reached.
  for (let pass = 0; pass <= toolConnections.length; pass++) {
    let changed = false;
    for (const c of toolConnections) {
      const want = depth.get(c.agent)! + 1;
      if (depth.get(c.tool)! < want) {
        depth.set(c.tool, want);
        changed = true;
      }
    }
    if (!changed) break;
    if (pass === toolConnections.length) {
      diagnostics.push('ai_tool dispatch has a cycle (an agent is reachable from its own tool); depths are truncated');
    }
  }
  let maxDepth = 0;
  for (const d of depth.values()) if (d > maxDepth) maxDepth = d;

  // ---- references: classified by reachability avoiding the referencing node ----
  const referenced = new Set<string>();
  const seededSkipped = new Set<string>();
  const referencesOf = new Map<string, ResolvedReference[]>();
  for (const r of raws) {
    const x = r.node.name;
    const resolved: ResolvedReference[] = [];
    let avoiding: Set<string> | null = null;
    for (const y of r.rawReferences) {
      if (y === x) {
        diagnostics.push(`node '${x}' references itself; the expression fails inside the action as in n8n`);
        resolved.push({ node: y, kind: 'unguarded' });
        continue;
      }
      if (!reachable.has(y)) {
        diagnostics.push(
          `node '${x}' references '${y}', which is unreachable from the start node${startNodes.length > 1 ? 's' : ''}; ` +
          `'${y}/skipped' is seeded and the reference always fails`);
        resolved.push({ node: y, kind: 'seeded' });
        referenced.add(y);
        seededSkipped.add(y);
        continue;
      }
      avoiding ??= reachFrom(startNodes, succ, x);
      if (avoiding.has(y)) {
        resolved.push({ node: y, kind: 'read' });
        referenced.add(y);
      } else {
        diagnostics.push(
          `node '${x}' references '${y}', which is reachable only through '${x}'; ` +
          'no read arc, the expression fails inside the action as in n8n');
        resolved.push({ node: y, kind: 'unguarded' });
      }
    }
    referencesOf.set(x, resolved);
  }

  // ---- dead required inputs (README join gadget) ----
  const deadInputsOf = new Map<string, number[]>();
  for (const r of raws) {
    const wired = new Set<number>();
    let maxWired = -1;
    for (const e of incoming.get(r.node.name)!) {
      wired.add(e.inputIndex);
      if (e.inputIndex > maxWired) maxWired = e.inputIndex;
    }
    const dead: number[] = [];
    if (r.requiredInputs !== null && maxWired >= 1) {
      for (const i of r.requiredInputs) if (i < maxWired && !wired.has(i)) dead.push(i);
    }
    if (dead.length > 0) {
      diagnostics.push(
        `node '${r.node.name}' requires input${dead.length > 1 ? 's' : ''} ${dead.join(', ')} ` +
        `but ${dead.length > 1 ? 'they have' : 'it has'} no producer; n8n pads the lower inputs and never runs it, ` +
        'so the join can never complete');
    }
    deadInputsOf.set(r.node.name, dead);
  }

  const fallbackRounds = options.maxAgentRounds ?? DEFAULT_MAX_AGENT_ROUNDS;
  requirePositiveInt(fallbackRounds, 'maxAgentRounds');
  const defaultCalls = options.maxAgentToolCalls ?? DEFAULT_MAX_AGENT_TOOL_CALLS;
  requirePositiveInt(defaultCalls, 'maxAgentToolCalls');
  const analysed: AnalysedNode[] = [];
  const byName = new Map<string, AnalysedNode>();
  for (const r of raws) {
    const tools = toolsOf.get(r.node.name) ?? [];
    const isAgent = tools.length > 0;
    const declared = r.node.maxRounds;
    if (isAgent && declared !== undefined) requirePositiveInt(declared, `node '${r.node.name}' maxRounds`);
    if (isAgent && declared === undefined) {
      diagnostics.push(
        `agent '${r.node.name}' does not declare a static maxIterations; A/rounds is seeded with ` +
        `${fallbackRounds} and the agent counts as unbounded for verification`);
    }
    const declaredCalls = r.node.maxToolCalls;
    if (isAgent && declaredCalls !== undefined) requirePositiveInt(declaredCalls, `node '${r.node.name}' maxToolCalls`);
    const connectedOutputs = new Set((outgoing.get(r.node.name) ?? []).map((e) => e.outputIndex));
    const failure = resolveFailureChain(
      r.node, r.shape, r.outputCount, r.errorOutputIndex, connectedOutputs, diagnostics);
    const a: AnalysedNode = {
      node: r.node, shape: r.shape, index: r.index, outputCount: r.outputCount,
      errorOutputIndex: r.errorOutputIndex, onError: r.onError, retry: r.retry,
      references: referencesOf.get(r.node.name)!,
      allRequired: r.allRequired, requiredInputs: r.requiredInputs, deadInputs: deadInputsOf.get(r.node.name)!,
      isTool: agentsOf.has(r.node.name),
      tools,
      maxRounds: isAgent ? (declared ?? fallbackRounds) : null,
      roundsAssumed: isAgent && declared === undefined,
      maxToolCalls: isAgent ? (declaredCalls ?? defaultCalls) : null,
      toolCallsAssumed: isAgent && declaredCalls === undefined,
      failure,
    };
    analysed.push(a);
    byName.set(r.node.name, a);
  }

  // ---- k-safety facts ----
  const producers = new Map<string, MultiProducerInput>();
  for (const e of edges) {
    const key = `${e.to} ${e.inputIndex}`;
    const prev = producers.get(key);
    producers.set(key, prev === undefined
      ? { node: e.to, inputIndex: e.inputIndex, producers: 1 }
      : { ...prev, producers: prev.producers + 1 });
  }
  const multiProducerInputs = [...producers.values()].filter((p) => p.producers > 1);

  return {
    startNode: primaryStart, startNodes,
    nodes: analysed, byName, edges, incoming, outgoing, sccOf, sccs, cyclic, reachable,
    depth, maxDepth, hasCycle: cyclic.size > 0, multiProducerInputs, referenced, seededSkipped,
    toolConnections, agentsOf, hasAgents: toolConnections.length > 0, diagnostics,
  };
}

/** One frame of the depth-first walk: the node and how far along its successors it is. */
interface TarjanFrame {
  readonly v: string;
  readonly next: readonly string[];
  pos: number;
}

/**
 * Tarjan's SCC algorithm; SCCs are emitted in reverse topological order. Iterative, with the
 * recursion made an explicit frame stack, so a long chain of nodes cannot overflow the call
 * stack; the visit order — and so every SCC id — is exactly the recursive one's.
 */
function tarjan(
  names: readonly string[],
  succ: ReadonlyMap<string, readonly string[]>,
): { sccOf: Map<string, number>; sccs: string[][] } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccOf = new Map<string, number>();
  const sccs: string[][] = [];
  let counter = 0;

  const enter = (v: string, frames: TarjanFrame[]): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    frames.push({ v, next: succ.get(v) ?? [], pos: 0 });
  };
  /** Every successor of `v` visited: pop its SCC if `v` is the root of one. */
  const leave = (v: string): void => {
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      scc.push(w);
      sccOf.set(w, sccs.length);
    } while (w !== v);
    sccs.push(scc);
  };

  for (const root of names) {
    if (index.has(root)) continue;
    const frames: TarjanFrame[] = [];
    enter(root, frames);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const w = frame.next[frame.pos];
      if (w !== undefined) {
        frame.pos++;
        if (!index.has(w)) enter(w, frames);
        else if (onStack.has(w)) low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        continue;
      }
      frames.pop();
      leave(frame.v);
      // The return from the recursive call: the caller's low-link takes the callee's.
      const caller = frames[frames.length - 1];
      if (caller !== undefined) low.set(caller.v, Math.min(low.get(caller.v)!, low.get(frame.v)!));
    }
  }
  return { sccOf, sccs };
}
