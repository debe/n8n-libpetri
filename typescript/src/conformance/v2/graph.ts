/**
 * The engine v2 graph mirror and its stage-1 input, re-exported from where they live now,
 * `n8n/v2-graph.ts` (`tasks/v2-seam-plan.md` step 6): the settlement policy reads n8n's graph
 * outside the conformance code, and the conformance code, its tests and the task scripts keep
 * importing it from here.
 */
export * from '../../n8n/v2-graph.js';
