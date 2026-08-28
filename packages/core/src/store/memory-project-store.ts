import { PathNotFoundError, type Bytes, type StorePath } from './project-store.js';
import { TempFileWriteStore } from './temp-file-write-store.js';

/**
 * A {@link ProjectStore} in a `Map`. The primary test seam CONTRIBUTING.md names, because in
 * this project "after this sequence of actions the store holds these files with these contents"
 * is not a proxy for the behaviour, it *is* the behaviour: the user's folder is the product.
 *
 * Not a test double for the real thing so much as a fourth backend that happens to be
 * volatile: it goes through the same {@link TempFileWriteStore} write path as OPFS and
 * passes the same shared suite, so a bug that only the real backends have is a bug in the
 * real backends rather than a gap in what the suite can see.
 */
export class MemoryProjectStore extends TempFileWriteStore {
	readonly #files = new Map<StorePath, Bytes>();
	#unreachable: Error | undefined;
	#writes = 0;
	#failAt: { readonly at: number; readonly step: 'bytes' | 'rename' } | undefined;
	#failNextDelete = false;

	/** Fails every operation with `cause` — the unreachable workspace of ADR-0008. */
	static unreachable(cause: Error = new Error('Workspace not reachable')): MemoryProjectStore {
		const store = new MemoryProjectStore();
		store.#unreachable = cause;
		return store;
	}

	/** Every path currently held, sorted, temporary files included. For assertions. */
	snapshot(): ReadonlyMap<StorePath, Bytes> {
		return new Map([...this.#files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	}

	/**
	 * Fail the next `write` at `step`, and only that one.
	 *
	 * A documented fault switch alongside {@link unreachable}, for the same reason: what survives a
	 * write that fails half way through is the whole of ADR-0017 rule 4, and no public API can
	 * produce that failure. Having it here rather than as a spy on a protected member inside the
	 * shared adapter suite is what lets the suite stay ignorant of how any backend is built —
	 * `'bytes'` is the temporary file never landing, `'rename'` is the move into place failing.
	 */
	failNextWrite(step: 'bytes' | 'rename'): void {
		this.failWriteAt(1, step);
	}

	/**
	 * Fail the `nth` `write` from now on at `step`, and only that one.
	 *
	 * {@link failNextWrite} widened to reach a boundary *inside* a multi-file operation, which is
	 * where Project Import's atomicity lives: a transaction writing a marker, a closure and the
	 * marker again has a durable boundary between every pair of those writes, and "the whole
	 * Workspace, before or after, never a mixture" is a claim about all of them rather than about the
	 * first. Counting is what makes the matrix exhaustive without the caller knowing how the engine
	 * is built — `nth` is a position in the sequence of writes the store sees, not a path.
	 *
	 * **Assumes the writes are awaited one at a time**, which is the only way an ordinal means
	 * anything. Every multi-file operation in this codebase writes sequentially, because the store's
	 * contract is per file and peak memory is deliberately one file.
	 */
	failWriteAt(nth: number, step: 'bytes' | 'rename'): void {
		this.#failAt = { at: this.#writes + nth, step };
	}

	/**
	 * Fail the next `delete`, and only that one.
	 *
	 * The other half of a transaction's durable boundaries: a protocol whose last step is removing its
	 * own marker has a failure there that no write fault can reach, and what a Workspace looks like
	 * after it is the difference between a Project that arrived and one that was rolled back.
	 */
	failNextDelete(): void {
		this.#failNextDelete = true;
	}

	/**
	 * Make every further operation fail — the backing going away mid-operation.
	 *
	 * {@link unreachable} for a store that is already in flight, and the only way to reach the case
	 * where an operation's *cleanup* cannot run either: a laptop closed, a folder unmounted, a tab
	 * losing its OPFS handle. {@link snapshot} still answers, because what the disk holds after that
	 * is exactly what has to be asserted.
	 */
	becomeUnreachable(cause: Error = new Error('Workspace not reachable')): void {
		this.#unreachable = cause;
	}

	/**
	 * Put `bytes` at `path` with no validation, including at a reserved temporary path.
	 *
	 * For tests that need the store in a state only a crashed tab can produce. There is
	 * deliberately no way to do this through {@link ProjectStore}, which is exactly why an
	 * abandoned write cannot be cleaned up with `delete` and `reclaimAbandonedWrites` exists.
	 */
	plant(path: StorePath, bytes: Bytes): void {
		this.#files.set(path, bytes.slice());
	}

	protected async readBytes(path: StorePath): Promise<Bytes> {
		this.#assertReachable();
		const bytes = this.#files.get(path);
		if (!bytes) throw new PathNotFoundError(path);
		// A copy, so a caller mutating what it read cannot reach back into the store. The real
		// backends hand out fresh buffers and application code must not depend on which.
		return bytes.slice();
	}

	protected async writeBytes(path: StorePath, bytes: Bytes): Promise<void> {
		this.#assertReachable();
		this.#writes += 1;
		this.#failIfArmed('bytes');
		this.#files.set(path, bytes.slice());
	}

	protected async renameTempFile(from: StorePath, to: StorePath): Promise<void> {
		this.#assertReachable();
		this.#failIfArmed('rename');
		const bytes = this.#files.get(from);
		if (!bytes) throw new PathNotFoundError(from);
		this.#files.set(to, bytes);
		this.#files.delete(from);
	}

	protected async listPaths(prefix: string): Promise<StorePath[]> {
		this.#assertReachable();
		return [...this.#files.keys()].filter((path) => path.startsWith(prefix));
	}

	protected async deletePath(path: StorePath): Promise<void> {
		this.#assertReachable();
		if (this.#failNextDelete) {
			this.#failNextDelete = false;
			throw new Error(`storage went away while ${path} was being deleted`);
		}
		this.#files.delete(path);
	}

	protected async byteLength(path: StorePath): Promise<number> {
		this.#assertReachable();
		const bytes = this.#files.get(path);
		if (!bytes) throw new PathNotFoundError(path);
		return bytes.byteLength;
	}

	#assertReachable(): void {
		if (this.#unreachable) throw this.#unreachable;
	}

	#failIfArmed(step: 'bytes' | 'rename'): void {
		const armed = this.#failAt;
		if (armed === undefined || armed.step !== step || armed.at !== this.#writes) return;
		this.#failAt = undefined;
		throw new Error(`storage went away while write ${armed.at} was at the ${step} step`);
	}
}
