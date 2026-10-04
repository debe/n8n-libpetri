# ADR 0015: Both engines, injectable into a stock n8n; the engine picks the path

Status: **accepted** (2026-10-03). Supersedes ADR 0013 decisions 2 (engineV2 as the fixed default)
and 3 (v1 frozen). It keeps ADR 0013 decision 1 (the pin is n8n master) and everything ADR 0014
built.

**Scope amendment (2026-10-03, owner):** engine v2 is left out of the product work for now. The
install step, the Docker image and the docs cover the v1 path only (patches 0001/0002). The v2 seam
(patches 0003/0004, `src/settlement/`, the engineV2 profile) stays in the repository, maintained
and tested, and is not shipped: nothing installs patches 0003/0004 or activates the policy. The
packed tarball, and so the image, still contains its library entry (`n8n-libpetri/n8n-v2`,
`dist/n8n-v2.js`) as an unused file; whether a published package keeps it is open
(`tasks/todo.md` §10). Engine v2 itself is too limited today (no Code node with task
runners, no agents, no sub-workflows, no retries) to offer it to users. The compile default is
`v1`.

## Context

The project owner's goal is to offer n8n-libpetri as an **optional, more capable scheduler for
n8n**: verifiable scheduling, a concurrency budget, failure policies and agent tool rounds. It
should be injectable into the n8n people run, and a small interface upstream should later make the
injection official. Two facts shape that:
- **Today n8n runs engine v1 by default.** Engine v2 is opt-in, needs Postgres, and n8n marks it
  "in development". It cannot yet run agents (Agent V3 is n8n's default agent), retries, error
  outputs or sub-workflows. Our v1 path does all of these (ADRs 0004, 0008, 0009).
- **n8n's direction is engine v2.** If v1 is retired, the v1 seam goes with it. Our v2 seam
  (`SettlementPolicy`, patches 0003/0004, ADR 0014) is built and measured: neutral when nothing is
  registered, and outcome-equal to n8n's own planner in the live testbed. It also follows engine
  v2's own design rule ("a pure core that decides, with every effect injected"), which makes it the
  stronger upstream candidate.

ADR 0013 made engineV2 the fixed default and froze v1. That bets on v2 before n8n's users are
there, and it freezes the only path that runs n8n's default agent.

## Decision

1. **The engine picks the path.**
   - A workflow that runs on engine v1 gets the net as its `WorkflowScheduler` (patches
     0001/0002).
   - A workflow with `settings.engineType: 'v2'` gets the net as its `SettlementPolicy` (patches
     0003/0004).
   - The compile profile follows the engine: `settings.engineType === 'v2'` selects `engineV2`,
     and anything else selects `v1`, as n8n itself decides. The library default is therefore `v1`
     when the caller names no profile. The verify CLI defaults to `--profile auto`, which reads
     the workflow's `settings.engineType`. `profile: 'engineV2'` and `'v1'` stay explicit choices.
2. **Both are maintained.**
   - v1 is un-frozen and gets the product work, because it is what users run. Its net stays pinned
     by the v1 fingerprint.
   - v2 is fully maintained and gains features as n8n builds them in v2 (the Agent V3 tool round
     is the clearest candidate, `upstream/rfc-tool-call-round.md`).
3. **Injection into a stock n8n: an install step and a Docker image.**
   - `n8n-libpetri install`, from a global install (`npm i -g`, `docs/install.md`; not `npx`,
     whose cache would also hold the hook path n8n loads), applies the seams to an installed n8n's compiled packages:
     `n8n-core` for v1 and `@n8n/engine` for v2. It refuses any file whose content hash it does
     not know, records what it changed, and `n8n-libpetri uninstall` restores the files byte for
     byte. `status` reports both.
   - It supports explicit n8n versions only. A version is supported when its patched build passes
     the neutrality legs.
   - Activation stays opt-in at run time (`N8N_EXECUTION_ENGINE=libpetri` and the v2 equivalent).
     An installed but unactivated n8n behaves exactly as stock.
   - A Docker image based on the official n8n image ships the install step already applied.
4. **Upstream, later and only on the owner's decision.** Lead with the v2 `SettlementPolicy`
   seam, and offer a minimal v1 hook only if n8n still wants it. Everything upstream stays a local
   draft in `upstream/` until then. Nothing is posted.

## Consequences

- The default compile profile changes again, from `engineV2` back to "follows the engine",
  meaning `v1` unless the workflow says v2. Call sites that rely on the bare default are reviewed
  in the same change. Explicit profiles are unaffected.
  Implemented in `tasks/inject-plan.md` step 1: `DEFAULT_COMPILE_PROFILE` is `'v1'`, and
  `profileForWorkflow` (`verify/workflow-json.ts`) is the only reader of `settings.engineType`,
  used by `--profile auto` and the JSON loader's `profile: 'auto'`. No production caller relied on
  the bare default: `compileCached` names `'v1'`, `src/settlement/` names `'engineV2'`, and
  `verify()` passes the profile through. The v1 fingerprint and the v2 golden did not move.
- The install step ships patches that contain n8n's own code, under the Sustainable Use License.
  The patches stay minimal and are applied on the user's machine. The owner decided on 2026-10-04 that
  n8n-derived files stay under n8n's licence and the rest is Apache-2.0. This needs a licensing note
  before the package or image is published.
- Supported n8n versions become a maintained list, and each entry needs a passing neutrality run.
  Implemented for the v1 path (`tasks/inject-plan.md` steps 2-11): `n8n-libpetri install`,
  `uninstall` and `status` (`typescript/src/install/`), per-release seams for n8n-core 2.41.4 and
  2.42.2, the hook, and the image. Both manifests carry a passing neutrality record
  (`docs/conformance-release.md`: the patched release with nothing registered is identical to its
  unpatched baseline). The licensing note is the `NOTICE` files in `patches/n8n/` and
  `typescript/seams/`; the owner settled the licensing on 2026-10-04 (`tasks/todo.md` §10), and
  publishing remains a separate, explicit step.
  Two parts of decision 3 are narrower as built. The installer hashes only the files it replaces
  and the names it creates, not every file of the package (`docs/install.md`; a whole-package
  check is open in `tasks/todo.md` §10). The `@n8n/engine` half, its `status` line and the v2
  activation variable are deferred by the scope amendment.

## Evidence

ADR 0014 and `docs/testbed.md` for v2; `docs/conformance-master.md` and the v1 fingerprint for
v1; `docs/conformance-release.md` for the released versions the installer supports;
`docs/divergences.md` for what each path does not reproduce.
