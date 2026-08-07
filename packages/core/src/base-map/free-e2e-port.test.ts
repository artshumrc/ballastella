import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// `scripts/free-e2e-port.mjs`'s pid parse, pinned.
//
// It lives beside `deployment-fence.test.ts` for the same reason that one does: `pnpm -r test` is
// what CI runs, root-level scripts are not a workspace package, and a test nobody runs is not a
// test. The subject is the e2e harness rather than the Base Map, which is the one awkward thing
// about this address.
//
// **Why it exists.** The obvious spelling of the parse —
// `out.split(/\s+/).map(Number).filter(Number.isInteger)` — is wrong in a way that looks right and
// logs like success. A trailing empty string becomes `0`, and POSIX defines pid 0 as *every process
// in the caller's process group*, so `process.kill(0, 'SIGTERM')` neither fails nor no-ops: the
// script terminated itself, its shell, and its siblings, exited 143, and took down the `&&` chain it
// runs in, so the build never happened and the suite never started. It printed
// `free-e2e-port: stopped pid …` first, so the log read as success.
//
// That was caught by running the script against a decoy listener and noticing the exit code, not by
// anything failing. These assertions are what keep it caught.

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../../..', 'scripts/free-e2e-port.mjs');

const { parsePids } = (await import(script)) as { parsePids: (out: string) => number[] };

describe('free-e2e-port parsePids', () => {
	it('never yields pid 0, whatever trailing whitespace the tool leaves', () => {
		// `lsof -t` output, which is what actually produced the bug.
		expect(parsePids('1987028\n')).toEqual([1987028]);
		expect(parsePids('1987028\n1987029\n')).toEqual([1987028, 1987029]);
		expect(parsePids('')).toEqual([]);
		expect(parsePids('\n')).toEqual([]);
		expect(parsePids('   \n  \n')).toEqual([]);
	});

	it('reads `fuser` output, which pads with spaces rather than newlines', () => {
		expect(parsePids(' 1987028  1987029\n')).toEqual([1987028, 1987029]);
	});

	it('refuses a literal 0 even when a tool reports one', () => {
		// Not hypothetical tidiness: 0 is the entire hazard, so it is refused in its own right
		// rather than only as a side effect of how whitespace happens to be handled.
		expect(parsePids('0\n')).toEqual([]);
		expect(parsePids('0 1987028\n')).toEqual([1987028]);
	});

	it('never yields this process, so freeing a port cannot stop the run doing the freeing', () => {
		expect(parsePids(`${process.pid}\n`)).toEqual([]);
		expect(parsePids(`${process.pid} 1987028\n`)).toEqual([1987028]);
	});

	it('ignores anything that is not a run of digits', () => {
		// `fuser` writes `20003/tcp:` alongside its pids, and a future tool swap should not be able
		// to turn stray text into a signal target.
		expect(parsePids('20003/tcp: 1987028\n')).toEqual([1987028]);
		expect(parsePids('-1\n')).toEqual([]);
		expect(parsePids('nope\n')).toEqual([]);
	});
});
