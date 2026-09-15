/**
 * Exhaustiveness guard for a `switch` over a closed union.
 *
 * Reaching it means a union gained a member no arm handles; the compiler rejects the call
 * site as soon as `value` is not `never`, so the omission is a type error rather than a
 * silently skipped branch — the failure mode a transition action must never have, since an
 * unwritten branch loses the tokens the firing consumed (EXEC-030).
 */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`internal: unhandled ${what} ${JSON.stringify(value)}`);
}
