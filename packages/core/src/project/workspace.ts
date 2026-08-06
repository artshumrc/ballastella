import type { Autosave } from '../autosave/autosave.js';
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

	/** Create a Project. Its directory name is derived from the display name and made unique. */
	async createProject(displayName: string): Promise<ProjectSummary> {
		const name = displayName.trim() || 'Untitled Project';
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
	 * alongside yours rather than be refused because of it.
	 *
	 * **The bytes are written exactly as they arrive, `project.json` included.** Unlike every other
	 * method here it does not stamp `updatedAt`, because importing is not editing: the Project was
	 * last changed when its author last changed it, and that is the one record of it that survives a
	 * zip round trip, which destroys filesystem modification times outright. Still the same single
	 * writer — every byte goes through this Workspace and the store's atomic `write` (ADR-0017 rule
	 * 4) — so an interrupted import cannot leave a torn file.
	 *
	 * @throws ProjectDirectoryCollisionError when `directory` is already in use
	 */
	async importProject(
		directory: string,
		source: ProjectFileSource,
		options: { onProgress?: TransferProgressListener } = {}
	): Promise<ProjectSummary> {
		if (directory.includes('/') || directory === '') {
			throw new InvalidPathError(directory, 'must be a single directory name');
		}
		const taken = new Set((await this.#store.list('')).map(topLevelSegment));
		if (taken.has(directory)) {
			throw new ProjectDirectoryCollisionError(directory, await this.#unusedDirectory(directory));
		}

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
		try {
			for await (const file of source.files()) {
				const path = `${directory}/${file.path}`;
				// Recorded before the write rather than after, so a write that fails part way through
				// is still cleaned up: the destination may hold a partial file, and the temporary file
				// the atomic write created may still be beside it.
				written.push(path);
				await this.#store.write(path, file.bytes);
				files += 1;
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
			await this.#rollBackImport(directory, written);
			throw cause;
		}
		report(null);
		return this.#summarise(directory);
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
	async #rollBackImport(directory: string, written: readonly string[]): Promise<void> {
		for (const path of written) {
			await this.#store.delete(path).catch(() => undefined);
		}
		// The half-finished writes `list` cannot report and `delete` cannot be handed, which is
		// exactly what a write interrupted between its two steps leaves behind.
		await this.#store.reclaimAbandonedWrites(`${directory}/`).catch(() => undefined);
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

	async #unusedDirectory(displayName: string): Promise<string> {
		// Every existing top-level name, not only the ones holding a Project: a new Project must
		// not land inside a directory that is already there for some other reason.
		const taken = new Set((await this.#store.list('')).map(topLevelSegment));
		const base = toDirectoryName(displayName);
		if (!taken.has(base)) return base;
		for (let suffix = 2; ; suffix += 1) {
			const candidate = `${base}-${suffix}`;
			if (!taken.has(candidate)) return candidate;
		}
	}
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
