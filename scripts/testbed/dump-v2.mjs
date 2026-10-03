/**
 * Reads executions and their step rows from engine v2's data plane over SQL, for
 * `diff-engines-v2.sh` (`tasks/v2-seam-plan.md` step 12). The comparison reads what the engine
 * wrote, not what n8n's REST API renders from it.
 *
 *   node dump-v2.mjs <postgres-url> <out.json> <execution-id> [more ids ...]
 *
 * The client is the `pg` the engine itself depends on, resolved from `packages/@n8n/engine`, so
 * nothing is installed for this. Filled output slots are computed with the store's own SQL
 * expression (`FILLED_OUTPUT_SLOTS` in `typeorm-step-store.ts`), so a slot counts as filled exactly
 * when the settlement handler would count it filled. Read-only: one `SELECT` per table.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { Client } = createRequire(resolve(here, '../../.n8n/packages/@n8n/engine/package.json'))('pg');

const [url, outPath, ...ids] = process.argv.slice(2);
if (!url || !outPath || ids.length === 0) {
  console.error('usage: node dump-v2.mjs <postgres-url> <out.json> <execution-id> [more ids ...]');
  process.exit(2);
}

const FILLED_OUTPUT_SLOTS = `COALESCE(
  (SELECT array_agg(jsonb_typeof(slot.value) <> 'null' ORDER BY slot.ordinality)
   FROM jsonb_array_elements(step.outputs) WITH ORDINALITY AS slot),
  '{}'
)`;

const client = new Client({ connectionString: url });
await client.connect();
try {
  const executions = await client.query(
    `SELECT id, workflow_id, status, mode, graph, response_expectation, created_at, finished_at
       FROM workflow_execution WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const steps = await client.query(
    `SELECT step.execution_id, step.node_id, step.iteration, step.status, step.outputs, step.error,
            ${FILLED_OUTPUT_SLOTS} AS filled_output_slots, step.created_at, step.updated_at
       FROM workflow_step_execution step
      WHERE step.execution_id = ANY($1::uuid[])
      ORDER BY step.execution_id, step.node_id, step.iteration`,
    [ids],
  );
  const server = await client.query('SHOW server_version');

  const missing = ids.filter((id) => !executions.rows.some((e) => e.id === id));
  if (missing.length > 0) throw new Error(`not in workflow_execution: ${missing.join(', ')}`);

  const out = {
    serverVersion: server.rows[0].server_version,
    executions: executions.rows.map((e) => ({
      id: e.id,
      workflowId: e.workflow_id,
      status: e.status,
      mode: e.mode,
      responseKind: e.response_expectation?.kind ?? null,
      nodes: (e.graph?.nodes ?? []).map((n) => ({ id: n.id, name: n.name, type: n.type })),
      createdAt: e.created_at,
      finishedAt: e.finished_at,
      steps: steps.rows
        .filter((s) => s.execution_id === e.id)
        .map((s) => ({
          nodeId: s.node_id,
          iteration: s.iteration,
          status: s.status,
          filledOutputSlots: s.filled_output_slots,
          outputs: s.outputs,
          error: s.error,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
        })),
    })),
  };
  await mkdir(dirname(resolve(outPath)), { recursive: true });
  await writeFile(resolve(outPath), `${JSON.stringify(out)}\n`);
  console.log(`[dump] ${out.executions.length} executions, ${steps.rows.length} step rows -> ${outPath}`);
} finally {
  await client.end();
}
