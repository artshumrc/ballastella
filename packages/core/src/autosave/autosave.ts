import type { Bytes, ProjectStore, StorePath, WritablePath } from '../store/project-store.js';

/**
 * What the indicator shows. There is no Save button, so this is the user's only signal that
 * the tool has their work (ADR-0017 rule 5) — scholars will not trust a tool that offers none.
 */
export type SaveState = 'saved' | 'saving' | 'unsaved';

/**
 * The write-ahead journal, as {@link Autosave} needs it (ticket 20).
 *
 * An interface rather than the class, so that `@ballastella/core`'s Node-side tests can drive every
 * branch — including the refusal — and so that a build with no usable `localStorage` passes nothing
 * at all rather than a stub that would make the app claim a protection it does not have.
 *
 * Both methods are **synchronous**, and that is the entire contract. An asynchronous journal would
 * be exactly the thing measured not to work: a document being unloaded does not run a continuation.
 */
export interface AutosaveJournal {
	/** Put `bytes` on disk for `path` now. Throws when the browser refused. */
	record(path: StorePath, bytes: Bytes): void;
	/** Drop `path`'s entry, because the store has the bytes. */
	forget(path: StorePath): void;
}

export interface AutosaveOptions {
	/**
	 * How long a file sits idle before it is written. Per file, never global (rule 2):
	 * otherwise editing annotations delays the alignment write and one busy file starves
	 * the rest.
	 */
	readonly debounceMs?: number;
	/**
	 * Where pending bytes are written ahead of the store (ADR-0017 rule 3, as amended by ticket 20).
	 *
	 * Optional because it is a browser capability and not a guarantee: `localStorage` can be absent
	 * or refused outright. Omitted, this class behaves exactly as it did before — which is to say,
	 * an edit inside its debounce window does not survive a real navigation.
	 */
	readonly journal?: AutosaveJournal;
	/**
	 * Called with the reason the journal refused an edit, and with `null` the moment it accepts one
	 * again.
	 *
	 * A callback rather than a field to poll, because the whole value of journalling at the edit
	 * rather than at `pagehide` is that there is still a screen to say this on and a person to read
	 * it. See `journal.ts` for why that timing is the design.
	 */
	readonly onJournalRefused?: (problem: unknown) => void;
}

/**
 * Write-through to the {@link ProjectStore}, debounced per file, with a visible save state.
 *
 * All five of ADR-0017's rules live here rather than being reinvented per slice, which is how
 * the atomic-write rule quietly fails to happen. Rules 1 and 2 are {@link commit} and
 * {@link queue}; rule 3 is {@link capture} and {@link flush}, wired up by `installFlushOnHide`;
 * rule 4 belongs to the store's `write`; rule 5 is {@link state} and {@link subscribe}.
 *
 * ⚠ **Rule 3 is two halves since ticket 20, and the asynchronous one does not survive a real
 * navigation.** {@link flush} awaits `store.write`, and a document being unloaded does not run the
 * continuation — a debounced Project rename followed by a real `page.reload()` lost the edit 8
 * times out of 8. So an edit is written to a synchronous journal at the moment it is queued, and
 * replayed at startup; see `journal.ts` for the measurement and for what the journal is not.
 */
export class Autosave {
	readonly #store: ProjectStore;
	readonly #debounceMs: number;
	readonly #files = new Map<StorePath, PendingFile>();
	readonly #listeners = new Set<(state: SaveState) => void>();
	readonly #journal: AutosaveJournal | undefined;
	readonly #onJournalRefused: (problem: unknown) => void;
	#state: SaveState = 'saved';
	/** The refusal last handed to `onJournalRefused`, so nothing is reported twice. */
	#reportedRefusal: unknown = null;

	constructor(store: ProjectStore, options: AutosaveOptions = {}) {
		this.#store = store;
		this.#debounceMs = options.debounceMs ?? 400;
		this.#journal = options.journal;
		this.#onJournalRefused = options.onJournalRefused ?? (() => undefined);
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
		// Before the timer, and synchronously. This is the one call in this class that a document
		// being torn down will actually finish (ticket 20).
		this.#writeAhead(path, bytes);
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
		// Journalled even though the write starts immediately: "immediately" is still asynchronous,
		// and the gap between here and the store having the bytes is exactly the gap a navigation
		// falls into. It is also the gap a failed write leaves the bytes sitting in.
		this.#writeAhead(path, bytes);
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

	/**
	 * Rule 3's synchronous half (ticket 20). Put everything still pending in the journal, **now**,
	 * **now**.
	 *
	 * Returns nothing. It briefly answered whether everything fitted, and no caller read it: a
	 * boolean that conflated "one file did not fit" with "there is no journal on this browser" was
	 * two different sentences in one bit, and both are already reported properly — the first through
	 * `onJournalRefused`, the second by `WorkspaceStorage` at startup.
	 *
	 * Called from the `pagehide` listener *before* {@link flush}, and it is the call that has to
	 * finish: `flush` awaits a store write, and a document being unloaded does not run the
	 * continuation. See ADR-0017, "Rule 3, amended", for the measurement that says so.
	 *
	 * Ordinarily every one of these bytes is already journalled by {@link queue} or {@link commit},
	 * so this is a re-record and not the only chance. It is here anyway because "the journal is
	 * complete at every moment" is an invariant of two methods rather than of one, and a third
	 * mutator added later would otherwise silently opt out of the guarantee.
	 *
	 * Never throws. It runs where nothing can catch, the refusal is already reported through
	 * `onJournalRefused`, and one file that will not fit must not stop the others being kept.
	 */
	capture(): void {
		if (!this.#journal) return;
		for (const [path, file] of this.#files) {
			if (file.pending !== undefined) this.#writeAhead(path, file.pending);
		}
	}

	/** Whether `path` has changes the store has not been given yet. */
	hasPendingWrite(path: StorePath): boolean {
		return this.#files.get(path)?.pending !== undefined;
	}

	/**
	 * Record `bytes` ahead of the store write, and report a refusal without failing the edit.
	 *
	 * **A journal refusal is not a failed save.** The bytes are in memory and the store write is
	 * still going to happen, so throwing from here would turn a lost *guarantee* into a lost edit —
	 * which is the failure this whole ticket is closing, reintroduced by its own fix. What it costs
	 * is protection against leaving the page in the next few hundred milliseconds, and that is what
	 * the user is told, in the words `JournalFullError` carries.
	 */
	#writeAhead(path: StorePath, bytes: Bytes): void {
		if (!this.#journal) return;
		const file = this.#file(path);
		try {
			this.#journal.record(path, bytes);
			file.journalRefusal = undefined;
		} catch (cause) {
			file.journalRefusal = cause;
		}
		this.#publishJournalRefusal();
	}

	/**
	 * Report the refusal, or its end.
	 *
	 * **Per file rather than one flag**, for the reason {@link lastError} is: a single field was
	 * cleared by the next write that happened to succeed, so one enormous Annotation collection
	 * refused by the quota would have had its warning wiped by the very next keystroke into a
	 * Project name — and the user would be told they were protected when one of their files was not.
	 */
	#publishJournalRefusal(): void {
		let refusal: unknown = null;
		for (const file of this.#files.values()) {
			if (file.journalRefusal !== undefined) {
				refusal = file.journalRefusal;
				break;
			}
		}
		// On change only. Without this, every keystroke into a file that *does* fit would re-announce
		// the refusal belonging to the one that does not, and an alert that reappears on every
		// keystroke is one a user turns off in their head.
		if (refusal === this.#reportedRefusal) return;
		this.#reportedRefusal = refusal;
		this.#onJournalRefused(refusal);
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
			if (file.pending === bytes) {
				file.pending = undefined;
				// The journal's only job is to hold what the store does not, so the entry goes the
				// moment the store has it — and **only** then, and only when nothing newer arrived
				// while the write was in flight. Forgetting unconditionally here would drop the
				// journal copy of an edit typed during the write, whose own `record` happened before
				// this line and would be undone by it.
				this.#journal?.forget(path);
			}
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
	/** Why this file's bytes are not in the write-ahead journal. Cleared when they get in. */
	journalRefusal?: unknown;
}
