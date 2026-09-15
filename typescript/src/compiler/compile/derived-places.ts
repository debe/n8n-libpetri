/** The place collections the verifier and the codec read off a compiled net, derived from its `NetMap`. */
import type { Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import type { NetMap } from '../net-map.js';
import type { InputGadget, JoinReadyPlaces } from '../types.js';

/**
 * Every `ready` place of one input, in the order the codec and the marking read them: the
 * OR form's round counter, a generic slot's single place, an enumerated slot's `data` place
 * and (when it exists) its `empty` place.
 */
export function readyPlacesOf(i: InputGadget): Place<unknown>[] {
  switch (i.slot) {
    case 'or':
    case 'ready': return [i.ready];
    case 'ready-split': return i.readyEmpty === null ? [i.readyData] : [i.readyData, i.readyEmpty];
    default: return assertNever(i, 'input slot');
  }
}

/**
 * The place collections the verifier reads off a compiled net, derived from the `NetMap`'s
 * gadgets and place infos on first use. A re-bound net (`withActions`, CORE-042) keeps the
 * same places under the same names, so one instance serves every rebinding of a compile.
 */
export class DerivedPlaces {
  private readonly netMap: NetMap;
  private joinInput: readonly Place<unknown>[] | null = null;
  private joinReady: readonly JoinReadyPlaces[] | null = null;
  private edgeData: readonly Place<unknown>[] | null = null;
  private running: readonly Place<unknown>[] | null = null;

  constructor(netMap: NetMap) {
    this.netMap = netMap;
  }

  get joinInputPlaces(): readonly Place<unknown>[] {
    return (this.joinInput ??= this.netMap.places.filter((p) => p.role === 'ready').map((p) => p.place));
  }

  get joinReadyPlaces(): readonly JoinReadyPlaces[] {
    return (this.joinReady ??= this.netMap.nodes.flatMap((g) => g.inputs.map((i): JoinReadyPlaces => ({
      node: g.node,
      inputIndex: i.index,
      places: readyPlacesOf(i),
    }))));
  }

  get edgeDataPlaces(): readonly Place<unknown>[] {
    return (this.edgeData ??= this.netMap.places
      .filter((p) => p.role === 'in-data' || p.role === 'edge-data')
      .map((p) => p.place));
  }

  /**
   * Every attempt's running place, not only the first: `no-double-activation` and the
   * mutual-exclusion pass ask about "this node is running", and an `onFailure` chain spreads
   * that across `X/running_i` (ADR 0009). `attempts` is empty for a policy-free node, so this
   * is `g.running` alone there.
   */
  get runningPlaces(): readonly Place<unknown>[] {
    return (this.running ??= this.netMap.nodes.flatMap((g) =>
      g.attempts.length === 0 ? [g.running] : g.attempts.map((att) => att.running)));
  }
}
