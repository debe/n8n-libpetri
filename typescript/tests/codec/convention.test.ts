/**
 * The codec's one error convention (`src/codec.ts`): a structural impossibility — the
 * compiled net and the data disagree — is a `CodecError` naming node and place; a foreign
 * token shape is a diagnostic naming node and place, and the token is skipped. These cases
 * pin the sites that used to do neither: they read a foreign token as if it meant something.
 */
import { encodeMarking } from '../../src/codec.js';
import { compile } from '../../src/compiler/index.js';
import type { RunPayload } from '../../src/scheduler/index.js';
import { diamond } from '../fixtures/workflows.js';
import { fakeWorkflow, items } from '../scheduler/support.js';
import { edge, emptyState, entryFor, gadget, live, put, slotsOf, src } from './support.js';
import { inputOf, readyOf } from '../compiler/support.js';

describe('a foreign token on a join input', () => {
  it('is a diagnostic naming node and place and is skipped, not written back as an arrived empty', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const merge = gadget(c, 'Merge');
    const m = c.sharedMarking();
    const foreign: RunPayload = { kind: 'run', executionData: entryFor(wf.nodes.A!, [items(9)]), attempt: 1 };
    const b = items({ b: 1 });
    put(m, readyOf(inputOf(merge, 0)), [foreign]);
    put(m, readyOf(inputOf(merge, 1)), [edge(b, src('B'))]);
    const diagnostics: string[] = [];
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n], onDiagnostic: (d) => diagnostics.push(d) });
    expect(diagnostics).toEqual([`node 'Merge': token on 'id:Merge/ready_0' carries no arrival; dropped`]);
    // Input 1's arrival is still pending, alone: a partial slot, never a stack entry run on `[]`.
    expect(x.nodeExecutionStack).toEqual([]);
    expect(slotsOf(x.waitingExecution, 'Merge')).toEqual([{ main: [null, b] }]);
  });
});
