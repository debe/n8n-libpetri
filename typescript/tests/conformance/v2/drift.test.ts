/**
 * `V2_REFUSALS` (`compiler/analysis/engine-v2/refusals.ts`) and its drift guard
 * (`conformance/v2/drift.ts`, `tasks/v2-acceptance.mts` leg 4): every n8n throw site on the way
 * to an engine v2 graph is mapped to a code, and a thrown error names its site by class and
 * message. The guard runs on n8n's own sources when a checkout at the pin is present; the rest
 * needs none.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V2_REFUSALS, v2RefusalOf } from '../../../src/compiler/index.js';
import type { V2RefusalFile, V2RefusalSite } from '../../../src/compiler/index.js';
import { refusalDrift, throwSitesIn } from '../../../src/conformance/v2/drift.js';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.n8n/packages/@n8n');
const SOURCES: Record<V2RefusalFile, string> = {
  'v1-workflow-converter.ts': `${pkg}/node-engine-compatibility/src/v1-workflow-converter.ts`,
  'loops.ts': `${pkg}/engine/src/graph/loops.ts`,
  'validate-executable-graph.ts': `${pkg}/engine/src/graph/validate-executable-graph.ts`,
};
const haveSources = Object.values(SOURCES).every((p) => existsSync(p));

describe('V2_REFUSALS', () => {
  const keys = Object.keys(V2_REFUSALS) as V2RefusalSite[];

  it('maps each site to at most two codes, two only for the slot rule\'s output and input side', () => {
    for (const k of keys) {
      const { codes } = V2_REFUSALS[k];
      if (codes.length === 2) expect([...codes], k).toEqual(['output-index-out-of-range', 'input-index-out-of-range']);
      else expect(codes.length, k).toBeLessThanOrEqual(1);
    }
  });

  it('leaves unmapped only the sites the port rules out', () => {
    expect(keys.filter((k) => V2_REFUSALS[k].codes.length === 0).sort()).toEqual([
      'backEdgeFromOutside', 'duplicateId', 'noBatchSize', 'notBatchTarget', 'severalTriggers', 'unknownEndpoint',
    ]);
  });

  it('names a site from an error by class, and by message where one class has several sites', () => {
    expect(v2RefusalOf('AmbiguousTriggerError', 'anything')).toBe('ambiguousTrigger');
    expect(v2RefusalOf('UnsupportedWorkflowError', 'Node "M" uses Merge mode "chooseBranch", which is not supported yet.'))
      .toBe('mergeChooseBranch');
    expect(v2RefusalOf('UnsupportedWorkflowError',
      'Node "B" has a batch size of 0, and it must be a whole number of at least 1.')).toBe('batchSizeInvalid');
    expect(v2RefusalOf('GraphValidationError',
      'Batch node B has no batch size, and it must be a whole number of at least 1')).toBe('noBatchSize');
    expect(v2RefusalOf('GraphValidationError', 'Edge a -> b has slot index 101; slot indices above 100 are not supported yet'))
      .toBe('slotAboveMax');
    expect(v2RefusalOf('UnimplementedError', 'Node x has more than one edge into input slot 0; converging branches on one slot is not supported yet'))
      .toBe('convergingInput');
    expect(v2RefusalOf('TypeError', 'x')).toBeUndefined();
    expect(v2RefusalOf('UnsupportedWorkflowError', 'a message no site throws')).toBeUndefined();
  });
});

describe('the drift guard', () => {
  it('finds every throw with its balanced argument list', () => {
    const sites = throwSitesIn('loops.ts', 'a\nthrow new A(`x ${f(y)} (0)`);\n  throw new B(g(h()));');
    expect(sites.map((s) => [s.error, s.line, s.text])).toEqual([
      ['A', 2, 'throw new A(`x ${f(y)} (0)`)'], ['B', 3, 'throw new B(g(h()))'],
    ]);
  });

  it('reports a site no entry maps, an entry no site matches, and a file it was not given', () => {
    const drift = refusalDrift({
      'validate-executable-graph.ts': "throw new GraphValidationError('Graph has no trigger node to start from');\n" +
        "throw new GraphValidationError('a new rule');",
    });
    expect(drift.unmapped.map((s) => s.text)).toEqual(["throw new GraphValidationError('a new rule')"]);
    expect(drift.stale).toContain('convergingInput');
    expect(drift.stale).not.toContain('noTrigger');
    // Entries of a file not given are not stale: the file is missing.
    expect(drift.stale).not.toContain('nestedLoop');
    expect([...drift.missing].sort()).toEqual(['loops.ts', 'v1-workflow-converter.ts']);
  });

  it.skipIf(!haveSources)('is clean on n8n\'s own sources at the pin: every throw mapped, every entry a throw', () => {
    const drift = refusalDrift(Object.fromEntries(
      Object.entries(SOURCES).map(([f, p]) => [f, readFileSync(p, 'utf8')])) as Record<V2RefusalFile, string>);
    expect(drift.unmapped).toEqual([]);
    expect(drift.stale).toEqual([]);
    expect(drift.missing).toEqual([]);
    expect(drift.sites).toHaveLength(Object.keys(V2_REFUSALS).length);
  });
});
