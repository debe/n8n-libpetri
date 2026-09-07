# ADR 0005 — The marking codec and Wait-node resume

Status: accepted (2026-09-04); amended 2026-09-06 with the final mapping (M2, track E).

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

- **Pausing.** A Wait node's action deposits `_paused` (an `xor` alternative alongside the
  success branch), which every `X_start` / `X_retry_wait` inhibits like `_halt`. Neither is
  reaped: since M6 nothing is (ADR 0004, "The reap is gone").
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

## Amendment (2026-09-06) — the final mapping

Implemented in `typescript/src/codec.ts` (`decodeExecutionData`, `encodeMarking`); tests
under `typescript/tests/codec/`. What changed against the text above, and what was left
open there:

- **Pause is `_pause`, not `_paused`**, deposited by the `waiting` / `stopped` outcome
  alternatives of `X_run` / `X_exhausted` (README "Retries, halt, cancellation"). Only
  `X_start`, `X_start_unmet` and `X_retry_wait` inhibit on it, so a paused net drains its
  structural transitions and quiesces with every token on an `in` / `ready` / `hasdata` /
  `waiting` place (plus `X/retry`: the retry wait is pause-inhibited and holds its budget
  unit, which decode re-seeds).
- **Token vocabulary.** A stack entry decodes to an `EntryPayload` (the `IExecuteData`
  object by reference — `metadata`, `runIndex`, the live `INode` included — which the start
  action passes through verbatim, as n8n runs an entry unconditionally); a `waitingExecution`
  slot to an `EdgePayload` (`items` by reference, `source` from `waitingExecutionSource`) or a
  unit token for `[]`. For a join / choose-branch entry the entry heads the first input's
  data slot with a unit companion on every other input's data slot (one `X/hasdata` unit on a
  generic join); `X/free_i` is withheld for every input that received a head, and a decoded
  head replaces the seeded empty of an unreachable input.
- **The seeded empty of an unreachable input is a one-off.** This is the choice the first
  implementation attempt got wrong, and the one the `twoTriggers` round trips pinned down.
  `sharedMarking()` re-creates exactly one empty on each join input fed only by producers no
  start node can reach (README "Initial marking and the marking codec"). It is R6's
  `null → []` substitution *done once*, so the first decoded head of that input **consumes**
  it — a head, an entry companion or a `[]` from `waitingExecution` alike — and it is never
  queued behind that head, never written back by encode (a join whose whole content is seeds
  is dropped: decode re-seeds it), and therefore not part of the round trip's semantic
  projection. That is literally what `initialMarking` does for the primary start node's own
  entry (`compile.ts`: it deletes `free_i` and every `ready` place of the join before writing
  the entry and its companions), and a decoded join stack entry now produces exactly the
  marking `initialMarking` produces for the same entry — asserted in `tests/codec/decode.test.ts`.
  The alternative — keeping the seed queued behind the entry so a *later* arrival on another
  input could pair with `[]` again — is wrong twice over: an n8n stack entry already carries
  that `[]` in its own `data.main[i]` (n8n's `allDataFound` did the padding when it built the
  entry), so re-queuing applies the substitution a second time; and the requeued token has no
  n8n shape, so `encode(decode(x))` invented a `waitingExecution` slot of `{ main: [null, []] }`
  that `x` never had and the net stranded a token on that input once the entry had run. The
  price of the one-off rule is the mirror case: a join that is handed both a complete entry
  *and* a further arrival on another input (n8n-inconsistent for an acyclic workflow — the
  producer would have to run twice) strands instead of being padded a second time. That is
  divergence #2, reported by the stranded encoder and provable statically, which is the
  register entry we already accept for it.
- **Slots are positional per input.** The queue of input `i` is the token on its `ready`
  place followed by the tokens on its edge places in canonical edge order; slot `j` pairs
  the `j`-th token of every input. That is the FIFO pairing the gadget enforces and what
  n8n's first-fit allocator produces for its own states. Decode reads `waitingExecution`
  slots per input in ascending run index: the first arrival takes the `ready` place and
  every later one queues on the input's **first edge place** (the arm forwards the payload
  when `free_i` returns), which keeps the order exact across a resume regardless of which
  producer the arrival came from. Encode writes a **complete** slot as a stack entry
  (`{ node, data: { main: items | [] per input }, source: { main } }`, n8n's `allDataFound`),
  an **entry-headed** slot as the entry verbatim, and a **partial** slot as
  `waitingExecution[node][k]` (`items` + source, `[]` + `null`, `null`) with `k = 0…` per node
  in positional order. Run indexes are renumbered; nothing but the allocator reads them.
- **OR rounds have a resume shape** (open item of track D). The deliveries of an open
  round beyond the pending arrivals and the seeds are written as
  `waitingExecution[C][k] = { main: [[]] }` — n8n's own "arrived empty", which its R6
  discards without running anything — and read back as `X/ready_i` units. A pending arrival
  on `X/hasdata_i` is a stack entry; on decode its `source`, if it names a tree edge from a
  producer the compile can reach, counts as one delivery again (the arm had counted it).
  `X/ran_i` is not encodable in n8n's shapes; decode rebuilds one marker when the round is
  open and `runData[C]` is non-empty (for an acyclic OR node there is exactly one round, so
  "ran at all" is "ran in this round"). Approximations, all in the positional class of
  divergences #8 / #10: a round that ran only a filtered-out or no-output activation (no
  `runData`) loses its marker and may skip after the pause; a second round of a node with
  unreachable producers double-counts the seeds.
- **Resume seeding of `Y/skipped`.** Beyond the shared marking's seeds (nodes unreachable
  from every start node), decode seeds `Y/skipped` for every referenced node with no
  recorded run that no pending activation (stack entry or waiting slot) can reach through
  the connection graph: `Y` will never run, so `X`'s `$('Y')` must fail with n8n's own error
  through `X_start_unmet` instead of stranding on the read arc. `X/done` comes from
  `runData` as before.
- **Modes and errors.** `pause` (default) and `cancelled` write the stack; `stranded`
  (natural quiescence with leftovers, divergence #2) writes every pending token —
  complete slots and entries included — to `waitingExecution` with one diagnostic per
  token naming node and place, never to the stack. A token on a place the net drains on its
  own before quiescence (`X/running`, `X/routed`, `X/ok_o`, `X/routed_o`, `X/in_empty`, an OR
  input's edge places; `X/retry` in `stranded`) is a `CodecError` naming the place. `cancelled`
  (`executor.close()`, ENV-013) is the one mode that legitimately sees them: a running token is
  a pending activation; a node that routes inside `X_run` (at or below `SPLIT_ROUTING_ABOVE`)
  has already deposited its successors' entries on the edge places, so only its leftover
  `X/routed` unit is discarded, while a node **above** the threshold can still be caught with
  its outcome on `X/ok_o`, which the encoder routes as `X_route_o` would have — either way the
  successors end where n8n's `addNodeToBeExecuted` had put them before the next iteration's
  cancellation check. `X/stopped` with `ran: false` (n8n's `shouldStopExecuting`
  before the pop) is a pending activation; with `ran: true` it is discarded.
- **Stack order.** The waiting node first, then depth descending, canvas order, token FIFO:
  the deepest pending node first, where n8n's LIFO `unshift` has it.
- **Round trips** (`tests/codec/roundtrip.test.ts`, seeded generators, no fast-check —
  a hand-rolled mulberry32 in `tests/codec/support.ts`, 200 seeds × 16 fixtures per
  direction): `encode(decode(x)) ≡ x` up to slot renumbering for n8n-consistent state
  (first-fit slots, canonical stack order), entries by reference, and `decode(y) ≡ decode(x)`
  token for token; `decode(encode(m)) ≡ m` for quiescent pause markings under the semantic
  projection (the pending activations per node whichever place holds them, plus the re-seeded
  control places) — a complete data slot comes back as an entry-headed slot with the same
  activation, a lone seeded empty is outside the projection (previous bullet), `_budget` is
  re-seeded to `k`, `_pause` is gone (a resumed net is not paused) and `X/skipped` is rebuilt
  from reachability. Exact marking equality is not available in either direction and not the
  right notion: n8n's format has one shape for "every input has arrived" (a stack entry), so
  the four markings that reach it — heads on the `ready` places, an entry-headed slot, a
  `stopped` token, a `retry` token — all encode to it and decode back as the entry-headed one.
  The projection is what survives that, and it is the equivalence the executor observes.
