/**
 * The marking codec (ADR 0005): the quiescent marking ↔ n8n's own
 * `IRunExecutionData.executionData` (`nodeExecutionStack`, `waitingExecution`,
 * `waitingExecutionSource`). n8n stays the system of record; nothing of the net is
 * persisted. The scheduler decodes on every `run()` and encodes at quiescence when the net
 * paused (`X/waiting`, `X/stopped`, `_pause`), was cancelled, or left tokens stranded.
 *
 * **Decoding** ({@link decodeExecutionData}) layers n8n's state over
 * `compiled.sharedMarking()` (`_budget` × k, `X/idle`, `X/free_i`, `X/tries`, the seeded
 * empties of inputs fed only by unreachable producers, the seeded `Y/skipped`):
 *
 * | n8n | marking |
 * |---|---|
 * | stack entry, direct-form node | an `EntryPayload` on `X/in` (FIFO) |
 * | stack entry, OR-form node | an `EntryPayload` on `X/hasdata_i`; a source over a tree edge from a reachable producer is one delivery of the round (`X/ready_i` + 1) |
 * | stack entry, join / choose-branch node | the entry on the first input's data slot, a unit companion on every other input's data slot, one unit on the generic join's `X/hasdata`; `X/free_i` withheld; the head replaces the seeded empty of an unreachable input — literally what `initialMarking` builds for the start node's own entry |
 * | `waitingExecution[X][k].main[i]` items | an `EdgePayload` (`source` from `waitingExecutionSource`) on `X/ready_i` (`X/ready_i_data` for a required choose-branch input) plus one `X/hasdata` unit on a generic join |
 * | `waitingExecution[X][k].main[i] = []` | a unit on `X/ready_i` (`X/ready_i_empty`): n8n's "arrived empty" |
 * | `waitingExecution[X][k].main[i] = null` | nothing (not arrived) |
 * | `waitingExecution[C][k].main = [[]]`, OR-form node | one delivery of the open round (`X/ready_i` + 1) |
 * | `runData[Y]` non-empty | `Y/done` |
 *
 * Slots are read per input in ascending `k` into the input's FIFO: the first arrival takes
 * the `ready` place (its seeded empty, if any, goes; `free_i` is withheld so
 * `free_i + ready_i ≤ 1` holds from the first marking on) and every later one queues on the
 * input's first edge place, behind `free_i`, as a live second arrival would (ADR 0003; the
 * arm forwards the payload). Pairing is positional per input, which is what both the join
 * gadget and n8n's first-fit allocator do. Queued data keeps its order (one FIFO); a queued
 * `[]` sits on the edge's `empty` place and the arms fire data before empty when `free_i`
 * returns, so mixed queued arrivals behind a busy slot are re-paired in that order — the
 * same tie-break the live net applies to arrivals waiting simultaneously (positional class,
 * divergence #8). The seeded empty of an input fed only by unreachable producers is a
 * **one-off**: `sharedMarking()` re-creates exactly one per decode, the first decoded head of
 * that input consumes it, and it is never written back (encode drops a join whose whole
 * content is seeds). It is R6's `null → []` substitution done once, and an n8n stack entry
 * already carries that `[]` in its own `data.main[i]`; queuing the seed behind such an entry
 * would apply the substitution twice and strand a token once the entry had run.
 * An OR-form node whose round is open and that has
 * a recorded run gets one `X/ran_i` marker (the round closes with `X_clear`, not a skip).
 * A referenced node without a recorded run that no pending activation can reach is seeded
 * `Y/skipped` (README "Expression references"): the referencing node must fail with n8n's
 * own error, not strand on its read arc.
 *
 * **Encoding** ({@link encodeMarking}) is the inverse. Only `nodeExecutionStack`,
 * `waitingExecution` and `waitingExecutionSource` are rewritten:
 *
 * | marking | n8n |
 * |---|---|
 * | `X/waiting` | `nodeExecutionStack[0]`: the node's own `executionData` (n8n `pushExecutionStack`) |
 * | `X/stopped` with `ran: false`, `X/retry` (pause, cancelled), `X/running` (cancelled) | a stack entry (the activation re-runs from scratch; the budget a retry held is re-seeded on decode) |
 * | `X/failed_i` (pause, cancelled), `X/timedout_i` (cancelled), `X/running_i` (cancelled) | a stack entry, as `X/retry` and `X/running` are — the attempt *position* is not persisted, so the activation resumes at its first attempt (ADR 0009) |
 * | `X/in` / `X/hasdata_i` data token | a stack entry: `{ node, data: { main }, source: { main: [source] } }` with `main[inputIndex]` the items and `null` below (n8n `addNodeToBeExecuted`); an entry verbatim |
 * | complete join slot (every input has a token, at least one with data) | a stack entry `{ node, data: { main: items \| [] per input }, source: { main } }`; an entry-headed slot is the entry verbatim |
 * | partial join slot; complete all-empty slot (a skip, seen under `cancelled` only) | `waitingExecution[X][k]` / `waitingExecutionSource[X][k]`: items + source, `[]` + `null`, `null` |
 * | OR round: `X/ready_i` beyond the pending arrivals and the seeds | `waitingExecution[C][k] = { main: [[]] }` per delivery |
 * | `X/ok_o` (per-output routing, cancelled only) | routed by the encoder as `X_route_o` would have: the arrivals join their consumers' inputs |
 * | `_pause`, `_budget`, `_halt`, `X/idle`, `X/free_i`, `X/tries`, `X/done`, `X/skipped`, `X/ran_i`, `X/hasdata` (counter), `X/routed(_o)`, `X/nil_o`, `X/stopped` with `ran: true`, a join slot holding nothing but seeded empties | discarded (re-seeded on decode) |
 *
 * Stack order: the waiting node first, then depth descending, canvas order, token FIFO —
 * the deepest pending node first, which is where n8n's LIFO stack (`unshift`) has it.
 * `waitingExecution` slots are numbered `0…` per node in positional order (n8n's run
 * indexes are renumbered; nothing reads them but the allocator).
 *
 * Modes: `pause` (default) and `cancelled` produce the stack; `stranded` (natural
 * quiescence with leftovers, divergence #2) writes every pending token to
 * `waitingExecution` — n8n's own stuck-slot shape — never to the stack, and reports each
 * through `onDiagnostic`. A token on a place the net drains on its own before quiescence
 * (`X/running`, `X/routed(_o)`, `X/ok_o`, `X/in_empty`, an OR input's edge places in
 * `pause` and `stranded`; `X/retry` in `stranded`) is a {@link CodecError} naming the place:
 * the net must be drained before encoding. `cancelled` (`executor.close()`, ENV-013) is the
 * one mode that legitimately sees them, which is why the scheduler also uses it for the two
 * markings a `close()` can have caught mid-flight: a pause raced by a cancellation, and the
 * quiescent marking of a halted run, which keeps every pending activation where it was
 * delivered because nothing reaps it (`compiler/compile.ts`).
 *
 * **Errors and diagnostics** follow one convention in both directions:
 *
 * - A **structural impossibility** — the compiled net and the data disagree — is a
 *   {@link CodecError} naming the node and the place: the place the data needed, or the one
 *   the token was read from (a node the net lacks altogether is named alone). The codec
 *   cannot write such data without inventing topology, and dropping it would lose items from
 *   the execution. Decode: an entry or row for a node the compiled workflow does not have; a
 *   `[]` for an input with no empty place — direct, join and choose-branch alike; a second
 *   pending arrival an input has no edge place to queue on. Encode: a token on a place a
 *   quiesced net has drained; two different stack entries paired in one join slot; an
 *   arrival routed over an edge the consumer does not carry, in every input form
 *   (`codec/routed.ts`).
 * - A **foreign token shape** is a diagnostic naming node and place (`onDiagnostic`), and
 *   the token is skipped. Encode: a token whose value is not the payload its place carries —
 *   on `X/waiting`, `X/stopped`, `X/retry`, `X/running`, an attempt's places, `X/in`,
 *   `X/hasdata_i`, a join's slot and edge places, `T/in_tool`, `A/queue`, `A/dispatched`,
 *   `X/ok_o`. Decode, where the token is an n8n cell or entry: a `waitingExecution` cell at
 *   an input index the node does not model (the shape n8n leaves behind when a node's input
 *   count shrinks), and an `ai_tool` stack entry no open agent round claims.
 *
 * Diagnostics also report what is translated faithfully but has no row in n8n's state — a
 * pending empty on a direct-form input (n8n never enqueues one) and every `stranded` write
 * (divergence #2). Neither is an error.
 *
 * Round trips: `encode(decode(x))` reproduces n8n's `x` up to slot renumbering and the
 * canonical stack order; `decode(encode(m))` reproduces the pending activations of `m`
 * (`tests/codec/roundtrip.test.ts`).
 *
 * Layout: `codec/decode.ts` and `codec/encode.ts` dispatch every stack entry, row and node on
 * its gadget form; `codec/join.ts`, `codec/or-round.ts` and `codec/agent-round.ts` hold each
 * form's two directions; `codec/routed.ts` the arrivals the encoder routes off `X/ok_o`;
 * `codec/writer.ts` what one encode writes; `codec/entry.ts` n8n's stack-entry shapes.
 */
export { CodecError } from './codec/errors.js';
export { decodeExecutionData, type DecodeOptions } from './codec/decode.js';
export { encodeMarking, type EncodeMode, type EncodeOptions } from './codec/encode.js';
export { entryForEdge } from './codec/entry.js';
