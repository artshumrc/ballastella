import { ALIGNMENT_DIRECTORY, alignmentImageId } from '../alignment/alignment.js';
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
	readOnFrontPage,
	serialiseProjectFile,
	type ProjectFile
} from './project-file.js';
import { PathNotFoundError, topLevelSegment, type ProjectStore } from '../store/project-store.js';

export const RESERVED_DIRECTORY_NAMES: readonly string[] = [
	IMAGE_DIRECTORY,
	ALIGNMENT_DIRECTORY,
	'base-map'
];

export class ReservedDirectoryNameError extends Error {
	override readonly name = 'ReservedDirectoryNameError';
	constructor(
		readonly directory: string,
		displayName: string
	) {
		super(
			`“${displayName}” would go in a folder called “${directory}”, and this Workspace keeps its ` +
				`shared Map Images, Alignments, and Base Map tiles in ` +
				`${RESERVED_DIRECTORY_NAMES.map((name) => `“${name}”`).join(', ')} — so “${directory}” is ` +
				`reserved and cannot be a Project. Choose another name. Nothing has been created.`
		);
	}
}

export const isReservedDirectoryName = (name: string): boolean =>
	RESERVED_DIRECTORY_NAMES.some((reserved) => foldName(reserved) === foldName(name));

export interface ProjectSummary {
	readonly directory: string;
	readonly name: string;
	readonly description: string;
	readonly updatedAt: string;
	readonly onFrontPage: boolean;
	readonly problem: 'format-too-new' | 'unreadable' | null;
}

export type WorkspaceIdentity = 'this-browser' | 'a-name-anywhere';

export interface FinishedDeletions {
	readonly finished: readonly string[];
	readonly refused: readonly { readonly directory: string; readonly detail: string }[];
	readonly unfinished: readonly string[];
}

type Verdict =
	| { readonly act: 'remove' }
	| { readonly act: 'forget' }
	| { readonly act: 'refuse'; readonly detail: string; readonly forget?: boolean };

const identityOf = (directory: string, file: ProjectFile): ProjectIdentity => ({
	name: file.name || directory,
	updatedAt: file.updatedAt
});

const unreadableIdentity = (directory: string): ProjectIdentity => ({
	name: directory,
	updatedAt: ''
});

export const deletionsAreNoteworthy = (report: FinishedDeletions): boolean =>
	report.finished.length > 0 || report.refused.length > 0 || report.unfinished.length > 0;

export class Workspace {
	readonly #store: ProjectStore;
	readonly #autosave: Autosave | undefined;
	readonly #now: () => Date;
	readonly #deleted: DeletedProjects | undefined;
	readonly #onDeletionNotRecorded: (directory: string) => void;
	readonly #observer: StoreContentObserver | undefined;
	readonly #identity: WorkspaceIdentity;

	constructor(
		store: ProjectStore,
		options: {
			readonly autosave?: Autosave;
			readonly identity?: WorkspaceIdentity;
			readonly now?: () => Date;
			readonly deleted?: DeletedProjects;
			readonly onDeletionNotRecorded?: (directory: string) => void;
			readonly observer?: StoreContentObserver;
		} = {}
	) {
		this.#store = store;
		this.#autosave = options.autosave;
		this.#now = options.now ?? (() => new Date());
		this.#deleted = options.deleted;
		this.#onDeletionNotRecorded = options.onDeletionNotRecorded ?? (() => undefined);
		this.#observer = options.observer;
		this.#identity = options.identity ?? 'a-name-anywhere';
	}

	get store(): ProjectStore {
		return this.#store;
	}

	async listProjects(): Promise<ProjectSummary[]> {
		const paths = await this.#store.list('');
		const directories = paths
			.filter((path) => path === projectFilePath(topLevelSegment(path)))
			.map(topLevelSegment);

		const summaries = await Promise.all(directories.map((directory) => this.#summarise(directory)));
		return summaries.sort(
			(a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.directory.localeCompare(b.directory)
		);
	}

	async readProject(directory: string): Promise<ProjectFile> {
		const path = projectFilePath(directory);
		const at = this.#observer?.mark() ?? 0;
		const bytes = await this.#store.read(path);
		this.#observer?.observe(path, bytes, at);
		return parseProjectFile(bytes);
	}

	async writeProject(
		directory: string,
		file: ProjectFile,
		options: { debounce?: boolean; stamp?: boolean } = {}
	): Promise<void> {
		const bytes = serialiseProjectFile(
			options.stamp === false ? file : { ...file, updatedAt: this.#now().toISOString() }
		);
		const path = projectFilePath(directory);
		if (!this.#autosave) await this.#store.write(path, bytes);
		else if (options.debounce) this.#autosave.queue(path, bytes);
		else await this.#autosave.commit(path, bytes);
	}

	async createProject(displayName: string, description = ''): Promise<ProjectSummary> {
		const name = displayName.trim() || 'Untitled Project';
		const preferred = toDirectoryName(name);
		if (isReservedDirectoryName(preferred)) {
			throw new ReservedDirectoryNameError(preferred, name);
		}
		const directory = await this.#unusedDirectory(name);
		this.#deleted?.forget(directory);
		await this.writeProject(directory, newProjectFile(name, this.#now(), description.trim()));
		return this.#summarise(directory);
	}

	async updateProjectDetails(
		directory: string,
		details: { name?: string; description?: string },
		options: { debounce?: boolean } = {}
	): Promise<ProjectSummary> {
		const file = await this.readProject(directory);
		await this.writeProject(
			directory,
			{
				...file,
				name: details.name ?? file.name,
				description: (details.description ?? file.description).trim()
			},
			options
		);
		return this.#summarise(directory);
	}

	async setProjectOnFrontPage(directory: string, onFrontPage: boolean): Promise<ProjectSummary> {
		const file = await this.readProject(directory);
		await this.writeProject(directory, { ...file, onFrontPage }, { stamp: false });
		return this.#summarise(directory);
	}

	async duplicateProject(directory: string): Promise<ProjectSummary> {
		const file = await this.readProject(directory);
		const name = `${file.name} (copy)`;
		const copy = await this.#unusedDirectory(name);
		this.#deleted?.forget(copy);

		for (const path of await this.#store.list(`${directory}/`)) {
			const destination = `${copy}/${path.slice(directory.length + 1)}`;
			await this.#store.write(destination, await this.#store.read(path));
		}
		await this.writeProject(copy, { ...file, name, onFrontPage: false });
		return this.#summarise(copy);
	}

	async deleteProject(directory: string, was: ProjectIdentity | null = null): Promise<void> {
		// Recorded before the first `await`, so the note survives page unload.
		if (this.#deleted && !this.#deleted.record(directory, was)) {
			this.#onDeletionNotRecorded(directory);
		}
		const quiet = (await this.#autosave?.abandon(`${directory}/`)) ?? true;
		await this.#removeEverythingIn(directory);
		if (quiet) this.#deleted?.forget(directory);
	}

	async finishInterruptedDeletions(): Promise<FinishedDeletions> {
		const finished: string[] = [];
		const refused: { directory: string; detail: string }[] = [];
		const unfinished: string[] = [];
		for (const record of this.#deleted?.pending() ?? []) {
			const { directory } = record;
			try {
				const verdict = await this.#verdictOn(record);
				if (verdict.act === 'refuse') {
					refused.push({ directory, detail: verdict.detail });
					if (verdict.forget) this.#deleted?.forget(directory);
					continue;
				}
				if (verdict.act === 'forget') {
					await this.#store.reclaimAbandonedWrites(`${directory}/`);
					this.#deleted?.forget(directory);
					continue;
				}
				const removed = await this.#removeEverythingIn(directory);
				this.#deleted?.forget(directory);
				if (removed > 0) finished.push(directory);
			} catch {
				unfinished.push(directory);
			}
		}
		return { finished, refused, unfinished };
	}

	async #verdictOn(record: DeletionRecord): Promise<Verdict> {
		const { directory, was } = record;
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
				summary = unreadableIdentity(directory);
				readable = false;
			} else throw cause;
		}
		if (this.#identity === 'a-name-anywhere') {
			return {
				act: 'refuse',
				detail:
					`Deleting “${was?.name || directory}” did not finish, so it is still in this ` +
					`Workspace folder. Ballastella will not remove it on its own: a Workspace folder is ` +
					`known only by its name, so another folder called the same thing — an external drive, ` +
					`a colleague's copy, a second checkout — looks exactly like this one from here. ` +
					`Nothing was removed. If this is your folder and you still mean to delete it, delete ` +
					`it again from the list; if it is not, forget this note.`
			};
		}
		if (was === null) {
			return {
				act: 'refuse',
				detail:
					`A recorded deletion of “${directory}” was not carried out, because Ballastella ` +
					`cannot tell which Project the note was about. Nothing was removed — delete it again ` +
					`if you still mean to, or forget this note.`
			};
		}
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

	async #removeEverythingIn(directory: string): Promise<number> {
		const manifest = projectFilePath(directory);
		const paths = await this.#store.list(`${directory}/`);
		const manifestLast = paths.filter((path) => path !== manifest);
		if (manifestLast.length < paths.length) manifestLast.push(manifest);
		for (const path of manifestLast) await this.#store.delete(path);
		await this.#store.reclaimAbandonedWrites(`${directory}/`);
		return paths.length;
	}

	async #summarise(directory: string): Promise<ProjectSummary> {
		try {
			const file = await this.readProject(directory);
			return {
				directory,
				...identityOf(directory, file),
				description: file.description,
				onFrontPage: file.onFrontPage,
				problem: null
			};
		} catch (cause) {
			const problem =
				cause instanceof ProjectFormatTooNewError
					? 'format-too-new'
					: cause instanceof ProjectFileUnreadableError || cause instanceof PathNotFoundError
						? 'unreadable'
						: null;
			if (problem === null) throw cause;
			return {
				directory,
				...unreadableIdentity(directory),
				description: '',
				onFrontPage: readOnFrontPage(
					await this.#store.read(projectFilePath(directory)).catch(() => new Uint8Array())
				),
				problem
			};
		}
	}

	async #unusedDirectory(displayName: string): Promise<string> {
		return unusedDirectoryName(displayName, takenDirectoryNames(await this.#store.list('')));
	}
}

export function takenDirectoryNames(paths: Iterable<string>): Set<string> {
	const taken = new Set(RESERVED_DIRECTORY_NAMES.map(foldName));
	for (const path of paths) taken.add(foldName(topLevelSegment(path)));
	return taken;
}

export function unusedDirectoryName(displayName: string, taken: ReadonlySet<string>): string {
	const base = toDirectoryName(displayName);
	if (!taken.has(foldName(base))) return base;
	for (let suffix = 2; ; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(foldName(candidate))) return candidate;
	}
}

export function hoistedImageId(archivePath: string): string | null {
	const [top, id, ...rest] = archivePath.split('/');
	if (top === IMAGE_DIRECTORY) return rest.length > 0 && id ? id : null;
	return alignmentImageId(archivePath);
}

export const foldName = (name: string): string => name.normalize('NFC').toLowerCase();

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
