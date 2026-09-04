/**
 * Conformance harness: run n8n's execution-engine suite under both schedulers with
 * `CI=true` (which makes `@n8n/vitest-config` emit junit.xml), parse both reports, and
 * emit the matrix. The headline number is loop-driving cases passed; pure-helper cases are
 * reported separately as a regression guard. Also the differential trace differ asserting
 * data equivalence and happens-before, never total order.
 *
 * Milestone M1 (harness) and M3 (differ).
 */
export {};
