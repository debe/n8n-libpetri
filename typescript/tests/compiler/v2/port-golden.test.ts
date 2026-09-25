/**
 * The converter port (`tasks/v2-profile-plan.md` step 13) on the committed workflows, against the
 * graphs n8n's own `V1WorkflowConverter` made of them — recorded in the settlement golden
 * (`tests/fixtures/v2/settlement-golden.json`, step 11), so this needs no `.n8n`.
 *
 * For every testbed workflow the golden holds, the workflow export read the verify CLI's way
 * (`describeWorkflowJson`, profile `engineV2`) and analysed under `engineV2` must give n8n's
 * graph: the same nodes, the same edges with the same slots, the same `isBackEdge`. For every one
 * the golden records as refused, ours must refuse with the code `V2_REFUSALS` maps n8n's error
 * to. And the CLI must accept and refuse the same files. The corpus-scale comparison is
 * `tasks/v2-acceptance.mts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, CompileError, V2_REFUSALS, v2RefusalOf } from '../../../src/compiler/index.js';
import type { SettlementGolden } from '../../../src/conformance/v2/golden.js';
import type { CliIo } from '../../../src/verify/cli.js';
import { runCli } from '../../../src/verify/cli.js';
import { describeWorkflowJson } from '../../../src/verify/workflow-json.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const golden = JSON.parse(readFileSync(resolve(repo, 'typescript/tests/fixtures/v2/settlement-golden.json'), 'utf8')) as SettlementGolden;
const testbed = golden.entries.filter((e) => e.source.startsWith('scripts/testbed/'));
const read = (source: string): unknown => JSON.parse(readFileSync(resolve(repo, source), 'utf8'));

const edgeText = (from: string, out: number, to: string, into: number, back: boolean): string =>
  `${from}.${out} -> ${to}.${into}${back ? ' (back)' : ''}`;

/** The port's graph of a workflow export: node names and edges, back edges marked. */
function portGraph(source: string, trigger: string | undefined): { nodes: string[]; edges: string[] } {
  const { description } = describeWorkflowJson(read(source), { profile: 'engineV2' });
  const a = analyse(description, { profile: 'engineV2', ...(trigger === undefined ? {} : { trigger }) });
  return {
    nodes: a.nodes.map((n) => n.node.name).sort(),
    edges: a.edges.map((e) => edgeText(e.from, e.outputIndex, e.to, e.inputIndex, a.engineV2!.edgeClass.get(e.id) === 'back')).sort(),
  };
}

describe('the port against n8n\'s converted graphs of the committed workflows', () => {
  it('covers the testbed workflows the golden records, accepted and refused', () => {
    expect(testbed.length).toBeGreaterThanOrEqual(7);
    expect(golden.skipped.length).toBeGreaterThanOrEqual(4);
  });

  it.each(testbed.map((e) => [e.source, e] as const))('%s: builds n8n\'s graph', (source, entry) => {
    const nameOf = new Map(entry.graph.nodes.map((n) => [n.id, n.name]));
    expect(portGraph(source, entry.trigger ?? undefined)).toEqual({
      nodes: entry.graph.nodes.map((n) => n.name).sort(),
      edges: entry.graph.edges.map((e) =>
        edgeText(nameOf.get(e.from)!, e.outputIndex, nameOf.get(e.to)!, e.inputIndex, e.isBackEdge === true)).sort(),
    });
  });

  it.each(golden.skipped.map((s) => [s.source, s.reason] as const))('%s: refuses it with the code of n8n\'s refusal', (source, reason) => {
    const [, error, message] = /^(\w+): ([\s\S]*)$/.exec(reason)!;
    const site = v2RefusalOf(error!, message!);
    expect(site, reason).toBeDefined();
    let code: string | undefined;
    try {
      portGraph(source, undefined);
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      code = e.code;
    }
    expect(V2_REFUSALS[site!].codes).toContain(code);
  });
});

describe('verify CLI --profile engineV2 on the committed workflows', () => {
  const io = (): CliIo => ({
    readFile: (p) => readFileSync(resolve(repo, p), 'utf8'), writeFile: () => {}, stdout: () => {}, stderr: () => {},
  });

  it.each(testbed.map((e) => e.source))('%s: accepted, as n8n accepts it (exit 0)', async (source) => {
    expect(await runCli([source, '--profile', 'engineV2', '--quiet'], io())).toBe(0);
  });

  it.each(golden.skipped.map((s) => s.source))('%s: refused, as n8n refuses it (exit 2)', async (source) => {
    expect(await runCli([source, '--profile', 'engineV2', '--quiet'], io())).toBe(2);
  });
});
