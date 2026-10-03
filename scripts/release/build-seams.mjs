#!/usr/bin/env node
/**
 * build-seams.mjs — produce the installer's seams for released n8n versions
 * (`typescript/seams/n8n-core/<core-version>/`, ADR 0015, `tasks/inject-plan.md` decisions 4-6).
 *
 *   node scripts/release/build-seams.mjs [--check] [--review <dir>] [--keep] <n8n-tag>...
 *   e.g. node scripts/release/build-seams.mjs n8n@2.41.5 n8n@2.41.6 n8n@2.42.2
 *
 * For each tag, read from `.n8n`'s object database only (`git show` / `git archive`, never a
 * checkout, so `.n8n`'s working tree and index are untouched — checked before and after):
 *
 *   1. The n8n-core version the tag pins (`packages/core/package.json`, cross-checked against the
 *      dependency `n8n@<version>` declares on npm), and its published tarball, fetched with
 *      `npm pack` and checked against the registry's `dist.integrity`.
 *   2. The tag's `packages/core/src/execution-engine/` and the tsconfig chain, extracted into a
 *      scratch directory under /private/tmp. The effective compiler options are parsed from
 *      `packages/core/tsconfig.build.json` by TypeScript itself.
 *   3. **The gate.** The *unpatched* sources of every file the patches touch are transpiled one
 *      file at a time (`transpileModule`, CommonJS, then the `@/` rewrite tsc-alias does) and
 *      must equal the published JS byte for byte. If they do not, this script stops: nothing is
 *      generated for a release we cannot reproduce. (The plan's fallbacks, a `tsc --noCheck`
 *      build and a full worktree build, are not implemented; no measured release needs them.)
 *   4. Patches 0001 and 0002 are applied to the scratch copy with `git apply` (exact context,
 *      no fuzz), and the five touched files are transpiled the same way, with source maps.
 *   5. Each patched JS file is encoded as a copy/insert delta against the stock file it
 *      replaces or, for a file the patches create, the stock touched file it copies the most
 *      from (`typescript/src/install/delta.ts`). The regenerated maps are shipped whole: they
 *      are mappings only (published maps carry no `sourcesContent`).
 *
 * Tags that pin the same n8n-core version must produce identical stock and patched bytes; they
 * become one manifest whose `n8n` lists them all. A manifest's `neutrality` record (filled by
 * the release-neutrality step) is carried over when the regenerated `after` hashes equal the
 * committed ones, and reset to null when they do not. Nothing here is time-stamped, so a rerun
 * reproduces the committed seams byte for byte; `--check` compares instead of writing and exits
 * 1 on any difference.
 *
 * The transpiler is the `typescript` version the tag's root `package.json` names (6.0.2 for
 * 2.40-2.42), installed into the scratch directory. The release itself was built with
 * `catalog:typescript` (7.0.2, native); the gate is what licenses using the API version: it
 * reproduces the JS. It does not reproduce the stock *maps* (their `mappings` differ), which is
 * why every touched file's map is regenerated and shipped, not only the patched ones.
 *
 * Needs network (npm) and `.n8n` with the tags fetched. Writes nothing outside
 * `typescript/seams/`, the scratch directory (removed unless --keep) and `--review`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const N8N_DIR = process.env.N8N_DIR ?? join(ROOT, '.n8n');
const PATCH_DIR = join(ROOT, 'patches/n8n');
const SEAMS_DIR = join(ROOT, 'typescript/seams/n8n-core');
const SOURCE_PATCHES = ['0001-extract-scheduler-loop.patch', '0002-scheduler-registry.patch'];
const ENGINE_SRC = 'packages/core/src/execution-engine';
/** Every file 0001/0002 touch, by output name; `stock` ones exist in the release. */
const TOUCHED = [
  { name: 'workflow-execute', stock: true },
  { name: 'index', stock: true },
  { name: 'stack-scheduler', stock: false },
  { name: 'scheduler-registry', stock: false },
  { name: 'workflow-scheduler', stock: false },
];
const DIST = 'dist/execution-engine';

const { encodeDelta, applyDelta, insertedBytes } = await import(join(ROOT, 'typescript/src/install/delta.ts'));

const args = process.argv.slice(2);
let check = false;
let keep = false;
let review;
const tags = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--check') check = true;
  else if (a === '--keep') keep = true;
  else if (a === '--review') review = resolve(args[++i] ?? '');
  else if (a === '-h' || a === '--help') {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 44).join('\n') + '\n');
    process.exit(0);
  } else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else tags.push(a);
}
if (tags.length === 0) usage('name at least one n8n tag, e.g. n8n@2.41.6');

function usage(message) {
  process.stderr.write(`[build-seams] error: ${message}\n`);
  process.exit(2);
}

class Fatal extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
/** Throws, so the scratch directory is removed and `.n8n` checked on the way out. */
function die(message, code = 1) {
  throw new Fatal(message, code);
}
const log = (message) => process.stdout.write(`[build-seams] ${message}\n`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...a) => execFileSync('git', ['-C', N8N_DIR, ...a], { maxBuffer: 1 << 28 });
const gitStatus = () => git('status', '--porcelain=v1', '--untracked-files=all').toString();

const statusBefore = gitStatus();
const headBefore = git('rev-parse', 'HEAD').toString().trim();
const scratch = mkdtempSync('/private/tmp/n8n-libpetri-seams-');
log(`scratch ${scratch}`);

try {
  const groups = new Map();
  const typescripts = new Map();
  for (const tag of tags) {
    const result = buildTag(tag);
    const group = groups.get(result.coreVersion);
    if (group === undefined) {
      groups.set(result.coreVersion, { ...result, n8n: [tag.replace(/^n8n@/, '')] });
      continue;
    }
    for (const f of TOUCHED) {
      if (!result.patched[f.name].js.equals(group.patched[f.name].js) || !result.patched[f.name].map.equals(group.patched[f.name].map)) {
        die(`${tag} pins n8n-core ${result.coreVersion} like ${group.n8n.join(', ')}, but its patched ${f.name}.js differs`);
      }
    }
    group.n8n.push(tag.replace(/^n8n@/, ''));
  }

  let differences = 0;
  for (const [version, group] of groups) differences += emit(version, group);
  if (check && differences > 0) die(`${differences} committed seam file(s) differ from a fresh build`);
  log(check ? 'check: committed seams reproduce byte for byte' : 'done');

  function buildTag(tag) {
    const work = join(scratch, tag.replace(/[^A-Za-z0-9.@-]/g, '_'));
    mkdirSync(work, { recursive: true });
    const corePkg = JSON.parse(git('show', `${tag}:packages/core/package.json`).toString());
    const coreVersion = corePkg.version;
    const rootPkg = JSON.parse(git('show', `${tag}:package.json`).toString());
    const tsVersion = rootPkg.devDependencies?.typescript;
    if (!/^\d+\.\d+\.\d+$/.test(tsVersion ?? '')) die(`${tag}: root package.json names no exact typescript version (${tsVersion})`);
    const n8nVersion = tag.replace(/^n8n@/, '');
    const pinned = execFileSync('npm', ['view', `n8n@${n8nVersion}`, 'dependencies.n8n-core']).toString().trim();
    if (pinned !== coreVersion) die(`${tag}: the tag's packages/core is ${coreVersion}, but n8n@${n8nVersion} on npm depends on n8n-core ${pinned}`);
    log(`${tag}: n8n-core ${coreVersion} (npm n8n@${n8nVersion} pins the same), typescript ${tsVersion}`);

    // 1. The published tarball, checked against the registry's integrity.
    const npmDir = join(work, 'npm');
    mkdirSync(npmDir);
    const integrity = execFileSync('npm', ['view', `n8n-core@${coreVersion}`, 'dist.integrity'], { cwd: npmDir }).toString().trim();
    const tgzName = execFileSync('npm', ['pack', `n8n-core@${coreVersion}`, '--silent'], { cwd: npmDir }).toString().trim().split('\n').pop();
    const tgz = readFileSync(join(npmDir, tgzName));
    const got = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    if (got !== integrity) die(`n8n-core@${coreVersion} tarball integrity ${got} != registry ${integrity}`);
    execFileSync('tar', ['-xzf', tgzName], { cwd: npmDir });
    const published = (rel) => readFileSync(join(npmDir, 'package', rel));

    // 2. Sources and tsconfig chain at the tag.
    const src = join(work, 'src');
    mkdirSync(src);
    const archive = git('archive', '--format=tar', tag, ENGINE_SRC, 'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json', 'packages/@n8n/typescript-config');
    execFileSync('tar', ['-x', '-C', src], { input: archive });
    mkdirSync(join(src, 'packages/core/node_modules/@n8n'), { recursive: true });
    symlinkSync(join(src, 'packages/@n8n/typescript-config'), join(src, 'packages/core/node_modules/@n8n/typescript-config'));

    const ts = typescriptAt(tsVersion);
    const parsed = ts.getParsedCommandLineOfConfigFile(join(src, 'packages/core/tsconfig.build.json'), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => die(`tsconfig: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`),
    });
    // What a single-file emit uses. Program-level options (rootDir, outDir, composite,
    // incremental, paths, types, lib) do not change one file's output and would only make
    // transpileModule complain; the package has no "type": "module", so tsc's NodeNext emits CJS.
    const options = { ...parsed.options, module: ts.ModuleKind.CommonJS };
    for (const k of ['moduleResolution', 'rootDir', 'outDir', 'composite', 'incremental', 'tsBuildInfoFile', 'declaration', 'declarationMap', 'paths', 'baseUrl', 'types', 'lib', 'configFilePath']) delete options[k];
    const transpile = (name) => {
      const file = join(src, ENGINE_SRC, `${name}.ts`);
      const out = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: options, fileName: `${name}.ts`, reportDiagnostics: true });
      if (out.diagnostics?.length) die(`${tag} ${name}.ts: ${out.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`);
      // tsc-alias: `@/x` is `packages/core/src/x`, written relative to the emitting file's directory.
      const js = out.outputText.replace(/require\("@\/([^"]+)"\)/g, (_, p) => {
        let r = relative('execution-engine', p);
        if (!r.startsWith('.')) r = `./${r}`;
        return `require("${r}")`;
      });
      const m = JSON.parse(out.sourceMapText);
      const map = JSON.stringify({ version: m.version, file: `${name}.js`, sourceRoot: '', sources: [`../../src/execution-engine/${name}.ts`], names: m.names, mappings: m.mappings });
      return { js: Buffer.from(js), map: Buffer.from(map) };
    };

    // 3. The gate.
    const stock = {};
    for (const f of TOUCHED.filter((t) => t.stock)) {
      const js = published(`${DIST}/${f.name}.js`);
      const ours = transpile(f.name).js;
      if (!ours.equals(js)) die(`${tag}: the unpatched transpile of ${f.name}.ts does not reproduce n8n-core@${coreVersion}'s ${f.name}.js (${sha256(ours)} != ${sha256(js)}); not generating`);
      stock[f.name] = { js, map: published(`${DIST}/${f.name}.js.map`) };
    }
    for (const f of TOUCHED.filter((t) => !t.stock)) {
      if (existsSync(join(npmDir, 'package', DIST, `${f.name}.js`))) die(`n8n-core@${coreVersion} already ships ${f.name}.js`);
    }
    log(`${tag}: gate passed, the unpatched transpile reproduces ${TOUCHED.filter((t) => t.stock).map((t) => `${t.name}.js`).join(' and ')}`);

    // 4. Apply 0001/0002 and transpile.
    for (const p of SOURCE_PATCHES) {
      // Outside any repository `git apply` is a plain, fuzz-free patch; GIT_DIR must not leak in.
      const { GIT_DIR: _gd, GIT_WORK_TREE: _gw, GIT_INDEX_FILE: _gi, ...env } = process.env;
      execFileSync('git', ['apply', '--whitespace=nowarn', join(PATCH_DIR, p)], { cwd: src, env });
    }
    const patched = {};
    for (const f of TOUCHED) patched[f.name] = transpile(f.name);
    return { tag, coreVersion, integrity, tgzName, tsVersion, stock, patched };
  }

  function emit(version, group) {
    const outDir = join(SEAMS_DIR, version);
    const files = new Map();
    const manifestFiles = [];
    const maps = [];
    const insertedByFile = {};
    let inserted = 0;
    for (const f of TOUCHED) {
      const target = group.patched[f.name].js;
      // A stock file is its own source; a created file copies from the stock file that leaves least to insert.
      const candidates = f.stock ? [f.name] : TOUCHED.filter((t) => t.stock).map((t) => t.name);
      let best;
      for (const from of candidates) {
        const delta = encodeDelta(group.stock[from].js, target);
        if (!applyDelta(group.stock[from].js, delta).equals(target)) die(`delta round trip failed for ${f.name}.js from ${from}.js`);
        const n = insertedBytes(delta);
        if (best === undefined || n < best.n) best = { from, delta, n };
      }
      const deltaName = `${f.name}.js.delta.json`;
      const deltaText = `${JSON.stringify({ ops: best.delta.ops })}\n`;
      files.set(deltaName, Buffer.from(deltaText));
      insertedByFile[`${f.name}.js`] = best.n;
      inserted += best.n;
      manifestFiles.push({
        path: `${DIST}/${f.name}.js`,
        before: f.stock ? sha256(group.stock[f.name].js) : null,
        after: sha256(target),
        delta: deltaName,
        deltaSha256: sha256(Buffer.from(deltaText)),
        deltaSource: `${DIST}/${best.from}.js`,
        deltaSourceSha256: sha256(group.stock[best.from].js),
      });
      const mapName = `${f.name}.js.map`;
      files.set(mapName, group.patched[f.name].map);
      maps.push({
        path: `${DIST}/${mapName}`,
        before: f.stock ? sha256(group.stock[f.name].map) : null,
        after: sha256(group.patched[f.name].map),
        file: mapName,
      });
      if (review) {
        mkdirSync(join(review, version), { recursive: true });
        const a = join(review, version, `${f.name}.stock.js`);
        const b = join(review, version, `${f.name}.patched.js`);
        writeFileSync(a, f.stock ? group.stock[f.name].js : '');
        writeFileSync(b, target);
        let diff = '';
        try {
          execFileSync('diff', ['-u', a, b]);
        } catch (e) {
          diff = e.stdout?.toString() ?? '';
        }
        writeFileSync(join(review, version, `${f.name}.js.diff`), diff);
      }
    }

    const existingPath = join(outDir, 'manifest.json');
    const existing = existsSync(existingPath) ? JSON.parse(readFileSync(existingPath, 'utf8')) : undefined;
    const sameAfter = existing !== undefined
      && JSON.stringify(existing.files?.map((f) => [f.path, f.after])) === JSON.stringify(manifestFiles.map((f) => [f.path, f.after]))
      && JSON.stringify(existing.maps?.files?.map((m) => [m.path, m.after])) === JSON.stringify(maps.map((m) => [m.path, m.after]));
    const manifest = {
      schema: 1,
      package: 'n8n-core',
      version,
      n8n: group.n8n,
      tarball: { name: group.tgzName, integrity: group.integrity },
      sourcePatches: Object.fromEntries(SOURCE_PATCHES.map((p) => [p, sha256(readFileSync(join(PATCH_DIR, p)))])),
      toolchain: {
        generator: 'scripts/release/build-seams.mjs',
        typescript: group.tsVersion,
        method: 'transpileModule per file, module CommonJS, compiler options parsed from packages/core/tsconfig.build.json, @/ rewritten relative as tsc-alias does',
        gate: 'the unpatched transpile of every stock touched file equals the published JS byte for byte',
      },
      files: manifestFiles,
      // Installed only where the target already ships maps (the stock workflow-execute.js.map exists).
      maps: { ifPresent: `${DIST}/workflow-execute.js.map`, files: maps },
      inserted: { bytes: inserted, byFile: insertedByFile },
      neutrality: sameAfter ? (existing.neutrality ?? null) : null,
    };
    files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

    let differences = 0;
    if (check) {
      const committed = existsSync(outDir) ? readdirSync(outDir).sort() : [];
      const fresh = [...files.keys()].sort();
      if (JSON.stringify(committed) !== JSON.stringify(fresh)) {
        log(`${version}: file set differs: committed [${committed.join(', ')}], fresh [${fresh.join(', ')}]`);
        differences++;
      }
      for (const [name, bytes] of files) {
        const p = join(outDir, name);
        if (!existsSync(p) || !readFileSync(p).equals(bytes)) {
          log(`${version}: ${name} differs`);
          differences++;
        }
      }
    } else {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      for (const [name, bytes] of files) writeFileSync(join(outDir, name), bytes);
      log(`${version}: wrote ${files.size} files for n8n ${group.n8n.join(', ')}; ${inserted} inserted bytes (${Object.entries(insertedByFile).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    }
    return differences;
  }

  function typescriptAt(version) {
    if (typescripts.has(version)) return typescripts.get(version);
    const dir = join(scratch, `typescript-${version}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', `typescript@${version}`], { cwd: dir });
    const ts = createRequire(join(dir, 'package.json'))('typescript');
    if (ts.version !== version) die(`installed typescript ${ts.version}, wanted ${version}`);
    typescripts.set(version, ts);
    return ts;
  }
} catch (e) {
  if (!(e instanceof Fatal)) throw e;
  process.stderr.write(`[build-seams] error: ${e.message}\n`);
  process.exitCode = e.code;
} finally {
  if (keep) log(`kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
  const statusAfter = gitStatus();
  const headAfter = git('rev-parse', 'HEAD').toString().trim();
  if (statusAfter !== statusBefore || headAfter !== headBefore) {
    process.stderr.write(`[build-seams] error: ${N8N_DIR} changed while generating (HEAD ${headBefore} -> ${headAfter})\n`);
    process.exitCode = 1;
  }
}
