/**
 * The loop-driving classifier, pinned against the real baseline so that every change to
 * `LOOP_DRIVING_PATTERNS` or `LOOP_DRIVING_FILE` shows up as a count change here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseJunit, allCases, classifyCase, describeBlocks, titleOf, LOOP_DRIVING_FILE, LOOP_DRIVING_PATTERNS,
} from '../../src/conformance/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/baseline.junit.xml', import.meta.url));
const cases = allCases(parseJunit(readFileSync(FIXTURE, 'utf8')));
const loopDriving = cases.filter((c) => classifyCase(c).loopDriving);
const short = (file: string) => file.replace('src/execution-engine/__tests__/', '');

describe('LOOP_DRIVING_FILE', () => {
  it('accepts the four workflow-execute files and nothing else', () => {
    const files = [...new Set(cases.map((c) => c.file))];
    expect(files.filter((f) => LOOP_DRIVING_FILE.test(f)).map(short).sort()).toEqual([
      'workflow-execute-node-error-reporting.test.ts',
      'workflow-execute-process-process-run-execution-data.test.ts',
      'workflow-execute-run-node.test.ts',
      'workflow-execute.test.ts',
    ]);
    expect(LOOP_DRIVING_FILE.test('src/execution-engine/__tests__/webhook-respond-branch-order.test.ts')).toBe(false);
    expect(LOOP_DRIVING_FILE.test('workflow-execute.test.ts')).toBe(true);
  });
});

describe('LOOP_DRIVING_PATTERNS', () => {
  it('has unique ids and a rationale each', () => {
    const ids = LOOP_DRIVING_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LOOP_DRIVING_PATTERNS.every((p) => p.rationale.length > 40)).toBe(true);
  });

  it('yields the pinned counts on the baseline', () => {
    const counts = Object.fromEntries(
      LOOP_DRIVING_PATTERNS.map((p) => [p.id, loopDriving.filter((c) => classifyCase(c).pattern === p.id).length]),
    );
    expect(counts).toEqual({ 'execution-order': 19, 'hook-order': 6, 'branch-order': 0, waiting: 9, partial: 2 });
    expect(loopDriving).toHaveLength(36);
  });

  it('finds the 19 execution-order cases: 12 v0 and 7 v1, all in workflow-execute.test.ts', () => {
    const eo = loopDriving.filter((c) => classifyCase(c).pattern === 'execution-order');
    expect(eo.every((c) => short(c.file) === 'workflow-execute.test.ts')).toBe(true);
    expect(eo.filter((c) => c.name.includes('v0 execution order'))).toHaveLength(12);
    expect(eo.filter((c) => c.name.includes('v1 execution order'))).toHaveLength(7);
    expect(eo.map((c) => c.name)).toContain(
      'WorkflowExecute > v1 execution order > should execute nodes in the correct order, depth-first & the most top-left one first',
    );
  });

  it('finds the waiting cases in the processRunExecutionData file only', () => {
    const w = loopDriving.filter((c) => classifyCase(c).pattern === 'waiting');
    expect(w.every((c) => short(c.file) === 'workflow-execute-process-process-run-execution-data.test.ts')).toBe(true);
    expect(w.filter((c) => c.name.includes('runExecutionData.waitTill'))).toHaveLength(3);
    expect(w.filter((c) => c.name.includes('waiting tools'))).toHaveLength(6);
  });

  it('finds the two partial cases that let the loop run, out of 13 in the block', () => {
    const block = cases.filter((c) => describeBlocks(c.name).includes('runPartialWorkflow2'));
    expect(block).toHaveLength(13);
    expect(block.every((c) => short(c.file) === 'workflow-execute.test.ts')).toBe(true);
    const partial = block.filter((c) => classifyCase(c).pattern === 'partial');
    expect(partial.map((c) => titleOf(c.name))).toEqual([
      'increments partial execution index starting with max index of previous runs',
      'increments partial execution index starting with max index of 0 of previous runs',
    ]);
    // The other eleven mock `processRunExecutionData` away and assert on the stack they built.
    expect(block.filter((c) => !classifyCase(c).loopDriving)).toHaveLength(11);
  });

  it('matches describe blocks; a title only narrows a block match', () => {
    expect(describeBlocks('A > b c > d')).toEqual(['A', 'b c']);
    expect(describeBlocks('only a title')).toEqual([]);
    expect(titleOf('A > b c > d')).toBe('d');
    expect(titleOf('only a title')).toBe('only a title');
    const we = 'src/execution-engine/__tests__/workflow-execute.test.ts';
    expect(classifyCase({ file: we, name: 'WorkflowExecute > runPartialWorkflow2 > increments partial execution index somehow' }))
      .toEqual({ loopDriving: true, pattern: 'partial' });
    expect(classifyCase({ file: we, name: 'WorkflowExecute > runPartialWorkflow2 > passes subgraph to `cleanRunData`' }))
      .toEqual({ loopDriving: false });
    // A title match without its block is nothing.
    expect(classifyCase({ file: we, name: 'WorkflowExecute > other > increments partial execution index somehow' }))
      .toEqual({ loopDriving: false });
    const file = 'src/execution-engine/__tests__/workflow-execute-run-node.test.ts';
    // Real run-node helper cases whose titles name the execution order.
    for (const title of [
      'should use first main input for v1 execution order when forceInputNodeExecution is false',
      'should use first main input for v0 execution order when forceInputNodeExecution is true',
    ]) {
      const name = `WorkflowExecute.runNode - Real Implementation > execution order and input data handling > ${title}`;
      expect(cases.some((c) => c.file === file && c.name === name)).toBe(true);
      expect(classifyCase({ file, name })).toEqual({ loopDriving: false });
    }
    expect(classifyCase({ file, name: 'x > v1 execution order > title' })).toEqual({ loopDriving: true, pattern: 'execution-order' });
    expect(classifyCase({ file, name: 'v1 execution order' })).toEqual({ loopDriving: false });
  });

  it('does not count helper suites whose names resemble the patterns', () => {
    const helperNames = [
      'WorkflowExecute > prepareWaitingToExecution > should handle multiple run indices',
      'WorkflowExecute.runNode - Real Implementation > execution order and input data handling > preserves input order',
      'WorkflowExecute > assignPairedItems > should process multiple output branches correctly',
      'WorkflowExecute > runPartialWorkflow2 > rewires graph for partial execution of tools',
      'WorkflowExecute > waitTill handling > handles waiting state when waitTill is set',
    ];
    for (const name of helperNames) {
      expect(classifyCase({ file: 'src/execution-engine/__tests__/workflow-execute.test.ts', name })).toEqual({ loopDriving: false });
    }
    expect(cases.filter((c) => c.name.includes('prepareWaitingToExecution')).some((c) => classifyCase(c).loopDriving)).toBe(false);
    expect(cases.filter((c) => c.name.includes('runPartialWorkflow2') && classifyCase(c).loopDriving)).toHaveLength(2);
  });

  it('never marks a case outside the workflow-execute files', () => {
    const outside = cases.filter((c) => !LOOP_DRIVING_FILE.test(c.file));
    expect(outside.length).toBe(1657 - 208);
    expect(outside.some((c) => classifyCase(c).loopDriving)).toBe(false);
    // The name would match; the file rule is what keeps it out.
    expect(classifyCase({ file: 'src/execution-engine/__tests__/webhook-respond-branch-order.test.ts', name: 'webhook responseNode branch ordering > x' }))
      .toEqual({ loopDriving: false });
    expect(classifyCase({ file: 'src/execution-engine/__tests__/workflow-execute.test.ts', name: 'webhook responseNode branch ordering > x' }))
      .toEqual({ loopDriving: true, pattern: 'branch-order' });
  });
});
