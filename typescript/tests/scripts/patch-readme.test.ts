/**
 * `patches/n8n/README.md`'s recipe for writing all four patches again from a patched working tree
 * (review finding): the recipe staged whole files, and 0001 / 0002 share `workflow-execute.ts` and
 * `index.ts` as 0003 / 0004 share `execution/index.ts` and `index.ts`, so commit 1 took 0002's
 * registry lookup and the regenerated 0001 was no longer the pure loop extraction. The patches are
 * checked in, so the files each one touches are read from their `diff --git` headers, and the
 * recipe's commit blocks are checked against them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const patchDir = fileURLToPath(new URL('../../../patches/n8n/', import.meta.url));

/** The files each patch touches, in patch order. */
function patchFiles(): { readonly name: string; readonly files: ReadonlySet<string> }[] {
  return readdirSync(patchDir)
    .filter((f) => /^\d{4}-.*\.patch$/.test(f))
    .sort()
    .map((name) => {
      const text = readFileSync(resolve(patchDir, name), 'utf8');
      const files = new Set([...text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]!));
      return { name, files };
    });
}

interface CommitBlock {
  /** Every path the block stages. */
  readonly staged: ReadonlySet<string>;
  /** The paths it stages hunk by hunk (`git add -p`). */
  readonly partial: ReadonlySet<string>;
}

/** The prose and the commit blocks of the "write all of them again" recipe. */
function regenerateRecipe(readme: string): { readonly prose: string; readonly commits: CommitBlock[] } {
  const start = readme.indexOf('To write all of them again from a patched working tree');
  if (start < 0) throw new Error('the regenerate-all recipe is missing');
  const fence = readme.indexOf('```bash', start);
  const end = readme.indexOf('```', fence + 7);
  const prose = readme.slice(start, fence);
  // join continuation lines, drop comments
  const lines = readme.slice(fence + 7, end).replace(/\\\n\s*/g, ' ').split('\n').map((l) => l.replace(/\s+#.*$/, '').trim());
  const commits: CommitBlock[] = [];
  let staged = new Set<string>();
  let partial = new Set<string>();
  for (const line of lines) {
    const add = /^git add( -p)? (.+)$/.exec(line);
    if (add !== null) {
      for (const path of add[2]!.split(/\s+/)) {
        staged.add(path);
        if (add[1] !== undefined) partial.add(path);
      }
    } else if (line === 'git commit') {
      commits.push({ staged, partial });
      staged = new Set();
      partial = new Set();
    }
  }
  return { prose, commits };
}

describe('the patch README regenerate-all recipe', () => {
  const patches = patchFiles();
  const { prose, commits } = regenerateRecipe(readFileSync(resolve(patchDir, 'README.md'), 'utf8'));

  it('has one commit block per patch', () => {
    expect(patches.map((p) => p.name)).toEqual([
      '0001-extract-scheduler-loop.patch',
      '0002-scheduler-registry.patch',
      '0003-settlement-policy.patch',
      '0004-settlement-policy-registry.patch',
    ]);
    expect(commits).toHaveLength(patches.length);
  });

  it('stages exactly the files of each patch', () => {
    patches.forEach((p, i) => {
      expect([...commits[i]!.staged].sort(), p.name).toEqual([...p.files].sort());
    });
  });

  it('stages a file a later patch also touches hunk by hunk, and only such a file', () => {
    patches.forEach((p, i) => {
      const later = new Set(patches.slice(i + 1).flatMap((q) => [...q.files]));
      const shared = [...p.files].filter((f) => later.has(f)).sort();
      expect([...commits[i]!.partial].sort(), p.name).toEqual(shared);
    });
    // the shapes the finding named
    expect(commits[0]!.partial).toEqual(new Set([
      'packages/core/src/execution-engine/workflow-execute.ts',
      'packages/core/src/execution-engine/index.ts',
    ]));
    expect(commits[2]!.partial).toEqual(new Set([
      'packages/@n8n/engine/src/execution/index.ts',
      'packages/@n8n/engine/src/index.ts',
    ]));
  });

  it('names every shared file in the prose before the recipe', () => {
    const counts = new Map<string, number>();
    for (const p of patches) for (const f of p.files) counts.set(f, (counts.get(f) ?? 0) + 1);
    const shared = [...counts].filter(([, n]) => n > 1).map(([f]) => f);
    expect(shared).toHaveLength(4);
    for (const f of shared) expect(prose, f).toContain(`\`${f}\``);
  });
});
