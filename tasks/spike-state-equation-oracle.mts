/**
 * The route-vs-route oracle: does the state-equation phase (VER-018) ever prove something
 * Spacer refutes?
 *
 * The graph-closed oracle covers only nets small enough for the state-class graph to close —
 * exactly the population where the algebra is least likely to go wrong. The nets that would
 * expose an unsound over-approximation are the **truncating** ones, and there the graph cannot
 * referee. This is the oracle that covers them: for every check the phase proves, re-ask the
 * same query with the phase off, so IC3/PDR through Spacer answers instead.
 *
 * A contradiction is `proven` by the phase and `violated` by Spacer. `unknown` from Spacer is
 * not a contradiction — it is the timeout this phase exists to avoid, and it is the expected
 * answer on most of them.
 *
 * Needed the linked working tree when it was written; the surface shipped in libpetri 6.0.0,
 * so it now runs against an ordinary install.
 *
 *   npx tsx tasks/spike-state-equation-oracle.mts
 *   LIMIT=40 TMO=20000 npx tsx tasks/spike-state-equation-oracle.mts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { SmtVerifier } from '../typescript/node_modules/libpetri/dist/verification/index.js';
import { verify } from '../typescript/src/verify/index.js';
import { describeWorkflowJson, parseNodeTypesFile } from '../typescript/src/verify/workflow-json.js';

const DIR = new URL('../.templates/', import.meta.url).pathname;
const CAT = new URL('../.node-types/catalogue.json', import.meta.url).pathname;
const LIMIT = Number(process.env.LIMIT ?? 1e9);
const TMO = Number(process.env.TMO ?? 15_000);

const nodeTypes = parseNodeTypesFile(JSON.parse(readFileSync(CAT, 'utf8')));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().slice(0, LIMIT);

/**
 * Force the phases off for run B.
 *
 * Nothing in this project calls `stateEquationPhase` — it is default-on — so the only way to
 * ask the same query the old way is to disable it where the verifier is constructed. Patching
 * the static keeps `verify()` and its whole route untouched, which is the point: run A and run
 * B must differ in the phase and in nothing else.
 */
const pristine = SmtVerifier.forNet.bind(SmtVerifier);
let phasesOff = false;
(SmtVerifier as any).forNet = (net: unknown) => {
  const v: any = pristine(net as never);
  return phasesOff ? v.stateEquationPhase(false).firingBound(false) : v;
};

const key = (c: any) => `${c.name}|${JSON.stringify(c.subject)}`;
let workflowsWithPhaseProofs = 0;
let phaseProofs = 0;
let spacerDecided = 0;
let contradictions = 0;
const detail: string[] = [];

for (const [i, f] of files.entries()) {
  let description: any;
  try {
    description = describeWorkflowJson(JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')), { nodeTypes }).description;
  } catch { continue; }
  const opts: any = { budget: 1, smtFallback: 'auto', timeoutMs: TMO, properties: ['proper-completion'] };

  let a: any;
  try { phasesOff = false; a = await verify(description, opts); } catch { continue; }
  const proved = (a.checks as any[]).filter(
    (c) => c.verdict === 'proven' && c.query?.method === 'state-equation');
  if (proved.length === 0) continue;
  workflowsWithPhaseProofs++;
  phaseProofs += proved.length;

  let b: any;
  try { phasesOff = true; b = await verify(description, opts); } finally { phasesOff = false; }
  const byKey = new Map<string, any>();
  for (const c of b.checks as any[]) byKey.set(key(c), c);

  for (const c of proved) {
    const other = byKey.get(key(c));
    if (other === undefined || other.verdict === 'unknown' || other.verdict === 'bounded') continue;
    spacerDecided++;
    if (other.verdict === 'violated') {
      contradictions++;
      detail.push(`${f}: ${c.name} — phase=proven spacer=violated`);
    }
  }
  if ((i + 1) % 10 === 0) {
    console.log(`[${i + 1}/${files.length}] workflows=${workflowsWithPhaseProofs} proofs=${phaseProofs}`
      + ` cross-checked=${spacerDecided} contradictions=${contradictions}`);
  }
}

console.log('\n============ STATE-EQUATION ORACLE ============');
console.log(`templates scanned:                    ${files.length}`);
console.log(`workflows with a state-equation proof: ${workflowsWithPhaseProofs}`);
console.log(`state-equation proofs total:           ${phaseProofs}`);
console.log(`of those, Spacer also decided:         ${spacerDecided}`);
console.log(`CONTRADICTIONS (phase proven, Spacer violated): ${contradictions}`);
for (const d of detail.slice(0, 20)) console.log(`   ${d}`);
console.log('\nA Spacer `unknown` is not a contradiction: it is the timeout VER-018 exists to avoid,');
console.log('and it is the expected answer on most of these. The claim this run supports is only');
console.log('as wide as the `Spacer also decided` line.');
writeFileSync('/tmp/state-equation-oracle.json',
  JSON.stringify({ files: files.length, workflowsWithPhaseProofs, phaseProofs, spacerDecided, contradictions, detail }, null, 1));
