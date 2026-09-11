# ADR 0009 — Execution policy in workflow JSON: the attempt chain

Status: accepted (2026-09-10). Built and measured end to end: compiler, carrier, scheduler,
codec, and the verifier's per-attempt bound.

## Context

The net exposes three tunable numbers and none of them is per node in a way a user can reach:
`_budget` comes from an environment variable, `A/rounds` from the agent's own
`options.maxIterations`, and `A/calls` from `options.maxToolCalls` — which, see §2, cannot be
set at all. Everything else that could be a policy is fixed in the gadget (`X/tries`, one delay,
one terminal) or lives outside the net entirely (`onError`, host-side in
`handleNodeExecutionError`). There is **no per-node deadline**, so a hung service holds a node
until n8n's whole-execution timeout.

The ask is per-node error routes that differ by attempt, per-attempt deadlines, and later
admission and rate — expressed as a powerful JSON language with only *proven* behaviours
surfaced in the editor.

## Decision

### 1. Three layers, and the test that keeps them apart

| layer | audience | vocabulary | lives in |
|---|---|---|---|
| **1. Workflow JSON** | the author, the editor, any n8n engine | `onFailure`, `retry`, `timeoutMs` | `node.executionPolicy`, `settings.executionPolicy` |
| **2. Structural IR** | the compiler, which never sees n8n | the same words, n8n-free | `NodeDescription.executionPolicy` |
| **3. Net encoding** | gadget, codec, verifier | places, arcs, roles | `X/failed_i`, `PlaceRole` |

**The test for layer 1: a workflow carrying this JSON must stay meaningful if n8n's own stack
scheduler runs it** — honouring what it can, ignoring the rest, nothing nonsense. That forbids
naming the engine (`petri`), the net (`place`, `token`) or a pattern library ("ladder",
"bulkhead") anywhere at layer 1. Layer-3 names reach users too, through
`verify/counterexample.ts`, so they are chosen to read in a report: `X/failed_2`, not `X/rung_2`.

Applying the test produced the design's strongest evidence: **`onFailure` is n8n's own `onError`
generalised over attempts.** `stopWorkflow` / `continueErrorOutput` / `continueRegularOutput` are
`stop` / `route` / `continue`, and `retryOnFail` + `maxTries` + `waitBetweenTries` is the
all-`retry` case. One attempt-indexed list subsumes four existing n8n fields, which is why it is
worth proposing upstream rather than keeping as a local extension.

### 2. The carrier, and the one that does not work

Both keys round-trip through a live n8n untouched:

- `workflow.settings.executionPolicy` — the REST DTO's schema is `.passthrough()`, the entity
  column is opaque JSON, the editor's settings modal spreads rather than rebuilds, and
  `Workflow.setSettings` stores it verbatim.
- `node.executionPolicy`, **top level** — the workflow DTO validates only that `nodes` is an
  array, `normalizeNodeShape` is `{...node}`, and the editor's `nodeTransforms.ts` copy loop
  keeps every key except a fixed list and anything beginning with `_`. So the name must not
  start with an underscore.

**`node.parameters.<key>` is not a carrier.** `getNodeParameters` recurses into a
non-`multipleValues` `collection` and rebuilds it from the node type's *declared* options into a
fresh object (`packages/workflow/src/node-helpers.ts`), so an undeclared key inside
`parameters.options` is dropped on the editor's save path and again in the `Workflow`
constructor. That is why `options.maxToolCalls` — the knob the README's known limits and
divergence #25 tell users to declare — has never been settable in a live n8n; it survived only
in `verify/workflow-json.ts`, which parses raw JSON and never calls `getNodeParameters`. It moves
to `node.executionPolicy.maxToolCalls`, with the old read kept as a deprecated fallback so the
verify CLI's fixtures keep working.

**No patch change.** Both keys arrive on the `Workflow` object the existing
`WorkflowScheduler.run(host, workflow, …)` seam already passes, so `patches/n8n/0001` and `0002`
are untouched and `scripts/verify-patch.sh` is the gate that says so.

Forward compatibility is asymmetric on purpose. An unknown `v`, or an unknown key at a known
`v`, is a diagnostic and is ignored — a workflow saved by a newer build must still run on an
older one. A *malformed* value at a known `v` is an error, because it changes the net that runs
and a silently dropped policy is a workflow behaving differently from its declaration.

### 3. The chain is unrolled, not counted

`X/tries` is seeded once by `initialMarking` and consumed by `X_retry_wait`, and **no transition
produces it** (`tests/spikes/failure-policy.test.ts` pins this). n8n evaluates
`getRetryParams(executionData)` per activation, so a node that activates twice — a loop, an
OR-input — gets n8n's full allowance and the net's leftover. The codec re-seeds it on decode, so
a resume restores it in full. Same class as `A/calls` re-seeding (divergence #25).

The chain therefore does not count. It unrolls, so every token it uses is created and consumed
inside one activation:

```text
X_start                    -> X/running_1
X_run_i:  one(X/running_i)
  -> and( xor( <success>, X/failed_i, and(_halt,_budget), waiting, stopped ), X/idle )
     as an Xor sibling when a deadline is declared:
        timeout(timeoutMs, and(X/timedout_i, X/idle))
timeout_i: one(X/timedout_i) inhibitor(_halt)          -> X/failed_i
attempt_i (retry):    one(X/failed_i) one(X/idle) delayed(waitMs_i)
                      inhibitor(_halt) inhibitor(_pause)  -> X/running_{i+1}
attempt_k (route |
           continue): one(X/failed_k)                     -> <the success routing>
attempt_k (stop):     one(X/failed_k)                     -> and(_halt, _budget)
```

This is ADR 0008 §2 in reverse. There, a count invisible to branch enumeration became a path the
graph can see; here, a counter that resets wrongly becomes a chain that is per-activation by
construction. `X/idle + Σ_i X/running_i = 1` stays a findable P-invariant and every `failed_i` is
bounded by 1.

**Attempt 1 reuses `X/running` and keeps the transition name `run`**, so `X_start` is unchanged,
every consumer that addresses a node's run transition by name still finds it, and a policy-free
node compiles byte-identically — which is what lets the whole existing conformance and
verification record stand untouched.

**`retryOnFail` is not reimplemented on top of this.** A node declaring one keeps the historical
gadget; the two are mutually exclusive and `analyse()` rejects a node carrying both rather than
inventing a precedence a workflow author cannot see.

### 4. The deadline is IO-013, and it needs a place of its own

`timeoutMs` arms libpetri's output timeout. IO-013: on expiry the firing is **abandoned** and the
timeout child's tokens are produced instead, and AC5 discards anything the action wrote before
expiry along with the firing. IO-013 is explicit that stopping the abandoned work is "a
capability, not a guarantee" — an implementation that does not own the thread leaves it running,
side effects and all. **The marking is correct either way**, which is why per-node cancellation
in n8n is desirable rather than a prerequisite.

The timeout child is an `Xor` **sibling** of the normal spec (`Xor(And(P1,P2), Timeout(5s,P3))`,
IO-017 AC1), and IO-015 validates by requiring exactly one assignment to explain the produced
set. A child writing `and(failed_i, idle)` would therefore be indistinguishable from the normal
failure branch and *every* failing firing would be ambiguous. Hence `X/timedout_i`, and a funnel
transition into `X/failed_i` — which is also what makes "a timeout is another way this attempt
failed" literally true in the net, so one step answers both and the chain does not double.

**`deadline()` and `window()` are the wrong tool** and are not used. TIME-013 force-*disables* an
overdue transition and emits `TransitionTimedOut`; the tokens stay where they are. That is a
stranding, not a handoff. The whole-execution deadline stays n8n's, for the four reasons ADR 0004
gives.

**The handoff already exists.** `action: 'stop'` deposits `_halt`, n8n persists the execution as
failed, and `settings.errorWorkflow` fires. A timeout escalated to `stop` therefore reaches the
takeover workflow with no new concept, which is why this policy needs no error machinery of its
own.

### 5. Time on resume: n8n owns the clock

libpetri clocks do not resume, deliberately. CORE-073 round-trips each token's `created_at` but
states that restoring "does **not** resume a partially elapsed firing interval"; AC3 requires a
restored `Delayed(d)` to wait its full `d` from the new executor's enablement. Its status is
`Proposed`, the TypeScript snapshot surface is "pending", and the coverage matrix records no test
reference in any language.

We do not need it. A resume compiles a fresh net, so the *compiler* can seed `delayed(remaining)`
from n8n's own persisted `runData` timestamps. Absolute times owned by n8n, relative intervals
derived at compile time — which keeps ADR 0005's "n8n stays the system of record" true and needs
no upstream change. (Not built yet; recorded here because the alternative — asking libpetri to
resume clocks — is the wrong direction and should not be attempted later by someone who has not
read CORE-073.)

### 6. The quiescence rule for every timed policy after this one

The scheduler runs the net to quiescence and stops it only through `close()`. A timed transition
that is *always* enabled therefore never lets `run()` return: a token-bucket refill can fire
whenever the bucket is not full, so the net never quiesces and the workflow hangs — the exact
"stopped workflow that never ends" this work exists to remove. **Every timed policy transition
must be gated on outstanding demand**: a read arc on a place marked only while something is
actually waiting on the resource. `timeout()` does not have this problem, being scoped to one
firing rather than to standing enablement.

### 6a. `onError` declares the port; `onFailure` decides the policy

A node with one main output has one arc, so a `route` step has nowhere to send a failure. The
net has the branch — `X_run`'s `Out` is `xor(success, X/failed_i, …)` — but n8n's graph has no
port to attach it to.

n8n already has the port, and it is declarative: `NodeHelpers.getNodeOutputs` appends the error
output on `node.onError === 'continueErrorOutput'` **alone**, which is exactly why the editor
draws it and a user can wire it. So the two fields divide cleanly and the pair is *allowed* on
one node, where `continueRegularOutput` is not: `onError` is a statement about the node's
**shape**, `onFailure` about its **policy**. A `route` step may then name `'error'`.

**What this adds is a thrown failure on the error arc.** n8n's error output carries *per-item*
errors: `handleNodeErrorOutput` runs on the success path and sorts them out of an otherwise
successful run, while a node that throws is continued down output 0 with its input passed
through, by `handleNodeExecutionError`, identically under both continue modes. Measured on the
`continueErrorOutput` fixture: n8n runs `Trigger, A, B`; `Err` never runs. A chain routes the
same failure — thrown *or* timed out — to the error arc, carrying `{ json: { error } }`.

The routing decision is applied inside `record()`, **before** the task data is written, rather
than by rewriting the outcome afterwards. Recording one thing and routing another would show the
editor a run that did not happen; the first draft of this did exactly that, and the live canvas
showed the item on the Success port while the Error branch ran.

### 7. What is deliberately not in v1

- **Distinguishing a timeout from a thrown error per step** (`on: 'error' | 'timeout'`). It needs
  a second failure place per attempt and a total rule for the trigger a step does not name.
  Both failures take the same step for now, which is what the funnel of §4 encodes.
- **`timeoutMs` without a chain.** An expired attempt would have nowhere to go, so it is rejected
  rather than given an invented default.
- **A `route` target on a node that declares no error output.** The step needs a *connected*
  output, and only `onError: 'continueErrorOutput'` adds one to a single-output node. A node with
  several outputs of its own (an `If`, a `Switch`) can be routed to without it.
- **ν-nets.** Activation lineage is a layer-3 capability, visible at layer 1 only as behaviours
  it enables (a per-item rate limit), never as a setting a user configures. Adopting `matchSpec`
  today forfeits the M5 solver-free route — `verify/state-class.ts` builds `StateClassGraph`
  directly and refuses a `matchSpec` net on purpose, while libpetri's Route B (`nu-scg`,
  VER-012) is reachable only inside `SmtVerifier`, which returns a verdict for one `SmtProperty`
  rather than the class enumeration proper-completion classification needs. The upstream ask is
  in `tasks/todo.md` §4; the migration keeps its own ADR, as ADR 0008 §6 says it must.

## Consequences

**Nothing existing moves.** A policy-free node compiles to the same net, and the suite is
903/903 with the 869 pre-existing cases untouched.

**A new place role, classified once.** `failed` is `retry`'s analogue: pending work, so it is
**not** in `REST_ROLES` — a quiescent marking holding one outside a designed terminal is a
stranding and is reported as one — and it joins `PAUSE_REST_ROLES`, where the codec writes it
back. `tests/verify/state-class.test.ts` pins both halves.

**The policy is part of the structural hash** (`v: 9` → `v: 10`), in its *resolved* form, so two
workflows differing only in it never share a compiled net. ADR 0008's boundary review found the
cost of omitting such a field.

**Every attempt counts as the node running.** `runningPlaces` spans `X/running_i`, so
`no-double-activation` and the mutual-exclusion pass ask about the node rather than about its
first attempt.

**The scheduler runs the chain, and the mapping is exact rather than new machinery.** A `retry`
step *is* `X_retry_wait` with the step's own delay; a terminal step *is* `X_exhausted` with the
outcome the workflow chose. n8n's own `handleNodeExecutionError` is reused rather than
reimplemented, by cloning `executionData` with `node.onError` set to the step's action —
`stop` → `stopWorkflow`, `continue` and `route` → `continueRegularOutput`. n8n reads `onError`
off `executionData.node` (`continuesOnError`), not off the `executionNode` argument, which is
why the clone is on the execution data. `route` then moves n8n's continue payload off output 0
onto the output the step named; it is **not** `continueErrorOutput`'s error item, because
`handleNodeErrorOutput` only ever places that on the appended error output.

Three facts the integration turned up, each of which would have been a silent defect:

1. **`retryOutcome` already advances the attempt counter**, so a step that incremented again
   wrote to the *next* attempt's failure place — a write outside the transition's own `Out`
   spec. The step carries `r.attempt` through unchanged, as `X_retry_wait` does.
2. **`canRetry` defaults to `g.retry !== null`** for every attempt after the first, and a
   chained node has no `X/retry`. Without the chain in that default, attempt 2's failure fell
   through to `record()` and halted the execution under `onError` instead of escalating.
3. **A deadline can abandon attempt 1 before `taskStartedData` exists in the marking.**
   `createTaskStartedData` assigns n8n's `executionIndex` once per *activation*, so the step
   answering the expiry can neither recreate it nor read it off the token. It is kept in a
   `WeakMap` keyed on the run payload — the same object `forwardInput` carries into the timeout
   place, which is what makes the two ends agree.

**The allowance is per activation, and the difference is measurable.** `multiProducer`'s `C` is
fed by two producers, so it activates twice; the script fails twice per activation and succeeds
on the third call. Under `retryOnFail` with `maxTries: 3` the node is called **4** times and the
execution **halts** — the first activation spends both retry tokens, the second has none left
and exhausts on its first failure. Under the equivalent three-attempt chain it is called **6**
times and the execution **completes**, with both activations recorded as successes. That gap is
finding 3 of the Context, priced (`tests/scheduler/failure-policy.test.ts`).

**Cost, measured** (`tests/spikes/failure-policy.test.ts`, a two-output `if` node in a four-node
workflow). `X_run` carries the routing spec, so *k* attempts multiply its flat branches by *k*
and a deadline adds one branch, one place and one transition per attempt:

| shape | run transitions | flat branches | places | transitions |
|---|---:|---:|---:|---:|
| no policy | 1 | 7 | 37 | 15 |
| 2 attempts | 2 | 16 | 40 | 18 |
| 2 attempts + deadline | 2 | 18 | 42 | 20 |
| 3 attempts | 3 | 24 | 42 | 20 |
| 3 attempts + deadline | 3 | 27 | 45 | 23 |
| 5 attempts | 5 | 40 | 46 | 24 |
| 5 attempts + deadline | 5 | 45 | 51 | 29 |

Growth is linear in the attempt count, not exponential, because each attempt gets its *own* run
transition rather than widening one spec. If a deep chain on a wide node proves expensive, the
answer is the one ADR 0004's M6 amendment already reached for outputs: force split routing for
policy-bearing nodes.

**The budget law survives the chain, and libpetri finds it.** On the CLI fixture below the
semiflow the verifier reports is

```
_budget + a/failed_1 + a/failed_2 + a/routed + a/running + a/running_2
        + a/timedout_1 + a/timedout_2 + ... = 1
```

so the two-phase invariant of ADR 0004 still holds with every chain place counted among the
in-flight markers — the unrolled attempts are inside the budget, not beside it. Proper completion
on the same net is **proven**, solver-free, in 12 ms over a complete 91-class graph, which is the
check that the chain strands nothing and that `failed` / `timedout` are classified correctly.

**Measured in a live n8n**, through the editor's own manual-run endpoint, on a workflow whose
two branches call a stub service that fails twice then recovers, and one that never answers
(`scripts/testbed/workflows/failure-policy-showcase.json`):

| leg | outcome | wall | Flaky Service | Hung Service | downstream |
|---|---|---:|---|---|---|
| n8n's own scheduler | **error** | 70 ms | `error` on the first 503 | never reached | neither ran |
| the net, chain declared | **success** | 3,086 ms | `success` after 3 calls (250 ms + 1,000 ms waits) | `error` after 2 × 1,500 ms, abandoned | both ran |

Three things that run proves and no unit test can. The carrier **survives the real stack**: the
policy comes back out of n8n's REST API and database byte-for-byte, having gone in through the
same `POST /rest/workflows` the editor uses. The deadline **ends a hang**: a service that never
answers cost 3 s and a recorded error instead of holding the node until n8n's whole-execution
timeout, and the `continue` terminal let the workflow finish anyway. And **the layering test of
§1 passes**: n8n's own stack scheduler ran the same document without complaint, ignoring a key
it does not know — the workflow stayed meaningful under the other engine, which is the whole
claim layer 1 rests on.

The legacy leg is not "n8n cannot retry" — `retryOnFail` would have recovered that branch. It is
that the *declared policy* is ignored, and that n8n has no per-attempt delay and no per-node
deadline to declare in the first place.

## Evidence

- **End to end through the CLI**, on a four-node workflow whose `if` node declares
  `timeoutMs: 30000` and `[retry 1s, route 'false', stop]`: the export path reads the carrier,
  reports the unreachable third step and the resolved chain as compiler diagnostics, and returns
  `proven` on proper completion and on both budget properties (the semiflow above).
- `typescript/tests/spikes/failure-policy.test.ts` — the four derived facts: nothing produces
  `X/tries`; every chain token has exactly one producer and one consumer inside its attempt; the
  cost table above; and, on the production executor, the deadline arm firing, IO-013 AC5
  discarding a pre-expiry write, and a fast attempt left alone.
- `typescript/tests/compiler/failure-policy.test.ts` — parsing and its asymmetric compatibility
  rules, resolution against the node's outputs, the compiled structure, hash separation, and the
  loud refusal in the scheduler binder.
- `typescript/tests/verify/state-class.test.ts` — the `failed` role in the pause widening and
  out of `REST_ROLES`.
- `scripts/testbed/workflows/failure-policy-showcase.json` plus the stub's `/flaky` and `/hang`
  endpoints — the live legs above, reproducible with
  `scripts/testbed/n8n-testbed.sh --daemon` and
  `node scripts/testbed/run.mjs "Failure Policy Showcase" <out>.json`.
- `typescript/tests/verify/properties.test.ts` — `placeBound(X/failed_i, 1)` per attempt and the
  structural check that the chain is a line, both `proven` without a solver.
- The `failurePolicy` fixture in `ALL`, which puts the chain through the codec's 200-seed
  property round trip and the hand-derived structural counts.
- `typescript/tests/scheduler/failure-policy.test.ts` — the chain through `FakeHost`, the mirror
  of `WorkflowExecute` at `441970b`: the `retryOnFail` twin (one `nodeExecuteBefore`, one
  `createTaskStartedData`, one recorded run), a different delay per attempt, all three
  terminals, the deadline abandoning an overrun and recording nothing for the late completion,
  the 4-vs-6 per-activation comparison above, and the equivalence: a uniform chain records
  **identical** `runData` to `retryOnFail` on both the recovering and the never-recovering
  script (the differ's own `comparableTask` projection).
- `scripts/testbed/workflows/resilient-fan-out.json` and `scripts/testbed/record-demo.sh` — four
  branches, two of them carrying a policy, run in the real editor: **5,123 ms at k = 4 against
  12,654 ms at k = 1**, every branch starting within 2 ms, and the same document **failing in
  3,106 ms** under n8n's own loop. `docs/testbed.md` has the timeline and the video.
