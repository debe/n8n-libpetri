# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-net-native-model.md) | One net, net-native modelling | accepted |
| [0002](0002-emission-rule.md) | The emission rule: explicit empty tokens, `nil` on cycles | accepted |
| [0003](0003-join-gadget.md) | The join gadget and the `requiredInputs` mapping | accepted |
| [0004](0004-two-phase-budget.md) | Two-phase start/run, the routed outcome, and the concurrency budget | accepted (amended M4: the refund moved to `X_done`) |
| [0005](0005-marking-codec.md) | The marking codec and Wait-node resume | accepted (amended M2 with the landed mapping) |
| [0006](0006-concurrency.md) | Payload safety and the k > 1 semantics | accepted |
| [0007](0007-verification.md) | The verification surface: what the property table proves, and what it cannot | accepted (amended M5: the state-class graph is the primary route, z3 the fallback) |

Each ADR has Context / Decision / Consequences / Evidence; Evidence names the spike under
`typescript/tests/spikes/` that pins the behaviour it rests on.

All seven are accepted and none is superseded; 0004, 0005 and 0007 carry amendments recorded in
the ADR itself rather than as a new record. 0007's M5 amendment inverts the routes (§9-§12):
libpetri's state-class graph (VER-010) decides proper completion and the other reachability
families, the `SmtVerifier` is the fallback for a truncated graph, and a fourth verdict,
`bounded`, reports what a cyclic workflow's explored prefix does establish.

For what the decisions add up to — what exists, what it is measured to do and what it
deliberately does not — see
[`../state-of-the-project.md`](../state-of-the-project.md).
