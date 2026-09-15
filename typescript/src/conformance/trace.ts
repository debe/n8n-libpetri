/**
 * The realised run, as the differ reads it: the `runNode` observations each engine's host
 * records ({@link TraceEvent}), folded into one {@link Activation} per `(node, runIndex)`,
 * and the data dependencies the run actually realised, read off the `source` n8n stamps on
 * every `ITaskData` ({@link dependencyEdges}). Both gates and the ordering report address an
 * activation by its {@link activationKey}.
 */
import type { IRunData, ISourceData, ITaskData } from 'n8n-workflow';

/** One observation of a node run. `seq` is a per-engine monotonic counter. */
export interface TraceEvent {
  readonly seq: number;
  readonly kind: 'start' | 'finish';
  readonly node: string;
  readonly runIndex: number;
  /** 0-based attempt of this activation (a retry or a soft-failure re-run is another attempt). */
  readonly attempt: number;
  /** Milliseconds since the engine started. Informational: ordering is by `seq`. */
  readonly at: number;
}

/** One node activation: every attempt of one `(node, runIndex)` pair. */
export interface Activation {
  readonly key: string;
  readonly node: string;
  readonly runIndex: number;
  /** `seq` of the first attempt's start. */
  readonly start: number;
  /** `seq` of the last attempt's finish; `Infinity` if it never finished. */
  readonly finish: number;
  readonly attempts: number;
}

export function activationKey(node: string, runIndex: number): string {
  return `${node}#${runIndex}`;
}

/** The node of an {@link activationKey}; a node name may itself contain `#`. */
export function activationNodeOf(key: string): string {
  return key.slice(0, key.lastIndexOf('#'));
}

/** Fold a trace into one activation per `(node, runIndex)`. */
export function activationsOf(trace: readonly TraceEvent[]): Map<string, Activation> {
  const out = new Map<string, Activation>();
  for (const e of trace) {
    const key = activationKey(e.node, e.runIndex);
    const seen = out.get(key);
    if (e.kind === 'start') {
      out.set(key, seen === undefined
        ? { key, node: e.node, runIndex: e.runIndex, start: e.seq, finish: Number.POSITIVE_INFINITY, attempts: 1 }
        : { ...seen, attempts: seen.attempts + 1 });
    } else if (seen !== undefined) {
      out.set(key, { ...seen, finish: e.seq });
    }
  }
  return out;
}

/** A data dependency the run actually realised: `to` consumed `from`'s output. */
export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly inputIndex: number;
}

/**
 * The dependency edges of one run, read off the `source` n8n stamps on every `ITaskData`
 * (`previousNode` / `previousNodeRun`). This is the *realised* dependency graph, not the
 * workflow's static one: it names the exact activations that fed each other.
 *
 * **A dispatched `ai_tool` activation is not one of these.** n8n stamps the agent as its
 * `previousNode`, but the agent did not *feed* it — it *asked* for it, and then waited. The
 * agent activation that asked and the one that answers share a run index (`handleRequest` sets
 * `nodeRunIndex: runIndex`), so `finish(agent) < start(tool)` is false in n8n itself, and
 * reading the edge as a data dependency reports a violation against every engine including the
 * reference one. `initializeNodeRunData` marks exactly these runs with an `inputOverride` on a
 * non-`main` connection, which is n8n's own way of saying the same thing.
 */
function isDispatched(task: ITaskData): boolean {
  const override = (task as { inputOverride?: Record<string, unknown> }).inputOverride;
  return override !== undefined && Object.keys(override).some((k) => k !== 'main');
}

export function dependencyEdges(runData: IRunData): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const [node, runs] of Object.entries(runData)) {
    runs.forEach((task, runIndex) => {
      if (isDispatched(task)) return;
      const sources = (task.source ?? []) as Array<ISourceData | null>;
      sources.forEach((source, inputIndex) => {
        if (source === null || source === undefined) return;
        edges.push({
          from: activationKey(source.previousNode, source.previousNodeRun ?? 0),
          to: activationKey(node, runIndex),
          inputIndex,
        });
      });
    });
  }
  return edges;
}
