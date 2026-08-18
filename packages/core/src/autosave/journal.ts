// The synchronous write-ahead journal that makes ADR-0017 rule 3 true (ticket 20).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, AND WHY IT IS NOT A SECOND ProjectStore
//
// ADR-0017 rule 3 said a pending write is flushed on `visibilitychange` → hidden and on `pagehide`.
// Measured in a real browser on 2026-08-07, that rule is false for the case it was written for.
//
// **The measurement lives in ADR-0017, "Rule 3, amended", and is deliberately not copied here.** It
// was transcribed into four files, which is four things that can drift from the run that produced
// them; the ADR is its one home and this is a pointer to it.
//
// The event fires and the flush is fast. The edit is lost anyway, because `ProjectStore.write` is
// **asynchronous** and a document that is being unloaded does not run the continuation. Rule 3 is
// not a race the user sometimes loses; for a real navigation it is never won. Only something
// synchronous survives, and in a browser the only synchronous durable write available to a page is
// `localStorage`.
//
// So the bytes of an edit are written *ahead* of the store write, synchronously, and removed once
// the store has them. That is the whole idea, and it is worth being exact about what it is not:
//
//   - **Not a store.** Nothing reads a Project out of here. It holds only what the ProjectStore has
//     *not* taken — an entry goes the moment its write lands — so in ordinary use it is empty
//     between one keystroke and the next. It is **not guaranteed** empty, and saying otherwise
//     would hide unbounded growth: an entry whose write failed is kept on purpose, and one
//     belonging to a Workspace nobody reopens persists until the user says otherwise, which is what
//     `journalledWorkspaces` and `discardJournal` are for.
//   - **Not a backup.** ADR-0024's tar is the backup. This holds no history, no other Workspace's
//     work, and nothing that has already been written.
//   - **Not durable.** Clearing site data, a private window closing, or a browser evicting the
//     origin takes it. `navigator.storage.persist()` (ADR-0024) covers it along with everything
//     else, and a refusal there is already reported in Workspace settings.
//
// ADR-0001 makes the ProjectStore the one home for user bytes, and this is a real exception to it.
// It is recorded in ADR-0001 rather than left for a future reader to discover.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WRITTEN AT THE EDIT, NOT AT `pagehide` — WHICH IS THE ONLY PLACE THE QUOTA CAN BE REPORTED
//
// The obvious shape is "on `pagehide`, write everything pending". It works, and it cannot tell the
// user anything: `localStorage` is roughly 5 MB per origin, an Annotation collection can exceed
// that on its own, and the moment a `QuotaExceededError` would be raised is the moment the page is
// being torn down. There is no screen left to put a message on and no reader left to read it.
//
// So the journal is maintained **continuously**: every {@link Autosave} `queue` and `commit`
// records synchronously, and every successful store write forgets. The entry is therefore already
// on disk when `pagehide` arrives, `Autosave.capture` at that moment is a belt-and-braces re-record
// rather than the only chance, and a quota refusal happens while the user is still looking at the
// app and can be told about it in words (SPEC stories 111 and 112).
//
// The cost, in full, because this is the paragraph whose job is to hold it:
//
//   * one synchronous `setItem` per keystroke on a debounced field. That is the same order as the
//     `JSON.stringify` of the whole collection which that keystroke already performs before reaching
//     `Autosave` at all, so it is a proportionate cost rather than a new category of one;
//   * one `getItem` on the first `record` for a path in a `WriteAheadJournal`'s life, to derive the
//     baseline (`#baseline`). Per instance, not per session — `replayJournal` builds one per call
//     unless it is handed the session's;
//   * one `getItem` **on every `forget`**, which is to say on every successful store write, to read
//     the bytes the store just took before the entry naming them goes;
//   * roughly 24 characters per entry for `JournalEntry.held`. A fingerprint rather than a second
//     copy of the bytes, deliberately — see that field for the measurement that decided it.

import type { Bytes, StorePath } from '../store/project-store.js';
import {
	keysWithPrefix,
	parseWorkspaceScopedKey,
	workspaceScopedKey
} from './workspace-scoped-key.js';

/**
 * The shape of the journal's own records. Bumped when the *envelope* changes, never for a change
 * to the user's bytes, which the journal does not interpret at all.
 *
 * SPEC story 114: an entry from a newer version of this application is **refused and left alone**,
 * never partially read and never discarded — see {@link readJournal}. That is only possible because
 * the version lives in the value rather than in the key: a key a newer build had versioned would be
 * invisible to this one, and invisible is exactly what "silently damaged" looks like.
 *
 * **Not bumped for {@link JournalEntry.held} (ticket 07)**, which is additive and optional: a build
 * that does not know the field reads the entry exactly as it always did, and a build that does reads
 * an older entry as one with no baseline. Bumping would make every entry written here
 * `from-a-newer-version` to any earlier build — refused, kept, and reported at every startup — which
 * is a worse outcome than the one the field improves.
 *
 * The residual that choice accepts: an older build that **re-records** a path writes an envelope with
 * no `held`, so downgrading and coming back loses the baseline silently. It costs a restore, which is
 * the same direction every other imprecision in this field takes.
 */
export const JOURNAL_FORMAT_VERSION = 1;

/** Every key this module owns begins with this. Nothing else in the origin may. */
const JOURNAL_KEY_PREFIX = 'ballastella.journal.';

/**
 * Where a copy a replay **declined to apply** is kept, out of reach of the live journal.
 *
 * ⚠ **A second namespace, because "kept" was not kept.** `replayJournal` used to keep such a copy by
 * leaving the ordinary entry in place, and an ordinary entry is addressed by path alone: the very
 * next edit to that file overwrote it, silently, which is SPEC story 6 — *"my next keystroke does not
 * silently destroy it"* — verbatim. That is not the same as an ordinary supersede, and the difference
 * is the whole reason this exists: journal entries hold whole-file snapshots, so entry `v2` replacing
 * entry `v1` loses nothing, `v2` being the later state of the same document. A declined copy is not
 * an earlier state of what the scholar is now editing — it is a *divergent* one, made against
 * something the store no longer holds, and the edit that replaces it is on a different branch.
 *
 * Keyed by path **and fingerprint**, so divergent copies of one file can both be held — up to
 * {@link HELD_COPIES_PER_PATH}, which is where the room this costs is reasoned about — and so
 * {@link forgetHeldCopy} destroys the one a notice names rather than whatever is at that path now.
 */
const HELD_KEY_PREFIX = 'ballastella.held.';

/**
 * How many declined copies of **one file** may be held at once.
 *
 * ⚠ **Because these are the one thing here that keeps whole bytes indefinitely.** A journal entry is
 * transient by construction — it goes the moment the store takes it — and {@link JournalEntry.held}
 * is a fingerprint precisely so that nothing doubles the footprint of the live journal. A declined
 * copy is neither: it is a full copy of a file, and it stays until a scholar answers a question. The
 * trade is worth making, because it is the only copy of a divergent edit that reached no store; it is
 * not worth making without end.
 *
 * Three, and the reasoning rather than the number is the point: a scholar who has been asked three
 * times about one file and answered none of them is not using the remedy, and taking further room
 * from the origin would spend the live journal's protection — which covers every file they are
 * *currently* editing — on unanswered questions about one. Past this, {@link WriteAheadJournal.hold}
 * refuses and says so, exactly as it does when the origin is full; nothing already held is discarded
 * to make room.
 *
 * The total is therefore bounded by three per path, and by nothing else: a Workspace with many files
 * can hold many copies. That is the honest statement of the bound.
 */
export const HELD_COPIES_PER_PATH = 3;

/**
 * The two axes an entry is keyed by: **which Workspace** and **which file**.
 *
 * The Workspace half is not decoration. Since ticket 12 the OPFS root holds several named
 * Workspaces and one click on the bar switches between them, so a journal keyed by path alone would
 * replay a Project rename typed in "Marking 2026" into whichever Workspace happened to be open at
 * the next startup — the same class of failure `WorkspaceStorage.#adopt` exists to prevent for
 * queued writes, arriving by a route that outlives the tab.
 *
 * The encoding itself is `workspace-scoped-key.ts`, shared with `deleted-projects.ts` (ticket 21):
 * two hand-written copies of it are two things that can drift, and a key one module writes and the
 * other cannot read fails silently.
 */
const journalKey = (workspace: string, path: StorePath): string =>
	workspaceScopedKey(JOURNAL_KEY_PREFIX, workspace, path);

/**
 * The key one held copy lives at.
 *
 * The fingerprint goes **first** in the subject so the split below is unambiguous: it is drawn from
 * `[0-9a-z-]` and contains no `/`, while a store path contains several.
 */
const heldKey = (workspace: string, path: StorePath, fingerprint: string): string =>
	workspaceScopedKey(HELD_KEY_PREFIX, workspace, `${fingerprint}/${path}`);

/** The `{ workspace, path, fingerprint }` a held key names, or `null` if it is not one of ours. */
function parseHeldKey(
	key: string
): { workspace: string; path: StorePath; fingerprint: string } | null {
	const named = parseWorkspaceScopedKey(HELD_KEY_PREFIX, key);
	if (named === null) return null;
	const cut = named.subject.indexOf('/');
	if (cut === -1) return null;
	return {
		workspace: named.workspace,
		fingerprint: named.subject.slice(0, cut),
		path: named.subject.slice(cut + 1)
	};
}

/** The `{ workspace, path }` a key names, or `null` if it is not one this module wrote. */
function parseJournalKey(key: string): { workspace: string; path: StorePath } | null {
	const named = parseWorkspaceScopedKey(JOURNAL_KEY_PREFIX, key);
	return named === null ? null : { workspace: named.workspace, path: named.subject };
}

/**
 * What the journal needs from `localStorage`, and nothing more.
 *
 * Injectable so every branch here — including the quota refusal, which a real browser will not
 * produce on demand — is assertable in the Node suite. `Storage` satisfies it structurally.
 */
export interface JournalStorage {
	readonly length: number;
	key(index: number): string | null;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/**
 * Whoever can be told what the store held for a path, and when the telling was learned.
 *
 * A structural port rather than the class, on the precedent `AutosaveJournal` sets: `Workspace` needs
 * to *report* a read and has no business holding a journal. {@link WriteAheadJournal} satisfies it.
 *
 * ⚠ **Two calls, because one would be unordered.** A read is asynchronous and a store write can land
 * while it is in flight, so "what this read saw" is evidence about the moment the read *began*, not
 * about the moment it resolved. {@link mark} is taken before the read and handed back to
 * {@link observe}, which is what lets a stale read lose to a newer fact instead of overwriting it.
 */
export interface StoreContentObserver {
	/** A token for "now", to be handed to {@link observe} with what the read that follows returns. */
	mark(): number;
	/** What the store held at `path`, as of the moment `at` was taken. */
	observe(path: StorePath, bytes: Bytes, at: number): void;
}

/**
 * A journalled edit a replay declined to apply, kept until the scholar says what to do with it.
 *
 * Out of the live journal (see {@link HELD_KEY_PREFIX}) and addressed by {@link fingerprint}, so
 * neither a later edit nor a later notice can reach the wrong bytes.
 */
export interface HeldCopy {
	readonly workspace: string;
	readonly path: StorePath;
	readonly bytes: Bytes;
	/** When the edit was recorded, ISO 8601, carried over from the entry it was held from. */
	readonly at: string;
	/** Why the replay declined it, as `replay.ts` spells its skip reasons. */
	readonly reason: string;
	/** `fingerprintOf(bytes)`. Its identity, and what {@link forgetHeldCopy} matches on. */
	readonly fingerprint: string;
}

/**
 * The shared shape of the two ways the journal can fail to hold an edit.
 *
 * Both mean the same thing to the user — *this edit is not protected against the tab closing* — and
 * different things about what to do, which is why they are two classes and not one with a flag.
 *
 * ⚠ **These messages are shown, not logged.** They are the whole of "fail loudly and visibly", and
 * they are read by a scholar in the middle of their work: they name the file the way the
 * application names it, say what is and is not at risk, and give one action. They do not explain
 * browser storage.
 */
abstract class JournalRefusal extends Error {
	readonly path: StorePath;
	/** How many bytes the edit was. */
	readonly size: number;

	constructor(name: string, message: string, path: StorePath, size: number, cause: unknown) {
		super(message, { cause });
		this.name = name;
		this.path = path;
		this.size = size;
	}
}

/**
 * There is no room left for this edit's copy — the origin's storage is full.
 *
 * The recoverable one: the quota is shared with every other page on this origin, so it can free up
 * on its own, and the next edit is protected again the moment it does.
 */
export class JournalFullError extends JournalRefusal {
	constructor(path: StorePath, size: number, cause: unknown) {
		super(
			'JournalFullError',
			`Ballastella has run out of room to keep a copy of ${describeFile(path, size)} while ` +
				`it saves. Your edit is still being saved — what is missing is the spare copy that ` +
				`would survive closing this tab first. Wait for “Saved” before you leave this page.`,
			path,
			size,
			cause
		);
	}
}

/**
 * The browser will not store anything at all, however small.
 *
 * ⚠ **Distinct from a full quota, and the distinction is not pedantry.** Safari with cookies
 * blocked hands the page a `localStorage` object that answers a read and rejects every write, so
 * `browserJournalStorage`'s read-only probe accepts it. Reported as "no room" it sends the user to
 * clear other sites' data, which will not help and cannot help; the true remedy is a browser
 * setting, or nothing at all. Told the wrong one, they would go on believing the protection was
 * one bad afternoon away from working.
 */
export class JournalUnavailableError extends JournalRefusal {
	constructor(path: StorePath, size: number, cause: unknown) {
		super(
			'JournalUnavailableError',
			`This browser will not let Ballastella keep a copy of ${describeFile(path, size)} while ` +
				`it saves — usually because site data is blocked, as it is in a private window. Your ` +
				`edit is still being saved; it is the spare copy that is unavailable. Wait for ` +
				`“Saved” before you leave this page.`,
			path,
			size,
			cause
		);
	}
}

/**
 * Which refusal this is.
 *
 * A quota failure is a `DOMException` named `QuotaExceededError`; Safari's older builds use
 * `NS_ERROR_DOM_QUOTA_REACHED` and code 22 or 1014. Anything else — a `SecurityError`, an
 * `InvalidStateError`, a plain `TypeError` — is storage that is not working at all rather than
 * storage that is full, and the two get different messages.
 */
function refusalFor(path: StorePath, size: number, cause: unknown): JournalRefusal {
	const name = cause instanceof Error ? cause.name : '';
	const code =
		typeof (cause as { code?: unknown })?.code === 'number' ? (cause as DOMException).code : 0;
	const full =
		name === 'QuotaExceededError' ||
		name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
		code === 22 ||
		code === 1014;
	return full
		? new JournalFullError(path, size, cause)
		: new JournalUnavailableError(path, size, cause);
}

/**
 * A file as a person reading a sentence about it needs it: its own name, and a size in the units
 * they would use.
 *
 * ADR-0017 asks the refusal to name the file and its size. A raw `StorePath` and a raw byte count
 * satisfy that literally and read as a stack trace, so the Project directory and the file name are
 * separated out and the bytes are rounded to something sayable.
 */
function describeFile(path: StorePath, size: number): string {
	const segments = path.split('/');
	const name = segments[segments.length - 1] ?? path;
	const inside = segments.length > 1 ? ` in “${segments[0]}”` : '';
	return `“${name}”${inside} (${describeSize(size)})`;
}

/**
 * A byte count in the units a person reading a sentence would use.
 *
 * Exported for `replay.ts`, which describes two versions of a file to somebody choosing between
 * them: two spellings of "how big is it" in two sentences about the same journal would be one more
 * thing that can drift.
 */
export function describeSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} bytes`;
}

/** The base64 payload stored at `key`, or `null` when there is nothing usable there. */
function storedBytes(storage: JournalStorage, key: string): string | null {
	return storedField(storage, key, 'bytes');
}

/** The base64 {@link JournalEntry.held} stored at `key`, or `null` when there is none. */
function storedHeld(storage: JournalStorage, key: string): string | null {
	return storedField(storage, key, 'held');
}

function storedField(storage: JournalStorage, key: string, field: string): string | null {
	try {
		const raw = storage.getItem(key);
		if (raw === null) return null;
		const envelope = JSON.parse(raw) as Record<string, unknown>;
		const value = envelope[field];
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}

/**
 * Sixteen hex digits of FNV-1a over the bytes, run twice from different offset bases, with the byte
 * length in front of them.
 *
 * The same construction — and the same reasoning — as `base-map/tile-cache.ts`'s `fingerprint`:
 * nothing here is a security boundary, and `crypto.subtle` is asynchronous, which would make
 * {@link WriteAheadJournal.record} into a promise and break the one contract that module has. Two
 * rounds because one is four billion buckets, and the length in front because the cheapest
 * disagreement to detect is a file that grew.
 *
 * ⚠ **Two rounds, and they are *not* independent — measured, not assumed.** Both are FNV-1a with the
 * same prime over the same bytes, differing only in their basis, so the difference between the two
 * running values is not free: the low bits of that difference are forced to agree at every length
 * tried. A collision in the first round therefore leaves about 30 free bits in the second rather than
 * 32 — call it 2^62 for an accidental pair of equal length, not 2^64. Still far past what a scholar's
 * Workspace can reach by accident, and stated at its real strength rather than at its nominal one.
 *
 * ⚠ **What a collision would cost.** {@link JournalEntry.held} is compared for equality against the
 * store's current content; two different files that fingerprint alike are read as "unchanged since
 * the edit" and `replay.ts` writes over the newer one. That is the defect this field exists to
 * prevent, arriving by a much narrower door: it needs a collision *and* an equal byte length *and*
 * the collision to be with the one earlier version of that same file. The inputs are a scholar's own
 * documents rather than an attacker's, and this design does not defend against a chosen-collision
 * attack — that is the honest limit, and full bytes is what it would cost to remove it. See
 * {@link JournalEntry.held} for why that price was judged too high.
 */
export function fingerprintOf(bytes: Bytes): string {
	const round = (basis: number): string => {
		let hash = basis;
		for (const byte of bytes) {
			hash ^= byte;
			// `Math.imul` keeps the multiply in 32 bits; `>>> 0` keeps the result unsigned.
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, '0');
	};
	return `${bytes.length.toString(36)}-${round(0x811c9dc5)}${round(0x9dc5811c)}`;
}

/** One file's bytes, waiting for a store write that has not landed. */
export interface JournalEntry {
	readonly workspace: string;
	readonly path: StorePath;
	readonly bytes: Bytes;
	/** When it was recorded, ISO 8601. Reported to the user; nothing branches on it. */
	readonly at: string;
	/**
	 * What the store held at the moment this entry was recorded, or `null` when the journal had no
	 * way to know (ticket 07).
	 *
	 * **This is the entry's precondition, and it is what stops a replay reverting newer bytes.** An
	 * entry means "the store has not taken these bytes"; it does not say what the store *has* taken
	 * since, and `replayJournal` used to write regardless — so a Workspace tar restored, a bundle
	 * opened or a pyramid ingested after the edit was put back to the older bytes and the revert was
	 * reported as a restoration. With this, replay can ask whether the store still holds what this
	 * entry was written against. See `replay.ts` for the decision it drives.
	 *
	 * ⚠ **Two sources, and only one of them used to exist.** The journal is synchronous by contract
	 * and the store is not, so nothing here can read the store; the value is what the journal has been
	 * *told* — see {@link WriteAheadJournal.#baseline}. {@link forget} is one teller, and on its own a
	 * poor one: `Autosave` calls it only after a store write has **succeeded**, so a path had no
	 * baseline until some write to it had landed, which left the case this whole design exists for —
	 * a store whose writes are failing, with a healthy journal — as the case with none.
	 *
	 * {@link observe} is the other, and it is what makes the guarantee useful: `EditorSession` reports
	 * every file it reads, and a file cannot be edited before it has been shown. So `null` now means
	 * *nothing has read this path* — an entry from an older build, or a file never opened in the
	 * session that wrote it — and `replay.ts` answers it by asking the scholar rather than guessing.
	 * `replay.test.ts` pins the shape, `journal.test.ts` pins the derivation, and
	 * `editor-session.test.ts` drives the read that supplies it.
	 *
	 * ⚠ **A {@link fingerprintOf} of those bytes, never the bytes.** An earlier draft stored the
	 * base64, which **doubled every entry's `localStorage` footprint** — measured at 40 062 characters
	 * against 80 072 for a 30 kB payload. ADR-0017 already says an Annotation collection can exceed
	 * the ~5 MB origin budget on its own, and a refusal there is a user-visible loss of protection, so
	 * halving the headroom to hold a second copy of bytes nothing ever reads back is the wrong trade.
	 * Every row of `replay.ts`'s decision needs only *equality* against what the store holds now, and
	 * a fingerprint answers that in 18 characters for an empty file, 20 at 30 kB and 22 at 5 MB — it
	 * grows with the *digits* of the length and nothing else.
	 */
	readonly held: string | null;
}

/**
 * An entry that exists and cannot be replayed, which is a thing to say out loud rather than a thing
 * to drop.
 *
 * Ticket 13 shipped a restore that counted a *declined* write as a restored one, and review caught
 * it. The lesson generalises past that one counter: everything the journal did not write has to be
 * reachable and nameable, which is what this type is for.
 */
export interface JournalProblem {
	/** The raw storage key, so a report can name something a person could go and look at. */
	readonly key: string;
	readonly reason: JournalProblemReason;
	/** One sentence, written for the user rather than for a log. */
	readonly detail: string;
	/** Whether the entry is still there. `false` means this report is the only trace of it. */
	readonly kept: boolean;
}

export type JournalProblemReason =
	/** The envelope did not parse, or held no usable bytes. Nothing is recoverable from it. */
	| 'unreadable'
	/** Written by a newer version of this application (SPEC story 114). Left strictly alone. */
	| 'from-a-newer-version';

/**
 * The write-ahead journal for **one** Workspace.
 *
 * Bound to a Workspace at construction rather than taking one per call, because the object that
 * owns it — an `EditorSession` — is itself replaced rather than repointed when the user switches
 * Workspace, for exactly the reason `WorkspaceStorage.#adopt` gives: bytes belong to the Workspace
 * they were typed into. A journal that took a Workspace argument would be one argument away from
 * writing an edit into somebody else's work.
 */
export class WriteAheadJournal {
	readonly #storage: JournalStorage;
	readonly #workspace: string;
	/**
	 * The base64 this journal believes the store holds for a path, which is the baseline the next
	 * {@link record} writes as {@link JournalEntry.held}. `null` is a cached "asked, and there is
	 * none", so a path with no baseline does not re-read storage on every keystroke.
	 *
	 * In memory rather than on disk because the *entry* carries it across a restart: a baseline is
	 * only ever needed at the moment an entry is written, and an entry that already exists carries
	 * its own — see {@link #baseline}.
	 */
	readonly #held = new Map<StorePath, string | null>();
	/**
	 * When each memo entry's evidence was obtained, against {@link #clock}.
	 *
	 * ⚠ **Without this a read that started before a write could undo it.** `observe` is fed by reads
	 * that are already in flight when an edit is saved: `readLayerFeatures` and `readAnnotations` name
	 * the same file, so a redraw overlapping a debounced `writeAnnotations` is the ordinary shape, not
	 * a corner. The stale read then filed the *previous* content as the baseline, and the next
	 * stranded edit was refused with "that file has been changed since" — false, and in exactly the
	 * case the journal exists for.
	 */
	readonly #heldAt = new Map<StorePath, number>();
	/** Monotonic, and only ever compared with itself. Not a time. */
	#clock = 0;

	constructor(storage: JournalStorage, workspace: string) {
		this.#storage = storage;
		this.#workspace = workspace;
	}

	/** The Workspace this journal writes for. */
	get workspace(): string {
		return this.#workspace;
	}

	/**
	 * Put `bytes` in the journal for `path`, **synchronously**. The whole point of the module.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ⚠ A REFUSAL NEVER REMOVES WHAT IS ALREADY THERE — AND AN EARLIER DRAFT OF THIS DID
	 *
	 * That earlier draft argued that an older entry is worse than none, because replaying it would
	 * hand the user a state they passed through rather than the one they stopped at. Review found
	 * two cases where the argument is simply false, and both are the moment the journal matters most:
	 *
	 *   1. **The bytes are often identical.** `Autosave.capture` re-records every pending file on
	 *      `pagehide`. If the quota filled in between — another tab, another origin — `setItem`
	 *      throws on bytes that are *the same bytes already stored*, and removing then destroys a
	 *      complete, valid rescue copy at the exact instant it is needed.
	 *   2. **It assumed the store write would still happen.** It will not, precisely when it matters:
	 *      an entry is only still here because the store has *not* taken these bytes, and the
	 *      commonest reason for that is a write that failed. Removing then leaves nothing anywhere.
	 *
	 * So nothing here ever removes on failure. What is stored is always bytes the store has not
	 * taken — {@link forget} runs the moment it has — so replaying it can only move the file toward
	 * a state the user reached, never away from one already saved; and every replay is *named to the
	 * user*, so an older state coming back is visible rather than silent. Nothing is truncated to
	 * make room and nothing is dropped quietly.
	 *
	 * The entry also carries {@link JournalEntry.held} when {@link #baseline} can derive one — the
	 * store content this edit was made against, which is what lets replay tell a stranded write from
	 * a revert (ticket 07).
	 *
	 * @throws JournalFullError when the browser is out of room for this file
	 * @throws JournalUnavailableError when the browser refuses to store anything at all
	 */
	record(path: StorePath, bytes: Bytes): void {
		const key = journalKey(this.#workspace, path);
		const encoded = encodeBytes(bytes);
		const held = this.#baseline(key, path);
		const value = JSON.stringify({
			formatVersion: JOURNAL_FORMAT_VERSION,
			at: new Date().toISOString(),
			...(held === null ? {} : { held }),
			bytes: encoded
		});
		try {
			this.#storage.setItem(key, value);
		} catch (cause) {
			// **The entry that is already there is left exactly where it is.** See the note above.
			//
			// The one thing still worth deciding here is whether to *report* a refusal, and the answer
			// is no when what is already stored is byte-for-byte these bytes. That is not a corner: it
			// is what `Autosave.capture` does on every `pagehide`, re-recording bytes that have not
			// changed since the edit. Reporting then would say a file was unprotected while its rescue
			// copy sat on disk, complete.
			//
			// The read happens only on the failure path, so the ordinary keystroke pays nothing for it.
			if (storedBytes(this.#storage, key) === encoded) return;
			throw refusalFor(path, bytes.length, cause);
		}
	}

	/**
	 * The {@link JournalEntry.held} to write for the next entry at `key`, or `null` for none.
	 *
	 * Two sources, and neither reads the store — this is on the synchronous path of every keystroke:
	 *
	 *   1. **{@link #held}, the memo**, seeded by {@link forget} with what the store took. It is
	 *      consulted *first* and therefore **shadows** the stored entry rather than merely filling in
	 *      for it, which is the half a "two sources, in order" reading misses: after
	 *      {@link forgetUnder} removes an entry, the memo is the only source left, which is why that
	 *      method prunes it.
	 *   2. **The entry already at `key`**, on a memo miss, so a baseline survives a restart.
	 *
	 * ⚠ **Source 2 rests on an inference that `superseded` broke, which is why {@link observe}
	 * exists.** The inference is: an entry exists only while the store has *not* taken its bytes, so
	 * what it was recorded against is still what the store holds. Every skip reason used to drop its
	 * entry, so that held. `'superseded'` keeps one — and keeps it *precisely because something else
	 * wrote the path*, which makes that entry's baseline, by construction, what the store no longer
	 * holds. Carried forward, it refuses the next edit to that path, and the next, until some write
	 * finally succeeds: one refusal turning into a standing one. `replayJournal` closes it by calling
	 * {@link observe} with what it actually read, which lands in the memo and shadows source 2.
	 *
	 * The memo is per instance and pruned only by {@link forgetUnder}, so it holds one short string
	 * per path touched in this instance's life. `replayJournal` takes the session's instance where it
	 * is given one, precisely so that what it observed outlives the call.
	 *
	 * ⚠ **This is derived, so it can be wrong.** `forget` is not only called on success:
	 * `Autosave.abandon` calls it for bytes the store never took, when the user deletes the Project
	 * or Map Image they belong to. A later edit to the same path is then recorded against a
	 * baseline that was never on disk.
	 *
	 * ⚠ **What a wrong baseline costs, per event and in aggregate.** `replay.ts` reads this field on
	 * exactly one line — the `superseded` line of `compare` — and only to *refuse* a write, so
	 * nothing here can turn a refusal into a write. Per event that costs a restore rather than an
	 * edit. In aggregate it can cost *every* restore for that path, because a refusal keeps the entry
	 * that carries the wrong baseline; that is the loop `observe` breaks, and `replay.test.ts` drives
	 * two sessions to prove it. **"Never an edit" is still false in one channel**, and it is the
	 * other operand: equality cannot tell "untouched since the edit" from "changed and changed back",
	 * so a path restored from a backup to exactly its old content is written over. `replay.ts` states
	 * that beside the row it belongs to.
	 */
	#baseline(key: string, path: StorePath): string | null {
		const remembered = this.#held.get(path);
		if (remembered !== undefined) return remembered;
		const carried = storedHeld(this.#storage, key);
		this.#held.set(path, carried);
		return carried;
	}

	/**
	 * Drop `path`'s entry **because the store has taken its bytes**. Idempotent.
	 *
	 * The bytes are read before the removal and remembered as the baseline, because the entry is the
	 * only record of what the store just took. That is what makes this different from
	 * {@link discard}, and callers have to mean one or the other.
	 */
	forget(path: StorePath): void {
		const key = journalKey(this.#workspace, path);
		// ⚠ **The entry is the only record of what the store just took — *given a guard in another
		// module*.** `Autosave.#drainLoop` forgets only inside `if (file.pending === bytes)`, so the
		// entry still holds the bytes that landed; without that guard an edit typed during the write
		// would already have replaced them and this would file the wrong content. Stated because it is
		// a cross-module dependency this class cannot see, and `autosave.ts` is where it lives.
		const taken = storedBytes(this.#storage, key);
		const bytes = taken === null ? null : decodeBytes(taken);
		// A payload that will not decode says nothing about what the store holds. Filing a fingerprint
		// of zero bytes would say the store holds an empty file, which is a fact nobody established.
		if (bytes !== null) this.#remember(path, fingerprintOf(bytes));
		this.#remove(key);
	}

	/**
	 * Drop `path`'s entry **without concluding anything about the store**. Idempotent.
	 *
	 * ⚠ **The distinction is not bookkeeping.** {@link forget} means "the store has these bytes", and
	 * it is the only thing that ever writes a baseline. A replay dropping an entry whose owner has
	 * gone has learned the opposite — those bytes reached no store and never will — and using
	 * `forget` there would file them as what the store holds, poisoning the baseline of any later
	 * edit to that path.
	 */
	discard(path: StorePath): void {
		this.#remove(journalKey(this.#workspace, path));
	}

	/** A token for "now", to be handed back to {@link observe}. See {@link StoreContentObserver}. */
	mark(): number {
		this.#clock += 1;
		return this.#clock;
	}

	/**
	 * Tell this journal what the store held for `path`, from a read that began at `at`.
	 *
	 * **Older evidence loses.** A read resolving after a write has landed — or after another read that
	 * started later — is describing a store that has moved on, and filing it would refuse the next
	 * stranded edit with a sentence that is not true.
	 */
	observe(path: StorePath, bytes: Bytes, at: number): void {
		if (at <= (this.#heldAt.get(path) ?? 0)) return;
		this.#remember(path, fingerprintOf(bytes), at);
	}

	/**
	 * Put a copy a replay declined to apply out of the live journal's reach, and drop the entry.
	 *
	 * See {@link HELD_KEY_PREFIX} for why this is a second namespace rather than "leave the entry
	 * where it is": an entry is addressed by path, so the next edit to that file overwrote it.
	 *
	 * ⚠ **`null` means nothing was set aside, and the caller must say so.** Two things refuse: the
	 * origin being out of room, and {@link HELD_COPIES_PER_PATH} already being reached. An earlier
	 * draft returned the fingerprint either way, so a report said *"It has been kept"* beside a
	 * **Throw this copy away** button when nothing had been kept and there was nothing to throw —
	 * the exact shape of failure this epic exists to end, inside the fix for it.
	 *
	 * On a refusal the journal entry is left exactly where it is, which is the same direction
	 * `record` takes for the same reason: a refusal must never be the thing that destroys the bytes
	 * it failed to protect. It is offered again at the next startup.
	 *
	 * @returns the copy's {@link HeldCopy.fingerprint}, or `null` if nothing was set aside
	 */
	hold(path: StorePath, bytes: Bytes, at: string, reason: string): string | null {
		const fingerprint = fingerprintOf(bytes);
		const key = heldKey(this.#workspace, path, fingerprint);
		// Re-holding a copy that is already there is not a new one, so it does not count against the
		// cap — that is the ordinary case of a startup meeting a decline it has already made.
		if (this.#storage.getItem(key) === null && this.#atCapacity(path)) return null;
		try {
			this.#storage.setItem(
				key,
				JSON.stringify({
					formatVersion: JOURNAL_FORMAT_VERSION,
					at,
					reason,
					bytes: encodeBytes(bytes)
				})
			);
		} catch {
			return null;
		}
		this.#remove(journalKey(this.#workspace, path));
		return fingerprint;
	}

	/** Whether `path` already holds as many declined copies as it is allowed. */
	#atCapacity(path: StorePath): boolean {
		let held = 0;
		for (const key of keysWithPrefix(this.#storage, HELD_KEY_PREFIX)) {
			const named = parseHeldKey(key);
			if (named && named.workspace === this.#workspace && named.path === path) held += 1;
		}
		return held >= HELD_COPIES_PER_PATH;
	}

	#remember(path: StorePath, fingerprint: string, at?: number): void {
		this.#held.set(path, fingerprint);
		this.#heldAt.set(path, at ?? this.mark());
	}

	#remove(key: string): void {
		try {
			this.#storage.removeItem(key);
		} catch {
			// Nothing a caller can do about a storage that refuses a delete, and the caller is the
			// success path of a write. A stale entry is caught at replay by the preconditions there.
		}
	}

	/**
	 * Drop every entry for a path starting with `prefix`. **The counterpart to a deletion.**
	 *
	 * `ProjectStore.delete` does not go through `Autosave`, so deleting a Project leaves any
	 * journalled write of its files behind — and the next startup would put a file back inside a
	 * directory the user deleted. Replay's own precondition catches the ordinary case, but it
	 * cannot catch a *new* Project created under the same directory name afterwards, which would
	 * look exactly like the old one still being there. So the deletion says so at the time.
	 *
	 * ⚠ **The memo goes with the entries, and it has to go first.** {@link #baseline} consults
	 * {@link #held} *before* the stored entry, so removing the entry and leaving the memo would make
	 * the memo the only surviving source — and it would be describing a Project the user has just
	 * deleted. A new Project created under the same directory name writes the same fixed
	 * `project.json` path, so its first edit would be recorded against the deleted Project's bytes
	 * and its rescue refused. Safe direction, and still wrong.
	 *
	 * @returns how many entries were dropped
	 */
	forgetUnder(prefix: string): number {
		for (const path of [...this.#held.keys()]) {
			if (!path.startsWith(prefix)) continue;
			this.#held.delete(path);
			this.#heldAt.delete(path);
		}
		let dropped = 0;
		for (const key of keysWithPrefix(this.#storage, JOURNAL_KEY_PREFIX)) {
			const named = parseJournalKey(key);
			if (!named || named.workspace !== this.#workspace) continue;
			if (!named.path.startsWith(prefix)) continue;
			try {
				this.#storage.removeItem(key);
				dropped += 1;
			} catch {
				// Best effort. Replay's preconditions are the second line for exactly this.
			}
		}
		// ⚠ **And the held copies, or a deletion leaves the loudest thing behind.** A copy a replay
		// declined is reported at every startup until somebody acts on it; one belonging to a Project
		// the user has just deleted would be a recurring notice about a file that no longer exists,
		// with an offered remedy that does nothing they care about. Counted with the entries because
		// what the caller wants to know is "how much of this Project's unsaved work went".
		for (const key of keysWithPrefix(this.#storage, HELD_KEY_PREFIX)) {
			const named = parseHeldKey(key);
			if (!named || named.workspace !== this.#workspace) continue;
			if (!named.path.startsWith(prefix)) continue;
			try {
				this.#storage.removeItem(key);
				dropped += 1;
			} catch {
				// Best effort, as above.
			}
		}
		return dropped;
	}
}

/** What one Workspace's journal holds, and everything in it that cannot be used. */
export interface JournalContents {
	readonly entries: readonly JournalEntry[];
	readonly problems: readonly JournalProblem[];
}

/**
 * Read one Workspace's entries, separating what can be replayed from what cannot.
 *
 * **Two lists rather than a filtered one.** An entry that is unreadable or from a newer build is
 * not "no entry"; it is a file the user edited whose bytes this build will not put back, and the
 * user has to be able to find out that happened. Every caller renders both.
 *
 * The two problems are treated differently on purpose:
 *
 *   - **`from-a-newer-version` is kept.** SPEC story 114 is that a newer format is refused with an
 *     explanation rather than partially loaded, and the entry may still be perfectly replayable by
 *     the build that wrote it. Discarding it would turn "refused" into "silently damaged".
 *   - **`unreadable` is discarded**, and reported with the key that held it. There is nothing
 *     recoverable in an envelope that does not parse, and keeping it would make the notice
 *     permanent — a warning the user can never clear is one they stop reading.
 */
export function readJournal(storage: JournalStorage, workspace: string): JournalContents {
	const entries: JournalEntry[] = [];
	const problems: JournalProblem[] = [];

	for (const key of keysWithPrefix(storage, JOURNAL_KEY_PREFIX)) {
		const named = parseJournalKey(key);
		if (named === null) {
			problems.push(discard(storage, key, 'unreadable', 'Its name could not be read.'));
			continue;
		}
		if (named.workspace !== workspace) continue;

		const raw = storage.getItem(key);
		if (raw === null) continue;

		let envelope: unknown;
		try {
			envelope = JSON.parse(raw);
		} catch {
			problems.push(
				discard(
					storage,
					key,
					'unreadable',
					`The saved copy of “${named.path}” is damaged and has been discarded. ` +
						`Nothing in your Workspace has been changed.`
				)
			);
			continue;
		}

		const record = envelope as {
			formatVersion?: unknown;
			at?: unknown;
			bytes?: unknown;
			held?: unknown;
		};
		if (typeof record.formatVersion !== 'number' || !Number.isInteger(record.formatVersion)) {
			problems.push(
				discard(
					storage,
					key,
					'unreadable',
					`The saved copy of “${named.path}” does not say what version wrote it and has ` +
						`been discarded. Nothing in your Workspace has been changed.`
				)
			);
			continue;
		}
		if (record.formatVersion > JOURNAL_FORMAT_VERSION) {
			// Kept, deliberately, and not counted as an entry. ADR-0010's forward-only rule in the
			// small: this build cannot know what a later envelope means, so it says so and leaves it.
			problems.push({
				key,
				reason: 'from-a-newer-version',
				kept: true,
				detail:
					`An unsaved change to “${named.path}” was set aside by a newer version of ` +
					`Ballastella (format ${record.formatVersion}; this copy reads ` +
					`${JOURNAL_FORMAT_VERSION}). It has been left exactly as it is rather than ` +
					`restored. Update your copy of Ballastella to recover it.`
			});
			continue;
		}

		const bytes = typeof record.bytes === 'string' ? decodeBytes(record.bytes) : null;
		if (bytes === null) {
			problems.push(
				discard(
					storage,
					key,
					'unreadable',
					`The saved copy of “${named.path}” could not be decoded and has been discarded. ` +
						`Nothing in your Workspace has been changed.`
				)
			);
			continue;
		}

		entries.push({
			workspace: named.workspace,
			path: named.path,
			bytes,
			at: typeof record.at === 'string' ? record.at : '',
			// A baseline that is absent, or present and not decodable, is the same thing to the caller:
			// no precondition. It is deliberately **not** a `JournalProblem` — the entry's own bytes are
			// intact and replaying them is what this build did before the field existed, so refusing the
			// entry over its baseline would cost the user an edit to save a check.
			held: typeof record.held === 'string' && record.held !== '' ? record.held : null
		});
	}

	// Sorted so a replay, and a report of one, is the same on every browser. `localStorage`
	// enumeration order is not specified, and a report whose lines move between visits is one a
	// user has to read from scratch every time.
	entries.sort((a, b) => a.path.localeCompare(b.path));
	problems.sort((a, b) => a.key.localeCompare(b.key));
	return { entries, problems };
}

/** What the held namespace holds for one Workspace, and everything in it that cannot be used. */
export interface HeldContents {
	readonly copies: readonly HeldCopy[];
	readonly problems: readonly JournalProblem[];
}

/**
 * Every copy a replay declined to apply, for one Workspace, sorted for a stable report.
 *
 * Read separately from {@link readJournal} because these are **not** pending writes: nothing is
 * waiting to put them in the store, and a startup that treated them as entries would apply the very
 * bytes a previous startup refused.
 */
export function readHeldCopies(storage: JournalStorage, workspace: string): HeldContents {
	const copies: HeldCopy[] = [];
	const problems: JournalProblem[] = [];
	for (const key of keysWithPrefix(storage, HELD_KEY_PREFIX)) {
		const named = parseHeldKey(key);
		if (named === null || named.workspace !== workspace) continue;
		const raw = storage.getItem(key);
		if (raw === null) continue;
		// ⚠ **Reported and discarded, not skipped past** — the same treatment `readJournal` gives an
		// unreadable entry, and for a sharper reason. A copy that will not parse still occupies the
		// origin's quota and still counts against {@link HELD_COPIES_PER_PATH}, so swallowing it left
		// room spent on bytes nobody could ever recover, invisibly, with no exit short of discarding
		// the whole Workspace's journal.
		let envelope: { bytes?: unknown; at?: unknown; reason?: unknown };
		try {
			envelope = JSON.parse(raw) as typeof envelope;
		} catch {
			problems.push(
				discard(
					storage,
					key,
					'unreadable',
					`A kept copy of “${named.path}” is damaged and has been discarded. Nothing in your ` +
						`Workspace has been changed.`
				)
			);
			continue;
		}
		const bytes = typeof envelope.bytes === 'string' ? decodeBytes(envelope.bytes) : null;
		if (bytes === null) {
			problems.push(
				discard(
					storage,
					key,
					'unreadable',
					`A kept copy of “${named.path}” could not be decoded and has been discarded. ` +
						`Nothing in your Workspace has been changed.`
				)
			);
			continue;
		}
		copies.push({
			workspace,
			path: named.path,
			bytes,
			at: typeof envelope.at === 'string' ? envelope.at : '',
			reason: typeof envelope.reason === 'string' ? envelope.reason : '',
			fingerprint: named.fingerprint
		});
	}
	copies.sort((a, b) => a.path.localeCompare(b.path) || a.fingerprint.localeCompare(b.fingerprint));
	problems.sort((a, b) => a.key.localeCompare(b.key));
	return { copies, problems };
}

/**
 * Throw away one held copy, **named by its fingerprint as well as its path**.
 *
 * ⚠ **The fingerprint is the whole point of this signature.** The notice offering this is built at
 * startup and never expires, so it can be acted on after arbitrary later work; keyed on the path
 * alone it destroyed whatever was at that path *then*, while the sentence beside the button
 * described a different, older version and said the copy had been kept.
 *
 * @returns whether there was one to throw away
 */
export function forgetHeldCopy(
	storage: JournalStorage,
	workspace: string,
	path: StorePath,
	fingerprint: string
): boolean {
	const key = heldKey(workspace, path, fingerprint);
	if (storage.getItem(key) === null) return false;
	try {
		storage.removeItem(key);
		return true;
	} catch {
		return false;
	}
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO FUNCTIONS BELOW SEE EVERY WORKSPACE, AND THE CLASS ABOVE DELIBERATELY SEES ONE
//
// `WriteAheadJournal`'s whole safety argument is that it is bound to one Workspace at construction,
// so no call can put an edit into somebody else's work. Sitting free functions that range over all
// of them in the same module reads, at a glance, as that guarantee being softer than it is — which
// review flagged, and it is a fair reading.
//
// They stay, and here, for a reason the class cannot serve: the question they answer is *"which
// Workspaces does this browser hold entries for, including ones no `WriteAheadJournal` will ever be
// constructed for"*. That is exactly the orphan case — a Workspace that has been deleted, or a
// folder never reopened — and an instance bound to a Workspace is structurally unable to ask it.
//
// What keeps them from weakening the guarantee is that **neither can write an entry**. One lists
// names; the other deletes wholesale, from a user's explicit gesture in Workspace settings. There is
// no path here that puts bytes at a key, which is the only operation the binding exists to fence.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every Workspace name the journal holds an entry for.
 *
 * So that an entry naming a Workspace that no longer exists can be **reported** rather than sitting
 * in storage for ever, invisible: replay only ever looks at the Workspace being opened, so nothing
 * else would ever meet it.
 */
export function journalledWorkspaces(storage: JournalStorage): string[] {
	const names = new Set<string>();
	for (const key of keysWithPrefix(storage, JOURNAL_KEY_PREFIX)) {
		const named = parseJournalKey(key);
		if (named) names.add(named.workspace);
	}
	// Held copies count: a Workspace nobody reopens can hold nothing *but* those, and one invisible
	// to this list is one whose storage the user is never offered a way to reclaim.
	for (const key of keysWithPrefix(storage, HELD_KEY_PREFIX)) {
		const named = parseHeldKey(key);
		if (named) names.add(named.workspace);
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Throw away every entry for one Workspace, and answer how many there were.
 *
 * The counterpart to deleting a Workspace, and the action offered beside the report of an orphaned
 * one. Deliberately not called automatically for a Workspace that is merely missing from
 * `listOpfsWorkspaces`: a folder Workspace is not in that list at all, and neither is one on a
 * drive that is unplugged today.
 */
export function discardJournal(storage: JournalStorage, workspace: string): number {
	let dropped = 0;
	for (const key of keysWithPrefix(storage, JOURNAL_KEY_PREFIX)) {
		const named = parseJournalKey(key);
		if (!named || named.workspace !== workspace) continue;
		try {
			storage.removeItem(key);
			dropped += 1;
		} catch {
			// Best effort; the count reports what actually went.
		}
	}
	// The held copies with them: this is the user asking for a Workspace's unsaved remains to be
	// thrown away, and a copy left behind would go on being reported with nothing left to act on.
	for (const key of keysWithPrefix(storage, HELD_KEY_PREFIX)) {
		const named = parseHeldKey(key);
		if (!named || named.workspace !== workspace) continue;
		try {
			storage.removeItem(key);
			dropped += 1;
		} catch {
			// Best effort, as above.
		}
	}
	return dropped;
}

/**
 * `localStorage` if this browser has a usable one, otherwise `null`.
 *
 * `null` rather than a throw, and rather than a no-op stand-in: a private window with storage
 * disabled is a browser where this protection **is not available**, and a silent stub would make
 * the app claim a guarantee it does not have. The caller reports the absence.
 */
export function browserJournalStorage(): JournalStorage | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		// ⚠ **Read, never write.** Safari with cookies blocked has the object and throws from every
		// property of it, so it does have to be touched rather than assumed — but the obvious probe,
		// a `setItem` and a `removeItem` of a scratch key, is a **write at startup**, and ADR-0010 is
		// that merely opening a Project modifies nothing. `editor-opening-view.e2e.ts` counts web
		// storage writes and caught exactly that; it left the key behind nowhere, and it was still a
		// write the user never asked for, on every load, before anything had been edited.
		//
		// Reading `length` is enough for the question being asked, which is "will this object answer
		// at all". Whether it will accept a *particular* payload is a quota question, and that one
		// cannot be answered in advance — it is answered by `JournalFullError` at the moment it
		// happens, which is why that error is written for a reader rather than for a log.
		void localStorage.length;
		return localStorage;
	} catch {
		return null;
	}
}

function discard(
	storage: JournalStorage,
	key: string,
	reason: JournalProblemReason,
	detail: string
): JournalProblem {
	let kept = true;
	try {
		storage.removeItem(key);
		kept = false;
	} catch {
		// Reported as kept, which is then the truth rather than the intention.
	}
	return { key, reason, detail, kept };
}

/**
 * How many bytes are turned into characters at a time.
 *
 * `String.fromCharCode(...chunk)` spreads its argument onto the call stack, so the whole array at
 * once overflows it somewhere in the low hundreds of thousands of elements — on an Annotation
 * collection, which is exactly the payload this module exists to carry.
 */
const ENCODE_CHUNK = 0x8000;

/**
 * Bytes as base64.
 *
 * Base64 rather than a latin-1 string, which would be a third smaller in `localStorage`'s UTF-16
 * pairs. The saving is not worth an encoding whose round trip depends on how an implementation
 * treats code points that are not characters; the quota this costs is reported honestly when it
 * runs out, which is the property that actually matters here.
 */
function encodeBytes(bytes: Bytes): string {
	let binary = '';
	for (let at = 0; at < bytes.length; at += ENCODE_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(at, at + ENCODE_CHUNK));
	}
	return btoa(binary);
}

/** Base64 back to bytes, or `null` for anything that is not base64. */
function decodeBytes(value: string): Bytes | null {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length) as Bytes;
	for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at) & 0xff;
	return bytes;
}
