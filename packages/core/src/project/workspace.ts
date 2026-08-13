import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import type { Autosave } from '../autosave/autosave.js';
import type { StoreContentObserver } from '../autosave/journal.js';
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
	 * Whether the Project is listed on a Published Site's Front Page (ADR-0032).
	 *
	 * `true` for a Project whose manifest this build cannot read, which is the same answer an absent
	 * field gets: a Project we cannot open is one we cannot claim its author took off the list.
	 */
	readonly onFrontPage: boolean;
	/**
	 * Why this Project cannot be opened, if it cannot. The hub still lists it: a Project from a
	 * newer version of the app is a thing the user owns and needs to see, and hiding it would
	 * be a worse failure than refusing to open it (ADR-0010).
	 */
	readonly problem: 'format-too-new' | 'unreadable' | null;
}

/**
 * Whether this Workspace's key names **one place**, or only a name the user can reproduce anywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONLY THING IN THIS APPLICATION THAT ESTABLISHES *WHICH DIRECTORY* A RECORD IS ABOUT
 *
 * A deletion record survives the page; the directory it names does not come with it. Something has
 * to say that the Workspace open now is the Workspace the gesture was made in, and there are only
 * two candidates: the **key** the record is filed under, and the **content** of the directory. The
 * second one cannot do it, and two rounds of this ticket were spent discovering that:
 *
 *   - the display name and `updatedAt` out of `project.json` are **copied verbatim** by Dropbox,
 *     Drive, rsync, a zip, or `cp -a`, and ADR-0010 guarantees that merely opening a Project writes
 *     nothing, so the copy *stays* byte-identical. A backup of the Project the user deleted matches
 *     every field of the record perfectly, because it **is** the Project the user deleted;
 *   - a manifest that will not read has no fields to compare at all, so any check degenerates to the
 *     directory name — which is the key again, and the part that is not unique;
 *   - a *missing* manifest is not evidence of anything: `#removeEverythingIn` writes it last, so its
 *     absence means either "the removal finished" or "this was never that Project".
 *
 * No fourth comparison fixes this, and each one added made the code claim a bound it did not have.
 * Identity is a property of the **key**, so it is asked for here, once:
 *
 *   - `'this-browser'` — the key names exactly one directory this origin owns and no other page can
 *     produce. `opfs:<name>`: a named Workspace in this browser's private storage (ADR-0001). A
 *     deletion recorded against it can only ever be finished against the directory it was made in.
 *   - `'a-name-anywhere'` — the key is a name a user can put on any folder on any drive.
 *     `folder:<folder name>`: the browser offers a page **no** stable identifier for a picked
 *     directory (ADR-0017 records the collision; ADR-0023 explicitly invites synced folders,
 *     colleagues' copies and second checkouts). Two folders called `maps` are one key.
 *
 * ⚠ **The default is `'a-name-anywhere'`, and it is the one that destroys nothing.** A caller that
 * has not thought about which it is has not established identity, which is exactly what the safe
 * answer means.
 */
export type WorkspaceIdentity = 'this-browser' | 'a-name-anywhere';

export interface WorkspaceOptions {
	/**
	 * Routes writes through autosave. Without one, every mutation is written immediately —
	 * which is what the tests that assert on files want, and what the hub's discrete actions
	 * want too.
	 */
	readonly autosave?: Autosave;
	/**
	 * Whether this Workspace's key establishes *which directory* a deletion record is about — see
	 * {@link WorkspaceIdentity}. Defaults to `'a-name-anywhere'`, which finishes no deletion
	 * unattended.
	 */
	readonly identity?: WorkspaceIdentity;
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
	/**
	 * Told what the store held for a path, at the moment this Workspace read it (ticket 07).
	 *
	 * ⚠ **This is what makes a stranded write recoverable rather than merely reported.** The
	 * write-ahead journal has to record, synchronously, what an edit was made *against*, and it
	 * cannot read the store to find out — `WriteAheadJournal.record` is synchronous by contract, and
	 * `Autosave` only ever learns what the store holds when a write is acknowledged, which is the one
	 * case that already worked. What is left is the read the application has already done: a Project
	 * is read before it can be edited, so the bytes are in hand at exactly the right moment.
	 *
	 * A callback rather than the journal itself, because a `Workspace` has no business holding one:
	 * this is a fact it happens to know and somebody else needs, and nothing here reads it back.
	 *
	 * Called for every read that **arrived**, including one whose bytes this build then refuses to
	 * parse: a failed read and a failed parse are different events, and the second one still knows
	 * exactly what the store holds. Nothing is reported when the read itself rejected — an absent or
	 * unreachable file tells nobody anything, and a guess in either direction is worse than the
	 * `'cannot-tell-which-is-newer'` this exists to avoid.
	 */
	readonly observer?: StoreContentObserver;
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

/**
 * What {@link Workspace.finishInterruptedDeletions} decided about one record.
 *
 * `'forget'` is the third answer the first two cuts of this did not have, and its absence was a
 * data-loss path: with only "remove" and "refuse" available, *"there is no manifest here"* had to be
 * spelled as `'remove'`, which walked a directory that was never this Project and deleted what was
 * inside it.
 */
type Verdict =
	| { readonly act: 'remove' }
	| { readonly act: 'forget' }
	| { readonly act: 'refuse'; readonly detail: string; readonly forget?: boolean };

/**
 * The two fields of a {@link ProjectSummary} that come out of the manifest.
 *
 * ⚠ **One spelling, because the deletion check compares against exactly what the hub rendered.**
 * There were two, and they disagreed on the empty name: `#summarise` published `file.name ||
 * directory` while the deletion check compared the raw `file.name`, so a Project whose manifest has
 * no name — reachable in a hand-editable folder Workspace, where `parseProjectFile` yields `''` —
 * could never match its own record. Its deletion could never be finished, its record was refused at
 * every startup for ever, and the user was shown `is now “”`.
 */
const identityOf = (directory: string, file: ProjectFile): ProjectIdentity => ({
	name: file.name || directory,
	updatedAt: file.updatedAt
});

/** The same, for a manifest that is there and will not read: there are no fields to take. */
const unreadableIdentity = (directory: string): ProjectIdentity => ({
	name: directory,
	updatedAt: ''
});

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
	readonly #observer: StoreContentObserver | undefined;
	readonly #identity: WorkspaceIdentity;

	constructor(store: ProjectStore, options: WorkspaceOptions = {}) {
		this.#store = store;
		this.#autosave = options.autosave;
		this.#now = options.now ?? (() => new Date());
		this.#deleted = options.deleted;
		this.#onDeletionNotRecorded = options.onDeletionNotRecorded ?? (() => undefined);
		this.#observer = options.observer;
		// The safe answer by default. See {@link WorkspaceIdentity}: a caller that has not said which
		// it is has not established identity, and unattended destruction is what that licenses.
		this.#identity = options.identity ?? 'a-name-anywhere';
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
		const path = projectFilePath(directory);
		// Before the read, not after it: what this read sees is evidence about the moment it *began*,
		// and a save landing while it is in flight must not be undone by it. See
		// {@link StoreContentObserver}.
		const at = this.#observer?.mark() ?? 0;
		const bytes = await this.#store.read(path);
		// ⚠ **Before the parse, and of the bytes rather than the model** (ticket 07). This is the
		// moment the user's view of the file is fixed, and what a later edit will have been made
		// against is these bytes exactly — a re-serialisation of the parsed model is merely
		// equivalent, and `serialiseProjectFile` stamps `updatedAt`, so a round trip would report
		// content the store has never held. Before the parse rather than after, because bytes that
		// arrived and did not parse are still bytes the store demonstrably holds.
		this.#observer?.observe(path, bytes, at);
		return parseProjectFile(bytes);
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

	/**
	 * Put a Project on the Published Site's Front Page, or take it off (ADR-0032).
	 *
	 * A discrete action rather than a continuing edit, so it is written straight through rather than
	 * debounced: the user pressed one control once, and the answer to "did that stick?" has to be yes
	 * before they close the tab.
	 *
	 * **It changes what a Front Page lists and nothing else.** The Project's files are untouched, its
	 * `?p=` address still resolves, and on a public Remote anyone who knows the directory name can read
	 * it — which is why nothing on this path is called private, hidden, or unpublished.
	 */
	async setProjectOnFrontPage(directory: string, onFrontPage: boolean): Promise<ProjectSummary> {
		const file = await this.readProject(directory);
		await this.writeProject(directory, { ...file, onFrontPage });
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
	 *   the `ProjectSummary` the hub was rendering. It is **not** what says this is the right
	 *   directory ({@link WorkspaceIdentity} is), but it is what
	 *   {@link finishInterruptedDeletions} checks to see whether the Project has *changed* since the
	 *   gesture — so a caller that passes nothing gets the deletion it asked for *now* and **no**
	 *   unattended completion later. See `deleted-projects.ts`.
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
		// ⚠ **Here rather than in `EditorSession`, and the `await` is the point** (ticket 21, review 3).
		//
		// The synchronous half is the sweep this class's caller used to do for it: the pending bytes,
		// the timers and the journal entries of everything under this directory, dropped so that rule
		// 3 cannot put the Project back at `pagehide` (see {@link Autosave.abandon}). Moved in for the
		// reason `record` above is in here: `EditorSession.deleteProject` is one route to deleting a
		// Project and {@link finishInterruptedDeletions} is another, and a third added later must not
		// be able to opt out.
		//
		// The asynchronous half is the hole the sweep alone left. `abandon` cannot call back a write
		// the store already has: `#drainLoop` captures its bytes and awaits `store.write`, so a
		// `project.json` write in flight at the moment of the click resolves **after**
		// `#removeEverythingIn` has listed the directory — recreating the manifest behind the
		// deletion, which then drops its own record on the line below and leaves nothing to catch it
		// at the next startup. Waited out here, between the record and the removal, so that the
		// synchronous guarantee this whole ticket exists for is untouched: if the page dies during
		// this await the record is already written and the next startup finishes the job.
		//
		// ⚠ **Bounded, and the answer is read** (round 4). A `store.write` is not guaranteed to
		// settle — a folder whose grant was revoked mid-write, an OPFS handle a second tab tore down
		// — and an unbounded wait here would be a Delete button that does nothing for ever, with the
		// Project still on screen. `abandon` gives up after a moment and says it gave up.
		const quiet = (await this.#autosave?.abandon(`${directory}/`)) ?? true;
		await this.#removeEverythingIn(directory);
		// Only now, and only because the removal above actually resolved. Forgetting before it would
		// be the same false claim `replayJournal` refuses to make: nothing is reported done that was
		// not done.
		//
		// And **not at all** when a write was still out there when the wait expired: it may land after
		// the listing above and put `project.json` back, which is precisely the hole this record
		// exists to catch. Kept, the next startup finds either nothing (and drops it silently) or the
		// manifest the deletion was aimed at (and finishes the job).
		if (quiet) this.#deleted?.forget(directory);
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
	 * took each name from `pending()` and removed every file under it, in whatever folder happened to
	 * be open. Its second cut compared the Project's display name and `updatedAt` against what the
	 * record captured — and **a copy reproduces both perfectly**, which is the whole of why the third
	 * cut stopped asking the directory who it is and started asking the key. See
	 * {@link WorkspaceIdentity}, which is the design and not a precondition.
	 *
	 * So, in order:
	 *
	 *   1. **A reserved name is never a Project** and can never have been deleted as one, so a record
	 *      naming `images/` — which nothing writes today — could not reach `images/` through here. It
	 *      is said once and then **dropped**: a record that can never license anything is not worth
	 *      warning about at every startup for the rest of the Workspace's life.
	 *   2. **No manifest at all is nothing to do.** `#removeEverythingIn` deletes `project.json`
	 *      **last**, precisely so that an interrupted deletion always still has its evidence — so a
	 *      directory with no manifest is either a deletion that got all the way to the end (the
	 *      ordinary case: the removal finished and only the note saying so was lost) or a directory
	 *      that was never that Project. **Neither is a reason to walk it and delete what is inside**,
	 *      which is what this used to do: `PathNotFoundError` from `readProject` means the *manifest*
	 *      is missing, not the directory, and a Drive folder mid-sync, a partial checkout, or any
	 *      folder of that name holding `annotations/*.geojson` and no manifest yet was listed and
	 *      emptied — and reported to the user as a deletion carried out, because `removed > 0`. The
	 *      record is dropped and the abandoned-write sweep, which can only touch this application's
	 *      own temporary files, is the whole of what happens.
	 *   3. **A Workspace whose key does not name one place finishes nothing unattended.** A
	 *      `'a-name-anywhere'` Workspace is told the deletion did not finish, the Project stays
	 *      listed, and deleting it again is one gesture — visible and non-destructive, which is
	 *      ADR-0017's rule for this whole chain. It is not a weaker version of the check below; it is
	 *      the recognition that *no* check of the directory's contents can be a stronger one.
	 *   4. **The record has to carry what it was aimed at.** A record with no `was` (see
	 *      `DeletedProjects`) is a gesture whose target was never written down; it still refuses a
	 *      replay, and it removes nothing.
	 *   5. **And the Project must not have changed since the gesture.** ⚠ **This is not an identity
	 *      check and must never be read as one** — step 3 is. Identity is already settled by the time
	 *      this runs; what `was` answers is whether the user has *reopened and edited* the Project in
	 *      the meantime, which `#claim` cannot see because it fires from `createProject` and
	 *      `duplicateProject` and never from merely opening one.
	 *
	 * What is left is a bound of the same shape as replay's and no larger: a deletion is finished
	 * unattended only in the directory it was made in, and only while that directory still holds the
	 * Project it was made against.
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
					// Kept unless the record could never license anything however long it is kept — a
					// reserved name. Without this the refusal is a **permanent** leak: nothing expires a
					// record, `#claim` drops one only on create or duplicate, and `discardOrphanedJournal`
					// by construction reaches only Workspaces that are *not* the one showing the refusal.
					// The user would be warned about it at every startup for ever, with no gesture that
					// makes it stop.
					if (verdict.forget) this.#deleted?.forget(directory);
					continue;
				}
				if (verdict.act === 'forget') {
					// Nothing left to answer for, so nothing is removed and nothing is said. The sweep is
					// this application's own abandoned temporary files under a path this application
					// wrote, which is unambiguous wherever the directory came from.
					await this.#store.reclaimAbandonedWrites(`${directory}/`);
					this.#deleted?.forget(directory);
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
	 * What to do with `record`: carry it out, drop it, or leave everything alone and say why.
	 *
	 * Rejects — rather than answering — when the store could not be asked, so an unreachable
	 * Workspace lands in `unfinished` and is tried again, never in `refused`. The five steps are
	 * documented on {@link finishInterruptedDeletions} and are in that order here.
	 */
	async #verdictOn(record: DeletionRecord): Promise<Verdict> {
		const { directory, was } = record;
		// 1. A reserved name can never have been a Project, so this record can never license anything
		//    — today or at any startup after it. Said once, then dropped.
		if (isReservedDirectoryName(directory)) {
			return {
				act: 'refuse',
				forget: true,
				detail:
					`A recorded deletion of “${directory}” was not carried out: that is a folder this ` +
					`Workspace keeps its own shared material in, and it can never have been a Project. ` +
					`Nothing was removed, and the note has been thrown away.`
			};
		}
		// 2. No manifest, so there is nothing here that answers to the gesture and nothing to do.
		let summary: ProjectIdentity;
		let readable: boolean;
		try {
			summary = identityOf(directory, await this.readProject(directory));
			readable = true;
		} catch (cause) {
			if (cause instanceof PathNotFoundError) return { act: 'forget' };
			if (
				cause instanceof ProjectFormatTooNewError ||
				cause instanceof ProjectFileUnreadableError
			) {
				// A manifest that is there and will not read is still a Project the hub lists and offers
				// Delete on (ADR-0010), so an interrupted deletion of one has to be finishable.
				summary = unreadableIdentity(directory);
				readable = false;
			} else throw cause;
		}
		// 3. Something is here, and whether this is the place the gesture was made is a question about
		//    the key, never about what is inside. See {@link WorkspaceIdentity}.
		if (this.#identity === 'a-name-anywhere') {
			return {
				act: 'refuse',
				// ⚠ **Two exits, and the first spelling offered only the destructive one** (round 4).
				// It said "delete it again from the list if it is the one you meant", which in the case
				// this sentence exists for — a colleague's folder of the same name, holding their own
				// `amsterdam-1625` — is an instruction to destroy their Project. And the note is kept, so
				// the same sentence returns at every startup for ever: nothing expires a record,
				// `#claim` fires only on create and duplicate, and Workspace settings can only discard
				// records for a Workspace that is *not* the one open. The panel that renders this offers
				// "Forget this note" beside it, which is the exit that costs nobody a file.
				detail:
					`Deleting “${was?.name || directory}” did not finish, so it is still in this ` +
					`Workspace folder. Ballastella will not remove it on its own: a Workspace folder is ` +
					`known only by its name, so another folder called the same thing — an external drive, ` +
					`a colleague's copy, a second checkout — looks exactly like this one from here. ` +
					`Nothing was removed. If this is your folder and you still mean to delete it, delete ` +
					`it again from the list; if it is not, forget this note.`
			};
		}
		// 4. And the gesture has to have written down what it was aimed at.
		if (was === null) {
			return {
				act: 'refuse',
				// ⚠ **Says what is true of every way this is reached, and the first spelling did not**
				// (round 4). `was` is `null` when the caller never supplied one *and* when the stored
				// value came from a build whose format this one does not read — and "this browser did
				// not keep a note" is plainly false of the second, where a newer build kept a perfectly
				// good note. The two have the same remedy, so they get one sentence that is true of
				// both rather than a second field to tell them apart.
				detail:
					`A recorded deletion of “${directory}” was not carried out, because Ballastella ` +
					`cannot tell which Project the note was about. Nothing was removed — delete it again ` +
					`if you still mean to, or forget this note.`
			};
		}
		// 5. Unchanged since the gesture. Not an identity check: step 3 already settled that this is
		//    the directory the user deleted in. This is "has the user reopened and edited it since",
		//    which is the one thing `#claim` cannot see.
		if (summary.name === was.name && summary.updatedAt === was.updatedAt) return { act: 'remove' };
		return {
			act: 'refuse',
			detail: readable
				? `A recorded deletion of “${was.name}” was not carried out: the Project in ` +
					`“${directory}” is now “${summary.name}”, last changed ` +
					`${summary.updatedAt || 'at an unrecorded time'}. It has been changed since it was ` +
					`deleted, so nothing was removed — delete it again if you still mean to.`
				: `A recorded deletion of “${was.name}” was not carried out: the project.json in ` +
					`“${directory}” cannot be read, and it could be read when it was deleted. Nothing was ` +
					`removed — delete it again if you still mean to.`
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
				...identityOf(directory, file),
				onFrontPage: file.onFrontPage,
				problem: null
			};
		} catch (cause) {
			if (cause instanceof ProjectFormatTooNewError) {
				return {
					directory,
					...unreadableIdentity(directory),
					onFrontPage: true,
					problem: 'format-too-new'
				};
			}
			if (cause instanceof ProjectFileUnreadableError || cause instanceof PathNotFoundError) {
				return {
					directory,
					...unreadableIdentity(directory),
					onFrontPage: true,
					problem: 'unreadable'
				};
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
