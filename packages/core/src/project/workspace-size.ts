// How large a Workspace is, and whether one more offline copy takes it over the cliff (ADR-0008).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS `list` + `size` AND NEVER `read`
//
// A mirrored pyramid is thousands of tile files. `ProjectStore#size` exists in ADR-0001's
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
// WHY IT SWEEPS ABANDONED WRITES FIRST
//
// Ticket 12's review found that `list` never reports a file matching the reserved temporary suffix
// — with or without a further extension, since Chromium's `createWritable()` leaves
// `<name>.ballastella-tmp.crswap` behind. That is right for every other caller and wrong for this
// one: those bytes are on the disk, and in the git repository the user pushes, while being invisible
// to any total built from `list`. A number that silently under-reports is worse than no number here,
// because the whole point of it is the decision "will this copy take me past what I can host".
//
// So the litter is removed before the total is taken, which makes the answer exact rather than a
// floor. It is a deletion of files that are garbage by construction — nothing can reach them through
// `ProjectStore` — and it is the same call `Workspace#deleteProject` already makes. A backend that
// refuses the sweep still gets a number, with the `list` caveat back: being unable to say how large a
// Workspace is would mean never warning about the cliff at all.

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
 * Reads nothing. See the note at the top of this file for both halves of why.
 */
export async function workspaceSize(store: ProjectStore, prefix = ''): Promise<WorkspaceSize> {
	// Before the total, not after: see the note above. Swallowed rather than fatal — a Workspace whose
	// litter cannot be swept still has a size, and refusing to say it would remove the warning entirely.
	await store.reclaimAbandonedWrites(prefix).catch(() => undefined);

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
