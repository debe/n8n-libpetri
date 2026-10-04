/**
 * The committed seams (`typescript/seams/n8n-core/<version>/`): schema, integrity, and their tie
 * to the source patches. Re-running `scripts/release/build-seams.mjs --check` reproduces them byte
 * for byte; that needs the network and `.n8n`, so it is a release step, and this is what CI can
 * check without either.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDelta, insertedBytes, parseDelta } from '../../src/install/delta.js';
import { loadManifests } from '../../src/install/manifest.js';
import { defaultSeamsDir } from '../../src/install/package-root.js';
import { sha256 } from '../../src/install/record.js';

const PATCHES = fileURLToPath(new URL('../../../patches/n8n/', import.meta.url));
const manifests = loadManifests(defaultSeamsDir());

/** The generator's measured totals (2026-10-03). A jump means the patches or the encoder changed. */
const MAX_INSERTED_BYTES = 1515;

describe('committed seams', () => {
  it('ship n8n-core 2.41.4 (n8n 2.41.5/2.41.6) and 2.42.2 (n8n 2.42.2), and nothing else', () => {
    expect([...manifests.keys()]).toEqual(['2.41.4', '2.42.2']);
    expect(manifests.get('2.41.4')!.manifest.n8n).toEqual(['2.41.5', '2.41.6']);
    expect(manifests.get('2.42.2')!.manifest.n8n).toEqual(['2.42.2']);
  });

  for (const [version, { manifest, dir }] of manifests) {
    describe(`n8n-core ${version}`, () => {
      it('records the hashes of the source patches it was built from, which are 0001 and 0002 as committed', () => {
        const committed = Object.fromEntries(
          readdirSync(PATCHES).filter((p) => /^000[12]-.*\.patch$/.test(p)).map((p) => [p, sha256(readFileSync(join(PATCHES, p)))]),
        );
        expect(manifest.sourcePatches).toEqual(committed);
      });

      it('ships exactly the files it lists, each with its recorded hash', () => {
        const listed = [...manifest.files.map((f) => f.delta), ...manifest.maps.files.map((m) => m.file), 'manifest.json'].sort();
        expect(readdirSync(dir).sort()).toEqual(listed);
        for (const f of manifest.files) expect(sha256(readFileSync(join(dir, f.delta))), f.delta).toBe(f.deltaSha256);
        for (const m of manifest.maps.files) expect(sha256(readFileSync(join(dir, m.file))), m.file).toBe(m.after);
      });

      it('touches only the five execution-engine files patches 0001/0002 touch, and no type declarations', () => {
        expect(manifest.files.map((f) => f.path)).toEqual([
          'dist/execution-engine/workflow-execute.js',
          'dist/execution-engine/index.js',
          'dist/execution-engine/stack-scheduler.js',
          'dist/execution-engine/scheduler-registry.js',
          'dist/execution-engine/workflow-scheduler.js',
        ]);
        expect(manifest.files.filter((f) => f.before === null).map((f) => f.path)).toEqual(manifest.files.slice(2).map((f) => f.path));
        expect(manifest.maps.files.map((m) => m.path)).toEqual(manifest.files.map((f) => `${f.path}.map`));
      });

      it('carries no more inserted bytes than the generator measured, and says so truthfully', () => {
        let total = 0;
        for (const f of manifest.files) {
          const n = insertedBytes(parseDelta(JSON.parse(readFileSync(join(dir, f.delta), 'utf8'))));
          expect(n, f.delta).toBe(manifest.inserted.byFile[f.path.split('/').pop()!]);
          total += n;
        }
        expect(total).toBe(manifest.inserted.bytes);
        expect(total).toBeLessThanOrEqual(MAX_INSERTED_BYTES);
      });

      it('decodes: every op is a well-formed copy or insert', () => {
        // Without the stock bytes (they are n8n's, not ours) neither the after hash nor whether
        // a copy stays inside the stock file can be checked here: the manifest records no stock
        // size, and the source below is sized from the delta's own furthest copy, so it cannot
        // be read past. The installer checks both on the user's machine before writing (a copy
        // outside the source refuses as "does not decode", installer.test.ts). What this checks
        // is that each copy has integer bounds and a positive length and each insert is a string.
        for (const f of manifest.files) {
          const delta = parseDelta(JSON.parse(readFileSync(join(dir, f.delta), 'utf8')));
          const furthest = Math.max(0, ...delta.ops.map((op) => ('copy' in op ? op.copy[0] + op.copy[1] : 0)));
          expect(() => applyDelta(Buffer.alloc(furthest), delta)).not.toThrow();
        }
      });

      it('has no neutrality record yet, or a passing one (the installer refuses anything else)', () => {
        expect(manifest.neutrality === null || manifest.neutrality.passed).toBe(true);
      });
    });
  }
});
