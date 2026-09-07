# Requirement mapping

This table maps n8n execution concepts at commit `441970b` to the libpetri primitives and
requirements used by the implementation. It is a traceability index, not a second
architecture document.

| n8n concept | Net representation | libpetri requirements |
|---|---|---|
| Connection | Per-edge `data` and `empty` places; cyclic omissions use local `nil` | CORE-030, IO-010 |
| Node readiness | Transition enablement | IO-005, EXEC-003 |
| Node execution | Action bound to `X_run` | CONC-002, EXEC-020, IO-015 |
| IF and Switch routing | `and` of per-output `xor`; wide outputs split before flattening | IO-011, IO-012, IO-016 |
| Multi-input node | Join subnet with per-input `free`, `ready` and `hasdata` places | IO-003, CORE-033, EXEC-010 |
| `waitingExecution` | Tokens on edge and join-ready places, encoded back to run state | EXEC-041 |
| v1 depth-first order | Transition priority from DAG depth, declaration order from canvas order | EXEC-002, CONC-023 |
| `retryOnFail` | Delayed retry transition and finite `tries` place | TIME-004, TIME-011 |
| Fatal `stopWorkflow` error | Terminal `_halt` place and inhibitors on further control flow | CORE-031, CORE-034, EXEC-013 |
| Cancellation | Executor `close()`; already-started actions may finish | ENV-013, EXEC-040 |
| Concurrency limit | Shared `_budget` place and two-phase P-semiflow | EXEC-003, VER-007 |
| `$('X')` dependency | Read arc on `X/done` when the reference is structurally upstream | CORE-032, EXEC-012 |
| Wait and resume | `_pause` plus marking codec to and from `IRunExecutionData` | EXEC-041 |
| Proper completion | Complete state-class graph; SMT `deadlockFree` fallback | VER-002, VER-010 |
| Composition | One `SubnetDef` per node with shared execution places | MOD-010, MOD-020, MOD-023 |

The compiler, scheduler and verifier must agree on this mapping. When a primitive changes,
update the implementation, its tests, the relevant ADR and this table in the same change.
