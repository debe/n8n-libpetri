# The upstream offer to n8n: order, approvals, checklist

Local only. Nothing in `upstream/` has been posted to GitHub, the n8n forum or any other
service. Every item below waits for the owner's explicit approval, one item at a time.

## The order (ADR 0012 §4)

Each step costs n8n less than the next one and stands on its own. If a step gets no interest,
the steps after it are not offered.

| # | item | file | form | status |
|---|---|---|---|---|
| 0 | Contribution terms: CLA, licence, where discussion happens | `README.md` §1 | read only | done |
| 1 | Property test for engine v2's settlement loop | `0001-test-engine-settlement-properties.patch`, `README.md` §2 | issue or forum topic, then one test-only PR | drafted |
| 2 | `SettlementPolicy` seam (our patches 0003, 0004) | `rfc-settlement-policy-seam.md` | forum topic (a feature), then 1–2 PRs | drafted |
| 3 | Tool-call rounds as steps | `rfc-tool-call-round.md` | forum topic only; no code until the rules are agreed | drafted |

Not offered unless n8n asks:
- patches 0001 and 0002 (engine v1, `packages/core`). `CONTRIBUTING.md` says "Contact n8n
  before starting any change under /packages/core".
- ADR 0012 §4's v1 asks restated for engine v2. The strongest of these is ADR 0009's
  `onFailure` as a retry model. A separate draft is needed first.

Why this order:
- The test needs no API change and checks n8n's code against n8n's own documented claims.
- The seam is a design change. It needs the engine team to accept the shape, and the test
  gives the reviewers a reason to trust our evidence.
- The tool-call round depends on the seam's discussion, and on a gap n8n owns: sub-nodes do not
  reach the step (`rfc-tool-call-round.md`, gap 1).

Suggested gate: post the next item only after a maintainer has replied to the previous one.

## What needs the owner's explicit approval

Approval for one item covers that item only.

1. **Each post.** That means every forum topic, GitHub issue, discussion, PR, comment, CLA
   signature and `/cla-check`.
2. **The words.** `CONTRIBUTING.md` asks for issue, PR and forum text "in your own words. Do
   not paste raw model output". The RFCs, the commit messages in the patches and this file
   were written by an AI agent. The owner rewrites them and decides whether to disclose AI
   assistance, which `CONTRIBUTING.md` encourages. `AGENTS.md` asks for ASD-STE100 Simplified
   Technical English. The drafts are plain English and were not checked against STE100.
3. **Identity.** Every commit author on a PR must sign the CLA. The owner chose
   `dbgh@knownhosts.org` (2026-10-04); the test patch and patches 0001-0004 are authored with it.
   The GitHub account that signs must own that address.
4. **Links to this project.** The RFCs link only to n8n's repository. Decide whether to link
   `github.com/debe/n8n-libpetri` and libpetri, and whether the repository is ready to be read.
5. **Licence.** `patches/n8n/` is a distributed modification of n8n under the Sustainable Use
   License, which asks for "a prominent notice stating that you have modified the software"
   (`README.md` §1). That is the owner's call, and it is better settled before we draw
   attention to the patches.
6. **Scope choices.**
   - Registry or option-only for the seam (ADR 0014, Open).
   - Whether to split the 999-line test into a DAG PR and a loop PR.
   - When to post. `CONTRIBUTING.md` names Hacktoberfest-style credit-seeking as a reason to
     close a PR, and it is October (`README.md`, "Before anything goes upstream").
   - Whether the tool-call RFC goes out before the seam has had a reply.

## Correction found while drafting

Internal documents say that 85 of 209 accepted entries "fail at the first tool call", or that
agents fail or halt at their first tool call. Remeasured on 2026-10-03 with n8n's converter
and validator at `944afe5` (`upstream/count-agent-entries.mjs`):
- 85 counts every workflow with any `ai_tool` connection;
- 69 entries have a tool-using node on the fired trigger's graph: 12 with an Agent V3, 44 with
  only Agent V1/V2, and 13 with an MCP Server Trigger;
- by source, 202 of the 209 accepted entries are templates and 7 are our own fixtures. Of the
  12 Agent V3 entries, 9 are templates and 3 are ours. 13 of the 200 templates contain an Agent
  V3, so "the templates predate Agent V3" was false and is gone from the RFC.

Before a tool call, an agent fails at its model lookup ("A Chat Model sub-node must be
connected and enabled"). `docs/testbed.md` already records that for three agent workflows,
under the engine v2 seed table. The RFC uses the corrected figures. The places that carried
the old claim (ADRs 0012 and 0013, `tasks/todo.md` §8, `tasks/v2-profile-plan.md` and
`tasks/spike-v2-settlement.mts`) are corrected as of 2026-10-04; `grep -rn 'first tool call'
docs tasks` now finds only the correction notes in ADR 0012.

## Checklist

Before item 1 (property test):
- [ ] Rebase onto current n8n master. Rerun `scripts/check-n8n-drift.sh`, the four tests
      (about 2–6 s, depending on load; each has a 60 s timeout), and `pnpm lint`,
      `pnpm typecheck` and `pnpm format:check` in `@n8n/engine`.
- [ ] Recheck the pinned scenario counts (4,160 / 1,152 / 150 / 222), the random kind counts
      (53 / 48 / 49) and the mutation table against that master.
- [ ] Mention in the issue that `settlement.test.ts`'s property test has the same seeding
      flaw (every graph has 4 nodes for seeds 1–200), and offer a shared seeded-PRNG helper,
      since the new test copies `lcg` and `randomInt` ("Avoid Repetitive Code").
- [ ] Mind the date: in October, open the issue or forum topic first and wait for a reply, so
      the PR does not read as Hacktoberfest credit-seeking.
- [ ] Rewrite the commit message and the issue text in your own words.
- [ ] Settle the author email and the CLA account.
- [ ] Open the issue or forum topic, and wait for a reply before the PR.

Before item 2 (seam RFC):
- [ ] Item 1 has a reply.
- [ ] Rebase 0003 and 0004. Rerun every neutrality leg: `engine`, `compat`, `cli-v2`, and
      `engine-int` and `compat-int` on Postgres. Update the RFC's table.
- [ ] Decide the injection shape to propose. `AGENTS.md`'s composition-root precedent (the
      admittance policy) favours option-only (RFC, "The precedent it follows"). If
      option-only, write it as 0004b and run its legs.
- [ ] Keep the four kinds of result apart in the post: neutrality legs, policy-entering cases,
      settlement evidence, integration results.
- [ ] Rewrite the RFC in your own words. Check the framing: an optional extension point beside
      n8n's planner, never a replacement or an improvement claim.
- [ ] Fill the PR template: summary, how to test, links to the forum topic.

Before item 3 (tool-call round RFC):
- [ ] Item 2 has a reply, or the owner decides to send item 3 anyway.
- [ ] Recheck gap 1 and gap 2 on current master. Either may have closed.
- [ ] Rerun the corpus count: `node upstream/count-agent-entries.mjs` from the repository root.
- [ ] Decide whether to offer the model port (not built) or the property test extension
      first.
- [ ] Rewrite in your own words, and post as discussion only, with no code.

After any post:
- [ ] Reply to requested changes within 14 days. `CONTRIBUTING.md` auto-closes PRs after that.
- [ ] Record what was posted, where, and when in this file.
