# Upstream preparation (n8n)

Local only. Nothing here has been posted to GitHub, the n8n forum or any other service.
Every statement about n8n comes from files read at n8n master `944afe5` (the pin),
in a detached worktree that has since been removed. `.n8n/` was not touched.

This directory is about contributing to **n8n**. `typescript/tests/upstream/` is a different
thing: probes for asks to libpetri.

| file | what it is |
|---|---|
| `README.md` | n8n's contribution terms, and how the patch below was made and measured |
| `0001-test-engine-settlement-properties.patch` | `git format-patch` of one commit on `944afe5`: a property test for engine v2's settlement loop. Needs nothing from this repository. sha256 `cadde68ea1e5…` |
| `rfc-settlement-policy-seam.md` | draft RFC for the `SettlementPolicy` seam (patches 0003/0004) |
| `rfc-tool-call-round.md` | draft RFC: agent tool-call rounds as engine v2 steps |
| `OFFER.md` | the order of the offer, what needs the owner's approval, and a checklist |
| `count-agent-entries.mjs` | the corpus count the tool-call RFC cites |

## 1. Contribution terms at the pin

### CLA: required, signed on the PR

- **Text** (`CONTRIBUTOR_LICENSE_AGREEMENT.md`, complete): "I give n8n permission to license my
  contributions on any terms they like. I am giving them this license in order to make it
  possible for them to accept my contributions into their project." Then a no-warranty,
  no-liability clause. `CONTRIBUTING.md` names the source: the Indie Open Source CLA form.
- **How it is signed.** `CONTRIBUTING.md`: a bot comments on the PR when it opens, signing is "the
  push of a button", and the PR merges only after the signature. The bot is
  `.github/workflows/ci-cla-check.yml`. It is n8n's own replacement for the "CLA Bot" GitHub
  App; the logic is in `n8n-io/github-actions/cla-check`, pinned by SHA. It runs on PR open,
  push and reopen (`pull_request_target`), on a `/cla-check` comment (to re-check after
  signing without a push), and in the merge queue. It sets a commit status `CLA Check`,
  keeps one PR comment that lists the **unsigned contributors**, and adds the label
  `cla-signed`.
- **What this means here.** Every commit author on the PR must sign. The patch's author is
  this repository's git identity (`Dennis Berger <dbgh@knownhosts.org>`). That email must
  belong to the GitHub account that signs, or the bot lists the commit as unsigned.

### What the Sustainable Use License does to a contribution

This is a reading of the text, not legal advice.

- `LICENSE.md`: everything on `master` is under the **Sustainable Use License 1.0** (SUL),
  except files with `.ee.` in the name or `.ee` in the directory name, which are under
  `LICENSE_EE.md` (the n8n Enterprise License). "Content of branches other than the main
  branch (i.e. "master") are not licensed." `@n8n/engine/package.json` declares
  `LicenseRef-n8n-sustainable-use`.
- The SUL is **outbound**: it governs what others may do with n8n. A contribution enters
  through the **CLA**, which lets n8n license it "on any terms they like". So contributed code
  ships under the SUL, and n8n may also put it under other terms, the Enterprise License
  included. The CLA text grants a license; it does not say that copyright is assigned.
- `LICENSE_EE.md` gives n8n all rights in any modification of a `.ee` file. Neither the test
  patch nor patches 0001–0004 touch a `.ee` file (checked: 0 of 14 distinct paths, 13 in
  patches 0001–0004 and 1 in the test patch).
- The test patch imports only `@n8n/engine` modules and `vitest`. Nothing from libpetri or
  n8n-libpetri goes in, so the CLA would cover that one test file and nothing else.
- Not a contribution question, but the same license: the SUL allows modification "for your own
  internal business purposes or for non-commercial or personal use", distribution only "free of
  charge for non-commercial purposes", and asks modified copies to carry "a prominent notice
  stating that you have modified the software". `patches/n8n/` is a distributed modification.
  Whether its current notices are enough is the user's call.

### Where design discussion is expected

- `CONTRIBUTING.md`, Community PR Guidelines §1, "Start With an Issue or Forum Topic":
  - **features and enhancements:** a topic on the forum (community.n8n.io) first. "Feature PRs
    that arrive with no prior discussion will be closed with a pointer to the forum."
  - **bug fixes:** an issue with reproduction steps must exist; a PR without one is returned.
  - **refactoring:** an issue or forum topic first, with the rationale.
  - **core:** "Contact n8n before starting any change under /packages/core." Patches 0001 and
    0002 change `packages/core`. Patches 0003 and 0004 change `packages/@n8n/engine`, which that
    sentence does not name.
  - **an existing issue:** ask in a comment and wait for a team member.
- A test-only PR has no row of its own. The golden rule ("a contribution should be worth more
  to the project than the time it takes us to review it") and the "Low-Value or Automated PRs"
  closure apply. The safe order is an issue or forum topic first, then the PR.
- Engine design is recorded in **ADRs**, written by n8n. `packages/@n8n/engine/docs/adr/` has
  four, all `Decision Owner: Catalysts` and all `RFC: -`. Their `Documentation:` links go to
  internal records: two ADRs link the same Notion page, and two link Linear issues (CAT-4341,
  CAT-4727). The repository has no RFC directory. Engine docs and code cite internal Linear
  tickets (CAT-2874, CAT-2875, CAT-2938) and a Notion "Durable Scheduler modularity blueprint".
  So the internal design record is not public; the forum and GitHub issues are the public way in.

### ADR conventions (`d01ec72338`, "ci: Enforce ADR conventions (#39286)")

The code-health rule `adr-conventions`
(`packages/quality/policy/code-health/src/rules/adr-conventions*.ts`) checks:

- location: `docs/adr/` at the repository root or at the root of a pnpm workspace package;
- name: `ADR-YYYYMMDD-kebab-case-title.md`, unique, with one H1 that matches the name;
- sections, once each and in this order: `Context`, `Decision`, `Alternatives Considered`,
  `Consequences`, `Links`, none empty, with exact blank-line spacing;
- metadata in order: `Date`, `Status` (`Active`, `Superseded` or `Deprecated`),
  `Decision Owner`; then optional `Source`, `Supersedes`, `Superseded by`, left out when empty;
- `Links` holds `RFC:`, `Documentation:` and `Related ADRs:`, with `-` for none, and full
  ADR IDs that resolve;
- paragraph lines of at most 100 characters before `Links`.

The template is `docs/ADR_TEMPLATE.md` (Context in under 150 words). The allowed owners are
configured in `packages/quality/policy/code-health/src/index.ts`: at the pin, only
`Catalysts`. An outside contributor cannot submit an ADR that passes CI under any other
owner. ADR 0014's open question (is a process-global registry acceptable) is an RFC or forum
question, not an ADR we could submit.

### Commits, PR titles and PR content

- **Title = squash commit subject:** `<type>(<scope>): <Summary>`
  (`.github/pull_request_title_conventions.md`, Angular convention, checked by
  `ci-check-pr-title.yml`).
  - types: `build ci chore docs feat fix perf refactor test`; only `feat`, `fix`, `perf` and
    breaking changes reach the changelog;
  - scopes: `API benchmark core editor engine` or `<name> Node`. `engine` means "the new
    workflow execution engine v2"; leave the scope out if none fits;
  - summary: imperative present tense, capitalized, no final period, no Linear IDs;
  - append `(no-changelog)` to keep a commit out of the changelog. It is used inconsistently on
    `test` commits (`git log` shows both forms); the patch uses it;
  - footer: `BREAKING CHANGE:` / `DEPRECATED:` blocks, `Fixes #n` / `Closes #n`.
- **PR template** (`.github/pull_request_template.md`): Summary; How to test; Related Linear
  tickets, GitHub issues and forum posts; checklist ("I have seen this code, I have run this
  code, and I take responsibility for this code", title conventions, docs, tests included,
  backport labels).
- **PR rules** (`CONTRIBUTING.md` §3–§6):
  - one logical change and **at most 1000 added lines**, or the PR is returned for splitting;
    stacked PRs (`gh stack`) are the way to land more;
  - tests are required, and a PR without them auto-closes after 14 days. A bug fix needs a
    regression test that fails on current `master`;
  - requested changes get a reply within 14 days, or the PR auto-closes;
  - no `ts-ignore` / `ts-expect-error`. Reuse `@n8n/utils`, `@n8n/constants` and `n8n-workflow`
    helpers before writing new ones;
  - **AI tools:** "You must understand every line you submit … without the AI"; write the PR
    description, issues and forum posts "in your own words. Do not paste raw model output";
    disclosing which tools did meaningful work is encouraged. The commit message in the patch
    is a **draft** written by an AI agent. Rewrite it in your own words before posting.
- **Writing style** (`AGENTS.md`): all technical text (comments, PR and issue descriptions,
  docs) in ASD-STE100 Simplified Technical English. Call the engine "engine v2", lowercase
  (`packages/@n8n/engine/AGENTS.md`).
- **Tests and checks** (`AGENTS.md`, "Verify changes"): Vitest; run focused tests from the
  owning package (`pnpm test <file>`); run the package's `pnpm lint` and `pnpm typecheck`
  before committing. For `@n8n/engine`: `lint` is `oxlint --quiet` (type-aware, `backendConfig`),
  `format:check` is `biome ci src`, `typecheck` is `tsc --noEmit`. Unit tests live in
  `src/**/__tests__/*.test.ts`; `*.integration.test.ts` runs only under
  `vitest.integration.config.ts` (Postgres via testcontainers). CI also runs `@n8n/code-health`.
  lefthook installs git hooks on `pnpm install`.
- **Engine layering** (`packages/@n8n/engine/AGENTS.md`): `graph/`, `execution/` and
  `admittance/` are core. Core must not import `express`, `pg`, `@n8n/typeorm`, `@n8n/config`
  or `@n8n/di`, and the package takes no `n8n-workflow` dependency at all, not even type-only.
  Partial writes are left to reconciliation (CAT-2938), not to cross-store transactions. The
  test patch imports code only from `graph/`, `execution/` and `response-channel/`
  (`noopExecutionResponseSender`), types only from `queue/` and `lifecycle-events/`, and
  nothing from outside the package except `vitest`.

## 2. The property test patch

`packages/@n8n/engine/src/execution/__tests__/settlement.property.test.ts`, one new file,
999 lines (inside the 1000-line limit, with 1 line to spare). Commit subject:
`test(engine): Add property tests for the settlement loop (no-changelog)`.

### What it drives and what it checks

It runs n8n's `ExecutionStartHandler` and `StepSettledHandler` without changes, over in-memory
`ExecutionStore` / `StepStore` / `WorkQueue` objects written to the interfaces' documented
contracts. Two examples: `createSteps` skips existing keys and creates nothing once a step has
failed; `cancelPendingSteps` cancels queued and waiting steps. Every decision comes from the
real `decisionKeys`, `decideSuccessors`, `loadTerminalIterations` and
`countExpectedSettledSteps`. A step worker settles each `step:ready` with an outcome that is a
function of the step key alone. A scenario is a graph plus that outcome function. Its messages
are delivered in **every order**: a memoised DFS over (rows, pending messages, execution
status, lifecycle events), where each delivery runs to completion. Larger graphs get seeded
random orders, with up to 3 messages redelivered per run. Every generator seeds its PRNG from a
hash of a label (`lcg(hash(label))`), never from a counter (see the correction below).

| claim (source) | check |
|---|---|
| rules 2–3 (`settlement.ts`) | the first run's fates equal `specFates`, an independent whole-graph fixpoint of the rules over (node, iteration) |
| confluence, "same outcomes in any order" | every order reaches one outcome: fates and status, or `failed` |
| completion (`completion.ts`, handler) | ends `completed`, exactly one `execution:completed`, every row settled, no row for an unreachable node, settled count **equal to** `countExpectedSettledSteps`, both at the finishing settlement and at the end; no row created after the finish |
| termination | the DFS terminates; deliveries = 1 + rows + queued rows (redeliveries on top) |
| rule 4, one hop per event | every row a settlement creates is `targetKey` of one of the settled step's out-edges, created `queued` or `skipped`, and announced once (`step:ready` / `step:settled`) with nothing else published; settled fates never change, except queued → cancelled after a failure |
| "any planner, at any time, recomputes the same decisions" | in **every** state reached, each completed or skipped step is planned again: `toQueue` keys must end completed and `toSkip` keys skipped in the final fates; at the end every re-plan is empty; planning from the rows `decisionKeys` names equals planning from all rows |
| fail-fast (handler) | with one failing step: ends `failed`, exactly one `execution:failed`, no `execution:completed`, every row settled |

### Coverage (measured with an instrumented copy of the final file; the copy was then deleted)

| test | graphs | scenarios | delivery orders | distinct states | re-planned (state, step) pairs |
|---|---:|---:|---:|---:|---:|
| every DAG of 1–3 nodes × every read-slot pattern; every 4-node DAG × the all-filled pattern + one other seeded pattern | 1,696 | 4,160 | 88,115 | 66,975 | 221,780 |
| loops: 2 pre-shapes × 8 bodies × 3 after-shapes; passes 0–3; done or empty; 3 seeds | 48 | 1,152 | 8,892 | 12,756 | 39,195 |
| random: 53 DAGs of 4–7 nodes, 48 with one loop (random 1–3-node body, 0–4 passes), 49 with two loops in sequence or in parallel (0–3 passes each); done slot empty in 11 of the 97 loop scenarios; 20 random orders each | 150 | 150 | 3,000 | — (sampled) | 26,553 (in 6,056 sampled states) |
| one failing step: DAGs of 1–3 nodes × each node; 8 loop bodies × failure at pass 0 or 1 | 79 | 222 (206 end `failed`) | 943 | 2,527 | 448 |

Random runs redelivered 2,596 messages. The deepest exhaustive order is 17 deliveries (loops).
The loop and failure rows did not change in the second round, and the instrumented copy gave
their earlier figures exactly, so the two rounds count the same way.
Graph shapes are those `validateExecutableGraph` accepts: one trigger, one edge per input slot,
batch nodes with `batchSize`, one back edge, and the done slot as the only exit. Each
generated graph passes through it, so a generator change that breaks the shape fails the test.

### Correction: the first random test generated no loop

The first version of this patch seeded the random scenarios with `lcg(seed)` for seeds 1–150.
That LCG's first draw grows by only 1664525 / 2³² ≈ 0.0004 per seed, so for seeds 1–150 it
lies in [0.2365, 0.2942], and `kind = randomInt(rand, 3)` was 0 for all 150 seeds. Every
random scenario was a DAG. `randomBody` and `twoLoopGraph` never ran, and the pass and
done-empty draws changed nothing. The pinned count (150) could not see it, because it counts
scenarios, not kinds. The coverage claimed for that row, in the commit message and in the first
prep report, was false. A review found it (kinds [150, 0, 0]); the loop-count mutant below
passed the random test.

Fixed in the second round:
- every generator seeds from a hash of a label. ``lcg(hash(`random ${seed}`))`` gives 53 DAGs,
  48 one-loop and 49 two-loop scenarios;
- the test pins the kind counts (53 / 48 / 49) beside the scenario count;
- the 4-node DAG sample had the same bias (`lcg(graphIndex + 1)`; its first draw only covered
  about [0.24, 0.87]). It now seeds from `dag ${size}#${graphIndex}` and draws from the patterns
  other than the all-filled one, so the second pattern is never a duplicate. The count stays
  4,160.

n8n's existing property test in `settlement.test.ts` copies the same LCG and has the same flaw:
`count = 3 + randomInt(rand, 6)` is 4 for every seed 1–200, so every graph it builds has 4
nodes. That is worth saying in the issue. The test patch does not change it, because it
changes no existing file.

### Results

At the pin, no property is violated in any scenario. Second round, 2026-10-03, on a 10-core
machine at load average 106–127 (other agents running).

| run | result |
|---|---|
| new file, pristine `944afe5` | 4 / 4 pass. DAG test 2.65–3.79 s, the four tests 4.1–5.7 s in total (4 runs) |
| `pnpm --filter @n8n/engine test`, pristine | 28 files, **380** tests (376 baseline + 4) |
| same, on `944afe5` + patches 0001–0004 | 29 files, **405** tests (401 + 4) |
| `pnpm lint` (oxlint, type-aware), `pnpm typecheck`, `pnpm format:check` (biome) | clean; the file is in scope of each (first round: checked with a deliberate violation, then reverted) |
| `git apply --check` on pristine `944afe5`; on `944afe5` + 0001–0004 | both apply |

**Timeout.** The describe block sets `{ timeout: 60_000 }`, and a run with the value set to
100 ms fails, so the option applies. Without it, every test has vitest's default 5 s
(`@n8n/vitest-config` sets no `testTimeout`, and its own comment says oversubscribed CI makes
timing-sensitive tests flake into timeouts). A review ran the first version at load average
about 50: the first run failed with "Test timed out in 5000ms" in the DAG test, and three reruns
took 6.1, 5.1 and 5.6 s for that test alone. The first round's "2.1–2.4 s" held only on an
idle machine. `describe(name, { timeout }, fn)` has precedent in n8n (`freezeGlobals` in
`@n8n/task-runner`, `AgentBuilderView` in `editor-ui`).

**Mutation probe.** Each mutant was applied alone to the pristine source, then reverted. Rerun
in the second round on the fixed file, with `--testTimeout=120000` so load cannot fake a kill.
"n8n's existing unit tests" means `settlement.test.ts`, `completion.test.ts` and
`step-settled-handler.test.ts`; the last two rows were also run against all 194 existing
`execution/` unit tests.

| mutant | new test | n8n's existing unit tests |
|---|---|---|
| `isLive` ignores the slot | killed (3 of 4 tests) | killed |
| loop count off by one (`completion.ts`) | killed (3 of 4; the first version's random test missed it) | killed |
| skips do not cascade (handler plans only after `completed`) | killed (4 of 4) | killed |
| a pending exit source read as "none" | killed (2 of 4) | killed |
| an unsettled source does not block the decision | killed (2 of 4) | killed |
| finish one step early | killed (4 of 4) | killed |
| a created skip announced as `step:ready` | killed (4 of 4) | killed |
| `isPastLoopEnd` removed **and** `batchStepDecides` always true | killed (3 of 4) | killed |
| `isPastLoopEnd` removed alone | survives | survives |
| `batchStepDecides` always true alone | survives | survives |
| `decisionKeys` omits the loop's batch key | survives | survives |
| no `hasFailedSteps` check before planning | survives | killed |
| no de-duplication of two edges into one step | survives | survives |
| `decideNodeFate`: `applicable === 0` returns `skipped` | survives | survives (all 194) |
| `finishExecutionIfDone` always finishes `completed` | survives | survives (all 194) |

The survivors are equivalent at the level the test observes:
- `isPastLoopEnd` and `batchStepDecides` guard the same thing, so each one alone is
  unobservable through `decideSuccessors`. The batch-key read in `decisionKeys` feeds only
  `isPastLoopEnd`. The doc comment says the exclusion lives in `decideNodeFate` "so anything
  recomputing fates reaches the same answer, reconciliation included". No public caller
  re-plans a body step outside `decideSuccessors` today. This is worth saying in the PR,
  not changing.
- Without the `hasFailedSteps` guard, `createSteps` still refuses after a failure, and the
  finish still picks `failed`. The existing unit test pins the call itself.
- Duplicate keys in one `createSteps` batch are absorbed by the store's insert-if-absent.
- `applicable === 0` cannot be reached from `decideSuccessors`: the candidate's own in-edge
  from the settled step always maps back to a row, or returns `pending` first.
- A failed step goes to `failExecution` first, so the `failed` branch of
  `finishExecutionIfDone` is reachable only in the race where a failure lands between a
  sibling's `hasFailedSteps` and its count (divergence row 37 in this repository). Each delivery
  here runs alone, so the race does not occur. n8n's existing suite does not test that branch
  either.

A review ran an independent probe of 15 mutants on the first version: 11 killed, 4 survived.
The survivors were the `applicable === 0` and always-`completed` mutants above, the missing
`hasFailedSteps` guard, and the loop-count mutant, which the first version's random test
missed (the loop and failure tests killed it). The fixed random test kills it
(`random loop seed=2: fates … the rules give after@0=skipped/ …`).

### Limits, stated in the file

- Each delivery runs alone, so concurrent handlers are not explored. Neither are the claim
  and complete steps of the worker as separate events, waits, cancellation on request, or
  the step executors.
- The stores are fakes written to the interface docs. A gap between those docs and
  `TypeOrmStepStore` would not show here.
- The scenario counts are pinned (4,160 / 1,152 / 150 / 222), and so are the random kinds
  (53 / 48 / 49), so a generator that shrinks or stops making a kind fails. A count says
  nothing else about what the scenarios contain: the first version pinned 150 random scenarios
  that were all DAGs. The order and state counts are not pinned, because a legitimate engine
  change (one more message, say) would move them.
- Each test has a 60 s timeout. On a slower or busier machine than the ones measured here,
  that bound is the next thing to fail.

### What kind of result this is

It tests n8n's code against n8n's own documented claims. Under `CLAUDE.md`'s reporting rule it
is none of the four kinds that ADR 0014 keeps apart. It is not a neutrality leg, because it
compares nothing against a baseline. It is not a policy-entering case, because it builds
`StepSettledHandler` directly, so the 0004 registry is never read and the net-backed policy
never answers. It is not settlement evidence for our policy, and it is not an integration
result. Its numbers belong to this patch only.

### How it was produced

Second round (the fixes above): the same steps in a new worktree,
`/private/tmp/n8n-upstream-fix`, commit `b17bdcbe6747…` (not in `.n8n`'s object store:
`git -C .n8n cat-file -e` fails). The worktree was removed and pruned afterwards; `.n8n` was
not touched and is still at detached `944afe5` with no branch, no stash and no other worktree.
First round:

- Worktree: `git -C .n8n worktree add --detach /private/tmp/n8n-upstream 944afe5c88…`.
- Install: `CI=true pnpm install --frozen-lockfile --offline --filter '@n8n/engine...'
  --filter n8n-monorepo` (pnpm 12.4.2 through the corepack shim in
  `conformance-results/.corepack-bin`).
- Build: `turbo run build --filter='@n8n/engine^...'`. All 9 tasks replayed from turbo's
  shared worktree cache, the outputs of `.n8n`'s own builds of the same, unpatched, packages.
- The commit was made with `GIT_OBJECT_DIRECTORY` pointed at a scratch directory (alternates:
  `.n8n/.git/objects`), so `.n8n`'s object store got no new object. Checked:
  `git -C .n8n cat-file -e df77167…` fails. Then `git format-patch -1 HEAD --stdout`, and
  `git worktree remove --force` and `git worktree prune`.
- Afterwards `.n8n` is at detached `944afe5`, with no branch, no stash and no other worktree.
  Its `packages/@n8n/engine/src` and `packages/core/src` hash to the same tree as `944afe5` +
  0001–0004 applied to a scratch index (`cbc7028d558f…`).

## Before anything goes upstream

1. Open a forum topic or issue first (§1). A test-only PR with no discussion risks the
   low-value closure.
   - **Timing.** Today is 2026-10-03. `CONTRIBUTING.md`'s "Low-Value or Automated PRs" list
     names "PRs whose main purpose is to earn a contribution credit, a mention, or event
     points. Hacktoberfest and similar events do not change the quality bar." A first-time,
     test-only PR opened in October is open to that reading. Opening the issue or forum topic
     first, and waiting for a reply, mitigates it. So does waiting until November.
   - **Repetition.** The test copies `lcg` and `randomInt` from `settlement.test.ts`.
     `CONTRIBUTING.md` asks to "Reuse existing components, parameters, and logic wherever
     possible" ("Avoid Repetitive Code"). A reviewer may ask for a shared test helper. That
     would edit `settlement.test.ts` too, which is also the place to fix its seeding (above).
     Offer it in the issue.
2. Rewrite the commit message and PR description in your own words (§4). Consider disclosing
   AI assistance.
3. Make sure the GitHub account that signs the CLA owns the commit email.
4. If reviewers want it smaller: the DAG test and the loop test stand alone. The random and
   failure tests can follow in a stacked PR.
