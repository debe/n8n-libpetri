/**
 * The registered rows that make one engine run a node the other did not: shared by the
 * ordering report (an activation with no rank on one side, {@link attributeOneSided}) and by
 * the `lastNodeExecuted` rule (a last node only one engine ran). The table is in order of
 * specificity; anything no row claims is a finding.
 */
import type { EngineName } from '../engines.js';
import { activationNodeOf } from '../trace.js';
import type { AttributionContext } from './context.js';
import { inHaltWindow } from './halt-window.js';
import { divergence, unattributed, type Attribution } from './vocabulary.js';

/** A node one engine ran and the other did not, with what the rules read. */
export interface OneSidedRun {
  readonly node: string;
  readonly ranIn: EngineName;
  readonly ctx: AttributionContext;
}

/** One registered row that can explain a {@link OneSidedRun}. */
export interface OneSidedRule {
  readonly row: number;
  readonly mechanism: string;
  readonly applies: (run: OneSidedRun) => boolean;
  /** The reason, stated about `activation`, one of `run.node`'s activations. */
  readonly why: (activation: string, run: OneSidedRun) => string;
}

const ONE_SIDED_RULES: readonly OneSidedRule[] = [
  {
    row: 2,
    mechanism: 'stranded-join',
    applies: ({ node, ctx }) => ctx.strandedNodes.includes(node),
    why: (activation, { node, ranIn }) =>
      `'${activation}' ran in ${ranIn} only: '${node}' is a stranded join or downstream of one, so the two engines ran it a different number of times`,
  },
  {
    row: 1,
    mechanism: 'starved-join',
    applies: ({ node, ranIn, ctx }) => ranIn === 'libpetri' && (ctx.starvedNodes ?? []).includes(node),
    why: (activation) =>
      `'${activation}' ran under the net only: n8n left this join (or its ancestor) in waitingExecution and never ran it, while the net's explicit empty token completes the AND-join`,
  },
  {
    row: 13,
    mechanism: 'destination-stop',
    applies: ({ ranIn, ctx }) => ranIn === 'n8n' && ctx.destinationNode !== undefined,
    why: (activation, { ctx }) =>
      `'${activation}' ran in n8n only: after destination node '${ctx.destinationNode}' n8n keeps popping the stack, while the net deposits _pause and quiesces`,
  },
  {
    row: 17,
    mechanism: 'halt-window',
    applies: ({ ranIn, ctx }) => ranIn === 'libpetri' && inHaltWindow(ctx.candidateOutcome),
    why: (activation, { ctx }) =>
      `'${activation}' ran under the net only and the execution ${ctx.candidateOutcome}: the net cannot un-start an action, and the window lasts until _halt reaches the marking, so a sibling in flight finishes and one can even start inside it`,
  },
];

/** The most specific registered row that explains `run`, or `undefined`. */
export function oneSidedRuleFor(run: OneSidedRun): OneSidedRule | undefined {
  return ONE_SIDED_RULES.find((rule) => rule.applies(run));
}

/** Attribute an activation only `ranIn` ran: it did not move, so no order rule applies. */
export function attributeOneSided(activation: string, ranIn: EngineName, ctx: AttributionContext): Attribution {
  const run: OneSidedRun = { node: activationNodeOf(activation), ranIn, ctx };
  const rule = oneSidedRuleFor(run);
  if (rule === undefined) return unattributed(`'${activation}' ran in ${ranIn} only, and no registered row explains it`);
  return divergence(rule.row, rule.mechanism, rule.why(activation, run));
}
