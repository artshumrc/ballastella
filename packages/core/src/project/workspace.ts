import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import type { Autosave } from '../autosave/autosave.js';
import type {
	DeletedProjects,
	DeletionRecord,
	ProjectIdentity
} from '../autosave/deleted-projects.js';
import { IMAGE_DIRECTORY } from './image-files.js';
import {
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	newProjectFile,
	parseProjectFile,
	projectFilePath,
	serialiseProjectFile,
	type ProjectFile
} from './project-file.js';
import { PathNotFoundError, topLevelSegment, type ProjectStore } from '../store/project-store.js';

/**
 * The Workspace directories that are not Projects and never can be (ADR-0023).
 *
 * `images/` holds every Historical Map's pyramid and `alignments/` holds every Alignment — both shared
 * by every Project — and `base-map/` is the opt-in offline tile cache (ADR-0025). A Project landing on
 * one of those names would put `project.json` and `annotations/` inside the pool of shared material,
 * and deleting that Project would take every Project's Historical Maps with it.
 *
 * Refused at **creation**, which is the point. `claimedByPublishing` refuses a colliding name at
 * *publish* time, and by then the Project exists and holds a semester's work; the only remedy on offer
 * is a rename, and the folder has already been sitting in the middle of the images.
 */
export const RESERVED_DIRECTORY_NAMES: readonly string[] = [
	// From the constants rather than spelled again: `imageDirectory` and `alignmentPath` are built from
	// these two, so a rename that missed this list would leave the Workspace writing its shared material
	// into a directory a Project is allowed to be created in — which is the collision this list exists
	// to refuse, arriving by the one route it could not see.
	IMAGE_DIRECTORY,
	ALIGNMENT_DIRECTORY,
	// A literal because there is no constant to take it from: `base-map/` is written by publishing
	// (`VIEWER_FILE_PATHS`) and read by the catalog's archive paths (ADR-0020, ADR-0025), neither of
	// which names a directory on its own.
	'base-map'
];

/**
 * A Project was asked for under a name the Workspace itself needs.
 *
 * Names the reservation rather than only refusing, because the user typed a perfectly reasonable
 * display name — "Images", "Base Map" — and `toDirectoryName` is what turned it into a collision. What
 * they need to know is that the *folder* name is taken by the Workspace and that the display name is
 * not the problem.
 */
export class ReservedDirectoryNameError extends Error {
	/** The folded folder name that was refused. */
	readonly directory: string;

	constructor(directory: string, displayName: string) {
		super(
			`“${displayName}” would go in a folder called “${directory}”, and this Workspace keeps its ` +
				`shared Historical Maps, Alignments, and Base Map tiles in ` +
				`${RESERVED_DIRECTORY_NAMES.map((name) => `“${name}”`).join(', ')} — so “${directory}” is ` +
				`reserved and cannot be a Project. Choose another name. Nothing has been created.`
		);
		this.name = 'ReservedDirectoryNameError';
		this.directory = directory;
	}
}

/**
 * Whether `name` is one of {@link RESERVED_DIRECTORY_NAMES}, compared the way a filesystem would.
 *
 * **Through {@link foldName}, and that is not decoration.** APFS and NTFS are both case-insensitive and
 * APFS folds Unicode composition as well, so `getDirectoryHandle('Images', { create: true })` hands
 * back the existing `images` — the shared pool — on the backend most users have. A reserved-name check
 * that compared raw strings would wave `Images` and a decomposed `Alignments` straight through, for
 * exactly the reason the collision check could not compare raw strings either.
 */
export const isReservedDirectoryName = (name: string): boolean =>
	RESERVED_DIRECTORY_NAMES.some((reserved) => foldName(reserved) === foldName(name));

/** What the hub page needs about one Project without opening it. */
export interface ProjectSummary {
	/** The Project's identity: its directory name inside the workspace (ADR-0008). */
	readonly directory: string;
	/** The display name. May be shared with another Project. */
	readonly name: string;
	/** ISO 8601, or `''` for a Project whose manifest never recorded one. */
	readonly updatedAt: string;
	/**
	 * Why this Project cannot be opened, if it cannot. The hub still lists it: a Project from a
	 * newer version of the app is a thing the user owns and needs to see, and hiding it would
	 * be a worse failure than refusing to open it (ADR-0010).
	 */
	readonly problem: 'format-too-new' | 'unreadable' | null;
}

export interface WorkspaceOptions {
	/**
	 * Routes writes through autosave. Without one, every mutation is written immediately —
	 * which is what the tests that assert on files want, and what the hub's discrete actions
	 * want too.
	 */
	readonly autosave?: Autosave;
	/** The clock, injectable so `updatedAt` is assertable. */
	readonly now?: () => Date;
	/**
	 * Where "the user deleted this Project" is written down synchronously (ticket 21).
	 *
	 * Optional, and its absence is a real state rather than a default — the same shape, and the same
	 * reason, as {@link EditorSessionOptions.journalStorage}: a browser with no usable `localStorage`
	 * cannot offer this, and a silent stand-in would make the application claim a guarantee it has
	 * not got. Without one, a deletion is exactly as durable as the page it was asked for on, which
	 * is what it was before ticket 21.
	 */
	readonly deleted?: DeletedProjects;
	/**
	 * Called when the browser refused to write a deletion down (ticket 21).
	 *
	 * `DeletedProjects.record` answers "is this durable", and the first cut of this class dropped the
	 * answer on the floor. Two real browsers reach it — a `localStorage` full of one enormous
	 * Annotation collection (ADR-0017), and a Safari with cookies blocked, where reads answer and
	 * every write rejects — and in both the deletion is back to being only as durable as the page.
	 * That is a **second refusal**, with a different remedy from `onJournalRefused`'s, and ADR-0017
	 * asks for two refusals rather than one.
	 */
	readonly onDeletionNotRecorded?: (directory: string) => void;
}

/** Why an unfinished deletion was not carried out, in one sentence written for the user. */
export interface RefusedDeletion {
	readonly directory: string;
	readonly detail: string;
}

/** What a startup found still to do, what it did, and what it would not do. */
export interface FinishedDeletions {
	/** Deletions that had not finished and now have. */
	readonly finished: readonly string[];
	/**
	 * Deletions this startup **refused to carry out**, whose record is kept (ticket 21, review 2).
	 *
	 * The list that exists because this is the one step of the recovery chain that *destroys* files
	 * rather than restoring them, and it had no precondition at all. A folder Workspace's key is its
	 * folder's name, which two folders may share (ADR-0017), so "the record names this directory" is
	 * not evidence that this is the Project the user deleted. Where the manifest does not still say
	 * what it said at the gesture, nothing is removed and the refusal is named.
	 */
	readonly refused: readonly RefusedDeletion[];
	/**
	 * Deletions that still have not finished, and whose record is **kept** for the next startup.
	 *
	 * Named rather than counted, and kept rather than dropped, for the reason `replayJournal`'s
	 * `failed` list is: an unplugged drive or a lapsed permission must cost a delay, never the
	 * gesture. Nothing here is reported as done.
	 */
	readonly unfinished: readonly string[];
}

/** Whether a startup's deletions are worth telling the user about. */
export const deletionsAreNoteworthy = (report: FinishedDeletions): boolean =>
	report.finished.length > 0 || report.refused.length > 0 || report.unfinished.length > 0;

/**
 * The Projects in one workspace, and their whole lifecycle.
 *
 * A workspace is a directory; Projects are directories inside it (ADR-0008). There is no
 * index file and nothing to keep in sync — the list of Projects *is* whatever directories
 * contain a `project.json`, which is what makes the workspace survive being zipped, cloned,
 * or edited by hand, and what makes a librarian's copy readable with no proprietary index.
 */
export class Workspace {
	readonly #store: ProjectStore;
	readonly #autosave: Autosave | undefined;
	readonly #now: () => Date;
	readonly #deleted: DeletedProjects | undefined;
	readonly #onDeletionNotRecorded: (directory: string) => void;

	constructor(store: ProjectStore, options: WorkspaceOptions = {}) {
		this.#store = store;
		this.#autosave = options.autosave;
		this.#now = options.now ?? (() => new Date());
		this.#deleted = options.deleted;
		this.#onDeletionNotRecorded = options.onDeletionNotRecorded ?? (() => undefined);
	}

	get store(): ProjectStore {
		return this.#store;
	}

	/**
	 * Every Project, most recently touched first.
	 *
	 * Rejects when the workspace cannot be reached — moved, deleted, or permission declined.
	 * The caller renders that as a normal state with a locate-again affordance, not an error
	 * boundary (ADR-0008).
	 */
	async listProjects(): Promise<ProjectSummary[]> {
		const paths = await this.#store.list('');
		const directories = paths
			.filter((path) => path === projectFilePath(topLevelSegment(path)))
			.map(topLevelSegment);

		const summaries = await Promise.all(
			directories.map(async (directory) => this.#summarise(directory))
		);
		return summaries.sort(
			(a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.directory.localeCompare(b.directory)
		);
	}

	/**
	 * Open a Project's manifest.
	 *
	 * Reads and parses; writes nothing, ever. Merely looking at last year's work must not
	 * modify a single byte, or opening a Project in a git repository produces an unexplained
	 * diff and opening one in a Dropbox folder syncs a rewrite to every other machine — both of
	 * which read as the tool corrupting data (ADR-0010).
	 *
	 * @throws ProjectFormatTooNewError for a Project from a newer version of the app
	 */
	async readProject(directory: string): Promise<ProjectFile> {
		return parseProjectFile(await this.#store.read(projectFilePath(directory)));
	}

	/**
	 * Write a Project's manifest, stamping `updatedAt`.
	 *
	 * @param options.debounce true for a continuing edit such as typing, which should coalesce;
	 *   false — the default — for a discrete action, which must not be lost to a closed tab.
	 */
	async writeProject(
		directory: string,
		file: ProjectFile,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const bytes = serialiseProjectFile({ ...file, updatedAt: this.#now().toISOString() });
		const path = projectFilePath(directory);
		if (options.debounce && this.#autosave) {
			this.#autosave.queue(path, bytes);
			return;
		}
		if (this.#autosave) {
			await this.#autosave.commit(path, bytes);
			return;
		}
		await this.#store.write(path, bytes);
	}

	/**
	 * Create a Project. Its directory name is derived from the display name and made unique.
	 *
	 * **Refused when the derived folder name is one the Workspace itself needs** — see
	 * {@link RESERVED_DIRECTORY_NAMES}. Refused rather than quietly suffixed: `toDirectoryName('Images')`
	 * is `images`, and a user who asked for a Project called "Images" and got one called "images-2" has
	 * been told nothing about why. This runs before `#unusedDirectory`, which *does* treat the reserved
	 * names as taken — so nothing else in this class can land on one either.
	 *
	 * @throws ReservedDirectoryNameError when the folder name is reserved
	 */
	async createProject(displayName: string): Promise<ProjectSummary> {
		const name = displayName.trim() || 'Untitled Project';
		const preferred = toDirectoryName(name);
		if (isReservedDirectoryName(preferred)) {
			throw new ReservedDirectoryNameError(preferred, name);
		}
		const directory = await this.#unusedDirectory(name);
		this.#claim(directory);
		await this.writeProject(directory, newProjectFile(name, this.#now()));
		return this.#summarise(directory);
	}

	/**
	 * Change a Project's display name.
	 *
	 * The directory is untouched: identity is the directory name, never the display name, so
	 * two Projects may share a display name and renaming can never collide, break a `?p=` link
	 * somebody was given, or move files under a sync client's feet (ADR-0008).
	 */
	async renameProject(
		directory: string,
		displayName: string,
		options: { debounce?: boolean } = {}
	): Promise<ProjectSummary> {
		const file = await this.readProject(directory);
		await this.writeProject(directory, { ...file, name: displayName }, options);
		return this.#summarise(directory);
	}

	/** Copy every file of a Project into a new directory. */
	async duplicateProject(directory: string): Promise<ProjectSummary> {
		const file = await this.readProject(directory);
		const name = `${file.name} (copy)`;
		const copy = await this.#unusedDirectory(name);
		this.#claim(copy);

		for (const path of await this.#store.list(`${directory}/`)) {
			const destination = `${copy}/${path.slice(directory.length + 1)}`;
			await this.#store.write(destination, await this.#store.read(path));
		}
		await this.writeProject(copy, { ...file, name });
		return this.#summarise(copy);
	}

	/**
	 * Remove a Project and everything in it.
	 *
	 * @param was what the Project's manifest said at the moment the user pressed Delete — normally
	 *   the `ProjectSummary` the hub was rendering. It is what {@link finishInterruptedDeletions}
	 *   checks before removing a byte, so a caller that passes nothing gets the deletion it asked for
	 *   *now* and **no** unattended completion later: the record is still written, still refuses a
	 *   replay, and still licenses nothing destructive. See `deleted-projects.ts`.
	 */
	async deleteProject(directory: string, was: ProjectIdentity | null = null): Promise<void> {
		// ⚠ **Synchronously, and before the first `await` — which is what makes it survive** (ticket
		// 21). Every line below is asynchronous, against OPFS, and a document that is being unloaded
		// does not run the continuation (ADR-0017, "Rule 3, amended"). Measured at `--repeat-each=20`
		// on the regression this closes: in 4 runs of 20 the very next line had not resolved before
		// the next navigation tore the page down, nothing had been removed, and a Project the user
		// had deleted was back on the hub at the next startup. See `deleted-projects.ts`.
		//
		// Here rather than in the caller so that no second route to deleting a Project can be added
		// without it — `EditorSession.deleteProject` is one caller, and {@link
		// finishInterruptedDeletions} below is another.
		if (this.#deleted && !this.#deleted.record(directory, was)) {
			// The answer was being dropped. A browser that will not hold the note is one where this
			// deletion is only as durable as the tab, and that is a sentence the user can act on while
			// the page still exists — the same argument `Autosave.onJournalRefused` makes for an edit.
			this.#onDeletionNotRecorded(directory);
		}
		await this.#removeEverythingIn(directory);
		// Only now, and only because the removal above actually resolved. Forgetting before it would
		// be the same false claim `replayJournal` refuses to make: nothing is reported done that was
		// not done.
		this.#deleted?.forget(directory);
	}

	/**
	 * Carry out the deletions the user asked for and the page did not live long enough to finish.
	 *
	 * **Run at startup, before anything reads the Workspace.**
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE ONE STEP OF THE RECOVERY CHAIN THAT DESTROYS, AND THEREFORE THE ONE THAT ASKS FIRST
	 *
	 * Replay puts bytes back; this takes them away. Its first cut had **no precondition at all**: it
	 * took each name from `pending()` and removed every file under it. Reachable inside documented
	 * behaviour, because a folder Workspace's key is `folder:<folder name>` and the browser offers a
	 * page no stable identifier for a picked directory (ADR-0017 records the collision, and ADR-0023
	 * explicitly invites synced and copied folders):
	 *
	 *   delete `amsterdam-1625` in folder Workspace `maps` on a laptop → torn down in the window this
	 *   whole ticket exists for → record left → the user next opens a *different* folder also called
	 *   `maps` — an external drive, a colleague's copy, a second checkout — and that folder's
	 *   `amsterdam-1625` is removed before the listing renders.
	 *
	 * So each record has to answer for itself before anything is removed:
	 *
	 *   1. **A reserved name is never a Project** and can never have been deleted as one, so a record
	 *      naming `images/` — which nothing writes today — could not reach `images/` through here.
	 *   2. **The record has to carry what it was aimed at.** A record with no `was` (see
	 *      `DeletedProjects`) is a gesture whose target was never written down; it still refuses a
	 *      replay, and it removes nothing.
	 *   3. **The manifest has to still say exactly that.** `readProject` is asked, and the display
	 *      name and `updatedAt` are compared. A different Project in a same-named folder differs; so
	 *      does one the user has since reopened and edited, which closes the second half of the same
	 *      hazard — `#claim` fires from `createProject` and `duplicateProject` and never from merely
	 *      *opening* an existing Project, so before this a reopened Project could be deleted under
	 *      the user at a later startup.
	 *   4. **No manifest at all is not a licence.** `#removeEverythingIn` deletes `project.json`
	 *      **last** precisely so that an interrupted deletion always still has its evidence; so a
	 *      directory with no manifest is either a deletion that got all the way to the end, or
	 *      somebody else's folder. Neither is a reason to walk it and delete files, and the
	 *      abandoned-write sweep — which can only touch this application's own temporary files — is
	 *      the whole of what happens.
	 *
	 * What is left is a bound of the same shape as replay's and no larger: an unfinished deletion can
	 * only be finished against a Project whose manifest is still byte-for-byte the one the user
	 * deleted.
	 *
	 * Idempotent, and deliberately so: a Project that is already gone deletes to nothing, which is
	 * exactly the ordinary case here — the removal usually *had* finished and only the note saying so
	 * was lost.
	 */
	async finishInterruptedDeletions(): Promise<FinishedDeletions> {
		const finished: string[] = [];
		const refused: RefusedDeletion[] = [];
		const unfinished: string[] = [];
		for (const record of this.#deleted?.pending() ?? []) {
			const { directory } = record;
			try {
				const verdict = await this.#verdictOn(record);
				if (verdict.act === 'refuse') {
					refused.push({ directory, detail: verdict.detail });
					continue;
				}
				const removed = await this.#removeEverythingIn(directory);
				this.#deleted?.forget(directory);
				// Named only when something was actually taken. A record whose Project had already gone
				// — the ordinary case, where the removal finished and only the note saying so was lost,
				// and the case of a second folder that never held it — is quietly dropped rather than
				// reported as a deletion carried out at startup. Nothing is reported done that was not
				// done, which is `replayJournal`'s rule and this is the destructive side of it.
				if (removed > 0) finished.push(directory);
			} catch {
				// Kept, and the loop goes on. One unreachable Project must not leave the others
				// half-deleted, and a Workspace that cannot answer today may answer tomorrow.
				unfinished.push(directory);
			}
		}
		return { finished, refused, unfinished };
	}

	/**
	 * Whether `record` may be carried out, and the sentence to show the user when it may not.
	 *
	 * Rejects — rather than answering — when the store could not be asked, so an unreachable
	 * Workspace lands in `unfinished` and is tried again, never in `refused`.
	 */
	async #verdictOn(
		record: DeletionRecord
	): Promise<{ act: 'remove' } | { act: 'refuse'; detail: string }> {
		const { directory, was } = record;
		if (isReservedDirectoryName(directory)) {
			return {
				act: 'refuse',
				detail:
					`A recorded deletion of “${directory}” was not carried out: that is a folder this ` +
					`Workspace keeps its own shared material in, and it can never have been a Project. ` +
					`Nothing was removed.`
			};
		}
		if (was === null) {
			return {
				act: 'refuse',
				detail:
					`A recorded deletion of “${directory}” was not carried out, because this browser did ` +
					`not keep a note of which Project it named. Nothing was removed — delete it again if ` +
					`it is still here.`
			};
		}
		let file: ProjectFile;
		try {
			file = await this.readProject(directory);
		} catch (cause) {
			if (cause instanceof PathNotFoundError) {
				// Nothing here answers to that gesture. Either the removal did finish and only the note
				// saying so was lost — the ordinary case — or this is another folder of the same name
				// that never held it. `#removeEverythingIn` then finds nothing to delete and reports
				// nothing, and its abandoned-write sweep can only touch this application's own
				// temporary files, which are unambiguous wherever they are.
				return { act: 'remove' };
			}
			if (
				cause instanceof ProjectFormatTooNewError ||
				cause instanceof ProjectFileUnreadableError
			) {
				// A manifest that will not read is still a Project the hub lists and offers Delete on
				// (ADR-0010), so this has to be resumable — but it is compared the way the user saw it
				// rather than waved through. `#summarise` renders both problems as the directory name
				// and an empty `updatedAt`, and that is exactly what the record will have captured; a
				// record holding anything else was aimed at a Project that could still be read, which
				// this is not.
				if (was.name === directory && was.updatedAt === '') return { act: 'remove' };
				return {
					act: 'refuse',
					detail:
						`A recorded deletion of “${was.name}” was not carried out: the project.json in ` +
						`“${directory}” cannot be read, so this is not the Project that was deleted. ` +
						`Nothing was removed.`
				};
			}
			throw cause;
		}
		if (file.name === was.name && file.updatedAt === was.updatedAt) return { act: 'remove' };
		return {
			act: 'refuse',
			detail:
				`A recorded deletion of “${was.name}” was not carried out: the Project in “${directory}” ` +
				`is now “${file.name}”, last changed ${file.updatedAt || 'at an unrecorded time'}, which ` +
				`is not the one that was deleted. Nothing was removed. This is what a second Workspace ` +
				`folder of the same name — another drive, a colleague's copy, a second checkout — looks ` +
				`like from here.`
		};
	}

	/**
	 * Remove every byte under `directory`, **with `project.json` last**.
	 *
	 * ⚠ **The order is chosen for the interruption, not for the success** — the same reasoning
	 * `deleteHistoricalMap` states for its own order. `project.json` is the whole of the evidence
	 * {@link finishInterruptedDeletions} checks before it will remove anything, so removing it first
	 * would leave a torn-down deletion with a record it can no longer justify and files it may no
	 * longer take. Last, the invariant is simple: **while an interrupted deletion has anything left
	 * to remove, it still has its manifest.**
	 *
	 * The Project stays listed until the last moment as a consequence, which is the honest reading
	 * anyway: it is not gone until it is gone.
	 *
	 * @returns how many files were removed, so a caller can tell "carried out a deletion" from "found
	 *   there was nothing left to do" and report only the first.
	 */
	async #removeEverythingIn(directory: string): Promise<number> {
		const manifest = projectFilePath(directory);
		const paths = await this.#store.list(`${directory}/`);
		let removed = 0;
		for (const path of paths) {
			if (path === manifest) continue;
			await this.#store.delete(path);
			removed += 1;
		}
		if (paths.includes(manifest)) {
			await this.#store.delete(manifest);
			removed += 1;
		}
		// Everything in it includes the half-finished writes `list` cannot report and `delete`
		// cannot be handed. Without this a "deleted" Project's directory survives on disk
		// permanently, holding bytes that are also missing from the totals tickets 15 and 16 warn
		// from — and in ticket 12's real folder, a stray dotfile the user commits to git.
		await this.#store.reclaimAbandonedWrites(`${directory}/`);
		return removed;
	}

	/**
	 * A new Project is taking `directory`, so no unfinished deletion names it any more (ticket 21).
	 *
	 * ⚠ **Synchronously, and with no `await` between here and the write that creates the Project.**
	 * That is the whole point of calling it *here* rather than after the creation resolves: an await
	 * in between is a window in which the page can go away leaving a record that says "the user
	 * deleted this folder" over a Project they have just made, and the next startup would delete it.
	 * That is precisely the shape of fresh data-loss path ticket 20's first cut opened twice, and it
	 * is not being reintroduced.
	 *
	 * Safe against the opposite mistake — forgetting a deletion that has not happened — because
	 * `#unusedDirectory` has just answered that no Project occupies this name, so there is nothing
	 * here for the record to be about.
	 *
	 * ⚠ **Deliberately not resting on "`finishInterruptedDeletions` has already run"**, which the
	 * first cut of this comment did. That is true only because `WorkspaceStorage.#replayAndReport`
	 * happens to call it first, which no test and no type pins — and it is not needed: the record
	 * that would be a hazard here is one aimed at a *previous* Project of this folder name, and
	 * {@link finishInterruptedDeletions} would refuse it anyway on the manifest it no longer matches.
	 * This drops it early so the user is never shown a refusal about a Project they have replaced.
	 */
	#claim(directory: string): void {
		this.#deleted?.forget(directory);
	}

	async #summarise(directory: string): Promise<ProjectSummary> {
		try {
			const file = await this.readProject(directory);
			return {
				directory,
				name: file.name || directory,
				updatedAt: file.updatedAt,
				problem: null
			};
		} catch (cause) {
			if (cause instanceof ProjectFormatTooNewError) {
				return { directory, name: directory, updatedAt: '', problem: 'format-too-new' };
			}
			if (cause instanceof ProjectFileUnreadableError || cause instanceof PathNotFoundError) {
				return { directory, name: directory, updatedAt: '', problem: 'unreadable' };
			}
			throw cause;
		}
	}

	/**
	 * Every top-level name already in the workspace, folded for comparison.
	 *
	 * Not only the ones holding a Project: a new Project must not land inside a directory that is
	 * already there for some other reason.
	 */
	async #takenNames(): Promise<Set<string>> {
		const paths = await this.#store.list('');
		return new Set([
			// Seeded, so `#unusedDirectory` can never *offer* a reserved name either — which matters
			// because it is what `createProject` and `duplicateProject` land on. An empty Workspace holds
			// none of these directories yet, so listing alone would say they were free.
			...RESERVED_DIRECTORY_NAMES.map(foldName),
			...paths.map((path) => foldName(topLevelSegment(path)))
		]);
	}

	async #unusedDirectory(displayName: string): Promise<string> {
		const taken = await this.#takenNames();
		const base = toDirectoryName(displayName);
		if (!taken.has(foldName(base))) return base;
		for (let suffix = 2; ; suffix += 1) {
			const candidate = `${base}-${suffix}`;
			if (!taken.has(foldName(candidate))) return candidate;
		}
	}
}

/**
 * The Historical Map an archive entry belongs to, when the entry is shared Workspace material —
 * `null` when it is one of the Project's own files (ADR-0023).
 *
 * An archive is rooted at the Project and its paths did not change, so this is the whole of the
 * hoist: `images/<id>/…` and `alignments/<id>.json` name a Historical Map that belongs to the
 * Workspace, and everything else — `project.json`, `annotations/…` — belongs inside the Project
 * directory.
 *
 * Deliberately narrow about what counts. `images/<id>` with nothing after it is a directory entry
 * rather than a file; `alignments/nested/thing.json` names no Historical Map this app would write.
 * Both answer `null`, so they land inside the Project directory as ordinary files rather than being
 * hoisted somewhere their name does not describe — which is the reading that cannot put an archive's
 * bytes at a Workspace path it did not ask for.
 */
export function hoistedImageId(archivePath: string): string | null {
	const segments = archivePath.split('/');
	if (segments[0] === IMAGE_DIRECTORY) {
		const id = segments[1];
		return segments.length > 2 && id !== undefined && id !== '' ? id : null;
	}
	if (segments[0] === ALIGNMENT_DIRECTORY && segments.length === 2) {
		const name = segments[1] ?? '';
		return name.endsWith('.json') && name.length > '.json'.length
			? name.slice(0, -'.json'.length)
			: null;
	}
	return null;
}

/**
 * A directory name reduced to what a filesystem will actually treat as distinct.
 *
 * The collision check used to be an exact string comparison, and that is only correct on a
 * case-sensitive, composition-sensitive filesystem — which the two most common ones are not. macOS's
 * APFS and Windows' NTFS are both case-insensitive, and APFS folds Unicode composition as well, so
 * on ticket 12's File System Access backend `getDirectoryHandle('Amsterdam-1625', { create: true })`
 * hands back the **existing** `amsterdam-1625`. A user correctly shown a collision, typing a
 * different case into the rename field, was told there was no collision and then had their own
 * `project.json`, GeoJSON, and every same-named tile overwritten with their colleague's — SPEC story
 * 14's forbidden outcome, reached through the affordance built to prevent it.
 *
 * Folded rather than rejected, and folded on *both* sides, because the answer has to be the same
 * whichever spelling arrives first. NFC before case folding: `toLocaleLowerCase` on a decomposed
 * sequence does not compose it. Deliberately conservative — two names that are distinct on ext4 are
 * treated as colliding — because the cost of that is one offered rename, and the cost of the other
 * way round is somebody's work.
 */
const foldName = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * A display name to a directory name: `Amsterdam 1625` → `amsterdam-1625`.
 *
 * The result has to be usable as a path segment on every filesystem a workspace might sit on
 * and as a `?p=` query value, so it is deliberately narrow — lowercase ASCII, digits, and
 * hyphens — rather than a faithful transliteration. A name in a script that reduces to nothing
 * still gets a Project; it gets a generic directory and keeps its real display name.
 */
export function toDirectoryName(displayName: string): string {
	const slug = displayName
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
		.replace(/-+$/, '');
	return slug || 'project';
}
