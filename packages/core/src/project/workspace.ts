import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import type { Autosave } from '../autosave/autosave.js';
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
import {
	InvalidPathError,
	PathNotFoundError,
	TEMP_PATH_SUFFIX,
	isTempPath,
	topLevelSegment,
	type ProjectStore
} from '../store/project-store.js';
import type { ProjectFileSource, TransferProgressListener } from '../transfer/transfer.js';

/**
 * An import would land on a directory name that is already taken (ADR-0008: the directory name
 * *is* the Project's identity).
 *
 * Thrown before anything is written, and carrying a free name, because the user must be offered a
 * choice rather than told what happened: they may be importing a colleague's version of work they
 * also have, and silently overwriting it is the one failure a zip-based workflow makes easy.
 */
export class ProjectDirectoryCollisionError extends Error {
	readonly directory: string;
	/** A name that is free right now, for the rename affordance. */
	readonly suggestion: string;

	constructor(directory: string, suggestion: string) {
		super(
			`This Workspace already has a folder called “${directory}”. ` +
				`Import under a different name — “${suggestion}” is free — or cancel. ` +
				`Nothing has been changed.`
		);
		this.name = 'ProjectDirectoryCollisionError';
		this.directory = directory;
		this.suggestion = suggestion;
	}
}

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
export const RESERVED_DIRECTORY_NAMES: readonly string[] = ['images', 'alignments', 'base-map'];

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

	constructor(store: ProjectStore, options: WorkspaceOptions = {}) {
		this.#store = store;
		this.#autosave = options.autosave;
		this.#now = options.now ?? (() => new Date());
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

		for (const path of await this.#store.list(`${directory}/`)) {
			const destination = `${copy}/${path.slice(directory.length + 1)}`;
			await this.#store.write(destination, await this.#store.read(path));
		}
		await this.writeProject(copy, { ...file, name });
		return this.#summarise(copy);
	}

	/**
	 * Write a Project that came from somewhere else into `directory`, which must be free.
	 *
	 * Zip-agnostic on purpose: `source` is any {@link ProjectFileSource}, so this is also the path
	 * ticket 14's remote ingest and ticket 15's mirroring will take. What it knows about is the two
	 * things only the Workspace can decide.
	 *
	 * **The collision.** `directory` is the Project's identity (ADR-0008), and if it is taken this
	 * throws {@link ProjectDirectoryCollisionError} *before writing anything*. Display names are not
	 * checked at all: two Projects may share one, so a colleague's "Amsterdam 1625" must import
	 * alongside yours rather than be refused because of it. "Taken" is decided on the folded name
	 * (see {@link foldName}) rather than by exact string, because on the two most common filesystems
	 * `Amsterdam-1625` *is* `amsterdam-1625` and an exact comparison there overwrites the Project it
	 * was asked to protect.
	 *
	 * **The bytes are written exactly as they arrive, `project.json` included.** Unlike every other
	 * method here it does not stamp `updatedAt`, because importing is not editing: the Project was
	 * last changed when its author last changed it, and that is the one record of it that survives a
	 * zip round trip, which destroys filesystem modification times outright. Still the same single
	 * writer — every byte goes through this Workspace and the store's atomic `write` (ADR-0017 rule
	 * 4) — so an interrupted import cannot leave a torn file.
	 *
	 * **The shared material is hoisted out of the Project directory** (ADR-0023). An archive is rooted at
	 * the Project and carries `images/<id>/` and `alignments/<id>.json` beside `project.json`, exactly as
	 * it always did — the zip format did not change — but those two now belong to the Workspace, so they
	 * are written at the Workspace root and everything else goes inside `directory`. See
	 * {@link hoistedImageId}.
	 *
	 * **And an image id the Workspace already has is not overwritten.** That is the whole of the
	 * deduplication ADR-0023 asks for, and the direction is the one that cannot lose work: the Alignment
	 * in the Workspace is the one every existing Project is already drawn by, and a colleague's archive
	 * of the same map would otherwise silently move every one of them. The Project still imports, still
	 * references the image, and draws it where the user already had it.
	 *
	 * @throws ProjectDirectoryCollisionError when `directory` is already in use
	 * @throws ReservedDirectoryNameError when `directory` is a name the Workspace itself needs
	 */
	async importProject(
		directory: string,
		source: ProjectFileSource,
		options: { onProgress?: TransferProgressListener } = {}
	): Promise<ProjectSummary> {
		assertDirectoryName(directory);
		// Before the collision check, so the message names the reservation rather than reporting a folder
		// the user cannot see. Import is the sharper case than creation: it writes into the Workspace root
		// itself, so a Project landing on `images/` would write `project.json` into the shared pool.
		if (isReservedDirectoryName(directory)) {
			throw new ReservedDirectoryNameError(directory, directory);
		}
		if (await this.#isTaken(directory)) {
			throw new ProjectDirectoryCollisionError(directory, await this.#unusedDirectory(directory));
		}

		const present = await this.#historicalMapIds();

		let files = 0;
		let bytes = 0;
		const report = (path: string | null) =>
			options.onProgress?.({
				files,
				totalFiles: source.paths.length,
				bytes,
				totalBytes: source.totalBytes,
				path
			});

		report(null);
		const written: string[] = [];
		/** The prefixes written into, for the abandoned-write sweep a rollback has to do. */
		const touched = new Set<string>([`${directory}/`]);
		try {
			for await (const file of source.files()) {
				const shared = hoistedImageId(file.path);
				// Counted as seen even when skipped, so progress reaches its total rather than stopping
				// short of it on an import that deduplicated half the archive.
				files += 1;
				if (shared !== null && present.has(shared)) {
					report(file.path);
					continue;
				}
				const path = shared === null ? `${directory}/${file.path}` : file.path;
				if (shared !== null) touched.add(`${file.path.split('/').slice(0, -1).join('/')}/`);
				// Recorded before the write rather than after, so a write that fails part way through
				// is still cleaned up: the destination may hold a partial file, and the temporary file
				// the atomic write created may still be beside it.
				written.push(path);
				await this.#store.write(path, file.bytes);
				bytes += file.bytes.length;
				// A source that under-declares `totalBytes` would make the progress it reports a lie, and
				// on an untrusted source — a zip somebody was handed — it is also the bound on how much
				// of the user's disk this loop may fill. So the declared total is a contract, checked.
				if (bytes > source.totalBytes) {
					throw new Error(
						`This Project holds more than the ${source.totalBytes} bytes it said it would, ` +
							`so it has not been imported.`
					);
				}
				report(file.path);
			}
		} catch (cause) {
			await this.#rollBackImport(written, touched);
			throw cause;
		}
		report(null);
		return this.#summarise(directory);
	}

	/**
	 * Every Historical Map the Workspace already has, by image id (ADR-0023).
	 *
	 * A map counts as present when *anything* is under `images/<id>/` or when its Alignment is there —
	 * not only when the pyramid is complete. The question this answers is "would importing overwrite
	 * something", and a half-written pyramid the user is still ingesting is something.
	 */
	async #historicalMapIds(): Promise<Set<string>> {
		const ids = new Set<string>();
		for (const path of await this.#store.list(`${IMAGE_DIRECTORY}/`)) {
			const id = path.slice(IMAGE_DIRECTORY.length + 1).split('/')[0];
			if (id !== undefined && id !== '') ids.add(id);
		}
		for (const path of await this.#store.list(`${ALIGNMENT_DIRECTORY}/`)) {
			const name = path.slice(ALIGNMENT_DIRECTORY.length + 1);
			if (name.endsWith('.json') && !name.includes('/')) ids.add(name.slice(0, -'.json'.length));
		}
		return ids;
	}

	/**
	 * Undo a partly written import.
	 *
	 * Without it the leftovers are worse than useless. `project.json` is written last, so the hub
	 * cannot list the directory and the user cannot see or delete what is there; and the name is
	 * taken forever, because the collision check counts every top-level name — so retrying the same
	 * file is told the folder already exists while the hub shows no such Project. A partially written
	 * import is worse than a rejected one (ticket 13), and this is what makes the rejected one
	 * reachable after the writing has begun — which CRC-32 verification makes necessary, since a
	 * damaged entry cannot be found until it has been inflated.
	 *
	 * Best-effort, and it never throws: the failure the caller is about to see is the one that
	 * matters, and a Workspace too broken to clean up is not one where a second error helps.
	 */
	async #rollBackImport(written: readonly string[], touched: ReadonlySet<string>): Promise<void> {
		for (const path of written) {
			await this.#store.delete(path).catch(() => undefined);
		}
		// The half-finished writes `list` cannot report and `delete` cannot be handed, which is
		// exactly what a write interrupted between its two steps leaves behind.
		//
		// Every prefix this import wrote into rather than only the Project's, because ADR-0023's hoist
		// puts some of them under `images/<id>/` and `alignments/`. Only prefixes it actually wrote to:
		// sweeping `images/` wholesale would reclaim the temporary file of an ingest running beside this.
		for (const prefix of touched) {
			await this.#store.reclaimAbandonedWrites(prefix).catch(() => undefined);
		}
	}

	/** A free directory name near `preferred`, for offering a way past a collision. */
	async suggestDirectory(preferred: string): Promise<string> {
		return this.#unusedDirectory(preferred);
	}

	/** Remove a Project and everything in it. */
	async deleteProject(directory: string): Promise<void> {
		for (const path of await this.#store.list(`${directory}/`)) {
			await this.#store.delete(path);
		}
		// Everything in it includes the half-finished writes `list` cannot report and `delete`
		// cannot be handed. Without this a "deleted" Project's directory survives on disk
		// permanently, holding bytes that are also missing from the totals tickets 15 and 16 warn
		// from — and in ticket 12's real folder, a stray dotfile the user commits to git.
		await this.#store.reclaimAbandonedWrites(`${directory}/`);
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
			// because it is what `suggestDirectory` returns to the rename field and what `duplicateProject`
			// lands on. An empty Workspace holds none of these directories yet, so listing alone would say
			// they were free.
			...RESERVED_DIRECTORY_NAMES.map(foldName),
			...paths.map((path) => foldName(topLevelSegment(path)))
		]);
	}

	async #isTaken(directory: string): Promise<boolean> {
		return (await this.#takenNames()).has(foldName(directory));
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
 * Refuse a directory name that is not one plain folder name.
 *
 * Checked against the name itself rather than left to `assertStorePath`, which sees each path only as
 * it is written: `..` and `\` failed on the *first entry inside* the Project, so the complaint named
 * a file the user has never heard of and arrived after that file had landed.
 */
function assertDirectoryName(directory: string): void {
	const reason =
		directory === ''
			? 'must be a single directory name'
			: directory.includes('/')
				? 'must be a single directory name, with no "/"'
				: directory.includes('\\')
					? 'must be a single directory name, with no "\\"'
					: directory === '.' || directory === '..'
						? 'must be a directory name rather than "." or ".."'
						: isTempPath(directory)
							? `must not end with the reserved ${TEMP_PATH_SUFFIX}`
							: '';
	if (reason) throw new InvalidPathError(directory, reason);
}

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
