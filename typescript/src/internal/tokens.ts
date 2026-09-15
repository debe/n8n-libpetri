/**
 * Unit tokens typed for the compiled net's places, which are all `Place<unknown>`
 * (CORE-002: identity by name, one value type per flat net). libpetri's `unitToken()` is
 * `Token<void>`; the one widening lives here so neither the compiler nor the codec casts.
 */
import { unitToken, type Token } from 'libpetri';

/** One unit token. */
export function unit(): Token<unknown> {
  return unitToken() as Token<unknown>;
}

/** `n` unit tokens. */
export function units(n: number): Token<unknown>[] {
  return Array.from({ length: n }, unit);
}
