import type {
	LocalChangeIndex,
	LocalChangeKind,
	LocalChangeSource,
	LocalChanges
} from '../remote/local-change-index.js';
import { classifyPath, projectDirectories } from '../remote/synchronization-paths.js';
import type { Bytes, ProjectStore, StorePath, WritablePath } from './project-store.js';

export class ManagedProjectStore implements ProjectStore, LocalChangeSource {
	readonly #store: ProjectStore;
	readonly #index: LocalChangeIndex;
	#marking: Promise<void> = Promise.resolve();
	#projects: Set<string> | null = null;

	constructor(store: ProjectStore, index: LocalChangeIndex) {
		this.#store = store;
		this.#index = index;
	}

	get changes(): LocalChangeIndex {
		return this.#index;
	}

	async read(path: StorePath): Promise<Bytes> {
		return this.#store.read(path);
	}

	async write(path: WritablePath, bytes: Bytes): Promise<void> {
		await this.#store.write(path, bytes);
		this.#mark(path, 'written');
	}

	async list(prefix: string): Promise<StorePath[]> {
		return this.#store.list(prefix);
	}

	async delete(path: StorePath): Promise<void> {
		await this.#store.delete(path);
		this.#mark(path, 'deleted');
	}

	async size(path: StorePath): Promise<number> {
		return this.#store.size(path);
	}

	async modifiedAt(path: StorePath): Promise<number | null> {
		return (await this.#store.modifiedAt?.(path)) ?? null;
	}

	async reclaimAbandonedWrites(prefix: string): Promise<void> {
		await this.#store.reclaimAbandonedWrites(prefix);
	}

	async localChanges(): Promise<LocalChanges> {
		await this.#marking;
		return this.#index.localChanges();
	}

	async flushChanges(): Promise<boolean> {
		await this.#marking;
		return this.#index.flush();
	}

	#mark(path: string, kind: LocalChangeKind): void {
		this.#marking = this.#marking
			.then(async () => {
				const projects = await this.#recognisedProjects(path);
				if (classifyPath(path, projects) !== 'source') return;
				await this.#index.mark(path, kind);
			})
			.catch(() => {});
	}

	// `path`'s own directory is always added: a new Project is recognised by the write creating it.
	async #recognisedProjects(path: string): Promise<ReadonlySet<string>> {
		const own = projectDirectories([path]);
		if (this.#projects === null) {
			const remembered = await this.#index.projectDirectories();
			if (remembered !== null) this.#projects = new Set(remembered);
			else {
				try {
					this.#projects = projectDirectories(await this.#store.list(''));
				} catch {
					return own;
				}
			}
		}
		for (const directory of own) this.#projects.add(directory);
		await this.#index.rememberProjectDirectories(this.#projects);
		return this.#projects;
	}
}

export function manageProjectStore(
	store: ProjectStore,
	index: LocalChangeIndex
): ManagedProjectStore {
	return store instanceof ManagedProjectStore ? store : new ManagedProjectStore(store, index);
}
