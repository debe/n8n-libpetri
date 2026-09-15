/**
 * The `--node-types` file: node-type shapes keyed by node name or by type, supplied because a
 * workflow JSON export carries no node-type descriptions at all.
 */
import type { NodeTypeShape } from '../../compiler/index.js';
import { asRecord } from './checked.js';

/** The node-type shapes a `--node-types` file may carry. Both maps are optional. */
export interface NodeTypesFile {
  /** Keyed by `type@typeVersion` or bare `type`. */
  readonly types?: Readonly<Record<string, NodeTypeShape>>;
  /** Keyed by node name; wins over `types`. */
  readonly nodes?: Readonly<Record<string, NodeTypeShape>>;
}

const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** `root[key]` checked to be a map of shapes; `undefined` when the file leaves it out. */
function shapesIn(root: Record<string, unknown>, key: 'types' | 'nodes'): Readonly<Record<string, NodeTypeShape>> | undefined {
  const map = root[key];
  if (map === undefined) return undefined;
  const entries = asRecord(map, `node-types file: "${key}"`);
  for (const [name, shape] of Object.entries(entries)) {
    const s = asRecord(shape, `node-types file: "${key}"["${name}"]`);
    for (const count of ['inputCount', 'outputCount'] as const) {
      if (!isCount(s[count])) {
        throw new Error(`node-types file: "${key}"["${name}"].${count} must be a non-negative integer`);
      }
    }
  }
  return entries as Readonly<Record<string, NodeTypeShape>>;
}

/**
 * A `--node-types` file, checked rather than cast: an array, a scalar, or a map whose entries
 * are not shapes used to be accepted as `{}` — "no shapes" — and the run then guessed every
 * port count exactly as a run without the flag would, with nothing said.
 */
export function parseNodeTypesFile(raw: unknown): NodeTypesFile {
  const root = asRecord(raw, 'node-types file');
  const types = shapesIn(root, 'types');
  const nodes = shapesIn(root, 'nodes');
  return { ...(types === undefined ? {} : { types }), ...(nodes === undefined ? {} : { nodes }) };
}
