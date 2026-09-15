/**
 * Join slots (README "Join gadget") in both directions, for the two slotted forms — the
 * generic join and choose-branch. Each input is a `free_i` / `ready_i` slot; n8n keeps a
 * partial slot as a `waitingExecution[X][k]` row and a complete one as a stack entry.
 *
 * Decode ({@link JoinQueues}, `join-decode.ts`) collects every input's arrivals positionally
 * (stack entries — the entry heads input 0, a unit companion every other input — then the rows
 * in ascending `k`) and materialises them once all are read: the head takes the `ready` place
 * and withholds `free_i`, every later arrival queues on the input's first edge place, behind
 * `free_i`, as a live second arrival would (ADR 0003). Encode ({@link encodeJoin},
 * `join-encode.ts`) reads the same positional queues back out of the marking and pairs them
 * into rows and entries.
 */
export { decodeJoinEntry, decodeJoinRow, JoinQueues, type JoinInput } from './join-decode.js';
export { encodeJoin } from './join-encode.js';
