/**
 * The acceptance leg of the engine v2 converter port (`tasks/v2-profile-plan.md` step 13): does
 * the `engineV2` compile of a workflow export build the graph n8n's own converter builds, and
 * refuse what n8n refuses?
 *
 * n8n's side is its compiled `V1WorkflowConverter.convert(workflow, fired)` followed by
 * `validateExecutableGraph`, from the pinned checkout's `dist`. Ours is the verify CLI's route:
 * `describeWorkflowJson(json, { profile: 'engineV2' })` (with the node-type catalogue when one
 * exists), then `analyse` / `compile` under `profile: 'engineV2'` with `trigger: fired`. The
 * corpus is the spike's: the 200 templates and the 11 testbed workflows, one entry per fireable
 * trigger (`isTriggerNodeType`) when n8n needs the name, else one entry with none.
 *
 * n8n is handed the export with the node ids a saved workflow has: a node with no id (or an empty
 * one) gets the id the JSON reader gives it (`nodePrefixOf`), since n8n gives such a node one
 * whenever a workflow is created or updated (`addNodeIds`, `cli/src/workflow-helpers.ts`, called
 * by `WorkflowCreationService` and `WorkflowService.update`), so its engine never converts a
 * node without. The verdict n8n gives the raw export is computed too, and where it differs it is
 * listed apart: a converter handed id-less nodes makes every node sharing the trigger's missing
 * id a trigger step.
 *
 * Per entry:
 *  (1) verdict: both accept, or both refuse;
 *  (2) on both-accept: the node set and the edge set are equal — every edge with its
 *      `outputIndex`, `inputIndex` and `isBackEdge` — by node name, and every node's id is n8n's
 *      (a node our reader renamed is listed, with the rename); the compiled net has a settlement
 *      gadget exactly for the nodes n8n's trigger reaches, and as many places, transitions,
 *      input arcs and output places as the net stage 1 compiles from n8n's own graph;
 *  (3) on both-refuse: the code is the one `V2_REFUSALS` maps n8n's throw to. A difference is a
 *      finding only when the workflow has one defect: the script repairs the defect n8n names and
 *      converts again, and when n8n's next refusal (or a later one) is ours, the workflow had
 *      several defects and the difference is reported apart, not as a failure;
 *  (4) drift guard: every `throw new X(` in the converter and validator sources is mapped in
 *      `V2_REFUSALS`, and every entry names one (`src/conformance/v2/drift.ts`); and
 *      `isV2TriggerType` answers as n8n's `isTriggerNodeType` on every node type of the corpus
 *      and the catalogue;
 *  (5) mutants: every entry n8n accepts is changed in one place at a time (`MUTATIONS`: a node
 *      the trigger reaches disabled, given `continueErrorOutput` or a non-`main` connection; a
 *      Merge's mode; a Split In Batches' version and parameters; the fired trigger misnamed), and
 *      each mutant goes through (1)–(3). The corpus alone reaches one disabled node and one
 *      misconfigured Split In Batches, too few to test the splice or `toBatchConfig`.
 *
 * Exit 1 on any finding of (1), (2), (4), a single-defect code difference in (3), or an error
 * that is not a `CompileError`, on the corpus or a mutant. Results are converter-level evidence,
 * not conformance numbers.
 *
 *   npx tsx tasks/v2-acceptance.mts [--limit N] [--no-catalogue] [--json out.json]
 *
 * Needs `.n8n/` at the pin, built with `scripts/bootstrap-n8n.sh --scope=cli`.
 */
import type { Transition } from 'libpetri';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, compile, CompileError, isV2TriggerType, V2_REFUSALS, V2_TRIGGER_NODE_TYPES, v2RefusalOf } from '../typescript/src/compiler/index.ts';
import type { CompileErrorCode, V2RefusalFile } from '../typescript/src/compiler/index.ts';
import { refusalDrift } from '../typescript/src/conformance/v2/drift.ts';
import { graphToDescription } from '../typescript/src/conformance/v2/graph.ts';
import type { V2Graph } from '../typescript/src/conformance/v2/graph.ts';
import { nodePrefixOf } from '../typescript/src/n8n/adapter/node.ts';
import { describeWorkflowJson, parseNodeTypesFile } from '../typescript/src/verify/workflow-json.ts';
import type { NodeTypesFile } from '../typescript/src/verify/workflow-json.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = resolve(root, '.n8n/packages/@n8n');
const need = `${pkg}/node-engine-compatibility/dist/v1-workflow-converter.js`;
if (!existsSync(need)) throw new Error(`${need} missing: run scripts/bootstrap-n8n.sh --scope=cli`);
const req = createRequire(`${pkg}/node-engine-compatibility/package.json`);
const { V1WorkflowConverter } = req(need);
const { validateExecutableGraph } = req(`${pkg}/engine/dist/graph/validate-executable-graph.js`);
const { getDescendantNodeIds } = req(`${pkg}/engine/dist/graph/workflow-graph-queries.js`);
const { isTriggerNodeType } = req('n8n-workflow');

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const LIMIT = Number(arg('limit', '100000'));
const JSON_OUT = arg('json', '');
const cataloguePath = resolve(root, '.node-types/catalogue.json');
const useCatalogue = !process.argv.includes('--no-catalogue') && existsSync(cataloguePath);
const nodeTypes: NodeTypesFile = useCatalogue ? parseNodeTypesFile(JSON.parse(readFileSync(cataloguePath, 'utf8'))) : {};

const n8nVersion = JSON.parse(readFileSync(resolve(root, '.n8n/packages/cli/package.json'), 'utf8')).version as string;
const libpetriVersion = JSON.parse(readFileSync(resolve(root, 'typescript/node_modules/libpetri/package.json'), 'utf8')).version as string;
const libpetriLinked = lstatSync(resolve(root, 'typescript/node_modules/libpetri')).isSymbolicLink();

// ---- (4) drift guard ---------------------------------------------------------------------------
const SOURCES: Record<V2RefusalFile, string> = {
  'v1-workflow-converter.ts': `${pkg}/node-engine-compatibility/src/v1-workflow-converter.ts`,
  'loops.ts': `${pkg}/engine/src/graph/loops.ts`,
  'validate-executable-graph.ts': `${pkg}/engine/src/graph/validate-executable-graph.ts`,
};
const drift = refusalDrift(Object.fromEntries(
  Object.entries(SOURCES).map(([f, p]) => [f, readFileSync(p, 'utf8')])) as Record<V2RefusalFile, string>);

// ---- corpus -------------------------------------------------------------------------------------
const files = [
  ...readdirSync(resolve(root, '.templates')).filter((f) => f.endsWith('.json')).map((f) => resolve(root, '.templates', f)),
  ...readdirSync(resolve(root, 'scripts/testbed/workflows')).map((f) => resolve(root, 'scripts/testbed/workflows', f)),
].slice(0, LIMIT);

interface RawWorkflow { nodes: RawNode[]; connections: Record<string, Record<string, unknown>>; [k: string]: unknown }
interface RawNode { id?: string; name: string; type: string; typeVersion?: number; disabled?: boolean; onError?: string; parameters?: Record<string, unknown> }
interface Graph { nodes: { id: string; name: string; type: string }[]; edges: { from: string; to: string; outputIndex: number; inputIndex: number; isBackEdge?: boolean }[] }

type Verdict = { kind: 'accept'; graph: Graph } | { kind: 'refuse'; error: string; message: string };

const converter = new V1WorkflowConverter();
function n8nVerdict(workflow: RawWorkflow, fired: string | undefined): Verdict {
  try {
    const graph = converter.convert(workflow, fired) as Graph;
    validateExecutableGraph(graph);
    return { kind: 'accept', graph };
  } catch (e) {
    return { kind: 'refuse', error: (e as Error).constructor.name, message: (e as Error).message };
  }
}

/** n8n's workflow object, as the differential builds it. */
const asWorkflow = (file: string, wf: Record<string, unknown>): RawWorkflow => ({
  id: basename(file, '.json'), name: wf['name'] ?? '', active: false, nodes: (wf['nodes'] ?? []) as RawNode[],
  connections: (wf['connections'] ?? {}) as RawWorkflow['connections'], settings: wf['settings'] ?? {},
  createdAt: new Date(), updatedAt: new Date(),
});

/**
 * `workflow` with every node id the JSON reader replaces replaced the same way (`nodePrefixOf`):
 * a missing or empty id, as `addNodeIds` replaces it, and also a repeated or `/`-containing one,
 * which no corpus workflow has. See the module doc.
 */
function withIds(workflow: RawWorkflow): RawWorkflow {
  const used = new Set<string>();
  const nodes = workflow.nodes.map((n, i) => ({ ...n, id: nodePrefixOf(n.id, i, used) }));
  return { ...workflow, nodes };
}

// ---- repairs, for (3): undo the one defect n8n named, so its next refusal shows ------------------
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** The node a refusal message names, by the converter's `Node "X"` form. */
const namedNode = (message: string): string | undefined => /Node "([^"]+)"/.exec(message)?.[1];
function repaired(workflow: RawWorkflow, site: string, message: string): RawWorkflow | null {
  const wf = clone(workflow);
  const name = namedNode(message);
  const node = wf.nodes.find((n) => n.name === name);
  switch (site) {
    case 'continueErrorOutput': if (!node) return null; delete node.onError; return wf;
    case 'mergeChooseBranch': case 'mergeExpressionMode':
      if (!node) return null; node.parameters = { ...node.parameters, mode: 'append' }; return wf;
    case 'batchVersion': case 'batchOptionsExpression': case 'batchReset': case 'batchSizeExpression': case 'batchSizeInvalid':
      if (!node) return null; node.typeVersion = 3; node.parameters = { ...node.parameters, options: {}, batchSize: 1 }; return wf;
    case 'connectionType': {
      if (!node) return null;
      const byType = wf.connections[node.name] ?? {};
      wf.connections[node.name] = Object.fromEntries(Object.entries(byType).filter(([t]) => t === 'main'));
      return wf;
    }
    default: return null;
  }
}

/** The codes n8n's successive refusals map to, repairing one defect at a time (at most 12). */
function refusalChain(workflow: RawWorkflow, fired: string | undefined): CompileErrorCode[][] {
  const chain: CompileErrorCode[][] = [];
  let wf: RawWorkflow | null = workflow;
  for (let i = 0; i < 12 && wf !== null; i++) {
    const v = n8nVerdict(wf, fired);
    if (v.kind === 'accept') break;
    const site = v2RefusalOf(v.error, v.message);
    if (site === undefined) break;
    chain.push([...V2_REFUSALS[site].codes]);
    wf = repaired(wf, site, v.message);
  }
  return chain;
}

// ---- ours ---------------------------------------------------------------------------------------
type Ours = { kind: 'accept'; nodes: Map<string, string>; edges: string[]; compiled: string[]; reached: string[]; size: string }
  | { kind: 'refuse'; code: CompileErrorCode; message: string }
  | { kind: 'error'; message: string };
function ourVerdict(json: unknown, fired: string | undefined): Ours {
  try {
    const { description } = describeWorkflowJson(json, { nodeTypes, profile: 'engineV2' });
    const options = { profile: 'engineV2' as const, ...(fired === undefined ? {} : { trigger: fired }) };
    const analysis = analyse(description, options);
    const compiled = compile(description, { ...options, analysis });
    const back = (id: number) => analysis.engineV2!.edgeClass.get(id) === 'back';
    return {
      kind: 'accept',
      nodes: new Map(analysis.nodes.map((n) => [n.node.name, n.node.id])),
      edges: analysis.edges.map((e) => edgeText(e.from, e.outputIndex, e.to, e.inputIndex, back(e.id))).sort(),
      compiled: compiled.netMap.settlements.map((g) => g.node).sort(),
      reached: [...analysis.reachable].sort(),
      size: netSize(compiled.net),
    };
  } catch (e) {
    if (e instanceof CompileError) return { kind: 'refuse', code: e.code, message: e.message };
    return { kind: 'error', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
/** A net's size: places, transitions, and each transition's input, read and output places, summed. */
function netSize(net: { places: ReadonlySet<unknown>; transitions: ReadonlySet<Transition> }): string {
  const ts = [...net.transitions];
  const sum = (f: (t: Transition) => ReadonlySet<unknown>): number => ts.reduce((n, t) => n + f(t).size, 0);
  return `${net.places.size} places, ${ts.length} transitions, ${sum((t) => t.inputPlaces())} inputs, ` +
    `${sum((t) => t.readPlaces())} reads, ${sum((t) => t.outputPlaces())} outputs`;
}
const edgeText = (from: string, out: number, to: string, into: number, back: boolean): string =>
  `${from}.${out} -> ${to}.${into}${back ? ' (back)' : ''}`;

// ---- comparison ---------------------------------------------------------------------------------
interface Finding { readonly leg: string; readonly entry: string; readonly detail: string }
const findings: Finding[] = [];
const multiDefect: { entry: string; n8n: string; ours: string; chain: string }[] = [];
const idArtifacts: { entry: string; raw: string; normalised: string }[] = [];
const verdictText = (v: Verdict): string => (v.kind === 'accept' ? 'accepts' : `refuses: ${v.error}: ${v.message}`);

/** The tallies of one leg: the corpus itself, or its mutants. */
const newStats = () => ({
  entries: 0, n8nAccepts: 0, oursAccepts: 0, bothAccept: 0, bothRefuse: 0,
  verdictDisagreements: 0, graphDisagreements: 0, renamedIds: 0, loopEntries: 0,
  codeEqual: 0, codeMultiDefect: 0, codeFindings: 0, ourErrors: 0, byCode: {} as Record<string, number>,
});
type Stats = ReturnType<typeof newStats>;

/**
 * Legs (1)–(3) on one entry: n8n handed `workflow` (ids assigned), ours handed `json`, both with
 * `fired`. `leg` prefixes the findings.
 */
function compareEntry(stats: Stats, leg: string, tag: string, workflow: RawWorkflow, json: unknown, fired: string | undefined): void {
  stats.entries++;
  const theirs = n8nVerdict(workflow, fired);
  const ours = ourVerdict(json, fired);
  if (theirs.kind === 'accept') stats.n8nAccepts++;
  if (ours.kind === 'accept') stats.oursAccepts++;
  if (ours.kind === 'error') {
    stats.ourErrors++;
    findings.push({ leg: `${leg} error`, entry: tag, detail: ours.message });
    return;
  }
  // (1)
  if (theirs.kind !== ours.kind) {
    stats.verdictDisagreements++;
    findings.push({
      leg: `${leg} (1) verdict`, entry: tag,
      detail: theirs.kind === 'accept' ? `n8n accepts, we refuse: ${(ours as { message: string }).message}`
        : `n8n refuses (${theirs.error}: ${theirs.message}), we accept`,
    });
    return;
  }
  if (theirs.kind === 'accept' && ours.kind === 'accept') {
    // (2)
    stats.bothAccept++;
    // A nameless node (`name` undefined in n8n's graph) goes by the name our reader gives the node
    // of the same id, so the two graphs compare by name.
    const ourNameById = new Map([...ours.nodes].map(([name, id]) => [id, name]));
    const g: Graph = { ...theirs.graph, nodes: theirs.graph.nodes.map((n) => ({ ...n, name: n.name ?? ourNameById.get(n.id) ?? String(n.name) })) };
    if (g.edges.some((e) => e.isBackEdge === true)) stats.loopEntries++;
    const nameOf = new Map(g.nodes.map((n) => [n.id, n.name]));
    const theirNodes = g.nodes.map((n) => n.name).sort();
    const ourNodes = [...ours.nodes.keys()].sort();
    const theirEdges = g.edges.map((e) => edgeText(nameOf.get(e.from)!, e.outputIndex, nameOf.get(e.to)!, e.inputIndex, e.isBackEdge === true)).sort();
    const problems: string[] = [];
    if (JSON.stringify(theirNodes) !== JSON.stringify(ourNodes)) {
      problems.push(`nodes: n8n only {${theirNodes.filter((n) => !ours.nodes.has(n)).join(', ')}}, ours only {${ourNodes.filter((n) => !theirNodes.includes(n)).join(', ')}}`);
    }
    if (JSON.stringify(theirEdges) !== JSON.stringify(ours.edges)) {
      problems.push(`edges: n8n only {${theirEdges.filter((e) => !ours.edges.includes(e)).join('; ')}}, ours only {${ours.edges.filter((e) => !theirEdges.includes(e)).join('; ')}}`);
    }
    const trigger = g.nodes.find((n) => n.type === 'trigger')!;
    const reached = [trigger.name, ...(getDescendantNodeIds(g, trigger.id) as string[]).map((id) => nameOf.get(id)!)].sort();
    if (JSON.stringify(reached) !== JSON.stringify(ours.reached) || JSON.stringify(reached) !== JSON.stringify(ours.compiled)) {
      problems.push(`compiled set: n8n reaches {${reached.join(', ')}}, analysis {${ours.reached.join(', ')}}, net {${ours.compiled.join(', ')}}`);
    }
    for (const n of g.nodes) {
      const id = ours.nodes.get(n.name);
      if (id !== undefined && id !== n.id) {
        stats.renamedIds++;
        problems.push(`id: '${n.name}' is ${String(n.id)} in n8n, ${id} ours`);
      }
    }
    // The same graph compiled from n8n's own converted graph (stage 1): the nets must be alike.
    const stage1 = netSize(compile(graphToDescription(g as V2Graph).description, { profile: 'engineV2' }).net);
    if (stage1 !== ours.size) problems.push(`net: stage 1 ${stage1}, stage 2 ${ours.size}`);
    if (problems.length > 0) {
      stats.graphDisagreements++;
      findings.push({ leg: `${leg} (2) graph`, entry: tag, detail: problems.join('\n      ') });
    }
    return;
  }
  if (theirs.kind === 'refuse' && ours.kind === 'refuse') {
    // (3)
    stats.bothRefuse++;
    stats.byCode[ours.code] = (stats.byCode[ours.code] ?? 0) + 1;
    const site = v2RefusalOf(theirs.error, theirs.message);
    if (site === undefined) {
      stats.codeFindings++;
      findings.push({ leg: `${leg} (3) code`, entry: tag, detail: `n8n threw ${theirs.error} (${theirs.message}), which V2_REFUSALS does not map` });
      return;
    }
    const expected = V2_REFUSALS[site].codes as readonly CompileErrorCode[];
    if (expected.includes(ours.code)) { stats.codeEqual++; return; }
    const chain = refusalChain(workflow, fired);
    const text = chain.map((c) => c.join('|') || 'internal').join(' -> ');
    if (chain.slice(1).some((codes) => codes.includes(ours.code))) {
      stats.codeMultiDefect++;
      multiDefect.push({ entry: tag, n8n: `${theirs.error} [${site}]: ${theirs.message}`, ours: `${ours.code}: ${ours.message}`, chain: text });
    } else {
      stats.codeFindings++;
      findings.push({ leg: `${leg} (3) code`, entry: tag, detail: `n8n ${theirs.error} [${site}] (${expected.join('|') || 'internal'}): ${theirs.message}\n      ours ${ours.code}: ${ours.message}\n      n8n's refusals, repairing one at a time: ${text}` });
    }
  }
}

// ---- mutants: one change to an entry n8n accepts --------------------------------------------------
/**
 * The single changes each accepted entry is mutated by, each at one node the trigger reaches
 * (every such node, for the cheap ones). Each mutant goes through legs (1)–(3) like an entry:
 * - `disable`: the node disabled — splicing, with its slot-0 rule and its orphans;
 * - `continueErrorOutput`: its `onError`;
 * - `aiConnection`: an empty `ai_tool` group on its connections;
 * - `chooseBranch` / `modeExpression` / `modeExpressionV1`: a Merge's mode;
 * - `sibVersion` / `sibOptions` / `sibReset` / `sibSizeExpression` / `sibSizeZero` / `sibSizeDefault`:
 *   a Split In Batches' version and parameters;
 * - `unknownTrigger` / `notATrigger`: the fired trigger named wrongly, once per entry;
 * - raw-JSON readings (review findings on step 13), where the scheduler's reading of an export is
 *   not the converter's: `ghostHop` (the node's first incoming main connection routed through a
 *   connections key that is no node), `indexMissing` / `indexString` (that connection's `index`
 *   deleted, or written `"0"`), `mergeVersionString` (a Merge's version written as a string, with an
 *   expression mode), `stickyOnPath` (a sticky note spliced into that connection),
 *   `triggerSubNode` (a sub-node whose type reads as a trigger, wired into the node over
 *   `ai_languageModel`); and once per entry `stickyTrigger` (a sticky note added and named as the
 *   fired trigger);
 * - the review's third round: `indexStringFirst` (the node's first incoming connection preceded by
 *   a copy whose `index` is written as a string: n8n's dedupe key prints both alike),
 *   `namelessNote` / `namelessNoteErrorOutput` (a sticky note with no `name` added, and a target
 *   with no `node` on the node's output 0: `rootAt` keeps every nameless node, `toEdges` gives the
 *   last an edge), `pipeIds` (ids holding `|`, arranged so that an added edge prints the dedupe
 *   key of the node's first incoming one and replaces it).
 */
type Mutation = (json: Record<string, unknown>, node: RawNode) => boolean;
type RawTarget = { node: string; type?: string; index?: unknown };
/** The first `main` target naming `name` in the connections map, with its source, output and group. */
function firstIncoming(json: Record<string, unknown>, name: string):
  { from: string; output: number; group: RawTarget[]; target: RawTarget } | null {
  for (const [from, byType] of Object.entries(json['connections'] as Record<string, Record<string, unknown>>)) {
    const groups = byType?.['main'];
    if (!Array.isArray(groups)) continue;
    for (const [output, group] of groups.entries()) {
      if (!Array.isArray(group)) continue;
      for (const target of group as RawTarget[]) if (target?.node === name) return { from, output, group: group as RawTarget[], target };
    }
  }
  return null;
}
/** Adds a nameless sticky note, and a target with no `node` field on the node's output 0. */
function namelessNote(json: Record<string, unknown>, n: RawNode, extra: Partial<RawNode>): boolean {
  (json['nodes'] as Partial<RawNode>[]).push({ id: `added-${++addedIds}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: {}, ...extra });
  const connections = json['connections'] as Record<string, Record<string, unknown>>;
  const byType = connections[n.name] ?? (connections[n.name] = {});
  const groups = (Array.isArray(byType['main']) ? byType['main'] : (byType['main'] = [])) as unknown[];
  if (!Array.isArray(groups[0])) groups[0] = [];
  (groups[0] as unknown[]).push({ type: 'main', index: 0 });
  return true;
}
/** Adds a node to the mutant's JSON, under a fresh id (a name may hold the MOD-010 separator). */
let addedIds = 0;
const addNode = (json: Record<string, unknown>, n: Omit<RawNode, 'id'>): void => {
  (json['nodes'] as RawNode[]).push({ ...n, id: `added-${++addedIds}` });
};
/** Routes the node's first incoming main connection through `via`, which then feeds the node. */
function routeThrough(json: Record<string, unknown>, n: RawNode, via: string): boolean {
  const incoming = firstIncoming(json, n.name);
  if (incoming === null) return false;
  const connections = json['connections'] as Record<string, Record<string, unknown>>;
  connections[via] = { main: [[{ node: n.name, type: 'main', index: incoming.target.index }]] };
  incoming.target.node = via;
  incoming.target.index = 0;
  return true;
}
const MUTATIONS: Record<string, Mutation> = {
  disable: (_, n) => { n.disabled = true; return true; },
  continueErrorOutput: (_, n) => { n.onError = 'continueErrorOutput'; return true; },
  aiConnection: (json, n) => {
    const connections = json['connections'] as Record<string, Record<string, unknown>>;
    connections[n.name] = { ...(connections[n.name] ?? {}), ai_tool: [[]] };
    return true;
  },
  chooseBranch: (_, n) => n.type === 'n8n-nodes-base.merge' && (n.parameters = { ...n.parameters, mode: 'chooseBranch' }, true),
  modeExpression: (_, n) => n.type === 'n8n-nodes-base.merge' && (n.typeVersion = 3, n.parameters = { ...n.parameters, mode: '={{ "append" }}' }, true),
  modeExpressionV1: (_, n) => n.type === 'n8n-nodes-base.merge' && (n.typeVersion = 1, n.parameters = { ...n.parameters, mode: '={{ "append" }}' }, true),
  sibVersion: (_, n) => n.type === 'n8n-nodes-base.splitInBatches' && (n.typeVersion = 2, true),
  sibOptions: (_, n) => n.type === 'n8n-nodes-base.splitInBatches' && (n.parameters = { ...n.parameters, options: '={{ {} }}' }, true),
  sibReset: (_, n) => n.type === 'n8n-nodes-base.splitInBatches' && (n.parameters = { ...n.parameters, options: { reset: true } }, true),
  sibSizeExpression: (_, n) => n.type === 'n8n-nodes-base.splitInBatches' && (n.parameters = { ...n.parameters, batchSize: '={{ 2 }}' }, true),
  sibSizeZero: (_, n) => n.type === 'n8n-nodes-base.splitInBatches' && (n.parameters = { ...n.parameters, batchSize: 0 }, true),
  sibSizeDefault: (_, n) => {
    if (n.type !== 'n8n-nodes-base.splitInBatches') return false;
    const { batchSize: _size, ...rest } = n.parameters ?? {};
    n.parameters = rest;
    return true;
  },
  ghostHop: (json, n) => routeThrough(json, n, `Ghost of ${n.name}`),
  indexMissing: (json, n) => {
    const incoming = firstIncoming(json, n.name);
    return incoming !== null && (delete incoming.target.index, true);
  },
  indexString: (json, n) => {
    const incoming = firstIncoming(json, n.name);
    return incoming !== null && (incoming.target.index = String(incoming.target.index ?? 0), true);
  },
  mergeVersionString: (_, n) => n.type === 'n8n-nodes-base.merge' &&
    (n.typeVersion = String(n.typeVersion ?? 1) as unknown as number, n.parameters = { ...n.parameters, mode: '={{ "append" }}' }, true),
  stickyOnPath: (json, n) => {
    const via = `Sticky before ${n.name}`;
    if (!routeThrough(json, n, via)) return false;
    addNode(json, { name: via, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: {} });
    return true;
  },
  indexStringFirst: (json, n) => {
    const incoming = firstIncoming(json, n.name);
    if (incoming === null || typeof incoming.target.index !== 'number') return false;
    incoming.group.splice(incoming.group.indexOf(incoming.target), 0, { ...incoming.target, index: String(incoming.target.index) });
    return true;
  },
  namelessNote: (json, n) => namelessNote(json, n, {}),
  namelessNoteErrorOutput: (json, n) => namelessNote(json, n, { onError: 'continueErrorOutput' }),
  pipeIds: (json, n) => {
    // P -> n (ids p, q) becomes P -> n with n's id 'm|q', and P -> X -> Y is added with ids 'p|m'
    // and q, X -> Y on P -> n's slots: the two print one dedupe key, and the later, X -> Y, stays.
    const incoming = firstIncoming(json, n.name);
    const nodes = json['nodes'] as RawNode[];
    const source = nodes.find((x) => x.name === incoming?.from);
    if (incoming === null || source === undefined || typeof incoming.target.index !== 'number') return false;
    const [p, q] = [source.id!, n.id!];
    n.id = `m|${q}`;
    const [x, y] = [`Pipe X of ${n.name}`, `Pipe Y of ${n.name}`];
    nodes.push({ id: `${p}|m`, name: x, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} });
    nodes.push({ id: q, name: y, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} });
    incoming.group.push({ node: x, type: 'main', index: 0 });
    const connections = json['connections'] as Record<string, Record<string, unknown>>;
    connections[x] = { main: [...Array.from({ length: incoming.output }, () => []), [{ node: y, type: 'main', index: incoming.target.index }]] };
    return true;
  },
  triggerSubNode: (json, n) => {
    const name = `Model for ${n.name}`;
    addNode(json, { name, type: 'acme.fooTriggerModel', typeVersion: 1, parameters: {} });
    (json['connections'] as Record<string, unknown>)[name] = { ai_languageModel: [[{ node: n.name, type: 'ai_languageModel', index: 0 }]] };
    return true;
  },
};

// ---- run ----------------------------------------------------------------------------------------
const corpus = newStats();
const mutants = newStats();
const mutantsBy: Record<string, number> = {};
const started = performance.now();

for (const file of files) {
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const raw = asWorkflow(file, json);
  const workflow = withIds(raw);
  let triggers: (string | undefined)[] = [undefined];
  const first = n8nVerdict(workflow, undefined);
  if (first.kind === 'refuse' && first.error === 'AmbiguousTriggerError') {
    triggers = workflow.nodes.filter((n) => n.disabled !== true && isTriggerNodeType(n.type)).map((n) => n.name);
  }
  for (const fired of triggers) {
    const tag = `${basename(file)}${fired === undefined ? '' : ` [${fired}]`}`;
    const theirs = n8nVerdict(workflow, fired);
    const rawVerdict = n8nVerdict(raw, fired);
    if (verdictText(rawVerdict) !== verdictText(theirs)) {
      idArtifacts.push({ entry: tag, raw: verdictText(rawVerdict), normalised: verdictText(theirs) });
    }
    compareEntry(corpus, 'corpus', tag, workflow, json, fired);
    if (theirs.kind !== 'accept') continue;

    // The mutants of an accepted entry, n8n and ours handed the same id-assigned JSON.
    const base = { ...json, nodes: workflow.nodes };
    const trigger = theirs.graph.nodes.find((n) => n.type === 'trigger')!.name;
    const reached = theirs.graph.nodes.map((n) => n.name).filter((n) => n !== trigger);
    for (const [kind, mutate] of Object.entries(MUTATIONS)) {
      for (const name of reached) {
        const mutant = clone(base) as Record<string, unknown> & { nodes: RawNode[] };
        mutant['connections'] = clone(json['connections'] ?? {});
        const node = mutant.nodes.find((n) => n.name === name)!;
        if (!mutate(mutant, node)) continue;
        mutantsBy[kind] = (mutantsBy[kind] ?? 0) + 1;
        compareEntry(mutants, `mutant ${kind}`, `${tag} {${kind} '${name}'}`, asWorkflow(file, mutant), mutant, fired);
      }
    }
    for (const [kind, named] of [['unknownTrigger', 'No Such Node'], ['notATrigger', reached[0]]] as const) {
      if (named === undefined) continue;
      mutantsBy[kind] = (mutantsBy[kind] ?? 0) + 1;
      compareEntry(mutants, `mutant ${kind}`, `${tag} {${kind} '${named}'}`, workflow, base, named);
    }
    {
      const mutant = clone(base) as Record<string, unknown> & { nodes: RawNode[] };
      mutant['connections'] = clone(json['connections'] ?? {});
      addNode(mutant, { name: 'Fired Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: {} });
      mutantsBy['stickyTrigger'] = (mutantsBy['stickyTrigger'] ?? 0) + 1;
      compareEntry(mutants, 'mutant stickyTrigger', `${tag} {stickyTrigger}`, asWorkflow(file, mutant), mutant, 'Fired Note');
    }
  }
}

// ---- (4) the trigger rule: our isTriggerNodeType against n8n's, on every type in sight ----------
const types = new Set<string>([...V2_TRIGGER_NODE_TYPES, ...Object.keys(nodeTypes.types ?? {}).map((k) => k.replace(/@[0-9.]+$/, ''))]);
for (const file of files) for (const n of (JSON.parse(readFileSync(file, 'utf8')).nodes ?? []) as RawNode[]) types.add(n.type);
const triggerDrift = [...types].filter((t) => isV2TriggerType(t) !== isTriggerNodeType(t));
for (const t of triggerDrift) findings.push({ leg: '4 drift', entry: t, detail: `isV2TriggerType ${isV2TriggerType(t)}, n8n's isTriggerNodeType ${isTriggerNodeType(t)}` });

const statsText = (label: string, st: Stats): string[] => [
  `${label}: ${st.entries} entries; n8n accepts ${st.n8nAccepts}, ours ${st.oursAccepts}`,
  `  (1) verdict: ${st.verdictDisagreements} disagreements`,
  `  (2) graph: ${st.bothAccept} both-accept (${st.loopEntries} with a batch loop), ${st.graphDisagreements} disagreements (${st.renamedIds} node ids differ)`,
  `  (3) code: ${st.bothRefuse} both-refuse; ${st.codeEqual} equal, ${st.codeMultiDefect} differ on a multi-defect workflow, ${st.codeFindings} findings`,
  `      refusals by our code: ${Object.entries(st.byCode).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c} ${k}`).join(', ')}`,
  `  errors that are not a CompileError: ${st.ourErrors}`,
];
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`n8n@${n8nVersion} converter + validator vs the engineV2 port; libpetri ${libpetriVersion}${libpetriLinked ? ' (linked)' : ' (registry)'}`);
console.log(`node types: ${useCatalogue ? '.node-types/catalogue.json' : 'none (guessed)'}`);
console.log(`corpus: ${files.length} workflows`);
for (const line of statsText('corpus', corpus)) console.log(line);
for (const line of statsText('mutants', mutants)) console.log(line);
console.log(`  by mutation: ${Object.entries(mutantsBy).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`(4) drift: ${drift.sites.length} throw sites in ${Object.keys(SOURCES).length} files, ${Object.keys(V2_REFUSALS).length} entries; ` +
  `${drift.unmapped.length} unmapped, ${drift.stale.length} stale, ${drift.missing.length} files missing`);
console.log(`    trigger rule: ${types.size} node types, ${triggerDrift.length} where isV2TriggerType differs from n8n's isTriggerNodeType`);
for (const s of drift.unmapped) findings.push({ leg: '4 drift', entry: `${s.file}:${s.line}`, detail: `unmapped: ${s.text.replace(/\s+/g, ' ').slice(0, 160)}` });
for (const k of drift.stale) findings.push({ leg: '4 drift', entry: k, detail: `stale: V2_REFUSALS.${k} matches ${JSON.stringify(V2_REFUSALS[k].match)} at no single site` });
console.log(`node ids: ${idArtifacts.length} entries where n8n's verdict on the raw export differs from its verdict with the ids an import assigns`);
for (const a of idArtifacts) console.log(`  [ids] ${a.entry}\n      raw export: ${a.raw}\n      ids assigned: ${a.normalised}`);
console.log(`wall clock: ${seconds} s`);
for (const m of multiDefect) {
  console.log(`\n[multi-defect] ${m.entry}\n      n8n  ${m.n8n}\n      ours ${m.ours}\n      n8n's refusals, repairing one at a time: ${m.chain}`);
}
for (const f of findings) console.log(`\n[${f.leg}] ${f.entry}\n      ${f.detail}`);
console.log(`\nfindings: ${findings.length}`);
if (JSON_OUT !== '') writeFileSync(JSON_OUT, JSON.stringify({ corpus, mutants, mutantsBy, findings, multiDefect, idArtifacts, drift }, null, 2));
process.exitCode = findings.length > 0 ? 1 : 0;
