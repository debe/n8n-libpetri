/** The tool form's input side (README "Agent tool dispatch", ADR 0008): `T/in_tool` alone. */
import { PLACE } from '../names.js';
import type { GadgetContext } from './context.js';
import type { LocalToolSide } from './local-shapes.js';

/** Declares `T/in_tool` and exposes it as a port. */
export function declareToolSide(ctx: GadgetContext): LocalToolSide {
  // `T/in_tool`: the tool's only input, written by every agent that can dispatch it. The tool
  // owns the place and exposes it; each agent binds an output port to it, the way a referencing
  // node binds a read port to `Y/done`. No main producer, so no edge places and no join slots.
  const inTool = ctx.internal(PLACE.inTool, 'in-tool', null);
  ctx.portDecls.push({ name: PLACE.inTool, local: inTool, direction: 'input' });
  return { form: 'tool', inTool };
}
