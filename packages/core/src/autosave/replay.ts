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
// WHAT "NEWER" MEANS HERE, AND WHICH CASES ARE DECIDABLE (ticket 07)
//
// This module used to write every entry unconditionally, checking only that the thing the file
// belongs to still existed. So a Workspace tar restored, a Project bundle opened, or a pyramid
// ingested *after* an edit was journalled put the older bytes back over the newer ones — and named
// the path in `restored`, which reads to the user as good news. Under the epic's change of direction
// the journal is what makes a failed write safe, so an entry deliberately outlives a restart and
// that stops being a latent hazard.
//
// **The journal and the store are different backends with no shared clock, so "newer" is decided by
// content and never by time.** An entry carries `held` — a fingerprint of what the store held when
// the edit was made (`journal.ts`) — and {@link compare} weighs it against what the store holds now.
//
// ⚠ **The rows of that decision are deliberately not transcribed here.** An earlier draft of this
// header held them as a table; review found that the table had become the module's second interface,
// that one of its rows was untested, and that its summary sentence stated the mechanism backwards —
// three drifts in one commit, in prose describing six lines of code directly below it. The rows are
// drivable, so they are driven: `replay.test.ts` has one `describe` per row, each named for what the
// row claims — plus the absent-file case, which the loop answers before `compare` is asked.
// **Change `compare`, read those.**
//
// What belongs here is what no single row says.
//
// **Where there is no baseline, nothing is decided silently — the scholar is asked.** `held` is
// written only by `WriteAheadJournal.forget`, and `Autosave` calls that only after a store write has
// **succeeded**, so a path has no baseline until some write to it has landed in that session, and a
// `null` baseline is carried forward for ever, restart included. **The case this whole design exists
// for — a store whose writes are failing, with a healthy journal — is therefore the case with no
// baseline**, and it is not a sliver. Both silent answers there are indefensible: writing can revert
// somebody's newer work, refusing and dropping can lose a real strand. So the entry is kept and
// named, with both versions described — `'cannot-tell-which-is-newer'`, below.
//
// ⚠ **That is the domain half. Applying the held copy is a chooser that does not exist yet**, and is
// ticket 03's; the panel today shows the sentence and offers to throw the copy away. Until the
// chooser ships, a stranded edit on a path with no baseline is **reported and held rather than put
// back**, which is a real interim cost of choosing the safe answer over the convenient one.
//
// A note on why the obvious fix is not one: `Autosave` learns what the store holds only when the
// store *acknowledges* a write, so a seam there could supply a baseline only for paths that have
// already been written successfully — which is exactly the set that already works. It would have
// looked like it closed this and would not have.
//
// **Direction of error.** `held` is read on one line, and only to *refuse* a write — absent, the
// write does not happen either, so nothing here turns a wrong baseline into an overwrite. What can
// is the store's side of the comparison: equality cannot tell "untouched since the edit" from
// "changed and changed back", so a file restored from a backup to exactly its former content is
// written over by an edit that predates the restore, and named in `restored`. That is a hole in what
// the comparison can see, and the one channel in which this module can still cost an edit.
//
// **What this delivers for "recovery without knowing to act" (story 9): the ground for it, not it.**
// The only thing that triggers a recovery is a startup replay. Nothing re-attempts within a session,
// and the retry machinery is being deleted, so the scholar is relieved of knowing to make another
// *edit* and left needing to know to *restart* — which nothing tells them to do. The undecidable row
// above asks them to act as well, deliberately. Story 9 is **unblocked** by this and not fulfilled;
// ticket 08 is what would close it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AN ALIGNMENT IS WRITTEN THROUGH `alignment-file.ts`, AND THE FENCE CANNOT SEE THIS (ticket 18)
//
// Saying that plainly rather than relying on it: the path here comes out of a journal key, which is
// **data read at runtime**. `WritablePath`'s brand only refuses a value that came out of
// `alignmentPath()`, and `scripts/check-alignment-writers.mjs` follows literals and one hop of
// local binding. Neither can see a string decoded from storage. This module is therefore in exactly
// the position the two tar readers are in (`transfer/restore-workspace-tar.ts`,
// `transfer/open-project-bundle.ts`), and takes the same remedy:
// **routed through the owning module rather than fenced**. {@link replayJournal} refuses to hand an
// Alignment path to `store.write` at all — it is a branch, above, with a test on it.
//
// The intent is `update`, and that is the honest one. The journalled bytes are the user's own
// interrupted edit of an Alignment they had open, which is precisely what `update` means; a
// `create` would decline whenever a file exists, which is every case that matters here, and this
// fix would not fix Alignments at all. `update`'s documented gap is **narrowed and not closed** by
// ticket 07: a colleague's edit arriving through a synced Workspace between the interrupted write
// and this replay is refused when the entry carries a baseline, and reported rather than overwritten
// when it does not. ADR-0023 accepts that gap and offers visibility rather than prevention — which
// is what the report below is.

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
import type { DeletedProjects } from './deleted-projects.js';
import {
	WriteAheadJournal,
	describeSize,
	fingerprintOf,
	readJournal,
	type JournalEntry,
	type JournalProblem,
	type JournalStorage
} from './journal.js';

/** Why an entry was found, understood, and still not written. */
export type ReplaySkipReason =
	/** The Project it belongs to is no longer in this Workspace. */
	| 'no-such-project'
	/**
	 * The user deleted the Project it belongs to (ticket 21).
	 *
	 * Distinct from `no-such-project`, and the distinction is the point. That one is an *inference*
	 * from files not being there, which is why it has to err toward keeping the entry — "unreadable
	 * is not absent". This one is the gesture itself, recorded at the moment the user made it, and it
	 * is the only evidence strong enough to refuse to put back a `<project>/project.json`, which
	 * {@link missingOwner} otherwise exempts from every check because writing it is what makes a
	 * Project exist.
	 */
	| 'project-deleted'
	/** The Historical Map it belongs to is no longer in this Workspace. */
	| 'no-such-historical-map'
	/**
	 * The store already holds exactly these bytes, so there is nothing to put back (ticket 07).
	 *
	 * Not `restored`, and the distinction is the whole of one acceptance criterion: nothing was
	 * written, so naming the path under "the change has been written now" would be a claim about a
	 * write that did not happen. It reaches here when the store took the bytes and the entry
	 * outlived them anyway — a `forget` the browser refused, or a page closed between this module's
	 * write and its own `forget`.
	 */
	| 'already-in-the-store'
	/**
	 * There is an edit here, and nothing can tell whether the file on disk is newer than it or older
	 * (ticket 07, round 3).
	 *
	 * The entry carries no baseline — see `journal.ts`, and note that this is the *normal* state for a
	 * path whose writes have never succeeded, which is the case the journal exists for. So the two
	 * readings are equally consistent with the evidence: the store may hold the last version this
	 * application managed to save, in which case the entry is a rescue; or a Workspace restore, a
	 * bundle, or another tab may have written it since, in which case putting the entry back is a
	 * revert.
	 *
	 * ⚠ **Both silent answers are indefensible, so neither is taken.** Writing can destroy somebody's
	 * newer work; refusing and dropping can destroy a real strand. What is left is to say so: the
	 * entry is **kept**, the sentence names both versions and their sizes, and the scholar decides.
	 * An earlier round wrote silently here and described it as a narrow residual in three places.
	 *
	 * ⚠ **The domain half only.** The panel renders the sentence and offers to throw the copy away;
	 * *applying* it is a chooser that does not exist yet and is ticket 03's. Until it does, a stranded
	 * edit on a path with no baseline is reported and held rather than put back — which is a real
	 * interim cost and is written down as one. Everything a chooser needs is reachable: the kept bytes
	 * from `readJournal`, the bytes on disk from `store.read`.
	 */
	| 'cannot-tell-which-is-newer'
	/**
	 * Something wrote this file after the edit was journalled, so putting it back would be a revert
	 * (ticket 07).
	 *
	 * See the module header for how that is decided and for the case it cannot decide. This is the
	 * one skip reason whose entry is **kept**: its bytes are a real edit of the user's that is on
	 * disk nowhere, and the routes that overwrite a journalled path — a Workspace tar, a Project
	 * bundle, an ingest — are ones where the user may well want it back.
	 */
	| 'superseded';

export interface ReplaySkipped {
	readonly path: StorePath;
	readonly reason: ReplaySkipReason;
	/** One sentence, written for the user. */
	readonly detail: string;
	/**
	 * Whether the entry is still in the journal. `false` means this report is the only trace of it.
	 *
	 * Every skip used to be a drop. `'superseded'` and `'cannot-tell-which-is-newer'` are not, so
	 * "deliberately not put back" stopped being a single thing to say about what happens next — and
	 * the two are kept for different reasons. A superseded entry can never be applied and is held only
	 * so that a refusal does not destroy an edit; an undecidable one is held because it is *waiting on
	 * the scholar*, which is a state it is supposed to persist in.
	 *
	 * ⚠ **Rendered, not merely recorded.** A kept entry is the one thing in this report that comes
	 * back at the *next* startup, byte-identically — `RecoveredEdits.svelte` keys its dismissal on
	 * the report's contents, so a notice about a kept entry is one the user cannot clear by reading
	 * it. So this field is what puts an exit beside exactly those rows and nothing else, the same
	 * remedy an unfinished deletion already offers, and for the same reason: the alternative is a
	 * warning at every visit whose only other exit is destroying a Workspace's whole journal.
	 */
	readonly kept: boolean;
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

/** What a replay may be told beyond the store it is writing into. */
export interface ReplayOptions {
	/**
	 * Which Projects the user deleted (ticket 21).
	 *
	 * Without it the replay behaves exactly as it did before, which is the honest default for a
	 * browser that cannot store the record at all — the same absence-is-a-state shape the journal
	 * storage itself has.
	 */
	readonly deleted?: DeletedProjects;
	/**
	 * The journal this Workspace's session already holds, if it has one (ticket 07).
	 *
	 * Without it a replay builds its own and throws it away, and everything it learned about the
	 * store goes with it. That matters for one case in particular: a `'superseded'` skip keeps an
	 * entry whose baseline is provably stale, and the only thing that stops that refusal repeating
	 * for every later edit to the path is `WriteAheadJournal.observe` — called here, on the instance
	 * the rest of the session will record through.
	 */
	readonly journal?: WriteAheadJournal;
}

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
	workspace: string,
	options: ReplayOptions = {}
): Promise<JournalReplayReport> {
	// The session's own journal where there is one, so that what this run *observes* about the store
	// outlives the call. See {@link ReplayOptions.journal}.
	const journal = options.journal ?? new WriteAheadJournal(storage, workspace);
	const { entries, problems } = readJournal(storage, workspace);

	const restored: StorePath[] = [];
	const skipped: ReplaySkipped[] = [];
	const failed: ReplayFailure[] = [];

	for (const entry of entries) {
		// Inside the `try`, so a precondition that cannot be evaluated — an unreachable Workspace
		// mid-walk — is one reported failure with its entry kept, rather than a rejection that
		// abandons every remaining entry unexamined.
		try {
			const blocked = await missingOwner(store, entry.path, options.deleted);
			if (blocked !== null) {
				skipped.push(blocked);
				// The thing it belonged to is gone, so the entry can never be used and would otherwise
				// be reported at every startup for ever. Dropped *after* being named in the report, and
				// only on the unambiguous evidence `missingOwner` insists on.
				//
				// `discard` and not `forget`: these bytes reached no store and never will, and `forget`
				// would file them as what the store holds for that path.
				journal.discard(entry.path);
				continue;
			}

			// After `missingOwner`, so a deleted Project's entry is refused by name rather than by
			// whatever its files happen to say, and before the write, because this is the question
			// that decides whether there is a write at all.
			//
			// **An absent file is the one case that needs no question**: nothing is there, so nothing can
			// be reverted, and the write at the bottom is reached with no verdict asked for. That is
			// narrower than "nothing newer exists" — a deletion is a newer state too, and this recreates
			// the file over one — but no deletion path leaves a live entry behind to reach it.
			const current = await currentBytes(store, entry.path);
			const verdict = current === null ? null : compare(entry, current);
			if (current !== null && verdict === 'already-in-the-store') {
				skipped.push({
					path: entry.path,
					reason: verdict,
					kept: false,
					detail:
						`An unsaved change to “${entry.path}” did not need to be put back — your ` +
						`Workspace already had it.`
				});
				// The store has these bytes, which is the one condition under which an entry is meant to
				// go; this is exactly the `forget` that did not happen when it should have.
				journal.forget(entry.path);
				continue;
			}
			if (current !== null && verdict === 'cannot-tell-which-is-newer') {
				// Kept, and the sentence carries what a person needs to choose between the two: how big
				// each is, and when the held one was made. The bytes themselves are not copied into the
				// report — a chooser reads them from `readJournal` and `store.read`, which is where they
				// already are, and a report is not a place to hold two copies of a file.
				skipped.push({
					path: entry.path,
					reason: verdict,
					kept: true,
					detail:
						`An unsaved change to “${entry.path}” was found, and Ballastella cannot tell ` +
						`whether it is newer than the file in your Workspace. The unsaved copy is ` +
						`${describeSize(entry.bytes.length)}${entry.at === '' ? '' : `, from ${entry.at}`}; ` +
						`the file in your Workspace is ${describeSize(current.length)}. It has been kept ` +
						`rather than put back, so nothing has been overwritten.`
				});
				continue;
			}
			if (current !== null && verdict === 'superseded') {
				// ⚠ **Tell the journal what is actually there, or this refusal becomes a standing one.**
				// The entry is kept, and `WriteAheadJournal.#baseline` would otherwise carry its now
				// provably-stale `held` into the *next* edit to this path — refusing that one too, and
				// the one after, until some save finally succeeds. The store has just been read; this is
				// the one moment anything in this application knows the truth for certain.
				if (current !== null) journal.observe(entry.path, current);
				// Kept, and not written. See {@link ReplaySkipReason}: the entry is the only copy of an
				// edit that is on disk nowhere, so the answer is to say so rather than to drop it.
				skipped.push({
					path: entry.path,
					reason: verdict,
					kept: true,
					detail:
						`An unsaved change to “${entry.path}” was not put back, because that file has been ` +
						`changed since the change was made — putting it back would undo the newer one. ` +
						`Your copy has been kept.`
				});
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

/** What replay decided to do with one entry, once its owner had been checked. */
type ReplayVerdict = 'write' | 'already-in-the-store' | 'cannot-tell-which-is-newer' | 'superseded';

/**
 * What the store holds at `path` now, or `null` when it holds nothing.
 *
 * ⚠ **Only `PathNotFoundError` is read as "nothing".** Anything else is a Workspace that could not
 * answer — an unplugged drive, a permission that lapsed — and it is rethrown so the entry becomes a
 * reported `failed` that is kept and tried again, rather than an absence that licenses a write. That
 * is the direction `hasHistoricalMap` and `missingOwner` both take, for the same reason.
 */
async function currentBytes(store: ProjectStore, path: StorePath): Promise<Bytes | null> {
	try {
		return await store.read(path);
	} catch (cause) {
		if (cause instanceof PathNotFoundError) return null;
		throw cause;
	}
}

/**
 * Whether this entry may be written over what the store holds now (ticket 07).
 *
 * The whole of "replay never reverts newer bytes". Every branch is named for the answer it gives and
 * driven by a `describe` of the same name in `replay.test.ts`; the module header carries what no
 * single branch says. Kept out of the loop so it is one function a reader can hold in their head.
 */
function compare(entry: JournalEntry, current: Bytes): ReplayVerdict {
	if (sameBytes(current, entry.bytes)) return 'already-in-the-store';
	// No baseline, and something different on disk: the evidence is equally consistent with a rescue
	// and with a revert. Neither silent answer is defensible, so the question is asked instead.
	if (entry.held === null) return 'cannot-tell-which-is-newer';
	if (fingerprintOf(current) !== entry.held) return 'superseded';
	return 'write';
}

/**
 * ⚠ **The length guard is load-bearing and easy to lose.** Without it, `every` walks only the
 * shorter run, so any byte string that is a strict *prefix* of the other compares equal — and both
 * of this function's callers then answer wrongly in a destructive direction: an entry whose store
 * content is a prefix of it is reported "already in the store" and dropped, destroying the edit, and
 * a growing file's baseline compares equal, licensing the exact revert this module exists to
 * prevent. Fixtures that differ in length hide it, which is why `replay.test.ts` drives a
 * prefix pair in both positions.
 */
const sameBytes = (left: Bytes, right: Bytes): boolean =>
	left.length === right.length && left.every((byte, at) => byte === right[at]);

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
 *
 * **A third layer arrived with ticket 21, and it is the only one that can see inside that
 * exemption**: `DeletedProjects`, the user's deletion written down synchronously at the moment they
 * asked for it. Layers 1 and 2 both reason from *files* — an entry swept at deletion time, or a
 * manifest that is no longer readable — and neither can say anything about `project.json` itself,
 * because its absence is equally the signature of a Project being born. Layer 3 reasons from the
 * gesture, which has an answer for it. It goes first, below.
 */
async function missingOwner(
	store: ProjectStore,
	path: StorePath,
	deleted: DeletedProjects | undefined
): Promise<ReplaySkipped | null> {
	// ⚠ **First, and above the `project.json` exemption below, which is the only reason it works**
	// (ticket 21). Every other check here asks the store whether something is still there, and none
	// of them can be asked about `<project>/project.json`: writing that file is *what makes the
	// Project exist*, so an interrupted `createProject` has no directory to point at and requiring
	// one would discard the only copy of a Project the user has just made. This asks a different
	// question, of a different source — did the user delete this Project? — and that one has an
	// answer for `project.json` too.
	//
	// A reserved directory (`images/`, `alignments/`, `base-map/`) can never be created as a Project
	// and therefore never recorded here, so asking before the branches below costs nothing and cannot
	// misfire.
	const owner = topLevelSegment(path);
	if (owner !== path && deleted?.has(owner) === true) {
		return {
			path,
			reason: 'project-deleted',
			kept: false,
			detail:
				`An unsaved change to “${path}” was not put back, because you deleted the ` +
				`Project it belongs to.`
		};
	}

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
					kept: false,
					detail:
						`An unsaved change to “${path}” was not put back, because the Historical Map it ` +
						`belongs to is no longer in this Workspace.`
				};
	}

	// The Workspace's own directories are not Projects and never can be, so there is no manifest to
	// look for. From the shared list rather than spelled again, so a fourth reserved directory
	// arrives here without anybody having to remember this line exists.
	if (RESERVED_DIRECTORY_NAMES.includes(owner)) return null;
	// Anything else at the Workspace root is not a Project's and has no owner to check.
	if (owner === path) return null;
	if (path === projectFilePath(owner)) return null;

	try {
		await store.read(projectFilePath(owner));
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
			kept: false,
			detail:
				`An unsaved change to “${path}” was not put back, because the Project it belongs to is ` +
				`no longer in this Workspace.`
		};
	}
}
