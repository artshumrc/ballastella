import {
	assertStorePath,
	isTempPath,
	TEMP_PATH_SUFFIX,
	type Bytes,
	type ProjectStore,
	type StorePath
} from './project-store.js';

/**
 * The half of a {@link ProjectStore} that is the same whichever backend is underneath:
 * path validation, and ADR-0017 rule 4's atomic write as *temp file, then rename*.
 *
 * Atomicity lives here rather than in each adapter on purpose. It is the rule most likely
 * to be quietly skipped — an adapter that just opens the destination and writes looks
 * correct and passes every test that does not interrupt it — so there is one implementation,
 * exercised by the shared adapter suite, that every backend inherits. Ticket 12's File
 * System Access adapter gets it by extending this class, not by reimplementing it.
 *
 * Subclasses implement the primitive operations and never override `write`.
 */
export abstract class TempFileWriteStore implements ProjectStore {
	async read(path: string): Promise<Bytes> {
		return this.readBytes(assertStorePath(path));
	}

	async write(path: string, bytes: Bytes): Promise<void> {
		const destination = assertStorePath(path);
		const temp = tempPathFor(destination);
		try {
			await this.writeBytes(temp, bytes);
			await this.renameTempFile(temp, destination);
		} catch (cause) {
			// The destination still holds whatever it held before; drop the orphan so a failed
			// write leaves the store exactly as it was.
			//
			// Both steps are inside the guard. `writeBytes` used to sit outside it, and a quota
			// failure part way through it still leaves the temporary file created — one that nothing
			// can then reach, because the suffix is reserved: `list` hides it, `delete` refuses it,
			// and deleting the Project walks `list`. The result was a "deleted" Project whose
			// directory survived on disk permanently.
			await this.deletePath(temp).catch(() => undefined);
			throw cause;
		}
	}

	async list(prefix: string): Promise<StorePath[]> {
		const paths = await this.listPaths(prefix);
		return paths.filter((path) => !isTempPath(path) && path.startsWith(prefix)).sort();
	}

	async delete(path: string): Promise<void> {
		await this.deletePath(assertStorePath(path));
	}

	async size(path: string): Promise<number> {
		// Never `read`. See ProjectStore#size.
		return this.byteLength(assertStorePath(path));
	}

	/**
	 * Delete every abandoned temporary file under `prefix`.
	 *
	 * **Unconditional, so it must not be called while anything is writing.** There is no age check and
	 * there is nowhere to get one: `ProjectStore` reports a byte length and nothing else, deliberately
	 * (ADR-0001), so telling a dead tab's litter from a temporary file created a millisecond ago by
	 * `write` would mean putting a modification time into the interface and into every adapter. Until
	 * something needs that for its own sake, the cheaper guarantee is the caller's — sweep where nothing
	 * else is writing.
	 *
	 * Which is the whole of the precondition, and it has been broken once: `workspaceSize` called this
	 * before totalling, so a user clicking "Make an offline copy" swept the entire Workspace, and a sweep
	 * landing between another write's `writeBytes` and its `renameTempFile` deleted that write's file and
	 * failed the save. The two safe call sites are Workspace adoption, where the walk is one the listing
	 * does anyway and no edit is in flight, and deleting a Project outright.
	 */
	async reclaimAbandonedWrites(prefix: string): Promise<void> {
		// One implementation for every backend, like `write` itself: the litter is created here, so
		// reclaiming it belongs here too rather than being each adapter's problem to remember.
		for (const path of await this.listPaths(prefix)) {
			if (isTempPath(path) && path.startsWith(prefix)) await this.deletePath(path);
		}
	}

	/** Rejects with {@link PathNotFoundError} when the path holds nothing. */
	protected abstract readBytes(path: StorePath): Promise<Bytes>;

	/** A complete write to a path that no caller can name, creating missing parents. */
	protected abstract writeBytes(path: StorePath, bytes: Bytes): Promise<void>;

	/**
	 * Move a completed temporary file over `to`, replacing whatever is there. The step that
	 * has to be atomic; the shared adapter suite interrupts exactly here.
	 */
	protected abstract renameTempFile(from: StorePath, to: StorePath): Promise<void>;

	/** Every existing path beginning with `prefix`; ordering and temp-filtering are handled above. */
	protected abstract listPaths(prefix: string): Promise<StorePath[]>;

	/** Idempotent removal. Also called with temporary paths. */
	protected abstract deletePath(path: StorePath): Promise<void>;

	/** Byte length from metadata. Rejects with {@link PathNotFoundError} when absent. */
	protected abstract byteLength(path: StorePath): Promise<number>;
}

/** `a/project.json` → `a/.project.json.<uuid>.ballastella-tmp`, alongside its destination. */
export function tempPathFor(path: StorePath): StorePath {
	const cut = path.lastIndexOf('/');
	const directory = cut === -1 ? '' : path.slice(0, cut + 1);
	const name = cut === -1 ? path : path.slice(cut + 1);
	return `${directory}.${name}.${crypto.randomUUID()}${TEMP_PATH_SUFFIX}`;
}
