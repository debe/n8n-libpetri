/**
 * The input side of the gadget (README "Per-node gadget", "Join gadget", "OR-inputs"; ADR 0003):
 * the edge ports and join slots of each form, whether the node can skip, `X_start` with its
 * `start_unmet` twins, `X_skip`, the OR form's `X_clear` and the arms.
 */
import { Transition, all, and, exactly, one, outPlace, place } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { CompileError, InternalCompilerError } from '../errors.js';
import {
  PLACE, TRANSITION, armOf, clearOf, edgeInPortOf, emptyTwinOf, freeOf, hasdataOf, ranOf, readyOf, readyVariantOf,
  skipCombinationOf, skippedPlaceOf, startUnmetOf,
} from '../names.js';
import type { InputGadgetCommon, JoinForm, ReadySlot, SplitReadySlot, Variant } from '../types.js';
import {
  andOf, type GadgetContext, type LocalEdge, type LocalInputCommon, type LocalInputSide, type LocalJoinInput,
  type LocalOrInput, type LocalReadyInput, type LocalSplitReadyInput,
} from './context.js';
import type { Markers, ReferencePorts, SharedPorts } from './ports.js';

/**
 * The `ready` place a join input's arrival of `variant` lands on: `X/ready_i` for the
 * generic join and for a non-required choose-branch input (one place for both variants),
 * `X/ready_i_data` / `X/ready_i_empty` for a required choose-branch input. Throws a named
 * compile error instead of yielding a `null` marking key when the enumerated form has no
 * place for the variant (an input fed only by cycle edges has no `ready_i_empty`;
 * `initialMarking` never asks for it, since an input seeded empty has only unreachable —
 * hence tree-edge — producers).
 *
 * The one copy of the rule: the gadget applies it to its own local places before
 * composition, the compiler, the codec and the scheduler to the canonical ones afterwards.
 */
export function readySlot(
  g: { readonly node: string; readonly form: JoinForm },
  i: Pick<InputGadgetCommon, 'index' | 'emptyCapable'> & (ReadySlot | SplitReadySlot),
  variant: Variant,
): Place<unknown> {
  const p = i.slot === 'ready-split' ? (variant === 'data' ? i.readyData : i.readyEmpty) : i.ready;
  if (p === null) {
    throw new CompileError('no-ready-place',
      `compile: node '${g.node}' input ${i.index} has no ${readyVariantOf(i.index, variant)} place to seed ` +
      `(form '${g.form}', emptyCapable ${i.emptyCapable})`, g.node);
  }
  return p;
}

/** Every assignment over `choices[i]` per input, in lexicographic order with `data` first. */
function combinations(choices: readonly (readonly Variant[])[]): Variant[][] {
  let acc: Variant[][] = [[]];
  for (const options of choices) {
    const next: Variant[][] = [];
    for (const c of acc) for (const v of options) next.push([...c, v]);
    acc = next;
  }
  return acc;
}

/** The input side over local places, with the helpers every start, skip and arm reads it through. */
export interface InputSide {
  readonly side: LocalInputSide;
  /** The join-slot inputs (empty for the direct, OR and tool forms). */
  readonly joinInputs: readonly LocalJoinInput[];
  /** Every modelled input, whichever slot shape. */
  readonly allInputs: readonly (LocalOrInput | LocalJoinInput)[];
  readonly slotOf: (i: LocalJoinInput, variant: Variant) => Place<unknown>;
  /** The `X/free_i` refunds every start / skip writes. */
  readonly freeRefunds: () => Out[];
}

/** Whether the node skips, and where its `skipped` marker lives. */
export interface SkipDecl {
  readonly hasSkip: boolean;
  /** The local `X/skipped`, exposed as a port; `null` when the node has no skip. */
  readonly skipped: Place<unknown> | null;
  /** The host-level `X/skipped` `compile` creates for a referenced node without a skip. */
  readonly hostSkippedName: string | null;
}

/** Declares the input side of the node's form: edge ports, join slots, the OR round places, `in_tool`. */
export function buildInputSide(ctx: GadgetContext): InputSide {
  const { a, analysis, edgeSlots, syntheticIn, name, reachable, incoming, form, required, port, internal, hostOwned, portDecls } = ctx;

  // ---- input side ----
  /** The producer edges of input `i` as local places, their host places declared and mapped. */
  const edgesOf = (i: number): { edges: LocalEdge[]; unreachableEdges: number; allUnreachable: boolean } => {
    const edges: LocalEdge[] = [];
    let unreachableEdges = 0;
    let allUnreachable = true;
    for (const e of incoming) {
      if (e.inputIndex !== i) continue;
      const producerReachable = analysis.reachable.has(e.from);
      if (producerReachable) allUnreachable = false;
      const slot = edgeSlots.get(e.id);
      if (slot === undefined) throw new InternalCompilerError(`internal: node '${name}' has no host slot for edge ${e.id}`);
      const dataPort = edgeInPortOf(i, e.id);
      const data = place<unknown>(dataPort);
      port(dataPort, data, slot.data, 'input');
      hostOwned(slot.data.name, 'edge-data', i, { edge: e });
      let empty: Place<unknown> | null = null;
      if (slot.empty !== null) {
        const emptyPort = emptyTwinOf(dataPort);
        empty = place<unknown>(emptyPort);
        port(emptyPort, empty, slot.empty, 'input');
        hostOwned(slot.empty.name, 'edge-empty', i, { edge: e });
        if (!producerReachable) unreachableEdges++;
      }
      edges.push({ edge: e, data, empty, host: slot });
    }
    return { edges, unreachableEdges, allUnreachable };
  };
  const inputCommon = (i: number): LocalInputCommon => {
    const { edges, unreachableEdges, allUnreachable } = edgesOf(i);
    const wired = edges.length > 0;
    return {
      index: i, edges, wired, required: required.has(i),
      emptyCapable: edges.some((e) => e.empty !== null),
      seedEmpty: reachable && wired && allUnreachable, unreachableEdges,
    };
  };
  /** Modelled input indexes, ascending: connected ones plus dead required ones. */
  const inputIndexes = (): number[] =>
    [...new Set([...incoming.map((e) => e.inputIndex), ...a.deadInputs])].sort((x, y) => x - y);

  let side: LocalInputSide;
  switch (form) {
    case 'tool': {
      // `T/in_tool`: the tool's only input, written by every agent that can dispatch it. The tool
      // owns the place and exposes it; each agent binds an output port to it, the way a referencing
      // node binds a read port to `Y/done`. No main producer, so no edge places and no join slots.
      const inTool = internal(PLACE.inTool, 'in-tool', null);
      portDecls.push({ name: PLACE.inTool, local: inTool, direction: 'input' });
      side = { form, inTool };
      break;
    }
    case 'direct': {
      const edge = incoming[0];
      const inLocal = place<unknown>(PLACE.in);
      if (edge !== undefined) {
        const slot = edgeSlots.get(edge.id);
        if (slot === undefined) throw new InternalCompilerError(`internal: node '${name}' has no host slot for edge ${edge.id}`);
        port(PLACE.in, inLocal, slot.data, 'input');
        hostOwned(slot.data.name, 'in-data', edge.inputIndex, { edge });
        let inEmpty: Place<unknown> | null = null;
        if (slot.empty !== null) {
          const emptyPort = emptyTwinOf(PLACE.in);
          inEmpty = place<unknown>(emptyPort);
          port(emptyPort, inEmpty, slot.empty, 'input');
          hostOwned(slot.empty.name, 'in-empty', edge.inputIndex, { edge });
        }
        side = { form, in: inLocal, inEmpty };
      } else {
        if (syntheticIn === null) throw new InternalCompilerError(`internal: node '${name}' has no producer and no synthetic in place`);
        port(PLACE.in, inLocal, syntheticIn, 'input');
        hostOwned(syntheticIn.name, 'in-data', 0);
        side = { form, in: inLocal, inEmpty: null };
      }
      break;
    }
    case 'or': {
      // `joinFormOf` chooses the OR form for exactly one input index with several tree edges.
      const [i, ...more] = inputIndexes();
      if (i === undefined || more.length > 0) throw new InternalCompilerError(`internal: OR-form node '${name}' models ${more.length + (i === undefined ? 0 : 1)} inputs`);
      const common = inputCommon(i);
      const input: LocalOrInput = {
        ...common, slot: 'or',
        ready: internal(readyOf(i), 'ready', i),
        hasdata: internal(hasdataOf(i), 'hasdata', i),
        ran: internal(ranOf(i), 'ran', i),
        round: common.edges.filter((e) => e.empty !== null).length,
      };
      side = { form, input };
      break;
    }
    case 'join': {
      const inputs: LocalReadyInput[] = inputIndexes().map((i) => ({
        ...inputCommon(i), slot: 'ready', free: internal(freeOf(i), 'free', i), ready: internal(readyOf(i), 'ready', i),
      }));
      side = { form, hasdata: internal(PLACE.hasdata, 'hasdata', null), inputs };
      break;
    }
    case 'choose-branch': {
      const inputs: LocalJoinInput[] = inputIndexes().map((i): LocalJoinInput => {
        const common = inputCommon(i);
        const free = internal(freeOf(i), 'free', i);
        if (common.required) {
          const readyData = internal(readyVariantOf(i, 'data'), 'ready', i, { variant: 'data' });
          const readyEmpty = common.emptyCapable ? internal(readyVariantOf(i, 'empty'), 'ready', i, { variant: 'empty' }) : null;
          return { ...common, slot: 'ready-split', free, readyData, readyEmpty };
        }
        return { ...common, slot: 'ready', free, ready: internal(readyOf(i), 'ready', i) };
      });
      side = { form, inputs };
      break;
    }
    default: return assertNever(form, 'join form');
  }
  /** The join-slot inputs (empty for the direct, OR and tool forms), for the refunds every start / skip writes. */
  const joinInputs: readonly LocalJoinInput[] = side.form === 'join' || side.form === 'choose-branch' ? side.inputs : [];
  /** Every modelled input, whichever slot shape: the arms and the gadget's `inputs`. */
  const allInputs: readonly (LocalOrInput | LocalJoinInput)[] = side.form === 'or' ? [side.input] : joinInputs;
  const slotOf = (i: LocalJoinInput, variant: Variant): Place<unknown> => readySlot({ node: name, form }, i, variant);
  const freeRefunds = (): Out[] => joinInputs.map((i) => outPlace(i.free));
  return { side, joinInputs, allInputs, slotOf, freeRefunds };
}

/** Decides whether the node skips and declares its `skipped` marker, as a port or host-owned. */
export function declareSkipped(ctx: GadgetContext, side: LocalInputSide): SkipDecl {
  const { analysis, name, id, internal, hostOwned, portDecls } = ctx;

  // ---- skip exists iff an empty token can arrive where it decides the activation ----
  const hasSkip = side.form === 'tool' ? false
    : side.form === 'direct' ? side.inEmpty !== null
    : side.form === 'or' ? true
    : side.form === 'join' ? side.inputs.some((i) => i.emptyCapable)
    : side.inputs.some((i) => i.required && i.emptyCapable);
  // The skipped marker also exists when a referencing node's start_unmet twin reads it: as
  // a port when a skip writes it, otherwise as a host-level place owned by this node.
  const referenced = analysis.referenced.has(name);
  const skipped = hasSkip ? internal(PLACE.skipped, 'skipped', null) : null;
  if (skipped !== null) portDecls.push({ name: PLACE.skipped, local: skipped, direction: 'output' });
  /** The host-level `X/skipped` `compile` creates for a referenced node without a skip. */
  const hostSkippedName = skipped === null && referenced ? skippedPlaceOf(id) : null;
  if (hostSkippedName !== null) hostOwned(hostSkippedName, 'skipped', null);
  return { hasSkip, skipped, hostSkippedName };
}

/** `X_start` and one `X_start_unmet_k` per guarded reference. */
export function buildStart(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  input: InputSide,
  references: ReferencePorts,
): { readonly startName: string; readonly startUnmetNames: readonly string[] } {
  const { depth, body, tinfo } = ctx;
  const { budget, halt, pause } = shared;
  const { idle, running } = markers;
  const { side, slotOf, freeRefunds } = input;
  const { refDone, refSkipped } = references;

  // ---- X_start and its start_unmet twins ----
  const startBuilder = (local: string, priority: number) => {
    const b = Transition.builder(local).priority(priority).inhibitors(halt, pause);
    switch (side.form) {
      case 'tool':
        b.inputs(one(side.inTool), one(budget), one(idle)).outputs(outPlace(running));
        break;
      case 'direct':
        b.inputs(one(side.in), one(budget), one(idle)).outputs(outPlace(running));
        break;
      case 'or':
        b.inputs(one(side.input.hasdata), one(budget), one(idle)).outputs(and(outPlace(running), outPlace(side.input.ran)));
        break;
      case 'join':
        for (const i of side.inputs) b.inputs(one(i.ready));
        b.inputs(all(side.hasdata));
        b.inputs(one(budget), one(idle)).outputs(and(outPlace(running), ...freeRefunds()));
        break;
      case 'choose-branch':
        for (const i of side.inputs) b.inputs(one(slotOf(i, 'data')));
        b.inputs(one(budget), one(idle)).outputs(and(outPlace(running), ...freeRefunds()));
        break;
      default: return assertNever(side, 'input side');
    }
    return b;
  };
  const start = startBuilder(TRANSITION.start, depth);
  if (refDone.length > 0) start.reads(...refDone);
  body.push(start.build());
  const startName = tinfo(TRANSITION.start, { role: 'start' });
  const startUnmetNames: string[] = [];
  refSkipped.forEach((ref, k) => {
    const local = startUnmetOf(k);
    body.push(startBuilder(local, depth - 1).read(ref.skipped).build());
    startUnmetNames.push(tinfo(local, { role: 'start-unmet', reference: ref.node }));
  });
  return { startName, startUnmetNames };
}

/** The node's skip transitions: one per form, one per enumerated combination for choose-branch. */
export function buildSkips(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  input: InputSide,
  skipped: Place<unknown> | null,
  skipEmpties: readonly Out[],
): readonly string[] {
  const { name, depth, body, tinfo } = ctx;
  const { halt } = shared;
  const { idle } = markers;
  const { side, slotOf, freeRefunds } = input;

  // ---- X_skip ----
  const skipNames: string[] = [];
  if (skipped !== null) {
    // What every skip writes, whichever form decides it: the empty of each outgoing tree
    // edge, the marker, and the join slots refunded (none outside the join forms).
    const skipOut = andOf([...skipEmpties, outPlace(skipped), ...freeRefunds()]);
    switch (side.form) {
      case 'direct': {
        if (side.inEmpty === null) throw new InternalCompilerError(`internal: node '${name}' skips without an in-empty place`);
        body.push(Transition.builder(TRANSITION.skip)
          .inputs(one(side.inEmpty))
          .inhibitor(halt)
          .outputs(skipOut)
          .priority(depth).build());
        skipNames.push(tinfo(TRANSITION.skip, { role: 'skip', combination: [] }));
        break;
      }
      case 'or': {
        // read(X/idle): X_start consumes hasdata_i when it fires but deposits ran_i only when
        // its action completes (outputs land on completion), so without the node's own mutex
        // an all-delivered round could skip while the run it just started is in flight.
        const i = side.input;
        body.push(Transition.builder(TRANSITION.skip)
          .inputs(exactly(i.round, i.ready))
          .inhibitors(i.hasdata, i.ran, halt)
          .read(idle)
          .outputs(skipOut)
          .priority(depth).build());
        skipNames.push(tinfo(TRANSITION.skip, { role: 'skip', combination: [] }));
        break;
      }
      case 'join': {
        const skip = Transition.builder(TRANSITION.skip).inhibitors(side.hasdata, halt).priority(depth);
        for (const i of side.inputs) skip.inputs(one(i.ready));
        skip.outputs(skipOut);
        body.push(skip.build());
        skipNames.push(tinfo(TRANSITION.skip, { role: 'skip', combination: [] }));
        break;
      }
      case 'choose-branch': {
        const listed = side.inputs.filter((i): i is LocalSplitReadyInput => i.slot === 'ready-split');
        /** Each enumerated input's position in `listed`, which is its column in every combination. */
        const columnOf = new Map(listed.map((i, k) => [i, k] as const));
        const choices = listed.map((i): Variant[] => (i.emptyCapable ? ['data', 'empty'] : ['data']));
        for (const combo of combinations(choices)) {
          if (combo.every((v) => v === 'data')) continue; // that combination is X_start
          const local = skipCombinationOf(combo);
          const skip = Transition.builder(local).inhibitor(halt).priority(depth);
          for (const i of side.inputs) {
            if (i.slot === 'ready') {
              skip.inputs(one(i.ready));
              continue;
            }
            const column = columnOf.get(i);
            const v = column === undefined ? undefined : combo[column];
            if (v === undefined) throw new InternalCompilerError(`internal: node '${name}' skip ${local} has no variant for input ${i.index}`);
            skip.inputs(one(slotOf(i, v)));
          }
          skip.outputs(skipOut);
          body.push(skip.build());
          skipNames.push(tinfo(local, { role: 'skip', combination: combo }));
        }
        break;
      }
      case 'tool':
        throw new InternalCompilerError(`internal: tool '${name}' has a skip transition`);
      default: return assertNever(side, 'input side');
    }
  }
  return skipNames;
}

/** The OR form's round closer, a genuine sink (CORE-043 AC4). */
export function buildClear(ctx: GadgetContext, shared: SharedPorts, markers: Markers, side: LocalInputSide): readonly string[] {
  const { depth, body, tinfo } = ctx;
  const { halt } = shared;
  const { idle } = markers;

  // ---- X_clear (OR form): the round closes once every producer delivered and ≥ 1 run happened ----
  // read(X/idle) for the same reason as X_skip: a run started from this round must have
  // landed its ran_i before the round is cleared, or that marker would leak into the next.
  const clearNames: string[] = [];
  if (side.form === 'or') {
    const i = side.input;
    const local = clearOf(i.index);
    body.push(Transition.builder(local)
      .inputs(exactly(i.round, i.ready), all(i.ran))
      .inhibitors(i.hasdata, halt)
      .read(idle)
      .priority(depth).build());
    clearNames.push(tinfo(local, { role: 'clear', port: i.index }));
  }
  return clearNames;
}

/** One `data` arm per producer edge and an `empty` arm per tree edge, for every modelled input. */
export function buildArms(ctx: GadgetContext, shared: SharedPorts, input: InputSide): readonly string[] {
  const { depth, body, tinfo } = ctx;
  const { halt } = shared;
  const { side, allInputs, slotOf } = input;

  // ---- arms (join, choose-branch and OR forms) ----
  const armNames: string[] = [];
  const joinHasdata = side.form === 'join' ? side.hasdata : null;
  for (const i of allInputs) {
    for (const e of i.edges) {
      const dataName = armOf(e.edge.id, 'data');
      const armData = Transition.builder(dataName).inputs(one(e.data)).inhibitor(halt).priority(depth);
      if (i.slot === 'or') {
        // A tree edge counts towards the round; a cycle edge only triggers a run.
        armData.outputs(e.empty !== null ? and(outPlace(i.ready), outPlace(i.hasdata)) : outPlace(i.hasdata));
      } else {
        armData.inputs(one(i.free));
        const ready = slotOf(i, 'data');
        armData.outputs(joinHasdata !== null ? and(outPlace(ready), outPlace(joinHasdata)) : outPlace(ready));
      }
      body.push(armData.build());
      armNames.push(tinfo(dataName, { role: 'arm', edge: e.edge, variant: 'data' }));
      if (e.empty !== null) {
        const emptyName = armOf(e.edge.id, 'empty');
        const armEmpty = Transition.builder(emptyName).inputs(one(e.empty)).inhibitor(halt).priority(depth);
        if (i.slot === 'or') {
          armEmpty.outputs(outPlace(i.ready));
        } else {
          armEmpty.inputs(one(i.free));
          armEmpty.outputs(outPlace(slotOf(i, 'empty')));
        }
        body.push(armEmpty.build());
        armNames.push(tinfo(emptyName, { role: 'arm', edge: e.edge, variant: 'empty' }));
      }
    }
  }
  return armNames;
}
