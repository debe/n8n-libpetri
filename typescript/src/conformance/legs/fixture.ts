/**
 * A differential fixture: one workflow with its node behaviours and harness options, the
 * budgets it is meaningful at, the start node every leg begins from, and the fresh host a
 * leg builds from it. `engines.ts` runs a fixture through both engines.
 */
import type { IRunExecutionData, Workflow } from 'n8n-workflow';
import type { WorkflowDescription } from '../../compiler/index.js';
import type { FakeHostOptions } from '../harness/fake-host.js';
import { newRunExecutionData, type RunDataOptions } from '../harness/run-data.js';
import type { NodeScript } from '../harness/scripts.js';
import { fakeWorkflow, type FakeWorkflowOptions } from '../harness/workflow.js';
import { TracingHost } from './tracing-host.js';

/** Everything the differ needs to run one workflow through both engines. */
export interface DifferFixture {
  readonly name: string;
  readonly workflow: WorkflowDescription;
  /** Node behaviours; a node without one passes its first input through. */
  readonly scripts?: Readonly<Record<string, NodeScript>>;
  /** Harness options (start items, node parameters, run-node filter, …). */
  readonly options?: FakeWorkflowOptions & RunDataOptions & FakeHostOptions;
  /** Budgets this fixture is meaningful at. Default `[1, 2, 4]`. */
  readonly budgets?: readonly number[];
}

/** A fixture the differ cannot run as written. */
export class DifferFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DifferFixtureError';
  }
}

/**
 * The node the run starts at: `startNodes[0]`, or the one-element alias `startNode`. A
 * fixture that names neither used to reach `workflow.nodes[undefined]` and fail inside the
 * engine with a `TypeError` about `name`; it is refused at the door instead.
 */
export function startNodeOf(fixture: DifferFixture): string {
  const name = fixture.workflow.startNodes?.[0] ?? fixture.workflow.startNode;
  if (name === undefined) {
    throw new DifferFixtureError(`differ: fixture '${fixture.name}' names no start node (startNodes or startNode)`);
  }
  return name;
}

/**
 * The payload objects a fixture supplies, copied for one leg. A token holds the very array
 * n8n produced and `addPairedItemLineage` copies items only shallowly (README "Concurrency":
 * *a node's input items are read-only*), so a fixture whose script writes into its input
 * would otherwise mutate objects the **other** leg had already recorded — the legs run one
 * after the other and the comparison happens after both. That erased the difference it was
 * built to find: the two engines produced `i: 100` and `i: 200` and `compareData` reported
 * `equal`, because both `runData`s pointed at the same item object. Cloning the fixture's
 * start items and pin data per leg is what keeps the two runs disjoint (and keeps the
 * fixture module's own `START` array unmutated for every later fixture in the process).
 */
function perLegPayloads<T extends RunDataOptions>(options: T): T {
  return {
    ...options,
    ...(options.startItems === undefined ? {} : { startItems: structuredClone(options.startItems) }),
    ...(options.pinData === undefined ? {} : { pinData: structuredClone(options.pinData) }),
  };
}

/** A fresh host for one leg of `fixture`: its own workflow, run data and payload copies. */
export function buildHost(fixture: DifferFixture): { host: TracingHost; workflow: Workflow; data: IRunExecutionData } {
  const options = perLegPayloads(fixture.options ?? {});
  const workflow = fakeWorkflow(fixture.workflow, options);
  const startName = startNodeOf(fixture);
  const startNode = workflow.nodes[startName];
  if (startNode === undefined) {
    throw new DifferFixtureError(`differ: fixture '${fixture.name}' starts at '${startName}', which is not one of its nodes`);
  }
  const data = newRunExecutionData(startNode, options);
  const host = new TracingHost(workflow, data, fixture.scripts ?? {}, options);
  return { host, workflow, data };
}
