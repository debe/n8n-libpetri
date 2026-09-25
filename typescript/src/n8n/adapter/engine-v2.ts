/**
 * The node fields only an `engineV2` compile reads (`tasks/v2-profile-plan.md` decision 11):
 * what n8n's `V1WorkflowConverter` (`@n8n/node-engine-compatibility`
 * `v1-workflow-converter.ts`) reads off a node's parameters and connections to refuse it. The
 * live adapter and the verify CLI's JSON reader both fill them through {@link engineV2FieldsOf},
 * so one net serves execution and verification here too.
 */
import type { BatchDescription, NodeDescription, StrayConnections } from '../../compiler/index.js';
import { DEFAULT_BATCH_SIZE, MERGE_TYPE, SPLIT_IN_BATCHES_TYPE } from '../../compiler/index.js';
import { fieldOf, recordOf } from './readers.js';

/**
 * `toBatchConfig`'s inputs: `options` written as an expression, `options.reset` set to anything
 * but `false`, and `batchSize ?? DEFAULT_BATCH_SIZE` — a number as written, `'expression'` for
 * any string (the converter refuses every string alike), `NaN` for any other value (it refuses
 * that as not a whole number).
 */
export function batchDescriptionOf(parameters: unknown): BatchDescription {
  const options = fieldOf(parameters, 'options');
  const reset = recordOf(options)?.['reset'];
  const size = fieldOf(parameters, 'batchSize') ?? DEFAULT_BATCH_SIZE;
  return {
    batchSize: typeof size === 'number' ? size : typeof size === 'string' ? 'expression' : Number.NaN,
    ...(typeof options === 'string' ? { optionsExpression: true } : {}),
    ...(reset !== undefined && reset !== false ? { reset: true } : {}),
  };
}

/**
 * The connection types other than `main` in a source's entry of n8n's connections-by-source
 * map, in the order the converter validates them: each type key, and within `main` each
 * connection's own `type` — every one `validateSupportedConnectionType` would refuse.
 */
export function aiOutputsOf(bySource: unknown): string[] {
  const out: string[] = [];
  const add = (type: string): void => { if (!out.includes(type)) out.push(type); };
  for (const [type, groups] of Object.entries(recordOf(bySource) ?? {})) {
    if (type !== 'main') {
      add(type);
      continue;
    }
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const c of group) {
        const t = fieldOf(c, 'type');
        if (t !== 'main') add(String(t));
      }
    }
  }
  return out;
}

/**
 * The engine v2 fields of a node of `type` and `typeVersion` (as written) with `parameters`,
 * whose entry in the connections-by-source map is `bySource`: `mergeMode` on every Merge (the
 * mode when it is a string, else `null`: the parameters were read), `mergeVersion` on a Merge
 * whose version is not a number, `batch` on every Split In Batches, `aiOutputs` when there is
 * one. A field that does not apply is left out.
 */
export function engineV2FieldsOf(
  type: string, typeVersion: unknown, parameters: unknown, bySource: unknown,
): Pick<NodeDescription, 'batch' | 'mergeMode' | 'mergeVersion' | 'aiOutputs'> {
  const mode = fieldOf(parameters, 'mode');
  const aiOutputs = aiOutputsOf(bySource);
  return {
    ...(type === MERGE_TYPE ? { mergeMode: typeof mode === 'string' ? mode : null } : {}),
    // `assertSupportedMergeMode` compares the version as written: `typeVersion >= 2` converts it.
    ...(type === MERGE_TYPE && typeof typeVersion !== 'number' ? { mergeVersion: Number(typeVersion) } : {}),
    ...(type === SPLIT_IN_BATCHES_TYPE ? { batch: batchDescriptionOf(parameters) } : {}),
    ...(aiOutputs.length === 0 ? {} : { aiOutputs }),
  };
}

/**
 * What a connections-by-source map in n8n's shape holds beyond the main connections between
 * nodes of `names` (`StrayConnections`): every `main` target that names no node, comes from a
 * key that names no node, or has a `type` other than `main` — the hops n8n's `rootAt` still walks
 * (`getChildNodes` follows every target under `main`, by name) — and each key that names no node
 * with its non-`main` connection types, which `toEdgesForSource` still checks. A target is read
 * as the main reader reads it: an object with a string `node`; a typeless one is `main` there.
 *
 * A target with no `node` field (any value but `null` whose `.node` is `undefined`) is walked as
 * n8n walks `undefined`: it reaches every node of
 * `nameless` (the nameless nodes, as the JSON reader names them: `rootAt` keeps each node whose
 * name, `undefined`, is in the set), and the walk goes on through the map's key `'undefined'`
 * (`connections[undefined]`) without reaching a node of that name. So such a target is a hop to
 * each of `nameless` and to each `main` target of the key `'undefined'`.
 */
export function strayConnectionsIn(
  bySource: Readonly<Record<string, unknown>>, names: ReadonlySet<string>, nameless: readonly string[] = [],
): StrayConnections {
  const main: { from: string; to: string }[] = [];
  const sources: { name: string; aiOutputs: string[] }[] = [];
  const throughUndefined: string[] = [];
  const groupsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  for (const group of groupsOf(fieldOf(bySource['undefined'], 'main'))) {
    for (const c of groupsOf(group)) {
      const to = fieldOf(c, 'node');
      if (typeof to === 'string') throughUndefined.push(to);
    }
  }
  for (const [from, byType] of Object.entries(bySource)) {
    if (!names.has(from)) {
      const aiOutputs = aiOutputsOf(byType);
      if (aiOutputs.length > 0) sources.push({ name: from, aiOutputs });
    }
    const groups = fieldOf(byType, 'main');
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const c of group) {
        const to = fieldOf(c, 'node');
        const type = fieldOf(c, 'type');
        if (to === undefined && c !== null && c !== undefined) {
          for (const n of [...nameless, ...throughUndefined]) main.push({ from, to: n });
          continue;
        }
        if (typeof to !== 'string') continue;
        if (names.has(from) && names.has(to) && (type === undefined || type === 'main')) continue;
        main.push({ from, to });
      }
    }
  }
  return { main, sources };
}
