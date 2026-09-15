/**
 * Expression references: the nodes a node's parameters name. Kept when the name is a node of
 * the workflow; self references are classified by the compiler.
 */

/**
 * The reference patterns, applied to every string parameter value:
 * 1. `$('name')`, `$("name")`, `` $(`name`) `` — the modern node accessor;
 * 2. `$node["name"]`, `$node['name']` — the legacy accessor, bracket form;
 * 3. `$node.name` — the legacy accessor, dot form (identifier names only);
 * 4. `$items("name", …)`, `$items('name', …)` — the legacy items helper.
 */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  /\$\(\s*'([^']+)'\s*\)/g,
  /\$\(\s*"([^"]+)"\s*\)/g,
  /\$\(\s*`([^`]+)`\s*\)/g,
  /\$node\[\s*'([^']+)'\s*\]/g,
  /\$node\[\s*"([^"]+)"\s*\]/g,
  /\$node\.([A-Za-z_$][\w$]*)/g,
  /\$items\(\s*'([^']+)'/g,
  /\$items\(\s*"([^"]+)"/g,
];

/** Appends to `found` every node of `nodeNames` that `text` references and `found` lacks. */
function collectReferences(text: string, nodeNames: ReadonlySet<string>, found: string[]): void {
  for (const re of REFERENCE_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const name = m[1]!;
      if (nodeNames.has(name) && !found.includes(name)) found.push(name);
    }
  }
}

/** Node names referenced by the expressions in `parameters` (any nesting), in first-seen order. */
export function scanExpressionReferences(parameters: unknown, nodeNames: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      collectReferences(v, nodeNames, found);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x);
    } else if (typeof v === 'object' && v !== null) {
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(parameters);
  return found;
}
