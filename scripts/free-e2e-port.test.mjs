// The pid parse in `free-e2e-port.mjs`, pinned.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY IT EXISTS: PID 0 IS EVERY PROCESS IN THE CALLER'S PROCESS GROUP.                       │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// The obvious spelling of the parse — `out.split(/\s+/).map(Number).filter(Number.isInteger)` — is
// wrong in a way that looks right and logs like success. A trailing empty string becomes `0`, and
// POSIX defines pid 0 as *every process in the caller's process group*, so
// `process.kill(0, 'SIGTERM')` neither fails nor no-ops: the script terminated itself, its shell,
// and its siblings, exited 143, and took down the `&&` chain it runs in — so the build never
// happened and the suite never started. It printed `free-e2e-port: stopped pid …` first, so the log
// read as success.
//
// That was caught by running the script against a decoy listener and noticing the exit code, not by
// anything failing. These assertions are what keep it caught.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY IT LIVES HERE NOW
//
// It used to be `packages/core/src/base-map/free-e2e-port.test.ts`, filed under the Base Map — which
// its own comment admitted was "the one awkward thing about this address" — for a reason that was
// true at the time: `pnpm -r test` does not reach the repository root, root scripts are not a
// workspace package, and a test nobody runs is not a test. That constraint was removed rather than
// worked around: `pnpm test` runs `node --test scripts/*.test.mjs`, and CI runs
// `pnpm test`. So the test sits beside its subject.
//
// It was also, briefly, in two places at once — this file and the Base Map one — each pinning the
// same function with slightly different cases. Consolidated here, keeping every case either had.

import assert from 'node:assert/strict';
import test from 'node:test';
import process from 'node:process';

import { parsePids } from './free-e2e-port.mjs';

test('reads the pids out of `lsof -t` output', () => {
	assert.deepEqual(parsePids('1987028\n'), [1987028]);
	assert.deepEqual(parsePids('1987028\n1987029\n'), [1987028, 1987029]);
});

test('reads `fuser` output, which pads with spaces rather than newlines', () => {
	assert.deepEqual(parsePids(' 1987028  1987029\n'), [1987028, 1987029]);
});

test('never yields pid 0, whatever whitespace the tool leaves behind', () => {
	// The whole reason this file exists. A trailing newline, a trailing space, a blank line and an
	// empty string all produce an empty token, and every one of them used to become a zero.
	for (const output of ['1987028\n', '1987028 ', '1987028\n\n', '\n1987028\n', '']) {
		assert.equal(
			parsePids(output).includes(0),
			false,
			`pid 0 slipped through for ${JSON.stringify(output)}`
		);
	}
	assert.deepEqual(parsePids(''), []);
	assert.deepEqual(parsePids('\n'), []);
	assert.deepEqual(parsePids('   \n  \n'), []);
});

test('refuses a literal 0 even when a tool reports one', () => {
	// Not hypothetical tidiness: 0 is the entire hazard, so it is refused in its own right rather
	// than only as a side effect of how whitespace happens to be handled.
	assert.deepEqual(parsePids('0\n'), []);
	assert.deepEqual(parsePids('0 1987028\n'), [1987028]);
});

test('never yields this process, so freeing a port cannot stop the run doing the freeing', () => {
	assert.deepEqual(parsePids(`${process.pid}\n`), []);
	assert.deepEqual(parsePids(`${process.pid} 1987028\n`), [1987028]);
});

test('ignores anything that is not a run of digits', () => {
	// `fuser` writes `20003/tcp:` alongside its pids, and a future tool swap should not be able to
	// turn stray text into a signal target.
	assert.deepEqual(parsePids('20003/tcp: 1987028\n'), [1987028]);
	assert.deepEqual(parsePids('-1\n'), []);
	assert.deepEqual(parsePids('nope\n'), []);
});
