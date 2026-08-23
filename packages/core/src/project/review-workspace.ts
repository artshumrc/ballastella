// What makes a Workspace a **Review Workspace** (ticket 14, ADR-0024).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE MARK IS A FILE IN THE WORKSPACE AND NOT A SETTING
//
// ADR-0024: "Review is an action, not a mode you toggle. A setting is something a user can forget
// they are inside, and the failure that creates is an afternoon's real work done in a Workspace
// built to be thrown away."
//
// That rules out the obvious implementations as well as the obvious interface. A list of Review
// Workspace names in `localStorage` is a setting wearing a different hat: it is separable from the
// thing it describes, so a cleared browser store, a second browser profile, or a copied OPFS
// directory leaves a throwaway Workspace looking exactly like the user's own — the banner gone, the
// two exits gone, and the afternoon's work about to happen. The mark therefore lives **inside** the
// Workspace it marks, is written before the first Project byte lands, and travels with the
// directory wherever the directory goes.
//
// It is at the Workspace root rather than inside the Project, because it is a fact about the
// *Workspace*: the Workspace is the throwaway thing, the Project inside it is an ordinary Project,
// and a mark in `project.json` would be a field every other reader of that document would have to
// know to ignore (ADR-0010's forward tolerance cuts the other way here).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTAINMENT IS STRUCTURAL; THE MARK IS ONLY HOW IT IS *SAID*
//
// A Review Workspace is absent from the user's Project list, absent from a backup of their
// Workspace, and uncounted in its size **because it is a different directory in the OPFS root**
// (ticket 12), not because anything filters on this mark. Nothing here is load-bearing for any of
// those three, and it must not become so: a filter is something that can be forgotten at a fourth
// call site, and containment cannot.
//
// What the mark is load-bearing for is the *banner* — which screen says "you are in a review copy",
// what it names, and which two exits it offers — and for refusing to publish or back one up.

import {
	PathNotFoundError,
	type Bytes,
	type ReadOnlyProjectStore,
	type StorePath
} from '../store/project-store.js';

/**
 * Where the mark lives, relative to the Workspace root.
 *
 * A top-level *file*, so it cannot collide with a Project: `listProjects` matches only
 * `<directory>/project.json` (ADR-0008), and `toDirectoryName` turns any name a user could type into
 * a slug with no `.` in it, so no Project directory can ever be called this.
 */
export const REVIEW_MARK_PATH = 'review.json' as StorePath;

/**
 * The format version of the mark itself.
 *
 * Separate from a Project's `formatVersion` and deliberately not checked against the future the way
 * ADR-0010 checks that one. A mark this build cannot read must still count as a mark — see
 * {@link readReviewMark} — because the safe direction here is to show the banner over a Workspace
 * that turns out to be the user's own, never to hide it over one that is about to be discarded.
 */
export const REVIEW_MARK_FORMAT_VERSION = 1;

/**
 * Where a Review Workspace's backing is, in the two words the app already uses for it.
 *
 * Spelled here rather than imported from the editor, because the mark is a file in a Workspace and
 * core is what reads and writes it. The editor's `WORKSPACE_BACKINGS` is the same two members and
 * assigns straight into this.
 */
export type ReviewOriginBacking = 'browser' | 'folder';

/**
 * The **one** ordinary Workspace a Review began from, as an Import may ask for it back (ADR-0037).
 *
 * ⚠ **Recorded when the review copy is made, and never rewritten.** A reviewer moves between
 * Workspaces while a review copy is open — that is what the banner's first exit is for — so an Import
 * that resolved its destination at the moment it ran would copy somebody else's work into whichever
 * Workspace happened to be open when they pressed the button. There is exactly one honest
 * destination, and it is the one they were in when they opened the thing they are reading.
 *
 * ⚠ **A display name is not identity, and for a folder it is barely a hint.** Two folders on one
 * machine may be called `maps`, a folder can be deleted and another created in its place, and a
 * Workspace folder is reached through a *grant* rather than through a path this application could
 * write down. So a folder origin carries {@link folderReference} — an installation-local reference to
 * the granted handle itself — and {@link name} is only for the sentences the reviewer reads.
 */
export interface ReviewOrigin {
	/**
	 * The installation-local Workspace key the synchronization metadata is already keyed by:
	 * `opfs:<name>` for browser storage, `folder:<name>` for a chosen folder.
	 */
	readonly workspaceKey: string;
	readonly backing: ReviewOriginBacking;
	/** What the Workspace is called, for what the reviewer is asked to confirm. Never identity. */
	readonly name: string;
	/**
	 * The installation-local reference to the granted folder handle, for a folder backing.
	 *
	 * `''` for a browser-backed origin, which needs none: an OPFS Workspace is reached by its name in
	 * a root this application owns, and there is no grant to lose.
	 */
	readonly folderReference: string;
}

/** What a Review Workspace knows about itself. */
export interface ReviewMark {
	readonly formatVersion: number;
	/**
	 * The display name of the Project that was opened, for the banner to name.
	 *
	 * The bundle's `project.json` name once the manifest has been read, and the file the user picked
	 * before that — see `open-project-bundle.ts` on why the mark is written twice.
	 */
	readonly project: string;
	/** The Project's directory inside this Review Workspace, or `''` before one has been written. */
	readonly directory: string;
	/** ISO 8601, so a teacher with thirty of these can tell which is this morning's. */
	readonly openedAt: string;
	/**
	 * The ordinary Workspace this Review began from, or `null` when none was recorded.
	 *
	 * `null` for every review copy made before ADR-0037 and for one opened where no ordinary
	 * Workspace could be named. Such a copy stays reviewable, editable and discardable; what it cannot
	 * do is Import, because there is no destination to Import *into* that is not a guess.
	 */
	readonly origin: ReviewOrigin | null;
}

export function serialiseReviewMark(mark: ReviewMark): Bytes {
	return new TextEncoder().encode(`${JSON.stringify(mark, null, '\t')}\n`) as Bytes;
}

/**
 * Read a mark's bytes, or `null` when they are not a mark this build understands.
 *
 * Tolerant about everything except the shape it needs. A mark from a newer build carrying members
 * this one has never heard of parses fine and keeps its `project` and `directory`; what it cannot
 * do is come back as `null`, because {@link readReviewMark} would then report the Workspace as the
 * user's own.
 */
export function parseReviewMark(bytes: Bytes): ReviewMark | null {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const formatVersion = record['formatVersion'];
	if (typeof formatVersion !== 'number') return null;
	const text = (value: unknown): string => (typeof value === 'string' ? value : '');
	return {
		formatVersion,
		project: text(record['project']),
		directory: text(record['directory']),
		openedAt: text(record['openedAt']),
		origin: parseReviewOrigin(record['origin'])
	};
}

/**
 * The origin a mark carries, or `null` for one that names no Workspace this build could ask for back.
 *
 * ⚠ **Stricter than the rest of this file, and in the opposite direction.** Everything above answers
 * "there is a mark here" as generously as it can, because the cost of a missed mark is an afternoon's
 * work in a throwaway Workspace. This answers "there is a destination here" as meanly as it can, for
 * the mirror reason: an origin half-read is a Workspace half-named, and the operation it licenses
 * copies work into somebody's own research and then deletes the copy it came from. A key that is not
 * a string, a backing this build does not know, or a folder origin with no grant reference behind it
 * is no destination at all — and no destination refuses, rather than guessing at one.
 */
function parseReviewOrigin(raw: unknown): ReviewOrigin | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const workspaceKey = record['workspaceKey'];
	const backing = record['backing'];
	if (typeof workspaceKey !== 'string' || workspaceKey === '') return null;
	if (backing !== 'browser' && backing !== 'folder') return null;
	const name = typeof record['name'] === 'string' ? record['name'] : '';
	const folderReference =
		typeof record['folderReference'] === 'string' ? record['folderReference'] : '';
	if (backing === 'folder' && folderReference === '') return null;
	if (name === '') return null;
	return { workspaceKey, backing, name, folderReference };
}

/**
 * The mark this Workspace carries, or `null` if it is an ordinary Workspace of the user's own.
 *
 * ⚠ **Unreadable is not absent, and here that rule points the opposite way from usual.** Everywhere
 * else in this codebase a file that will not read is treated as *present* so that nothing overwrites
 * it (see `alignment-file.ts`, and ticket 20's replay). The same rule applies here and produces the
 * same answer for a different reason: a Workspace whose mark exists but will not parse is answered
 * with a mark rather than with `null`, because the failure to avoid is a scholar doing an
 * afternoon's work inside a Workspace built to be thrown away. Only `PathNotFoundError` — the file
 * genuinely is not there — means "this is your own Workspace".
 *
 * A backend that is down therefore answers "review", and the cost is a banner over a Workspace that
 * is not one, which a reload corrects. The cost the other way is somebody's afternoon.
 */
export async function readReviewMark(store: ReadOnlyProjectStore): Promise<ReviewMark | null> {
	let bytes: Bytes;
	try {
		bytes = await store.read(REVIEW_MARK_PATH);
	} catch (cause) {
		if (cause instanceof PathNotFoundError) return null;
		return unreadableMark();
	}
	return parseReviewMark(bytes) ?? unreadableMark();
}

/**
 * The mark used when there is a file there that cannot be read as one.
 *
 * Names nothing it does not know. The banner then says a review copy is open without claiming which
 * Project it holds, which is the truthful reading of "there is a mark here and I cannot read it".
 */
const unreadableMark = (): ReviewMark => ({
	formatVersion: REVIEW_MARK_FORMAT_VERSION,
	project: '',
	directory: '',
	openedAt: '',
	origin: null
});

/** An action a Review Workspace does not get, or one only a Review Workspace gets. */
export class ReviewWorkspaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReviewWorkspaceError';
	}
}

/**
 * What a Review Workspace is holding, in the words the user should see.
 *
 * A mark that could not be read carries no Project name — see {@link readReviewMark} — so this says
 * "a Project somebody sent you" rather than inventing one.
 */
export function describeReviewSubject(mark: ReviewMark): string {
	return mark.project ? `“${mark.project}”` : 'a Project somebody sent you';
}

/**
 * Refuse an action a Review Workspace does not get, in the words the user should see (workspace-and-layers SPEC story 111).
 *
 * ⚠ **One sentence for every one of them rather than a phrase per call site.** Publishing and backing
 * up are refused for the same reason and the user is owed the same explanation; two spellings is how
 * two screens come to say different things about one rule. In `packages/core` rather than in the
 * editor so it has a test seam at all — the app has none — and so that the *writer* of a backup can
 * refuse as well as the button that presses it.
 */
export function assertNotReviewing(
	workspaceName: string,
	mark: ReviewMark | null,
	verb: string
): void {
	if (mark === null) return;
	throw new ReviewWorkspaceError(
		`“${workspaceName}” is a review copy of ${describeReviewSubject(mark)}, so it cannot be ` +
			`${verb}. It holds somebody else's work and is meant to be discarded. Go back to your own ` +
			`Workspace first.`
	);
}

/**
 * Refuse an action **only** a Review Workspace gets, in the words the user should see.
 *
 * The other direction, and the destructive one: discarding removes a Workspace and everything in it,
 * and the only thing standing between that and a user's own research is which Workspace is open.
 */
export function assertReviewing(workspaceName: string, mark: ReviewMark | null): void {
	if (mark !== null) return;
	throw new ReviewWorkspaceError(
		`“${workspaceName}” is one of your own Workspaces rather than a review copy, so it is not ` +
			`discarded from here. Workspace settings is where a Workspace of your own is deleted.`
	);
}
