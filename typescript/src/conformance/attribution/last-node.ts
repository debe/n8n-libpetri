/**
 * The `resultData.lastNodeExecuted` rule ({@link attributeLastNodeExecuted}): the field is a
 * function of the execution order alone, so a difference is row #5 or #16 — unless one of the
 * two names belongs to a node only one engine ran, which the one-sided rows must explain.
 */
import type { IRunData } from 'n8n-workflow';
import type { EngineName } from '../engines.js';
import type { AttributionContext } from './context.js';
import { oneSidedRuleFor, type OneSidedRule } from './one-sided.js';
import { divergence, unattributed, type Attribution } from './vocabulary.js';

type RunData = Readonly<Record<EngineName, IRunData>>;

/** The engine that alone ran `name`, or `undefined` when both or neither did. */
function ranOnlyIn(name: string, runData: RunData): EngineName | undefined {
  const inReference = runData.n8n[name] !== undefined;
  const inCandidate = runData.libpetri[name] !== undefined;
  if (inReference === inCandidate) return undefined;
  return inCandidate ? 'libpetri' : 'n8n';
}

/** The registered row that explains why only one engine ran `name`, if it did and one does. */
function oneSidedCauseOf(name: string | undefined, runData: RunData, ctx: AttributionContext): OneSidedRule | undefined {
  if (name === undefined) return undefined;
  const ranIn = ranOnlyIn(name, runData);
  return ranIn === undefined ? undefined : oneSidedRuleFor({ node: name, ranIn, ctx });
}

function ranInBoth(name: string | undefined, runData: RunData): boolean {
  return name !== undefined && runData.n8n[name] !== undefined && runData.libpetri[name] !== undefined;
}

/**
 * Attribute a difference in `resultData.lastNodeExecuted`; `null` when the two engines name
 * the same node. The field records which node ran last, a function of the execution order
 * alone: row #5 at k = 1, row #16 above it (where the field records the last node to
 * *complete*, its definition under concurrency) — provided both names belong to nodes that
 * ran in both engines. A name that belongs to a node only one engine ran is not a defect
 * when that node's runs are themselves attributed: the field then names the last node of a
 * run that legitimately differs (a starved join the net completed, a sibling that finished
 * inside the halt window, an entry n8n ran after a destination stop). Otherwise it is.
 */
export function attributeLastNodeExecuted(
  last: Readonly<Record<EngineName, string | undefined>>,
  runData: RunData,
  ctx: AttributionContext,
): Attribution | null {
  const { n8n: lastLeft, libpetri: lastRight } = last;
  if (lastLeft === lastRight) return null;
  const names = `'${lastLeft ?? 'undefined'}' / '${lastRight ?? 'undefined'}'`;
  const oneSided = oneSidedCauseOf(lastLeft, runData, ctx) ?? oneSidedCauseOf(lastRight, runData, ctx);
  if (oneSided !== undefined) {
    return divergence(oneSided.row, oneSided.mechanism,
      `${names}: the field names the last node to run, and one of them ran in one engine only for the reason divergence #${oneSided.row} records`);
  }
  if (!ranInBoth(lastLeft, runData) || !ranInBoth(lastRight, runData)) {
    return unattributed(`${names}: one of them never ran in one engine`);
  }
  const k = ctx.effectiveBudget;
  return divergence(k > 1 ? 16 : 5, 'last-node-executed', k > 1
    ? `both '${lastLeft}' and '${lastRight}' ran in both engines; at k=${k} the field records the last node to complete (row #16)`
    : `both '${lastLeft}' and '${lastRight}' ran in both engines: which of them ran *last* is the total order row #5 abandons`);
}
