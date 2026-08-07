import type { Bytes, ProjectStore, StorePath, WritablePath } from '../store/project-store.js';

/**
 * What the indicator shows. There is no Save button, so this is the user's only signal that
 * the tool has their work (ADR-0017 rule 5) — scholars will not trust a tool that offers none.
 */
export type SaveState = 'saved' | 'saving' | 'unsaved';

export interface AutosaveOptions {
	/**
	 * How long a file sits idle before it is written. Per file, never global (rule 2):
	 * otherwise editing annotations delays the alignment write and one busy file starves
	 * the rest.
	 */
	readonly debounceMs?: number;
}

/**
 * Write-through to the {@link ProjectStore}, debounced per file, with a visible save state.
 *
 * All five of ADR-0017's rules live here rather than being reinvented per slice, which is how
 * the atomic-write rule quietly fails to happen. Rules 1 and 2 are {@link commit} and
 * {@link queue}; rule 3 is {@link flush}, wired up by `installFlushOnHide`; rule 4 belongs to
 * the store's `write`; rule 5 is {@link state} and {@link subscribe}.
 */
export class Autosave {
	readonly #store: ProjectStore;
	readonly #debounceMs: number;
	readonly #files = new Map<StorePath, PendingFile>();
	readonly #listeners = new Set<(state: SaveState) => void>();
	#state: SaveState = 'saved';

	constructor(store: ProjectStore, options: AutosaveOptions = {}) {
		this.#store = store;
		this.#debounceMs = options.debounceMs ?? 400;
	}

	/** What the indicator should show right now. */
	get state(): SaveState {
		return this.#state;
	}

	/**
	 * Why a write failed, if one did and its bytes are still waiting.
	 *
	 * Tracked per file rather than globally. A single field was cleared by the next write that
	 * happened to succeed, so renaming a Project with the disk full and then creating any other
	 * Project made the indicator read "Saved" for an edit that was never written — exactly what
	 * ADR-0017 rule 5 exists to prevent.
	 */
	get lastError(): unknown {
		for (const file of this.#files.values()) {
			if (file.error !== undefined) return file.error;
		}
		return undefined;
	}

	/** Called on every change of {@link state}. Returns its own unsubscribe. */
	subscribe(listener: (state: SaveState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#state);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Rule 2. Queue `bytes` for `path`, resetting only that path's timer. Two calls for the
	 * same path inside the window produce one write; calls for different paths keep their own
	 * deadlines.
	 *
	 * **A `WritablePath`, for the same reason {@link commit} takes one** (ticket 18). This was missed
	 * in the first cut and it was the largest hole in the guard: the pending bytes reach
	 * `store.write` in {@link #drainLoop} exactly as a committed one does, so narrowing `commit`
	 * alone left `autosave.queue(alignmentPath(id), bytes)` compiling and blind-writing a Workspace
	 * Alignment on the debounce — a write nobody is even awaiting.
	 */
	queue(path: WritablePath, bytes: Bytes): void {
		const file = this.#file(path);
		file.pending = bytes;
		if (file.timer !== undefined) clearTimeout(file.timer);
		file.timer = setTimeout(() => {
			file.timer = undefined;
			// Nobody is awaiting a debounced write, so a failure is reported through the save state
			// and `lastError` rather than as an unhandled rejection. The bytes stay pending either
			// way, so the next commit or flush tries again.
			void this.#drain(path).catch(() => undefined);
		}, this.#debounceMs);
		this.#publish();
	}

	/**
	 * Rule 1. Write `path` now, cancelling any debounce on it.
	 *
	 * This is what the end of a continuous gesture calls — pointer-up on a dragged Control
	 * Point, not a timer. Dragging then writes exactly once, and a dropped frame never costs a
	 * write; debouncing alone would turn a drag into a write storm against the storage layer,
	 * worst in OPFS, which is the constrained backend. No gesture exists yet, which is exactly
	 * why the mechanism has to be here before the slices that need it.
	 *
	 * **Rejects when the store rejected**, so a caller cannot report a mutation as saved when it
	 * was not. The bytes stay pending, so a later {@link flush} still has them.
	 *
	 * **A `WritablePath`, which excludes an Alignment's** (ticket 18). Autosave is the route every
	 * edit in the editor takes to storage, so branding `ProjectStore.write` alone would have left the
	 * whole app one `autosave.commit(alignmentPath(id), …)` away from the blind overwrite the brand
	 * exists to prevent. `alignment/alignment-file.ts` is the one module that may cross it.
	 */
	commit(path: WritablePath, bytes: Bytes): Promise<void> {
		const file = this.#file(path);
		if (file.timer !== undefined) {
			clearTimeout(file.timer);
			file.timer = undefined;
		}
		file.pending = bytes;
		return this.#drain(path);
	}

	/**
	 * Rule 3. Write everything pending, immediately, and resolve once the store has it.
	 *
	 * Wired to `visibilitychange` → hidden and to `pagehide` — never `beforeunload`, which is
	 * unreliable and ignored on mobile. This is the closed-laptop path.
	 *
	 * Resolves rather than rejects even when a write failed: it is called from an event listener
	 * with nobody to catch it, and the failure is already visible in {@link state} and
	 * {@link lastError}.
	 */
	async flush(): Promise<void> {
		// A write can queue further work, so drain until there is nothing left rather than once.
		for (let pass = 0; pass < 100; pass += 1) {
			const draining: Promise<void>[] = [];
			for (const [path, file] of [...this.#files]) {
				if (file.timer !== undefined) {
					clearTimeout(file.timer);
					file.timer = undefined;
				}
				if (file.pending !== undefined) draining.push(this.#drain(path));
				else if (file.draining) draining.push(file.draining);
			}
			if (draining.length === 0) return;
			const results = await Promise.allSettled(draining);
			// Failed bytes stay pending, so without this the loop would retry them up to a hundred
			// times — one quota failure turned into a hundred against a full disk. A write that has
			// just failed will not succeed on an immediate retry; the next edit or flush tries again.
			if (results.some((result) => result.status === 'rejected')) return;
		}
	}

	/** Whether `path` has changes the store has not been given yet. */
	hasPendingWrite(path: StorePath): boolean {
		return this.#files.get(path)?.pending !== undefined;
	}

	#file(path: StorePath): PendingFile {
		let file = this.#files.get(path);
		if (!file) {
			file = {};
			this.#files.set(path, file);
		}
		return file;
	}

	#drain(path: StorePath): Promise<void> {
		const file = this.#file(path);
		// One writer per path, so two edits to the same file can never race into the store out
		// of order. Different paths are independent — that is the whole of rule 2.
		file.draining ??= this.#drainLoop(path, file).finally(() => {
			file.draining = undefined;
			if (file.pending === undefined && file.timer === undefined) this.#files.delete(path);
			this.#publish();
		});
		return file.draining;
	}

	async #drainLoop(path: StorePath, file: PendingFile): Promise<void> {
		this.#publish('saving');
		while (file.pending !== undefined) {
			const bytes = file.pending;
			try {
				await this.#store.write(path, bytes);
			} catch (cause) {
				// The bytes stay pending, deliberately. Clearing them before the attempt and merely
				// returning on failure lost the edit outright: there was nothing left for `flush` to
				// find, nothing to retry, and nothing keeping the indicator off "Saved" — which is
				// exactly what ADR-0017 rule 5 forbids. Rethrown so `commit`'s caller cannot report
				// a mutation it did not get.
				file.error = cause;
				throw cause;
			}
			// Only clear what the store actually took. An edit that arrived while it had these bytes
			// is newer and has to survive to the next pass.
			if (file.pending === bytes) file.pending = undefined;
			file.error = undefined;
		}
	}

	#publish(force?: SaveState): void {
		const next = force ?? this.#derive();
		if (next === this.#state) return;
		this.#state = next;
		for (const listener of this.#listeners) listener(next);
	}

	#derive(): SaveState {
		let unsaved = false;
		for (const file of this.#files.values()) {
			if (file.draining) return 'saving';
			// A write that failed left its bytes pending, so "unsaved" follows from the file's own
			// state and no separate error flag can go stale against it.
			if (file.pending !== undefined || file.timer !== undefined) unsaved = true;
		}
		return unsaved ? 'unsaved' : 'saved';
	}
}

interface PendingFile {
	timer?: ReturnType<typeof setTimeout> | undefined;
	pending?: Bytes | undefined;
	draining?: Promise<void> | undefined;
	/** Why this file's last write attempt failed. Cleared when one succeeds. */
	error?: unknown;
}
