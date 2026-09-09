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
decoded to node names. The SMT fallback asks one whole-net deadlock-freedom query with the
structural rest set as sinks, the pause / halt widenings as conditional sinks (libpetri
VER-014), and the state equation on (VER-016) — the graph's own classification as a property.

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

The whole-net proper-completion fallback decides real cases since 2026-09-08 (ADR 0007 §13):
with the widenings declared it asks the graph's question, and with the state equation on it
proves the two-tool agent at `maxToolCalls` 64 in seconds where it was `unknown` at 120 s. The
state graph is still faster where it closes, and it is what decides a truncated cyclic graph's
`bounded` verdict; the fallback is what closes a truncated acyclic one.

## Current measurements

Recorded on the repository's verifier measurement harness:

| Workflow | Result | State classes | Approximate time |
|---|---|---:|---:|
| Diamond | Proven | 306 | 21 ms |
| 41-node chain | Proven | 1,967 | 150 ms |
| `ifBothOutputs` | Violated | Counterexample found | 42 ms |
| 21-node five-diamond | Proven at k=1 | Complete | About 2 s |
| 49-node parallel shape | Unknown | Truncated | Shape exceeds practical graph budget |
| `agentOneTool` (`maxToolCalls` 4) | Proven | 1,466 | 16 ms |
| `agentTwoTools` (`maxToolCalls` 4) | Proven | 6,315 | 101 ms |

State-class counts are under libpetri's canonical state-class key (2026-09-08); the earlier
figures — `diamond` 330, `agentOneTool` 1,730, `agentTwoTools` 7,968 — counted one marking once
per clock order. The SMT fallback on the same fixtures, asked as the graph's own question with
the state equation on (30 s budget): proven on `linear`, `fanOut`, `multiProducer`,
`chooseBranch`, `wide8`, `agentOneTool` (0.6 s), `agentTwoTools` (1.5 s) and — the case the
graph can only bound — `loopOverItems` in 0.5 s. Unknown at that budget on `diamond`, `chain40`
and `switch20`, and those are not the same kind of unknown. `diamond` is a clock limit: it
proves in 35.5 s once the budget allows it, which is why a 30 s column reports it as undecided.
`chain40` is the same thing on a longer clock: it proves in **410 s**, and a join-free chain
proves at every length measured — 5.7 s at 12 nodes, 15.3 s at 18, 62.7 s at 20, 77.6 s at 24,
171.7 s at 32, 410.1 s at 40 — so the cost climbs steeply with length (roughly the cube of it)
but no length yet measured defeats the proof. `switch20`, the widest fixture here at 22 nodes
and 238 places, proves in **277.5 s**.

So every `unknown` in that column is a clock limit. On the fixtures measured here the proof
direction has no shape it cannot decide, only shapes it needs minutes for — which is a
statement about the default budget, not about the encoding, and it is the opposite of what this
document said before the measurement. What stays genuinely weak is the other direction: on
`ifBothOutputs`, `unbalancedJoin` and `cyclicStranding`, all of which do strand, no witness
comes back at any budget tried, with or without the state equation. Proof is cheapened by more
seconds; witness search is not.

**Vary the timeout before reading anything into an `unknown`.** The verdict conflates "no proof
exists in this encoding" with "the proof needed more seconds than it was given", and only the
measurement separates them. This bit twice while the table above was being written: `diamond`
was recorded as a capability limit when it needed 35.5 s against a 30 s budget, and a sweep at
60 s put a "wall" at 20 chain nodes that a 300 s budget walked straight through. Both were the
same mistake, and the second was made after the first had been written down. Unknown too on the genuinely violated `ifBothOutputs`, `unbalancedJoin`
and `cyclicStranding` — and there no witness comes back at all, at any budget tried, with or
without the state equation. Proof is the strong direction of this query; witness search is the
weak one, and that is a libpetri capability gap rather than a budget.

An agent workflow proves, and the reason is worth stating because the shape looks like one that
cannot. Its round loop — `A/queue → A/dispatched → A/running → A/queue` — is a cycle, and a cycle
is what leaves `loopOverItems` at `bounded` on the graph route however large the cap (the SMT
fallback proves that fixture since 2026-09-08, ADR 0007 §13). This one closes on the graph because
neither of its two counts is open-ended, and both are budgets that nothing refunds:

- **`A/rounds`**, seeded from the agent's own `options.maxIterations`, consumed by `A_resume`.
  The bound comes out of the workflow JSON, where n8n already keeps it as a counter its node
  checks in an `if`; making it a place is what moves it into reach of the verifier (ADR 0008).
- **`A/calls`**, the tool-call budget, consumed one unit per `A_dispatch`. n8n has no such bound.
  It is the scheduler's, and it exists for the verifier: see "What an agent verdict covers".

Both are hard, and both halves of that are measured rather than argued. Nothing in the compiled
net produces either place (`tests/compiler/agent.test.ts` enumerates every output branch), so
each is monotonically decreasing; and the class count scales with each of them, so they are what
close the graph. Remove either and nothing else holds the exploration finite.

### What an agent verdict covers

A `proven` on an agent workflow covers **every round size up to the agent's tool-call budget**,
and the reason that has to be said is that the first shape did not.

[IO-015] output validation compares the produced place *names* — `enumerateBranches` returns
`ReadonlySet<Place>` — so an `Out` branch says *which* places a firing writes and never *how many*
tokens it writes to them. The first shape opened a round by depositing one `A/pending` unit per
requested call. The state-class graph enumerates the same branches, and a branch naming
`A/pending` once deposits one token: measured, the graph peaked at **one** call in flight where
the executor reaches `n`. Proper completion is a safety property, so exploring *fewer* reachable
markings is the direction that can return a false `proven`. The verdict was narrower than it
looked, and `tests/compiler/agent.test.ts` pinned the limit until it was gone.

The fix turns the count into a **path**. `A_dispatch` consumes one unit of `A/calls` per firing,
so "how many tool calls" is "how many times dispatch fired" — a sequence of firings, which
enumeration sees. Measured on `agentTwoTools`, `peak(A/outstanding)` equals the budget at every
budget tested; the graph explores a round with every tool in flight at once, which is the
executor's case and the one the feature exists for. Nothing refunds `A/calls`, and that is
load-bearing: refund it at the join — NU-040's idiom — and a round can dispatch without bound,
`T/done` accumulates, and the graph truncates (`tests/spikes/agent-round.test.ts`). This is the
budget place from the ν-net spec, *"the decidability lever"*, without ν-names: one round is live
per agent, which is the case `nu-nets.md` §6 says plain structure covers.

**What it costs, and why the default is not what the fixtures declare.** Not `m^K`: the graph
is keyed on markings, and two dispatch sequences of the same tools reach one marking. The state
space is a product of independent counters — `A/calls`, `A/outstanding`, `A/response`, and
`T/in_tool` and `T/done` per tool, each 0…K — so it grows polynomially, about K^3.3 in the
budget (the ratios per step fall: 7.1, 4.3, 3.1 in K) and between m^2.1 at K = 4 and m^3.6 at
K = 8 in the tool count. On the real net, under libpetri's canonical state-class key
(2026-09-08):

| Agent | K = 2 | K = 4 | K = 6 | K = 8 |
|---|---:|---:|---:|---:|
| one tool | 466 | 1,466 | 3,490 | 6,922 |
| two tools | 891 | 6,315 | 27,351 | 85,935 |

A four-tool agent truncates at K = 8. The runtime default, `DEFAULT_MAX_AGENT_TOOL_CALLS`, is
**64** — sized so no ordinary agent trips a cap it never asked for, and far too wide for a graph.
So an agent that declares nothing verifies as **truncated**, cause `tool-calls`, and the report
names the agent, its budget, that the number was the scheduler's default, and the knob: declare a
small `options.maxToolCalls`. A declared budget is at once the runtime cap the workflow chose and
the width of the claim its `proven` makes — one net, one number, and the compiler marks an
assumed one (`toolCallsAssumed`) so the verifier never reports a bound it invented. The fixtures
declare 4.

A per-round budget — refilled between rounds, one unit per firing, gated on no round being open
— was built and measured too. It closes, and it is the semantics a user might expect ("calls per
turn"), but it costs about ten times more for the same K, because verification cost tracks the
*total* dispatches explored and per-round makes that K × rounds. Recorded in ADR 0008.

**What the SMT route does with an agent, since it is the route one would rather prove with.**
The safety families are K-independent there and fast: at the runtime default budget of 64 on
`agentTwoTools`, `budget` proves in 0.2 s and all-pairs `mutual-exclusion` in 1.8 s via IC3.
Proper completion does not decide via SMT on this net — nor on `diamond`, nor on any n8n net
with a join behind a work node — and the reasons are two, both measured and both recorded in
`tasks/todo.md` under libpetri:

- `deadlockFree(sinks)` is "quiescent ∧ a token outside the sinks". Every n8n node can halt or
  pause, so a halt while a sibling's arrival is pending is a *real* reachable marking with a
  non-rest token, and the solver finds it — `fanOut` in 1.8 s, the agent at K = 64 in 20 s with
  the counterexample confirmed by replay. It is right about the question as asked; the graph
  route decides the same question by widening the rest set under a terminal marker, which no
  libpetri property expresses.
- Where no such witness exists and the answer is `proven`, Spacer stops converging at one
  pipeline stage before a join: `T → IF → Merge` proves a genuinely unreachable target in
  0.1 s, and the same target with one `set` node on each branch is `unknown` at 60 s and at
  300 s. Not the join's `all()` arc, not the invariant set (libpetri's basis spans the exact
  nullity at every depth), not interleaving, not any of twenty Spacer option sets, not
  `m'_i ≥ 0` — each ruled out by experiment. The root cause, found 2026-09-08: the proof needs
  linear *inequality* invariants — "the start node holds at most one token" and, along every
  edge, "the parent's emissions bound the child's tokens" — and libpetri conjoins only
  equalities (`y·C = 0`) into its Horn rules. Six such lemmas, generated from the workflow's
  edges and checked by sign against every flat incidence column, prove the depth-1 target in
  0.1 s and eight prove depth 2 in 0.2 s (`typescript/tests/upstream/inequality-lemmas.ts`).
  Fixed upstream the same day: a structural linear state-equation bound (VER-015) proves the
  cliff net at every depth in 0.0 s before Spacer runs, and the state equation with firing
  counters (VER-016, `stateEquation(true)`) puts the ordering laws into every rule body for the
  proofs Spacer still has to do itself — which is what lets the quiescence fallback prove the
  agent net.

Two things still inflate that count, both recorded in `tasks/todo.md`. The `done` markers of
the two tools — history that only a `$('X')` read arc ever reads, and nothing here reads —
multiply the distinct markings by 3 (27,351 with them, 9,033 without, at K = 6); the compiler
knows which nodes are referenced, so the verifier could drop the rest from the key. And the
per-tool counters are interchangeable, which is what Route B's permutation-symmetry quotient
would collapse — applied to subnet instances rather than ν-names. A third is gone: until
2026-09-08 libpetri's state-class key included the *order* in which clocks were added, so on an
untimed net one marking was counted once per enabling history — 41,697 classes over 27,351
markings at K = 6, 1.5× — and the fixtures paid 1.00–1.08×. The key is now canonical (clocks
ordered by transition name, the full DBM matrix as the key), measured here at 1.00× on every
fixture: `typescript/tests/upstream/class-key-duplicates.ts`.

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

Value-blindness has one consequence sharp enough to name, because it turns into a **false
`violated`** rather than a missing proof. When two agents share one tool, the tool's success
branch is an `xor` over its agents' `A/response` places and the scheduler picks the agent the
dispatch token names — correct at run time, and the routing is asserted rather than assumed
(`scheduler/actions.ts`, `succeed`). The state-class graph cannot read that token, so it
explores the arm where the response lands on the *other* agent, and that arm strands the
dispatcher: proper completion on `agentSharedTool` reports `violated`, quiescing on
`A1/dispatched` + `A1/outstanding` with an uncollected `A2/response`. The workflow is fine and
the run is fine; the counterexample is an artifact of the abstraction (VER-004), of exactly the
kind ADR 0007 §7 says a witness may be. It is the one shape where that caveat costs a user a
red report instead of a weaker verdict, so treat a proper-completion violation on a shared tool
as unproven, not as a defect. `tasks/todo.md` carries the fix: compile the tool's start / run /
success chain once per dispatching agent, which makes the routing structural and the
abstraction exact.

Every report starts from the fresh initial marking. Resume and retry execution begin from a
codec-decoded marking, which is a separate verification problem.

The relevant design decisions are recorded in
[`adr/0007-verification.md`](adr/0007-verification.md). Requirement identifiers and test
coverage are in [`../spec/`](../spec/).
