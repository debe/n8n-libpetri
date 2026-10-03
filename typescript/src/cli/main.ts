#!/usr/bin/env node
/**
 * The `n8n-libpetri` process entry point (`package.json` `bin`). Its whole body is the
 * invocation, for the reason `verify/main.ts` gives: under tsup's code splitting an
 * `import.meta.url` guard compares a chunk's URL and is never true.
 */
import { dispatch } from './dispatch.js';
import { exitWith } from './exit.js';
import { nodeIo } from './io.js';

exitWith(() => dispatch(process.argv.slice(2), nodeIo));
