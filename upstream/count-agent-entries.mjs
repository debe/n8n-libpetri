// Counts the accepted engine v2 corpus entries that an agent tool call could reach.
// n8n's own V1WorkflowConverter and validateExecutableGraph, from `.n8n` dist (the pin), over
// `.templates/` (200 public templates) and `scripts/testbed/workflows/` (11 workflows of our own),
// one entry per fired trigger as in tasks/spike-v2-settlement.mts. Prints the counts for all
// entries, then for each source. Run from the repository root: node upstream/count-agent-entries.mjs
// Measured 2026-10-03 at 944afe5:
//   all        entries 310, accepted 209, anyTool 85, agentInGraph 69, v3Entries 12, oldEntries 44, mcpEntries 13
//   templates  entries 299, accepted 202, anyTool 82, agentInGraph 66, v3Entries 9,  oldEntries 44, mcpEntries 13
//   own        entries 11,  accepted 7,   anyTool 3,  agentInGraph 3,  v3Entries 3,  oldEntries 0,  mcpEntries 0
//   files with an Agent at typeVersion >= 3 anywhere: 13 templates, 5 of our own
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, basename } from 'node:path';
const root = process.cwd();
const pkg = resolve(root, '.n8n/packages/@n8n');
const req = createRequire(`${pkg}/node-engine-compatibility/package.json`);
const { validateExecutableGraph } = req(`${pkg}/engine/dist/graph/validate-executable-graph.js`);
const { V1WorkflowConverter } = req(`${pkg}/node-engine-compatibility/dist/v1-workflow-converter.js`);
const { isTriggerNodeType } = req('n8n-workflow');
const sources = {
  templates: readdirSync(resolve(root, '.templates')).filter((f) => f.endsWith('.json')).map((f) => resolve(root, '.templates', f)),
  own: readdirSync(resolve(root, 'scripts/testbed/workflows')).map((f) => resolve(root, 'scripts/testbed/workflows', f)),
};
const AGENT = '@n8n/n8n-nodes-langchain.agent';
const converter = new V1WorkflowConverter();

function count(files) {
  let entries = 0, accepted = 0, anyTool = 0, agentInGraph = 0, v3Entries = 0, oldEntries = 0, mcpEntries = 0, v3Files = 0;
  const versions = new Map(); const agentTypes = new Map();
  for (const file of files) {
    const wf = JSON.parse(readFileSync(file, 'utf8'));
    if ((wf.nodes ?? []).some((n) => n.type === AGENT && Number(n.typeVersion) >= 3)) v3Files++;
    const workflow = { id: basename(file, '.json'), name: wf.name ?? '', active: false, nodes: wf.nodes ?? [], connections: wf.connections ?? {}, settings: wf.settings ?? {}, createdAt: new Date(), updatedAt: new Date() };
    let triggers = [undefined];
    try { converter.convert(workflow); } catch (e) {
      if (e.constructor.name === 'AmbiguousTriggerError') triggers = workflow.nodes.filter((n) => !n.disabled && isTriggerNodeType(n.type)).map((n) => n.name);
    }
    const agents = new Set();
    for (const byType of Object.values(wf.connections ?? {})) for (const group of (byType?.ai_tool ?? [])) for (const c of (group ?? [])) if (c?.node) agents.add(c.node);
    for (const fired of triggers) {
      entries++;
      let graph;
      try { graph = converter.convert(workflow, fired); validateExecutableGraph(graph); } catch { continue; }
      accepted++;
      if (agents.size > 0) anyTool++;
      const hit = graph.nodes.filter((n) => agents.has(n.name));
      const nodesOf = hit.map((h) => wf.nodes.find((x) => x.name === h.name));
      const ag = nodesOf.filter((n) => n?.type === AGENT);
      for (const n of ag) versions.set(n.typeVersion, (versions.get(n.typeVersion) ?? 0) + 1);
      if (ag.some((n) => Number(n.typeVersion) >= 3)) v3Entries++; else if (ag.length) oldEntries++;
      if (nodesOf.some((n) => n?.type === '@n8n/n8n-nodes-langchain.mcpTrigger')) mcpEntries++;
      if (hit.length > 0) { agentInGraph++; for (const h of hit) { const t = wf.nodes.find((x) => x.name === h.name)?.type; agentTypes.set(t, (agentTypes.get(t) ?? 0) + 1); } }
    }
  }
  return { counts: { files: files.length, entries, accepted, anyTool, agentInGraph, v3Entries, oldEntries, mcpEntries, v3Files }, versions: [...versions].sort(), agentTypes: [...agentTypes].sort((a, b) => b[1] - a[1]) };
}

for (const [name, files] of [['all', [...sources.templates, ...sources.own]], ...Object.entries(sources)]) {
  const { counts, versions, agentTypes } = count(files);
  console.log(name, counts); console.log('  agent versions on the fired graph', versions); console.log('  tool-using node types', agentTypes);
}
