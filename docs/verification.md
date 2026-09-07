# Verification

The verifier analyses the same compiled net that `PetriScheduler` executes. There is no
simplified verification model. A result therefore describes the scheduler's control-flow
semantics, subject to the abstraction limits below.

The primary engine is libpetri's state-class graph. It enumerates reachable marking classes
once and answers all reachability-safety queries from that graph. If the graph truncates,
the verifier can send undecided queries to libpetri's `SmtVerifier`, which uses Z3/Spacer.

## CLI

```bash
cd typescript
npm run build
npx n8n-libpetri verify ../workflow.json
```

Useful forms:

```bash
# One property and a concurrency budget
npx n8n-libpetri verify ../workflow.json \
  --budget 2 \
  --property proper-completion

# Require proofs in CI
npx n8n-libpetri verify ../workflow.json --strict --json --out verification.json

# Check one exclusion pair
npx n8n-libpetri verify ../workflow.json --mutex FetchA,FetchB

# Bound or disable the state graph and control the SMT fallback
npx n8n-libpetri verify ../workflow.json \
  --max-classes 50000 \
  --smt-fallback auto \
  --timeout 30000
```

Options:

| Option | Meaning |
|---|---|
| `--budget k` | Requested concurrency budget. The compiler may lower it for unsafe shapes. |
| `--property NAME` | Select a property family. Repeatable. |
| `--max-classes n` | State-class cap. Default 200,000; zero disables graph exploration. |
| `--smt-fallback auto\|off\|force` | Control the SMT route. Default `auto`. |
| `--timeout ms` | Per-query SMT timeout. Default 60,000 ms. |
| `--node-types FILE` | Supply exact node input/output shapes. |
| `--start NODE` | Override the inferred start node. |
| `--mutex A,B` | Check one mutual-exclusion pair. Repeatable. |
| `--all-pairs` | Check all node pairs. This creates O(n²) queries. |
| `--no-semiflows` | Disable P-semiflow strengthening. |
| `--strict` | Fail if any result is `bounded` or `unknown`. |
| `--json` | Emit JSON. |
| `--out FILE` | Write the report to a file. |
| `--quiet` | Do not stream checks as they finish. |

Without `--node-types`, the workflow JSON adapter guesses port counts for unknown node
types. The warnings are part of the report because a guessed shape changes the net being
verified. Use an exact node-type file for a result that matters.

## Verdicts

| Verdict | Claim |
|---|---|
| `proven` | The property holds for all markings in a complete analysis. |
| `violated` | A reachable counterexample exists. |
| `bounded` | The property holds for the exact cyclic-run prefix reported. This is not a proof. |
| `unknown` | Neither route decided the property. |

`bounded` exists because productive cycles have an infinite reachability graph. The report
states how many executions of cyclic nodes the explored prefix covers. Raising the state cap
extends that prefix; it does not turn bounded exploration into a general liveness proof.

Exit codes are the CI contract:

| Code | Meaning |
|---:|---|
| 0 | No violation. `bounded` and `unknown` are accepted unless `--strict` is set. |
| 1 | A violation, or any non-proof under `--strict`. |
| 2 | Bad arguments, unreadable input or malformed JSON. |
| 3 | No usable Z3 installation, so the requested fallback did not run. |

A finding outranks a missing solver. If the graph finds a violation and Z3 is unavailable,
the process exits 1.

## Properties

### `proper-completion`

Checks that no reachable quiescent marking contains unfinished workflow work. Halted and
paused markings are valid terminal states because the codec preserves their pending
activations for retry or resume.

The graph checks the whole net and records stranded join inputs and edge tokens. On a
violation, the counterexample is the firing sequence that reaches the terminal marking,
decoded to node names. The SMT fallback asks a whole-net deadlock-freedom query after
classifying structural sinks.

This property catches workflow deadlocks in the model: joins waiting for combinations of
tokens that can no longer arrive, unmet control-flow dependencies and other quiescent
markings with pending work. It does not prove that a productive cycle terminates.

### `dead-nodes`

Checks whether `X/running` is unreachable for each node. An unreachable node is a finding.
A reachable witness does not prove liveness under all executions, so the report states the positive
direction conservatively rather than promoting it to a liveness claim.

### `no-double-activation`

Checks that `X/running` never contains two tokens. This verifies the per-node `idle` mutex
against the compiled workflow, not merely against the intended subnet template.

### `budget`

Checks that `_budget` never exceeds the initial budget and validates the two-phase resource
law:

```text
_budget + running + retry + in-flight routing = k
```

The P-semiflow is important here. Reachability alone can show an overflow counterexample;
the invariant explains why an overflow is impossible.

### `retry-bound`

Checks the initial bound of `X/tries` and the structural condition that no transition
produces new try tokens. Both parts are required. A bounded place means little if the model
can refill it through an omitted path.

### `mutual-exclusion`

Checks that two named nodes are never running together. Use repeated `--mutex A,B` arguments
for selected resources. `--all-pairs` is useful on small nets and expensive on large ones.

## State-class graph

The graph performs breadth-first exploration over marking classes. When it closes, the set
of reachable markings is complete for the compiled abstraction. Safety properties decided
from that graph are proofs, and violations include a shortest discovered firing path.

The graph ignores transition priority. That creates a superset of scheduler behaviour:
lower-priority transitions may appear earlier than the executor would choose them. For
safety proofs this is conservative. A property proved over the larger set also holds for the
priority-respecting execution. Validate a counterexample against the executor when priority matters.

State-space cost depends more on shape than node count:

- A chain has few interleavings.
- Independent branches create combinations of markings.
- Productive cycles create an infinite graph.
- Higher budgets expose more concurrent interleavings.

The graph never converts truncation into `proven`. Violations already found remain valid;
undecided checks continue through the fallback or return `bounded`/`unknown`.

## SMT fallback

The fallback runs only for queries the graph did not decide. `auto` refuses known-dangerous
net shapes above either of these limits:

- 12 join inputs
- 450 flat places

The limit protects the process from libpetri's pre-solver expansion, which can exhaust the
V8 heap before Z3 gets a query. `--smt-fallback force` bypasses the refusal and can still
abort the process. It is an escape hatch, not a capacity increase.

`--smt-fallback off` is useful when a graph-only result is required. If Z3 cannot be found,
the report explains the resolution failure through `PATH` and `LIBPETRI_Z3` rather than
throwing.

The whole-net proper-completion fallback is currently weak on the measured fixtures. The
state graph is both faster and more useful when it closes. SMT remains valuable for
invariants and selected reachability queries after graph truncation.

## Current measurements

Recorded on the repository's verifier measurement harness:

| Workflow | Result | State classes | Approximate time |
|---|---|---:|---:|
| Diamond | Proven | 330 | 8 ms |
| 41-node chain | Proven | 1,967 | 110 ms |
| `ifBothOutputs` | Violated | Counterexample found | 15 ms |
| 21-node five-diamond | Proven at k=1 | Complete | About 2 s |
| 49-node parallel shape | Unknown | Truncated | Shape exceeds practical graph budget |

Cyclic prefix coverage at the default 200,000-state cap:

| Workflow | Cyclic node runs | Completed passes |
|---|---:|---:|
| `loopOverItems` | 21 | 10 |
| `userCycle` | 138 | 69 |

Timing varies by machine. The verdict and explored-class count are the useful parts.

Reproduce the measurements with:

```bash
cd typescript
npx tsx tests/verify/measure-graph.ts
npx tsx tests/verify/measure-graph.ts --smt --timeout 30000
npx tsx tests/verify/measure.ts --timeout 30000
npx vitest run tests/verify
```

## What is not proved

The abstraction is priority-blind and value-blind. A node firing is atomic. The verifier
does not prove:

- output values or item-level predicates;
- total execution order;
- wall-clock deadlines or latency;
- fairness or eventual termination of productive cycles;
- properties of an arbitrary resumed marking;
- behaviour outside the supplied node shapes and workflow graph.

Every report starts from the fresh initial marking. Resume and retry execution begin from a
codec-decoded marking, which is a separate verification problem.

The relevant design decisions are recorded in
[`adr/0007-verification.md`](adr/0007-verification.md). Requirement identifiers and test
coverage are in [`../spec/`](../spec/).
