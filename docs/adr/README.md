# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-net-native-model.md) | One net, net-native modelling | accepted |
| [0002](0002-emission-rule.md) | The emission rule: explicit empty tokens, `nil` on cycles | accepted |
| [0003](0003-join-gadget.md) | The join gadget and the `requiredInputs` mapping | accepted (amended 2026-09-05: the arm form for single-input OR nodes) |
| [0004](0004-two-phase-budget.md) | Two-phase start/run, the routed outcome, and the concurrency budget | accepted (amended M4: the refund moved to `X_done`; amended M6: routing collapsed into `X_run`, `X/ok` and the halt reap deleted, `SPLIT_ROUTING_ABOVE` back to 3) |
| [0005](0005-marking-codec.md) | The marking codec and Wait-node resume | accepted (amended M2 with the landed mapping) |
| [0006](0006-concurrency.md) | Payload safety and the k > 1 semantics | accepted |
| [0007](0007-verification.md) | The verification surface: what the property table proves, and what it cannot | accepted (amended M5: the state-class graph is the primary route, z3 the fallback) |
| [0008](0008-agent-tool-dispatch.md) | Agent tool dispatch: the round is a marking | accepted |
| [0009](0009-execution-policy.md) | Execution policy in workflow JSON: the attempt chain | accepted (compiler, carrier and scheduler built; codec and the per-attempt bound remain) |
| [0010](0010-bounds-at-the-entry.md) | Bounds at the entry, not a global concurrency counter | **proposed** — nothing built; would supersede the budget half of 0004 and the k-safety half of 0006 |
| [0011](0011-composition-theorem.md) | The composition theorem: per-gadget contracts to a whole-workflow claim | **proposed** — proof sketch, not mechanised; measured to cover 40.5% of the template corpus |
| [0012](0012-engine-v2-target.md) | Engine v2 as a second target: model first, seam second | **proposed**: nothing built; plan for n8n's `packages/@n8n/engine` |

Each ADR has Context / Decision / Consequences / Evidence; Evidence names the spike under
`typescript/tests/spikes/` that pins the behaviour it rests on.

ADRs are records of the moment they were decided. Line numbers they cite in n8n files refer
to the commit they name (0001-0011: master `441970b`), not to the current pin
(`scripts/n8n-pin.sh`). Moving to `n8n@2.41.3` shifted `workflow-execute.ts` by four lines
from its prelude onwards. The extracted loop, `stack-scheduler.ts`, did not change.

0001–0009 are accepted and none is superseded; 0003, 0004, 0005 and 0007 carry amendments
recorded in
the ADR itself rather than as a new record. 0010 and 0011 are the **proposed** pair, and they
are read together: 0010 removes the global `_budget` counter so that gadgets share only edge
places and two monotone markers, and 0011 is the theorem that turns per-gadget proofs into a
whole-workflow claim — which is much harder while a shared counter remains, because a gadget's
contract then silently assumes a unit is free for it. 0011 is measured to cover 40.5% of the
template corpus as scoped; cycles and agents are the two extensions worth more than the core.
0010 argues
for deleting the global `_budget` place in favour of an admission bound at the entry, a
declared bound per loop and an optional author-placed throttle, and it would supersede the
concurrency-budget half of 0004 and the k-safety half of 0006 once built. Until then those two
stand as written. 0007's M5 amendment inverts the routes (§9-§12):
libpetri's state-class graph (VER-010) decides proper completion and the other reachability
families, the `SmtVerifier` is the fallback for a truncated graph, and a fourth verdict,
`bounded`, reports what a cyclic workflow's explored prefix does establish.

For what the decisions add up to — what exists, what it is measured to do and what it
deliberately does not — see
[`../state-of-the-project.md`](../state-of-the-project.md).
