import { PathNotFoundError, type Bytes, type StorePath } from './project-store.js';
import { TempFileWriteStore } from './temp-file-write-store.js';

/**
 * A {@link ProjectStore} in a `Map`. SPEC's Seam 1 — the primary seam, because in this
 * project "after this sequence of actions the store holds these files with these contents"
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
	#failNextWriteStep: 'bytes' | 'rename' | undefined;

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
		this.#failNextWriteStep = step;
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
		if (this.#failNextWriteStep !== step) return;
		this.#failNextWriteStep = undefined;
		throw new Error(`storage went away while the write was at the ${step} step`);
	}
}
