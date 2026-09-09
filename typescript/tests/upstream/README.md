# Upstream reproducers

Runnable evidence behind the libpetri items in `tasks/todo.md` §4. Not vitest files: each is a
script that compiles an n8n-libpetri fixture into a libpetri net and asks libpetri a question,
so a libpetri change is measurable from here the moment it lands — `libpetri` resolves to the
local checkout at `/Users/db/repositories/libpetri/typescript`.

```bash
cd typescript
npx tsx tests/upstream/deadlock-witness.ts     # A: deadlockFree(sinks) cannot excuse a designed terminal
npx tsx tests/upstream/smt-cliff.ts            # B: Spacer stops proving at one pipeline stage before a join
npx tsx tests/upstream/class-key-duplicates.ts # C: the state-class key counts one marking once per clock order
npx tsx tests/upstream/smt-targets.ts          # B, isolated: which depth-1 targets prove and which stay unknown
npx tsx tests/upstream/inequality-lemmas.ts    # B, resolved: six sign-checked inequality lemmas prove them in 0.1 s
```

`tests/spikes/agent-round.test.ts` pins D — an `Out` branch is a set of places, so a firing that
deposits `n` tokens into one place is one branch and one token to every branch-enumerating
analysis.

Negative evidence on B, not scripted: twenty `fp.spacer.*` / `fp.xform.*` option sets on the
dumped depth-1 script all stay `unknown` at 60 s. The lever is the invariant class, not the
solver's configuration. (The encoder already states `m'_i ≥ 0` in every rule.)

Status, 2026-09-08: A, B, C and D are fixed in libpetri TypeScript — `sinkPlacesWhen` (VER-014),
the linear state-equation bound (VER-015) and the state equation with firing counters
(`stateEquation(true)`, VER-016), the canonical DBM key, and an IO-016 AC4 warning when a
firing writes more tokens than its branch names. `smt-cliff.ts` unmodified now reads
proven/proven/proven in 0.0 s; `deadlock-witness.ts` runs the three forms so each step is visible;
`class-key-duplicates.ts` reads 1.00×. `smt-targets.ts` and `inequality-lemmas.ts` remain as the
evidence the fix was built on.
