/**
 * The one call that constructs a state-class graph (`state-class.ts`, "Drop-in seam for a
 * reduced graph"): a partial-order-reduced or structurally reduced builder replaces this
 * function and nothing else.
 */
import type { PetriNet } from 'libpetri';
import { StateClassGraph } from 'libpetri/verification';
import type { MarkingState } from 'libpetri/verification';

/**
 * libpetri's state-class graph of `net` from `initialMarking`, bounded by `maxClasses`
 * (VER-010). Throws where libpetri does, and on a net whose verdicts it could not make soundly
 * ({@link assertMatchBlind}).
 */
export function buildStateClassGraph(
  net: PetriNet, initialMarking: MarkingState, maxClasses: number,
): StateClassGraph {
  assertMatchBlind(net);
  return StateClassGraph.build(net, initialMarking, maxClasses);
}

/**
 * `StateClassGraph` never reads a transition's `matchSpec`: its enablement is the
 * structural token counts, so it explores a ν-join as an uncorrelated one. That is
 * libpetri's **over-approximation fallback**, and the fallback is sound for reachability
 * safety but *not* for quiescence — "a `Proven` on a quiescence property never comes from
 * the fallback" (`nu-nets.md` §8). `SmtVerifier` routes around this; building the graph
 * directly, as this module does, does not. Nothing here compiles a `matchSpec` today
 * (ADR 0008 records why the agent round does not use one), so this is a tripwire for
 * whoever adds the first: it must not silently start answering with a coarser abstraction.
 */
function assertMatchBlind(net: PetriNet): void {
  for (const t of net.transitions) {
    if ((t as { matchSpec?: unknown }).matchSpec != null) {
      throw new Error(
        `transition '${t.name}' carries a ν-net matchSpec; the state-class graph is match-blind, ` +
        'so its quiescence verdicts would come from an over-approximation that is not sound for ' +
        'them (nu-nets.md §8). Route this net through SmtVerifier with budgetPlaces declared.');
    }
  }
}
