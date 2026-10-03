/**
 * The seam manifests the installer ships (`seams/n8n-core/<version>/manifest.json`), written by
 * `scripts/release/build-seams.mjs` (`tasks/inject-plan.md` decisions 3-6).
 *
 * Support is keyed on the **n8n-core** version, because that is the package the installer
 * patches and n8n-core releases more slowly than n8n (n8n 2.41.5 and 2.41.6 both pin 2.41.4).
 * n8n's own version is reported, never trusted. An entry is supported only when its version is
 * listed, every `before` hash matches the target, and its neutrality record is filled in.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refused } from './errors.js';
import { sha256 } from './record.js';

export interface ManifestFile {
  /** Relative to the n8n-core directory. */
  readonly path: string;
  /** sha256 of the stock file, or null for a file the patches create. */
  readonly before: string | null;
  readonly after: string;
  readonly delta: string;
  readonly deltaSha256: string;
  /** The stock file the delta copies from (itself for a replaced file). */
  readonly deltaSource: string;
  readonly deltaSourceSha256: string;
}

export interface ManifestMap {
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
  /** The shipped map, beside the manifest. */
  readonly file: string;
}

/** The release-neutrality run that licenses an entry (plan step 9). */
export interface NeutralityRecord {
  readonly date: string;
  readonly passed: boolean;
  readonly summary: string;
  readonly [key: string]: unknown;
}

export interface SeamManifest {
  readonly schema: 1;
  readonly package: 'n8n-core';
  readonly version: string;
  /** The n8n releases that pin this n8n-core version. */
  readonly n8n: readonly string[];
  readonly tarball: { readonly name: string; readonly integrity: string };
  readonly sourcePatches: Readonly<Record<string, string>>;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly files: readonly ManifestFile[];
  /** Installed only when `ifPresent` exists in the target: an n8n-core shipped without maps gets none. */
  readonly maps: { readonly ifPresent: string; readonly files: readonly ManifestMap[] };
  readonly inserted: { readonly bytes: number; readonly byFile: Readonly<Record<string, number>> };
  readonly neutrality: NeutralityRecord | null;
}

export interface LoadedManifest {
  readonly manifest: SeamManifest;
  /** The directory holding the manifest, its deltas and maps. */
  readonly dir: string;
  readonly sha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Checks a parsed manifest's shape. Throws on anything the installer would trip over later. */
export function validateManifest(json: unknown, where: string): SeamManifest {
  const fail = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  if (typeof json !== 'object' || json === null) fail('not an object');
  const m = json as Partial<SeamManifest>;
  if (m.schema !== 1) fail(`schema ${String(m.schema)}, expected 1`);
  if (m.package !== 'n8n-core') fail(`package ${String(m.package)}, expected n8n-core`);
  if (typeof m.version !== 'string') fail('no version');
  if (!Array.isArray(m.n8n) || m.n8n.length === 0) fail('no n8n versions');
  if (!Array.isArray(m.files) || m.files.length === 0) fail('no files');
  const relative = (p: unknown): boolean => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').includes('..');
  const plain = (p: unknown): boolean => typeof p === 'string' && /^[A-Za-z0-9._-]+$/.test(p);
  for (const f of m.files!) {
    if (!relative(f.path) || !relative(f.deltaSource)) fail(`bad path in ${JSON.stringify(f)}`);
    if (!plain(f.delta)) fail(`bad delta name ${String(f.delta)}`);
    if (f.before !== null && !HEX64.test(String(f.before))) fail(`bad before hash for ${f.path}`);
    for (const h of [f.after, f.deltaSha256, f.deltaSourceSha256]) if (!HEX64.test(String(h))) fail(`bad hash for ${f.path}`);
    const source = m.files!.find((g) => g.path === f.deltaSource);
    if (source === undefined || source.before === null || source.before !== f.deltaSourceSha256) {
      fail(`${f.path}: its delta source ${f.deltaSource} must be a stock file of this manifest`);
    }
  }
  if (typeof m.maps !== 'object' || m.maps === null || !relative(m.maps.ifPresent) || !Array.isArray(m.maps.files)) fail('bad maps');
  for (const f of m.maps!.files) {
    if (!relative(f.path) || !plain(f.file)) fail(`bad map ${JSON.stringify(f)}`);
    if (f.before !== null && !HEX64.test(String(f.before))) fail(`bad before hash for ${f.path}`);
    if (!HEX64.test(String(f.after))) fail(`bad after hash for ${f.path}`);
  }
  if (m.neutrality !== null && (typeof m.neutrality !== 'object' || typeof m.neutrality?.passed !== 'boolean')) fail('bad neutrality record');
  return m as SeamManifest;
}

/** Every manifest under `seamsDir`, by n8n-core version. */
export function loadManifests(seamsDir: string): Map<string, LoadedManifest> {
  const out = new Map<string, LoadedManifest>();
  if (!existsSync(seamsDir)) return out;
  for (const version of readdirSync(seamsDir).sort()) {
    const dir = join(seamsDir, version);
    const path = join(dir, 'manifest.json');
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    const manifest = validateManifest(JSON.parse(bytes.toString('utf8')), path);
    if (manifest.version !== version) throw new Error(`${path}: version ${manifest.version} in directory ${version}`);
    out.set(version, { manifest, dir, sha256: sha256(bytes) });
  }
  return out;
}

/** The n8n versions the shipped manifests cover, for a refusal's message. */
export function supportedN8n(manifests: ReadonlyMap<string, LoadedManifest>): string {
  const rows = [...manifests.values()].map(({ manifest: m }) => `n8n ${m.n8n.join('/')} (n8n-core ${m.version}${m.neutrality?.passed ? '' : ', no neutrality record yet'})`);
  return rows.length === 0 ? 'none' : rows.join('; ');
}

/** The manifest for `coreVersion`, or a refusal naming what is supported. */
export function manifestFor(manifests: ReadonlyMap<string, LoadedManifest>, coreVersion: string, n8nVersion: string | undefined): LoadedManifest {
  const found = manifests.get(coreVersion);
  if (found === undefined) {
    throw refused(`n8n-core ${coreVersion}${n8nVersion === undefined ? '' : ` (n8n ${n8nVersion})`} is not supported; supported: ${supportedN8n(manifests)}`);
  }
  return found;
}

/** Refuses an entry whose neutrality record is missing or failed, unless the caller accepts that. */
export function requireNeutrality(loaded: LoadedManifest, allowUnverified: boolean): boolean {
  const n = loaded.manifest.neutrality;
  if (n !== null && n.passed) return false;
  if (allowUnverified) return true;
  throw refused(
    `the seams for n8n-core ${loaded.manifest.version} have ${n === null ? 'no neutrality record' : 'a failed neutrality record'} ` +
      '(the release run that shows the patched n8n passes its own suite); pass --allow-unverified to install them anyway',
  );
}
