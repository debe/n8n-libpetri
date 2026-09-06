/**
 * `verify(workflow)` — the property table, over the same net the scheduler executes.
 *
 * There is no verification net. {@link verify} calls `compile()` exactly as
 * `PetriScheduler` does and hands `compiled.net` to libpetri's `SmtVerifier`
 * (`spec/07-verification.md`), so every verdict is about the semantics production runs.
 * Counterexamples come back as node paths (`counterexample.ts`), never as place names.
 *
 * The six property families and what each one can and cannot say:
 *
 * 1. **proper completion** — `joinedOrDeadLettered(p)` (NU-040) on every join-input
 *    `ready_i` place and every edge data place, with `_pause` and `_halted` declared as the
 *    **only** sinks (VER-002), plus a `placeBound` on each `ready_i` — a weaker question
 *    (how many arrivals can queue there at once) that, unlike the quiescence query, closes
 *    on a real workflow. `joinedOrDeadLettered` ignores the declared sinks (NU-040 AC4), so
 *    a violation whose witness is a paused or halted marking is downgraded to `unknown`
 *    rather than reported: see {@link PAUSE_WITNESS_REASON}. `joinedOrDeadLettered` encodes
 *    "reachable ∧ quiescent ∧ M(p) ≥ 1" for *any* place — it is not ν-specific.
 *    `deadlockFree` is the wrong question here, for a reason that does not depend on how
 *    libpetri words it. Its error condition today (VER-002, since the `terminatesAtSink`
 *    split) is "quiescent ∧ some marked place is not a declared sink" — stranding-based, and
 *    a *successful* run of a compiled workflow quiesces holding every `X/idle`, every
 *    `X/done` and `X/skipped` marker, the refunded `_budget` units, every unspent `X/tries`
 *    and every spent `empty` token, so the whole-net question is violated by every clean
 *    execution unless most of the net is declared a sink. And even the legitimate sink set
 *    would still fire on a *paused* marking, whose unconsumed arrival on an `in` place is
 *    the marking codec's business (ADR 0005) and not a stranding. The question has to be
 *    asked per place.
 * 2. **dead nodes** — `unreachable({X/running})` per node. Only libpetri's *proven*
 *    direction becomes a verdict: it means the node can never run, which is the finding, so
 *    the check reports `violated` (`types.ts`). libpetri's `violated` — a witness that
 *    reaches the running place — is **not** reported as `proven`: the encoding is untimed,
 *    priority-blind and value-blind (VER-004), every `xor` branch of a router is explored
 *    whatever the data, and VER-004 AC3 licenses the proof direction only. A node the
 *    solver says is reachable is therefore `unknown` (see {@link LIVENESS_REASON}), and so
 *    is a node that is dead only because n8n starts **one trigger per execution** — another
 *    entry point of a multi-trigger workflow, or a node only that entry point feeds
 *    (see {@link alternativeEntryReach}).
 * 3. **no double activation** — `placeBound(X/running, 1)`: the `X/idle` mutex made
 *    structural (`X/idle + X/running = 1` is a found P-invariant, ADR 0004).
 * 4. **budget** — `placeBound(_budget, k)` plus the two-phase P-semiflow
 *    `w·_budget + w·Σ(running + ok + retry) = w·k` read off the validated invariants. A net
 *    whose budget were a self-loop (consumed and refunded by one transition) would prove the
 *    bound trivially: the incidence column is zero, so the encoder never sees the place move.
 *    The two-phase gadget is what makes this bound mean something.
 * 5. **retry bound** — `placeBound(X/tries, maxTries − 1)` **plus** a structural check that
 *    no transition of the net produces `X/tries`. The place bound on its own only restates
 *    the seeding; it is the conjunction of the two that bounds the number of *attempts*.
 * 6. **mutual exclusion** — `mutualExclusion(A/running, B/running)` for caller-supplied
 *    pairs, or every pair. At k = 1 every pair is provable, which is a sanity check of the
 *    budget model rather than a workflow property; at k ≥ 2 it is violated for independent
 *    nodes, which is the point of the budget.
 *
 * What no verdict here can say (VER-004): the encoding is **priority-blind** and
 * **value-blind**. Nothing about firing *order* — n8n's depth-first walk, `executionIndex`,
 * the divergence register's ordering rows — is provable from it, and no verdict depends on
 * what a node returns. Timing is ignored too, which only strengthens a proof (timing can
 * restrict behaviour, never add it).
 *
 * Without a usable z3 every verdict is `unknown` with a reason naming `PATH` and
 * `LIBPETRI_Z3` (VER-013). Nothing here throws on a solver problem.
 */
import { performance } from 'node:perf_hooks';
import { compile } from '../compiler/index.js';
import type { CompiledWorkflow, NetMapView, NodeGadget, WorkflowDescription } from '../compiler/index.js';
import type { Place, Token } from 'libpetri';
import {
  MarkingState, SmtVerifier, flatten, formatZ3Version, joinedOrDeadLettered, mutualExclusion,
  placeBound, resolveZ3, unreachable,
  type FlatNet, type PInvariant, type SmtProperty, type SmtVerificationResult, type Z3Solver,
} from 'libpetri/verification';
import { decodeCounterexample } from './counterexample.js';
import type {
  CheckSubject, CheckVerdict, Counterexample, InvariantSummary, MutualExclusionRequest, PropertyCheck,
  PropertyName, SolverInfo, VerificationReport, VerifyOptions,
} from './types.js';
import { PROPERTY_NAMES } from './types.js';

/** Per-query z3 timeout when the caller names none. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Property families run when the caller names none: everything a workflow always has. */
export const DEFAULT_PROPERTIES: readonly PropertyName[] = [
  'budget', 'no-double-activation', 'dead-nodes', 'retry-bound', 'proper-completion',
];

// ==================== solver ====================

/** Resolves z3 once per run (VER-013); a failure is a reason string, never a throw. */
export function resolveSolver(env: NodeJS.ProcessEnv = process.env): SolverInfo {
  try {
    const solver: Z3Solver = resolveZ3(env);
    return {
      available: true,
      program: solver.program,
      version: formatZ3Version(solver.version),
      reason: null,
    };
  } catch (e) {
    return {
      available: false,
      program: null,
      version: null,
      reason:
        'no usable z3 executable resolved: put z3 >= 4.8.0 on PATH or point LIBPETRI_Z3 at one ' +
        `(${messageOf(e)})`,
    };
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ==================== marking ====================

/** A compiler marking (tokens per place) as the verifier's count vector (VER-004: values are irrelevant). */
export function markingStateOf(marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): MarkingState {
  const builder = MarkingState.builder();
  for (const [place, tokens] of marking) builder.tokens(place, tokens.length);
  return builder.build();
}

// ==================== invariants ====================

/**
 * libpetri's canonical report lines (VER-013 fixes them byte for byte across the four
 * implementations), which is the only public way to read the **post-validation** counts:
 * the exact BigInt re-check that drops a row runs inside `verify()` and its helper is not
 * package API. Re-deriving them here with `computePInvariants` would report rows libpetri
 * then discarded — an over-count, on exactly the reset-arc chains this net has.
 */
const FOUND_LINE = /^ {2}Found: (\d+) P-invariant\(s\)$/m;
const SEMIFLOW_LINE = /^ {2}Semiflows encoded as invariants: (\d+)$/m;

function countFrom(report: string, pattern: RegExp): number | null {
  const m = pattern.exec(report);
  return m === null ? null : Number(m[1]);
}

/** Place name → weight for one invariant, over the flattened net's place order. */
export function invariantTerms(invariant: PInvariant, flat: FlatNet): Map<string, number> {
  const terms = new Map<string, number>();
  for (const index of invariant.support) {
    const place = flat.places[index];
    if (place === undefined) continue;
    terms.set(place.name, invariant.weights[index] ?? 0);
  }
  return terms;
}

/** `2*_budget + 2*A/running + A/ok_0 + … = 2` — the same shape libpetri prints. */
export function renderInvariant(invariant: PInvariant, flat: FlatNet): string {
  const parts: string[] = [];
  for (const [name, weight] of [...invariantTerms(invariant, flat)].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (weight === 0) continue;
    parts.push(weight === 1 ? name : `${weight}*${name}`);
  }
  return `${parts.join(' + ')} = ${invariant.constant}`;
}

/**
 * The two-phase budget semiflow, if the verifier kept it: a law giving `_budget` and every
 * `X/running` the same positive weight `w`, summing to `w·k`, and touching at least one
 * in-flight place of every node that has one (`X/ok`, the split-routing `X/ok_o` /
 * `X/routed_o`, or `X/retry`). A node holds its unit from `X_start` to `X_route`, so those
 * places are exactly where the unit sits while it is not in `_budget` (ADR 0004).
 *
 * "At least one", not "all": a node with `n` connected outputs routes per output
 * (`SPLIT_ROUTING_ABOVE`), and the Farkas enumeration then returns **one law per output**
 * — `_budget + … + X/ok_o + X/routed_o + X/running + … = w·k` for each `o` — rather than one
 * law folding all `n` in at weight `w/n`. Every one of them is the conservation law; the
 * first is returned.
 */
export function budgetSemiflowOf(
  invariants: readonly PInvariant[], flat: FlatNet, map: NetMapView, budget: number,
): PInvariant | null {
  for (const invariant of invariants) {
    const terms = invariantTerms(invariant, flat);
    const w = terms.get(map.shared.budget.name) ?? 0;
    if (w <= 0 || invariant.constant !== w * budget) continue;
    if (map.nodes.every((g) => nodeCarriesUnit(g, terms, w))) return invariant;
  }
  return null;
}

function nodeCarriesUnit(g: NodeGadget, terms: ReadonlyMap<string, number>, w: number): boolean {
  if ((terms.get(g.running.name) ?? 0) !== w) return false;
  const inFlight = [
    g.ok,
    g.retry,
    ...g.outputs.flatMap((o) => [o.ok, o.routed]),
  ].filter((p): p is Place<unknown> => p !== null);
  return inFlight.length === 0 || inFlight.some((p) => (terms.get(p.name) ?? 0) > 0);
}

// ==================== the run ====================

interface QueryOutcome {
  readonly verdict: CheckVerdict;
  readonly reason: string | null;
  readonly method: string | null;
  readonly result: SmtVerificationResult | null;
  readonly elapsedMs: number;
}

interface Context {
  readonly compiled: CompiledWorkflow;
  readonly map: NetMapView;
  readonly state: MarkingState;
  readonly flat: FlatNet;
  readonly timeoutMs: number;
  readonly semiflowInvariants: boolean;
  readonly solver: SolverInfo;
  /** Node → the alternative entry point that is the only reason it cannot run here. */
  readonly entryReach: ReadonlyMap<string, string>;
  readonly checks: PropertyCheck[];
  readonly onCheck: ((check: PropertyCheck) => void) | undefined;
  /** The invariant list of the first result that carried one: what the encoder actually saw. */
  invariants: readonly PInvariant[] | null;
  /** That result's report, for the two canonical count lines. */
  invariantReport: string | null;
}

/**
 * Runs one property. Never throws: a solver problem, a CORE-043 rejection or any other
 * failure becomes `unknown` with the message as the reason (VER-013).
 */
async function query(ctx: Context, property: SmtProperty, sinks: readonly Place<unknown>[]): Promise<QueryOutcome> {
  if (!ctx.solver.available) {
    return { verdict: 'unknown', reason: ctx.solver.reason, method: null, result: null, elapsedMs: 0 };
  }
  const started = performance.now();
  try {
    const verifier = SmtVerifier.forNet(ctx.compiled.net)
      .initialMarking(ctx.state)
      .semiflowInvariants(ctx.semiflowInvariants)
      .timeout(ctx.timeoutMs)
      .property(property);
    if (sinks.length > 0) verifier.sinkPlaces(...sinks);
    const result = await verifier.verify();
    if (ctx.invariants === null && result.invariants.length > 0) {
      ctx.invariants = result.invariants;
      ctx.invariantReport = result.report;
    }
    return {
      verdict: result.verdict.type,
      reason: result.verdict.type === 'unknown' ? result.verdict.reason : null,
      method: result.verdict.type === 'proven' ? result.verdict.method : result.verdict.type === 'violated' ? 'IC3/PDR' : null,
      result,
      elapsedMs: performance.now() - started,
    };
  } catch (e) {
    return {
      verdict: 'unknown',
      reason: `verification failed: ${messageOf(e)}`,
      method: null,
      result: null,
      elapsedMs: performance.now() - started,
    };
  }
}

function record(
  ctx: Context,
  check: Omit<PropertyCheck, 'counterexample'> & { readonly counterexample?: PropertyCheck['counterexample'] },
): void {
  const full: PropertyCheck = { counterexample: null, ...check };
  ctx.checks.push(full);
  ctx.onCheck?.(full);
}

/**
 * The place(s) a property names, for the report. The `default` is deliberate rather than an
 * exhaustive switch: `SmtProperty` is a libpetri union that gains members (VER-002 added
 * `terminates-at-sink`), and a property this module does not use must not break its build.
 */
function placeOf(property: SmtProperty): string | null {
  switch (property.type) {
    case 'place-bound':
    case 'branch-place-bound':
      return property.place.name;
    case 'joined-or-dead-lettered':
      return property.pending.name;
    case 'mutual-exclusion':
      return `${property.p1.name}, ${property.p2.name}`;
    case 'unreachable':
      return [...property.places].map((p) => p.name).join(', ');
    default:
      return null;
  }
}

function queryRecord(
  property: SmtProperty, outcome: QueryOutcome, sinks: readonly Place<unknown>[],
): PropertyCheck['query'] {
  return {
    property: property.type,
    place: placeOf(property),
    verdict: outcome.verdict,
    sinks: sinks.map((p) => p.name),
    method: outcome.method,
  };
}

// ==================== properties ====================

/**
 * Why a proper-completion violation is downgraded to `unknown` rather than reported.
 *
 * `joinedOrDeadLettered` carries **no sink clause by design** (NU-040 AC4: "a declared sink
 * must not excuse a stranded group"), so `sinkPlaces(_pause, _halted)` does not reach this
 * property's error condition — only `deadlockFree` and `terminatesAtSink` read the declared
 * sinks. The declaration is kept because it is the intent VER-002 would need, but it is
 * inert today, and without it every quiescent marking counts — including the two the model
 * *designs*: a paused run (`_pause`, from a Wait node or a destination stop) and a halted
 * one (`_halted`). In a paused marking an unconsumed arrival on an `in` / `ready` place is
 * not stranded at all — it is exactly what the marking codec writes back into n8n's
 * `nodeExecutionStack` (ADR 0005). Since every node's `X_run` offers the waiting and stopped
 * outcomes, that witness exists in every workflow with two sibling branches, and reporting
 * it would make the property fire on every fan-out.
 *
 * So a violation whose witness marking holds `_pause` or `_halted` is not a finding. It is
 * also not a proof: Spacer returns one witness, and a real stranding may exist behind it —
 * hence `unknown`, with the witness kept for inspection.
 */
const PAUSE_WITNESS_REASON =
  'the only witness the solver returned is a paused or halted run — a designed terminal marking ' +
  'whose unconsumed arrivals the marking codec writes back, not a stranding. joinedOrDeadLettered ' +
  'carries no sink clause (NU-040 AC4), so declaring _pause and _halted as sinks cannot exclude it, ' +
  'and the query cannot separate a real stranding from a pause';

/** True when the witness marking holds `_pause`, `_halt` or `_halted`. */
function witnessIsDesignedTerminal(cex: Counterexample | null): boolean {
  return cex !== null && cex.stuckMarking.some(
    (p) => p.node === null && (p.role === 'pause' || p.role === 'halt' || p.role === 'halted'));
}

/**
 * The **arrival capacity** of a join / OR input: how many arrivals its gadget can hold at
 * once, and which of the two gadgets it is.
 *
 * A join / choose-branch input has one slot: every `arm` consumes `free_i` and only
 * `X_start` / `X_skip` refund it (ADR 0003), so `free_i + ready_i ≤ 1` holds **by
 * construction** and `placeBound(ready_i, 1)` cannot come back `violated` on a net this
 * compiler produced. The query is still worth its 400 ms — it re-checks the gadget against
 * the net that was actually built, and a compiler change that broke the discipline would
 * show up here — but it is *not* a detector for the arrival-order class of divergence #8.
 * That class lives on the OR form, which aggregates a round of `n` deliveries with no slot
 * token at all (README "OR-inputs"), and where `placeBound(ready_i, n)` is exactly the query
 * `docs/divergences.md` row #8 names.
 */
function arrivalCapacity(ctx: Context, node: string, inputIndex: number): { capacity: number; round: boolean } {
  const input = ctx.map.node(node).inputs.find((i) => i.index === inputIndex);
  return input?.round === null || input?.round === undefined
    ? { capacity: 1, round: false }
    : { capacity: input.round, round: true };
}

/** README "Join gadget" / "OR-inputs": the `ready_i` place is where a stranded arrival sits. */
async function runProperCompletion(ctx: Context): Promise<void> {
  const sinks = [ctx.map.shared.pause, ctx.map.shared.halted];
  for (const group of ctx.compiled.joinReadyPlaces) {
    // The *bound* on the ready place — how many arrivals can queue — is a different and
    // much weaker question than "does one strand", and unlike the quiescence query it
    // closes (docs/verification.md). A violation is the arrival-count class of
    // divergence #8: more arrivals reached the input than its gadget can pair.
    const { capacity, round } = arrivalCapacity(ctx, group.node, group.inputIndex);
    for (const place of group.places) {
      const property = placeBound(place, capacity);
      const outcome = await query(ctx, property, []);
      const where = `${group.node}'s input ${group.inputIndex}`;
      record(ctx, {
        property: 'proper-completion',
        name: round
          ? `${group.node} input ${group.inputIndex} queues at most ${capacity} arrival${capacity === 1 ? '' : 's'} per round`
          : `${group.node} input ${group.inputIndex} keeps its join slot discipline`,
        subject: { kind: 'join-input', node: group.node, inputIndex: group.inputIndex, place: place.name },
        verdict: outcome.verdict,
        explanation: outcome.verdict === 'proven'
          ? round
            ? `${where} never holds more than ${capacity} arrival(s), so a round cannot over-fill and the ` +
              'positional pairing of divergence #8 cannot bite on it. This bounds pile-up; it does not ' +
              'prove nothing strands (see below).'
            : `${where} never holds more than one arrival at a time, so the slot discipline of ADR 0003 ` +
              '(free_i + ready_i <= 1) holds. That bound holds by construction on a join input — every arm ' +
              'consumes the slot and only X_start / X_skip refund it — so this re-checks the gadget against ' +
              'the compiled net; it is neither a proof that nothing strands nor the arrival-order query of ' +
              'divergence #8, which is the OR-round form (see below).'
          : outcome.verdict === 'violated'
            ? round
              ? `More than ${capacity} arrival(s) can pile up on ${where}: arrivals are paired positionally, ` +
                'so the pairing is decided by arrival order (divergence #8).'
              : `${where} can hold two arrivals at once: the join slot discipline of ADR 0003 is broken — an ` +
                'arm armed the input without taking its free token, or something refunded the slot twice.'
            : `Whether ${where} can hold more than ${capacity} arrival(s) was not decided.`,
        reason: outcome.reason,
        elapsedMs: outcome.elapsedMs,
        query: queryRecord(property, outcome, []),
        counterexample: counterexampleFor(outcome, ctx),
      });
    }
    for (const place of group.places) {
      const property = joinedOrDeadLettered(place);
      const outcome = await query(ctx, property, sinks);
      const { verdict, reason, counterexample } = classifyQuiescence(outcome, ctx);
      const subject: CheckSubject = {
        kind: 'join-input', node: group.node, inputIndex: group.inputIndex, place: place.name,
      };
      record(ctx, {
        property: 'proper-completion',
        name: `${group.node} input ${group.inputIndex} always completes`,
        subject,
        verdict,
        explanation: verdict === 'proven'
          ? `No reachable quiescent marking leaves an arrival waiting on ${group.node}'s input ${group.inputIndex}.`
          : verdict === 'violated'
            ? `${group.node} can be left with an arrival stranded on input ${group.inputIndex}: the run quiesces ` +
              'with that token still waiting, which is what n8n discovers at runtime as a stuck Merge.'
            : `Whether an arrival can strand on ${group.node}'s input ${group.inputIndex} was not decided.`,
        reason,
        elapsedMs: outcome.elapsedMs,
        query: queryRecord(property, outcome, sinks),
        counterexample,
      });
    }
  }
  for (const place of ctx.compiled.edgeDataPlaces) {
    const info = ctx.map.place(place.name);
    const consumer = info?.node ?? '(unknown)';
    const edge = info?.edge;
    const property = joinedOrDeadLettered(place);
    const outcome = await query(ctx, property, sinks);
    const { verdict, reason, counterexample } = classifyQuiescence(outcome, ctx);
    const subject: CheckSubject = {
      kind: 'edge',
      node: consumer,
      place: place.name,
      ...(edge === undefined ? {} : { from: edge.from, outputIndex: edge.outputIndex, inputIndex: edge.inputIndex }),
    };
    const where = edge === undefined
      ? `${consumer}'s input`
      : `the edge ${edge.from}.${edge.outputIndex} -> ${edge.to}.${edge.inputIndex}`;
    record(ctx, {
      property: 'proper-completion',
      name: `${where} is always consumed`,
      subject,
      verdict,
      explanation: verdict === 'proven'
        ? `No reachable quiescent marking leaves a payload on ${where}.`
        : verdict === 'violated'
          ? `A payload can be left undelivered on ${where}: ${consumer} never consumes it and the run quiesces.`
          : `Whether a payload can be left on ${where} was not decided.`,
      reason,
      elapsedMs: outcome.elapsedMs,
      query: queryRecord(property, outcome, sinks),
      counterexample,
    });
  }
}

/**
 * A quiescence query's outcome, with a violation whose witness is one of the two designed
 * terminal markings downgraded to `unknown` (see {@link PAUSE_WITNESS_REASON}). The witness
 * stays attached either way — it is the evidence for the downgrade.
 */
function classifyQuiescence(outcome: QueryOutcome, ctx: Context): {
  verdict: CheckVerdict; reason: string | null; counterexample: Counterexample | null;
} {
  const counterexample = outcome.result === null || outcome.verdict !== 'violated'
    ? null
    : decodeCounterexample(outcome.result, ctx.map);
  if (outcome.verdict === 'violated' && witnessIsDesignedTerminal(counterexample)) {
    return { verdict: 'unknown', reason: PAUSE_WITNESS_REASON, counterexample };
  }
  return { verdict: outcome.verdict, reason: outcome.reason, counterexample };
}

function counterexampleFor(outcome: QueryOutcome, ctx: Context): PropertyCheck['counterexample'] {
  if (outcome.result === null || outcome.verdict !== 'violated') return null;
  return decodeCounterexample(outcome.result, ctx.map);
}

/**
 * Why a node the solver says is *reachable* is `unknown` and never `proven`.
 *
 * `unreachable(P)` is a safety property, so only its `proven` direction transfers: VER-004
 * AC3 says a proof on the untimed net implies the property for all timed executions, and
 * says nothing about a witness. libpetri's `violated` here is a firing sequence in an
 * abstraction that is untimed, **priority-blind** and **value-blind** — every `xor` branch
 * of a routing transition is explored whatever the data (VER-004 AC2) — so "the IF sent
 * items down this branch" is available to the solver on a workflow where no run ever does
 * it. Reporting that as "the node is live" would be a claim the encoding cannot support,
 * and it would be counted among the proofs.
 */
const LIVENESS_REASON =
  'the running place is reachable only in the untimed, priority-blind and value-blind ' +
  'over-approximation (VER-004): every xor branch of a router is explored whatever the data, ' +
  'so this witness does not establish that a real run reaches the node. VER-004 AC3 licenses ' +
  'the proof direction only — liveness is not provable by this encoding';

/**
 * Nodes that can never run in **this** compiled execution only because n8n starts one
 * trigger per execution: an entry point (a node whose type declares no input) that is not
 * the start node the workflow was compiled with, plus everything reachable from it and from
 * no start node. `initialMarking` seeds only `startNodes[0]`'s own input (README "Initial
 * marking and the marking codec"), so `unreachable({X/running})` really is `proven` for
 * them — but a Manual-plus-Webhook workflow is an ordinary n8n pattern, not a defect, and
 * reporting one as a finding would fail the CLI's exit-code gate on a healthy workflow.
 *
 * A node with no incoming connection whose *shape* has an input is **not** an entry point:
 * n8n can never start there, so a dead one is a real finding (the `Orphan` fixture).
 *
 * Returns node name → the entry point it belongs to (an entry point maps to itself).
 */
export function alternativeEntryReach(compiled: CompiledWorkflow): Map<string, string> {
  const analysis = compiled.analysis;
  const starts = new Set(compiled.startNodes);
  const found = new Map<string, string>();
  for (const a of analysis.nodes) {
    const entry = a.node.name;
    if (starts.has(entry) || a.shape.inputCount !== 0 || analysis.reachable.has(entry)) continue;
    const stack = [entry];
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (found.has(name)) continue;
      found.set(name, entry);
      // A node a start node reaches is not dead at all, and must not be excused here.
      for (const e of analysis.outgoing.get(name) ?? []) {
        if (!analysis.reachable.has(e.to) && !found.has(e.to)) stack.push(e.to);
      }
    }
  }
  return found;
}

/** `unreachable({X/running})`: only the *proven* direction is a verdict (see {@link LIVENESS_REASON}). */
async function runDeadNodes(ctx: Context): Promise<void> {
  for (const g of ctx.map.nodes) {
    const property = unreachable(new Set([g.running]));
    const outcome = await query(ctx, property, []);
    const entry = ctx.entryReach.get(g.node);
    const dead = outcome.verdict === 'proven';
    const verdict: CheckVerdict = dead && entry === undefined ? 'violated' : 'unknown';
    const structural = g.reachable ? '' : ' The compiler already marks it unreachable from every start node.';
    const confirmed = outcome.result?.counterexampleConfirmed === true;
    const entryReason = entry === undefined
      ? null
      : `n8n starts one trigger per execution and this net was compiled with '${ctx.compiled.startNode}' ` +
        `as the start node, so ${entry === g.node ? 'this entry point' : `'${entry}'`} never fires here; ` +
        `re-run with the start node set to '${entry}' to verify the execution it starts`;
    record(ctx, {
      property: 'dead-nodes',
      name: `${g.node} can run`,
      subject: { kind: 'node', node: g.node, place: g.running.name },
      verdict,
      explanation: verdict === 'violated'
        ? `${g.node} can never run: no reachable marking ever puts a token on its running place.${structural}`
        : dead
          ? `${g.node} cannot run in an execution started from ${ctx.compiled.startNode}, but it is ` +
            `${entry === g.node ? 'another entry point of this workflow' : `reachable only from '${entry}', another entry point`}` +
            ' — an alternative entry point, not a dead node.'
          : outcome.verdict === 'violated'
            ? `${g.node} is reachable in the abstraction${confirmed ? ': the solver replayed a firing sequence to its running place' : ', though the replay did not confirm a firing sequence'}. ` +
              'That is not a proof that it is live (VER-004).'
            : `Whether ${g.node} can ever run was not decided.`,
      reason: verdict === 'violated'
        ? outcome.reason
        : dead
          ? entryReason
          : outcome.verdict === 'violated' ? LIVENESS_REASON : outcome.reason,
      elapsedMs: outcome.elapsedMs,
      query: queryRecord(property, outcome, []),
      // The witness of a reachable node is a path that runs it in the abstraction, not a
      // defect; the finding here is the dead node, and a dead node has no trace.
      counterexample: null,
    });
  }
}

/** `placeBound(X/running, 1)`: the `X/idle` mutex, structurally (ADR 0004). */
async function runNoDoubleActivation(ctx: Context): Promise<void> {
  for (const g of ctx.map.nodes) {
    const property = placeBound(g.running, 1);
    const outcome = await query(ctx, property, []);
    record(ctx, {
      property: 'no-double-activation',
      name: `${g.node} never runs twice at once`,
      subject: { kind: 'node', node: g.node, place: g.running.name },
      verdict: outcome.verdict,
      explanation: outcome.verdict === 'proven'
        ? `Two activations of ${g.node} can never overlap: X/idle + X/running = 1 holds on every reachable marking.`
        : outcome.verdict === 'violated'
          ? `${g.node} can be running twice at once — its X/idle mutex does not hold.`
          : `Whether two activations of ${g.node} can overlap was not decided.`,
      reason: outcome.reason,
      elapsedMs: outcome.elapsedMs,
      query: queryRecord(property, outcome, []),
      counterexample: counterexampleFor(outcome, ctx),
    });
  }
}

async function runBudget(ctx: Context): Promise<void> {
  const k = ctx.compiled.effectiveBudget;
  const property = placeBound(ctx.map.shared.budget, k);
  const outcome = await query(ctx, property, []);
  record(ctx, {
    property: 'budget',
    name: `at most ${k} node${k === 1 ? '' : 's'} in flight`,
    subject: { kind: 'place', place: ctx.map.shared.budget.name },
    verdict: outcome.verdict,
    explanation: outcome.verdict === 'proven'
      ? `_budget never exceeds ${k}, so at most ${k} activation${k === 1 ? '' : 's'} can hold a unit at once.`
      : outcome.verdict === 'violated'
        ? `_budget can exceed ${k}: a transition refunds a unit it did not take.`
        : `Whether _budget stays within ${k} was not decided.`,
    reason: outcome.reason,
    elapsedMs: outcome.elapsedMs,
    query: queryRecord(property, outcome, []),
    counterexample: counterexampleFor(outcome, ctx),
  });

  // The semiflow is read off the invariants the encoder was given, not asked of z3: it is a
  // structural fact, and its absence is not a violation but a gap in what can be proven.
  const invariants = ctx.invariants ?? (await collectInvariants(ctx));
  const semiflow = invariants === null ? null : budgetSemiflowOf(invariants, ctx.flat, ctx.map, k);
  record(ctx, {
    property: 'budget',
    name: 'the two-phase budget semiflow holds',
    subject: { kind: 'net' },
    verdict: semiflow === null ? 'unknown' : 'proven',
    explanation: semiflow === null
      ? 'No validated conservation law covers _budget together with every X/running: the budget unit ' +
        'cannot be tracked structurally, so the bound above rests on IC3 alone.'
      : `_budget + the in-flight places of every node is conserved at ${k}, so a unit is held from ` +
        'X_start to X_route and refunded exactly once (ADR 0004).',
    reason: semiflow === null
      ? 'the P-invariant computation returned no law giving _budget and every X/running the same positive weight'
      : null,
    elapsedMs: 0,
    query: {
      property: 'none',
      place: ctx.map.shared.budget.name,
      verdict: semiflow === null ? 'unknown' : 'proven',
      sinks: [],
      method: semiflow === null ? null : 'P-invariant',
    },
    counterexample: null,
  });
}

/** The flat transitions that **produce** tokens on `place`, read off the encoder's own post-vectors. */
export function producersOf(flat: FlatNet, place: Place<unknown>): string[] {
  const index = flat.placeIndex.get(place.name);
  if (index === undefined) return [];
  return flat.transitions.filter((t) => (t.postVector[index] ?? 0) > 0).map((t) => t.name);
}

/**
 * The retry bound is two checks, because the place bound alone does not entail it.
 *
 * `placeBound(X/tries, maxTries − 1)` is true in the initial marking — `X/tries` is seeded
 * with exactly that many tokens — and a net that *refunded* a try token would still satisfy
 * it while `X_retry_wait` fired without limit (a two-place net whose
 * `retry_wait: one(tries), one(go) → and(go, tries)` keeps `placeBound(tries, 2)` proven
 * forever, and `placeBound(tries, 1)` violated, so the query is live rather than vacuous).
 * What turns the bound into "at most `maxTries` attempts" is the structural fact that
 * **nothing produces `X/tries`**: it is seeded, consumed by `X_retry_wait` and read as an
 * inhibitor by `X_exhausted`. That half needs no solver — it is read off the flattened net
 * the encoder sees — and it is the half a future compiler change would break.
 */
async function runRetryBound(ctx: Context): Promise<void> {
  for (const g of ctx.map.nodes) {
    if (g.tries === null || g.maxTries === null) continue;
    const bound = g.maxTries - 1;
    const property = placeBound(g.tries, bound);
    const outcome = await query(ctx, property, []);
    record(ctx, {
      property: 'retry-bound',
      name: `${g.node}/tries never holds more than ${bound}`,
      subject: { kind: 'node', node: g.node, place: g.tries.name },
      verdict: outcome.verdict,
      explanation: outcome.verdict === 'proven'
        ? `${g.node}/tries never exceeds the ${bound} token(s) it is seeded with. On its own that bounds ` +
          'the try tokens, not the attempts — the attempt bound is the check below.'
        : outcome.verdict === 'violated'
          ? `${g.node}/tries can exceed ${bound}: something puts a try token back.`
          : `Whether ${g.node}/tries stays within ${bound} was not decided.`,
      reason: outcome.reason,
      elapsedMs: outcome.elapsedMs,
      query: queryRecord(property, outcome, []),
      counterexample: counterexampleFor(outcome, ctx),
    });

    const producers = producersOf(ctx.flat, g.tries);
    const attempts: CheckVerdict = producers.length > 0
      ? 'violated'
      : outcome.verdict === 'proven' ? 'proven' : 'unknown';
    record(ctx, {
      property: 'retry-bound',
      name: `${g.node} attempts at most ${g.maxTries} times`,
      subject: { kind: 'node', node: g.node, place: g.tries.name },
      verdict: attempts,
      explanation: attempts === 'proven'
        ? `No transition produces ${g.tries.name} and it never exceeds ${bound}, so X_retry_wait can fire at ` +
          `most ${bound} times and ${g.node} runs at most ${g.maxTries} times before X_exhausted.`
        : producers.length > 0
          ? `${producers.length} transition(s) produce ${g.tries.name} (${producers.join(', ')}), so the try ` +
            'tokens are refunded and the number of attempts is not bounded by the seeding.'
          : `Nothing produces ${g.tries.name}, but the bound on it was not established, so the attempt count ` +
            'is not bounded either.',
      reason: attempts === 'unknown' ? outcome.reason : null,
      elapsedMs: 0,
      query: {
        property: 'none',
        place: g.tries.name,
        verdict: producers.length > 0 ? 'violated' : 'proven',
        sinks: [],
        method: 'structural',
      },
      counterexample: null,
    });
  }
}

/** Node pairs, or every unordered pair in declaration order. */
export function exclusionPairs(map: NetMapView, request: MutualExclusionRequest): Array<readonly [string, string]> {
  if (request !== 'all-pairs') return request.map((p) => [p[0], p[1]] as const);
  const names = map.nodes.map((g) => g.node);
  const pairs: Array<readonly [string, string]> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) pairs.push([names[i]!, names[j]!] as const);
  }
  return pairs;
}

async function runMutualExclusion(ctx: Context, request: MutualExclusionRequest): Promise<void> {
  for (const [a, b] of exclusionPairs(ctx.map, request)) {
    const subject: CheckSubject = { kind: 'node-pair', nodes: [a, b] };
    let ga: NodeGadget;
    let gb: NodeGadget;
    try {
      ga = ctx.map.node(a);
      gb = ctx.map.node(b);
    } catch (e) {
      record(ctx, {
        property: 'mutual-exclusion',
        name: `${a} and ${b} never run at once`,
        subject,
        verdict: 'unknown',
        explanation: `The pair could not be resolved to two nodes of this workflow.`,
        reason: messageOf(e),
        elapsedMs: 0,
        query: { property: 'mutual-exclusion', place: null, verdict: 'unknown', sinks: [], method: null },
      });
      continue;
    }
    const property = mutualExclusion(ga.running, gb.running);
    const outcome = await query(ctx, property, []);
    record(ctx, {
      property: 'mutual-exclusion',
      name: `${a} and ${b} never run at once`,
      subject,
      verdict: outcome.verdict,
      explanation: outcome.verdict === 'proven'
        ? `${a} and ${b} can never be running at the same time.`
        : outcome.verdict === 'violated'
          ? `${a} and ${b} can be running at the same time.`
          : `Whether ${a} and ${b} can overlap was not decided.`,
      reason: outcome.reason,
      elapsedMs: outcome.elapsedMs,
      query: queryRecord(property, outcome, []),
      counterexample: counterexampleFor(outcome, ctx),
    });
  }
}

/**
 * One invariant-only pipeline run, for a report that ran no query that produced invariants
 * (no solver, or no property selected). `verify()` computes phases 1–3 before it resolves
 * z3, so this costs no solver process when there is none.
 */
async function collectInvariants(ctx: Context): Promise<readonly PInvariant[] | null> {
  if (ctx.invariants !== null) return ctx.invariants;
  try {
    const result = await SmtVerifier.forNet(ctx.compiled.net)
      .initialMarking(ctx.state)
      .semiflowInvariants(ctx.semiflowInvariants)
      .timeout(ctx.timeoutMs)
      .property(placeBound(ctx.map.shared.budget, ctx.compiled.effectiveBudget))
      .verify();
    ctx.invariants = result.invariants;
    ctx.invariantReport = result.report;
    return result.invariants;
  } catch {
    return null;
  }
}

// ==================== entry points ====================

/** Which property families to run: the caller's list, or the default plus any requested pairs. */
export function selectProperties(options: VerifyOptions): readonly PropertyName[] {
  if (options.properties !== undefined) {
    return PROPERTY_NAMES.filter((p) => options.properties!.includes(p));
  }
  return options.mutualExclusion === undefined
    ? DEFAULT_PROPERTIES
    : [...DEFAULT_PROPERTIES, 'mutual-exclusion'];
}

/** Compiles `workflow` exactly as the scheduler does, then verifies the net it produced. */
export async function verify(
  workflow: WorkflowDescription, options: VerifyOptions = {},
): Promise<VerificationReport> {
  const compiled = compile(workflow, { budget: options.budget ?? 1 });
  return verifyCompiled(compiled, options);
}

/** Verifies an already compiled workflow (the scheduler's own `CompiledWorkflow`). */
export async function verifyCompiled(
  compiled: CompiledWorkflow, options: VerifyOptions = {},
): Promise<VerificationReport> {
  const started = performance.now();
  const properties = selectProperties(options);
  const ctx: Context = {
    compiled,
    map: compiled.netMap,
    state: markingStateOf(compiled.initialMarking(options.triggerItems ?? null)),
    flat: flatten(compiled.net),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    semiflowInvariants: options.semiflowInvariants ?? true,
    solver: resolveSolver(),
    entryReach: alternativeEntryReach(compiled),
    checks: [],
    onCheck: options.onCheck,
    invariants: null,
    invariantReport: null,
  };

  // Cheapest first, so a streamed run says something useful before the expensive family:
  // proper completion is quiescence-based and is the one that can fail to close (see
  // docs/verification.md).
  if (properties.includes('budget')) await runBudget(ctx);
  if (properties.includes('no-double-activation')) await runNoDoubleActivation(ctx);
  if (properties.includes('retry-bound')) await runRetryBound(ctx);
  if (properties.includes('mutual-exclusion')) {
    await runMutualExclusion(ctx, options.mutualExclusion ?? 'all-pairs');
  }
  if (properties.includes('dead-nodes')) await runDeadNodes(ctx);
  if (properties.includes('proper-completion')) await runProperCompletion(ctx);

  const invariants = await collectInvariants(ctx);
  const report = ctx.invariantReport;
  const summary: InvariantSummary = {
    basis: report === null ? 0 : countFrom(report, FOUND_LINE) ?? 0,
    semiflowsEncoded: report === null ? 0 : countFrom(report, SEMIFLOW_LINE) ?? 0,
    encoded: invariants?.length ?? 0,
    budgetSemiflow: invariants === null
      ? null
      : (() => {
        const sf = budgetSemiflowOf(invariants, ctx.flat, ctx.map, compiled.effectiveBudget);
        return sf === null ? null : renderInvariant(sf, ctx.flat);
      })(),
  };

  const counts = { proven: 0, violated: 0, unknown: 0 };
  for (const c of ctx.checks) counts[c.verdict]++;

  return {
    workflow: compiled.net.name,
    structuralHash: compiled.structuralHash,
    requestedBudget: compiled.requestedBudget,
    budget: compiled.effectiveBudget,
    budgetRestriction: compiled.budgetRestriction,
    solver: ctx.solver,
    net: {
      places: compiled.net.places.size,
      transitions: compiled.net.transitions.size,
      flatTransitions: ctx.flat.transitions.length,
    },
    invariants: summary,
    timeoutMs: ctx.timeoutMs,
    properties,
    checks: ctx.checks,
    counts,
    ok: counts.violated === 0,
    diagnostics: compiled.diagnostics,
    shapeWarnings: options.shapeWarnings ?? [],
    elapsedMs: performance.now() - started,
  };
}
