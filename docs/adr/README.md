# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-net-native-model.md) | One net, net-native modelling | accepted |
| [0002](0002-emission-rule.md) | The emission rule: explicit empty tokens, `nil` on cycles | accepted |
| [0003](0003-join-gadget.md) | The join gadget and the `requiredInputs` mapping | accepted |
| [0004](0004-two-phase-budget.md) | Two-phase start/run, the routed outcome, and the concurrency budget | accepted (amends README `X_run` shape) |
| [0005](0005-marking-codec.md) | The marking codec and Wait-node resume | accepted (amended M2 with the landed mapping) |
| [0006](0006-concurrency.md) | Payload safety and the k > 1 semantics | accepted |

Each ADR has Context / Decision / Consequences / Evidence; Evidence names the spike under
`typescript/tests/spikes/` that pins the behaviour it rests on.
