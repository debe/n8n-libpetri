/**
 * The compiler's errors, typed. Every message is the text it always was — the suites, the
 * verifier's CLI and the conformance differ read messages — so the class and `code` add a
 * machine-readable reason beside the sentence rather than replacing it.
 *
 * {@link PolicyError} (`policy.ts`) stays what it is: a malformed `executionPolicy`, with the
 * list of problems it found.
 */

/**
 * Why the compiler refused a description, or a lookup on what it compiled:
 * - `invalid-budget`: `options.budget` is not a positive integer;
 * - `invalid-options`: options that contradict each other (agent budgets beside a precomputed
 *   analysis, a structural hash without its analysis);
 * - `empty-workflow`: no nodes at all;
 * - `duplicate-node-name` / `duplicate-node-id`: two nodes share a name or an id;
 * - `empty-node-id` / `invalid-node-id`: an id that cannot be a MOD-010 prefix (empty, or
 *   containing the `/` separator);
 * - `no-start-node` / `unknown-start-node`: no start node declared, or one the workflow lacks;
 * - `unknown-connection-node`, `output-index-out-of-range`, `input-index-out-of-range`: a main
 *   connection naming a node or a port the workflow does not have;
 * - `unknown-tool-connection-node`: an `ai_tool` connection naming a node the workflow lacks;
 * - `invalid-count`: a port count or an agent budget that is not the integer it must be;
 * - `no-ready-place`: a marking asked for a `ready` place the input's form does not have;
 * - `tool-start-node`: the start node is an `ai_tool` node, which only its agent can reach;
 * - `unknown-node` / `unknown-transition`: a `NetMap` lookup of a name the net does not have.
 */
export type CompileErrorCode =
  | 'invalid-budget'
  | 'invalid-options'
  | 'empty-workflow'
  | 'duplicate-node-name'
  | 'duplicate-node-id'
  | 'empty-node-id'
  | 'invalid-node-id'
  | 'no-start-node'
  | 'unknown-start-node'
  | 'unknown-connection-node'
  | 'output-index-out-of-range'
  | 'input-index-out-of-range'
  | 'unknown-tool-connection-node'
  | 'invalid-count'
  | 'no-ready-place'
  | 'tool-start-node'
  | 'tool-main-consumer'
  | 'unknown-node'
  | 'unknown-transition';

/**
 * A description the compiler cannot compile, or a question about the compiled net it cannot
 * answer. `node` names the node the refusal is about, when there is one — also a node the
 * workflow lacks, e.g. an unknown start node.
 */
export class CompileError extends Error {
  readonly code: CompileErrorCode;
  readonly node?: string;

  constructor(code: CompileErrorCode, message: string, node?: string) {
    super(message);
    this.name = 'CompileError';
    this.code = code;
    if (node !== undefined) this.node = node;
  }
}

/**
 * A broken invariant of the compiler itself (the `internal:` family): the analysis, the gadget
 * and the flat net disagree. Never the workflow's fault, so it has no code to act on; the
 * message says which invariant failed.
 */
export class InternalCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalCompilerError';
  }
}
