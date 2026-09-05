# Divergences from n8n

Every n8n behaviour this engine does not reproduce is listed here with its classification.
Nothing is skipped silently.

| # | n8n behaviour | Classification | Rationale | Status |
|---|---|---|---|---|
| 1 | R6 stuck-join partial fire, starved-branch case | abandoned (cause removed) | Empty outputs are propagated as explicit tokens, so an AND-join always completes | designed |
| 2 | R6 stuck-join partial fire, arrival-count mismatch | abandoned (defect surfaced) | A stranded token is a modelling error; the verifier flags it statically and the runtime reports it instead of silently re-running the join | designed |
| 3 | v0 execution order (R5 ancestor forcing) | out of scope | Queries live scheduler state; v0 workflows route to the legacy scheduler | designed |
| 4 | Slot-overwrite data loss in `addNodeToBeExecuted` | abandoned (defect) | Reproducing it would destroy user data | designed |
| 5 | Total-order `nodeExecutionOrder` assertions | replaced | LIFO artifact; replaced by data equivalence + happens-before | designed |
| 6 | Endless-loop guard (`currentExecutionTry === lastExecutionTry`) | abandoned | Cycles carry bounded iteration tokens; the verifier proves bounds | designed |
| 7 | Cross-branch `$('Y')` reference fails or succeeds by canvas order | replaced | The net waits for `Y` when it is reachable on another branch; an unmet reference (Y skipped or unreachable) fails with n8n's own error | designed |
| 8 | OR-input rounds that interleave (one producer delivers twice before its sibling once) | positional | Counted positionally like n8n's slots; `placeBound(X/ready_i, n)` proves a workflow free of it | designed |
| 9 | Non-all-required node wired only on a higher input (R6 runs it at quiescence with the lower input `[]`) | replaced | Compiled in direct form and run on arrival with the same data; only the timing differs | designed |
| 10 | OR-input node also fed by a cycle-edge producer: an all-empty round after cycle-triggered runs | positional | Cycle runs leave `ran_i` markers the round does not clear, so the node is not skipped; the downstream join then strands, which the verifier reports | designed |
