// How large a Workspace is, and whether one more offline copy takes it over the cliff (ADR-0008).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS `list` + `size` AND NEVER `read`
//
// An offline copy's pyramid is thousands of tile files. `ProjectStore#size` exists in ADR-0001's
// interface precisely so that a byte total can be had **without opening anything** — both real
// backends answer it from directory metadata for free, and ticket 02's shared adapter suite has a
// spy on `read` keeping it that way. A total assembled by reading every tile would be the slowest
// possible way to answer the one question a user needs answered *before* they start a copy, and it
// would grow with the size of the Workspace rather than with the number of files in it.
//
// `workspace-size.test.ts` puts the same spy on this function, because a version written with
// `read` would pass every other assertion about the number it returns.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY IT DOES NOT SWEEP ABANDONED WRITES, THOUGH IT ONCE DID
//
// `list` never reports a file matching the reserved temporary suffix — with or without a further
// extension, since Chromium's `createWritable()` leaves `<name>.ballastella-tmp.crswap` behind — so a
// total built from `list` is a floor rather than an exact figure whenever a crashed tab has left
// litter on the disk. Ticket 12's review found that, and this function answered it by calling
// `reclaimAbandonedWrites` before totalling.
//
// **That was a measurement with a destructive sweep of the whole Workspace inside it**, and the
// caller is a user clicking "Make an offline copy" or opening the publish dialog.
// `TempFileWriteStore.reclaimAbandonedWrites` deletes every temporary path it walks, unconditionally
// and with no age check, because at its intended call site nothing else is writing. Fired from here it
// could land between another write's `writeBytes` and its `renameTempFile` — an autosave of
// `project.json`, a tile of an ingest running in the same tab — and delete that write's temporary file
// out from under it, failing a save the user never connected to the button they pressed. Asking how
// large a Workspace is must not be able to break what is being written into it.
//
// So the sweep stays where it is safe and expected: Workspace adoption, in
// `workspace-storage.svelte.ts`, which is "the one moment a full sweep is both cheap and expected" —
// the walk the listing does anyway, before any edit is in flight. That runs before any measurement in
// the session, so the floor and the exact figure differ only for litter dropped since — another tab
// dying mid-write, which is the case the next adoption sweeps up. Under-reporting by the bytes of one
// abandoned write is the price of never deleting a file somebody is still writing, and it is much the
// cheaper of the two errors.

import type { ProjectStore } from '../store/project-store.js';

/**
 * The ~1 GB static-hosting budget of ADR-0008, in bytes.
 *
 * GitHub Pages' published-site limit, and it is shared by **every Project in the Workspace** — which
 * is what makes it a cliff rather than a per-Project ceiling. Decimal rather than binary because that
 * is the way the hosts state it and the way the warning reads it back.
 *
 * ADR-0008 also records a hard 100 MB per-file limit in git. Nothing here can approach it: a tile is
 * a few kilobytes and `project.json` is a few hundred bytes, so the only file this app writes that
 * could is a zip export, which does not live in the Workspace.
 */
export const STATIC_HOSTING_LIMIT_BYTES = 1_000_000_000;

/** How much a Workspace, or one Project in it, currently occupies. */
export type WorkspaceSize = {
	readonly bytes: number;
	/** How many files that was. Said as well, because "3 files" and "31 000 files" are different news. */
	readonly files: number;
};

/**
 * The byte total under `prefix` — `''` for the whole Workspace, `'<directory>/'` for one Project.
 *
 * **Reads nothing, and writes nothing — one `list` and one `size` per file it names.** See the note
 * at the top of this file for both halves of why, the second of which is that this is a question a
 * user asks while other things in the same tab are still writing.
 */
export async function workspaceSize(store: ProjectStore, prefix = ''): Promise<WorkspaceSize> {
	const paths = await store.list(prefix);
	const sizes = await Promise.all(paths.map((path) => store.size(path).catch(() => 0)));

	return { bytes: sizes.reduce((sum, size) => sum + size, 0), files: paths.length };
}

/** Whether adding `adding` bytes to a Workspace of `current` bytes crosses the ADR-0008 budget. */
export const crossesHostingLimit = (current: number, adding: number): boolean =>
	current + adding > STATIC_HOSTING_LIMIT_BYTES;

/**
 * A number of bytes as a person reads it: `4.6 MB`, `310 MB`, `1.0 GB`.
 *
 * One decimal below ten of a unit and none above it, so the figure carries the precision it has
 * and no more. Decimal units, matching {@link STATIC_HOSTING_LIMIT_BYTES} and the way a hosting
 * limit is quoted — a warning that said "954 MiB of your 1 GB" would look like an arithmetic error.
 */
export function describeBytes(bytes: number): string {
	const rounded = Math.max(0, Math.round(bytes));
	if (rounded < 1000) return `${rounded} ${rounded === 1 ? 'byte' : 'bytes'}`;

	const units = [
		[1e9, 'GB'],
		[1e6, 'MB'],
		[1e3, 'kB']
	] as const;

	for (const [scale, unit] of units) {
		if (rounded < scale) continue;
		const value = rounded / scale;
		return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
	}
	return `${rounded} bytes`;
}

/**
 * What to tell the user before a copy that would cross the cliff, or `''` when it would not.
 *
 * **Information, not a gate** (ADR-0007, and ticket 15 says so in as many words): the scholar may be
 * copying a map they have every right to and may never publish this Workspace at all. What must not
 * happen is that they find out from `git push` failing, which is the failure ADR-0008 names.
 */
export function hostingLimitWarning(current: number, adding: number): string {
	if (!crossesHostingLimit(current, adding)) return '';

	const limit = describeBytes(STATIC_HOSTING_LIMIT_BYTES);
	const already = current > STATIC_HOSTING_LIMIT_BYTES;

	return (
		`This Workspace holds ${describeBytes(current)} and this copy adds about ` +
		`${describeBytes(adding)}, ` +
		(already
			? `so it is already past the ${limit} a free static host such as GitHub Pages will publish. `
			: `which takes it past the ${limit} a free static host such as GitHub Pages will publish. `) +
		`You can still make the copy — this is worth knowing rather than a reason to stop — but ` +
		`publishing the whole Workspace to one of those hosts will fail, and the way out is to publish ` +
		`one Project at a time or to host it somewhere without that limit.`
	);
}
