/**
 * One live node as the compiler sees it: its subnet prefix and its {@link NodeDescription}.
 */
import type { INode } from 'n8n-workflow';
import type { ExecutionPolicy, NodeDescription } from '../../compiler/index.js';
import { engineV2FieldsOf } from './engine-v2.js';
import { policyFieldsOf } from './policy.js';

/**
 * The subnet prefix of a node: its `id` (a UUID in n8n), unless it is missing, contains the
 * MOD-010 separator `/` or repeats an earlier node's — then `n<k>` for the first `k >= index`
 * (the node's position in `workflow.nodes`) no node already owns. The fallback is checked
 * against `used` like a real id, because a workflow may carry the literal id `n1` beside a
 * node with none: n8n runs that workflow, and `analyse()` refuses a duplicate prefix.
 */
export function nodePrefixOf(id: unknown, index: number, used: Set<string>): string {
  let prefix = typeof id === 'string' && id.length > 0 && !id.includes('/') && !used.has(id) ? id : undefined;
  for (let k = index; prefix === undefined; k++) if (!used.has(`n${k}`)) prefix = `n${k}`;
  used.add(prefix);
  return prefix;
}

/** The node fields n8n leaves out when unset, copied only when set. */
const OPTIONAL_NODE_FIELDS = ['disabled', 'onError', 'retryOnFail', 'maxTries', 'waitBetweenTries'] as const;

/** The `keys` of `source` whose value is not `undefined`, in `keys` order. */
function definedFieldsOf<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * `node` as the compiler sees it, under the subnet prefix `id` and its resolved `policy`;
 * `bySource` is its entry in `connectionsBySourceNode`, read for the engine v2 fields.
 */
export function liveNodeDescription(
  node: INode, id: string, policy: ExecutionPolicy | undefined, bySource?: unknown,
): NodeDescription {
  return {
    id,
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion,
    position: [node.position[0], node.position[1]],
    ...definedFieldsOf(node, OPTIONAL_NODE_FIELDS),
    ...policyFieldsOf(node.parameters, policy),
    ...engineV2FieldsOf(node.type, node.typeVersion, node.parameters, bySource),
  };
}
