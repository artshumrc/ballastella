// Free a port before Playwright's web server builds and binds it.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: A LEFTOVER SERVER SERVES A PREVIOUS BUILD, AND NOTHING SAYS SO.           │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// `serveStatic` is `build && vite preview`, so the build is *inside* the web-server command.
// Playwright's `reuseExistingServer` decides whether to run that command by asking one question:
// is something already answering on this port? If yes it skips the command **whole** — including
// the build. The suite then runs against whatever that process is serving, which is the last build
// somebody made, in this tree or another checkout.
//
// This is not theoretical. An implementer working this repo hit eighteen simultaneous failures in
// `editor-base-map.e2e.ts` and spent time reading them as a code defect; the cause was a reused
// `vite preview` from an earlier run serving pre-change HTML. A later sweep of the machine found
// seven stray preview processes still listening. The failure mode is the worst kind: not an error,
// but confident red or green about code that is not the code under test.
//
// The port hashing in `playwright.config.ts` fixed the *cross-checkout* half of this — two trees no
// longer collide. It does nothing for a stale server in the same tree on the same port, which is
// the common case, because the port is stable per checkout by design.
//
// So the command now frees its own port first and `reuseExistingServer` is off by default. The cost
// is a rebuild per run. `BALLASTELLA_E2E_REUSE=1` opts back in for fast iteration against a build
// you know is current — deliberately an opt-in, because the default has to be correct rather than
// quick.

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Process ids listening on `port`, via whichever tool this machine has.
 *
 * Both `lsof` and `fuser` exit non-zero when nothing matches, which is the ordinary case, so a
 * non-zero exit is read as "nothing there" rather than as a failure. A machine with neither tool
 * gets an empty list and the build proceeds — `--strictPort` will then fail loudly with the real
 * problem, which is better than this script inventing one.
 *
 * ⚠ **`> 0` is load-bearing, and leaving it out cost an afternoon.** Splitting the output on
 * whitespace leaves a trailing empty string, `Number('')` is `0`, and `Number.isInteger(0)` is true
 * — so the list contained a pid `0`. `process.kill(0, …)` does not fail and does not no-op: POSIX
 * defines pid 0 as *every process in the caller's process group*. The script SIGTERMed itself, the
 * shell around it, and its siblings, then exited 143 — which, in the `&&` chain this runs in, means
 * the build never happens and the suite never starts. It printed "stopped pid …" first, so the log
 * looked like success. `scripts/free-e2e-port.test.mjs` pins the parse.
 */
const listeners = (port) => {
	for (const [command, args] of [
		['lsof', ['-t', `-i:${port}`, '-sTCP:LISTEN']],
		['fuser', [`${port}/tcp`]]
	]) {
		try {
			const out = execFileSync(command, args, {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore']
			});
			return parsePids(out);
		} catch {
			// Non-zero means no match, or the tool is absent. Try the next one.
		}
	}
	return [];
};

/**
 * Pids from `lsof -t` or `fuser` output: real process ids only, never this process, never `0`.
 *
 * Exported so the pid-0 hazard above is pinned by a test rather than by this comment.
 */
export const parsePids = (out) =>
	out
		.split(/\s+/)
		.filter((token) => /^\d+$/.test(token))
		.map(Number)
		.filter((pid) => pid > 0 && pid !== process.pid);

/** Free `port`, reporting what it stopped. Returns the number of processes signalled. */
export const freePort = (port) => {
	let stopped = 0;
	// SIGTERM, not SIGKILL: `vite preview` closes its listener on term, and a killed process can leave
	// the port in TIME_WAIT long enough for `--strictPort` to fail on a bind we were about to make.
	for (const pid of listeners(port)) {
		try {
			process.kill(pid, 'SIGTERM');
			stopped++;
			console.log(`free-e2e-port: stopped pid ${pid} holding port ${port}`);
		} catch (cause) {
			// Gone between listing and killing, or not ours to signal. Either way `--strictPort` is the
			// backstop and it reports the actual condition.
			console.warn(`free-e2e-port: could not stop pid ${pid} on port ${port}: ${cause}`);
		}
	}
	return stopped;
};

// Only when run as a command. Importing this module — which the test does — must not signal anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const port = Number(process.argv[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`free-e2e-port: expected a port number, got ${JSON.stringify(process.argv[2])}`);
		process.exit(2);
	}
	freePort(port);
}
