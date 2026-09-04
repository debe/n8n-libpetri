# ADR 0001 — One net, net-native modelling

Status: accepted (2026-09-04)

## Context

Two earlier drafts of the n8n mapping were rejected. One used a null output spec plus
`skipOutputValidation` on execution transitions and a separate "verification net". The other
put a permit-gated dispatch queue beside the executor to reproduce n8n's stack order. Both
routed around libpetri semantics, and a model the verifier cannot trust is not a model.

## Decision

1. Every transition carries a real `Out` spec (libpetri IO-010..IO-015). Genuine sinks that
   produce nothing may omit it (CORE-043 AC4); nothing else may.
2. One `PetriNet` per execution serves the executor, the exporter and the verifier.
3. Ordering, mutual exclusion, concurrency limits, retries and halts are modelled with
   priority, declaration order, inhibitor and read arcs, timed transitions and places
   (`_budget`, `X/idle`, `X/tries`, `_halt`). No scheduler policy lives outside the net.
4. n8n behaviours that are implementation artifacts (LIFO order, the stuck-join fallback R6
   on arrival-count mismatch, the slot-overwrite data loss, v0 ancestor forcing, the
   endless-loop heuristic) are abandoned deliberately and listed in `docs/divergences.md`.

## Consequences

- The verifier sees exactly what runs. Proper completion, dead nodes, exclusion and bounds are
  proven on the executed net.
- The concurrency budget is a place, so it is provable (`placeBound`, P-semiflow), and it is
  the only way to bound concurrency in libpetri's TypeScript port (CONC-012 is unimplemented).
- Some n8n tests that assert a total execution order cannot pass by construction. The success
  criterion is data equivalence plus deterministic happens-before plus an explicit divergence
  register.
