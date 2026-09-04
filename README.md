# n8n-libpetri

**n8n-libpetri replaces n8n's intra-workflow scheduler with a Coloured Time Petri Net
engine built on [libpetri](https://github.com/debe/libpetri).** n8n keeps its editor,
workflow JSON, credentials, node ecosystem, persistence, webhooks, hooks and queue mode.
Only the ~490-line `executionLoop` inside `WorkflowExecute.processRunExecutionData()` is
replaced: the loop that pops `nodeExecutionStack`, calls `runNode()`, and hand-manages
`waitingExecution` for multi-input joins. There is no n8n source fork; n8n is cloned at a
pinned commit into a gitignored `.n8n/` and carries two rebasable patches.

This README is the single source of architectural truth. Read it before structural changes.

## Why

1. **Real concurrency.** n8n completes one branch before starting the next. Two independent
   500 ms HTTP calls take ~1 s. Under a net both transitions are enabled at once.
2. **Analysability.** Once a workflow *is* a net, libpetri's `SmtVerifier` (Z3/Spacer
   IC3-PDR) proves proper completion, bounds, exclusion and unreachability before activation,
   and hands back counterexamples that are literal node paths through the same semantics
   production runs.

## Principles

1. **No null output spec, no `skipOutputValidation`.** Every transition declares a real
   `Out` spec the executor validates and the verifier reads. One net serves execution and
   verification. The only null-spec transitions are genuine sinks (libpetri CORE-043 AC4).
2. **The net decides what runs.** Enablement, priority, inhibitors, read arcs, timed
   transitions and ν-minting determine firing. No host-side dispatch queue, permit gating or
   scheduler policy object. Retries, mutexes, concurrency limits and halts are places and arcs.
3. **n8n's legacy behaviour is a candidate for abandonment, not a requirement.** Where n8n
   encodes an artifact we model the correct semantics and record the divergence in
   [`docs/divergences.md`](docs/divergences.md).

The philosophy in one line: the net expresses flow, which can be proven; enablement
describes; it is resource-consumption based; you run when you have everything.

## The model — one net per execution

### Emission rule

An **empty token** asserts "this edge carries nothing for this activation of the producer".
The assertion is only meaningful when the producer cannot be re-activated by its own output,
so after an SCC decomposition of the main-connection graph:

| Edge | Producer fires with data (`X_run`) | Producer skipped (`X_skip`) |
|---|---|---|
| tree edge, producer not in a cycle | `data \| empty` | `empty` |
| tree edge, producer in a cycle | `data \| nil` | `empty` |
| cycle edge (both ends in one SCC) | `data \| nil` | nothing |

`nil` is a per-output local place consumed by a genuine sink transition. This one rule covers
IF/Switch/Filter (routing items, empty is a fact), Loop Over Items (`done` is "not yet" on
intermediate firings), arbitrary user cycles (no empty storms) and skipping a whole loop
(empty flows past it on the exit edge). It is what makes an AND-join always complete in the
acyclic case, which removes the cause of n8n's stuck-join fallback rather than the symptom.

### Per-node gadget

Each n8n node compiles to a libpetri `SubnetDef` instantiated at prefix `node.id`:

```
X_start: one(X/in) one(_budget) one(X/idle) inhibitor(_halt) [read(Y/done) per $('Y')]
         → outPlace(X/running)                                priority = depth(X)
X_run:   one(X/running)
         → xor( and( per output i: xor(and(data edges_i), and(empty|nil edges_i)),
                     outPlace(_budget), outPlace(X/idle), outPlace(X/done) ),
                and( outPlace(X/retry), outPlace(_budget), outPlace(X/idle) ),   [retryOnFail]
                and( outPlace(_halt),   outPlace(_budget), outPlace(X/idle) ) )  [stopWorkflow]
         action: host.runNode(...) + route                     priority = depth(X) + 1
X_skip:  one(X/in_empty) → and(empty edges per rule, outPlace(X/skipped))
```

- The two-phase start/run is textbook duration modelling. It makes `budget + Σ running = k`
  a real P-semiflow and `mutualExclusion(A/running, B/running)` provable, with an explicit
  `X/idle` mutex instead of reliance on an executor implementation detail.
- The budget refund is the action's job on every `xor` branch; the action never throws
  (libpetri EXEC-030: a rejected action loses its consumed tokens).
- Priority = DAG depth gives n8n's documented v1 depth-first completion at k = 1;
  declaration order = canvas order gives sibling order.
- `X/done` and `X/skipped` are markers. Read arcs on `Y/done` make `$('Y')` expression
  dependencies explicit; an unmet one is a stranded token the verifier catches statically.
- `IRunExecutionData` is written exactly as n8n writes it, so `WorkflowDataProxy`, `$node`,
  `$json` and `pairedItem` keep working untouched.

### Join gadget (k ≥ 2 inputs, or an input with several producers)

```
per input i:  X/free_i (1 token)
per edge e into input i:
  arm_e_data:  one(e/data)  one(X/free_i) → and(outPlace(X/ready_i), outPlace(X/hasdata))
  arm_e_empty: one(e/empty) one(X/free_i) → outPlace(X/ready_i)
X_start: one(X/ready_0)…one(X/ready_k-1) all(X/hasdata) one(_budget) one(X/idle) inhibitor(_halt)
         → and(outPlace(X/running), outPlace(X/free_*))
X_skip:  one(X/ready_0)…one(X/ready_k-1) inhibitor(X/hasdata) → and(empty edges…, outPlace(X/free_*))
```

`all()` requires at least one token, so "at least one non-empty input" is structural and
start/skip are mutually exclusive without priority. `free_i` serialises slots so a second
arrival waits until the current slot is consumed, matching n8n's first-free-slot allocator.
Merge chooseBranch (all inputs required, always 2) enumerates its four combinations.

### Retries, halt, cancellation

- `retryOnFail`: `X/tries` seeded with `maxTries − 1`; `X_retry_wait` is a `delayed()`
  transition consuming one try; `X_exhausted` fires under `inhibitor(X/tries)`. The net
  decides retry-vs-exhaust; the verifier proves at most `maxTries` attempts.
- A fatal node error deposits `_halt`. Every start inhibits on it, in-flight actions finish,
  and `_halt_reap` clears the net with reset arcs so a halted run quiesces cleanly.
- Cancellation is `executor.close()`; the workflow timeout stays n8n's own poll plus `close()`.

### Concurrency budget and its safety condition

`_budget` holds k unit tokens: k = 1 is sequential n8n, larger k is parallel. Positional
pairing is sound above k = 1 only if every node fires at most once per execution, which the
compiler checks (acyclic, and every input index has at most one producer). Otherwise k = 1.
Lifting that is the genuine use of ν-lineage names and is deferred.

### Marking codec

n8n stays the system of record. On a Wait node the marking is serialised into
`nodeExecutionStack` and `waitingExecution` in n8n's own shape (empty tokens as `[]`,
not-arrived as `null`); on start the marking is rebuilt from a non-empty stack. Join inputs
fed only by nodes unreachable from the start node are seeded with an empty token.

## Layout

```
typescript/   one npm package, multi-entry: ".", "./compiler", "./verify", "./conformance"
patches/n8n/  0001-extract-scheduler-loop, 0002-scheduler-registry (rebasable, upstream quality)
scripts/      bootstrap-n8n.sh, run-conformance.sh, verify-patch.sh
docs/         adr/, divergences.md, assets/, diagrams/
spec/         n8n concept → libpetri requirement mapping
```

## Status

Milestone M0 (scaffold). See [`tasks/todo.md`](tasks/todo.md) and [`CHANGELOG.md`](CHANGELOG.md).

## License

Apache-2.0. n8n itself is under the Sustainable Use License and is never committed here.
