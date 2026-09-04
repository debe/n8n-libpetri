/**
 * Verification over the compiled net (the same net that executes).
 *
 * Properties: proper completion via `joinedOrDeadLettered` per join input and edge place
 * with no sinks declared (VER-002, NU-040), dead nodes via `unreachable({X/running})`,
 * exclusion via `mutualExclusion(A/running, B/running)`, bounds via `placeBound`, and
 * at-most-`maxTries` attempts. Counterexamples are decoded through `NetMap` into node paths.
 * Without z3 every verdict is `unknown` (VER-013), never a throw.
 *
 * Milestone M4.
 */
export {};
