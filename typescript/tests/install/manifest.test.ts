/**
 * `validateManifest` and `loadManifests`: the guards that keep a manifest, which `--seams <dir>`
 * accepts from any directory, from naming a file outside n8n-core or a delta outside its own
 * directory. Each malformed manifest must throw before the installer reads or writes anything.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifests, validateManifest, type SeamManifest } from '../../src/install/manifest.js';
import { CORE_VERSION, DIST, cleanupTrees, makeSeams } from './support.js';

afterEach(() => cleanupTrees());

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
type Manifest = Mutable<SeamManifest>;

function fixture(): { seams: string; manifest: Manifest } {
  const seams = makeSeams();
  const manifest = JSON.parse(readFileSync(join(seams, CORE_VERSION, 'manifest.json'), 'utf8')) as Manifest;
  return { seams, manifest };
}

const check = (m: Manifest): SeamManifest => validateManifest(m, 'manifest.json');

describe('validateManifest', () => {
  it('accepts the fixture manifest', () => {
    expect(check(fixture().manifest).version).toBe(CORE_VERSION);
  });

  const cases: [string, (m: Manifest) => void, RegExp][] = [
    ['a ../ file path', (m) => { m.files[0]!.path = `${DIST}/../../../outside.js`; }, /bad path/],
    ['an absolute file path', (m) => { m.files[0]!.path = '/etc/passwd'; }, /bad path/],
    ['a ../ delta source', (m) => { m.files[2]!.deltaSource = '../n8n-core/dist/x.js'; }, /bad path/],
    ['a delta name with a /', (m) => { m.files[0]!.delta = '../index.js.delta.json'; }, /bad delta name/],
    ['a delta source that is a created file', (m) => { m.files[0]!.deltaSource = m.files[2]!.path; m.files[0]!.deltaSourceSha256 = m.files[2]!.after; }, /must be a stock file of this manifest/],
    ['a delta source hash that differs from the source\'s before', (m) => { m.files[2]!.deltaSourceSha256 = 'b'.repeat(64); }, /must be a stock file of this manifest/],
    ['a malformed after hash', (m) => { m.files[0]!.after = 'xyz'; }, /bad hash/],
    ['a ../ map path', (m) => { m.maps.files[0]!.path = '../outside.js.map'; }, /bad map/],
    ['a map file name with a /', (m) => { m.maps.files[0]!.file = 'sub/x.map'; }, /bad map/],
    ['a ../ maps.ifPresent', (m) => { m.maps.ifPresent = '../x.map'; }, /bad maps/],
    ['another package', (m) => { (m as { package: string }).package = 'n8n-workflow'; }, /expected n8n-core/],
  ];
  for (const [what, mutate, error] of cases) {
    it(`refuses ${what}`, () => {
      const { manifest } = fixture();
      mutate(manifest);
      expect(() => check(manifest)).toThrow(error);
    });
  }
});

describe('loadManifests', () => {
  it('refuses a manifest whose version is not its directory\'s', () => {
    const { seams } = fixture();
    renameSync(join(seams, CORE_VERSION), join(seams, '1.0.0'));
    expect(() => loadManifests(seams)).toThrow(`version ${CORE_VERSION} in directory 1.0.0`);
  });

  it('refuses a malformed manifest on load, naming its file', () => {
    const { seams, manifest } = fixture();
    manifest.files[0]!.path = '../outside.js';
    const path = join(seams, CORE_VERSION, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => loadManifests(seams)).toThrow(`${path}: bad path`);
  });
});
