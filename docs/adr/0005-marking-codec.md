# ADR 0005 — The marking codec and Wait-node resume

Status: accepted (2026-09-04); implementation is M2.

## Context

n8n persists an execution's progress as `IRunExecutionData.executionData`:
`nodeExecutionStack` (the nodes ready to run, with their input data and `source`),
`waitingExecution` / `waitingExecutionSource` (partially arrived joins, one slot per input:
items, `[]`, or `null` for not arrived) and `resultData.runData`. The Wait node relies on it
(`workflow-execute.ts` @ `441970b`):

- When a node sets `waitTill`, the loop pushes the node's own entry back onto the *front* of
  the stack and breaks out of `executionLoop` (lines 2449–2460: `pushExecutionStack(executionData)`
  is `nodeExecutionStack.unshift`, 2178–2180; the `break` at 2459). Everything else on the
  stack and every `waitingExecution` slot is left as is and persisted.
- On resume, `processRunExecutionData` calls `handleWaitingState` before the loop (2226; body
  1496–1521): it clears `waitTill`, marks `nodeExecutionStack[0].node.disabled = true` unless
  `metadata.resumeError` is set (1515), so the Wait node runs again as a pass-through, and pops
  the last run of `lastNodeExecuted` from `runData` (1520) so the node does not show up twice.
- Queue mode hands the same `IRunExecutionData` to another worker after a wait.

The net has no `nodeExecutionStack`. A running execution's progress is the marking. If the
marking were persisted in its own format, every consumer of `IRunExecutionData` — the
editor's partial-execution UI, queue-mode workers, `WorkflowDataProxy`, crash recovery —
would need to learn it.

## Decision

**n8n stays the system of record.** The `MarkingCodec` converts the quiescent marking to and
from n8n's own shapes; nothing of the net is persisted.

- **Pausing.** A Wait node's action deposits `_paused` (an `xor` alternative alongside
  `X/ok`), which every `X_start` / `X_retry_wait` inhibits like `_halt`, but with no reap.
  The executor then quiesces on its own: in-flight actions finish and their outputs are
  routed (EXEC-040). The codec runs on that quiescent marking.
- **Encoding** (marking → `IRunExecutionData`):
  - The Wait node's own entry first on `nodeExecutionStack`, as `handleWaitingState`
    expects, carrying the input it was activated with.
  - Every other `data` token on an edge or `X/in` place becomes a stack entry for its
    consumer, in FIFO token order, with `source.previousNode` / `previousNodeOutput` /
    `previousNodeRun` from the token.
  - Each join slot (ADR 0003) becomes `waitingExecution[node][runIndex].main`: `ready_i`
    tokens map slot-by-slot in FIFO order, a `data` token to its items, an `empty` token
    to `[]`, and a missing input to `null`; `waitingExecutionSource` mirrors it. Arrivals
    still queued in an edge place behind `free_i` take the next run index.
  - `_budget`, `X/idle`, `X/free_i`, `X/tries` and the `done` / `skipped` markers are not
    encoded: they are re-seeded on decode, and `done` / `skipped` are rebuilt from `runData`.
- **Decoding** (non-empty `nodeExecutionStack` → initial marking): each stack entry seeds
  the consumer's `X/in` (or edge place); each `waitingExecution` slot seeds `ready_i` with a
  `data` or `empty` token per non-`null` input and leaves `null` inputs unmarked; the
  disabled Wait node runs as n8n's pass-through and routes its stored output. `runIndex` is
  never stored in a token; it is computed from `runData` at `X_run` time.
- Join inputs fed only by nodes unreachable from the start node are seeded with `empty`
  (unreachable is definitionally empty), which is the `null → []` substitution of R6 done
  once, at decode time.

## Consequences

- Wait/resume and queue-mode handoff work with an unmodified `IRunExecutionData`; the
  patches never touch persistence.
- A marking is only encoded at quiescence, so nothing in flight is ever serialised. Halt
  showed the price of that rule: an action in flight when the pause lands still completes and
  its routed output is part of the encoded state, which is what n8n does too (the node's run
  is recorded before the loop breaks).
- Slot-by-slot encoding is exact for the FIFO pairing the join gadget enforces; the
  arrival-count mismatch n8n silently tolerates has no encoding and is reported instead
  (divergence #2).
- `X/tries` is re-seeded on decode, so retries do not survive a wait; n8n does not persist
  retry counts either.

## Evidence

- `typescript/tests/spikes/join-gadget.test.ts` — the `ready_i` FIFO queues pair first with
  first and a second arrival waits in its edge place, which is the slot-by-slot order the
  encoder relies on.
- `typescript/tests/spikes/halt.test.ts` — an inhibitor on every start plus natural
  quiescence: the in-flight node completes, its output is routed and lands in the final
  marking; nothing new starts. `_paused` uses the same mechanism minus the reap.
- `typescript/tests/spikes/emission-cycle.test.ts` — skipped nodes leave `empty` on tree
  edges, which the encoder writes as `[]`, matching R6's substitution at line 2688.
- The codec's own round-trip tests land in M2 under `typescript/tests/codec/`.
