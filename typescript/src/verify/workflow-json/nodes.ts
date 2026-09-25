/** A workflow export's `nodes` array → the compiler's {@link NodeDescription}s. */
import type { NodeDescription, OnError } from '../../compiler/index.js';
import { NON_EXECUTABLE_TYPES } from '../../n8n/adapter/graph.js';
import { engineV2FieldsOf } from '../../n8n/adapter/engine-v2.js';
import { nodePrefixOf } from '../../n8n/adapter/node.js';
import { fieldOf } from '../../n8n/adapter/readers.js';
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

/**
 * `raw`, the export's `nodes[index]`, as the compiler sees it; `used` holds the prefixes taken so
 * far, and `connections` is the export's connections-by-source map, read for the engine v2 fields.
 * `as` names a node the export leaves nameless (see {@link nodesOf}).
 */
export function nodeDescriptionOf(
  raw: RawNode, index: number, used: Set<string>, connections?: unknown, as?: string,
): NodeDescription {
  const name = as ?? raw.name;
  if (typeof name !== 'string' || name === '') throw new Error(`nodes[${index}] has no name`);
  const type = typeof raw.type === 'string' ? raw.type : 'unknown';
  return {
    // MOD-010 reserves `/` in a prefix, and the prefix must be unique: the adapter's rule.
    id: nodePrefixOf(raw.id, index, used),
    name,
    type,
    typeVersion: typeof raw.typeVersion === 'number' ? raw.typeVersion : 1,
    position: positionOf(raw, index),
    ...optionalFieldsOf(raw),
    ...engineV2FieldsOf(type, raw.typeVersion, raw.parameters, fieldOf(connections, name)),
  };
}

/** The export's nodes, as descriptions and as the checked records they came from, index-aligned. */
export interface JsonNodes {
  readonly nodes: NodeDescription[];
  readonly records: Record<string, unknown>[];
  readonly names: ReadonlySet<string>;
  /** The names given to nameless annotations under `engineV2`, in export order (see {@link nodesOf}). */
  readonly nameless: readonly string[];
}

/**
 * The name a nameless annotation at `nodes[index]` is described under: one no node of the export
 * has, since a description is keyed by name.
 */
function namelessNameOf(index: number, taken: ReadonlySet<string>): string {
  let name = `(nameless nodes[${index}])`;
  while (taken.has(name)) name = `${name}'`;
  return name;
}

/**
 * `root.nodes`, every entry an object with a name no other entry has — annotations dropped,
 * unless `keepAnnotations`.
 *
 * The drop is {@link NON_EXECUTABLE_TYPES}, the live adapter's own set, because one net serves
 * execution and verification: a workflow the scheduler runs must not be one the CLI refuses.
 * It has to happen *before* the name check, since an export may omit `name` on exactly these
 * nodes — measured on the template corpus, `5385.json` carries four nameless sticky notes among
 * nineteen nodes, and requiring a name first rejected all nineteen. They are unwired by
 * construction (`connections` is keyed by name), so dropping them changes no edge.
 *
 * Under `engineV2` (`keepAnnotations`) every annotation is kept: n8n's converter has no notion
 * of one, roots through it when it is wired on the main path and checks it like any other node,
 * so the port must see it. That includes a note with no `name` field, which n8n can reach too: a
 * `main` target with no `node` field puts `undefined` in `rootAt`'s reachable set, which then
 * keeps *every* nameless node, and `toEdges` turns the target into an edge to the last of them
 * (`idsByName.get(undefined)`), which `toGraphNode` checks like any other. So a nameless note is
 * described under a name of its own ({@link namelessNameOf}, listed in `nameless`), which the
 * connection readers give such a target (`connectionsOf`, `strayConnectionsIn`). A note whose
 * `name` is present but not a non-empty string is still dropped (`docs/divergences.md` row 34).
 *
 * Kept nodes keep their **original** index, so an id prefix and a fallback position do not move
 * when an annotation is removed from in front of them.
 */
export function nodesOf(root: Record<string, unknown>, keepAnnotations = false): JsonNodes {
  const rawNodes = root['nodes'];
  if (!Array.isArray(rawNodes)) throw new Error('workflow has no `nodes` array');
  const kept: { raw: Record<string, unknown>; index: number; nameless: boolean }[] = [];
  rawNodes.forEach((n, i) => {
    const raw = asRecord(n, `nodes[${i}]`);
    const type = raw['type'];
    const named = typeof raw['name'] === 'string' && raw['name'] !== '';
    const annotation = typeof type === 'string' && NON_EXECUTABLE_TYPES.has(type);
    const nameless = annotation && keepAnnotations && raw['name'] === undefined;
    if (annotation && !(keepAnnotations && named) && !nameless) return;
    kept.push({ raw, index: i, nameless });
  });
  const taken = new Set(kept.flatMap(({ raw }) => (typeof raw['name'] === 'string' ? [raw['name']] : [])));
  const nameless: string[] = [];
  for (const k of kept) {
    if (!k.nameless) continue;
    const name = namelessNameOf(k.index, taken);
    taken.add(name);
    nameless.push(name);
  }
  const used = new Set<string>();
  let next = 0;
  const nodes = kept.map(({ raw, index, nameless: unnamed }) =>
    nodeDescriptionOf(raw as RawNode, index, used, root['connections'], unnamed ? nameless[next++] : undefined));
  const names = new Set(nodes.map((n) => n.name));
  if (names.size !== nodes.length) throw new Error('workflow has two nodes of the same name');
  return { nodes, records: kept.map((k) => k.raw), names, nameless };
}
