# ADR 0013: Engine v2 is the primary target; v1 is frozen

Status: **accepted** (2026-10-02). Supersedes ADR 0012's ordering ("model first, seam second")
now that the model is measured, and keeps all of its findings.

## Context

ADR 0012 asked whether the net can state engine v2's settlement rule and plan for it from step
rows alone. Measured since then:
- The engineV2 profile compiles all 209 corpus entries n8n accepts.
- The converter port agrees with n8n's on 310 entries and 17,587 mutants, and in more than
  160,000 fuzzed workflows.
- The stateless planner agrees with n8n's `decideSuccessors` on every row set reached: sampled
  (33,367 distinct row sets) and exhaustive on small graphs (123,142 row sets).
- The v1 net is pinned byte-identical by a fingerprint.

n8n's own investment is in engine v2, which moves on master far ahead of the release branches.
In the 35 engine commits between `n8n@2.41.3` and master `944afe5` (2026-10-02), the decision
core did not change: `settlement.ts`, `completion.ts`, `iteration-mapping.ts`, `loop-ledger.ts`,
`batch-step.ts`, `graph/loops.ts` and `validate-executable-graph.ts`. What did change around it
is listed below.
- A step status `waiting`: a step that ran and suspended, which still owes a settlement. A
  resume completes it with stored outputs.
- After a failure, `cancelPendingSteps` cancels both queued and waiting rows (previously
  `cancelQueuedSteps`).
- An execution status `waiting` and `isLiveExecutionStatus`.
- Cancellation on request, and streamed webhook responses.

The project owner decided to move to v2 as the primary target.

## Decision

1. **The pin is n8n master**, now `944afe5` (`scripts/n8n-pin.sh`). Release tags lag engine v2
   by weeks. `scripts/check-n8n-drift.sh` reports, at every resync, what touched the seam and
   engine v2.
2. **`engineV2` becomes the default compile profile, and the default for the verify CLI.** v1
   stays available as `profile: 'v1'`. Every v1 consumer passes the profile explicitly: the
   v1 scheduler, codec, conformance and testbed.
3. **v1 is frozen, not deleted.** Patches 0001/0002, `PetriScheduler`, the v1 codec, the
   conformance suite and the v1 testbed stay, and stay tested. The fingerprint keeps the v1 net
   byte-identical, and conformance is rerun at every resync as a regression check. v1 gets no
   new features. It remains the only path that runs on n8n's default engine, and its 1,700+
   measured cases are the evidence base, so deleting it is a separate decision for when v2
   runs end to end.
4. **The work moves to running on v2:**
   - (a) model master's `waiting` status and `cancelPendingSteps` in the decoder, the
     planner and the divergences;
   - (b) seam patches 0003/0004 against master, which extract a `SettlementPolicy` (no
     behaviour change, with n8n's engine and compatibility tests as the gate) and make it
     injectable through `createEngineRuntime`;
   - (c) a net-backed `SettlementPolicy`, `decodeStepRows` + `planFromMarking` behind n8n's
     interface;
   - (d) a live v2 testbed: n8n with `N8N_ENABLED_MODULES=engine-v2` and the policy
     registered, compared with n8n's own planner on the testbed workflows.

## Consequences

- The default changes for every caller. A v1 caller that does not name its profile now gets
  an engineV2 compile, or a refusal where v2 refuses. The repository's own v1 call sites are
  switched in the same change.
- The reporting rule in CLAUDE.md still separates kinds of result. v1 conformance numbers are
  frozen-path regression checks. v2 settlement evidence is not a conformance number. The live
  v2 testbed will be an integration result.
- What v2 does not do (no retries, no error output, agents failing at the first tool call)
  becomes what this project's default compile does not do. `docs/divergences.md` rows 31-34
  carry it.

## Evidence

ADR 0012 Evidence; `tasks/v2-profile-plan.md`; `tasks/v2-acceptance.mts`;
`tasks/v2-differential.mts`; `tasks/spike-v2-exhaustive.mts`. The resync to `944afe5` is
measured in `docs/conformance-master.md`.
