import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';

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
	#lastError: unknown;

	constructor(store: ProjectStore, options: AutosaveOptions = {}) {
		this.#store = store;
		this.#debounceMs = options.debounceMs ?? 400;
	}

	/** What the indicator should show right now. */
	get state(): SaveState {
		return this.#state;
	}

	/** Why the last write failed, if it did. Cleared by the next write that succeeds. */
	get lastError(): unknown {
		return this.#lastError;
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
	 */
	queue(path: StorePath, bytes: Bytes): void {
		const file = this.#file(path);
		file.pending = bytes;
		if (file.timer !== undefined) clearTimeout(file.timer);
		file.timer = setTimeout(() => {
			file.timer = undefined;
			void this.#drain(path);
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
	 */
	commit(path: StorePath, bytes: Bytes): Promise<void> {
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
			await Promise.allSettled(draining);
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
			file.pending = undefined;
			try {
				await this.#store.write(path, bytes);
				this.#lastError = undefined;
			} catch (cause) {
				this.#lastError = cause;
				return;
			}
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
			if (file.pending !== undefined || file.timer !== undefined) unsaved = true;
		}
		if (unsaved) return 'unsaved';
		return this.#lastError === undefined ? 'saved' : 'unsaved';
	}
}

interface PendingFile {
	timer?: ReturnType<typeof setTimeout> | undefined;
	pending?: Bytes | undefined;
	draining?: Promise<void> | undefined;
}
