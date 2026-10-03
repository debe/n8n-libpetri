/**
 * A byte-level copy/insert delta: how the installer ships a patched n8n-core file without
 * shipping n8n-core's compiled code (ADR 0015, `tasks/inject-plan.md` decision 5).
 *
 * A delta rebuilds a target file from one **source** file the user already has — the stock
 * file it replaces, or, for a file the patches create, the stock file its code was moved out
 * of — plus the few bytes the patches add. The installer checks the source's sha256 before it
 * decodes and the result's sha256 before it writes, so a delta is exactly as safe as a
 * zero-fuzz diff, and it carries ~1.5 KB of inserted text instead of ~92 KB of compiled code.
 *
 * The encoder is greedy: at each target position it looks up the next {@link SEED} bytes in
 * an index of the source, extends every candidate forward (and backward into the pending
 * insert), and takes the longest. Deterministic for a given pair of inputs, so the generator
 * reproduces the committed deltas byte for byte.
 */

/** Minimum match length. Shorter common runs are cheaper as inserts than as copy ops. */
export const SEED = 12;
/** Candidates kept per seed. Whitespace runs repeat thousands of times in compiled JS. */
const MAX_CANDIDATES = 256;

/** One operation: copy `[offset, length]` bytes of the source, or insert literal bytes. */
export type DeltaOp =
  | { readonly copy: readonly [offset: number, length: number] }
  | { readonly insert: string }
  | { readonly insertBase64: string };

export interface Delta {
  readonly ops: readonly DeltaOp[];
}

export class DeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeltaError';
  }
}

/** Encodes `target` as copies out of `source` plus inserts. */
export function encodeDelta(source: Uint8Array, target: Uint8Array): Delta {
  const src = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const tgt = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
  const index = new Map<string, number[]>();
  for (let p = 0; p + SEED <= src.length; p++) {
    const key = src.toString('latin1', p, p + SEED);
    const list = index.get(key);
    if (list === undefined) index.set(key, [p]);
    else if (list.length < MAX_CANDIDATES) list.push(p);
  }

  const ops: DeltaOp[] = [];
  let pending: number[] = [];
  const flushInsert = (): void => {
    if (pending.length === 0) return;
    ops.push(insertOp(Buffer.from(pending)));
    pending = [];
  };
  const pushCopy = (offset: number, length: number): void => {
    const last = ops[ops.length - 1];
    if (last !== undefined && 'copy' in last && last.copy[0] + last.copy[1] === offset) {
      ops[ops.length - 1] = { copy: [last.copy[0], last.copy[1] + length] };
    } else {
      ops.push({ copy: [offset, length] });
    }
  };

  let i = 0;
  while (i < tgt.length) {
    let bestOffset = -1;
    let bestLength = 0;
    let bestBack = 0;
    if (i + SEED <= tgt.length) {
      const candidates = index.get(tgt.toString('latin1', i, i + SEED));
      if (candidates !== undefined) {
        for (const p of candidates) {
          let n = SEED;
          while (i + n < tgt.length && p + n < src.length && tgt[i + n] === src[p + n]) n++;
          let back = 0;
          while (back < pending.length && p - back - 1 >= 0 && pending[pending.length - back - 1] === src[p - back - 1]) back++;
          if (n + back > bestLength + bestBack) {
            bestOffset = p;
            bestLength = n;
            bestBack = back;
          }
        }
      }
    }
    if (bestOffset < 0) {
      pending.push(tgt[i]!);
      i++;
      continue;
    }
    if (bestBack > 0) pending.length -= bestBack;
    flushInsert();
    pushCopy(bestOffset - bestBack, bestLength + bestBack);
    i += bestLength;
  }
  flushInsert();
  return { ops };
}

/** Rebuilds the target. Throws {@link DeltaError} on a copy outside the source. */
export function applyDelta(source: Uint8Array, delta: Delta): Buffer {
  const src = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const parts: Buffer[] = [];
  for (const op of delta.ops) {
    if ('copy' in op) {
      const [offset, length] = op.copy;
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > src.length) {
        throw new DeltaError(`copy [${offset}, ${length}] is outside the ${src.length}-byte source`);
      }
      parts.push(src.subarray(offset, offset + length));
    } else if ('insert' in op) {
      if (typeof op.insert !== 'string') throw new DeltaError('insert is not a string');
      parts.push(Buffer.from(op.insert, 'utf8'));
    } else if ('insertBase64' in op) {
      if (typeof op.insertBase64 !== 'string') throw new DeltaError('insertBase64 is not a string');
      parts.push(Buffer.from(op.insertBase64, 'base64'));
    } else {
      throw new DeltaError(`unknown delta op ${JSON.stringify(op)}`);
    }
  }
  return Buffer.concat(parts);
}

/** Bytes the delta carries itself: what the package ships of the patched file. */
export function insertedBytes(delta: Delta): number {
  let n = 0;
  for (const op of delta.ops) {
    if ('insert' in op) n += Buffer.byteLength(op.insert, 'utf8');
    else if ('insertBase64' in op) n += Buffer.from(op.insertBase64, 'base64').length;
  }
  return n;
}

/** Text where the bytes are valid UTF-8 on their own, base64 where a run splits a character. */
function insertOp(bytes: Buffer): DeltaOp {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? { insert: text } : { insertBase64: bytes.toString('base64') };
}

/** Parses a delta file, checking only its shape; {@link applyDelta} checks the ranges. */
export function parseDelta(json: unknown): Delta {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as { ops?: unknown }).ops)) {
    throw new DeltaError('a delta is an object with an ops array');
  }
  return { ops: (json as { ops: DeltaOp[] }).ops };
}
