import type { Bytes, ProjectStore, StorePath, WritablePath } from '../store/project-store.js';

export type SaveState = 'saved' | 'saving' | 'unsaved';

// Both methods must stay synchronous.
export interface AutosaveJournal {
	record(path: StorePath, bytes: Bytes): void;
	forget(path: StorePath): void;
}

type FileState =
	| {
			readonly at: 'debouncing';
			readonly bytes: Bytes;
			readonly timer: ReturnType<typeof setTimeout>;
	  }
	| { readonly at: 'writing'; readonly bytes: Bytes; readonly drain: Promise<void> }
	| { readonly at: 'abandoning'; readonly drain: Promise<void> }
	| { readonly at: 'held'; readonly bytes: Bytes; readonly error: unknown };

const bytesOf = (state: FileState): Bytes | undefined =>
	state.at === 'abandoning' ? undefined : state.bytes;

const drainOf = (state: FileState): Promise<void> | undefined =>
	state.at === 'writing' || state.at === 'abandoning' ? state.drain : undefined;

export class Autosave {
	readonly #store: ProjectStore;
	readonly #debounceMs: number;
	readonly #inFlightWaitMs: number;
	readonly #states = new Map<StorePath, FileState>();
	readonly #journalRefusals = new Map<StorePath, unknown>();
	readonly #listeners = new Set<(state: SaveState) => void>();
	readonly #journal: AutosaveJournal | undefined;
	readonly #onJournalRefused: (problem: unknown) => void;
	#state: SaveState = 'saved';
	#reportedRefusal: unknown = null;

	constructor(
		store: ProjectStore,
		options: {
			readonly debounceMs?: number;
			readonly inFlightWaitMs?: number;
			readonly journal?: AutosaveJournal;
			readonly onJournalRefused?: (problem: unknown) => void;
		} = {}
	) {
		this.#store = store;
		this.#debounceMs = options.debounceMs ?? 400;
		this.#inFlightWaitMs = options.inFlightWaitMs ?? 2000;
		this.#journal = options.journal;
		this.#onJournalRefused = options.onJournalRefused ?? (() => undefined);
	}

	get state(): SaveState {
		return this.#state;
	}

	get lastError(): unknown {
		for (const state of this.#states.values()) {
			if (state.at === 'held') return state.error;
		}
		return undefined;
	}

	subscribe(listener: (state: SaveState) => void): () => void {
		this.#listeners.add(listener);
		this.#tell(() => listener(this.#state));
		return () => this.#listeners.delete(listener);
	}

	queue(path: WritablePath, bytes: Bytes): void {
		const current = this.#states.get(path);
		const drain = current && drainOf(current);
		if (drain) this.#states.set(path, { at: 'writing', bytes, drain });
		else
			this.#states.set(path, { at: 'debouncing', bytes, timer: this.#armDebounce(path, current) });
		this.#writeAhead(path);
		this.#announce();
	}

	commit(path: WritablePath, bytes: Bytes): Promise<void> {
		// Owed before journalling, so a refusal handler that makes its own edit is not reverted by this one.
		const { drain, start } = this.#owe(path, bytes);
		this.#writeAhead(path);
		start();
		return drain;
	}

	async flush(): Promise<void> {
		for (let pass = 0; pass < 100; pass += 1) {
			const draining = this.#bringToRest(() => true);
			if (draining.length === 0) return;
			const results = await Promise.allSettled(draining);
			// Failed bytes stay pending; retrying them here would hammer a full disk.
			if (results.some((result) => result.status === 'rejected')) return;
		}
	}

	capture(): void {
		if (!this.#journal) return;
		for (const path of [...this.#states.keys()]) this.#writeAhead(path);
	}

	abandon(prefix: string): Promise<boolean> {
		const inFlight: Promise<unknown>[] = [];
		for (const path of [...this.#states.keys()]) {
			if (!path.startsWith(prefix)) continue;
			this.#journalRefusals.delete(path);
			this.#forget(path);
			// Re-read after `#forget`: the injected journal may have queued to this path.
			const state = this.#states.get(path);
			if (state === undefined) continue;
			const drain = drainOf(state);
			if (drain) {
				this.#states.set(path, { at: 'abandoning', drain });
				inFlight.push(drain);
			} else {
				this.#stopDebounce(state);
				this.#states.delete(path);
			}
		}
		this.#sendJournalRefusal();
		this.#announce();
		return this.#quietUnder(inFlight);
	}

	settled(prefix: string): Promise<boolean> {
		const quiet = this.#bringToRest((path) => path.startsWith(prefix));
		this.#announce();
		return this.#quietUnder(quiet);
	}

	#bringToRest(matches: (path: StorePath) => boolean): Promise<unknown>[] {
		const waiting: Promise<unknown>[] = [];
		for (const path of [...this.#states.keys()]) {
			if (!matches(path)) continue;
			const owed = this.#drainOwed(path);
			if (owed) waiting.push(owed);
		}
		return waiting;
	}

	#drainOwed(path: StorePath): Promise<void> | undefined {
		const state = this.#states.get(path);
		if (state === undefined) return undefined;
		if (state.at === 'writing' || state.at === 'abandoning') return state.drain;
		const { drain, start } = this.#owe(path, state.bytes);
		start();
		return drain;
	}

	async #quietUnder(inFlight: readonly Promise<unknown>[]): Promise<boolean> {
		if (inFlight.length === 0) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), this.#inFlightWaitMs);
		});
		try {
			return await Promise.race([Promise.allSettled(inFlight).then(() => true), expiry]);
		} finally {
			clearTimeout(timer);
		}
	}

	hasPendingWrite(path: StorePath): boolean {
		const state = this.#states.get(path);
		return state !== undefined && bytesOf(state) !== undefined;
	}

	#writeAhead(path: StorePath): void {
		if (!this.#journal) return;
		const state = this.#states.get(path);
		const bytes = state && bytesOf(state);
		if (bytes === undefined) return;
		try {
			this.#journal.record(path, bytes);
			this.#journalRefusals.delete(path);
		} catch (cause) {
			this.#journalRefusals.set(path, cause);
		}
		this.#sendJournalRefusal();
	}

	#forget(path: StorePath): void {
		try {
			this.#journal?.forget(path);
		} catch {
			// Best effort.
		}
	}

	#sendJournalRefusal(): void {
		const first = this.#journalRefusals.values().next();
		const refusal = first.done ? null : first.value;
		if (refusal === this.#reportedRefusal) return;
		this.#reportedRefusal = refusal;
		this.#tell(() => this.#onJournalRefused(refusal));
	}

	#stopDebounce(state: FileState): void {
		if (state.at === 'debouncing') clearTimeout(state.timer);
	}

	#armDebounce(path: StorePath, current: FileState | undefined): ReturnType<typeof setTimeout> {
		if (current) this.#stopDebounce(current);
		return setTimeout(() => {
			if (this.#states.get(path)?.at !== 'debouncing') return;
			void this.#drainOwed(path)?.catch(() => undefined);
		}, this.#debounceMs);
	}

	#owe(
		path: StorePath,
		bytes: Bytes
	): { readonly drain: Promise<void>; readonly start: () => void } {
		const current = this.#states.get(path);
		const running = current && drainOf(current);
		if (running) {
			this.#states.set(path, { at: 'writing', bytes, drain: running });
			return { drain: running, start: () => undefined };
		}
		if (current) this.#stopDebounce(current);
		let started!: (loop: Promise<void>) => void;
		const drain = new Promise<void>((resolve) => {
			started = resolve;
		});
		this.#states.set(path, { at: 'writing', bytes, drain });
		return { drain, start: () => started(this.#drainLoop(path)) };
	}

	async #drainLoop(path: StorePath): Promise<void> {
		let failure: { readonly error: unknown } | undefined;
		try {
			this.#announce();
			for (;;) {
				const state = this.#states.get(path);
				if (state?.at !== 'writing') break;
				const bytes = state.bytes;
				try {
					await this.#store.write(path, bytes);
				} catch (cause) {
					failure = { error: cause };
					throw cause;
				}
				const after = this.#states.get(path);
				// Newer bytes arrived mid-write (or `abandon` already forgot the entry): go round again.
				if (after?.at !== 'writing' || after.bytes !== bytes) continue;
				this.#forget(path);
				break;
			}
		} finally {
			const state = this.#states.get(path);
			if (failure && state?.at === 'writing') {
				this.#states.set(path, { at: 'held', bytes: state.bytes, error: failure.error });
			} else {
				this.#states.delete(path);
				this.#journalRefusals.delete(path);
			}
			this.#announce();
		}
	}

	#announce(): void {
		const next = this.#derive();
		if (next === this.#state) return;
		this.#state = next;
		for (const listener of this.#listeners) this.#tell(() => listener(this.#state));
	}

	#tell(call: () => void): void {
		try {
			call();
		} catch (cause) {
			queueMicrotask(() => {
				throw cause;
			});
		}
	}

	#derive(): SaveState {
		const states = [...this.#states.values()];
		if (states.some((state) => drainOf(state) !== undefined)) return 'saving';
		return states.length > 0 ? 'unsaved' : 'saved';
	}
}

interface HideEventTargets {
	readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
	readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export function installFlushOnHide(autosave: Autosave, targets: HideEventTargets): () => void {
	const keep = () => {
		autosave.capture();
		void autosave.flush();
	};
	const onVisibilityChange = () => {
		if (targets.document.visibilityState === 'hidden') keep();
	};

	targets.document.addEventListener('visibilitychange', onVisibilityChange);
	targets.window.addEventListener('pagehide', keep);

	return () => {
		targets.document.removeEventListener('visibilitychange', onVisibilityChange);
		targets.window.removeEventListener('pagehide', keep);
	};
}
