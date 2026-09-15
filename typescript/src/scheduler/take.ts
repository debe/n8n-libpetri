/**
 * Reading the token a firing consumed: every action narrows its input through {@link take}, so a
 * token that is not the payload its place carries is reported once, by name, in one way.
 */
import type { Place, TransitionContext } from 'libpetri';
import { InternalSchedulerError } from './errors.js';

/**
 * A token a transition consumed that is not the payload the gadget puts on that place. The
 * compiler builds every place for one payload and the scheduler's actions are its only
 * writers, so this is an invariant of the compiled net broken, never an n8n condition: it
 * names the transition and the place so the gadget that wired them can be found.
 */
export class UnexpectedTokenError extends InternalSchedulerError {
  constructor(transition: string, place: string) {
    super(`internal: '${transition}' consumed a token on '${place}' that is not the payload the place carries`);
    this.name = 'UnexpectedTokenError';
  }
}

/** The token `ctx` consumed from `place`, narrowed by `guard`; anything else is an {@link UnexpectedTokenError}. */
export function take<T>(ctx: TransitionContext, place: Place<unknown>, guard: (v: unknown) => v is T): T {
  const v = ctx.input(place);
  if (!guard(v)) throw new UnexpectedTokenError(ctx.transitionName(), place.name);
  return v;
}
