import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import type { Autosave } from '../autosave/autosave.js';
import type { DeletedProjects } from '../autosave/deleted-projects.js';
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
}

/** What a startup found still to do, and what it could not do. */
export interface FinishedDeletions {
	/** Deletions that had not finished and now have. */
	readonly finished: readonly string[];
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

	constructor(store: ProjectStore, options: WorkspaceOptions = {}) {
		this.#store = store;
		this.#autosave = options.autosave;
		this.#now = options.now ?? (() => new Date());
		this.#deleted = options.deleted;
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

	/** Remove a Project and everything in it. */
	async deleteProject(directory: string): Promise<void> {
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
		this.#deleted?.record(directory);
		await this.#removeEverythingIn(directory);
		// Only now, and only because the removal above actually resolved. Forgetting before it would
		// be the same false claim `replayJournal` refuses to make: nothing is reported done that was
		// not done.
		this.#deleted?.forget(directory);
	}

	/**
	 * Carry out the deletions the user asked for and the page did not live long enough to finish.
	 *
	 * **Run at startup, before anything reads the Workspace**, which is what makes the ordering below
	 * safe: every {@link createProject} and {@link duplicateProject} in a session happens after this
	 * has cleared the record for the directory it claims, so a Project made under a deleted one's
	 * folder name can never be swept away by a gesture aimed at its predecessor.
	 *
	 * Idempotent, and deliberately so: a Project that is already gone deletes to nothing, which is
	 * exactly the ordinary case here — the removal usually *had* finished and only the note saying so
	 * was lost.
	 */
	async finishInterruptedDeletions(): Promise<FinishedDeletions> {
		const finished: string[] = [];
		const unfinished: string[] = [];
		for (const directory of this.#deleted?.pending() ?? []) {
			try {
				await this.#removeEverythingIn(directory);
				this.#deleted?.forget(directory);
				finished.push(directory);
			} catch {
				// Kept, and the loop goes on. One unreachable Project must not leave the others
				// half-deleted, and a Workspace that cannot answer today may answer tomorrow.
				unfinished.push(directory);
			}
		}
		return { finished, unfinished };
	}

	async #removeEverythingIn(directory: string): Promise<void> {
		for (const path of await this.#store.list(`${directory}/`)) {
			await this.#store.delete(path);
		}
		// Everything in it includes the half-finished writes `list` cannot report and `delete`
		// cannot be handed. Without this a "deleted" Project's directory survives on disk
		// permanently, holding bytes that are also missing from the totals tickets 15 and 16 warn
		// from — and in ticket 12's real folder, a stray dotfile the user commits to git.
		await this.#store.reclaimAbandonedWrites(`${directory}/`);
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
	 * `#unusedDirectory` has just answered that no Project occupies this name, and
	 * {@link finishInterruptedDeletions} has already run at startup.
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
