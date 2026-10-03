# RFC: a `SettlementPolicy` seam in engine v2's `StepSettledHandler`

**Draft. Not posted.** Written by an AI agent for the repository owner. n8n's `CONTRIBUTING.md`
asks for issues and PR text "in your own words", so the owner rewrites this before it goes
anywhere. All n8n facts are read at master [`944afe5`][pin].

## Summary

Move the two decisions `StepSettledHandler` takes from the step rows behind an interface, with
n8n's code as the default. Nothing changes while no other policy is passed. The change is an
optional extension point: engine v2 keeps its own planner, and a host can plug in another one,
for example to run it beside the default and compare.

## Problem

Engine v2's settlement rules are a pure core: [`decideSuccessors`][settlement] and
[`countExpectedSettledSteps`][completion]. They are not injected. The handler imports them and
calls them inline, in [`planSuccessors`][planSuccessors] and
[`finishExecutionIfDone`][finishIfDone], and [`createEngineRuntime`][runtime] builds the handler
with no option that could replace them. To run another planner, or to check the default against
an independent model in a live server, you must fork the handler.

## The precedent it follows

The package's [`AGENTS.md`][agents-blueprint] states the blueprint: "a **pure core that
decides, with every effect handed in as an injected interface**". `decideSuccessors` already is
that pure core, and the handler already receives its effects (stores, queues, publishers)
through the constructor. So the blueprint does not ask for the decision to be injected, and
this RFC does not claim that it does.

The precedent is a different part of the same file:
- **Core interfaces** are "each defined in its own core module beside a default/reference use"
  ([`AGENTS.md`][agents-layers]), for example `AdmittanceService` in `admittance/`.
  `SettlementPolicy` is defined in `execution/`, beside `defaultSettlementPolicy`, which is the
  code moved out of the handler.
- **Composition roots** "construct the concrete adapters (the `DataSource`, the admittance
  policy, the v1 step executor) and hand them to `createEngineRuntime`. **Construction lives
  here, not in the core**" ([`AGENTS.md`][agents-roots]). The admittance policy is the closest
  case: a policy that the core consults and that the host chooses. `serve.ts` and the cli's
  `EngineV2Runtime` both pass `new AllowAllAdmittance()`. A settlement policy can be passed the
  same way.

This precedent supports alternative 1 below (an option only, chosen in the composition root)
more than the engine-side registry that patch 0004 adds in `execution/`.

The seam also follows the read-path rule in [`AGENTS.md`][agents-readpath]: a reader type that
"cannot reach `claimStep` or `finishExecution`".

## The interface

New file `execution/settlement-policy.ts` (patch 0003):

```ts
export interface SettlementReader {
	readonly executionId: string;
	loadLatestStepSummaries(nodeIds: string[]): Promise<Record<string, StepSummary>>;
	loadStepSummariesByKeys(keys: StepKey[]): Promise<Record<StepKeyId, StepSummary>>;
	countSettledSteps(): Promise<number>;
}

export interface SettlementPolicy {
	decideSuccessors(graph: WorkflowGraph, settled: StepKey,
	                 reader: SettlementReader): Promise<SuccessorDecisions>;
	isFinished(graph: WorkflowGraph, reader: SettlementReader): Promise<boolean>;
}

export const defaultSettlementPolicy: SettlementPolicy;   // the code moved out of the handler
export function settlementReaderFor(stepStore: StepStore, executionId: string): SettlementReader;
```

- `StepSettledHandler` gets an optional 7th constructor argument, which defaults to
  `defaultSettlementPolicy`.
- The reader is bound to one execution and has no write method. A policy is therefore a
  function of the rows it reads, and its type enforces that.
- The seam is `isFinished`, not an expected count. A policy that had to return a count would
  return a boolean in disguise.
- These stay in the handler: the failure branch, `hasFailedSteps`, `createSteps`, the
  announcements and `cancelPendingSteps`. A settlement that observes a failure never asks the
  policy. One race remains: a failure that lands after the handler's first `hasFailedSteps`
  check and before `isFinished` reaches the policy on a row set with a failed row. The handler
  then checks `hasFailedSteps` again before it finishes. `StepReadyHandler` keeps input
  gathering.

Patch 0004 adds `EngineRuntimeOptions.settlementPolicy?`. `createEngineRuntime` passes
`settlementPolicy ?? getSettlementPolicy()` to the handler. That is the only read of a small
module registry (`setSettlementPolicy`, `getSettlementPolicy`, `resetSettlementPolicy`). The
in-process module, the `n8n engine` command and `serve.ts` all build their engine through
`createEngineRuntime`, so the patch touches nothing in `packages/cli`.

## Evidence of no behaviour change

**The decision core is byte-identical.** `settlement.ts`, `completion.ts`, `loop-ledger.ts`,
`iteration-mapping.ts` and `graph/loops.ts` do not change. `defaultSettlementPolicy` makes the
same store calls in the same order. The existing pins on read order
([`step-settled-handler.test.ts:236`][pin236], [`:252`][pin252]) pass unedited. No existing
test case is edited. Patch 0004 adds one `describe` block (90 lines) to the existing
`create-engine-runtime.test.ts`.

**Neutrality legs**: patched with nothing registered, against the unpatched commit. We ran
each baseline twice as a flake check. Results compare per case (junit).

| suite | cases | patched = baseline |
|---|---:|---|
| `@n8n/engine` unit | 376 (plus 25 new) | identical |
| `@n8n/node-engine-compatibility` unit | 169 | identical |
| `cli` engine-v2 module and dispatcher | 365 | identical |
| `@n8n/engine` integration (Postgres 18.4) | 149 | identical |
| `m1-acceptance` integration (Postgres) | 18 (16 pass, 2 `it.todo`) | identical |

`tsc --noEmit`, `oxlint` and `biome ci src` are clean on the engine package.

The 25 new cases are the seam's own tests:
- the default policy against direct calls of `decideSuccessors` and the count test, including
  how many reads it makes and in what order;
- an injected policy is used, and a settlement that observes a failure does not consult it;
- the runtime takes the option, then the registry, then the default.

## What it enables

These numbers are from our own policy, which answers from a formal model of the settlement
rules. They show that the seam carries a full alternative policy. They are not
conformance numbers for n8n.

- **A second planner behind the same handler and stores.** With our policy registered, n8n's
  engine integration suite passes 10 of 10 cases that reach the policy. The other 139 of its
  149 cases never reach the policy, so they say nothing about it. `m1-acceptance` passes 16 of
  16, and all 16 reach it. We count per case, by an "entered" counter.
- **Shadow mode.** One policy answers and a second runs beside it and logs disagreements. On
  n8n's own suites both directions agree on every comparable answer. The exceptions are 2
  answers in one conditional-diamond case, where the reused snapshot gave a safe late "not
  finished". Any team could run a candidate rule change this way first.
- **Differential checks outside the server.** The same interface lets a test drive
  `decideSuccessors` and an independent model over every reached row set.
- **Reconciliation (CAT-2938)** could call the same policy. The reader is the read set that
  "any planner, at any time, recomputes the same decisions" needs. This is a guess about a
  design we cannot see.

## Open question: process-global registry or DI

Patch 0004 copies a shape we already use for engine v1: a module-level registry, read once per
runtime. It needs no cli change. It is also ambient mutable state inside `execution/`, a core
folder. A registry is per module instance, so a policy registered on `src` does not reach a
runtime built from `dist`. We met this when two copies of the module were loaded.

Alternatives, smallest first:

1. **Option only.** Keep `EngineRuntimeOptions.settlementPolicy` and drop the registry. The cli
   composition root (`EngineV2Runtime.initEngine`) chooses what to pass, for example from a DI
   token. This adds a cli change but no global state in the engine.
2. **Registry in the cli module**, not in the engine package.
3. **As built**: an engine-side registry.

The `AGENTS.md` precedent (see "The precedent it follows") points to alternative 1, and we
would write that version if the engine team agrees. The policy does not depend on the choice.

## Minimal PR plan

Each PR is under 1,000 added lines and needs no `.ee` file.

1. `refactor(engine): Extract the settlement decisions into a SettlementPolicy (no-changelog)`:
   patch 0003, 705 added lines: 175 of source (138 in the new `settlement-policy.ts`, 37 in
   the handler and the two index files; 60 removed from the handler) and 530 of tests. Five
   files, all in `packages/@n8n/engine/src/execution/` plus the package index.
2. `refactor(engine): Let a host choose the settlement policy (no-changelog)`: patch 0004
   (134 added lines, 90 of them tests), or alternative 1 above if preferred.

The seam is independent of a property test for the settlement loop (offered separately), but
that test runs the handler unchanged and would also cover the default policy after PR 1.

## What we ask

- Is a settlement seam welcome in engine v2 at this stage, or should it wait for a planned
  refactor (reconciliation, extraction of serving infrastructure)?
- Which injection shape (option, cli registry, engine registry)?
- Should `validateGraph`, which `StartExecutionService` accepts but `createEngineRuntime` does
  not pass, be in the same PR? We left it out on purpose: a policy that refused graphs at
  start, which n8n accepts, would change behaviour.

[pin]: https://github.com/n8n-io/n8n/tree/944afe5c889f130ac07c1831dd88fa7c7103a5c1
[settlement]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/execution/settlement.ts#L11-L34
[completion]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/execution/completion.ts#L14
[planSuccessors]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/execution/step-settled-handler.ts#L108
[finishIfDone]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/execution/step-settled-handler.ts#L174
[runtime]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/runtime/create-engine-runtime.ts#L100
[agents-blueprint]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/AGENTS.md#L12-L18
[agents-layers]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/AGENTS.md#L35-L40
[agents-roots]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/AGENTS.md#L53-L57
[agents-readpath]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/AGENTS.md#L95-L105
[pin236]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/execution/__tests__/step-settled-handler.test.ts#L236
[pin252]: https://github.com/n8n-io/n8n/blob/944afe5c889f130ac07c1831dd88fa7c7103a5c1/packages/@n8n/engine/src/execution/__tests__/step-settled-handler.test.ts#L252
