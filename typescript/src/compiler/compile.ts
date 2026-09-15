/**
 * `compile(workflow, options)`: one flat libpetri net per workflow.
 *
 * Pipeline: structural analysis (`graph.ts`), one `SubnetDef` per node (`gadget.ts`)
 * instantiated at prefix `node.id` (MOD-010), composed in canvas order by port binding
 * (MOD-020) into a flat net (MOD-023) with the shared `_budget` / `_halt` /
 * `_pause` places, the consumer-owned edge places and the `Y/done` reference places bound as ports;
 * then action binding (CORE-042) and the `NetMap`. Every transition of the flat net belongs
 * to a node: there is no host-level transition, and no reap — `_halt` is the halted run's
 * terminal marker and nothing consumes it (the halt note in `compile/compose.ts`). The
 * `PrecompiledNet` program is compiled lazily once per `CompiledWorkflow` (CONC-020) and
 * enforces CORE-043.
 *
 * The stages live in `compile/`: the options and their refusals (`options.ts`), the k-safety
 * check (`k-safety.ts`), the host edge places (`edge-places.ts`), composition (`compose.ts`),
 * the `NetMap` (`mapping.ts`), action binding (`bind.ts`), and the compiled workflow with its
 * markings and derived place collections (`compiled-workflow.ts`, `marking.ts`,
 * `derived-places.ts`).
 *
 * Declaration order is canvas order: nodes are composed sorted by `(y, x)` ascending and
 * each gadget declares its transitions in a fixed order, so libpetri's declaration-order
 * tiebreak (EXEC-002 AC3) reproduces n8n's sibling order.
 */
import { placeholderActions } from './actions.js';
import { readySlot } from './gadget.js';
import { structuralHash } from './hash.js';
import type { CompileOptions, CompiledWorkflow, WorkflowDescription } from './types.js';
import { bindActions } from './compile/bind.js';
import { CompiledWorkflowImpl } from './compile/compiled-workflow.js';
import { composeNet } from './compile/compose.js';
import { DerivedPlaces } from './compile/derived-places.js';
import { kSafety } from './compile/k-safety.js';
import { mapNet } from './compile/mapping.js';
import { analysisOf, requestedBudgetOf } from './compile/options.js';

// The one copy of the "which ready place" rule lives beside the gadget that lays the places
// out; it is published from here, where every consumer of the compiled net has always found it.
export { readySlot };
export { kSafety } from './compile/k-safety.js';
export { readyPlacesOf } from './compile/derived-places.js';

/**
 * Compiles `workflow` into one flat net (see the module comment). Analyses it first, unless the
 * caller already did: `options.analysis` (with `options.structuralHash`, when that is known too)
 * is then used as given — `compile(workflow, { analysis, structuralHash })` — and becomes the
 * compiled workflow's `analysis`.
 */
export function compile(workflow: WorkflowDescription, options: CompileOptions = {}): CompiledWorkflow {
  const requested = requestedBudgetOf(options);
  const analysis = analysisOf(workflow, options);
  const hash = options.structuralHash ?? structuralHash(analysis);
  const restriction = kSafety(analysis);
  const effectiveBudget = restriction === null ? requested : 1;

  const { structural, builds, shared } = composeNet(workflow, analysis);
  const map0 = mapNet(structural, shared, builds);
  const fallback = placeholderActions();
  const user = options.actions;
  const net = bindActions(structural, map0, (info, map) => user?.(info, map) ?? fallback(info, map));

  return new CompiledWorkflowImpl(
    net, map0.rebind(net), analysis, hash, requested, effectiveBudget, restriction, new DerivedPlaces(map0));
}
