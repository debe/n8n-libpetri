/** A workflow export's `nodes` array → the compiler's {@link NodeDescription}s. */
import type { NodeDescription, OnError } from '../../compiler/index.js';
import { nodePrefixOf } from '../../n8n/adapter/node.js';
import { asRecord } from './checked.js';

/** A node as the export holds it: every field unchecked until read. */
export interface RawNode {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly typeVersion?: unknown;
  readonly position?: unknown;
  readonly disabled?: unknown;
  readonly onError?: unknown;
  readonly retryOnFail?: unknown;
  readonly maxTries?: unknown;
  readonly waitBetweenTries?: unknown;
  readonly parameters?: unknown;
  /** The layer-1 policy carrier (ADR 0009). Top-level on the node, never inside `parameters`. */
  readonly executionPolicy?: unknown;
}

const ON_ERROR: ReadonlySet<string> = new Set(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']);

/** The canvas position; a node without a usable one is stacked down the canvas by its index. */
function positionOf(raw: RawNode, index: number): [number, number] {
  return Array.isArray(raw.position) && raw.position.length >= 2
    ? [Number(raw.position[0]) || 0, Number(raw.position[1]) || 0]
    : [0, index * 100];
}

/** The disabled flag and the error and retry settings, each only when the export sets it to a value of its type. */
function optionalFieldsOf(
  raw: RawNode,
): Pick<NodeDescription, 'disabled' | 'onError' | 'retryOnFail' | 'maxTries' | 'waitBetweenTries'> {
  const onError = typeof raw.onError === 'string' && ON_ERROR.has(raw.onError) ? raw.onError as OnError : undefined;
  return {
    ...(raw.disabled === true ? { disabled: true } : {}),
    ...(onError === undefined ? {} : { onError }),
    ...(raw.retryOnFail === true ? { retryOnFail: true } : {}),
    ...(typeof raw.maxTries === 'number' ? { maxTries: raw.maxTries } : {}),
    ...(typeof raw.waitBetweenTries === 'number' ? { waitBetweenTries: raw.waitBetweenTries } : {}),
  };
}

/** `raw`, the export's `nodes[index]`, as the compiler sees it; `used` holds the prefixes taken so far. */
export function nodeDescriptionOf(raw: RawNode, index: number, used: Set<string>): NodeDescription {
  const name = raw.name;
  if (typeof name !== 'string' || name === '') throw new Error(`nodes[${index}] has no name`);
  return {
    // MOD-010 reserves `/` in a prefix, and the prefix must be unique: the adapter's rule.
    id: nodePrefixOf(raw.id, index, used),
    name,
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    typeVersion: typeof raw.typeVersion === 'number' ? raw.typeVersion : 1,
    position: positionOf(raw, index),
    ...optionalFieldsOf(raw),
  };
}

/** The export's nodes, as descriptions and as the checked records they came from, index-aligned. */
export interface JsonNodes {
  readonly nodes: NodeDescription[];
  readonly records: Record<string, unknown>[];
  readonly names: ReadonlySet<string>;
}

/** `root.nodes`, every entry an object with a name no other entry has. */
export function nodesOf(root: Record<string, unknown>): JsonNodes {
  const rawNodes = root['nodes'];
  if (!Array.isArray(rawNodes)) throw new Error('workflow has no `nodes` array');
  const used = new Set<string>();
  const nodes = rawNodes.map((n, i) => nodeDescriptionOf(asRecord(n, `nodes[${i}]`) as RawNode, i, used));
  const names = new Set(nodes.map((n) => n.name));
  if (names.size !== nodes.length) throw new Error('workflow has two nodes of the same name');
  return { nodes, records: rawNodes.map((n, i) => asRecord(n, `nodes[${i}]`)), names };
}
