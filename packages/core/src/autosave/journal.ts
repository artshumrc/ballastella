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
// The cost is one synchronous `setItem` per keystroke on a debounced field. That is the same order
// as the `JSON.stringify` of the whole collection which that keystroke already performs before
// reaching `Autosave` at all, so it is a proportionate cost rather than a new category of one — but
// it is a real cost and this is where it is written down.

import type { Bytes, StorePath } from '../store/project-store.js';

/**
 * The shape of the journal's own records. Bumped when the *envelope* changes, never for a change
 * to the user's bytes, which the journal does not interpret at all.
 *
 * SPEC story 114: an entry from a newer version of this application is **refused and left alone**,
 * never partially read and never discarded — see {@link readJournal}. That is only possible because
 * the version lives in the value rather than in the key: a key a newer build had versioned would be
 * invisible to this one, and invisible is exactly what "silently damaged" looks like.
 */
export const JOURNAL_FORMAT_VERSION = 1;

/** Every key this module owns begins with this. Nothing else in the origin may. */
const JOURNAL_KEY_PREFIX = 'ballastella.journal.';

/**
 * The two axes an entry is keyed by: **which Workspace** and **which file**.
 *
 * The Workspace half is not decoration. Since ticket 12 the OPFS root holds several named
 * Workspaces and one click on the bar switches between them, so a journal keyed by path alone would
 * replay a Project rename typed in "Marking 2026" into whichever Workspace happened to be open at
 * the next startup — the same class of failure `WorkspaceStorage.#adopt` exists to prevent for
 * queued writes, arriving by a route that outlives the tab.
 *
 * `encodeURIComponent` on both halves, and it is what makes the key unambiguous rather than merely
 * tidy: a Workspace name is arbitrary user text in any script (`toWorkspaceName` keeps letters,
 * marks, numbers, spaces, `(`, `)`, `_` and `-`), a store path contains `/`, and concatenating the
 * two raw would let a Workspace called `a/b` and a Workspace called `a` holding `b/…` produce the
 * same key. Encoding escapes `/` in both, so the single unescaped `/` below is the only separator.
 */
const journalKey = (workspace: string, path: StorePath): string =>
	`${JOURNAL_KEY_PREFIX}${encodeURIComponent(workspace)}/${encodeURIComponent(path)}`;

/** The `{ workspace, path }` a key names, or `null` if it is not one this module wrote. */
function parseJournalKey(key: string): { workspace: string; path: StorePath } | null {
	if (!key.startsWith(JOURNAL_KEY_PREFIX)) return null;
	const body = key.slice(JOURNAL_KEY_PREFIX.length);
	const cut = body.indexOf('/');
	if (cut === -1) return null;
	try {
		return {
			workspace: decodeURIComponent(body.slice(0, cut)),
			path: decodeURIComponent(body.slice(cut + 1))
		};
	} catch {
		// A malformed `%` escape. Someone else's key under our prefix, or a truncated one; either
		// way it names no Workspace and no file, so it is a problem to report rather than an entry.
		return null;
	}
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

function describeSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} bytes`;
}

/** The base64 payload stored at `key`, or `null` when there is nothing usable there. */
function storedBytes(storage: JournalStorage, key: string): string | null {
	try {
		const raw = storage.getItem(key);
		if (raw === null) return null;
		const held = JSON.parse(raw) as { bytes?: unknown };
		return typeof held.bytes === 'string' ? held.bytes : null;
	} catch {
		return null;
	}
}

/** One file's bytes, waiting for a store write that has not landed. */
export interface JournalEntry {
	readonly workspace: string;
	readonly path: StorePath;
	readonly bytes: Bytes;
	/** When it was recorded, ISO 8601. Reported to the user; nothing branches on it. */
	readonly at: string;
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
	 * @throws JournalFullError when the browser is out of room for this file
	 * @throws JournalUnavailableError when the browser refuses to store anything at all
	 */
	record(path: StorePath, bytes: Bytes): void {
		const key = journalKey(this.#workspace, path);
		const encoded = encodeBytes(bytes);
		const value = JSON.stringify({
			formatVersion: JOURNAL_FORMAT_VERSION,
			at: new Date().toISOString(),
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

	/** Drop `path`'s entry. Called the moment the store has the bytes; idempotent. */
	forget(path: StorePath): void {
		try {
			this.#storage.removeItem(journalKey(this.#workspace, path));
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
	 * @returns how many entries were dropped
	 */
	forgetUnder(prefix: string): number {
		let dropped = 0;
		for (const key of journalKeys(this.#storage)) {
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

	for (const key of journalKeys(storage)) {
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

		const record = envelope as { formatVersion?: unknown; at?: unknown; bytes?: unknown };
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
			at: typeof record.at === 'string' ? record.at : ''
		});
	}

	// Sorted so a replay, and a report of one, is the same on every browser. `localStorage`
	// enumeration order is not specified, and a report whose lines move between visits is one a
	// user has to read from scratch every time.
	entries.sort((a, b) => a.path.localeCompare(b.path));
	problems.sort((a, b) => a.key.localeCompare(b.key));
	return { entries, problems };
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
	for (const key of journalKeys(storage)) {
		const named = parseJournalKey(key);
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
	for (const key of journalKeys(storage)) {
		const named = parseJournalKey(key);
		if (!named || named.workspace !== workspace) continue;
		try {
			storage.removeItem(key);
			dropped += 1;
		} catch {
			// Best effort; the count reports what actually went.
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

/** Every key currently in `storage`, snapshotted so removals during a walk cannot skip one. */
function journalKeys(storage: JournalStorage): string[] {
	const keys: string[] = [];
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (key !== null && key.startsWith(JOURNAL_KEY_PREFIX)) keys.push(key);
	}
	return keys;
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
