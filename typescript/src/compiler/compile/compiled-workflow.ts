/**
 * The `CompiledWorkflow` `compile()` returns: the bound net with its `NetMap`, the analysis and
 * budget it was compiled under, the lazily compiled `PrecompiledNet` program (CONC-020) and the
 * lazily derived place collections, all kept across `withActions` rebinding (CORE-042).
 */
import { PrecompiledNet } from 'libpetri';
import type { PetriNet, Place, Token } from 'libpetri';
import type { NetMap } from '../net-map.js';
import type { ActionBinder, BudgetRestriction, CompiledWorkflow, JoinReadyPlaces, WorkflowAnalysis } from '../types.js';
import { bindActions } from './bind.js';
import type { DerivedPlaces } from './derived-places.js';
import { initialMarkingOf, settlementInitialMarkingOf, sharedMarkingOf } from './marking.js';

export class CompiledWorkflowImpl implements CompiledWorkflow {
  readonly net: PetriNet;
  readonly netMap: NetMap;
  readonly analysis: WorkflowAnalysis;
  readonly structuralHash: string;
  readonly startNode: string;
  readonly startNodes: readonly string[];
  readonly requestedBudget: number;
  readonly effectiveBudget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  readonly diagnostics: readonly string[];
  private readonly derived: DerivedPlaces;
  private compiledProgram: PrecompiledNet | null = null;

  constructor(
    net: PetriNet,
    netMap: NetMap,
    analysis: WorkflowAnalysis,
    structuralHash: string,
    requestedBudget: number,
    effectiveBudget: number,
    budgetRestriction: BudgetRestriction | null,
    derived: DerivedPlaces,
  ) {
    this.net = net;
    this.netMap = netMap;
    this.analysis = analysis;
    this.structuralHash = structuralHash;
    this.startNode = analysis.startNode;
    this.startNodes = analysis.startNodes;
    this.requestedBudget = requestedBudget;
    this.effectiveBudget = effectiveBudget;
    this.budgetRestriction = budgetRestriction;
    this.diagnostics = analysis.diagnostics;
    this.derived = derived;
  }

  get joinInputPlaces(): readonly Place<unknown>[] { return this.derived.joinInputPlaces; }
  get joinReadyPlaces(): readonly JoinReadyPlaces[] { return this.derived.joinReadyPlaces; }
  get edgeDataPlaces(): readonly Place<unknown>[] { return this.derived.edgeDataPlaces; }
  get runningPlaces(): readonly Place<unknown>[] { return this.derived.runningPlaces; }

  get program(): PrecompiledNet {
    if (this.compiledProgram === null) this.compiledProgram = PrecompiledNet.compile(this.net);
    return this.compiledProgram;
  }

  sharedMarking(): Map<Place<unknown>, Token<unknown>[]> {
    if (this.analysis.profile === 'engineV2') return new Map();
    return sharedMarkingOf(this.netMap, this.analysis, this.effectiveBudget);
  }

  initialMarking(triggerItems: unknown): Map<Place<unknown>, Token<unknown>[]> {
    if (this.analysis.profile === 'engineV2') return settlementInitialMarkingOf(this.netMap, this.startNode);
    return initialMarkingOf(this.sharedMarking(), this.netMap.node(this.startNode), triggerItems);
  }

  withActions(binder: ActionBinder): CompiledWorkflow {
    const rebound = bindActions(this.net, this.netMap, binder);
    return new CompiledWorkflowImpl(
      rebound, this.netMap.rebind(rebound), this.analysis, this.structuralHash,
      this.requestedBudget, this.effectiveBudget, this.budgetRestriction, this.derived);
  }
}
