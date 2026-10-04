# Plan: install n8n-libpetri into a released n8n (v1 path only)

This plan implements ADR 0015 decisions 1 and 3 under the 2026-10-03 scope amendment. The installer, the Docker image and the docs cover the v1 path only: patches 0001/0002, `PetriScheduler` and `N8N_EXECUTION_ENGINE=libpetri`. Patches 0003/0004, `src/settlement/`, the `engineV2` profile and the `--v2` testbed stay in the repository and keep their tests. They are not shipped and not documented in the install path.

Repository HEAD is e2f9fbe (the ADR 0015 amendment). Nothing was committed or published. `.n8n` is unchanged: its working tree still carries 0001-0004 on 944afe5, as before the probes. Release sources were read with `git show`. Probe output is in `/private/tmp/claude-501/-Users-db-repositories-n8n-libpetri/c186cc14-81ab-42e7-b620-bf8e492ac474/scratchpad/{npm,derive,tx}`.

## Judge's checks of the disputed facts

| Claim | Verdict | Evidence |
|---|---|---|
| Transpiling one file at a time reproduces the published JS | **Holds** | Running `transpileModule` (TS 6.0.2) over `workflow-execute.ts`/`index.ts` at the tag reproduces `n8n-core@2.41.4` byte for byte (`3bc32b34…`, `d09aa125…`). The patched outputs are the same for 2.40.3, 2.41.4 and 2.42.2. |
| The same transpile reproduces the published `.map` | **Fails** | `mappings` differ from the 96th character on (63,861 vs 63,880 chars). Both plans' builds reproduce JS only, not maps. |
| The image's `n8n-core` matches npm | **Holds** | `n8nio/n8n:2.41.6` has a single copy, reached through a pnpm symlink. `workflow-execute.js` is `3bc32b34…` and `workflow-execute.js.map` is `a9bf4c2d…`, the same as npm. `.d.ts` files are absent. `.map` files are present. |
| `bin/n8n` installs source-map-support | **Holds** | Line 33 at 2.41.6, line 37 at 2.42.2. A stale map therefore gives wrong stack-trace lines. |
| `EXTERNAL_HOOK_FILES` reaches every process that runs executions | **Holds** | A plain `require` in `ExternalHooks.init()`. `initExternalHooks()` is called in `start`, `worker`, `webhook`, `execute` and `execute-batch`. A file that fails to load raises `UnexpectedError('Problem loading external hook file')`. |
| `EXTERNAL_HOOK_FILES` loads before any execution can start | **Not quite (both plans missed this)** | In `start.ts` at 2.41.6, `WaitTracker.init()` (line 288) runs before `initExternalHooks()` (line 294). On the leader, the tracker queries waiting executions immediately and arms `setTimeout(startExecution, waitTill - now)`. An execution that became overdue while n8n was down can resume on n8n's own loop during the awaits in between. The worker is safe: hooks load at `worker.ts` init before `initScalingService`. |
| A's smoke test uses `n8n execute --file` | **Wrong** | At 2.41.6 and 2.42.2, `--file` throws "no longer supported". B's `import:workflow` followed by `execute --id` is correct. |
| A: "`main.ts` already dispatches on the first argument" | **Wrong** | `src/verify/main.ts` only calls `runCli(argv)`. A dispatcher has to be added. |
| A copy/insert delta keeps the shipped n8n text minimal | **Holds, but only at byte level** | Matching by line, 97% of `stack-scheduler.js` is new text, because the loop is re-indented and `this` becomes `host`. A greedy byte matcher (12-byte seed) ships 189 + 419 + 374 + 16 + 524 = **1,522 inserted bytes** for all five files (92 KB of output). Every reconstruction was checked for round-trip equality. |
| The profile flip breaks 15 tests in 5 files | Taken from B (measured in a temporary worktree) | A's list misses `workflow-json.test.ts` and `v1-identity.test.ts`. |
| Stock n8n reads `N8N_EXECUTION_ENGINE` | **No** | `git grep` at both tags finds no reads, so rejecting any value other than `libpetri` is safe. |
| The dist needs `n8n-workflow` at runtime | **No** | Every `n8n-workflow` import in `src/` used by the scheduler is `import type`. `dist/*.js` contains no `n8n-workflow` reference. A global install resolves only `libpetri` from its own `node_modules`. |

## Decisions

1. **Scope: v1 only.** Nothing in this work touches patches 0003/0004, `src/settlement/`, `src/n8n-v2*.ts` or the `engineV2` profile, and their tests stay in the suite. The testbed's `--v2` path and the v2 branch of the preload stay as they are. *Reason:* the owner's amendment. Engine v2 cannot yet run Code nodes with task runners, agents, sub-workflows or retries.

2. **The compile default goes back to `v1`. The CLI default is `--profile auto`.**
   - `DEFAULT_COMPILE_PROFILE = 'v1'` in `src/compiler/analysis/validate.ts`, with a comment citing ADR 0015.
   - A new `profileForWorkflow(json)` in `verify/workflow-json.ts` returns `engineV2` only when `settings.engineType === 'v2'`, the same rule n8n applies.
   - `auto` exists only in the CLI and the JSON loader; `compile()` never guesses.
   - The report header and `--json` always state the profile that was resolved.
   - *Reason:* ADR 0015 decision 1 and its consequences. `compileCached` already names `'v1'`, so runtime behaviour does not change.

3. **The support matrix is keyed on the n8n-core version plus file hashes.** n8n's own version is only reported.
   - Ship 2.41.4 (n8n 2.41.x stable/latest) and 2.42.2 (beta).
   - 2.40.3 has the same `before` hashes and costs only one neutrality run, so it is added only if that run is done.
   - An entry is *supported* only when its version is listed, every `before` hash matches **and** its neutrality record is filled in. The installer refuses an entry whose neutrality record is empty.
   - *Reason:* n8n-core releases more slowly than n8n (n8n 2.41.4-2.41.6 all pin core 2.41.4). The installer patches n8n-core. ADR 0015 decision 3 ties support to a passing neutrality run.

4. **Patched files are generated by a transpile gated on reproducing the original.** `scripts/release/build-seams.mjs <n8n-tag>…` does this for each tag:
   1. Resolves the n8n-core version and runs `npm pack` on it.
   2. Transpiles the **unpatched** touched sources with `transpileModule`, using the effective options of `tsconfig.build.json` and the `@/` rewrite.
   3. **Requires byte equality with the published JS.** If that fails, it falls back to `tsc --noCheck` plus `tsc-alias` on a `git archive` of `packages/core` (B's method), and then to a full build in a `/private/tmp` worktree.
   4. Applies 0001/0002 in a temporary `GIT_INDEX_FILE` and transpiles the result.

   The patched release is typechecked in the neutrality step (step 9), because a transpile does not check types. *Reason:* this method is measured byte-identical for all three cores. It needs about 2 MB and no `node_modules`, where B's build needs about 360 MB. The gate catches tsdown, bundling, a TS bump or decorators in these files.

5. **The shipped format is a byte-level copy/insert delta against the user's own, hash-checked file.**
   - Each file's delta is a JSON list of `{copy:[offset,len]}` and `{insert:"…"}` operations. A new file names its copy source (`workflow-execute.js` or `index.js`).
   - Measured, the package carries about 1.5 KB of inserted text instead of 92 KB of compiled n8n code.
   - The source patches (`patches/n8n/*.patch`, hashes recorded in the manifest) stay the reviewable form. The generator also writes unified diffs to the scratchpad for review; they are not shipped.
   - *Reason:* ADR 0015 asks for the minimum of n8n's code in what we distribute. Because `before` and `after` are both checked, a delta is as safe as a zero-fuzz diff.

6. **Source maps: regenerated maps are shipped for all five files and installed only where the target already has maps (`ifPresent`).** `.d.ts` files are not touched.
   - The maps come from the same transpile pass as the patched JS, with `sources` set to `../../src/execution-engine/<name>.ts`.
   - Their `before` hash is recorded (`a9bf4c2d…` for 2.41.4) and the original is backed up.
   - Published maps carry no `sourcesContent`, so they contain mappings only.
   - *Reason:* `bin/n8n` installs source-map-support, so leaving the old map (A) points traces at the wrong lines. The unpatched map cannot be reproduced, so the gate stays on the JS. Map correctness is tested separately with a stack-trace probe (step 5).

7. **Loader: `EXTERNAL_HOOK_FILES` with a CJS shim. One loader for npm and Docker.**
   - `hook/n8n-hook.cjs`, about 20 lines, calls `bootFromEnv()` from `dist/n8n/boot.js` and exports `{}`.
   - `bootFromEnv` takes the v1 branch of `scripts/testbed/preload.mjs`, which then calls it. The env parsing and the seam check therefore cannot drift between the two loaders.
   - *Reason:* it is n8n's documented extension point, it needs no change to n8n, and it is scoped to n8n's commands. Unlike `NODE_OPTIONS`, it does not reach task-runner or Execute Command children. A refusal stops n8n at boot.
   - **Known gap (measured above):** in regular mode, an overdue waiting execution can resume on n8n's loop before the hook loads. This is recorded in `docs/divergences.md`, measured by smoke leg 5, and filed in `tasks/todo.md` as an upstream ask (load hooks before `WaitTracker.init`). The `--import` preload stays the testbed's mechanism on the pinned master; it is not a second product loader.

8. **What the hook does.**
   - **Activation:**
     - `N8N_EXECUTION_ENGINE` unset or empty: the hook does nothing.
     - `libpetri`: the hook registers the scheduler.
     - Any other value: the hook throws, so a typo cannot silently run stock n8n.
   - **Resolving `n8n-core` and `n8n-workflow`:** through `createRequire(realpath(process.argv[1]))`, then `require.main`, overridden by `N8N_LIBPETRI_RESOLVE_FROM`. This gives the module instance n8n's own CLI loads.
   - **The hook throws with a fix-it message in two cases:**
     - `setWorkflowSchedulerFactory` is missing ("n8n-core <v> at <path> has no scheduler seam; run `n8n-libpetri install`").
     - The sha256 of `workflow-execute.js` differs from the `after` hash in the install record (a partial install, or a file modified after install).
   - **Settings:** `N8N_LIBPETRI_BUDGET` (default 1), `N8N_LIBPETRI_MAX_AGENT_ROUNDS` and `N8N_LIBPETRI_MAX_AGENT_TOOL_CALLS`, read with the preload's validator.
   - **Log lines:** `[n8n-libpetri] scheduler registered` at boot, and `ENGINE_ENTERED_DIAGNOSTIC` on the first execution. They are two separate claims, as in the testbed.

9. **Install state lives inside the n8n-core directory**: `<n8n-core>/.n8n-libpetri/{install.json, backup/, journal}`.
   - *Reason:* `npm i -g n8n@new` replaces the directory and the record together, so `status` then reports `stock` and the hook's seam check names the fix.
   - Uninstall needs the backups, because a copy/insert delta cannot be reversed. If a backup is missing or its hash does not equal `before`, uninstall refuses and names the remedy (reinstall n8n).

10. **Installer semantics.**
    - **Locating n8n,** in this order: `--n8n <dir|bin>`; the realpath of `n8n` on `PATH`, walking up to the `package.json` named `n8n`; `$(npm root -g)/n8n`.
    - **Locating n8n-core:** `createRequire(<n8n>/package.json).resolve('n8n-core/package.json')`, then the realpath. This works for npm, pnpm and Docker layouts alike.
    - **Refusals:**
      - more than one n8n-core realpath under n8n's tree, whatever their versions;
      - a path under `_npx/`, unless `--allow-npx` is given;
      - an unlisted version, which names the supported n8n versions;
      - any hash mismatch, which names the file and the hash found;
      - an entry with no neutrality record.
    - **`install`:**
      1. Take a lock file.
      2. Check every `before` hash.
      3. Back up the originals and verify the copies.
      4. Rebuild every output in memory and check its `after` hash before writing anything.
      5. Write the journal.
      6. Write each file to a temp file in the same directory, then rename it into place.
      7. Write `install.json` last.

      Any failure rolls back from the backups. Running `install` on a target that is already installed with the same seams does nothing and exits 0.
    - **`uninstall`:** every file must still hash to `after`. Restore the backups, check `before`, delete the created files, then remove `.n8n-libpetri/`. The result is byte-identical to stock.
    - **`status`:** one of `stock`, `stock-unsupported`, `installed`, `modified` (lists each file) or `orphaned` (seam present but no record). It also checks the current environment: whether `N8N_EXECUTION_ENGINE` is set, and whether `EXTERNAL_HOOK_FILES` contains our hook. `--json` is available.
    - **Exit codes:** 0 ok, 1 refused, 2 usage, 3 inconsistent state, 4 permission (`EACCES`, naming the directory's owner). These are separate from verify's exit 3 ("no solver resolved"); usage and the docs say so for each subcommand.

11. **CLI: a new dedicated entry `src/cli/main.ts` becomes `bin`.**
    - It dispatches `install | uninstall | status | env | verify`. An unknown first word falls through to `verify`, so `n8n-libpetri <workflow.json>` keeps working.
    - `env` prints the two exports, for `eval "$(n8n-libpetri env)"`.
    - The entry contains only the invocation, for the tsup-splitting reason given in `verify/main.ts`.
    - `files` becomes `["dist","seams","hook"]`. `"private": true` stays.

12. **Docker image: `docker/Dockerfile` on `n8nio/n8n:${N8N_VERSION}` (default 2.41.6).**
    - As root: install the local `npm pack` tarball globally, run `n8n-libpetri install --n8n /usr/local/lib/node_modules/n8n`, and gate the build on `status` reporting `installed`. Then switch back to `USER node`.
    - A wrapper entrypoint `docker/entrypoint.sh` (`tini -- /n8n-libpetri-entrypoint.sh` → `exec /docker-entrypoint.sh "$@"`) appends our hook to `EXTERNAL_HOOK_FILES` when `N8N_EXECUTION_ENGINE` is non-empty, and keeps any value the user set.
    - The image is stock until the engine is activated, activation is one variable, and a typo is caught by the hook.
    - The tag is local only: `n8n-libpetri:<ours>-n8n<version>`.
    - *Reason:* files are owned by root, so the install has to run at build time. The wrapper composes with users' own hook files, which an `ENV` preset would overwrite.

13. **Reporting.** The Docker smoke test, the npm end-to-end job and the testbed are integration results, never conformance numbers. Neutrality legs are reported per CLAUDE.md: loop-driving cases are stated separately from pure-helper cases, and a scope that never constructs a scheduler is a patch-neutrality leg.

## Implementation steps (one agent each, in order)

1. **Profile default (Decision 2).**
   - Files: `src/compiler/analysis/validate.ts`, `src/verify/workflow-json.ts` (`profileForWorkflow`), `src/verify/cli/args.ts` (`--profile auto|v1|engineV2`, usage text), and the doc comments in `verify/types.ts`, `compiler/types/output.ts`, `compiler/graph.ts` and `verify/cli.ts`. Add a consequence line to ADR 0015.
   - Tests:
     - Rewrite the 15 failing assertions in `tests/compiler/v2/options.test.ts`, `tests/verify/v2-families.test.ts`, `tests/verify/cli.test.ts`, `tests/verify/workflow-json.test.ts` and `tests/compiler/v1-identity.test.ts`. Each becomes either "name `engineV2`" or "assert v1". Never add profiles in bulk to hide the change.
     - Add `auto` cases: a v2 export is detected, a v1 export is detected, an explicit flag beats auto.
   - Done when `npm run check` and `npm test` are green, the v1 fingerprint and the v2 golden are unchanged, and `code-graph-mcp callgraph compile` shows no production caller that relies on the bare default.

2. **Boot extraction (Decision 7/8).**
   - Files:
     - `src/n8n/boot.ts` (`bootFromEnv({resolveFrom?, onDiagnostic?})`, the env validator, the seam check, the record hash check);
     - a tsup entry `n8n/boot`;
     - the v1 branch of `scripts/testbed/preload.mjs` reduced to a call to it, with the v2 branch untouched.
   - Tests: `tests/n8n/boot.test.ts` against a fake core module, covering inert (unset or empty), active, missing seam, record hash mismatch, typo value and a bad knob.
   - Done when `n8n-testbed.sh --daemon` still prints `scheduler registered` and, after a run, `engine entered`, and `diff-engines.sh` gives the same result as before.

3. **Hook shim.**
   - Files: `typescript/hook/n8n-hook.cjs`.
   - Tests: inert with no env var; throws on a core without the seam; `require()` of the ESM dist from CJS works, checked on Node 24 and 26 in the CI matrix.
   - Done when n8n's `ExternalHooks.init` accepts `require(hook)` returning `{}`, checked with a unit test that mirrors `loadHooks`.

4. **Delta codec.**
   - Files: `src/install/delta.ts`, with an encoder (greedy, 12-byte seed, capped candidate list) and a decoder.
   - Tests:
     - round-trip property tests;
     - a decoder that refuses an out-of-range copy;
     - a fixed fixture asserting the inserted-byte count does not regress past the generator's report.
   - Done when the round trip is exact on the three measured cores.

5. **Seam generator and the committed seams (Decisions 4-6).**
   - Files: `scripts/release/build-seams.mjs`, and `typescript/seams/n8n-core/{2.41.4,2.42.2}/{manifest.json,*.delta.json,*.js.map}` with `neutrality: null`.
   - The manifest records `schema`, `package`, `version`, `n8n[]`, the source patch hashes, the toolchain, the per-file `path`/`before`/`after`/`delta`/`deltaSource`, the maps with `ifPresent`, and the inserted-byte totals.
   - Tests:
     - a CI test of manifest schema and integrity: every shipped file's hash matches, and `sourcePatches` equals the hashes of `patches/n8n/000{1,2}*`;
     - a local stack-trace probe: throw from a known line in the patched `workflow-execute.js` under source-map-support and assert the mapped TS line.
   - Done when re-running the generator reproduces the committed seams byte for byte, the unpatched gate passes for both versions, and `.n8n` `git status` is the same before and after.

6. **Installer.**
   - Files: `src/install/{locate,manifest,plan,apply,record,uninstall,status}.ts`.
   - Tests use synthetic fixture trees: a fake n8n plus n8n-core with known bytes, a fixture manifest and a fixture neutrality record. Cases:
     - stock → install → installed → uninstall → byte-identical;
     - a second install does nothing;
     - a tampered file → refuse;
     - an unknown version → refuse;
     - an empty neutrality record → refuse;
     - a write failure injected after file 2 → rollback;
     - a missing backup → refuse uninstall;
     - an `_npx` path → refuse;
     - two n8n-core copies → refuse;
     - a held lock → refuse;
     - a read-only directory → exit 4;
     - the `orphaned` and `modified` statuses;
     - a pnpm symlink layout.
   - Done when every case passes and the exit codes match Decision 10.

7. **CLI dispatcher and packaging.**
   - Files: `src/cli/main.ts`, a tsup entry, `package.json` (`bin`, `files`), the `env` command.
   - Tests: dispatch for each subcommand, `verify` fall-through on a workflow path, exit codes, and the output of `env`.
   - Done when `npm pack` contains `dist/`, `seams/` and `hook/` and no `patches/` copies, and `npx ./n8n-libpetri-*.tgz status --n8n <fixture>` works.

8. **End-to-end against real packages.**
   - A CI job with network and no Docker, run for each version: `npm i n8n-core@<v>`; install; check the `after` hashes; check that `require('n8n-core').setWorkflowSchedulerFactory` is a function; call `registerPetriScheduler`; uninstall; compare with the tarball's bytes.
   - Locally, once: `npm i -g n8n@2.41.6 --prefix /private/tmp/<dir>` (about 1 GB), then locate, install, `n8n execute --id` with and without the engine, uninstall, and remove the prefix.
   - Done when both are green and the global-layout result (number of n8n-core copies, path) is recorded.

9. **Release neutrality.**
   - For each n8n-core version, a worktree under `/private/tmp` at its n8n tag with 0001/0002 applied, then `pnpm` bootstrap, `tsc --noEmit` for `packages/core`, and the execution-engine suite under the stock loop and under libpetri.
   - Results go into each manifest's `neutrality` record (date, suite, numbers) and `docs/conformance-release.md`, reported per Decision 13.
   - Remove the worktrees afterwards, and check `.n8n` with `git status` before and after.
   - Done when both manifests carry a passing record and no worktree is left.

10. **Docker image and smoke test.**
    - Files: `docker/Dockerfile`, `docker/entrypoint.sh`, `scripts/docker/smoke.sh`. The smoke script runs one container at a time with `--memory=700m`, SQLite and a `--rm` trap. Legs:
      1. `status` reports `installed`.
      2. Engine off: `import:workflow`, then `execute --id` on a fixture with a join and a retry and no Code node; no `[n8n-libpetri]` lines appear.
      3. Engine on: `scheduler registered` and `engine entered` appear, and the run data equals leg 2's.
      4. `N8N_EXECUTION_ENGINE=libpetrx`: n8n refuses to start with our message.
      5. Overdue wait: a Wait-node execution whose `waitTill` passes while the container is stopped, then `n8n start` with the engine on. Record whether the resume printed `engine entered` (the Decision 7 gap).
      6. `uninstall`, then compare sha256 with the base image's files.
      7. Worker boot: a Redis container plus `n8n worker` with `--max-old-space-size=256` logs `scheduler registered`.

      A full queue execution stays on `n8n-testbed.sh --queue`, because main alone measured 468 MiB in the 0.95 GB VM.
    - Done when legs 1-4, 6 and 7 pass on 2.41.6 (and on 2.42.2 if memory allows), the leg 5 outcome is written into `docs/divergences.md`, and no containers or images are pushed.

11. **Docs.**
    - Files:
      - `docs/install.md`: npm and Docker, the version matrix, the two variables, queue mode (set both on every main, worker and webhook process), and the npx caveat;
      - an install section in the README (v1 only, "an alternative scheduler for n8n");
      - `docs/divergences.md` rows: the maps are regenerated, and the overdue-wait resume at boot;
      - NOTICE files in `seams/` and `patches/`;
      - `tasks/todo.md` items: the licensing review, the upstream hook-order ask, and 2.40.3;
      - an implementation note in ADR 0015.
    - Done when no install-path doc mentions engine v2, and the wording check (no "replaces", no "superior") passes.

## Falsifiers

- **The transpile stops reproducing the release.** The step 5 gate fails. Use the fallback build, and if that fails too, do not ship the version.
- **A type error hidden by the type-blind transpile.** `tsc --noEmit` in step 9 fails.
- **The wrong map.** The step 5 stack-trace probe maps to the wrong TS line.
- **A loader hole beyond `WaitTracker`.** Any execution without `engine entered` in an activated process. Smoke leg 5 measures the known hole; an unknown one would show in leg 3 or in the testbed.
- **The hook set without activation, or activation without the hook.** On npm this cannot be detected without changing n8n. The evidence is a log without `scheduler registered` next to `status` showing the environment. In Docker the wrapper prevents it.
- **The image's n8n-core differs from npm's** for a release. The build's `status` gate refuses, and the CI image pull compares hashes.
- **Several n8n-core copies under `npm i -g`.** Step 8 records the layout, and the installer refuses.
- **`require(esm)` fails on Node 24,** or a future dist uses top-level await (`ERR_REQUIRE_ASYNC_MODULE`). The step 3 CI matrix catches it.
- **The profile flip changes a runtime result.** The v1 fingerprint or the v2 golden moves in step 1.
- **The v2 code rots while it is not shipped.** Its tests leave CI, or a step touches `src/settlement`/0003/0004. Reviewers check the diff of each step for this.
- **The delta grows.** A future release's inserted bytes jump; the generator reports the totals and the fixture test pins them.

## Licensing and publishing preconditions (the owner decides; nothing is published in this work)

**Owner's decision, 2026-10-04:** n8n-derived files stay under n8n's Sustainable Use License, and the owner's own code is Apache-2.0. Precondition 1's licensing part is settled. Publishing itself remains an explicit step.

- The deltas, maps and source patches are derived from n8n-core code under the Sustainable Use License (`LICENSE.md`, `LICENSE_EE.md`). The package carries about 1.5 KB of inserted text, and the rest is copied out of the user's own file on their machine.
- `seams/` and `patches/` carry a NOTICE that states this origin and includes the text of n8n's license.
- The package's `license` field has to express both licenses (for example `Apache-2.0 AND LicenseRef-n8n-SUL`). That is the owner's call.
- The Docker image redistributes all of n8n's layers. Pushing it to a registry falls under the SUL distribution clause ("free of charge for non-commercial purposes"). Legal review is advisable.
- The names "n8n-libpetri" and the image tag raise a trademark question. Wording stays "an alternative scheduler for n8n", never "replaces" or "superior".
- **Required before any publish:**
  1. Owner sign-off and the NOTICE files.
  2. `"private": true` lifted deliberately.
  3. A passing neutrality record in every shipped manifest.
  4. The npm end-to-end job and the global-install check green.
  5. Docker smoke legs 1-4, 6 and 7 green, and the leg 5 outcome documented.
  6. Engine v2 absent from the install path and its docs.
  7. The divergences rows written.

## Step 1 record (2026-10-03): profile default back to v1

Done. Nothing committed; `.n8n` left at detached `944afe5` with 0001-0004 applied; no Docker containers.

- **Library:** `DEFAULT_COMPILE_PROFILE = 'v1'` (`compiler/analysis/validate.ts`, comment cites ADR 0015). `compile()`, `analyse()`, `verify()` and the JSON loader never read `settings.engineType`.
- **Loader:** `profileForWorkflow(raw)` in `verify/workflow-json.ts` returns `engineV2` only for `settings.engineType === 'v2'`, as `EngineV2DispatcherService` does. `describeWorkflowJson`/`parseWorkflowJson` take `profile: 'auto'` and return the resolved `profile`. No profile still means `v1`, even for a v2 export.
- **CLI:** `--profile auto|v1|engineV2`, default `auto`. A named profile's flags are checked at parse time, as before. Under `auto` they are checked once the workflow is read (`withProfile`): `--budget`, `--start`, `--mutex` and `--all-pairs` under engineV2, or `--trigger` under v1, is a usage error (exit 2, with the usage text), and the message says what the workflow set. The v1 report header now reads `(profile v1)`; `--json` already carried `profile`.
- **Tests:** the 15 failing assertions in 5 files were rewritten one by one (each now asserts v1 or names `engineV2`). New: `auto` detection, explicit beats auto in both directions, and `profileForWorkflow` edge cases. Suite 2147 → 2149, `npm run check` clean. `tests/fixtures/v1-fingerprint.json` and `tests/fixtures/v2/settlement-golden.json` are untouched, and both tests pass.
- **Call sites:** `code-graph-mcp callgraph compile` shows three production callers: `verify()` (passes the profile through), `compileCached` (names `'v1'`) and `CompiledWorkflow.program`. `src/settlement/compile-cache.ts` names `'engineV2'`. None relies on the bare default.
- **Conformance** (`run-conformance.sh --skip-patch --engines=legacy,libpetri` after `npm run build`, registry libpetri, execution-engine scope, 1,756 cases): legacy identical to baseline, loop-driving 45/45, helper 1,711/1,711. libpetri k = 1: loop-driving **41/45**, helper 1,711/1,711. The 4 regressions are the recorded ones: three `v1 execution order` cases and `waiting tools > resets responses between different node executions`. These are loop-driving regression checks, not new engine results.
- **`verify-patch.sh`:** applies 0001-0004 cleanly (13 paths).

Deviations:
1. `scripts/templates/survey.mjs` defaults to `--profile v1` (was `engineV2`). It was not in the step's file list, but its doc said it followed the CLI default. It still passes the profile to the CLI by name, never `auto`.
2. The loader gained `parseWorkflowText`, `resolveProfile` and the `ProfileChoice` type, and the CLI gained `withProfile`. Together they let the CLI resolve `auto` before it describes the workflow, so a flag that does not fit the resolved profile is a usage error rather than a loader error.
3. With `--mutex` and `--all-pairs` both given under engineV2, the error now names `--all-pairs` (it used to name `--mutex`), because the check reads the merged option, where `--all-pairs` wins.
4. Docs were edited beyond CLAUDE.md, README and `docs/verification.md`: the CHANGELOG `Breaking` entry was rewritten (ADR 0013's default was never released), the CLAUDE.md overview line for engine v2 and its survey line were updated, and a consequence line was added to ADR 0015. `docs/state-of-the-project.md` and `docs/conformance-master.md` still describe ADR 0013's "v1 frozen". They are left for step 11.

## Step 2 record (2026-10-03): installer, seams, hook and boot path (plan steps 2-8, v1 only)

Done. Nothing committed or published; `.n8n` left at detached `944afe5` with 0001-0004 applied (`verify-patch.sh` re-run at the end); no Docker containers; the `/private/tmp` e2e prefix and the generator's scratch directories are removed.

- **Boot path:** `src/n8n/boot.ts` (`bootFromEnv`, tsup entry `n8n/boot`): `N8N_EXECUTION_ENGINE` unset or empty is inert, `libpetri` registers, anything else throws; knobs validated before anything is resolved; `n8n-core`/`n8n-workflow` resolved from `N8N_LIBPETRI_RESOLVE_FROM`, else `realpath(argv[1])`, else `require.main`; refuses a core without `setWorkflowSchedulerFactory`/`StackScheduler` and a core whose files no longer hash to the install record. Boot line: `[n8n-libpetri] scheduler registered: budget=N, n8n-core=<v>[ (installed)], hook=<loader>`; `engine entered` stays the factory's separate line. The preload's v1 branch is now a call to it (still gated on `=== 'libpetri'`, so the testbed's `--engine=legacy` leg is untouched); its v2 branch is unchanged.
- **Hook:** `typescript/hook/n8n-hook.cjs` exports `{}`; loads the dist only when `N8N_EXECUTION_ENGINE` is non-empty; writes any refusal to stderr before rethrowing (n8n keeps the reason only in `UnexpectedError.extra`).
- **Delta codec:** `src/install/delta.ts`, greedy, 12-byte seed, 256 candidates per seed, backward extension into the pending insert; base64 inserts only where a run is not valid UTF-8 on its own.
- **Seams:** `scripts/release/build-seams.mjs n8n@2.41.5 n8n@2.41.6 n8n@2.42.2` wrote `typescript/seams/n8n-core/{2.41.4,2.42.2}/` (manifest, five deltas, five maps each). Gate passed for every tag: the unpatched `transpileModule` (typescript 6.0.2, options parsed from the tag's `packages/core/tsconfig.build.json`) reproduces the published `workflow-execute.js` and `index.js`. Patched outputs equal the probe's (`07a64811…` for `workflow-execute.js`). Inserted bytes: **1,515** per version (189 + 419 + 367 + 524 + 16). `--check` reproduces both directories byte for byte; `.n8n` `git status`/HEAD checked equal before and after by the script itself. `neutrality: null` in both (step 9 fills it).
- **Installer:** `src/install/{locate,manifest,plan,apply,status,record,errors,fs-ops,package-root,cli}.ts`; state in `<n8n-core>/.n8n-libpetri/{install.json,journal.json,lock,backup/}`; exit codes 0/1/2/3/4 as decision 10.
- **CLI:** `src/cli/dispatch.ts` + `src/cli/main.ts` (new `bin`, tsup entry `cli/main`): `install | uninstall | status | env`, `help`, everything else falls through to `verify` (which already accepted a leading `verify`). `files` is now `["dist","seams","hook"]`; `"private": true` stays. `npm pack`: 98 files, 784 kB, `seams/` and `hook/` present, no `patches/`.
- **Tests** (no network, no `.n8n`, no Docker): `tests/install/{delta,seams,installer,hook,hook-dist}.test.ts`, `tests/n8n/boot.test.ts`, `tests/cli/dispatch.test.ts`. Every installer case in step 6 is covered, plus interrupted-install recovery, mode preservation, a damaged shipped delta, `--allow-unverified`, PATH and `npm root -g` location. Suite 2149 → **2211** with `dist/` built (2208 + 3 skipped without it: `hook-dist` needs the build; CI runs it after `npm run build` with `N8N_LIBPETRI_REQUIRE_DIST=1`, which turns the skip into a failure). `npm run check` clean; `v1-fingerprint.json` and `settlement-golden.json` untouched and green.
- **End to end, local** (`scripts/release/e2e-npm.sh`, Node 24.21.0, `npm i -g n8n@2.41.6 --prefix /private/tmp/...`, 2.4 GB, 2,284 packages): **one n8n-core copy** at `lib/node_modules/n8n/node_modules/n8n-core` (2.41.4, stock hashes `3bc32b34…`/`d09aa125…`, maps present). All six legs passed: `status` found n8n on PATH (`stock`); `install` refused without `--allow-unverified` (exit 1, no neutrality record), installed with it (10 files incl. maps), second install a no-op, `require('n8n-core').setWorkflowSchedulerFactory` a function; engine on: `scheduler registered … (installed)`, the fan-out/Merge workflow ran via `POST /rest/workflows/:id/run` (`success`, Join 2 items) and `engine entered` was logged; engine off on the same database: run data equal, no `[n8n-libpetri]` line; `N8N_EXECUTION_ENGINE=libpetrx`: n8n refused to start with our message; `uninstall`: all 430 n8n-core files byte-identical to before. An integration result, not a conformance number. Logs: scratchpad `e2e-npm/`.
- **Map check (local, heuristic):** against the patched TS at `n8n@2.41.6`, the shipped `workflow-execute.js.map` maps 849/904 identifier-bearing generated lines to a TS line naming the same identifier (stack-scheduler 182/193); the stock map against the patched JS manages 93/620. The misses are CJS import-binding lines (`backend_network_1` on an `import` line), as expected.
- **Testbed:** `n8n-testbed.sh --daemon --budget=1` printed `scheduler registered` (twice, main thread and one worker thread, as the preload has always run in worker threads) and, after a Concurrency Showcase run, `engine entered`. `diff-engines.sh`: all legs identical to legacy on data, no edge inverted (Agent · Nested Agents, Agent · Two Tools, Concurrency Showcase), as recorded before.

Deviations:
1. **The plan's version mapping was off by one.** n8n 2.41.4 pins n8n-core **2.41.3**; 2.41.5 and 2.41.6 pin 2.41.4 (checked on npm and at the tags). The 2.41.4 manifest lists `n8n: ["2.41.5","2.41.6"]`; the generator cross-checks each tag's `packages/core` version against `npm view n8n@<v> dependencies.n8n-core` and refuses a disagreement. 2.40.x was not generated.
2. **No `/private/tmp` worktree.** The generator reads the tag with `git archive` into a scratch directory under `/private/tmp` and applies 0001/0002 there with `git apply` outside any repository (exact context, no fuzz), as decision 4 describes. It never writes to `.n8n`, and checks `git status` and HEAD before and after.
3. **The decision 4 fallbacks are not implemented** (`tsc --noCheck` + `tsc-alias`, then a full build). The generator stops when the gate fails; no shipped version needs a fallback.
4. **The transpiler is typescript 6.0.2, not the 7.0.2 that built the release** (`catalog:typescript` is native TS 7, which has no `transpileModule`). The gate is what licenses it, and it reproduces the JS. It does not reproduce the stock maps, which is why every touched file's map is regenerated (decision 6).
5. **`--allow-unverified`.** Decision 3 says the installer refuses an empty neutrality record. Step 9 has not run, so both shipped manifests have none, and the e2e needed a way through. The flag installs anyway, warns, and records `unverified: true`, which `status` reports. Without it, the refusal stands (exit 1).
6. **Extra state `interrupted`** (a journal without a record). `status` exits 3 for it, `install` refuses, and `uninstall` restores from the backups after checking that each file is either stock or as written.
7. **`--seams <dir>`** lets the CLI use seams from somewhere else. The tests use it, and so would a seam build that is not yet committed.
8. **Knob parsing is stricter than the old preload's `parseInt`.** `3x` and ` 2.5` are now refused, where they used to read as 3 and 2.
9. **The map check is a mapping heuristic, run locally once.** Decision 6's stack-trace probe (throw from a known line under source-map-support) was not built. Executing the patched file needs n8n's dependency graph, and the heuristic already tells the right maps from the wrong ones (849/904 against 93/620). It is not a committed test.
10. **The CI matrix stays Node 24 only.** Step 3 asked for Node 24 and 26. `npm ci` fails on 26 because of isolated-vm (see `ci.yml`). Locally, the hook was exercised on Node 26.8.1 (vitest) and on 24.21.0 (the e2e).
11. **The e2e ran on Node 24.21.0**, a checksum-verified nodejs.org binary in the e2e directory. Under Node 26, `npm i -g n8n@2.41.6` fails: `@confluentinc/kafka-javascript` has no node-v147 prebuild and its source build fails.
12. **`scripts/README.md`** now lists the two release scripts. `.github/workflows/ci.yml` gained the post-build `hook-dist` step.

Open (for later steps):
- The package's `exports` still list `./n8n-v2` and `./n8n-v2-vitest-setup`, library entries that predate this work. The install path does not use them. Whether a published package keeps them is a step 7/11 packaging call.
- `docker/` and the smoke test are step 10. The docs, the NOTICE files, the divergences rows and the license field are step 11. Neutrality records are step 9.
- `renderEnv` appends the hook every time it is evaluated, so evaluating it twice lists the hook twice. n8n would then require one file twice, and its module cache makes the second require a no-op.

## Step 3 record (2026-10-03): Docker image and smoke test (plan step 10), `docs/install.md`

Done. Nothing committed, pushed or published; `.n8n` left at detached `944afe5` with 0001-0004 applied (`verify-patch.sh` re-run at the end); no containers, smoke volumes or networks left. The two images are local only.

- **Image:** `docker/Dockerfile` on `n8nio/n8n:${N8N_VERSION}` (default 2.41.6). As root it runs `npm install --global` on the packed tarball (adds n8n-libpetri and libpetri, 2 packages), `n8n-libpetri install --n8n /usr/local/lib/node_modules/n8n`, and fails the build unless `status` prints `state: installed`; then `USER node`. `docker/entrypoint.sh` (`tini -- /n8n-libpetri-entrypoint.sh` → `exec /docker-entrypoint.sh "$@"`) appends the hook to `EXTERNAL_HOOK_FILES` only when `N8N_EXECUTION_ENGINE` is non-empty, with n8n's separator, keeping the user's entries and not adding ours twice. Built locally as `n8n-libpetri:0.1.0-n8n2.41.6` and `n8n-libpetri:0.1.0-n8n2.42.2` by `scripts/docker/build.sh` from `npm pack` of this repository (98 files, 784 kB). In both images the installer found one n8n-core, behind the pnpm symlink (`.pnpm/n8n-core@file+…/node_modules/n8n-core`), with stock hashes.
- **Smoke** (`scripts/docker/smoke.sh`, one n8n container at a time, `--memory=700m`, SQLite in a labelled throwaway volume, a trap removes everything labelled): **all seven legs passed on 2.41.6 (one full run, plus two partial runs while building it) and on 2.42.2 (one full run).**
  1. `status`: `installed` (with `--allow-unverified`).
  2. Engine off: `import:workflow` + `execute --id` on `scripts/docker/fixtures/join-retry.json` (a fan-out joined by a Merge; one branch an HTTP Request to `127.0.0.1:1` with `retryOnFail`, `maxTries` 2, `waitBetweenTries` 1000 and `onError: continueErrorOutput` into a fallback Set; no Code node). Succeeds; no `[n8n-libpetri]` line.
  3. Engine on (`N8N_EXECUTION_ENGINE=libpetri` plus a user's own `EXTERNAL_HOOK_FILES=/fixtures/user-hook.cjs`): the user hook loads, `scheduler registered … n8n-core=2.41.4 (installed)` and `engine entered` appear; run data equal to leg 2's (error `stack` keys stripped), node order equal (`Start > Branch A > Unreachable Service > Fallback > Join > Done`), Join 2 items, the retrying node's run spans 1,030-1,064 ms in both legs across the runs (two tries, 1,000 ms apart).
  4. `N8N_EXECUTION_ENGINE=libpetrx`: n8n exits 1 with `[n8n-libpetri] refusing to start n8n: N8N_EXECUTION_ENGINE must be 'libpetri' or unset, got 'libpetrx'`.
  5. Overdue wait (measured): a 70 s Wait execution put to wait by `execute` with the engine on, then `n8n start` with the engine on, the timer 8-23 s overdue. In all three runs, `scheduler registered` came before n8n's `TimeoutNegativeWarning` for the overdue timer, `engine entered` followed, and the execution finished `success`. The race in `start.ts` is real but these runs took the safe order. Written up as `docs/divergences.md` row 40 (`proposed`).
  6. `uninstall` as root in a throwaway container: `state: stock`, and every n8n-core file hashes as in the base image (291 files on 2.41.6, 295 on 2.42.2).
  7. Redis (`redis:7-alpine`, 64 MiB) plus `n8n worker` (`EXECUTIONS_MODE=queue`, `--max-old-space-size=256`, engine on): `scheduler registered`, then `n8n worker is now ready`; 384-395 MiB resident.
  These are integration results, not conformance numbers.
- **Docs:** `docs/install.md` (new): the v1 install path only, with npm and Docker, the activation variables and knobs, the supported versions with their missing neutrality records, queue mode (both variables on every main, worker and webhook process; engine v2 not part of the install path yet), status and uninstall with exit codes, known gaps, licensing, and "nothing is published yet". `scripts/README.md` lists the two docker scripts. The wording check finds no "replaces n8n" and no "superior" (the two hits for "replace" are literal: npx replacing its cache, `npm i -g` replacing `n8n-core`).
- **Gate:** `npm run check` clean; `npm test` 2211/2211 with `dist/` built and `N8N_LIBPETRI_REQUIRE_DIST=1`; `v1-identity.test.ts` and the golden tests green, with `tests/fixtures/` untouched; `verify-patch.sh` applies 0001-0004 (13 paths).

Deviations:
1. **The image is built with `--allow-unverified`.** Both manifests still have `neutrality: null` (step 9). The Dockerfile's `N8N_LIBPETRI_INSTALL_FLAGS` defaults to empty, so a plain `docker build` keeps the installer's refusal. `build.sh` passes the flag and says so, and the image's install record and `status` carry `unverified`.
2. **`scripts/docker/build.sh` is new** (the plan named only the Dockerfile, the entrypoint and `smoke.sh`). It stages a build context with only the tarball and the entrypoint, so nothing else from the repository reaches the image and no `.dockerignore` is needed.
3. **The first smoke fixture hit divergence #2 live.** It wired the HTTP node's success output *and* its error-fallback branch into the same Merge input. The engine completed the Merge with the empty success token and logged `stranded token on …/ready_1 input 1 (divergence #2)`. n8n waited for the fallback, so the run data differed (Join 1 item against 2). `n8n-libpetri verify` reports the same shape statically (`proper-completion` violated on `Join input 1`, budget lowered for a multi-producer input). The fixture now wires only the error output, and verify proves proper completion on it. The claim that this shape is common was unmeasured. Measured 2026-10-04: it occurs in 0 of 211 workflows, and multi-producer slots on multi-input nodes in 1, with concurrent producers (`tasks/scan-multi-producer-slots.mjs`). `docs/install.md` names it under known gaps and says to run `verify` first. Whether it deserves more than the existing row is an open question for the owner.
4. **Leg 3 also checks that a user's own hook file still loads** next to ours, which tests the wrapper's composition. The plan did not ask for this.
5. **Leg 5's outcome went into `docs/divergences.md` now** (row 40, plus the intro's note on `proposed` rows), as step 10 asks. The source-map row and the rest of step 11 (README install section, NOTICE files, `tasks/todo.md` items, ADR 0015 note, the state-of-the-project and conformance-master pages) are left for step 11. `docs/install.md` was written in this step because the step asked for it.
6. **Leg 7 runs the worker on SQLite.** n8n warns that scaling mode is not officially supported with SQLite. The leg checks the boot only; a full queue execution stays with `n8n-testbed.sh --queue`.
7. **The base image runs Node 26.7.0**, so the hook's `require(esm)` is exercised on Node 26 in the image and on Node 24.21.0 by the npm e2e.
8. **No `/private/tmp` worktree was needed.** The image installs the already committed seams from an `npm pack` of this repository; `build.sh` stages under `$TMPDIR` and removes it.
9. **Left on the Docker host (local, never pushed):** the images `n8n-libpetri:0.1.0-n8n2.41.6` and `n8n-libpetri:0.1.0-n8n2.42.2`, plus the pulled `n8nio/n8n:2.42.2` and `redis:7-alpine`, and build cache. `docker rmi` removes them.

## Step 4 record (2026-10-03): review findings on the installer, release neutrality (plan step 9), docs (plan step 11)

Done. Nothing committed, pushed or published; `.n8n` left at detached `944afe5` with 0001-0004 applied (`verify-patch.sh` re-run at the end); no containers left.

- **Uninstall had no journal and no rollback** (major). It removed the created files before it restored the replaced ones, so a failure midway left the patched `workflow-execute.js`/`index.js` requiring files that were gone, every later run refused with "changed after install", and an I/O error escaped as a stack trace with exit 2. Now (`src/install/apply.ts`): uninstall writes a journal from the record and removes the record before it touches a file; restores replaced files first, then removes created ones (`restoreStock`, shared with install's rollback); needs a backup only for a file that is not stock now; and maps every failure to exit 3 (or 4 for a permission error), saying that the journal and backups are kept and that `uninstall` again finishes. A journal tells `status`/`install` which run stopped (`operation`).
- **Install wrote replaced files before created ones** (minor). Now created first, then replaced; the record lists files in the order written. The journal is written before the first backup.
- **Stale lock, temp files, killed-before-journal leftovers** (minor). `src/install/lock.ts`: the lock is created whole (temp file + `link`), names `pid` and `host`, and a lock whose process is gone on this host is taken over (moved aside and re-read, so two recoveries cannot both win); another host's lock is refused with the remedy. Temp files `.<file>.n8n-libpetri-<pid>.tmp` beside the seam's files are swept by uninstall, rollback and install. A state directory with no record and no journal (a run killed before its journal) is reported under `stock` with a line, removed by `uninstall` (`leftover: true`), and cleared by `install`. The boot path now refuses a journal without a record when the engine is activated.
- **Evidence.** `tests/install/crash.test.ts` kills `install` and `uninstall` (child process, SIGKILL just before the Nth `node:fs` mutation) at **every** mutation they make (install about 60, uninstall about 30 points) and asserts at each: n8n-core loadable (no patched file without its created files), `status` in {stock, installed, interrupted}, and `uninstall` exits 0 to the exact stock bytes with no state directory; after a killed install, `install` again works or names `uninstall`. Checked against mutations of the fix (old write order: 20 unloadable points; old restore order: 17; no takeover: every crash point refused). `installer.test.ts` adds EIO at a restore and at a removal (exit 3, loadable, retry to stock), EIO before any change (exit 3, nothing changed), EACCES midway (exit 4, retry), the write order, the three lock cases, the leftover directory, and an interrupted install built as a real crash leaves it (journal, dead-pid lock, temp file). In the rebuilt `n8n-libpetri:0.1.0-n8n2.41.6` image, as root: the reviewer's EIO-at-the-3rd-rename uninstall now exits 3, `require('n8n-core')` loads, `status` says `interrupted`, `install` names `uninstall`, and a second `uninstall` restores all 291 files to the base image's hashes; SIGKILL at each of install's 13 renames and uninstall's 5: n8n-core loads at every point and `uninstall` returns the base image's bytes every time (scratchpad `docker-crash/result.txt`).
- **v0 routing** (minor). `PetriScheduler` emits `legacy route: executionOrder '<v0>' is not 'v1', so n8n's own stack loop runs this execution, not the net (divergence #3)` for each such execution (`legacyRouteDiagnostic`); `engine entered` keeps its meaning (the conformance scripts count it). `docs/install.md` has the three lines in a table, a paragraph on v1-only routing, a queue-mode line and a known-gaps entry; divergence row 3 names the line.
- **Release neutrality (plan step 9).** `scripts/release/neutrality.sh n8n@<tag>`: a local clone of `.n8n` under `/private/tmp` (not a worktree: a worktree registers in `.n8n/.git`), `bootstrap-n8n.sh` at the tag (new `N8N_RESULTS`, `N8N_BOOTSTRAP_COMMIT/TAG` overrides; `run-conformance.sh` takes `N8N_RESULTS` too), `git apply` of 0001/0002, `pnpm --filter n8n-core typecheck`, then `run-conformance.sh --skip-patch` legacy and libpetri. **n8n@2.41.6: 1,723/1,723 identical (loop-driving 45/45, helper 1,678/1,678); n8n@2.42.2: 1,746/1,746 identical (45/45, 1,701/1,701); typecheck passed on both.** PetriScheduler leg 41/45 loop-driving on both, the same four regressions. Both manifests now carry the record; `build-seams.mjs --check` still reproduces the committed seams byte for byte. `docs/conformance-release.md` reports it, with its limits (source patches, not the installed dist; execution-engine scope only). The image and the e2e no longer pass `--allow-unverified`; `build.sh --allow-unverified` remains for seams without a record.
- **Scope of the stock check** (minor). Not a code defect: the installer hashes the files it replaces and the names it creates, which is what the seam depends on. `docs/install.md` overstated it ("any file whose hash it does not know"); it now says exactly what is checked, and an installer test pins that a change elsewhere is neither refused nor undone. A whole-package check is a `tasks/todo.md` §10 item.
- **Docs (plan step 11).** README: an install section (v1 only, "optional alternative scheduler"), the contents entry, repository-map rows, and the license exception. `docs/state-of-the-project.md` and `docs/conformance-master.md` describe ADR 0015 and its scope amendment instead of ADR 0013's "v2 primary, v1 frozen". `NOTICE` files in `patches/n8n/` and `typescript/seams/` (origin, plus n8n's `LICENSE.md` verbatim, identical at 944afe5, 2.41.6 and 2.42.2). `package.json` `license` is `Apache-2.0 AND LicenseRef-n8n-sustainable-use`. ADR 0015, its README row, ADR 0013 and this plan dated the amendment 2026-10-04; it is 2026-10-03, as the commits are. ADR 0015 got an implementation note; `tasks/todo.md` §10 lists the licensing review, the upstream hook-order ask, 2.40.3 and the whole-package check; CHANGELOG and `scripts/README.md` updated.

Deviations:
1. **The license field and NOTICE wording are a proposal.** The plan leaves the license expression to the owner; `"private": true` stays, and the review is a todo item.
2. **Clones, not worktrees,** for the neutrality run (reason above). `.n8n`'s HEAD and `git status` were checked equal before and after by the script.
3. **The neutrality run is of the patched source,** not of the installed dist; the link is the build-seams gate. Stated in the record and the report.
4. **Both images rebuilt without `--allow-unverified`, and smoked again:** all seven legs passed on 2.41.6 and on 2.42.2 (`status` now prints `neutrality record 2026-10-03`, no `unverified`). The superseded local images were removed. A live v0 check in the 2.41.6 image: the smoke fixture with `executionOrder: "v0"` under `N8N_EXECUTION_ENGINE=libpetri` logs `scheduler registered`, `engine entered` and then `legacy route: executionOrder 'v0' …`. Integration results, not conformance numbers.
