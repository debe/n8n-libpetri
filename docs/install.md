# Installing n8n-libpetri into a released n8n

n8n-libpetri is an alternative intra-workflow scheduler for n8n. This page covers adding it to a
released n8n, either installed with npm or run from the official Docker image. It covers the
**v1 path only**: patches 0001/0002 and `PetriScheduler`, activated by
`N8N_EXECUTION_ENGINE=libpetri`. Engine v2 support (patches 0003/0004, `SettlementPolicy`) is not
part of the install path yet. It stays in the repository and its tests, and is neither installed
nor activated by anything on this page (ADR 0015, scope amendment of 2026-10-03).

> **Nothing is published yet.** There is no npm package and no image on a registry. Everything
> below builds from a checkout of this repository. The package stays `"private": true` until
> the owner signs off on the preconditions in [`tasks/inject-plan.md`](../tasks/inject-plan.md)
> ("Licensing and publishing preconditions").

## How it works

The install step adds the scheduler seam to the `n8n-core` package your n8n loads. The seam is
patches 0001/0002, rebuilt for that release. It checks the sha256 of every file before it writes
and after, keeps backups, and records what it changed in `<n8n-core>/.n8n-libpetri/`. The seam
alone changes nothing: with no scheduler registered, n8n runs its own stack loop exactly as
before.

Activation is a separate run-time choice made through two environment variables:

| Variable | Value | Effect |
|---|---|---|
| `N8N_EXECUTION_ENGINE` | unset or empty | n8n runs its own loop. The hook file does nothing. |
| | `libpetri` | The hook registers `PetriScheduler` at boot. |
| | anything else | The hook stops n8n at boot, so a typo cannot quietly run stock n8n. |
| `EXTERNAL_HOOK_FILES` | lists `…/n8n-libpetri/hook/n8n-hook.cjs` | n8n `require()`s the hook in `start`, `worker`, `webhook`, `execute` and `execute-batch`. |

The hook also refuses to boot when `n8n-core` has no seam (n8n was upgraded or reinstalled
after the install) or when a patched file no longer hashes to what the installer wrote. It
names the fix in both cases. An activated process logs these lines on stderr:

| Line | When | What it shows |
|---|---|---|
| `[n8n-libpetri] scheduler registered: …` | once, at boot | The hook registered `PetriScheduler`. Registering is not running anything. |
| `[n8n-libpetri] engine entered: …` | once per process, the first time n8n constructs a scheduler | n8n asked the registered factory for a scheduler. It does not show that the net ran an execution. |
| `[n8n-libpetri] legacy route: executionOrder '<v0>' is not 'v1', …` | every execution of a workflow that is not `executionOrder: "v1"` | That execution ran on n8n's own stack loop, not on the net. |

The engine runs only workflows whose settings say `"executionOrder": "v1"` (n8n's default for
new workflows). A workflow with `executionOrder: "v0"`, or with none (older exports), is handed
to n8n's own stack loop for every execution, even with the engine activated, because v0's
ancestor forcing is not modelled (divergence #3 in [`docs/divergences.md`](divergences.md)).
`engine entered` still appears for it, so look for the `legacy route` line, or check the
workflow's settings, to tell which loop ran.

Optional knobs, read and validated at boot:

| Variable | Default | Meaning |
|---|---|---|
| `N8N_LIBPETRI_BUDGET` | `1` | How many nodes of one execution may run at once. 1 keeps n8n's sequential order. |
| `N8N_LIBPETRI_MAX_AGENT_ROUNDS` | none | Caps an agent's tool rounds (ADR 0008). |
| `N8N_LIBPETRI_MAX_AGENT_TOOL_CALLS` | none | Caps an agent's tool calls. |

## Supported versions

Support is keyed on the `n8n-core` version and the hashes of the files the seam touches. The
installer refuses any other version. Before it writes anything, it checks that every file it
replaces (`dist/execution-engine/workflow-execute.js` and `index.js`, and their maps where the
release ships maps) hashes to the stock release, and that none of the files it creates exists
yet. It does not hash the rest of `n8n-core`: a change to any other file is neither detected
nor refused, and `uninstall` leaves such a change as it found it.

| n8n | n8n-core | Seams | Release-neutrality record |
|---|---|---|---|
| 2.41.5, 2.41.6 | 2.41.4 | `typescript/seams/n8n-core/2.41.4/` | passed 2026-10-03, at `n8n@2.41.6` |
| 2.42.2 (beta) | 2.42.2 | `typescript/seams/n8n-core/2.42.2/` | passed 2026-10-03, at `n8n@2.42.2` |

n8n 2.41.4 and earlier pin other `n8n-core` versions and are not supported. A version counts as
supported only once its neutrality run has passed and is recorded in its manifest: at that
release, with 0001/0002 applied and nothing registered, n8n-core's execution-engine suite must be
identical to the unpatched baseline, and the patched tree must typecheck. Both runs are in
[`conformance-release.md`](conformance-release.md), with what they do and do not show. The
installer refuses seams without a passing record unless you pass `--allow-unverified`; the
record of such an install says so, and `status` reports it.

Node: the npm path was exercised on Node 24.21.0. The official image ships Node 26.7.0. The hook
needs Node's synchronous `require(esm)`, which both have.

## npm

Build the package from this repository and install it next to n8n:

```bash
cd typescript && npm install && npm run build && npm pack      # writes n8n-libpetri-0.1.0.tgz
npm install --global ./n8n-libpetri-0.1.0.tgz
n8n-libpetri status                                             # expect: state: stock
n8n-libpetri install
```

`install` finds n8n through `--n8n <dir|bin>`, then `n8n` on `PATH`, then `$(npm root -g)/n8n`.
It writes into n8n's `node_modules`, so run it as the user who owns that directory. It refuses
an n8n inside npm's npx cache unless you pass `--allow-npx`, because npx can replace that
directory at any time. Running `install` a second time does nothing.

Activate the engine in the shell that starts n8n:

```bash
eval "$(n8n-libpetri env)"    # N8N_EXECUTION_ENGINE=libpetri, and our hook appended to EXTERNAL_HOOK_FILES
n8n start
```

`env` appends to any `EXTERNAL_HOOK_FILES` you already set, using n8n's
`EXTERNAL_HOOK_FILES_SEPARATOR`. Unset both variables, or just `N8N_EXECUTION_ENGINE`, to go back
to n8n's own loop without uninstalling.

## Docker

`docker/Dockerfile` starts from the official `n8nio/n8n:<version>` image. At build time it
installs the packed tarball globally, runs `n8n-libpetri install`, and fails the build unless
`status` reports `installed`. A wrapper entrypoint, `docker/entrypoint.sh`, runs before n8n's own
`/docker-entrypoint.sh`: when `N8N_EXECUTION_ENGINE` is non-empty it appends the hook to
`EXTERNAL_HOOK_FILES` and keeps any hook files you listed. Activation is therefore one variable,
and the hook catches a typo in it.

```bash
scripts/docker/build.sh 2.41.6      # npm run build + npm pack, then a local image n8n-libpetri:0.1.0-n8n2.41.6
scripts/docker/build.sh 2.42.2      # the same on n8nio/n8n:2.42.2

docker run --rm -p 5678:5678 -v n8n_data:/home/node/.n8n n8n-libpetri:0.1.0-n8n2.41.6                   # stock n8n
docker run --rm -p 5678:5678 -v n8n_data:/home/node/.n8n -e N8N_EXECUTION_ENGINE=libpetri n8n-libpetri:0.1.0-n8n2.41.6   # the net
```

The image is tagged locally and never pushed. `scripts/docker/build.sh --allow-unverified`
passes that flag to the installer, for seams that have no neutrality record yet; the shipped
ones do not need it.

`scripts/docker/smoke.sh <version>` checks an image in seven legs, one container at a time
under `--memory=700m`, and removes every container, volume and network it created:

1. `status` reports `installed`.
2. With the engine off, an imported workflow with a join and a retry runs through
   `n8n execute --id`, and no `[n8n-libpetri]` line appears.
3. With `N8N_EXECUTION_ENGINE=libpetri` and a user hook file already set, both hooks load,
   `scheduler registered` and `engine entered` appear, and the run data and node order equal
   leg 2's.
4. `N8N_EXECUTION_ENGINE=libpetrx` stops n8n with our message.
5. A Wait-node execution that became overdue while n8n was down is resumed by `n8n start`. The
   leg records whether the resume ran through the engine (see [Known gaps](#known-gaps)).
6. `uninstall` restores every `n8n-core` file byte for byte to the base image's.
7. A queue-mode `n8n worker` next to a Redis container logs `scheduler registered`.

These are integration results, not conformance numbers.

## Queue mode

In queue mode the main process only enqueues: workers construct the scheduler for queued
executions, and the main process runs manual ones (unless
`OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true`). Set `N8N_EXECUTION_ENGINE=libpetri` on **every**
main, worker and webhook process, and on npm installs `EXTERNAL_HOOK_FILES` as well (`eval
"$(n8n-libpetri env)"` in each process's environment). With the image, the variable alone is
enough on each container. Check each process's log for `scheduler registered`: a worker without
it runs n8n's own loop. A workflow that is not `executionOrder: "v1"` runs on n8n's own loop on
every process (see the `legacy route` line above). This covers the v1 path only; engine v2 is not
part of the install path yet. A full queue-mode execution is exercised by
`scripts/testbed/n8n-testbed.sh --queue` on the pinned n8n master (`docs/testbed.md`), not by the
image smoke test, which checks only that a worker boots with the engine.

## Status and uninstall

```bash
n8n-libpetri status [--json]     # stock | stock-unsupported | installed | modified | orphaned | interrupted
n8n-libpetri uninstall
```

`status` also reports whether the current environment activates the engine. `uninstall`
requires every patched file to still hash to what the installer wrote. It restores the backups,
checks them against the stock hashes, deletes the files it created and removes
`.n8n-libpetri/`. The result is byte-identical to the files the install touched. If a backup is
missing or damaged, it refuses and tells you to reinstall n8n.

**Interrupted runs.** Each file is replaced through a temp file and a rename, so it is always
either stock or as written. Install writes the files it creates before the files that require
them, and uninstall restores the required-by files before it deletes the created ones, so
`n8n-core` stays loadable wherever a run stops. Both runs keep a journal in `.n8n-libpetri/`
while they change files. If one is killed or fails midway (an I/O error, a full disk, a closed
container), `status` reports `interrupted` and the hook refuses to start n8n with the engine
activated. Run `n8n-libpetri uninstall`: it finishes the way back to stock from the backups,
removes any temp files the run left beside the patched files, and then `install` works again.
A killed run also leaves its lock behind. The lock names the run's pid and host. The next
`install` or `uninstall` on the same host takes over a lock whose process no longer runs, and
says so. A lock from another host (a shared volume) cannot be checked, so the command refuses
and names the file to remove once you know no run is in progress. A run killed before it changed
any file leaves only `.n8n-libpetri/`. `status` still reports `stock` and says so, and
`uninstall` removes it. Upgrading n8n (`npm i -g n8n@<new>`) replaces `n8n-core`
together with the install record, so `status` then reports `stock` and you run `install` again.
In Docker, use the base image again, or rebuild for the new version.

Exit codes for `install`, `uninstall` and `status`: 0 ok, 1 refused (unknown version, hash
mismatch, no neutrality record, npx path, two `n8n-core` copies, a lock held by a running or
unknown process), 2 usage, 3 inconsistent state (`modified`, `orphaned`, `interrupted`, or an
uninstall that stopped midway on an I/O error), 4 permission denied. The verifier's
exit 3 ("no solver resolved") belongs to a different command.

## Known gaps

- **Workflows that are not `executionOrder: "v1"`.** They run on n8n's own stack loop even with
  the engine activated (divergence #3), and the process still logs `engine entered`. Each such
  execution logs a `legacy route` line instead. Switch the workflow to v1 in its settings to run
  it on the net, after checking the v1 order suits it.
- **Workflows the net runs differently.** [`docs/divergences.md`](divergences.md) lists every n8n
  behaviour the engine does not reproduce. Run `n8n-libpetri verify <workflow.json>` before
  activating it for a workflow. For example, a node whose success output and error-fallback
  branch both feed the same input of one Merge is a recorded divergence (#2): the verifier
  reports `proper-completion` violated on that input, and the live run completes the Merge with
  the empty branch, where n8n waits for the fallback.
- **Overdue waits at boot.** In regular mode n8n starts its `WaitTracker` before it loads hook
  files, so an execution that became overdue while n8n was down could resume on n8n's own loop.
  Smoke leg 5 measured the resume going through the engine on 2.41.6 (two runs) and on 2.42.2
  (one run), because the tracker's timer fired after the hook had loaded. Nothing guarantees that
  order (divergence row 40; the fix is upstream). Workers load hooks before they take jobs.
- **Source maps.** The installer regenerates the maps of the touched files. Stack traces map to
  the patched TypeScript lines, and the map of the stock release cannot be reproduced.

## Licensing

The package's own code is Apache-2.0. The seams under `typescript/seams/` (deltas and maps) and
the source patches under `patches/n8n/` derive from `n8n-core`, which is under n8n's Sustainable
Use License. The install applies about 1.5 KB of inserted text to the user's own `n8n-core` on
their machine. The rest is copied from the user's files. The Docker image contains all of n8n's
layers. Redistributing it falls under the Sustainable Use License's terms. These are open
questions for the owner and a legal review before anything is published (NOTICE files, the
package's `license` field, trademark wording). Until then the image stays local.
