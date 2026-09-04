# spec/

Language-neutral mapping from n8n execution concepts to libpetri requirement IDs. Filled in
during M1 as the compiler is written; each row cites the n8n source location (pinned commit
`441970b`) and the libpetri requirement it maps onto.

| n8n concept | libpetri construct | Requirements |
|---|---|---|
| connection | edge place pair `data` / `empty` | CORE-030, IO-010 |
| node readiness | transition enablement | IO-005, EXEC-003 |
| node execution | action on `X_run` | CONC-002, EXEC-020, IO-015 |
| IF / Switch outputs | `and` of per-edge `xor` | IO-011, IO-012, IO-016 |
| multi-input node | join gadget (`all()`, inhibitor, per-input free slot) | IO-003, CORE-033, EXEC-010 |
| `waitingExecution` | marking of `ready_i` places | EXEC-041 |
| v1 depth-first order | priority = depth, declaration order | EXEC-002, CONC-023 |
| retryOnFail | `delayed()` transition over a tries place | TIME-004, TIME-011 |
| stopWorkflow error | `_halt` place, inhibitors, reset-arc reap | CORE-031, CORE-034, EXEC-013 |
| cancellation | `close()` | ENV-013, EXEC-040 |
| concurrency | `_budget` place | EXEC-003, VER-002 |
| `$('X')` reference | read arc on `X/done` | CORE-032, EXEC-012 |
| Wait node / resume | marking codec ↔ `IRunExecutionData` | EXEC-041 |
| stuck join (design-time) | `joinedOrDeadLettered` | VER-002, NU-040 |
| composition | one `SubnetDef` per node | MOD-010, MOD-020, MOD-023 |
