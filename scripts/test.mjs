#!/usr/bin/env node
/**
 * Test runner for `npm test`.
 *
 * Runs the unit suite with `node --test` in a single process
 * (`--test-isolation=none`), so the whole suite shares one process and no
 * per-file child processes are spawned.
 *
 * The isolation flag has two names depending on the Node major:
 *   - Node 22:  `--experimental-test-isolation=none` (experimental name)
 *   - Node 23+: `--test-isolation=none` (stable name; the experimental name
 *     is kept as an alias)
 * Instead of hard-coding a version boundary, probe the stable name first:
 * Node exits with status 9 for a "bad option" (V8 bad-option exit code), so a
 * 9 means the flag is unknown on this Node and we retry with the
 * experimental name. A genuine test failure exits with the test runner's
 * non-zero status (1), which is propagated unchanged.
 */
import { spawnSync } from 'node:child_process';

const TEST_ARGS = ['--test', 'test/unit/*.test.mjs'];

function run(flag) {
  return spawnSync(process.execPath, [flag, ...TEST_ARGS], { stdio: 'inherit' });
}

let result = run('--test-isolation=none');
if (result.status === 9) {
  result = run('--experimental-test-isolation=none');
}
process.exit(result.status === null ? 1 : result.status);
