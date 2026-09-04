# n8n-libpetri — milestones

## M0 — Repository
- [x] Scaffold from adk-libpetri conventions, TypeScript package skeleton, CI
- [x] `debe/n8n-libpetri` created

## M1 — Compiler, confirmations, n8n bootstrap + patches
- [ ] Track A: `src/compiler` — SCC + emission rule, per-node gadget, join gadget, retry gadget,
      halt + reap, expression read arcs, unreachable-input seeding, k-safety, NetMap, dotExport
- [ ] Track B: `tests/spikes` — pin every derived fact against libpetri (see README model)
- [ ] Track C: `scripts/bootstrap-n8n.sh`, patches 0001/0002, junit baseline, conformance matrix

## M2 — Engine
- [ ] `PetriScheduler` + `MarkingCodec`, v1 only, cancellation via `close()`
- [ ] Data equivalence + happens-before on the fixture set at k = 1; divergence register complete

## M3 — Concurrency + differential report
- [ ] k > 1 under the safety check; lineage-step copy; differ over both engines

## M4 — Verification
- [ ] `verify(workflow)`: proper completion, dead nodes, exclusion, bounds, ≤ maxTries
