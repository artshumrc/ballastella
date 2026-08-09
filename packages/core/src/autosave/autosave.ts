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
	 * How long {@link Autosave.abandon} and {@link Autosave.settled} will wait for a write the store
	 * already has, before answering `false` and letting the caller get on with it.
	 *
	 * Injectable so the bound itself is testable — a wait nothing can expire is a wait nothing can
	 * prove expires. See `Autosave.#quietUnder` for why there is a bound at all.
	 */
	readonly inFlightWaitMs?: number;
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
	readonly #inFlightWaitMs: number;
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
		// Long enough that an OPFS write which is merely slow is waited for rather than given up on,
		// and short enough that a write which is never going to settle costs the user a pause and not
		// a Delete button that does nothing. See `#quietUnder`.
		this.#inFlightWaitMs = options.inFlightWaitMs ?? 2000;
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

	/**
	 * Give up on everything still pending under `prefix`, because it is being deleted (ticket 21).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE JOURNAL WAS SWEPT AND THE BYTES THAT FILL IT WERE NOT
	 *
	 * `EditorSession.deleteProject` emptied the *journal* of the Project it was deleting and left
	 * `Autosave`'s own pending bytes exactly where they were. Those bytes are the source the journal
	 * is written from, so both of this class's rule-3 halves put the Project straight back:
	 * {@link capture} re-records `<project>/project.json` at `pagehide`, **after** the sweep, and
	 * {@link flush} writes it into the store outright. Either one resurrects a Project the user
	 * watched disappear — the exact defect ticket 21 closes, arriving by a route the sweep could not
	 * see.
	 *
	 * Swept here rather than by ordering the two more carefully, because there is no ordering that
	 * works: `pagehide` can fire at any point after the click, including between the sweep and the
	 * deletion resolving.
	 *
	 * Timers are cleared and the save state republished, so a Project deleted mid-debounce does not
	 * leave the indicator reading "Unsaved" for a file that no longer exists.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE SYNCHRONOUS HALF IS ALL OF THE SWEEP AND NONE OF THE GUARANTEE
	 *
	 * ⚠ **A write already handed to the store cannot be called back.** {@link #drainLoop} captures
	 * its `bytes` and then awaits `store.write`; clearing `pending` here does not reach into that.
	 * So a `<project>/project.json` write in flight at the moment the user presses Delete can resolve
	 * **after** the deletion has listed the directory, recreating the manifest behind it — and the
	 * deletion then drops its own record, leaving nothing for the next startup to catch.
	 *
	 * Which is why this answers with a promise: everything it *could* stop is stopped before it
	 * returns, and the promise is for the writes it could not. `Workspace.deleteProject` waits on it
	 * **after** writing the deletion down and before removing a byte, so the synchronous guarantee
	 * that whole ticket rests on is untouched.
	 *
	 * Never rejects: a write that failed is a write the store does not have, which is the outcome the
	 * caller wanted anyway.
	 *
	 * @returns whether everything under `prefix` is now quiet. `false` means a write is **still out
	 *   there** and the wait gave up on it — see {@link #quietUnder}.
	 */
	abandon(prefix: string): Promise<boolean> {
		const inFlight: Promise<unknown>[] = [];
		for (const [path, file] of [...this.#files]) {
			if (!path.startsWith(prefix)) continue;
			if (file.timer !== undefined) {
				clearTimeout(file.timer);
				file.timer = undefined;
			}
			file.pending = undefined;
			file.error = undefined;
			file.journalRefusal = undefined;
			this.#forget(path);
			// A write already in flight owns this entry until it settles; `#drainLoop`'s `finally` is
			// what removes it, and removing it here would let a second drain start for the same path.
			if (file.draining) inFlight.push(file.draining);
			else this.#files.delete(path);
		}
		this.#publishJournalRefusal();
		this.#publish();
		return this.#quietUnder(inFlight);
	}

	/**
	 * Bring everything under `prefix` to rest, **losing nothing** (ticket 21, rounds 4 and 5).
	 *
	 * {@link abandon}'s sibling, and the difference is the whole reason it exists: `abandon` is for a
	 * path whose bytes are about to be *removed*, so it throws them away; this is for a path that is
	 * about to be removed **by somebody else** — `deleteHistoricalMap`, which decides for itself
	 * whether the deletion may happen at all and must not have the user's unsaved Alignment thrown
	 * away before it does. Nothing here is discarded: an edit that survives this is on disk, and if
	 * the deletion is then refused the user still has it.
	 *
	 * ⚠ **"Rest" is not "nothing in flight", and the first cut of this waited only for
	 * `file.draining`** (round 5). A file inside its debounce has `pending` set and `draining`
	 * undefined, so that version answered `true` for a path whose bytes had not left this object —
	 * and its timer would then fire during whatever the caller went on to do. A pending file is
	 * **drained** instead: the timer is cleared and the write started now rather than in a few
	 * hundred milliseconds, which costs nothing because it is a write the store was about to be given
	 * anyway, and is the only reading of "settled" that is true of bytes still held here.
	 *
	 * ⚠ **What that is worth, stated exactly, because the round before this one over-claimed a
	 * narrower version of it.** Today's caller — `EditorSession.#quietBeforeDeleting` — sees only
	 * `commit`, which drains at once, so its reachable hazard is the in-flight case and the first cut
	 * did cover that. On those two prefixes a merely-pending file is also swept by
	 * `#forgetJournalled`'s `abandon` before anything restarts it. So this widening fixes **no
	 * currently reachable orphan**: it makes the method's name true, and it removes the landmine
	 * waiting for the first caller who queues a debounced write under a prefix they then delete. The
	 * unit test for it drives this class directly, and the editor-seam tests — which can only build
	 * the in-flight state — are honest about covering the other half.
	 *
	 * @returns whether everything under `prefix` is quiet — `false` when the wait gave up.
	 */
	settled(prefix: string): Promise<boolean> {
		const quiet: Promise<unknown>[] = [];
		for (const [path, file] of [...this.#files]) {
			// ⚠ **Prefix-scoped, and it has to be.** Without this every call would wait on every write
			// in the Workspace, so one stuck write in a Project nobody is looking at would put the
			// whole bound on every Historical Map deletion — a pause with no cause the user could see.
			if (!path.startsWith(prefix)) continue;
			if (file.timer !== undefined) {
				clearTimeout(file.timer);
				file.timer = undefined;
			}
			// `#drain` is one-writer-per-path: handed a file that is already draining it returns that
			// same promise, and `#drainLoop` picks the newer bytes up on its next pass. So this is the
			// pending case and the in-flight case in one line, with no second drain.
			if (file.pending !== undefined) quiet.push(this.#drain(path).catch(() => undefined));
			else if (file.draining) quiet.push(file.draining);
		}
		this.#publish();
		return this.#quietUnder(quiet);
	}

	/**
	 * Wait for `inFlight`, but **not for ever**.
	 *
	 * ⚠ **A store write is not guaranteed to settle, and both callers of this are on a gesture the
	 * user is watching** (ticket 21, round 4). A folder whose grant was revoked mid-write, or an OPFS
	 * handle a second tab tore down, can leave `store.write` pending with nothing to reject it — and
	 * before this class answered with a promise at all, `abandon` was synchronous and a deletion ran
	 * regardless. An unbounded wait would turn that into a Delete button that does nothing, for ever,
	 * with the Project still on screen.
	 *
	 * So the wait is a **courtesy to a write that is going to land**, not a guarantee, and the answer
	 * says which of the two happened. `Workspace.deleteProject` removes the files either way — the
	 * user asked — and keeps its deletion record when the answer is `false`, so the next startup
	 * finishes what a write landing late may have put back. Nothing is reported done that was not
	 * done, which is this chain's rule and the reason the boolean exists rather than a silent
	 * timeout.
	 */
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
	 * Drop `path`'s journal entry, and **never throw for it**.
	 *
	 * ⚠ **A `forget` that threw was a third way a drain could stop, and it was the worst of the
	 * three** (review 2). It is called from {@link #drainLoop} *after* `store.write` resolved and
	 * outside the `try` that guards the write, so a journal that threw here made `commit` reject for
	 * a write the store had actually taken: the caller reported failure for a success, `pending` was
	 * already cleared so nothing was held, `lastError` stayed `undefined`, and the indicator read
	 * **"Saved"** — a rejected save with no sentence anywhere, which is the exact shape this epic
	 * exists to remove.
	 *
	 * Swallowed for the same reason {@link #writeAhead} swallows a refused `record`, and the
	 * asymmetry between them was the bug: **a journal failure is not a save failure.** The bytes are
	 * on disk either way. Throwing from here turns a lost bookkeeping guarantee into a lost edit.
	 *
	 * ⚠ **Stated exactly, because swallowing is the thing this epic distrusts.** What is lost is a
	 * stale journal entry: the next startup replays bytes the store already has, which is a
	 * redundant write of identical bytes and not a lost or resurrected edit. What is *not* done here
	 * is telling anyone — there is no surface for "the journal is holding something it should not",
	 * `journalRefusal` says the opposite thing, and `lastError` would be a lie because no write
	 * failed. That is left open rather than invented here; see the ticket report.
	 */
	#forget(path: StorePath): void {
		try {
			this.#journal?.forget(path);
		} catch {
			// Deliberately silent here and reported nowhere yet — see above.
		}
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

	/**
	 * Start draining `path`, or hand back the drain already running for it.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * A `commit` COULD RESOLVE SUCCESSFULLY WITH ITS BYTES STILL IN MEMORY
	 *
	 * ⚠ **The memo is claimed here, before {@link #drainLoop} runs a line, and released by the loop
	 * itself at the instant it stops — never a microtask later.** It used to be released by a
	 * `.finally` on the loop's promise, which runs *after* the loop has already exited its `while`
	 * and resolved. A `commit` landing in that window saw `file.draining` still set, was handed the
	 * settling promise, set `file.pending`, and **no loop ever restarted**. The caller's promise
	 * then resolved — reporting a write that had not happened — and the bytes sat pending until the
	 * next edit to that path overwrote them. The last write of a burst was lost permanently.
	 *
	 * (Reproduced deterministically here with a store that hands the test the promise the loop
	 * awaits. **Whether real OPFS timing enters that window has not been shown and is not claimed.**)
	 *
	 * The invariant that forbids it, which is the thing to keep true rather than the mechanism:
	 * **if a file has pending bytes, a drain is scheduled or running for it.** The stated exception
	 * is a drain that stopped by *throwing* — see {@link #drainLoop}'s `finally`.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE DEFERRED IS LOAD-BEARING. DO NOT REPLACE IT WITH AN ASSIGNMENT AFTER THE CALL.
	 *
	 * ⚠ **`#drainLoop`'s very first act is to publish `'saving'`, and `#publish` runs subscribers
	 * synchronously.** A subscriber is application code: the editor's indicator, or anything that
	 * reacts to it by writing. So a subscriber can re-enter `commit` — and therefore this method —
	 * *before the loop that provoked it has run a second line*. The memo has to be in `file.draining`
	 * by then, and an `async` method cannot see its own promise, so it cannot put it there itself.
	 * `file.draining = this.#drainLoop(path, file)` assigns after that whole synchronous cascade has
	 * already happened, and the re-entrant call therefore finds the slot empty and starts a
	 * **second concurrent loop on the same path**: rule 2's one-writer invariant broken outright,
	 * with two writes racing into one file and the store free to end up holding the older of them.
	 * Measured, with a subscriber that commits once on `'saving'`: two loops instead of one.
	 *
	 * ⚠ **That hole predates this ticket**: the `??=` this replaced assigned just as late, so the
	 * concurrent-loop measurement reproduces on the commit before it too. It is not a hazard this
	 * change introduced, and closing it is not optional now that the loop releases its own memo.
	 *
	 * The same lateness has a second consequence, measured with the same probe: a loop that stops
	 * *before its first suspension* — which is what a throwing subscriber does — has already run the
	 * `finally` by the time the assignment happens, so the assignment writes a **settled** promise
	 * into `file.draining` that nothing will ever clear. If it settled by rejecting, every later
	 * `#drain` on that path hands the rejection straight back and the path is dead.
	 *
	 * Both are asserted: `keeps one writer per path when a subscriber commits back into it` and
	 * `is not killed by a subscriber that throws while the indicator is published`. Removing the
	 * deferred turns three tests red. This shape is not a stylistic choice.
	 */
	#drain(path: StorePath): Promise<void> {
		const file = this.#file(path);
		// One writer per path, so two edits to the same file can never race into the store out
		// of order. Different paths are independent — that is the whole of rule 2.
		if (file.draining !== undefined) return file.draining;
		let started!: (loop: Promise<void>) => void;
		const draining = new Promise<void>((resolve) => {
			started = resolve;
		});
		file.draining = draining;
		started(this.#drainLoop(path, file));
		return draining;
	}

	async #drainLoop(path: StorePath, file: PendingFile): Promise<void> {
		try {
			// ⚠ **Inside the `try`, and it is not tidiness.** `#publish` runs subscribers synchronously,
			// and a subscriber is application code that can throw. Published from above the `try`, that
			// throw left the loop rejecting *without the `finally` below ever running*, so
			// `file.draining` kept a rejected promise for ever and every later `#drain` on that path
			// handed it straight back — the indicator stuck on "Saving" and `commit`, the debounce and
			// `flush` all dead for that file, permanently. That is strictly worse than the defect this
			// method exists to fix: unrecoverable rather than merely stranded.
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
					//
					// ⚠ Through {@link #forget}, which swallows. This line is outside the `try` that guards
					// `store.write`, so a journal that threw here rejected `commit` for a write that had
					// succeeded — see `#forget` for the whole of it. That is what keeps the enumeration
					// below at two endings rather than three.
					this.#forget(path);
				}
				file.error = undefined;
			}
		} finally {
			// ⚠ **Synchronous with the loop stopping, and that is the entire fix.** Nothing at all runs
			// between the `while` condition reading `undefined` and this line, so there is no moment at
			// which `pending` can be set against a `draining` that is about to be cleared. A `commit`
			// arriving before this either finds the loop still going — and its bytes are picked up on
			// the next pass — or finds the memo already gone and starts its own loop, which is a promise
			// that really does cover its write. See {@link #drain} for what this replaced.
			//
			// **The stated exception to "if pending, a drain is running": a loop that stopped by
			// throwing.** Two things above this can throw, and only two: `store.write`, and the
			// `#publish('saving')` that runs subscribers. (`#forget` used to be a third and is not any
			// more — that is what it exists for.) Both leave `pending` set with nothing scheduled, on
			// purpose. Restarting here would turn a full disk into a spin and a subscriber that always
			// throws into an unkillable loop. The contract is that the bytes are **held**, so the next
			// `commit`, `queue` or `flush` still has them and the indicator reads "Unsaved" rather than
			// "Saved". Retrying them without being asked is a separate change and is not made here.
			//
			// Ranged over rather than enumerated by the caller: `leaves the path alive when a drain
			// stops because …` drives both endings and the ordinary one, each through flush, the
			// debounce and commit in turn.
			//
			// **Release first, publish last.** Measured: publishing first leaves the indicator on
			// "Saving" for a drain that has stopped, because `#derive` reads the memo this line is
			// about to clear — see `releases the drain before it publishes`. The `#publish` below runs
			// subscribers and so can throw as well, and releasing first means that cannot strand the
			// memo either; that second consequence is reasoned, not measured, and is stated as such.
			//
			// ⚠ **Residual, pre-existing and not fixed here:** `#publish` has no per-listener guard, so
			// the first subscriber that throws stops the rest being notified for that transition. This
			// change is what makes a throwing subscriber a *supported* ending, so it is named here.
			file.draining = undefined;
			if (file.pending === undefined && file.timer === undefined) this.#files.delete(path);
			this.#publish();
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
