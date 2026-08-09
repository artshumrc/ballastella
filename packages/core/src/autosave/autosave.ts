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
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS HAPPENING TO ONE FILE, AS ONE VALUE (ticket 09).
 *
 * This union replaced five independent mutable fields — `pending`, `timer`, `draining`, `error` and
 * `journalRefusal` — whose legal combinations were maintained by convention across six methods.
 * **Roughly half of every defect the `nothing-fails-silently` epic found was two of those fields
 * disagreeing about one file**, and two of them were introduced by the fixes for earlier ones:
 *
 * | Defect | The disagreement | Why it cannot be spelled now |
 * |---|---|---|
 * | The original write gap | `pending` set, the `draining` memo about to clear, nothing scheduled | there is no variant carrying bytes and no mechanism |
 * | A throwing subscriber killed the path | `draining` held a rejected promise for ever | a listener no longer runs anywhere a drain can see it — see {@link Autosave.subscribe} |
 * | The journal-`forget` ending | `pending` clear and `error` clear, but `commit` rejected | an error exists only as `held`, which carries the bytes it is about |
 * | The unbounded retry | `error` stale from an earlier refusal | leaving `held` discards the error with the state that held it |
 * | `settled()` answering `true` with a write coming | `timer` armed behind a caller that was told it was quiet | a timer exists only as `debouncing`, and every reader switches over the whole union |
 * | A refused deletion killing the retry | a "quiescing" flag set with nothing left to clear it | `abandoning` is owned by the drain it names, and that drain's `finally` is what ends it |
 *
 * **The invariant the epic spent four rounds testing is now a property of the type**: *if bytes are
 * pending, a drain is scheduled or running*. Every variant that carries bytes carries either the
 * timer that will start their drain, the drain that is writing them, or — for the one stated
 * exception — the error explaining why nothing is coming. There is no fourth possibility to write.
 *
 * **Idle is absence.** A path is in `Autosave`'s map exactly while something is happening to it, so
 * "idle with bytes" is not a state that has to be forbidden; it has no representation at all.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
type FileState =
	/**
	 * Rule 2's debounce window. `bytes` are the newest edit and `timer` is what will write them; the
	 * two are created together and cannot be separated, which is what defect 5 needed.
	 */
	| {
			readonly at: 'debouncing';
			readonly bytes: Bytes;
			readonly timer: ReturnType<typeof setTimeout>;
	  }
	/**
	 * A drain owns this path and `bytes` are what the store has not taken yet. Rule 2's
	 * one-writer-per-path is this variant being the only one that carries a `drain`: a second writer
	 * would need a second `drain` for the same key, and the map has one value per key.
	 */
	| { readonly at: 'writing'; readonly bytes: Bytes; readonly drain: Promise<void> }
	/**
	 * {@link Autosave.abandon} was called while a drain was in flight. The bytes are gone — they were
	 * for a Project being deleted — but the write already handed to the store cannot be called back,
	 * so the path stays owned by its drain until that drain stops.
	 *
	 * The only variant with no bytes, which is why it is a variant rather than `writing` with an
	 * empty payload: "a drain is running and owes the store nothing" is a different fact from "a
	 * drain is running and these bytes are still owed", and conflating them is how `abandon` used to
	 * let a second writer in.
	 */
	| { readonly at: 'abandoning'; readonly drain: Promise<void> }
	/**
	 * **The one stated exception to "if bytes are pending, a drain is scheduled or running."** A
	 * drain stopped by throwing and left these bytes behind, deliberately: restarting would turn a
	 * full disk into a spin. The bytes are held for the next `commit`, `queue`, `flush` or `settled`,
	 * and the journal still has a copy for the next startup to replay.
	 *
	 * `error` cannot be set without `bytes`, and cannot outlive them: the only way out of `held` is a
	 * transition that builds a whole new state, so an error can never be read against a file that has
	 * since been written. That is defects 3 and 4, both of them, by construction.
	 */
	| { readonly at: 'held'; readonly bytes: Bytes; readonly error: unknown };

/** The bytes this state is holding for the store, if it is holding any. */
const bytesOf = (state: FileState): Bytes | undefined =>
	state.at === 'abandoning' ? undefined : state.bytes;

/** The drain that owns this path, if one does. */
const drainOf = (state: FileState): Promise<void> | undefined =>
	state.at === 'writing' || state.at === 'abandoning' ? state.drain : undefined;

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
 *
 * ⚠ **One state per path since ticket 09.** What is happening to a file is a single {@link FileState}
 * value rather than a handful of fields kept consistent by hand — read that type first, because the
 * argument for it is a table of six shipped defects.
 */
export class Autosave {
	readonly #store: ProjectStore;
	readonly #debounceMs: number;
	readonly #inFlightWaitMs: number;
	/**
	 * One state per path, and **presence is the whole of "something is happening"**. Nothing is ever
	 * stored here for a file at rest, so no reader has to ask whether an entry is stale.
	 */
	readonly #states = new Map<StorePath, FileState>();
	/**
	 * Why each path's bytes are **not in the journal**. The one per-file fact kept outside
	 * {@link FileState}, and it is argued rather than left over.
	 *
	 * It is orthogonal to the write path in both directions: a file can be debouncing, writing or
	 * held with or without a journal entry, and a journal refusal changes nothing about what will be
	 * written or when. Folding it into the union would double every variant to record a fact that
	 * none of them branch on — and it is the write path's own combinations that produced the defects,
	 * not this one, which has never disagreed with anything because nothing else reads it.
	 *
	 * Its lifetime is tied to {@link #states} at the two points a path stops being interesting: the
	 * drain that put the bytes in the store, and {@link abandon}. Both are marked below.
	 */
	readonly #journalRefusals = new Map<StorePath, unknown>();
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
	 *
	 * ⚠ **Reads out of `held`, which is the only variant that has an error at all** (ticket 09). It
	 * therefore cannot answer for a file whose bytes have since been written: the error and the bytes
	 * it is about leave together or not at all.
	 */
	get lastError(): unknown {
		for (const state of this.#states.values()) {
			if (state.at === 'held') return state.error;
		}
		return undefined;
	}

	/**
	 * Called on every change of {@link state}. Returns its own unsubscribe.
	 *
	 * ⚠ **A listener that throws cannot reach the caller, here or anywhere else in this class**
	 * (ticket 09). Its failure is rethrown out of band instead — see {@link #tell}.
	 */
	subscribe(listener: (state: SaveState) => void): () => void {
		this.#listeners.add(listener);
		this.#tell(() => listener(this.#state));
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
	 *
	 * ⚠ **An edit that arrives while a drain owns the path is handed to that drain and arms no timer**
	 * (ticket 09). Before, it did both: the bytes went to the running loop *and* a timer was set, so
	 * one file could be debouncing and writing at the same time. That combination was the stray timer
	 * this epic twice caught firing against bytes that were no longer there, and — worse — it turned
	 * the documented "bytes the store refused are **held**, not retried" into "retried, if the edit
	 * that failed happened to have a sibling behind it". Now the drain is the mechanism, alone.
	 */
	queue(path: WritablePath, bytes: Bytes): void {
		// Before anything else, and synchronously. This is the one call in this class that a document
		// being torn down will actually finish (ticket 20).
		this.#writeAhead(path, bytes);
		const current = this.#states.get(path);
		const drain = current && drainOf(current);
		if (drain) this.#states.set(path, { at: 'writing', bytes, drain });
		else
			this.#states.set(path, { at: 'debouncing', bytes, timer: this.#armDebounce(path, current) });
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
		// Journalled even though the write starts immediately: "immediately" is still asynchronous,
		// and the gap between here and the store having the bytes is exactly the gap a navigation
		// falls into. It is also the gap a failed write leaves the bytes sitting in.
		this.#writeAhead(path, bytes);
		// The debounce is cancelled by `#drain`, which is where every transition out of `debouncing`
		// happens. Cancelling it here as well is how a second cancellation site gets forgotten.
		return this.#drain(path, bytes);
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
			const draining = this.#bringToRest(() => true);
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
		for (const [path, state] of this.#states) {
			const bytes = bytesOf(state);
			if (bytes !== undefined) this.#writeAhead(path, bytes);
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
	 * ⚠ **A write already handed to the store cannot be called back.** {@link #drainLoop} reads its
	 * `bytes` out of the state and then awaits `store.write`; moving the path to `abandoning` here
	 * does not reach into that. So a `<project>/project.json` write in flight at the moment the user
	 * presses Delete can resolve **after** the deletion has listed the directory, recreating the
	 * manifest behind it — and the deletion then drops its own record, leaving nothing for the next
	 * startup to catch.
	 *
	 * Which is why this answers with a promise: everything it *could* stop is stopped before it
	 * returns, and the promise is for the writes it could not. `Workspace.deleteProject` waits on it
	 * **after** writing the deletion down and before removing a byte, so the synchronous guarantee
	 * that whole ticket rests on is untouched.
	 *
	 * ⚠ **`abandoning` is why a path being written to keeps exactly one writer** (ticket 09). The
	 * in-flight drain stays *in the state*, so a `queue` for the same path a moment later is handed
	 * to that same drain. Dropping the path from the map instead — which is what "clear the pending
	 * bytes" used to amount to — let the next `queue` build a fresh entry with no drain on it and
	 * start a **second** concurrent write to one file.
	 *
	 * Never rejects: a write that failed is a write the store does not have, which is the outcome the
	 * caller wanted anyway.
	 *
	 * @returns whether everything under `prefix` is now quiet. `false` means a write is **still out
	 *   there** and the wait gave up on it — see {@link #quietUnder}.
	 */
	abandon(prefix: string): Promise<boolean> {
		const inFlight: Promise<unknown>[] = [];
		for (const [path, state] of [...this.#states]) {
			if (!path.startsWith(prefix)) continue;
			// One of the two points a journal refusal stops being interesting: these bytes are not
			// going anywhere, so whether they reached the journal no longer says anything true.
			this.#journalRefusals.delete(path);
			this.#forget(path);
			const drain = drainOf(state);
			if (drain) {
				this.#states.set(path, { at: 'abandoning', drain });
				inFlight.push(drain);
			} else {
				this.#stopDebounce(state);
				this.#states.delete(path);
			}
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
	 * ⚠ **"Rest" is not "nothing in flight", and the first cut of this waited only for the in-flight
	 * write** (round 5). A file inside its debounce carried its bytes and no drain, so that version
	 * answered `true` for a path whose bytes had not left this object — and its timer would then fire
	 * during whatever the caller went on to do. Every state that carries bytes is **drained** instead:
	 * the timer is cleared and the write started now rather than in a few hundred milliseconds, which
	 * costs nothing because it is a write the store was about to be given anyway, and is the only
	 * reading of "settled" that is true of bytes still held here.
	 *
	 * ⚠ **The version of that defect ticket 09 removes is the one where it comes back.** It came back
	 * as a `timer` field nobody switched on, invisible to a reader of `settled` because `settled` did
	 * not mention timers. There is now one value per path and {@link #bringToRest} switches over all
	 * of it, so a state that carries bytes cannot be quietly left out of the answer: adding a variant
	 * without handling it does not compile.
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
		// ⚠ **Prefix-scoped, and it has to be.** Without this every call would wait on every write in
		// the Workspace, so one stuck write in a Project nobody is looking at would put the whole bound
		// on every Historical Map deletion — a pause with no cause the user could see.
		const quiet = this.#bringToRest((path) => path.startsWith(prefix));
		this.#publish();
		return this.#quietUnder(quiet);
	}

	/**
	 * Start, or join, a drain for every matching path, and hand back what to wait on.
	 *
	 * ⚠ **The one place that reads "what has to happen before this path is quiet" out of a state**,
	 * shared by {@link flush} and {@link settled} because they had the same three-way decision written
	 * out twice and one of the two got it wrong (ticket 21, round 5). The `switch` is exhaustive by
	 * type: a variant added without a case here is a compile error, not a path silently reported as
	 * quiet.
	 *
	 * ⚠ **The promises come back unhandled, and both callers must settle them with `allSettled`.**
	 * `flush` reads the rejection — that is how one refused write stops it retrying ninety-nine more
	 * times against a full disk — so swallowing here silently turned that guard off. Measured: with a
	 * `.catch` on this line, `does not turn one failing write into a storm of retries` fails with a
	 * hundred calls instead of one.
	 */
	#bringToRest(matches: (path: StorePath) => boolean): Promise<unknown>[] {
		const waiting: Promise<unknown>[] = [];
		for (const [path, state] of [...this.#states]) {
			if (!matches(path)) continue;
			switch (state.at) {
				case 'writing':
				case 'abandoning':
					// `#drain` is one-writer-per-path, so joining is all there is to do: bytes that arrived
					// while the store had the previous ones are picked up by this same loop on its next pass.
					waiting.push(state.drain);
					break;
				case 'debouncing':
				case 'held':
					waiting.push(this.#drain(path, state.bytes));
					break;
				default:
					throw unhandled(state);
			}
		}
		return waiting;
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
		const state = this.#states.get(path);
		return state !== undefined && bytesOf(state) !== undefined;
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
		try {
			this.#journal.record(path, bytes);
			this.#journalRefusals.delete(path);
		} catch (cause) {
			this.#journalRefusals.set(path, cause);
		}
		this.#publishJournalRefusal();
	}

	/**
	 * Drop `path`'s journal entry, and **never throw for it**.
	 *
	 * Two callers: {@link #drainLoop}, on the success path *after* `store.write` resolved and outside
	 * the `try` that guards the write, and {@link abandon}, synchronously while sweeping a deleted
	 * Project. The first is where the damage was.
	 *
	 * ⚠ **A `forget` that threw was a third way a drain could stop, and it was the worst of the
	 * three** (review 2). A journal that threw in `#drainLoop` made `commit` reject for a write the
	 * store had actually taken: the caller reported failure for a success, the bytes had already been
	 * released so nothing was held, `lastError` stayed `undefined`, and the indicator read **"Saved"**
	 * — a rejected save with no sentence anywhere, which is the exact shape this epic exists to
	 * remove. In `abandon` it would have taken down a Delete the user was watching.
	 *
	 * Swallowed because **a journal failure is not a save failure**: the bytes are on disk either
	 * way, so throwing turns a lost bookkeeping guarantee into a lost edit. {@link #writeAhead} makes
	 * the same call for a refused `record` — but only half the same, and the difference is the point
	 * below: it swallows the *throw* and still reports the cause, through `#journalRefusals` and
	 * `onJournalRefused`. This swallows both.
	 *
	 * ⚠ **NOBODY IS TOLD, AND THAT IS THE COST.** There is no surface for "the journal is holding
	 * something it should not": a journal refusal says the opposite thing, and `lastError` would be a
	 * lie because no write failed. Inventing one belongs to ticket 03, not here.
	 *
	 * What the stale entry then does at the next startup, stated to the limit of what is measured:
	 * `replayJournal` writes it back, which is a **redundant write of identical bytes so long as
	 * nothing outside `Autosave` has written that path in between**. It is not harmless in general.
	 * `replay.ts` gates only on the owner still existing (`missingOwner`) and never compares the
	 * store's bytes against the entry's, so a newer write that arrived by a route which does not call
	 * `journal.record` is reverted — and reported as `restored`, which reads as good news.
	 *
	 * Measured against a real `WriteAheadJournal` and `replayJournal`:
	 *
	 * ```
	 * store v1        → entry v1 → replay → v1          restored: ["p/project.json"]
	 * store v1, v2    → entry v1 → replay → v1  ← lost  restored: ["q/project.json"]
	 * ```
	 *
	 * Every mutator inside this class re-records, so `Autosave` is not such a route;
	 * `transfer/open-project-bundle.ts`, `transfer/restore-workspace-tar.ts`, `tiler/ingest.ts`,
	 * `base-map/offline-cache.ts` and `replay.ts` itself are.
	 *
	 * ⚠ **That hazard is pre-existing and untouched here** — it does not depend on this method
	 * swallowing, and it is ticket 07's subject. Named rather than fixed.
	 *
	 * ⚠ **Reachability is not claimed, on the same standard as {@link #drain}'s.** `WriteAheadJournal`
	 * is the only production implementation and its own `forget` already swallows a refused
	 * `removeItem`, and `EditorSession` is the only place that injects it. So **no shipped journal can
	 * reach this guard**; it is driven in tests by an `AutosaveJournal` stub that throws. It is here
	 * because the interface permits it and the enumeration of drain endings has to be true of the
	 * interface, not of today's one implementation.
	 */
	#forget(path: StorePath): void {
		try {
			this.#journal?.forget(path);
		} catch {
			// Deliberately silent, and reported nowhere at all — see above for what that costs and for
			// why no existing surface can carry it.
		}
	}

	/**
	 * Report the refusal, or its end.
	 *
	 * **Per file rather than one flag**, for the reason {@link lastError} is: a single field was
	 * cleared by the next write that happened to succeed, so one enormous Annotation collection
	 * refused by the quota would have had its warning wiped by the very next keystroke into a
	 * Project name — and the user would be told they were protected when one of their files was not.
	 *
	 * ⚠ **Residual, pre-existing and not fixed here.** A refusal is dropped without being republished
	 * when the store finally takes the bytes, so the app keeps the last refusal it was told about
	 * until the *next* edit anywhere re-derives it. The bytes are safe by then, so the staleness is in
	 * the notification and not in the fact; the refusal surface is ticket 03's subject.
	 */
	#publishJournalRefusal(): void {
		let refusal: unknown = null;
		for (const cause of this.#journalRefusals.values()) {
			refusal = cause;
			break;
		}
		// On change only. Without this, every keystroke into a file that *does* fit would re-announce
		// the refusal belonging to the one that does not, and an alert that reappears on every
		// keystroke is one a user turns off in their head.
		if (refusal === this.#reportedRefusal) return;
		this.#reportedRefusal = refusal;
		this.#tell(() => this.#onJournalRefused(refusal));
	}

	/** Clear the debounce a state is holding, if it is holding one. */
	#stopDebounce(state: FileState): void {
		if (state.at === 'debouncing') clearTimeout(state.timer);
	}

	/**
	 * Replace whatever debounce `current` was holding with a fresh one.
	 *
	 * ⚠ **A timer belongs to exactly one state and dies with it.** Every transition out of
	 * `debouncing` runs through here, {@link #drain} or {@link abandon}, and all three clear it — which
	 * is why the callback can trust that a `debouncing` state it finds is the one it was armed for.
	 * The epic has twice paid for a timer that outlived the reason it was set.
	 */
	#armDebounce(path: StorePath, current: FileState | undefined): ReturnType<typeof setTimeout> {
		if (current) this.#stopDebounce(current);
		return setTimeout(() => {
			const state = this.#states.get(path);
			// Not `debouncing` means this timer was cleared and its state replaced — which cannot happen,
			// because clearing it is what replacing it consists of. Written as a read of the state rather
			// than as an assertion so that a future transition which forgets to clear costs a missed
			// write rather than a second writer on a path that already has one.
			if (state?.at !== 'debouncing') return;
			// Nobody is awaiting a debounced write, so a failure is reported through the save state
			// and `lastError` rather than as an unhandled rejection. The bytes stay pending either
			// way, so the next commit or flush tries again.
			void this.#drain(path, state.bytes).catch(() => undefined);
		}, this.#debounceMs);
	}

	/**
	 * Start draining `path` with `bytes`, or hand them to the drain already running for it.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * A `commit` COULD RESOLVE SUCCESSFULLY WITH ITS BYTES STILL IN MEMORY
	 *
	 * ⚠ **The `writing` state is in the map before {@link #drainLoop} runs a line, and the loop's
	 * `finally` replaces it at the instant the loop stops — never a microtask later.** The memo used
	 * to be released by a `.finally` on the loop's promise, which runs *after* the loop has already
	 * exited and resolved. A `commit` landing in that window saw the memo still set, was handed the
	 * settling promise, recorded its bytes, and **no loop ever restarted**. The caller's promise then
	 * resolved — reporting a write that had not happened — and the bytes sat pending until the next
	 * edit to that path overwrote them. The last write of a burst was lost permanently.
	 *
	 * (Reproduced deterministically here with a store that hands the test the promise the loop
	 * awaits. **Whether real OPFS timing enters that window has not been shown and is not claimed.**)
	 *
	 * ⚠ **Ticket 09 makes the invariant a property of the type rather than of this method.** There is
	 * no `FileState` carrying bytes without the thing that will write them, so the window has no
	 * value to land in: a `commit` arriving here either finds a `writing`/`abandoning` state and gives
	 * its bytes to that drain, or finds a state with no drain and starts one. The stated exception —
	 * `held` — carries the error saying why nothing is coming.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE DEFERRED IS LOAD-BEARING. DO NOT REPLACE IT WITH AN ASSIGNMENT AFTER THE CALL.
	 *
	 * ⚠ **`#drainLoop`'s very first act is to publish, and `#publish` runs subscribers
	 * synchronously.** A subscriber is application code: the editor's indicator, or anything that
	 * reacts to it by writing. So a subscriber can re-enter `commit` — and therefore this method —
	 * *before the loop that provoked it has run a second line*. The `writing` state has to be in the
	 * map by then, and an `async` method cannot see its own promise, so it cannot put it there itself.
	 * `#states.set(path, { …, drain: this.#drainLoop(path) })` builds the state after that whole
	 * synchronous cascade has already happened, and the re-entrant call therefore finds no drain and
	 * starts a **second concurrent loop on the same path**: rule 2's one-writer invariant broken
	 * outright, with two writes racing into one file and the store free to end up holding the older of
	 * them. Measured, with a subscriber that commits once on `'saving'`: two loops instead of one.
	 *
	 * ⚠ **That hole predates ticket 01**: the `??=` it replaced assigned just as late, so the
	 * concurrent-loop measurement reproduces on the commit before it too.
	 *
	 * Asserted by `keeps one writer per path when a subscriber commits back into it`. This shape is
	 * not a stylistic choice.
	 */
	#drain(path: StorePath, bytes: Bytes): Promise<void> {
		const current = this.#states.get(path);
		const running = current && drainOf(current);
		// One writer per path, so two edits to the same file can never race into the store out
		// of order. Different paths are independent — that is the whole of rule 2.
		if (running) {
			// Not a no-op even when the bytes are unchanged: this is also how `abandoning` is undone by
			// a caller that wants the path back.
			this.#states.set(path, { at: 'writing', bytes, drain: running });
			return running;
		}
		if (current) this.#stopDebounce(current);
		let started!: (loop: Promise<void>) => void;
		const drain = new Promise<void>((resolve) => {
			started = resolve;
		});
		this.#states.set(path, { at: 'writing', bytes, drain });
		started(this.#drainLoop(path));
		return drain;
	}

	async #drainLoop(path: StorePath): Promise<void> {
		let failure: { readonly error: unknown } | undefined;
		try {
			this.#publish();
			for (;;) {
				const state = this.#states.get(path);
				// Anything but `writing` means there is nothing left owed: either the loop has just taken
				// the last bytes the store wanted, or `abandon` took them away. Both stop.
				if (state?.at !== 'writing') break;
				const bytes = state.bytes;
				try {
					await this.#store.write(path, bytes);
				} catch (cause) {
					// The bytes are kept, deliberately. Clearing them before the attempt and merely
					// returning on failure lost the edit outright: there was nothing left for `flush` to
					// find, nothing to retry, and nothing keeping the indicator off "Saved" — which is
					// exactly what ADR-0017 rule 5 forbids. Rethrown so `commit`'s caller cannot report
					// a mutation it did not get; the `finally` below is what turns this into `held`.
					failure = { error: cause };
					throw cause;
				}
				const after = this.#states.get(path);
				// Only release what the store actually took. An edit that arrived while it had these
				// bytes is newer and has to survive to the next pass, and an `abandon` that arrived is a
				// path whose journal entry has already been dropped by `abandon` itself.
				if (after?.at !== 'writing' || after.bytes !== bytes) continue;
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
				break;
			}
		} finally {
			// ⚠ **Synchronous with the loop stopping, and that is the entire fix.** Nothing at all runs
			// between the loop deciding it is finished and this line, so there is no moment at which
			// bytes can be recorded against a drain that is about to disappear. A `commit` arriving
			// before this either finds the loop still going — and its bytes are picked up on the next
			// pass — or finds no drain and starts its own, which is a promise that really does cover its
			// write. See {@link #drain} for what this replaced.
			//
			// **The one stated exception to "if bytes are pending, a drain is scheduled or running": a
			// loop that stopped by throwing.** Exactly one thing above this can throw — `store.write`.
			// (`#forget` used to be a second and is not any more; a subscriber that throws used to be a
			// third and is not any more, because `#publish` no longer lets one escape.) It leaves the
			// bytes in `held`, on purpose. Restarting here would turn a full disk into a spin. The
			// contract is that the bytes are **held**, so the next `commit`, `queue`, `flush` or
			// `settled` still has them and the indicator reads "Unsaved" rather than "Saved". Retrying
			// them without being asked is a separate change and is not made here.
			//
			// **Release first, publish last.** Measured: publishing first leaves the indicator on
			// "Saving" for a drain that has stopped, because `#derive` reads the very state this line is
			// about to replace — see `releases the drain before it publishes`.
			const state = this.#states.get(path);
			if (failure && state?.at === 'writing') {
				this.#states.set(path, { at: 'held', bytes: state.bytes, error: failure.error });
			} else {
				this.#states.delete(path);
				// The other point a journal refusal stops being interesting: the bytes are in the store,
				// or `abandon` has thrown them away. Either way there is nothing left to be unprotected.
				this.#journalRefusals.delete(path);
			}
			this.#publish();
		}
	}

	/**
	 * Tell every listener, and **let none of them reach the code that called us** (ticket 09).
	 *
	 * ⚠ **A subscriber that threw has corrupted this class's state twice.** `#drainLoop` publishes
	 * before it does anything else, so a throw from a listener used to abort the loop: once leaving a
	 * rejected promise memoised for ever — every later write to that path dead — and once leaving the
	 * bytes stranded with the indicator reading "Saving". Guarding the loop against it was a defence
	 * in one of three places; not letting a listener throw into this class at all retires the class.
	 *
	 * The failure is **rethrown out of band, never swallowed**, which is the pattern ticket 04
	 * already established at the tile-fetch seam: `queueMicrotask` puts it where an uncaught error
	 * goes, with nothing of ours left on the stack to catch it, so `window.onerror` and the e2e
	 * suites' `pageerror` watch both still see it. A silent subscriber failure is precisely what this
	 * epic exists to stop.
	 *
	 * Per listener, so one that throws no longer stops the rest being notified — a residual named
	 * against the previous shape of this method and closed here.
	 */
	#publish(): void {
		const next = this.#derive();
		if (next === this.#state) return;
		this.#state = next;
		for (const listener of this.#listeners) this.#tell(() => listener(next));
	}

	/** Call application code from inside this class, and rethrow its failure out of band. */
	#tell(call: () => void): void {
		try {
			call();
		} catch (cause) {
			queueMicrotask(() => {
				throw cause;
			});
		}
	}

	/**
	 * What the indicator should show, **derived from the states and from nothing else**.
	 *
	 * ⚠ **There is no way to force a value past this** (ticket 09). `#publish` used to take an
	 * override, used once to announce `'saving'` before the loop had done anything — a second source
	 * of truth for the one field the user actually sees. It is unnecessary now: a drain puts its
	 * `writing` state in the map before the loop runs, so the derivation already says `'saving'`.
	 */
	#derive(): SaveState {
		let unsaved = false;
		for (const state of this.#states.values()) {
			switch (state.at) {
				case 'writing':
				case 'abandoning':
					return 'saving';
				case 'debouncing':
				case 'held':
					// A write that failed kept its bytes, so "unsaved" follows from the file's own state and
					// no separate error flag can go stale against it.
					unsaved = true;
					break;
				default:
					throw unhandled(state);
			}
		}
		return unsaved ? 'unsaved' : 'saved';
	}
}

/**
 * A {@link FileState} variant nobody handled.
 *
 * Unreachable by construction — the parameter is `never`, so adding a variant without a case in
 * every `switch` is a **compile** error rather than a path that silently reports a file as quiet.
 * That is the check; the throw is only what a caller who defeated the type system would get.
 */
const unhandled = (state: never): Error =>
	new Error(`unhandled autosave file state: ${JSON.stringify(state)}`);
