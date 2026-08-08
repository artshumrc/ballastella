// Putting the write-ahead journal back into the ProjectStore at startup (ticket 20).
//
// The other half of `journal.ts`. Everything interesting here is a refusal: what this must **not**
// write, and how it says so.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RULE THIS MODULE IS BUILT AROUND
//
// **Nothing is reported as restored that was not written.** Ticket 13 shipped a restore whose
// counter included a write the writer had declined, and review caught it; the same mistake here
// would tell a scholar their Control Points were recovered when the file was left alone.
//
// So a path reaches `restored` on one line only, immediately after the write that put it there
// resolved; the outcome `writeAlignmentBytes` answers with is checked rather than assumed, and
// anything but `'written'` becomes a reported failure; and the report has four separate lists
// rather than a count and a boolean, because "put back", "deliberately not put back", "could not be
// put back yet" and "this build will not read it" are four different things to tell somebody.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AN ALIGNMENT IS WRITTEN THROUGH `alignment-file.ts`, AND THE FENCE CANNOT SEE THIS (ticket 18)
//
// Saying that plainly rather than relying on it: the path here comes out of a journal key, which is
// **data read at runtime**. `WritablePath`'s brand only refuses a value that came out of
// `alignmentPath()`, and `scripts/check-alignment-writers.mjs` follows literals and one hop of
// local binding. Neither can see a string decoded from storage. This module is therefore in exactly
// the position `project/workspace.ts`'s Project-zip importer is in, and takes the same remedy:
// **routed through the owning module rather than fenced**. {@link replayJournal} refuses to hand an
// Alignment path to `store.write` at all — it is a branch, above, with a test on it.
//
// The intent is `update`, and that is the honest one. The journalled bytes are the user's own
// interrupted edit of an Alignment they had open, which is precisely what `update` means; a
// `create` would decline whenever a file exists, which is every case that matters here, and this
// fix would not fix Alignments at all. `update`'s documented gap comes with it unchanged: a
// colleague's edit arriving through a synced Workspace between the interrupted write and this
// replay is overwritten, exactly as it would have been had the original write completed. ADR-0023
// accepts that gap in the same words and offers visibility rather than prevention — which is what
// the report below is.

import {
	writeAlignmentBytes,
	type AlignmentFilePort,
	type AlignmentWriteOutcome
} from '../alignment/alignment-file.js';
import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { IMAGE_DIRECTORY, imageInfoPath } from '../project/image-files.js';
import { referencedImagePath } from '../remote-iiif/referenced-image.js';
import { projectFilePath } from '../project/project-file.js';
import { RESERVED_DIRECTORY_NAMES } from '../project/workspace.js';
import {
	PathNotFoundError,
	topLevelSegment,
	type Bytes,
	type ProjectStore,
	type StorePath
} from '../store/project-store.js';
import {
	WriteAheadJournal,
	readJournal,
	type JournalProblem,
	type JournalStorage
} from './journal.js';

/** Why an entry was found, understood, and still not written. */
export type ReplaySkipReason =
	/** The Project it belongs to is no longer in this Workspace. */
	| 'no-such-project'
	/** The Historical Map it belongs to is no longer in this Workspace. */
	| 'no-such-historical-map';

export interface ReplaySkipped {
	readonly path: StorePath;
	readonly reason: ReplaySkipReason;
	/** One sentence, written for the user. */
	readonly detail: string;
}

export interface ReplayFailure {
	readonly path: StorePath;
	/** One sentence, written for the user. */
	readonly detail: string;
}

/**
 * What a replay did, in four lists that do not overlap.
 *
 * Four rather than "restored, and some number of others", because each is a different thing to say
 * to a person: work put back, work deliberately not put back, work that could not be put back
 * *yet*, and journal entries this build will not read at all.
 */
export interface JournalReplayReport {
	readonly workspace: string;
	/** Paths whose bytes are now in the store. Nothing else appears here. */
	readonly restored: readonly StorePath[];
	readonly skipped: readonly ReplaySkipped[];
	/** Writes that were attempted and rejected. Their entries are **kept** for the next startup. */
	readonly failed: readonly ReplayFailure[];
	readonly problems: readonly JournalProblem[];
}

/** Whether anything at all happened worth telling the user about. */
export const replayIsNoteworthy = (report: JournalReplayReport): boolean =>
	report.restored.length > 0 ||
	report.skipped.length > 0 ||
	report.failed.length > 0 ||
	report.problems.length > 0;

/**
 * Put one Workspace's journalled edits back into its store.
 *
 * Run once per Workspace, as it is opened — never for all of them at once, because a journal entry
 * belongs to the Workspace it was typed into (ticket 12 put several in the OPFS root) and a store
 * only ever addresses one.
 *
 * **An entry is dropped only when its bytes are in the store, or when it can never be used.** A
 * write that fails is left in place, so an unplugged drive or a Workspace whose permission has
 * lapsed costs a delay rather than the edit.
 */
export async function replayJournal(
	storage: JournalStorage,
	store: ProjectStore,
	workspace: string
): Promise<JournalReplayReport> {
	const journal = new WriteAheadJournal(storage, workspace);
	const { entries, problems } = readJournal(storage, workspace);

	const restored: StorePath[] = [];
	const skipped: ReplaySkipped[] = [];
	const failed: ReplayFailure[] = [];

	for (const entry of entries) {
		// Inside the `try`, so a precondition that cannot be evaluated — an unreachable Workspace
		// mid-walk — is one reported failure with its entry kept, rather than a rejection that
		// abandons every remaining entry unexamined.
		try {
			const blocked = await missingOwner(store, entry.path);
			if (blocked !== null) {
				skipped.push(blocked);
				// The thing it belonged to is gone, so the entry can never be used and would otherwise
				// be reported at every startup for ever. Dropped *after* being named in the report, and
				// only on the unambiguous evidence `missingOwner` insists on.
				journal.forget(entry.path);
				continue;
			}

			await write(store, entry.path, entry.bytes);
			restored.push(entry.path);
			journal.forget(entry.path);
		} catch (cause) {
			// Kept, deliberately: this is the one outcome that may succeed later, and dropping it
			// would turn a Workspace that is merely unreachable today into lost work.
			failed.push({
				path: entry.path,
				detail:
					`An unsaved change to “${entry.path}” could not be put back: ` +
					`${cause instanceof Error ? cause.message : String(cause)}. It has been kept and ` +
					`will be tried again next time this Workspace is opened.`
			});
		}
	}

	return { workspace, restored, skipped, failed, problems };
}

/**
 * Write one journalled entry, choosing the route by what the path names.
 *
 * The Alignment branch is the point of this function. See the module header: the path is runtime
 * data, so neither `WritablePath` nor the fence can see it, and the branch is what keeps the
 * promise that `alignment-file.ts` is the one writer.
 */
async function write(store: ProjectStore, path: StorePath, bytes: Bytes): Promise<void> {
	const imageId = alignmentImageId(path);
	if (imageId !== null) {
		const port: AlignmentFilePort = {
			read: (at) => store.read(at),
			// Straight to the store rather than through `Autosave`: these bytes are being put back,
			// not edited, and routing a startup recovery through a debounce and a "Saving…" indicator
			// would describe the wrong thing — the same argument `Workspace`'s own port makes.
			commit: (at, value) => store.write(at, value)
		};
		const outcome: AlignmentWriteOutcome = await writeAlignmentBytes(port, {
			imageId,
			bytes,
			write: { intent: 'update' }
		});
		// `update` writes unconditionally, so `'written'` is the only answer this can get today.
		// Checked rather than assumed, because "counted as restored without having been written" is
		// the exact bug ticket 13 shipped and review caught. If the intent above is ever narrowed to
		// one that can decline, this becomes a reported failure instead of a silent false claim.
		if (outcome !== 'written') {
			throw new Error(
				`the one Alignment writer answered “${outcome}” rather than writing it, so this ` +
					`change has not been put back`
			);
		}
		return;
	}
	await writePlain(store, path, bytes);
}

/**
 * Write anything that is **not** an Alignment.
 *
 * ⚠ **The guard is a runtime check because nothing else here can be one.** `StorePath` is a
 * `string`, and a `string` is assignable to `WritablePath` — the brand is optional so that every
 * ordinary path in the codebase stays writable without a cast — so the compiler accepts
 * `alignments/x.json` here. The fence cannot see it either: it follows literals and one hop of
 * local binding, and this path was decoded from storage. Deleting the branch above would therefore
 * compile, lint clean, and blind-write a Workspace-shared Alignment.
 *
 * So the refusal is executable, and it is what makes that deletion **observable**: with the branch
 * gone, replaying an Alignment reports a failure instead of a restore, and `replay.test.ts` goes
 * red. That is the difference between a guard and a comment.
 */
async function writePlain(store: ProjectStore, path: StorePath, bytes: Bytes): Promise<void> {
	if (alignmentImageId(path) !== null) {
		throw new Error(
			`“${path}” is an Alignment and may only be written through alignment-file.ts (ticket 18)`
		);
	}
	await store.write(path, bytes);
}

/** The Historical Map an `images/<image-id>/…` path belongs to, or `null`. */
function imageIdUnder(path: StorePath): string | null {
	const segments = path.split('/');
	if (segments[0] !== IMAGE_DIRECTORY || segments.length < 3) return null;
	const id = segments[1] ?? '';
	return id === '' ? null : id;
}

/**
 * Whether this Workspace still holds a Historical Map, on the **same evidence standard** the
 * Project check below uses.
 *
 * ⚠ **This was an empty `store.list()`, and that is not evidence of absence.** Review found the
 * asymmetry: the Project branch says in as many words that "unreadable is not absent" and errs
 * toward keeping the entry, while this one read any empty listing as a deletion and then discarded
 * the unsaved bytes permanently. A listing that came back empty for any reason other than the map
 * having been deleted destroyed the rescue, silently.
 *
 * So the careful branch wins, and the question is asked the way that branch asks it: of **two named
 * files**, either of which existing means the map is here — `info.json` for a pyramid in the
 * Workspace, `remote.json` for one referenced from a Library. Only `PathNotFoundError` from *both*
 * counts as gone. Anything else — a folder whose permission lapsed, a backend that is down — is a
 * Workspace that cannot answer, and a Workspace that cannot answer must never be read as one where
 * the user's map has been deleted.
 *
 * The listing is kept as a **last resort under the same rule**, because the two named files are not
 * the only way a map can be present: an ingest interrupted between its tiles and its `info.json`
 * leaves a directory that `Workspace.#historicalMapIds` counts and neither named file evidences. So
 * a non-empty listing also means present — and a listing that *rejects* means present too, which is
 * the half the original spelling got wrong. Only every check answering "definitely not there" is
 * absence.
 */
async function hasHistoricalMap(store: ProjectStore, imageId: string): Promise<boolean> {
	for (const path of [imageInfoPath(imageId), referencedImagePath(imageId)]) {
		try {
			await store.size(path);
			return true;
		} catch (cause) {
			if (!(cause instanceof PathNotFoundError)) return true;
		}
	}
	try {
		return (await store.list(`${IMAGE_DIRECTORY}/${imageId}/`)).length > 0;
	} catch {
		// Could not be asked, which is not an answer of "no".
		return true;
	}
}

/**
 * The Historical Map an `alignments/<image-id>.json` path names, or `null` for anything else.
 *
 * Deliberately as narrow as `hoistedImageId`'s Alignment half: exactly two segments, a non-empty
 * stem, and a `.json` suffix. Anything looser would route a path this application never writes into
 * the Alignment writer, which is the opposite of a guard.
 *
 * ⚠ **Exported for its positive control, and that is the whole reason it is exported.** Both the
 * routing in {@link write} and the refusal in {@link writePlain} ask this one function the same
 * question, so if it is ever loosened or narrowed the branch and its guard move **together, in the
 * same direction, silently**: a path it stopped recognising would be sent to the plain write *and*
 * waved through by the refusal that exists to catch exactly that. `replay.test.ts` pins it against
 * the spellings on both sides of the line, so such a change is a red test rather than a quiet hole.
 */
export function alignmentImageId(path: StorePath): string | null {
	const segments = path.split('/');
	if (segments.length !== 2 || segments[0] !== ALIGNMENT_DIRECTORY) return null;
	const name = segments[1] ?? '';
	return name.endsWith('.json') && name.length > '.json'.length
		? name.slice(0, -'.json'.length)
		: null;
}

/**
 * Why this entry must not be written, or `null` when it may be.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * A JOURNAL MUST NOT RESURRECT WHAT THE USER DELETED
 *
 * `ProjectStore.delete` does not go through `Autosave`, so nothing about a deletion reaches the
 * journal on its own. Without this, deleting a Project whose rename was still inside its debounce
 * window would put `project.json` back into a directory the user removed — a Project reappearing on
 * the hub, from a gesture that said it was going.
 *
 * Two layers, because one is not enough on its own:
 *
 *   1. **`WriteAheadJournal.forgetUnder`, called by the deletion**, which is exact and is what
 *      handles the case this cannot: a *new* Project created afterwards under the same directory
 *      name, which from here is indistinguishable from the old one still being there.
 *   2. **This check**, which catches everything the first missed — a deletion in another tab, a
 *      folder emptied from the operating system, a Workspace restored from a backup.
 *
 * ⚠ **Which of the two carries which case was measured rather than reasoned about**, by deleting
 * layer 1 and watching the tests:
 *
 *   - A Project simply deleted and not replaced is **layer 2's**; the whole directory is gone, so
 *     there is no manifest to find and nothing is written.
 *   - A Project deleted and replaced under the same folder name is **layer 1's**, but not through
 *     `project.json` — creating the replacement rewrites that path, which supersedes the journalled
 *     entry and then forgets it. It is the Project's *other* files, an Annotation collection still
 *     inside its debounce window, that nothing rewrites and that would land in a Project with no
 *     Layer referencing them.
 *
 * `<project>/project.json` is also deliberately exempt from the Project check below, and has to be:
 * writing that file is *what makes the Project exist*, so an interrupted `createProject` has no
 * directory to point at yet, and requiring one would discard the only copy of a Project the user has
 * just made.
 */
async function missingOwner(store: ProjectStore, path: StorePath): Promise<ReplaySkipped | null> {
	const imageId = alignmentImageId(path) ?? imageIdUnder(path);
	if (imageId !== null) {
		// A Historical Map's *own* evidence files are exempt, for exactly the reason
		// `<project>/project.json` is: writing one is what makes the map exist, so an interrupted add
		// has nothing to point at yet and requiring it would discard the only copy. The deletion path
		// (`EditorSession.deleteHistoricalMap`) empties the journal of the map at the time, which is
		// the layer that covers what this exemption opens — the same two-layer split as a Project.
		if (path === imageInfoPath(imageId) || path === referencedImagePath(imageId)) return null;
		// An Alignment, or a Historical Map's own record, belongs to a map in this Workspace
		// (ADR-0023). If the map has gone, putting the file back leaves one describing nothing, which
		// every size total counts and every backup carries.
		return (await hasHistoricalMap(store, imageId))
			? null
			: {
					path,
					reason: 'no-such-historical-map',
					detail:
						`An unsaved change to “${path}” was not put back, because the Historical Map it ` +
						`belongs to is no longer in this Workspace.`
				};
	}

	const directory = topLevelSegment(path);
	// The Workspace's own directories are not Projects and never can be, so there is no manifest to
	// look for. From the shared list rather than spelled again, so a fourth reserved directory
	// arrives here without anybody having to remember this line exists.
	if (RESERVED_DIRECTORY_NAMES.includes(directory)) return null;
	// Anything else at the Workspace root is not a Project's and has no owner to check.
	if (directory === path) return null;
	if (path === projectFilePath(directory)) return null;

	try {
		await store.read(projectFilePath(directory));
		return null;
	} catch (cause) {
		if (!(cause instanceof PathNotFoundError)) {
			// Unreadable is not absent — the same direction `alignment-file.ts`'s `existing` takes.
			// A Workspace that cannot answer must not be read as one where the Project has gone.
			return null;
		}
		return {
			path,
			reason: 'no-such-project',
			detail:
				`An unsaved change to “${path}” was not put back, because the Project it belongs to is ` +
				`no longer in this Workspace.`
		};
	}
}
