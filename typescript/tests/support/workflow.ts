/**
 * Helpers over a `WorkflowDescription` fixture that more than one suite needs.
 */
import type { WorkflowDescription } from '../../src/compiler/index.js';

/** A fixture the test helpers cannot run as written. */
export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

/**
 * The node a run starts at: `startNodes[0]`, or the one-element alias `startNode` — the rule
 * the differ applies (`src/conformance/engines.ts` `startNodeOf`, which takes a
 * `DifferFixture` and is not on the conformance barrel). A description that names neither, or
 * names a node it does not have, is refused here with the fixture's name; passed on, it put
 * `node: undefined` on the start stack entry and the run failed somewhere else, or not at all.
 */
export function startNodeOf(desc: WorkflowDescription): string {
  const name = desc.startNodes?.[0] ?? desc.startNode;
  if (name === undefined) {
    throw new FixtureError(`fixture '${desc.name}' names no start node (startNodes or startNode)`);
  }
  if (!desc.nodes.some((n) => n.name === name)) {
    throw new FixtureError(`fixture '${desc.name}' starts at '${name}', which is not one of its nodes`);
  }
  return name;
}
