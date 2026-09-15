/**
 * The one `sleep` the suites use: the conformance harness's own
 * (`src/conformance/harness/scripts.ts`), which the node scripts already await, so a test and
 * the scripts it drives wait the same way.
 */
export { sleep } from '../../src/conformance/index.js';
