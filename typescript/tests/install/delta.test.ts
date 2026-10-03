/**
 * The copy/insert delta codec (`src/install/delta.ts`): exact round trips, a decoder that
 * refuses to read outside its source, and inserts that stay text where the bytes allow.
 */
import { applyDelta, DeltaError, encodeDelta, insertedBytes, parseDelta, SEED } from '../../src/install/delta.js';

/** A small deterministic PRNG, so a failing case reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function mutate(source: Buffer, random: () => number): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  while (i < source.length) {
    const n = 1 + Math.floor(random() * 200);
    const r = random();
    if (r < 0.15) parts.push(Buffer.from(`/* inserted ${Math.floor(random() * 1e6)} ü */`));
    else if (r < 0.25) { i += n; continue; }
    else if (r < 0.3) parts.push(source.subarray(Math.floor(random() * source.length), Math.floor(random() * source.length)));
    parts.push(source.subarray(i, i + n));
    i += n;
  }
  return Buffer.concat(parts);
}

describe('delta codec', () => {
  it('round-trips random edits of a text exactly', () => {
    const random = rng(42);
    for (let round = 0; round < 60; round++) {
      const words = Array.from({ length: 400 }, () => ['const', 'x', '=', 'await', 'host.', 'run', '(', ')', ';\n', '    ', 'é', '漢'][Math.floor(random() * 12)]);
      const source = Buffer.from(words.join(' '));
      const target = mutate(source, random);
      const delta = encodeDelta(source, target);
      expect(applyDelta(source, delta).equals(target), `round ${round}`).toBe(true);
      // The delta survives JSON, which is how it ships.
      expect(applyDelta(source, parseDelta(JSON.parse(JSON.stringify(delta)))).equals(target)).toBe(true);
    }
  });

  it('round-trips arbitrary bytes, using base64 where a run is not valid UTF-8 on its own', () => {
    const random = rng(7);
    const source = Buffer.from(Array.from({ length: 3000 }, () => Math.floor(random() * 256)));
    const target = Buffer.concat([source.subarray(0, 1000), Buffer.from([0xff, 0xfe, 0xc3]), source.subarray(1500)]);
    const delta = encodeDelta(source, target);
    expect(applyDelta(source, delta).equals(target)).toBe(true);
    expect(delta.ops.some((op) => 'insertBase64' in op)).toBe(true);
  });

  it('encodes an unchanged file as one copy and a new file as one insert', () => {
    const source = Buffer.from('x'.repeat(10) + 'abcdefghijklmnopqrstuvwxyz'.repeat(4));
    expect(encodeDelta(source, source).ops).toEqual([{ copy: [0, source.length] }]);
    expect(encodeDelta(source, Buffer.from('short')).ops).toEqual([{ insert: 'short' }]);
    expect(encodeDelta(Buffer.alloc(0), Buffer.alloc(0)).ops).toEqual([]);
  });

  it('carries only what the target adds', () => {
    const source = Buffer.from('line one is long enough\nline two is long enough\nline three is long enough\n');
    const target = Buffer.from('line one is long enough\nNEW\nline two is long enough\nline three is long enough\n');
    const delta = encodeDelta(source, target);
    expect(insertedBytes(delta)).toBe(3); // "NEW"; the newline is copied with its neighbour
    expect(delta.ops.filter((op) => 'copy' in op).every((op) => 'copy' in op && op.copy[1] >= SEED)).toBe(true);
  });

  it('refuses a copy outside the source', () => {
    const source = Buffer.from('0123456789');
    expect(() => applyDelta(source, { ops: [{ copy: [5, 6] }] })).toThrow(DeltaError);
    expect(() => applyDelta(source, { ops: [{ copy: [-1, 2] }] })).toThrow(DeltaError);
    expect(() => applyDelta(source, { ops: [{ copy: [0, 0] }] })).toThrow(DeltaError);
    expect(() => applyDelta(source, { ops: [{ copy: [1.5, 2] }] })).toThrow(DeltaError);
    expect(() => applyDelta(source, { ops: [{ bogus: 1 } as never] })).toThrow(DeltaError);
    expect(() => parseDelta({ nope: [] })).toThrow(DeltaError);
  });
});
