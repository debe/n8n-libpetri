/**
 * One renderer for a marked place.
 *
 * A report prints the same stranded place twice — once in the whole-net row's explanation
 * ("It quiesces holding …") and once in that row's finding block ("marking at the
 * violation: …"). Those were two functions that disagreed on a ported place: the explanation
 * said `M input 1 ready`, the finding block `M port 1 ready`, for the same token on the same
 * page. `renderMarkedPlace` is now the only one, and it names the side of the node the port is
 * on, so a join input reads the same wherever it appears.
 */
import { renderFinding, renderMarkedPlace, verify } from '../../src/verify/index.js';
import { unbalancedJoin } from './support.js';

it('a stranded join input renders identically in the finding block and the whole-net explanation', async () => {
  // Graph only: the stranding is found by enumeration, so no solver is involved.
  const report = await verify(unbalancedJoin, { properties: ['proper-completion'], smtFallback: 'off' });
  const whole = report.checks.find((c) => c.property === 'proper-completion' && c.subject.kind === 'net');
  expect(whole?.verdict).toBe('violated');
  const ready = whole!.counterexample!.stuckMarking.find((p) => p.node === 'M' && p.role === 'ready');
  expect(ready, 'the stranding leaves an arrival on a join input of M').toBeDefined();

  const rendered = renderMarkedPlace(ready!);
  expect(rendered).toBe(`M input ${ready!.port} ready (${ready!.place})`);
  expect(whole!.explanation).toContain(rendered);
  expect(renderFinding(whole!, 1).join('\n')).toContain(rendered);
});
