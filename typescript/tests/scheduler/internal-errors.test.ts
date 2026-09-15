/**
 * The scheduler's `internal:` family is typed: `InternalSchedulerError` is a broken invariant of
 * the compiled net or of the actions that serve it, never a workflow condition. The messages
 * are the ones they always were — only the class is new.
 */
import { compile, type TransitionInfo } from '../../src/compiler/index.js';
import { InternalSchedulerError, schedulerActions, UnexpectedTokenError } from '../../src/scheduler/index.js';
import { conn, node, workflow } from '../fixtures/workflows.js';

/** Trigger → A: `A` has one output, so it routes in its own `X_run`. */
const linear = workflow('internal-linear', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
], [conn('Trigger', 0, 'A', 0)], 'Trigger');

describe('InternalSchedulerError', () => {
  it('is what binding a transition the gadget was not built with throws, message unchanged', () => {
    const { netMap } = compile(linear);
    // `A` routes in `X_run`, so a per-output `X_route_o` for it is an invariant broken.
    const info: TransitionInfo = { role: 'route', node: 'A', name: 'A/route_0', port: 0 };
    let thrown: unknown;
    try {
      schedulerActions()(info, netMap);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InternalSchedulerError);
    expect((thrown as Error).name).toBe('InternalSchedulerError');
    expect((thrown as Error).message).toBe("internal: node 'A' has a route transition but routes in X_run");
  });

  it('counts an unexpected token among them, under its own name', () => {
    const error = new UnexpectedTokenError('A/run', 'A/running');
    expect(error).toBeInstanceOf(InternalSchedulerError);
    expect(error.name).toBe('UnexpectedTokenError');
    expect(error.message).toBe("internal: 'A/run' consumed a token on 'A/running' that is not the payload the place carries");
  });
});
