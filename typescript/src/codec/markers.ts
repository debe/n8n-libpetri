/**
 * The markers decode adds last, once every activation is placed: `X/done` for every node with
 * a recorded run, and `Y/skipped` for a referenced node nothing pending can reach (README
 * "Expression references"). {@link hasRunIn} is also what an open OR round's `X/ran_i`
 * marker is decided by.
 */
import type { IRunData } from 'n8n-workflow';
import { reachableFrom, type CompiledWorkflow } from '../compiler/index.js';
import { unit } from '../internal/tokens.js';
import { add, count, type MarkingMap } from './shared.js';

/** Whether a node, by name, actually executed. */
export type HasRun = (name: string) => boolean;

/**
 * Whether `name` actually executed. A tool node is the one place where having a `runData`
 * entry is not the same thing: `initializeNodeRunData` **reserves** a slot per requested
 * action before the tool runs — n8n's own test asserts `data` is `undefined` for a tool whose
 * round was abandoned — so a reserved-but-unfilled slot must not mark `X/done` or a resumed
 * `$('Tool')` read arc would see a run that never happened.
 */
export function hasRunIn(compiled: CompiledWorkflow, runData: IRunData | undefined): HasRun {
  return (name) => {
    const runs = runData?.[name] ?? [];
    if (runs.length === 0) return false;
    const isTool = compiled.netMap.tryNode(name)?.form === 'tool';
    return isTool ? runs.some((t) => t.data !== undefined) : true;
  };
}

/**
 * `X/done` from `runData`, then `Y/skipped` for every referenced node without a recorded run
 * that no node in `pendingNodes` (a decoded activation) can reach and that holds no skip yet:
 * the referencing node must fail with n8n's own error, not strand on its read arc.
 */
export function addMarkers(compiled: CompiledWorkflow, marking: MarkingMap, pendingNodes: ReadonlySet<string>, hasRun: HasRun): void {
  for (const g of compiled.netMap.nodes) {
    if (hasRun(g.node)) add(marking, g.done, unit());
  }
  const referenced = new Set<string>();
  for (const g of compiled.netMap.nodes) for (const y of g.references) referenced.add(y);
  if (referenced.size === 0) return;
  const reach = reachableFrom(compiled.analysis, pendingNodes);
  for (const y of referenced) {
    const g = compiled.netMap.node(y);
    if (g.skipped === null || hasRun(y) || reach.has(y) || count(marking, g.skipped) > 0) continue;
    add(marking, g.skipped, unit());
  }
}
