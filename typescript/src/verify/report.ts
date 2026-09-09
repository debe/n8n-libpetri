/**
 * Rendering a {@link VerificationReport} for a terminal: a header, the property table, the
 * findings with their node paths, and the unproven list.
 *
 * Three rules the format follows. A violation is never printed as place names — the
 * counterexample is a node path (`counterexample.ts`), and the stuck marking is printed in
 * node / role terms with the place name in parentheses for anyone who wants to look it up.
 * An `unknown` is never silently dropped: it gets its own section with the reason, so a
 * run whose expensive property did not close cannot be mistaken for a clean bill of health.
 * And a `bounded` verdict gets a section of its own too, never the proven tally: it holds
 * over every run within the graph's closed prefix — counted in **runs of the workflow's
 * cyclic nodes**, which is what `loopTransitions` counts, so a two-node loop spends two per
 * pass of its body and the rendered line says both figures — and it says nothing beyond it,
 * so folding it into `proven` would be exactly the false proof this surface must not have.
 */
import { renderMarkedPlace, renderNodePath } from './counterexample.js';
import type { CheckSubject, PropertyCheck, VerificationReport } from './types.js';

const VERDICT_LABEL = {
  proven: 'PROVEN', violated: 'VIOLATED', bounded: 'BOUNDED', unknown: 'unknown',
} as const;

/** Which route answered: the solver-free graph, the SMT fallback, or neither. */
const ROUTE_LABEL = {
  'state-class-graph': 'graph', smt: 'z3', structural: 'struct', none: '-',
} as const;

/** `Merge input 0`, `A -> Merge.0`, `Set2`, `A | B`, `_budget`, `net`. */
export function renderSubject(subject: CheckSubject): string {
  switch (subject.kind) {
    case 'join-input':
      return `${subject.node} input ${subject.inputIndex}`;
    case 'edge':
      return subject.from === undefined
        ? `${subject.node} input`
        : `${subject.from}.${subject.outputIndex} -> ${subject.node}.${subject.inputIndex ?? 0}`;
    case 'node':
      return subject.node;
    case 'node-pair':
      return `${subject.nodes[0]} | ${subject.nodes[1]}`;
    case 'place':
      return subject.place;
    case 'net':
      return '(whole net)';
  }
}

function seconds(ms: number): string {
  if (ms === 0) return '-';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i] ?? 0))).join('  ').trimEnd());
}

/** The one-line header block: what was verified, against what, with which solver. */
export function renderHeader(report: VerificationReport): string[] {
  // Not "every verdict is unknown": since M5 the solver-free route decides everything a
  // complete graph decides, and saying otherwise contradicts the PROVEN rows on the same page.
  const solver = report.solver.available
    ? `z3 ${report.solver.version} (${report.solver.program}), ${(report.timeoutMs / 1000).toFixed(0)}s per query`
    : 'none — the SMT fallback cannot run; the solver-free route still decides what a complete graph ' +
      `decides (VER-010) (${report.solver.reason})`;
  const budget = report.budgetRestriction === null
    ? `k = ${report.budget}`
    : `k = ${report.budget} (requested ${report.requestedBudget}, lowered: ${report.budgetRestriction.reason} — ${report.budgetRestriction.detail})`;
  const invariants = report.invariants.encoded === 0
    ? 'not computed (no family needed them)'
    : `${report.invariants.basis} basis + ${report.invariants.semiflowsEncoded} semiflow(s) encoded ` +
      `= ${report.invariants.encoded} handed to the encoder (VER-007)`;
  return [
    `n8n-libpetri verify — ${report.workflow}`,
    ...table([
      ['  net', `${report.net.places} places, ${report.net.transitions} transitions, ${report.net.flatTransitions} flat (XOR-expanded, IO-016)`],
      ['  budget', budget],
      ['  state space', renderStateSpace(report)],
      ['  solver', solver],
      ['  invariants', invariants],
      ['  budget semiflow', report.invariants.budgetSemiflow
        ?? (report.invariants.encoded === 0
          ? 'not computed — the P-invariant pipeline runs only for the budget family'
          : 'not found among the validated invariants')],
      // Every query starts from `compiled.initialMarking(...)`, so a resumed or retried
      // execution — whose marking the codec rebuilds from n8n's own stack, and which need
      // not be reachable from M0 at all — is outside what any verdict here covers.
      ['  scope', 'markings reachable from the fresh initial marking; a resumed or retried execution starts from a codec-decoded marking outside that set'],
      ['  hash', report.structuralHash],
    ]),
  ];
}

/**
 * The solver-free route's line: how much was enumerated, whether it closed, and — when it
 * did not — what stopped it (one of {@link TruncationCause}'s four, which is measured rather
 * than assumed) plus, on a cyclic workflow, the bound its prefix closes. A truncated graph is
 * printed as such, because it is the difference between a proof and a bounded observation.
 */
export function renderStateSpace(report: VerificationReport): string {
  const space = report.stateSpace;
  if (space.error !== null) return `not built: ${space.error} — every check fell back to the solver`;
  const size = `${space.classes} classes in ${(space.elapsedMs / 1000).toFixed(1)}s, ` +
    `${space.quiescent} quiescent (${space.terminal} paused or halted)`;
  if (space.complete) return `${size}, complete (VER-010)`;
  if (space.truncation === 'off') {
    return `${size}, the solver-free route is off (maxClasses = ${space.requestedMaxClasses})`;
  }
  const why = space.truncation === 'cycle'
    ? 'the workflow has a cycle, so its state space is unbounded'
    : space.truncation === 'tool-calls'
      ? agentBudgets(space.agents)
      : space.truncation === 'parallelism'
        ? 'independent parallel branches (NU-053: no partial-order reduction)'
        : 'the class cap is below what this workflow needs (no cycle, no branching node)';
  const lowered = space.maxClasses < space.requestedMaxClasses
    ? ` (lowered from ${space.requestedMaxClasses} to fit the heap)`
    : '';
  // The bound is the only thing a truncated cyclic graph can still certify, so it belongs on
  // the same line as the truncation rather than buried in a per-check reason. It counts the
  // *runs of cyclic nodes*, not iterations of the loop body: on a two-node cycle one pass of
  // the body is two of them ({@link loopTransitions}).
  const bound = space.boundedCyclicRuns === null
    ? ''
    : `; ${space.expanded} classes expanded, closing every run of at most ` +
      `${space.boundedCyclicRuns} cyclic-node run(s) across ${space.loopSteps} cyclic node(s)`;
  return `${size}, TRUNCATED at the ${space.maxClasses}-class cap${lowered} — ${why}${bound}`;
}

/**
 * The one truncation with a knob. The graph explores every round size up to an agent's
 * tool-call budget — a product of per-tool and per-round counters, polynomial in both — so the fix is a smaller declared
 * budget, and the message says which agent, what it has now, and whether that number was the
 * workflow's or the scheduler's runtime default.
 */
function agentBudgets(agents: VerificationReport['stateSpace']['agents']): string {
  const each = agents.map((a) =>
    `'${a.node}' may make ${a.maxToolCalls} tool call(s) across ${a.tools} tool(s)` +
    (a.assumed ? ' (the scheduler default — nothing declared)' : ' (declared)'));
  return `an agent's tool-call budget: ${each.join('; ')}. The graph explores every round size up to ` +
    'the budget, so declare a small options.maxToolCalls on the agent for a complete graph — a ' +
    'declared budget is both the runtime cap and the width of the claim';
}

/**
 * One row per check: property, the check's own name, verdict, wall clock.
 *
 * The name and not the subject: a family can ask two different questions about one subject
 * (a join input gets both the quiescence query and the arrival bound), and two rows reading
 * `proper-completion  Merge input 0` with different verdicts would be unreadable.
 */
export function renderTable(checks: readonly PropertyCheck[]): string[] {
  const rows: string[][] = [['PROPERTY', 'CHECK', 'VERDICT', 'ROUTE', 'TIME']];
  for (const c of checks) {
    rows.push([c.property, c.name, VERDICT_LABEL[c.verdict], ROUTE_LABEL[c.query.route], seconds(c.elapsedMs)]);
  }
  return table(rows);
}

/** A violation with its node path and, for a stranding, the marking the run got stuck in. */
export function renderFinding(check: PropertyCheck, index: number): string[] {
  const lines = [`  ${index}. [${check.property}] ${check.explanation}`];
  const cex = check.counterexample;
  if (cex === null) return lines;
  lines.push(`     node path${cex.ordered ? '' : ' (unordered — the replay did not confirm a firing sequence)'}: ${renderNodePath(cex)}`);
  if (cex.stuckMarking.length > 0) {
    lines.push(`     marking at the violation: ${cex.stuckMarking.map(renderMarkedPlace).join('; ')}`);
  }
  return lines;
}

export function renderReport(report: VerificationReport): string {
  const lines: string[] = [...renderHeader(report), ''];
  // Before the diagnostics: a guessed shape changes which net the rest of the page is about.
  if (report.shapeWarnings.length > 0) {
    lines.push(`Guessed node shapes (${report.shapeWarnings.length}) — the compiled net may differ from the workflow`);
    for (const w of report.shapeWarnings) lines.push(`  - ${w}`);
    lines.push('');
  }
  if (report.diagnostics.length > 0) {
    lines.push('Compiler diagnostics');
    for (const d of report.diagnostics) lines.push(`  - ${d}`);
    lines.push('');
  }
  if (report.checks.length === 0) {
    lines.push('No checks ran (no property selected).', '');
    return lines.join('\n');
  }
  lines.push(...renderTable(report.checks), '');

  const violated = report.checks.filter((c) => c.verdict === 'violated');
  if (violated.length > 0) {
    lines.push(`Findings (${violated.length})`);
    violated.forEach((c, i) => lines.push(...renderFinding(c, i + 1)));
    lines.push('');
  }
  const bounded = report.checks.filter((c) => c.verdict === 'bounded');
  if (bounded.length > 0) {
    const k = report.stateSpace.boundedCyclicRuns;
    const steps = report.stateSpace.loopSteps;
    // The quantity is runs of the cyclic nodes, which is what `closedCyclicRuns` counts.
    // With `steps` of them on the cycle, `floor(k / steps)` complete passes of the body are
    // guaranteed; printing the raw count as "loop iterations" overstated it by that factor.
    const passes = k === null || steps <= 1 ? null : Math.floor(k / steps);
    lines.push(
      `Bounded (${bounded.length}) — holds for every run of at most ${k ?? '?'} cyclic-node run(s)` +
      `${passes === null ? '' : ` (at least ${passes} complete pass(es) of the ${steps} cyclic node(s))`}, ` +
      'which is sound and is not a proof');
    for (const c of bounded) lines.push(`  - ${c.property} / ${c.name}`);
    lines.push('');
  }
  const unknown = report.checks.filter((c) => c.verdict === 'unknown');
  if (unknown.length > 0) {
    lines.push(`Unproven (${unknown.length}) — not a clean result, just an undecided one`);
    for (const c of unknown) {
      lines.push(`  - ${c.property} / ${c.name}: ${c.reason ?? 'no reason given'}`);
    }
    lines.push('');
  }
  lines.push(
    `${report.counts.proven} proven, ${report.counts.violated} violated, ${report.counts.bounded} bounded, ` +
    `${report.counts.unknown} unknown in ${(report.elapsedMs / 1000).toFixed(1)}s`,
  );
  return lines.join('\n');
}
