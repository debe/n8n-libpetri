/**
 * `$('Y')` references classified by reachability avoiding the referencing node (README
 * "Expression references"): `read`, `seeded` or `unguarded`.
 */
import type { ResolvedReference } from '../types.js';
import { reachFrom } from './reachability.js';
import type { RawNode } from './validate.js';

/** Every node's classified references and the two node sets they imply. */
export interface ClassifiedReferences {
  /** Nodes referenced with a read arc (`read` or `seeded`). */
  readonly referenced: ReadonlySet<string>;
  /** Referenced nodes unreachable from every start node. */
  readonly seededSkipped: ReadonlySet<string>;
  readonly referencesOf: ReadonlyMap<string, readonly ResolvedReference[]>;
}

/** Classifies every node's references against reachability from the start nodes. */
export function classifyReferences(
  raws: readonly RawNode[],
  startNodes: readonly string[],
  succ: ReadonlyMap<string, readonly string[]>,
  reachable: ReadonlySet<string>,
  diagnostics: string[],
): ClassifiedReferences {
  // ---- references: classified by reachability avoiding the referencing node ----
  const referenced = new Set<string>();
  const seededSkipped = new Set<string>();
  const referencesOf = new Map<string, ResolvedReference[]>();
  for (const r of raws) {
    const x = r.node.name;
    const resolved: ResolvedReference[] = [];
    let avoiding: Set<string> | null = null;
    for (const y of r.rawReferences) {
      if (y === x) {
        diagnostics.push(`node '${x}' references itself; the expression fails inside the action as in n8n`);
        resolved.push({ node: y, kind: 'unguarded' });
        continue;
      }
      if (!reachable.has(y)) {
        diagnostics.push(
          `node '${x}' references '${y}', which is unreachable from the start node${startNodes.length > 1 ? 's' : ''}; ` +
          `'${y}/skipped' is seeded and the reference always fails`);
        resolved.push({ node: y, kind: 'seeded' });
        referenced.add(y);
        seededSkipped.add(y);
        continue;
      }
      avoiding ??= reachFrom(startNodes, succ, x);
      if (avoiding.has(y)) {
        resolved.push({ node: y, kind: 'read' });
        referenced.add(y);
      } else {
        diagnostics.push(
          `node '${x}' references '${y}', which is reachable only through '${x}'; ` +
          'no read arc, the expression fails inside the action as in n8n');
        resolved.push({ node: y, kind: 'unguarded' });
      }
    }
    referencesOf.set(x, resolved);
  }
  return { referenced, seededSkipped, referencesOf };
}
