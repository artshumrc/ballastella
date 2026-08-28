#!/usr/bin/env node
// Build both apps for the e2e suite: once per run, and only when a source has actually changed.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: TWO WEB SERVERS EACH BUILT THE VIEWER, AT THE SAME TIME, INTO ONE FOLDER. │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// `playwright.config.ts` declares two `webServer` entries and Playwright starts them **in
// parallel**. Each one used to be `build && vite preview`, and both of those builds produce
// `apps/viewer/build`:
//
//   - the viewer's own `vite build` writes it, emptying the directory first;
//   - the editor's `build` is `stage:viewer && vite build`, and `stage:viewer` is
//     `pnpm --filter @ballastella/viewer run build && node scripts/stage-viewer-bundle.mjs` —
//     it writes the same directory and then *copies it* into `apps/editor/static/viewer-bundle`.
//
// So every run had two `vite build` processes racing over one output directory while a third step
// read that directory to stage it. A copy that lands mid-empty stages a partial viewer into the
// editor, and the editor then ships a Publish button whose bundle is missing files — which shows up
// as an unrelated-looking failure in `editor-publish`, `editor-transfer` or `editor-pwa`, in one run
// and not the next. Nothing errors; the build reports success both times.
//
// The fix is that there is now exactly one build, sequential, shared: the editor's own `build`
// already builds the viewer, stages it, and then builds the editor, so one invocation produces both
// `apps/viewer/build` and `apps/editor/build` in the right order. Both web-server commands call this
// script; the first one through does the work under a lock and the second finds it done.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// AND WHY IT IS ALSO ALLOWED TO SKIP
//
// The build was inside the web-server command so that a run could never test a stale build, and
// `reuseExistingServer` was turned off because "something answers on the port" is not an answer to
// "is this build current". That reasoning is kept. What replaces it is a stronger question, asked of
// the files rather than of a socket: a SHA-256 over every build input, compared with the fingerprint
// recorded beside the last build. Unchanged inputs mean the output on disk is the output this build
// would produce, so it is served as it stands; anything else rebuilds.
//
// The inputs are an explicit allowlist ({@link INPUT_ROOTS} and {@link INPUT_FILES}) rather than
// "the whole repository", so that editing documentation does not cost a two-minute rebuild.
// **Adding a new source directory to either app means adding it here.** Erring on the side of
// including something costs a rebuild; erring on the side of leaving something out is the stale
// build this whole file exists to prevent, so when in doubt, include it.
//
// `BALLASTELLA_E2E_FORCE_BUILD=1` rebuilds unconditionally.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories walked in full, minus {@link SKIP_DIRECTORIES}. */
const INPUT_ROOTS = ['apps', 'packages', 'patches'];

/**
 * Individual files that change what a build produces.
 *
 * `scripts/` is deliberately **not** an input root. It once was, and that made editing
 * `retry-budget.mjs` — a reporter that runs long after both apps are built — force a full two-app
 * rebuild, which is the opposite of the allowlist's purpose. Exactly one script is a build input:
 * `stage-viewer-bundle.mjs`, which the editor's `build` runs to copy the viewer into its assets. If
 * another script joins the build, it belongs on this list.
 */
const INPUT_FILES = [
	'package.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'tsconfig.json',
	'scripts/stage-viewer-bundle.mjs'
];

/**
 * Directory names never walked.
 *
 * All of them are *output* — a build product, a cache, or a test artefact. Hashing them would make
 * the fingerprint depend on the previous build and so never match.
 */
const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'.svelte-kit',
	'build',
	'dist',
	'.vite',
	'test-results',
	'__screenshots__',
	'.vitest-attachments',
	// `stage-viewer-bundle.mjs` writes this from `apps/viewer/build`; it is output living under a
	// source tree, and it is the one entry here that is easy to mistake for an input.
	'viewer-bundle',
	// `stage-deploy-build.mjs` writes `apps/editor/.deploy` — a filtered copy of `src/routes` and
	// `static` that only a deployment build reads. Output under a source tree, like `viewer-bundle`
	// above, and `INPUT_ROOTS` includes `apps` wholesale, so without this entry the fingerprint
	// would take a copy of the source into account *as well as* the source, and every deployment
	// build would invalidate the e2e build that has nothing to do with it.
	'.deploy'
]);

const cacheDirectory = path.join(repoRoot, 'node_modules/.cache/ballastella-e2e');
const stampFile = path.join(cacheDirectory, 'build-stamp.json');
const lockDirectory = path.join(cacheDirectory, 'build.lock');

/** Every build input, as repo-relative paths, in a stable order. */
const inputFiles = () => {
	const found = [];
	const walk = (relative) => {
		for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORIES.has(entry.name)) continue;
				walk(path.join(relative, entry.name));
			} else if (entry.isFile()) {
				found.push(path.join(relative, entry.name));
			}
		}
	};
	for (const root of INPUT_ROOTS) if (existsSync(path.join(repoRoot, root))) walk(root);
	for (const file of INPUT_FILES) if (existsSync(path.join(repoRoot, file))) found.push(file);
	return found.sort();
};

/**
 * A SHA-256 over the *contents* of every input, with its path.
 *
 * Contents rather than mtimes: `git checkout` and `git stash` rewrite mtimes on files whose bytes
 * did not change, and — the direction that matters — restore bytes without always moving the mtime
 * forward. An mtime stamp would rebuild constantly while a branch is switched and skip the one
 * rebuild that mattered.
 */
const fingerprint = () => {
	const digest = createHash('sha256');
	for (const file of inputFiles()) {
		digest.update(file);
		digest.update('\0');
		digest.update(readFileSync(path.join(repoRoot, file)));
		digest.update('\0');
	}
	return digest.digest('hex');
};

/**
 * The built output both preview servers will serve, as the things that must exist for a skip.
 *
 * **`image-pane.html` is here to tell the two editor builds apart, and it is load-bearing.**
 * `pnpm build:deploy` writes the same `apps/editor/build` from a filtered source tree with the
 * `/image-pane` harness route and the test fixtures left out (`scripts/stage-deploy-build.mjs`).
 * Its inputs are the same files, so the fingerprint matches — and with only `index.html` on this
 * list, a developer who had run a deployment build would then have the suite silently served it.
 * `editor-image-pane.e2e.ts` would fail on a missing route and `editor-pwa.e2e.ts` on a missing
 * entry, both for a reason nothing on screen connects to a build they ran earlier. That is exactly
 * the stale-build failure this whole stamp exists to prevent, arriving through the one door the
 * stamp could not see.
 *
 * One sentinel is enough: the harness route and the fixtures are omitted by the same build, so a
 * tree holding this document holds both.
 */
export const OUTPUTS = [
	'apps/editor/build/index.html',
	'apps/editor/build/image-pane.html',
	'apps/viewer/build/index.html'
];

const outputsPresent = () => OUTPUTS.every((file) => existsSync(path.join(repoRoot, file)));

const readStamp = () => {
	try {
		return JSON.parse(readFileSync(stampFile, 'utf8'));
	} catch {
		return null;
	}
};

/**
 * `mkdir` as a mutual exclusion, held for the length of one build.
 *
 * The two web-server commands start together, so without this they would both decide the build is
 * stale and both run it — reinstating the race this file exists to remove. `mkdir` is the primitive
 * because it is atomic on every filesystem this runs on, unlike "check then create".
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ A LEAKED LOCK WEDGES THE SUITE, SO BOTH HALVES OF LETTING GO ARE LOAD-BEARING.             │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The first cut of this had a comment promising a lock whose owner is gone would be broken rather
 * than waited on, and code that did neither. Two independent faults, found by review:
 *
 * 1. **It leaked.** `build()` called `process.exit()` on a failed build, and `process.exit` does not
 *    run a `finally`. So the first failing build — or the first ^C — left the lock behind for good.
 * 2. **Recovery was dead code.** `process.kill(pid, 0)` **throws** when the process is gone
 *    (`ESRCH`); the old `catch` returned `false`, so a dead owner was judged alive. The signal's
 *    semantics are inverted from the way they read: *returning* means alive, and of the two throws
 *    only `ESRCH` means gone — `EPERM` means alive and owned by somebody else.
 *
 * Together those turned one failed build into a suite that wedged for fifteen minutes, and then for
 * fifteen minutes again, which is a worse outcome than the double build the lock exists to prevent.
 *
 * So: nothing calls `process.exit` while the lock is held, and {@link releaseOnExit} registers the
 * release on `exit` *and* on the two signals that would otherwise skip it.
 */
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_POLL_MS = 250;

export const takeLock = (directory = lockDirectory) => {
	try {
		mkdirSync(directory, { recursive: false });
		writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }));
		return true;
	} catch {
		return false;
	}
};

/**
 * Remove the lock at `directory`, whoever holds it.
 *
 * The unconditional form, for exactly one caller: breaking a lock whose owner {@link lockIsStale}
 * has shown to be gone. Everything else wants {@link releaseOwnLock}.
 */
export const releaseLock = (directory = lockDirectory) =>
	rmSync(directory, { recursive: true, force: true });

/**
 * Remove the lock **only if this process still holds it**.
 *
 * ⚠ Without the check, letting go is a race of its own — and it is the same defect class as the one
 * the ownership-less `lockIsStale` was: a check that isn't. The sequence is legal and quick:
 * process A finishes its build and releases in its `finally`; process B, polling, takes the lock and
 * writes its own `owner.json`; A then *exits*, and an unconditional exit handler deletes the lock
 * out from under B. Two builds run concurrently over one output directory, which is the whole thing
 * this file exists to prevent, and neither process ever sees an error.
 *
 * An unreadable or absent `owner.json` means "not ours" and is left alone. That covers the window in
 * which a new holder has made the directory but not yet written its pid — guessing "ours" there
 * would delete a lock somebody took microseconds ago.
 */
export const releaseOwnLock = (directory = lockDirectory) => {
	let owner;
	try {
		owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
	} catch {
		return false;
	}
	if (owner?.pid !== process.pid) return false;
	releaseLock(directory);
	return true;
};

/**
 * Whether the process that holds the lock is gone, from what `process.kill(pid, 0)` did.
 *
 * Exported because this is the inversion that made the recovery dead code, and a comment is not
 * enough to keep it right. Read it as: **no throw means alive**, `ESRCH` means gone, and anything
 * else — `EPERM`, from a lock taken by another user — means alive and not ours to judge.
 */
export const ownerIsGone = (pid) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch (cause) {
		if (cause?.code === 'ESRCH') return true;
		// `EPERM` is a live process this user may not signal. Anything else is unexpected, and
		// "assume alive" is the answer that cannot break somebody else's running build.
		return false;
	}
};

/**
 * Whether the lock may be broken: its owner has gone, or it is older than any real build.
 *
 * `now` and `directory` are parameters so this is testable without a build around it — the whole
 * point of the finding is that it was never exercised.
 */
export const lockIsStale = (directory = lockDirectory, now = Date.now()) => {
	let owner;
	try {
		if (now - statSync(directory).mtimeMs > LOCK_STALE_MS) return true;
		owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
	} catch {
		// The lock is gone (the caller will simply take it), or the holder is between its `mkdir` and
		// its `writeFileSync`. The second resolves in milliseconds, so "not stale, poll again" is the
		// answer that cannot snatch a lock somebody just took.
		return false;
	}
	return typeof owner?.pid === 'number' && ownerIsGone(owner.pid);
};

/**
 * Let go of the lock however this process ends. Returns a function that disarms it again.
 *
 * `exit` covers a normal return and an uncaught throw. The two signals are covered explicitly
 * because their default action terminates the process *without* running `exit` handlers — and ^C
 * during a two-minute build is not a rare event, it is how an implementer changes their mind.
 *
 * **Both halves of not overreaching are here.** The handlers use {@link releaseOwnLock}, so they can
 * only remove a lock this process still owns; and the caller disarms them once it has released
 * normally, so in the ordinary case they never run at all. Either alone would be correct; the
 * ownership check is the invariant and the disarm is the thing that makes the invariant cheap.
 */
export const releaseOnExit = (directory) => {
	const release = () => releaseOwnLock(directory);
	const onSignal = (signal) => () => {
		release();
		// The conventional exit code for a signal, and re-raising rather than exiting 0 so a parent
		// `&&` chain still stops.
		process.exit(signal === 'SIGINT' ? 130 : 143);
	};
	const handlers = [
		['exit', release],
		['SIGINT', onSignal('SIGINT')],
		['SIGTERM', onSignal('SIGTERM')]
	];
	for (const [event, handler] of handlers) process.on(event, handler);
	return () => {
		for (const [event, handler] of handlers) process.off(event, handler);
	};
};

/**
 * Build both apps. Returns the exit status; **never exits the process**, because the caller holds
 * the lock and `process.exit` would skip its release.
 *
 * The editor's `build` is `stage:viewer && vite build`, and `stage:viewer` builds the viewer first —
 * so this one command produces `apps/viewer/build`, stages it into the editor, and then builds the
 * editor, in that order and in one process tree. Running the viewer's build as well would be the
 * concurrent write this script removes.
 */
const build = () => {
	const result = spawnSync('pnpm', ['--filter', '@ballastella/editor', 'run', 'build'], {
		cwd: repoRoot,
		stdio: 'inherit'
	});
	return result.status ?? 1;
};

const main = () => {
	mkdirSync(cacheDirectory, { recursive: true });
	const forced = process.env.BALLASTELLA_E2E_FORCE_BUILD === '1';

	for (;;) {
		const wanted = fingerprint();
		const stamp = readStamp();
		if (!forced && stamp?.fingerprint === wanted && outputsPresent()) {
			console.log(`e2e-build: apps/*/build are current (${wanted.slice(0, 12)}) — not rebuilding`);
			return 0;
		}
		if (takeLock()) {
			// Registered *after* the lock is held, so a process that never took it cannot delete one
			// somebody else did — and disarmed in the `finally`, so it cannot delete one taken by
			// whoever comes next.
			const disarm = releaseOnExit(lockDirectory);
			try {
				console.log('e2e-build: building both apps…');
				const started = Date.now();
				const status = build();
				// A failed build leaves no stamp, so the next run tries again rather than serving whatever
				// half-written output is on disk. Returned rather than exited, so the lock is released by
				// the `finally` below — `process.exit` here is what leaked it.
				if (status !== 0) return status;
				// Fingerprinted *after* the build, so that a source edited while the build was running
				// leaves a stamp that no longer matches and the next run rebuilds.
				writeFileSync(stampFile, JSON.stringify({ fingerprint: fingerprint() }));
				console.log(`e2e-build: built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
			} finally {
				releaseOwnLock(lockDirectory);
				disarm();
			}
			return 0;
		}
		if (lockIsStale()) {
			console.warn('e2e-build: breaking a lock whose owner is gone');
			releaseLock();
			continue;
		}
		sleep(LOCK_POLL_MS);
	}
};

/** Block the process. Deliberately synchronous: this script is a gate, not a server. */
const sleep = (ms) => {
	const until = Date.now() + ms;
	while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
};

// Only when run as a command. Importing this module — which `e2e-build.test.mjs` does, so that the
// lock can be exercised without a two-minute build attached — must not build anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	process.exitCode = main();
}
