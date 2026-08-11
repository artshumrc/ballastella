// The build lock in `e2e-build.mjs`: letting go of it, and noticing when somebody else did not.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: THE LOCK HAD A COMMENT PROMISING RECOVERY AND NO CODE THAT DID IT.        │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Two faults shipped together and neither could fail visibly, because a lock is only exercised when
// something goes wrong:
//
//   - `build()` called `process.exit()` on a failed build, and `process.exit` skips `finally`, so
//     the lock leaked on the first failure or the first ^C;
//   - `lockIsStale()` treated a throw from `process.kill(pid, 0)` as "still running", when `ESRCH`
//     is precisely the opposite — so the leaked lock was never broken.
//
// One failed build then wedged every later run for fifteen minutes at a time. The tests below are
// the ones that would have caught it: both directions of the signal, and the exit path itself, in a
// real child process, because that is the only place `process.exit` semantics are real.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	utimesSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	OUTPUTS,
	lockIsStale,
	ownerIsGone,
	releaseLock,
	releaseOwnLock,
	takeLock
} from './e2e-build.mjs';

/** This module's subject, as a URL a spawned child can `import`, and as a path it can be run from. */
const moduleUrl = new URL('./e2e-build.mjs', import.meta.url).href;
const scriptPath = fileURLToPath(moduleUrl);
const scratch = () => mkdtempSync(path.join(tmpdir(), 'ballastella-lock-'));

/** A pid that is certainly not running: claimed and reaped inside this test. */
const deadPid = () => {
	const finished = spawnSync(process.execPath, ['-e', '']);
	return finished.pid;
};

test('a live process is not gone', () => {
	assert.equal(ownerIsGone(process.pid), false);
});

test('a process that has exited is gone — the direction the old code had inverted', () => {
	// `process.kill(pid, 0)` THROWS `ESRCH` here. Reading that throw as "still running" is what made
	// the recovery path dead code.
	assert.equal(ownerIsGone(deadPid()), true);
});

test('a process this user may not signal is treated as alive, not as gone', () => {
	// pid 1 raises `EPERM` for an unprivileged user — a live process owned by somebody else. Guessing
	// "gone" there would break a lock somebody's build is holding. (Running as root, `kill` simply
	// succeeds, which is the same answer.)
	assert.equal(ownerIsGone(1), false);
});

test('a lock held by a live process is not stale', () => {
	const directory = path.join(scratch(), 'build.lock');
	try {
		assert.equal(takeLock(directory), true);
		assert.equal(lockIsStale(directory), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a lock whose owner has exited is stale, and can then be taken', () => {
	const directory = path.join(scratch(), 'build.lock');
	try {
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: deadPid() }));

		assert.equal(lockIsStale(directory), true);
		releaseLock(directory);
		assert.equal(takeLock(directory), true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a lock older than any real build is stale even if some process still holds that pid', () => {
	// The backstop for a pid that has been recycled onto an unrelated process. Fifteen minutes is far
	// longer than a build, which is seconds.
	const directory = path.join(scratch(), 'build.lock');
	try {
		takeLock(directory);
		const longAgo = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(directory, longAgo, longAgo);
		assert.equal(lockIsStale(directory), true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a lock taken between its mkdir and its owner file is not stale', () => {
	// The window where the holder exists but has not said who it is. Answering "stale" here would let
	// a second process snatch a lock a first had just taken, which is the double build the lock
	// exists to prevent.
	const directory = path.join(scratch(), 'build.lock');
	try {
		mkdirSync(directory, { recursive: true });
		assert.equal(lockIsStale(directory), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * Run a child that takes `directory` as its lock, wires up the release, and then ends as told.
 *
 * A real child process, because `process.exit` and signal defaults cannot be observed in-process —
 * which is exactly why the leak shipped: the old `finally { releaseLock() }` read correctly and
 * never ran.
 */
const childHoldingTheLock = (directory, ending) =>
	spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			[
				`import { takeLock, releaseOnExit } from ${JSON.stringify(moduleUrl)};`,
				`const directory = ${JSON.stringify(directory)};`,
				`if (!takeLock(directory)) process.exit(9);`,
				`releaseOnExit(directory);`,
				`console.log('held');`,
				ending
			].join('\n')
		],
		{ encoding: 'utf8', timeout: 20_000 }
	);

test('the lock is released when the process exits non-zero, not only when it returns', () => {
	// The failed-build path. `build()` used to `process.exit(status)` here, straight past the
	// `finally`.
	const directory = path.join(scratch(), 'build.lock');
	const result = childHoldingTheLock(directory, 'process.exit(3);');
	assert.equal(result.status, 3, result.stderr);
	assert.equal(
		existsSync(directory),
		false,
		'the lock survived a process that exited while holding it'
	);
});

test('the lock is released when the process throws while holding it', () => {
	const directory = path.join(scratch(), 'build.lock');
	const result = childHoldingTheLock(directory, 'throw new Error("the build blew up");');
	assert.equal(result.status, 1, result.stderr);
	assert.equal(existsSync(directory), false, 'the lock survived an uncaught throw');
});

test('the lock is released on ^C, whose default action skips exit handlers', () => {
	// The other half, and the likelier one: a two-minute build is a thing implementers interrupt.
	// `SIGINT`'s default terminates the process without running `exit` handlers, so this needs its own
	// listener and its own test.
	const directory = path.join(scratch(), 'build.lock');
	const result = childHoldingTheLock(
		directory,
		'process.kill(process.pid, "SIGINT"); setTimeout(() => {}, 10_000);'
	);
	assert.equal(result.status, 130, result.stderr);
	assert.equal(existsSync(directory), false, 'the lock survived an interrupt');
});

test('releasing does not remove a lock another process has since taken', () => {
	// **Letting go is a race of its own.** Legal, quick sequence: A releases in its `finally`, B takes
	// the lock and writes its own pid, A exits and its still-registered handler deletes B's lock. Two
	// builds then run over one output directory with no error anywhere — the thing this whole file
	// exists to prevent, reintroduced by the fix for the leak.
	const directory = path.join(scratch(), 'build.lock');
	try {
		takeLock(directory); // ours
		releaseOwnLock(directory);
		// Somebody else, now.
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid + 1 }));

		assert.equal(releaseOwnLock(directory), false, 'it claimed a lock it does not own');
		assert.equal(existsSync(directory), true, "it deleted another process's lock");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('releasing leaves alone a lock whose owner has not written its pid yet', () => {
	// The window between a new holder's `mkdir` and its `writeFileSync`. Guessing "ours" here would
	// delete a lock somebody took microseconds ago.
	const directory = path.join(scratch(), 'build.lock');
	try {
		mkdirSync(directory, { recursive: true });
		assert.equal(releaseOwnLock(directory), false);
		assert.equal(existsSync(directory), true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('the exit handlers are disarmed once the lock has been released normally', () => {
	// The other half of not overreaching: in the ordinary case the handlers should not run at all.
	// The child releases, disarms, then lets a *different* owner take the lock and exits — and the
	// lock must still be there.
	const directory = path.join(scratch(), 'build.lock');
	const result = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			[
				`import { mkdirSync, writeFileSync } from 'node:fs';`,
				`import path from 'node:path';`,
				`import { takeLock, releaseOnExit, releaseOwnLock } from ${JSON.stringify(moduleUrl)};`,
				`const directory = ${JSON.stringify(directory)};`,
				`if (!takeLock(directory)) process.exit(9);`,
				`const disarm = releaseOnExit(directory);`,
				`releaseOwnLock(directory);`,
				`disarm();`,
				// Somebody else takes it before we finish exiting.
				`mkdirSync(directory, { recursive: true });`,
				`writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }));`,
				`process.exit(0);`
			].join('\n')
		],
		{ encoding: 'utf8', timeout: 20_000 }
	);
	try {
		assert.equal(result.status, 0, result.stderr);
		// Note the successor's pid is *this child's own* pid, so an ownership check alone would not
		// save it. Only the disarm does, which is why both are here.
		assert.equal(
			existsSync(directory),
			true,
			"an exit handler that was supposed to be disarmed deleted the successor's lock"
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AND THE WIRING, WHICH IS WHERE THE ORIGINAL DEFECT ACTUALLY LIVED.
//
// Everything above pins `releaseOnExit` as a unit. All of it still passes if `build()` goes back to
// calling `process.exit(status)` *and* `main()` stops calling `releaseOnExit` — which is precisely
// the bug that shipped. A fence around the fix is not a fence around the bug, so the script itself
// is run, with a build made to fail.

/** Where `e2e-build.mjs` keeps its lock, derived the same way the script derives it. */
const repoLockDirectory = path.resolve(
	path.dirname(scriptPath),
	'..',
	'node_modules/.cache/ballastella-e2e/build.lock'
);

test('running the script with a failing build leaves no lock behind', (t) => {
	// A lock left by a *live* build would make this hang rather than fail, so it is skipped instead —
	// the honest answer, since the thing under test cannot be observed while somebody else holds it.
	if (existsSync(repoLockDirectory) && !lockIsStale(repoLockDirectory)) {
		t.skip('a live build holds the repository lock');
		return;
	}
	releaseLock(repoLockDirectory);

	// `PATH=''` makes `pnpm` unfindable, so `build()` fails in milliseconds instead of after a real
	// two-app build. `BALLASTELLA_E2E_FORCE_BUILD=1` gets past the up-to-date check, which would
	// otherwise return before the lock is ever taken.
	const result = spawnSync(process.execPath, [scriptPath], {
		encoding: 'utf8',
		timeout: 60_000,
		env: { ...process.env, PATH: '', BALLASTELLA_E2E_FORCE_BUILD: '1' }
	});

	assert.notEqual(result.status, 0, 'a failing build should fail the script');
	assert.equal(
		existsSync(repoLockDirectory),
		false,
		'the script leaked its lock on a failed build — the defect this file exists for'
	);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE OTHER WAY A STALE BUILD GETS SERVED: THE RIGHT FILES, FROM THE WRONG BUILD.
//
// `pnpm build:deploy` writes the same `apps/editor/build` from a filtered source tree, leaving the
// `/image-pane` harness route and the test fixtures out (`scripts/stage-deploy-build.mjs`). Its
// inputs are the same bytes, so the fingerprint matches; only the *output* differs. `OUTPUTS` is
// therefore the sole thing standing between a developer who ran a deployment build and a suite
// silently served it, and the guard works only while at least one entry names something a
// deployment build does not produce.
//
// Read out of both scripts rather than restated, because the failure is drift: rename the excluded
// directory, or drop the sentinel as a redundant-looking path, and the guard goes quiet while
// looking exactly as it does now.

test('OUTPUTS names something a deployment build does not produce, so the two are told apart', () => {
	const staging = readFileSync(new URL('./stage-deploy-build.mjs', import.meta.url), 'utf8');
	const omitted = [...staging.matchAll(/^\s*omit: '([^']+)'/gm)].map((match) => match[1]);

	// If this is empty the assertion below would pass vacuously — which is the shape of a guard that
	// has quietly stopped guarding, so it is refused outright.
	assert.ok(
		omitted.length > 0,
		'no `omit:` entries found in stage-deploy-build.mjs — this test can no longer tell what a ' +
			'deployment build leaves out, so it cannot check that OUTPUTS distinguishes one.'
	);

	const sentinels = OUTPUTS.filter((output) => omitted.some((name) => output.includes(name)));
	assert.ok(
		sentinels.length > 0,
		`OUTPUTS names none of what a deployment build omits (${omitted.join(', ')}), so an ` +
			'ordinary build and a deployment build are indistinguishable to the stamp and the e2e ' +
			'suite can be served the wrong one. Keep a path in OUTPUTS that only the ordinary build ' +
			'writes — see the comment on OUTPUTS in e2e-build.mjs.'
	);
});
