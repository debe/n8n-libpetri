/**
 * Synthetic n8n installations and seams for the installer tests: a fake n8n package with a
 * fake n8n-core whose files have known bytes, and a seam directory built from them with the
 * real delta encoder. No network, no `.n8n`, no Docker.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliIo } from '../../src/cli/io.js';
import { encodeDelta, insertedBytes } from '../../src/install/delta.js';
import type { NeutralityRecord, SeamManifest } from '../../src/install/manifest.js';
import { sha256 } from '../../src/install/record.js';

export const CORE_VERSION = '9.9.9';
export const N8N_VERSION = '9.9.10';
export const DIST = 'dist/execution-engine';
export const PASSED: NeutralityRecord = { date: '2026-10-03', passed: true, summary: 'fixture' };

/** Deterministic JS-looking text, so deltas have real copies to find. */
function lines(seed: string, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`    const ${seed}_${i} = compute(${seed.length + i}, "${seed}-${(i * 7919) % 104729}");`);
  return `${out.join('\n')}\n`;
}

export const STOCK: Readonly<Record<string, string>> = {
  'workflow-execute.js': `"use strict";\nclass WorkflowExecute {\n  run() {\n${lines('loop', 120)}  }\n${lines('tail', 40)}}\nexports.WorkflowExecute = WorkflowExecute;\n//# sourceMappingURL=workflow-execute.js.map`,
  'index.js': `"use strict";\nexports.a = void 0;\n${lines('export', 20)}//# sourceMappingURL=index.js.map`,
  'workflow-execute.js.map': '{"version":3,"file":"workflow-execute.js","mappings":";;AAAA"}',
  'index.js.map': '{"version":3,"file":"index.js","mappings":";;AAAA"}',
};

export const PATCHED: Readonly<Record<string, string>> = {
  'workflow-execute.js': STOCK['workflow-execute.js']!.replace(lines('loop', 120), '    const scheduler = (0, scheduler_registry_1.getWorkflowSchedulerFactory)()();\n'),
  'index.js': STOCK['index.js']!.replace('exports.a = void 0;', 'exports.a = exports.setWorkflowSchedulerFactory = void 0;\nvar scheduler_registry_1 = require("./scheduler-registry");'),
  'stack-scheduler.js': `"use strict";\nclass StackScheduler {\n  async run(host) {\n${lines('loop', 120).replaceAll('compute(', 'host.compute(')}  }\n}\nexports.StackScheduler = StackScheduler;\n`,
  'scheduler-registry.js': '"use strict";\nlet factory = () => new StackScheduler();\nfunction setWorkflowSchedulerFactory(next) { factory = next; }\nexports.setWorkflowSchedulerFactory = setWorkflowSchedulerFactory;\n',
  'workflow-scheduler.js': '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n',
};
const MAPS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.keys(PATCHED).map((f) => [`${f}.map`, `{"version":3,"file":"${f}","sources":["../../src/execution-engine/${f.replace('.js', '.ts')}"],"mappings":";;AACA"}`]),
);

export interface Tree {
  readonly root: string;
  /** n8n's package directory (realpath). */
  readonly n8nDir: string;
  /** n8n-core's package directory (realpath). */
  readonly coreDir: string;
  readonly bin: string;
}

export interface TreeOptions {
  readonly layout?: 'npm' | 'pnpm';
  readonly maps?: boolean;
  /** Put the tree under a `_npx/` directory. */
  readonly npx?: boolean;
  /** A second, nested n8n-core copy. */
  readonly secondCore?: string;
  readonly coreVersion?: string;
}

const tmpRoots: string[] = [];

export function tempDir(prefix = 'n8n-libpetri-install-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}

/** Removes every temp tree made so far, restoring write bits first. */
export function cleanupTrees(): void {
  for (const dir of tmpRoots.splice(0)) {
    const unlock = (p: string): void => {
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          chmodSync(p, 0o755);
          for (const e of readdirSync(p)) unlock(join(p, e));
        }
      } catch {
        // dangling link
      }
    };
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCore(dir: string, version: string, maps: boolean): void {
  mkdirSync(join(dir, DIST), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'n8n-core', version, main: 'dist/index' }));
  writeFileSync(join(dir, 'dist/index.js'), '"use strict";\n');
  for (const [name, text] of Object.entries(STOCK)) {
    if (!maps && name.endsWith('.map')) continue;
    writeFileSync(join(dir, DIST, name), text);
  }
  // A file the installer must never touch.
  writeFileSync(join(dir, DIST, 'workflow-execute.d.ts'), 'export declare class WorkflowExecute {}\n');
}

export function makeTree(options: TreeOptions = {}): Tree {
  const root = tempDir();
  const base = options.npx ? join(root, '.npm', '_npx', 'abc123') : join(root, 'prefix', 'lib');
  const n8nDir = join(base, 'node_modules', 'n8n');
  mkdirSync(join(n8nDir, 'bin'), { recursive: true });
  writeFileSync(join(n8nDir, 'package.json'), JSON.stringify({ name: 'n8n', version: N8N_VERSION, dependencies: { 'n8n-core': CORE_VERSION } }));
  const bin = join(n8nDir, 'bin', 'n8n');
  writeFileSync(bin, '#!/usr/bin/env node\n');
  chmodSync(bin, 0o755);
  const version = options.coreVersion ?? CORE_VERSION;
  let coreDir: string;
  if (options.layout === 'pnpm') {
    coreDir = join(n8nDir, 'node_modules', '.pnpm', `n8n-core@${version}`, 'node_modules', 'n8n-core');
    writeCore(coreDir, version, options.maps ?? true);
    symlinkSync(relative(join(n8nDir, 'node_modules'), coreDir), join(n8nDir, 'node_modules', 'n8n-core'));
  } else {
    coreDir = join(n8nDir, 'node_modules', 'n8n-core');
    writeCore(coreDir, version, options.maps ?? true);
  }
  if (options.secondCore !== undefined) {
    writeCore(join(n8nDir, 'node_modules', 'some-node', 'node_modules', 'n8n-core'), options.secondCore, false);
    writeFileSync(join(n8nDir, 'node_modules', 'some-node', 'package.json'), JSON.stringify({ name: 'some-node', version: '1.0.0' }));
  }
  return { root, n8nDir: realpathSync(n8nDir), coreDir: realpathSync(coreDir), bin };
}

/** A seam directory for {@link STOCK} → {@link PATCHED}, built as `build-seams.mjs` builds one. */
export function makeSeams(options: { neutrality?: NeutralityRecord | null; version?: string; n8n?: string[] } = {}): string {
  const version = options.version ?? CORE_VERSION;
  const seams = tempDir('n8n-libpetri-seams-');
  const dir = join(seams, version);
  mkdirSync(dir, { recursive: true });
  const files: SeamManifest['files'][number][] = [];
  const byFile: Record<string, number> = {};
  for (const [name, text] of Object.entries(PATCHED)) {
    const stock = STOCK[name];
    const from = stock === undefined ? 'workflow-execute.js' : name;
    const delta = encodeDelta(Buffer.from(STOCK[from]!), Buffer.from(text));
    const deltaText = `${JSON.stringify(delta)}\n`;
    writeFileSync(join(dir, `${name}.delta.json`), deltaText);
    byFile[name] = insertedBytes(delta);
    files.push({
      path: `${DIST}/${name}`,
      before: stock === undefined ? null : sha256(Buffer.from(stock)),
      after: sha256(Buffer.from(text)),
      delta: `${name}.delta.json`,
      deltaSha256: sha256(Buffer.from(deltaText)),
      deltaSource: `${DIST}/${from}`,
      deltaSourceSha256: sha256(Buffer.from(STOCK[from]!)),
    });
  }
  const maps = Object.entries(MAPS).map(([name, text]) => {
    writeFileSync(join(dir, name), text);
    const stock = STOCK[name];
    return { path: `${DIST}/${name}`, before: stock === undefined ? null : sha256(Buffer.from(stock)), after: sha256(Buffer.from(text)), file: name };
  });
  const manifest: SeamManifest = {
    schema: 1,
    package: 'n8n-core',
    version,
    n8n: options.n8n ?? [N8N_VERSION],
    tarball: { name: `n8n-core-${version}.tgz`, integrity: 'sha512-fixture' },
    sourcePatches: { '0001-extract-scheduler-loop.patch': '0'.repeat(64), '0002-scheduler-registry.patch': '1'.repeat(64) },
    toolchain: { generator: 'tests/install/support.ts' },
    files,
    maps: { ifPresent: `${DIST}/workflow-execute.js.map`, files: maps },
    inserted: { bytes: Object.values(byFile).reduce((a, b) => a + b, 0), byFile },
    neutrality: options.neutrality === undefined ? PASSED : options.neutrality,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return seams;
}

/** path → sha256 of every file under `dir`, for byte-identical comparisons. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[relative(dir, p)] = sha256(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

export interface CapturedIo extends CliIo {
  readonly out: string[];
  readonly err: string[];
}

export function captureIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t) => { out.push(t); },
    stderr: (t) => { err.push(t); },
    writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
    readFile: (p) => readFileSync(p, 'utf8'),
  };
}

/** The shipped `EXTERNAL_HOOK_FILES` entry. */
export const HOOK_SOURCE = fileURLToPath(new URL('../../hook/n8n-hook.cjs', import.meta.url));

/** n8n's `ExternalHooks.init()` + `loadHooks()`, verbatim in behaviour. */
export const N8N_LOADER = `
const registered = {};
function loadHooks(hookFileData) {
  for (const [resource, operations] of Object.entries(hookFileData)) {
    for (const operation of Object.keys(operations)) {
      const hookName = resource + '.' + operation;
      registered[hookName] ??= [];
      registered[hookName].push(...operations[operation]);
    }
  }
}
const files = (process.env.EXTERNAL_HOOK_FILES ?? '').split(':').filter(Boolean);
for (let hookFilePath of files) {
  hookFilePath = hookFilePath.trim();
  try {
    const hookFile = require(hookFilePath);
    loadHooks(hookFile);
  } catch (e) {
    console.error('UnexpectedError: Problem loading external hook file ' + hookFilePath);
    process.exit(42);
  }
}
console.log(JSON.stringify({ registered, booted: globalThis.__n8nLibpetriBooted ?? null }));
`;

