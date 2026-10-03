/**
 * What an install would write, computed entirely in memory and checked before anything is
 * touched (`tasks/inject-plan.md` decision 10, steps 2 and 4): every stock file hashes to its
 * `before`, every file the patches create is absent, and every rebuilt output hashes to its
 * `after`. A plan that exists is a plan whose every byte is known to be right.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDelta, DeltaError, parseDelta } from './delta.js';
import { refused } from './errors.js';
import type { LoadedManifest } from './manifest.js';
import { sha256, sha256File, type RecordedFile } from './record.js';

export interface PlannedWrite extends RecordedFile {
  readonly bytes: Buffer;
  readonly kind: 'code' | 'map';
}

export interface InstallPlan {
  readonly writes: readonly PlannedWrite[];
  /** Whether the target ships source maps, so the regenerated ones are installed. */
  readonly maps: boolean;
}

/** One stock file that does not hash to the manifest's `before`, or a created file that already exists. */
export interface Mismatch {
  readonly path: string;
  readonly expected: string | null;
  readonly found: string | null;
}

/** Every file of the manifest whose current bytes are not the stock ones the seams were built from. */
export function stockMismatches(coreDir: string, loaded: LoadedManifest): Mismatch[] {
  const { manifest } = loaded;
  const out: Mismatch[] = [];
  const check = (path: string, before: string | null): void => {
    const found = sha256File(join(coreDir, path));
    if (found !== before) out.push({ path, expected: before, found });
  };
  for (const f of manifest.files) check(f.path, f.before);
  if (existsSync(join(coreDir, manifest.maps.ifPresent))) {
    for (const m of manifest.maps.files) check(m.path, m.before);
  }
  return out;
}

export function describeMismatch(m: Mismatch): string {
  if (m.expected === null) return `${m.path} already exists (sha256 ${m.found}); the stock release has no such file`;
  if (m.found === null) return `${m.path} is missing (expected sha256 ${m.expected})`;
  return `${m.path} has sha256 ${m.found}, expected ${m.expected}`;
}

/** Builds every output and checks it. Throws a refusal on the first stock or output mismatch. */
export function planInstall(coreDir: string, loaded: LoadedManifest): InstallPlan {
  const { manifest, dir } = loaded;
  const mismatches = stockMismatches(coreDir, loaded);
  if (mismatches.length > 0) {
    throw refused(`n8n-core ${manifest.version} at ${coreDir} is not the stock release the seams were built from: ${mismatches.map(describeMismatch).join('; ')}`);
  }
  const writes: PlannedWrite[] = [];
  for (const f of manifest.files) {
    const deltaBytes = readFileSync(join(dir, f.delta));
    if (sha256(deltaBytes) !== f.deltaSha256) throw refused(`the shipped ${f.delta} is damaged (sha256 ${sha256(deltaBytes)}, expected ${f.deltaSha256}); reinstall n8n-libpetri`);
    const source = readFileSync(join(coreDir, f.deltaSource));
    if (sha256(source) !== f.deltaSourceSha256) throw refused(`${f.deltaSource} changed while planning`);
    let bytes: Buffer;
    try {
      bytes = applyDelta(source, parseDelta(JSON.parse(deltaBytes.toString('utf8'))));
    } catch (e) {
      if (e instanceof DeltaError || e instanceof SyntaxError) throw refused(`the shipped ${f.delta} does not decode: ${e.message}; reinstall n8n-libpetri`);
      throw e;
    }
    if (sha256(bytes) !== f.after) throw refused(`rebuilding ${f.path} gave sha256 ${sha256(bytes)}, expected ${f.after}; nothing was written`);
    writes.push({ path: f.path, before: f.before, after: f.after, bytes, kind: 'code' });
  }
  const maps = existsSync(join(coreDir, manifest.maps.ifPresent));
  if (maps) {
    for (const m of manifest.maps.files) {
      const bytes = readFileSync(join(dir, m.file));
      if (sha256(bytes) !== m.after) throw refused(`the shipped ${m.file} is damaged (sha256 ${sha256(bytes)}, expected ${m.after}); reinstall n8n-libpetri`);
      writes.push({ path: m.path, before: m.before, after: m.after, bytes, kind: 'map' });
    }
  }
  return { writes, maps };
}
