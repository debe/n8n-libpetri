/**
 * The name vocabulary of the compiled net: every place and transition name `compile.ts` and
 * `gadget.ts` produce, and nothing else. This module is its one import surface; the names are
 * written in `names/`, split by audience — the prefix rule (`qualified.ts`), places
 * (`places.ts`), ports (`ports.ts`) and transitions (`transitions.ts`) — and nothing outside
 * `names/` builds a name of its own.
 *
 * A node's gadget is a `SubnetDef` instantiated at prefix `node.id` (MOD-010), so a place or
 * transition it declares under the local name `L` is `${id}/L` in the flat net (MOD-012) —
 * {@link qualified}. The host places `compile()` creates before composition (the
 * consumer-owned edge places, a producer-less node's synthetic `in`, a referenced node's
 * host-level `skipped`) are named exactly as the consumer's own instance would qualify the
 * port bound to them, so a host place's name is `qualified(consumer.id, port)` whichever file
 * builds it. The local names are therefore also the port names.
 *
 * Every function is pure and total; the net-identity baseline pins the output byte for byte,
 * because `NetMap`, the marking codec, the verifier's reports and every stored marking address
 * places by these names.
 */
export { qualified } from './names/qualified.js';
export {
  SHARED_PLACE, PLACE, AGENT_PLACE, inPlaceOf, skippedPlaceOf, freeOf, readyOf, readyVariantOf, hasdataOf, ranOf,
  nilOf, okOf, routedOf, runningOf, failedOf, timedOutOf, arrivedPlaceOf, livePlaceOf,
} from './names/places.js';
export {
  emptyTwinOf, edgeInPortOf, consumerPortOf, edgeOutPortOf, refDonePortOf, refSkippedPortOf, toolInPortOf,
  agentResponsePortOf, arrivedPortOf, successorLivePortOf,
} from './names/ports.js';
export {
  TRANSITION, startUnmetOf, attemptRunOf, routeOf, skipCombinationOf, clearOf, armOf, deadlineOf, attemptStepOf,
  sinkOf,
} from './names/transitions.js';
