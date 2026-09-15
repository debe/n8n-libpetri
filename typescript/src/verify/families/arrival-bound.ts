/**
 * The arrival bound of every join / OR input: how many arrivals its gadget can hold at once
 * (README "OR-inputs", ADR 0003), recorded as proper completion's bound rows.
 */
import type { Place } from 'libpetri';
import type { CompiledWorkflow } from '../../compiler/index.js';
import { recordBound } from '../record.js';
import type { Context } from '../route.js';

/** One join / OR input and the places its arrivals land on. */
type JoinReadyGroup = CompiledWorkflow['joinReadyPlaces'][number];

/**
 * The **arrival capacity** of a join / OR input: how many arrivals its gadget can hold at
 * once, and which of the two gadgets it is.
 *
 * A join / choose-branch input has one slot: every `arm` consumes `free_i` and only
 * `X_start` / `X_skip` refund it (ADR 0003), so `free_i + ready_i ≤ 1` holds **by
 * construction** and a violation would mean the compiler broke the gadget. The OR form
 * aggregates a round of `n` deliveries with no slot token at all (README "OR-inputs"), and
 * `placeBound(ready_i, n)` there is the query `docs/divergences.md` row #8 names — the form
 * where a violation is a real finding, and the one M4's SMT route could not decide.
 */
function arrivalCapacity(ctx: Context, node: string, inputIndex: number): { capacity: number; round: boolean } {
  const input = ctx.map.node(node).inputs.find((i) => i.index === inputIndex);
  return input === undefined || input.slot !== 'or'
    ? { capacity: 1, round: false }
    : { capacity: input.round, round: true };
}

/** The arrival bound of each place of one join / OR input, against that input's capacity. */
export async function recordArrivalBounds(ctx: Context, group: JoinReadyGroup): Promise<void> {
  const { capacity, round } = arrivalCapacity(ctx, group.node, group.inputIndex);
  for (const place of group.places) {
    await recordArrivalBound(ctx, group.node, group.inputIndex, place, capacity, round);
  }
}

/**
 * How many arrivals can queue on one join / OR input at once (README "OR-inputs").
 *
 * Its undecided reason is `recordBound`'s: an `unknown` here can only come from the SMT route
 * (the graph decides a bound outright or declines), and the SMT route is only reached on a
 * graph that did not close, so the truncation half is always part of it.
 */
async function recordArrivalBound(
  ctx: Context, node: string, inputIndex: number, place: Place<unknown>, capacity: number, round: boolean,
): Promise<void> {
  const where = `${node}'s input ${inputIndex}`;
  await recordBound(ctx, {
    property: 'proper-completion',
    name: round
      ? `${node} input ${inputIndex} queues at most ${capacity} arrival${capacity === 1 ? '' : 's'} per round`
      : `${node} input ${inputIndex} keeps its join slot discipline`,
    subject: { kind: 'join-input', node, inputIndex, place: place.name },
    place,
    bound: capacity,
    explanation: {
      proven: round
        ? `${where} never holds more than ${capacity} arrival(s), so a round cannot over-fill and the ` +
          'positional pairing of divergence #8 cannot bite on it. This bounds pile-up; whether anything ' +
          'strands is the check below.'
        : `${where} never holds more than one arrival at a time, so the slot discipline of ADR 0003 ` +
          '(free_i + ready_i <= 1) holds. That bound holds by construction on a join input — every arm ' +
          'consumes the slot and only X_start / X_skip refund it — so this re-checks the gadget against ' +
          'the compiled net rather than detecting anything.',
      violated: round
        ? `More than ${capacity} arrival(s) can pile up on ${where}: arrivals are paired positionally, ` +
          'so the pairing is decided by arrival order (divergence #8).'
        : `${where} can hold two arrivals at once: the join slot discipline of ADR 0003 is broken — an ` +
          'arm armed the input without taking its free token, or something refunded the slot twice.',
      unknown: `Whether ${where} can hold more than ${capacity} arrival(s) was not decided.`,
    },
  });
}
