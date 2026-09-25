/**
 * Records `tests/fixtures/v1-fingerprint.json` from the compiler as it is now.
 *
 *   cd typescript && npx tsx tests/compiler/v1-fingerprint.gen.ts [--force]
 *
 * The file is the v1 baseline of ADR 0012 (`tasks/v2-profile-plan.md`, step 1): it was recorded
 * before the compile profile existed, and a later change is expected to leave it alone. So
 * this script refuses to overwrite an existing file without `--force`. Regenerating it to make
 * `v1-identity.test.ts` pass is exactly the change the test exists to catch; use `--force` only
 * for a v1 change that is meant, and say so in the commit.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  FINGERPRINT_FILE, entryOf, subjects, type FingerprintEntry, type FingerprintFile,
} from './v1-fingerprint.js';

const force = process.argv.includes('--force');
if (existsSync(FINGERPRINT_FILE) && !force) {
  process.stderr.write(`${FINGERPRINT_FILE.pathname} exists; pass --force to overwrite the v1 baseline\n`);
  process.exit(1);
}

// `libpetri/package.json` is not in the package's exports map, so it is read off the install.
const libpetri = (JSON.parse(readFileSync(
  new URL('../../node_modules/libpetri/package.json', import.meta.url), 'utf8')) as { version: string }).version;
const recorded: Record<string, FingerprintEntry> = {};
for (const subject of subjects()) recorded[subject.key] = entryOf(subject);

const file: FingerprintFile = {
  comment: 'v1 net fingerprint (ADR 0012, tasks/v2-profile-plan.md step 1). Written by '
    + 'tests/compiler/v1-fingerprint.gen.ts, checked by tests/compiler/v1-identity.test.ts. Do not edit.',
  libpetri,
  subjects: recorded,
};
writeFileSync(FINGERPRINT_FILE, `${JSON.stringify(file, null, 1)}\n`);
process.stdout.write(`wrote ${Object.keys(recorded).length} subjects to ${FINGERPRINT_FILE.pathname}\n`);
