// The one place a Workspace's own writes and deletions are written down (ADR-0038).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A WRAPPER, NOT A HOOK IN EVERY AUTHORING METHOD
//
// The local-change index has to be durable and it has to sit at one seam, and there are dozens of
// places that author bytes: autosave, the tiler, the Annotation editor, offline
// copies, Base Map tile caching, Alignment commits, tar restore, Project Import. Marking the index
// from each of them is a rule every future feature has to remember, and the one that forgets it does
// not fail a test — it silently reports a changed Workspace as `In sync`.
//
// So nothing authoring changes at all. `ProjectStore` is already the narrow interface every byte
// crosses (ADR-0001), so composition over it catches every writer that exists and every writer that
// will be written. This is installed around the store *before* an `EditorSession` is given it, so the
// session, its `Autosave`, its `Workspace` and the tiler all hold the managed store and none of them
// knows it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONLY WHAT SUCCEEDED, AND ONLY SCHOLARSHIP
//
// A mark is made *after* the underlying operation resolves, so a rejected write, a quota failure or
// an abandoned temporary file marks nothing. Reads, listings, size queries and
// `reclaimAbandonedWrites` mark nothing because they change nothing.
//
// And a marked path is a **source** path by `synchronization-paths.ts`'s classifier: the `_app/`
// bundle and the site record a Sync writes are generated output, and a `README.md` is somebody
// else's file. None of them is an author's drifting scholarship, and reporting them as such would
// make a Workspace read `Changes to send` the moment it sent them.

import { LocalChangeIndex } from '../remote/local-change-index.js';
import { classifyPath, projectDirectories } from '../remote/synchronization-paths.js';
import type {
	LocalChangeKind,
	LocalChangeSource,
	LocalChanges
} from '../remote/local-change-index.js';
import type { Bytes, ProjectStore, StorePath, WritablePath } from './project-store.js';

/**
 * A {@link ProjectStore} that records every successful write and deletion of scholarship it performs.
 *
 * Delegates everything and changes no byte of behaviour: the store underneath keeps its whole
 * contract, including {@link ProjectStore.write}'s atomicity, so the shared adapter suite still
 * describes what a caller gets.
 */
export class ManagedProjectStore implements ProjectStore, LocalChangeSource {
	readonly #store: ProjectStore;
	readonly #index: LocalChangeIndex;
	/**
	 * Marking, serialised and off the caller's path.
	 *
	 * ⚠ **A write does not wait for its own mark**, and it must not: tiling writes tens of thousands
	 * of files, and a durable record between each pair of them would make the job unusable. The chain
	 * is what keeps the marks in the order the operations happened, and {@link localChanges} joins it
	 * so a reader never sees a Workspace mid-mark.
	 */
	#marking: Promise<void> = Promise.resolve();
	/**
	 * The Project directories classification needs, or `null` until they have been established.
	 *
	 * See {@link #recognisedProjects}: read from the index where it has them, and otherwise from one
	 * directory walk that then never has to happen again.
	 */
	#projects: Set<string> | null = null;

	constructor(store: ProjectStore, index: LocalChangeIndex) {
		this.#store = store;
		this.#index = index;
	}

	/** The index this store marks, for a Baseline advance that has to clear part of it. */
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
		// Idempotent by contract, so this also marks a path that held nothing. A deletion of a path the
		// Baseline records is exactly the change worth reporting, and one of a path it does not is a
		// mark the comparison finds nothing to say about.
		this.#mark(path, 'deleted');
	}

	async size(path: StorePath): Promise<number> {
		return this.#store.size(path);
	}

	async modifiedAt(path: StorePath): Promise<number | null> {
		return (await this.#store.modifiedAt?.(path)) ?? null;
	}

	async reclaimAbandonedWrites(prefix: string): Promise<void> {
		// Nothing to mark: every path this removes is a temporary file no caller can name, and the
		// reserved suffix keeps `list` and the classifier from ever having seen it as Workspace content.
		await this.#store.reclaimAbandonedWrites(prefix);
	}

	/** What Ballastella has changed since the Baseline. Reads no byte of the Workspace. */
	async localChanges(): Promise<LocalChanges> {
		await this.#marking;
		return this.#index.localChanges();
	}

	/** Make every mark so far durable. For a caller that wants the guarantee at a chosen moment. */
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
			.catch(() => {
				// A store that will not keep the mark has already told the index's own caller. Failing the
				// author's write over it would be refusing to save their work to protect a status line.
			});
	}

	/**
	 * The Project directories `classifyPath` needs, established at most once per Workspace.
	 *
	 * The index remembers them, because the alternative is a `list('')` over a multi-gigabyte
	 * Workspace on the first write of every session. Where it has never recorded them — a Workspace
	 * that predates this feature — one walk seeds it and the record carries them from then on.
	 *
	 * ⚠ **`path`'s own directory is added whatever the walk said**, and that is not belt and braces: a
	 * brand new Project is recognised *by* its `project.json`, and the write creating it would
	 * otherwise be classified against a Workspace that does not have it yet — as would the deletion
	 * that has just removed it.
	 */
	async #recognisedProjects(path: string): Promise<ReadonlySet<string>> {
		const own = projectDirectories([path]);
		if (this.#projects === null) {
			const remembered = await this.#index.projectDirectories();
			if (remembered !== null) this.#projects = new Set(remembered);
			else {
				try {
					this.#projects = projectDirectories(await this.#store.list(''));
				} catch {
					// An unreachable Workspace cannot be inventoried, and this is not the operation to fail
					// over it. Left unestablished, so the next tracked change tries again.
					return own;
				}
			}
		}
		for (const directory of own) this.#projects.add(directory);
		await this.#index.rememberProjectDirectories(this.#projects);
		return this.#projects;
	}
}

/**
 * Install change tracking around `store`, or hand back the one that already has it.
 *
 * ⚠ **Idempotent, because the Workspace a session is given is adopted more than once.** Switching
 * Workspaces builds a session from a store, and so does reopening a remembered folder; a second
 * wrapper around an already-managed store would mark every change twice — harmless to the index,
 * which is a set — but it would also stack a second directory walk and a second flush schedule on
 * every write for the rest of the session.
 */
export function manageProjectStore(
	store: ProjectStore,
	index: LocalChangeIndex
): ManagedProjectStore {
	return store instanceof ManagedProjectStore ? store : new ManagedProjectStore(store, index);
}
