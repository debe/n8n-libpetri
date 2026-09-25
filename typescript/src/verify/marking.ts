/**
 * A compiler marking as the verifier's count vector, shared by the v1 report (`verify.ts`) and
 * the `engineV2` one (`settlement.ts`).
 */
import type { Place, Token } from 'libpetri';
import { MarkingState } from 'libpetri/verification';

/** A compiler marking (tokens per place) as the verifier's count vector (VER-004: values are irrelevant). */
export function markingStateOf(marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): MarkingState {
  const builder = MarkingState.builder();
  for (const [place, tokens] of marking) builder.tokens(place, tokens.length);
  return builder.build();
}
