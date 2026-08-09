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
 * **Half of the invariant the epic spent four rounds testing is now a property of the type**: every
 * variant that carries bytes carries either the timer that will start their drain, the drain that is
 * writing them, or — for the one stated exception — the error explaining why nothing is coming. There
 * is no fourth possibility to write.
 *
 * ⚠ **THE OTHER HALF IS NOT, AND SAYING IT WAS COST TWO ROUNDS OF BLOCKING REGRESSIONS** (reviews 1
 * and 2). "*If bytes are pending, a drain is scheduled or running*" is a claim about **which bytes**
 * as much as about which fields, and a union cannot make it. `{ at: 'writing', bytes, drain }` is a
 * perfectly legal state whatever `bytes` holds — including bytes older than the ones the caller was
 * just told were saved. Ticket 09 turned bytes into a parameter in three places and each round found
 * the inversion in a new one: the sweep, the debounce, and then `commit` and `queue` themselves.
 *
 * ⚠ **Round 1's rule — "only a caller who was handed bytes may install bytes" — was itself false.**
 * `commit` *is* such a caller and still reverted a newer edit, because between being handed the bytes
 * and installing them it called `#writeAhead`, which reports a refusal through `onJournalRefused`.
 * So the rule became about *when* rather than *who*. ⚠ **And then it was too narrow.** Round 3 found
 * the same inversion carrying a derived `SaveState` instead of bytes: `#publish` read `#derive()`
 * once and handed that snapshot to each listener in turn, so a subscriber was told `saved` while
 * `#states` held unwritten bytes. For ADR-0017 rule 5 that is not a lesser defect — the indicator is
 * the user's only signal, and one *told* a stale state is as wrong as one holding stale bytes.
 *
 * **Bytes were the instance. Staleness is the class.** The rule is therefore about any value read
 * out of `#states`, derived or raw:
 *
 * > **No value read or derived from `#states` may be carried across a call that can reach
 * > application code.**
 *
 * Anything on the far side of such a call must read `#states` again rather than use what it read
 * before. Every place control leaves this class, and how each is held to that:
 *
 * | Reaches out | Where | Held by |
 * |---|---|---|
 * | listeners, via `#tell` | `#publish`, `subscribe` | **shape** — both read `this.#state` at the moment each listener is called, never before the loop |
 * | `onJournalRefused`, via `#tell` | `#publishJournalRefusal` | **shape** — reached only from `#writeAhead`, which takes no bytes |
 * | `journal.record` | `#writeAhead` | **shape** — the bytes are read from `#states` on the line above and used for nothing else |
 * | `journal.forget` | `#forget`, from `#drainLoop` and `abandon` | **shape** — both re-read `#states` afterwards; `abandon` walks keys |
 * | `store.write` | `#drainLoop` | **shape** — the loop re-reads `#states` after every await and compares by identity |
 * | a caller's **thenable**, via `await` | `#drainLoop`'s `await this.#store.write(…)` | **shape** — the same after-every-await re-read; see below |
 * | `AutosaveOptions` **property getters** | the constructor | **shape** — nothing is installed yet, so there is no value to make stale |
 *
 * ⚠ **The last two are not call sites, and that is why they were missed.** The `await` on
 * `store.write` reads `.then` off whatever the store returned, so a caller-supplied thenable runs
 * application code at a seam whose row above names only the call; and `options.debounceMs`,
 * `options.journal` and the rest are property reads that a `Proxy` or a getter turns into
 * application code. Neither can hold a byte value stale — the first is covered by the re-read that
 * already protects its row, the second runs before any state exists — so neither is a defect. They
 * are listed because a row that is true of the call and silent about the mechanism beside it is how
 * an enumeration stays wrong.
 *
 * ⚠ **THIS LIST WAS DERIVED BY GREP, AND MUST BE RE-DERIVED RATHER THAN RE-READ.** An earlier
 * version called itself complete on the strength of a careful reading, and was not: the two rows
 * above were missing, and a mechanical sweep of every call expression in this file is what found
 * them. A read-derived enumeration published as complete is exactly the claim-outrunning-code shape
 * this epic exists to catch. When this class changes, run the sweep again — grep every call
 * expression and every property read on caller-supplied objects, and subtract `this.#…`, the
 * `Map`/`Set`/`Promise` builtins, and the module-level pure helpers (`bytesOf`, `drainOf`,
 * `unhandled`). What is left is this table.
 *
 * ⚠ **AND THE SWEEP IS NOT ENOUGH ON ITS OWN — CHECK EACH ROW'S CLASSIFICATION SEPARATELY.** Round
 * 3's defect was in this table, in row 1, on a seam the sweep had enumerated correctly. The row said
 * `#publish` "takes no bytes and reads nothing but `#states`" — both halves true, and the conclusion
 * did not follow, because it read `#states` *once* and then called out *N* times. Finding it needed
 * a different question from "where does control leave": **for each row, what value is alive across
 * that call, and is it re-read after it?** Two rows were also classified **shape** when they were in
 * fact held by argument (see the two ⚠ blocks below); one of those, row 1, was reachable and was a
 * live defect. Enumerating the exits is the cheap half of this table. Classifying them is the half
 * that has been wrong twice.
 *
 * ⚠ **Row 1 was argument-held and nothing said so.** It was reachable only because the editor
 * registers exactly one listener and never re-registers it — but `subscribe` is public and returns
 * an unsubscribe, and `does not tell a resubscribing listener the state it had before its own edit`
 * needs no second subscriber at all: a `Set` revisits an element deleted and re-added mid-iteration.
 * "There is only one listener today" is not a property of this class and must never be cited as one.
 *
 * ⚠ **One window is held by argument rather than by shape, and it is named rather than hidden.**
 * `#owe` is handed a byte value by its caller. That is safe because `#owe` reaches nothing on the
 * list above — it touches `#states`, `drainOf` and `clearTimeout` and constructs a promise — so no
 * application code can run while the value is in flight. **Nothing enforces that it stays that way**:
 * a future edit adding a `#publish` to `#owe` would reopen the whole class of defect and no test
 * would say so. If that method grows, this table is what has to be re-derived.
 *
 * ⚠ **`journal.record` re-entering is a second argument, not a proof.** If a `record` implementation
 * synchronously wrote to the same path, the outer `record` would finish last and the journal would
 * end up holding the older bytes. `WriteAheadJournal.record` is a `localStorage.setItem` that calls
 * nothing, so no shipped journal can do it. Stated because the interface permits it.
 *
 * So the guarantee stands on two things, and both have to be read together: **the type**, for which
 * fields may coexist — this table — and **the rule above**, for which bytes go in them.
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
	 * A drain owns this path and `bytes` are what the store has not taken yet.
	 *
	 * Rule 2's one-writer-per-path rests on the map having one value per key: a path is either owned
	 * by a drain or it is not, and both variants that carry a `drain` — this one and `abandoning` —
	 * carry exactly one, which `drainOf` is the single reader of. (An earlier draft of this sentence
	 * said `writing` was *the only* variant carrying a drain. It was false in the same commit that
	 * wrote it, twelve lines above `drainOf`, which returns one for both.)
	 */
	| { readonly at: 'writing'; readonly bytes: Bytes; readonly drain: Promise<void> }
	/**
	 * {@link Autosave.abandon} was called while a drain was in flight. The bytes are gone — they were
	 * for a Project being deleted — but the write already handed to the store cannot be called back,
	 * so the path stays owned by its drain until that drain stops.
	 *
	 * The only variant with no bytes, which is why it is a variant rather than `writing` with an
	 * empty payload: "a drain is running and owes the store nothing" is a different fact from "a
	 * drain is running and these bytes are still owed".
	 *
	 * ⚠ **It did not fix a shipped defect, and an earlier draft of this comment said it did.**
	 * Measured against the parent commit: the old `abandon` cleared `pending` but kept the entry
	 * *and* its `draining` memo, so a `queue` arriving afterwards was handed the running drain and
	 * one writer was preserved. Running this ticket's tests against that implementation gives eight
	 * failures and `leaves a path being written to one writer, even after abandoning it` is **not**
	 * among them. What this variant buys is that the two facts stop being one nullable field, so a
	 * reader cannot mistake either for the other — expressiveness, not a repair.
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
	 *
	 * ⚠ **Installed before anything that can call out, which is the rule in {@link FileState}'s
	 * banner** (ticket 09, review 2). This used to journal first, and `#writeAhead` reports a refusal
	 * to the app: a handler that made its own edit had it silently reverted by the `bytes` this method
	 * was still holding. The journal record is still synchronous and still happens before any
	 * suspension, which is all ticket 20 needs of it.
	 */
	queue(path: WritablePath, bytes: Bytes): void {
		const current = this.#states.get(path);
		const drain = current && drainOf(current);
		if (drain) this.#states.set(path, { at: 'writing', bytes, drain });
		else
			this.#states.set(path, { at: 'debouncing', bytes, timer: this.#armDebounce(path, current) });
		// Synchronously, and reading what was just installed rather than what this method was passed.
		// This is the one call in this class that a document being torn down will actually finish
		// (ticket 20).
		this.#writeAhead(path);
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
		// ⚠ **Three steps, and the order is the whole of review 2's finding A.** `#owe` installs and
		// calls nothing that can reach application code; `#writeAhead` and `start` both can, and by
		// then there is no byte value left in this method for either to make stale. Written as one
		// `#drain(path, bytes)` call with the journal in front of it, a refusal handler that made its
		// own edit had that edit reverted — `commit` resolved, the store held the older bytes and the
		// indicator read Saved.
		const { drain, start } = this.#owe(path, bytes);
		// Journalled even though the write starts immediately: "immediately" is still asynchronous,
		// and the gap between here and the store having the bytes is exactly the gap a navigation
		// falls into. It is also the gap a failed write leaves the bytes sitting in. Still ahead of
		// `start`, so the ticket-20 ordering — journalled before the store is asked — is unchanged.
		this.#writeAhead(path);
		start();
		return drain;
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
		// Keys, snapshotted, and `#writeAhead` re-reads each one: `journal.record` and the refusal it
		// may report are both application code, so a value read before them can be stale by the time
		// it is used. Same rule as {@link #bringToRest} and {@link abandon} — see {@link FileState}.
		for (const path of [...this.#states.keys()]) this.#writeAhead(path);
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
	 * ⚠ **`abandoning` keeps the in-flight drain in the state, so a `queue` for the same path a moment
	 * later is handed to that same drain and one writer is preserved.** Dropping the path from the map
	 * instead would let the next `queue` build a fresh entry with no drain on it and start a **second**
	 * concurrent write to one file — which `leaves a path being written to one writer, even after
	 * abandoning it` asserts, and which deleting this branch turns red.
	 *
	 * ⚠ **That is not a defect this variant fixed, and an earlier draft of this comment said it was.**
	 * The implementation before ticket 09 cleared the pending bytes but kept the entry *and* its
	 * `draining` memo, which preserved one writer by the same argument. Corrected rather than
	 * quietly dropped, because a fix that never happened is exactly the kind of claim this epic
	 * exists to catch.
	 *
	 * Never rejects: a write that failed is a write the store does not have, which is the outcome the
	 * caller wanted anyway.
	 *
	 * ⚠ **What this does NOT guarantee, stated because the paragraphs above enumerate what it does.**
	 * An edit `queue`d for this path *after* the sweep re-adopts it — legitimately, because the caller
	 * asked for the path back — records itself in the journal, and if its write then fails it is left
	 * `held` with a live journal entry that `replayJournal` restores at the next startup. Pre-existing
	 * and identical before ticket 09; named here rather than fixed, because comparing the journal
	 * against the store is ticket 07's subject.
	 *
	 * @returns whether everything under `prefix` is now quiet. `false` means a write is **still out
	 *   there** and the wait gave up on it — see {@link #quietUnder}.
	 */
	abandon(prefix: string): Promise<boolean> {
		const inFlight: Promise<unknown>[] = [];
		// ⚠ **Keys, and the state re-read *after* `#forget`** (ticket 09, review 2). `#forget` calls an
		// injected `AutosaveJournal.forget`, which is application code by the same standard as a
		// listener: a `forget` that wrote to a path later in this walk left the old loop holding a
		// value from before that write, so it saw a live `writing` state as merely debouncing, deleted
		// it, and never put its drain into `inFlight`. This then answered `true` — everything is quiet
		// — with a write outstanding, past the very promise it exists to provide. Pre-existing; fixed
		// here because the rule this ticket writes down forbids it.
		for (const path of [...this.#states.keys()]) {
			if (!path.startsWith(prefix)) continue;
			// One of the two points a journal refusal stops being interesting: these bytes are not
			// going anywhere, so whether they reached the journal no longer says anything true.
			this.#journalRefusals.delete(path);
			this.#forget(path);
			const state = this.#states.get(path);
			// Re-added by the `forget` above, or removed by it. Either way it is not this sweep's.
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
	 * out twice and one of the two got it wrong (ticket 21, round 5).
	 *
	 * ⚠ **IT WALKS KEYS, AND IT MUST NEVER CARRY A STATE ACROSS AN ITERATION** (ticket 09, review 1).
	 * The first cut read `[...this.#states]` — keys *and values* — and handed each value's bytes to
	 * `#drain`. Draining the first path publishes, `#publish` runs subscribers synchronously, and a
	 * subscriber that writes to a path **later in this walk** then had its edit overwritten by the
	 * value read before it ran. Measured: `commit` resolved, the store held the older bytes,
	 * `hasPendingWrite` was false, the indicator read `saved` and nothing was scheduled — story 23
	 * inverted. A subscriber that *deleted* a Project mid-walk had it written straight back.
	 *
	 * {@link #drainOwed} re-reads the state at the moment it drains, and has no parameter through
	 * which a stale value could be passed. That is why this loop destructures nothing.
	 *
	 * ⚠ **The promises come back unhandled, and both callers must settle them with `allSettled`.**
	 * `flush` reads the rejection — that is how one refused write stops it retrying ninety-nine more
	 * times against a full disk — so swallowing here silently turned that guard off. Measured: with a
	 * `.catch` on this line, `does not turn one failing write into a storm of retries` fails with a
	 * hundred calls instead of one.
	 */
	#bringToRest(matches: (path: StorePath) => boolean): Promise<unknown>[] {
		const waiting: Promise<unknown>[] = [];
		for (const path of [...this.#states.keys()]) {
			if (!matches(path)) continue;
			const owed = this.#drainOwed(path);
			if (owed) waiting.push(owed);
		}
		return waiting;
	}

	/**
	 * Drain whatever `path` owes **right now**, or join the drain already running for it.
	 *
	 * ⚠ **No `bytes` parameter, and that absence is the fix for review 1's blocking regression.** Only
	 * a caller who was handed bytes by the user — {@link queue} and {@link commit} — may install bytes;
	 * see {@link #drain}. Every other route into the store reaches this method instead, which reads the
	 * state at the point of use, so there is no value in flight for a re-entrant subscriber to make
	 * stale. The union constrains which fields coexist; it cannot constrain which bytes go in them, and
	 * this is where that second half is enforced.
	 *
	 * `undefined` when the path owes nothing — which is not the same as "nothing happened". It is the
	 * answer for a path {@link abandon} removed while this walk was in progress, and answering with a
	 * promise there is what wrote a deleted Project back into the store.
	 *
	 * The `switch` is exhaustive by type: a variant added without a case here is a compile error, not
	 * a path silently reported as quiet.
	 */
	#drainOwed(path: StorePath): Promise<void> | undefined {
		const state = this.#states.get(path);
		if (state === undefined) return undefined;
		switch (state.at) {
			case 'writing':
			case 'abandoning':
				// One writer per path, so joining is all there is to do: bytes that arrived while the store
				// had the previous ones are picked up by that same loop on its next pass.
				return state.drain;
			case 'debouncing':
			case 'held': {
				// `state.bytes` is read here and installed by `#owe` with nothing in between that can
				// reach application code — the one window in which a byte value may exist outside
				// `#states`. Nothing is journalled: these bytes were recorded when they were queued or
				// committed, and re-recording from a sweep would report a refusal nobody asked about.
				const { drain, start } = this.#owe(path, state.bytes);
				start();
				return drain;
			}
			default:
				throw unhandled(state);
		}
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
	 *
	 * ⚠ **It takes no bytes: it records what `path` owes, read out of `#states`** (ticket 09, review
	 * 2). Taking them as a parameter meant `queue` and `commit` had to hold a value across this call —
	 * and this call reports a refusal to the app, so a handler that made its own edit had it reverted
	 * a moment later. Reading the state instead means the journal cannot hold bytes the store is not
	 * also about to be given.
	 */
	#writeAhead(path: StorePath): void {
		if (!this.#journal) return;
		const state = this.#states.get(path);
		const bytes = state && bytesOf(state);
		// Nothing owed — the path is `abandoning`, or has gone entirely. There is nothing to protect.
		if (bytes === undefined) return;
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
	 * What the stale entry then does at the next startup is `replay.ts`'s subject, and ticket 07
	 * changed the answer: replay compares the store against the entry rather than writing
	 * unconditionally, so an entry whose bytes the store already has resolves to
	 * `already-in-the-store` and **no write happens at all**, and one it cannot decide about is kept
	 * and reported rather than applied. What `Autosave` contributes to that comparison is the
	 * baseline, and only from {@link #forget} — this method, called after a store write has actually
	 * succeeded. That is why a swallowed `forget` matters at all: it costs the path its baseline, not
	 * a reverted file. See `replay.ts` for the decision table.
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
			// Not `debouncing` means this timer was cleared and its state replaced — which cannot happen,
			// because clearing it is what replacing it consists of. Written as a read of the state rather
			// than as an assertion so that a future transition which forgets to clear costs a missed
			// write rather than a second writer on a path that already has one.
			//
			// ⚠ **Deliberately not bound to a variable** (ticket 09, review 2). Holding `state` here and
			// passing `state.bytes` on the next line was measured to be an *equivalent* mutant — nothing
			// runs in between, so nothing could redden it — which meant "every route but `queue` and
			// `commit` drains what the path owes rather than a value it is carrying" was enforced by
			// care at this site and by shape everywhere else. With no binding there is no value to
			// pass, so it is shape here too.
			if (this.#states.get(path)?.at !== 'debouncing') return;
			// Nobody is awaiting a debounced write, so a failure is reported through the save state
			// and `lastError` rather than as an unhandled rejection. The bytes stay pending either
			// way, so the next commit or flush tries again.
			void this.#drainOwed(path)?.catch(() => undefined);
		}, this.#debounceMs);
	}

	/**
	 * Install `bytes` as what `path` owes the store, and answer both the drain that will write them
	 * and how to set it going.
	 *
	 * ⚠ **THIS METHOD REACHES NO APPLICATION CODE, AND THAT IS ITS CONTRACT.** It touches
	 * `#states`, `drainOf` and `clearTimeout`, and constructs a promise. Nothing here can call a
	 * listener, a journal or the store. That is what makes it safe to hold a byte value across —
	 * the only place in this class where a byte value may be held at all — and it is why `start`
	 * comes back as a thunk rather than being called here: starting the loop publishes, and
	 * publishing is application code that must not run until the caller has finished installing and
	 * journalling. See {@link FileState}'s banner for the rule and {@link commit} for the defect.
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
	#owe(
		path: StorePath,
		bytes: Bytes
	): { readonly drain: Promise<void>; readonly start: () => void } {
		const current = this.#states.get(path);
		const running = current && drainOf(current);
		// One writer per path, so two edits to the same file can never race into the store out
		// of order. Different paths are independent — that is the whole of rule 2.
		if (running) {
			// Not a no-op even when the bytes are unchanged: this is also how `abandoning` is undone by
			// a caller that wants the path back, which `lets a commit take back a path that was
			// abandoned mid-write` asserts.
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
		// ⚠ **`this.#state` at call time, never the `next` computed above** (ticket 09, review 3).
		// Handing each listener the value derived before the loop began made this the sixth way out
		// of this class, and the only one a sweep for *where control leaves* could not find, because
		// nothing about the seam moved — a value did. A listener that reacts by editing runs a nested
		// `#publish` that advances `#state` correctly; the outer loop then resumed and told every
		// listener it had not yet reached the **pre-edit** state. The last thing such a subscriber
		// heard was `saved`, with bytes pending.
		//
		// This is the shape {@link subscribe} has always used, eleven lines up. A listener may now be
		// told the same state twice, which is right: saying a true thing again is not a defect, and
		// saying a stale one is.
		for (const listener of this.#listeners) this.#tell(() => listener(this.#state));
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
