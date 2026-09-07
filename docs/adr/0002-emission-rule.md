# ADR 0002 — The emission rule: explicit empty tokens, `nil` on cycles

Status: accepted (2026-09-04)

## Context

n8n v1 never propagates an empty output. The gate in `WorkflowExecute.processRunExecutionData`
(`packages/core/src/execution-engine/workflow-execute.ts` @ `441970b`, lines 2514–2517) only
schedules a successor when `nodeSuccessData[outputIndex].length !== 0`; the `connectionData.index > 0`
exception is guarded by `isLegacyExecutionOrder`, so it is v0-only. A multi-input node whose
other branch produced nothing therefore never receives its second arrival, its
`waitingExecution` slot stays `null`, and the join starves. R6 (lines 2582–2740) exists to
rescue such joins: once `nodeExecutionStack` is empty it walks `waitingExecution` and fires the
node with `[]` substituted for the missing inputs (line 2688). R6 is a symptom fix and it is
also the place where n8n's arrival-count mismatch bug lives (see ADR 0003).

A Petri net cannot "not send": an AND-join enables only when every input place holds a
token. The natural fix — every activation writes either `data` or `empty` on every outgoing
edge — is correct on a DAG but wrong on a cycle: a node skipped because its input was empty
would emit `empty` on its back edge, re-activating its predecessor's skip, which emits `empty`
again, forever. The spike reproduces this storm (`emission-cycle.test.ts`, control case: the
run never quiesces and has to be stopped with `close()`).

## Decision

An **empty token** asserts "this edge carries nothing for this activation of the producer". The
assertion is only meaningful when the producer cannot be re-activated by its own output, so
edges are classified after an SCC decomposition of the main-connection graph:

| Edge | Producer fires with data (`X_run`, or `X_route_o` above the split threshold) | Producer skipped (`X_skip`) |
|---|---|---|
| tree edge, producer not in a cycle | `data \| empty` | `empty` |
| tree edge, producer in a cycle | `data \| nil` | `empty` |
| cycle edge (both ends in one SCC) | `data \| nil` | nothing |

- `nil` is a per-output local place consumed by a genuine sink transition with no output
  spec (libpetri CORE-043 AC4). It records "this activation produced nothing here" without
  ever enabling a successor.
- The per-edge choice is the output spec `and(per edge: xor(data, empty | nil), …)` (IO-011,
  IO-012); the routing action selects the branch of each `xor` by which place it writes
  (IO-015). Writing both or neither is a validation failure surfaced as a
  `transition-failed` event (EVT-008) that loses the consumed tokens (EXEC-030/031) and
  leaves the run quiescing normally.
- IF / Switch / Filter route items, so `empty` on a starved output is a fact. Loop Over Items
  emits `nil` on `done` for intermediate firings ("not yet"), `data` on the final one.
  Skipping a whole loop emits `empty` on the loop's tree exit edge, so a downstream join still
  completes.

## Consequences

- On an acyclic workflow every join input eventually holds `data` or `empty`, so an AND-join
  always completes. R6's starved-branch case has no cause left (divergence #1).
- Cycles terminate: `nil` never re-activates anything and is drained by its sink before the
  next activation, so it never accumulates.
- A skipped node inside an SCC emits nothing on its cycle edges. If the SCC's only exit edge
  belongs to a *different* node of the SCC, that exit edge stays silent when the entry node is
  skipped; a downstream join would then strand. The compiler must treat this as a k = 1
  and verification concern (the stranded token is what `joinedOrDeadLettered` flags), not
  paper over it with a synthetic `empty`.
- Value-blind verification (VER-004) sees each `xor` as free choice, so every data/empty
  combination is explored. That is the over-approximation we want for safety properties.

## Evidence

- `typescript/tests/spikes/out-spec.test.ts` — the `and`-of-`xor` spec is valid and compiles;
  branch selection by written place; both-written and neither-written are IO-015 violations
  with the exact messages libpetri 5.0.0 emits; tokens lost; run quiesces.
- `typescript/tests/spikes/emission-cycle.test.ts` — a three-iteration Loop-Over-Items cycle
  terminates with 4 loop-node firings and 3 body firings; every `nil` place peaks at one token
  and ends empty; skipping the whole loop yields `empty` on the exit edge; the `empty`-on-cycle
  control never quiesces.
