// Reading a file out of the Workspace from a test, once, correctly.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: THE SAME RETRY LOOP HAD BEEN WRITTEN FOUR TIMES, AND ONE COPY LACKED IT.  │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// The app writes atomically — a temp file, then `move()` over the destination (ADR-0017 rule 4) — so
// a read that lands inside that window does **not** return stale bytes. It raises: `NotFoundError`
// while the destination is momentarily gone, or `NotReadableError` as it is replaced. Every helper
// that reads the Workspace therefore has to retry, and four of them had grown their own copy of the
// loop with the same constants and the same reasoning in the comment.
//
// The fourth copy is why this module exists rather than the duplication being tolerated: it was the
// one *without* the retry, in `editor-alignment.e2e.ts`, and it was the last remaining failure in
// the ten measured runs of 2026-08-07 — `NotReadableError: The requested file could not be read`.
// A hazard that three helpers document at length and a fourth silently reproduces is not a comment
// problem.
//
// **The retry is on the read, never on an assertion.** Bytes that are genuinely absent are still
// absent after twenty attempts, so nothing here can turn a missing file into a passing test.

import type { Page } from './test.js';

/**
 * Twenty attempts, 25 ms apart — half a second, against a `move()` that takes microseconds.
 *
 * Generous on purpose: the cost of being wrong in one direction is a test that reports a file as
 * unreadable when the app was mid-write, and in the other it is half a second added to a failure
 * that was going to fail anyway.
 */
const READ_ATTEMPTS = 20;
const READ_RETRY_MS = 25;

/**
 * The text of a Workspace-rooted path, or `null` when it is not there.
 *
 * `path` is rooted at the Workspace, not at a Project — `amsterdam-1625/project.json`,
 * `alignments/blaeu.json`, `images/blaeu/info.json` — because that is what ADR-0023 made the
 * addressable thing: an Alignment and a pyramid belong to the Workspace and a Project directory is
 * just the first segment of some paths.
 *
 * `null` rather than a throw is the contract the polling callers want, since inside `expect.poll` an
 * absent file is a retry and not a failure. {@link readStoredFile} is the loud version.
 */
/**
 * The read, with **why it failed** carried back out of the page.
 *
 * The failure is stringified inside the browser because a `DOMException` does not survive the
 * `page.evaluate` boundary as itself. Keeping it is not decoration: `NotFoundError` and
 * `NotReadableError` mean different things here — the first is "no such file", which is usually the
 * test's answer, and the second is the atomic-replace window, which is usually the machine's. An
 * earlier version of this helper dropped the cause and made its own failures undiagnosable, which is
 * precisely the tax this ticket is about.
 */
const attemptRead = (
	page: Page,
	path: string
): Promise<{ text: string; failure: null } | { text: null; failure: string }> =>
	page.evaluate(
		async ([path, attempts, retryMs]) => {
			let failure = 'it was never attempted';
			for (let attempt = 0; attempt < (attempts as number); attempt += 1) {
				try {
					let handle = await workspaceRoot();
					const segments = (path as string).split('/').filter((segment) => segment !== '');
					for (const segment of segments.slice(0, -1)) {
						handle = await handle.getDirectoryHandle(segment);
					}
					const file = await handle.getFileHandle(segments.at(-1) as string);
					return { text: await (await file.getFile()).text(), failure: null } as const;
				} catch (cause) {
					failure = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
					await new Promise((resolve) => setTimeout(resolve, retryMs as number));
				}
			}
			return { text: null, failure } as const;
		},
		[path, READ_ATTEMPTS, READ_RETRY_MS] as const
	);

export const readStoredFileOrNull = async (page: Page, path: string): Promise<string | null> =>
	(await attemptRead(page, path)).text;

/**
 * The text of a Workspace-rooted path. Throws, naming the path, the attempts **and the last
 * failure**, when it is not there.
 *
 * For the callers whose next line would fail anyway: a matcher error about `null` says nothing about
 * which file could not be read or why, and this has to be readable by whoever finds the run red. The
 * distinction the last failure carries is the useful one — a persistent `NotFoundError` is a test
 * looking in the wrong place, a persistent `NotReadableError` is not.
 */
export const readStoredFile = async (page: Page, path: string): Promise<string> => {
	const { text, failure } = await attemptRead(page, path);
	if (text === null) {
		throw new Error(
			`${path} could not be read in ${READ_ATTEMPTS} attempts over ` +
				`${READ_ATTEMPTS * READ_RETRY_MS}ms — the last failure was ${failure}. ` +
				'A transient failure here is the atomic-replace window; a persistent one is not.'
		);
	}
	return text;
};

/** {@link readStoredFileOrNull}, parsed. `null` when the file is absent *or* is not yet valid JSON. */
export const readStoredJsonOrNull = async <T>(page: Page, path: string): Promise<T | null> => {
	const text = await readStoredFileOrNull(page, path);
	if (text === null) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		// A file caught mid-write can be syntactically incomplete as well as unreadable. Same answer.
		return null;
	}
};
