/**
 * v1 nets stay what they were (ADR 0012 §1, `tasks/v2-profile-plan.md` decision 1 and step 1).
 *
 * Every subject in `v1-fingerprint.ts` — each fixture of `tests/fixtures/workflows.ts` and each
 * committed testbed workflow, read the way the verify CLI reads it without `--node-types` — is
 * compiled with the compiler as it is and compared line by line with
 * `tests/fixtures/v1-fingerprint.json`, which was recorded before the engine v2 profile
 * existed. A failure lists `- recorded line` / `+ current line` per subject, so it names the
 * place, arc, `Out` branch or priority that moved.
 *
 * The recording is written by `v1-fingerprint.gen.ts` (`npx tsx
 * tests/compiler/v1-fingerprint.gen.ts --force`, from `typescript/`). Do not regenerate it to
 * make this test pass: a v1 net that changes while the v2 profile lands is the regression the
 * profile's single switch point (decision 2) is meant to rule out.
 */
import { readFileSync } from 'node:fs';
import { compile } from '../../src/compiler/index.js';
import { diamond } from '../fixtures/workflows.js';
import { FINGERPRINT_FILE, diffLines, entryOf, fingerprint, subjects, type FingerprintFile } from './v1-fingerprint.js';

const recorded = JSON.parse(readFileSync(FINGERPRINT_FILE, 'utf8')) as FingerprintFile;
const current = subjects();

describe('v1 net fingerprint', () => {
  it('covers exactly the recorded subjects', () => {
    expect(current.map((s) => s.key).sort()).toEqual(Object.keys(recorded.subjects).sort());
  });

  it.each(current.map((s) => [s.key, s] as const))('%s is unchanged', (key, subject) => {
    const want = recorded.subjects[key];
    if (want === undefined) throw new Error(`${key} has no recorded fingerprint`);
    const got = entryOf(subject);
    if ('error' in want || 'error' in got) {
      expect(got).toEqual(want);
      return;
    }
    expect(diffLines(want.lines, got.lines)).toEqual([]);
  });
});

// The subjects name v1 explicitly, so the fingerprint does not depend on the library default.
// ADR 0015 made that default v1 again: a compile with no profile is the recorded v1 net, and an
// engineV2 compile is not.
describe('the fingerprint compiles v1 by name', () => {
  it('every subject compiles to a v1 net', () => {
    for (const subject of current) {
      const entry = entryOf(subject);
      if ('error' in entry) continue;
      expect(subject.compile().netMap.profile, subject.key).toBe('v1');
    }
  });

  it('the default compile is the recorded v1 net, and an engineV2 compile is not', () => {
    const want = recorded.subjects['fixture:diamond'];
    if (want === undefined || 'error' in want) throw new Error('fixture:diamond has no recorded lines');
    expect(compile(diamond).netMap.profile).toBe('v1');
    expect(diffLines(want.lines, fingerprint(compile(diamond)))).toEqual([]);
    expect(diffLines(want.lines, fingerprint(compile(diamond, { profile: 'v1' })))).toEqual([]);
    expect(diffLines(want.lines, fingerprint(compile(diamond, { profile: 'engineV2' })))).not.toEqual([]);
  });
});

describe('diffLines', () => {
  it('is empty for equal lists', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('names a removed and an added line', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual(['- b', '+ x']);
  });

  it('counts a duplicated line', () => {
    expect(diffLines(['a'], ['a', 'a'])).toEqual(['+ a']);
  });

  it('reports a reorder of the same lines', () => {
    expect(diffLines(['a', 'b'], ['b', 'a'])).toEqual(['order differs at line 0: expected "a", got "b"']);
  });
});
