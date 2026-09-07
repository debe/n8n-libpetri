/**
 * Stable structural hash of a workflow: the cache key for a `CompiledWorkflow` and its
 * `PrecompiledNet` program (CONC-020: compile once per workflow version).
 */
import { createHash } from 'node:crypto';
import type { WorkflowAnalysis } from './graph.js';

/**
 * SHA-256 (hex) over a canonical JSON rendering of everything the compiler reads: nodes in
 * canvas order with their structural fields and resolved type shapes, resolved expression
 * references, deduplicated connections in canonical order and the start nodes (the
 * primary one and the canonical set: they decide depth, reachability and which node
 * `initialMarking` seeds). Two workflows with equal hashes compile to structurally
 * identical nets and programs. The budget is deliberately not part of it: it changes only
 * the initial marking.
 */
export function structuralHash(analysis: WorkflowAnalysis): string {
  const canonical = {
    // 2: clamped retry params (retryParamsOf); 3: classified references, OR form, split
    // routing; 4: start-node set, _pause, X/waiting and X/stopped outcomes; 5: per-output
    // routing for every node with an output, so `_budget` is refunded by X_done one cycle
    // after the edge tokens land; 6: X_run routes in its own Out spec at or below
    // SPLIT_ROUTING_ABOVE (3) connected outputs — X/ok and X_route are gone there and
    // X_done consumes a single X/routed; 7: no `_halted` and no `_halt_reap` — `_halt` is
    // the halted run's terminal marker, never consumed, and the pending activations rest
    // where they were delivered
    v: 7,
    start: analysis.startNode,
    starts: [...analysis.startNodes],
    nodes: analysis.nodes.map((a) => ({
      id: a.node.id,
      name: a.node.name,
      type: a.node.type,
      typeVersion: a.node.typeVersion,
      position: [a.node.position[0], a.node.position[1]],
      disabled: a.node.disabled === true,
      onError: a.onError,
      retryOnFail: a.retryOnFail,
      // Clamped as n8n reads them, so values n8n treats alike hash alike.
      maxTries: a.maxTries,
      waitBetweenTries: a.waitBetweenTries,
      inputCount: a.shape.inputCount,
      outputCount: a.shape.outputCount,
      requiredInputs: a.shape.requiredInputs === undefined ? null
        : typeof a.shape.requiredInputs === 'number' ? a.shape.requiredInputs
        : [...a.shape.requiredInputs],
      loopNode: a.shape.loopNode === true,
      outputNames: a.shape.outputNames === undefined ? null : [...a.shape.outputNames],
      references: a.references.map((r) => [r.node, r.kind]),
    })),
    edges: analysis.edges.map((e) => [e.from, e.outputIndex, e.to, e.inputIndex]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
