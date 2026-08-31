// Which Projects the user deleted, written synchronously so the answer survives the page.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: A DELETION IS AS ASYNCHRONOUS AS AN EDIT, AND NOBODY HAD NOTICED
//
// ADR-0017's "Rule 3, amended" measures that `ProjectStore.write` cannot finish while a document is
// being unloaded, and the write-ahead journal (`journal.ts`) is what makes an *edit* survive a real
// navigation. `Workspace.deleteProject` is the same shape and has none of that protection of its
// own: it lists the Project's files, deletes them one by one, and reclaims the abandoned writes —
// several awaits deep, against OPFS.
//
// **Measured on 2026-08-08**, `--repeat-each=20` on the regression this closes: in 4 runs of 20 the
// deletion had not got past its **first** `await` — the `list` — before the next navigation tore the
// document down. Nothing had been removed, so a Project the user had deleted, and watched go, was
// still on disk at the next startup and back on the hub. Twenty percent.
//
// The tempting reading is that the write-ahead journal replayed the deleted Project's `project.json`
// back. It does not: the journal is empty by then, and the entry the replay put back is the one the
// user had *just typed*, correctly, before deleting. What comes back is the file the deletion never
// removed. The distinction matters, because weakening the journal would have fixed nothing and cost
// the journal its whole subject.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS RECORDED IS THE GESTURE, AND THE PROJECT IT WAS AIMED AT
//
// The discrimination this makes available is **"the user deleted this Project"**, which the
// application knows for certain because it is the thing the user just did. It is deliberately *not*
// "this Project's files are not there right now", which is a guess — and the guess is the shape of
// the data-loss paths that open when an empty listing is read as proof a file was gone. `replay.ts`
// holds the "unreadable is not absent" rule; this adds the one fact that rule could never derive.
//
// ⚠ **A folder name alone is not enough to destroy anything on, and the first cut of this module
// recorded nothing else.** A Workspace key is `folder:<folder name>` for a picked directory, because
// the browser offers a page no stable identifier for one, and ADR-0017 records the collision that
// follows: two folders called `maps`, on two drives, share a key. ADR-0017 also *bounds* it — a
// wrong-Workspace **replay** can only write into a Project whose `project.json` is already there, so
// its worst case is one overwritten file the user is told about. A wrong-Workspace **deletion** has
// no such bound: it would list a directory and remove every byte in it.
//
// ⚠ **And {@link DeletionRecord.was} is not the answer to that, which the second cut of this module
// said it was.** It claimed that carrying the Project's display name and `updatedAt` left "a bound of
// the same shape as replay's: an unfinished deletion can only be finished against a Project that is
// byte-for-byte the one the user deleted". That sentence is true and it is the hole — **a copy IS
// byte-for-byte the one the user deleted.** Dropbox, Drive, rsync, `cp -a` and a zip all reproduce
// `project.json` exactly, and ADR-0010 guarantees that opening a Project writes nothing, so the copy
// stays identical; every field of the record matches a backup of the very Project that was deleted.
// No further field fixes that, because the thing being asked is *identity* and the evidence being
// offered is *content*.
//
// So identity comes from the **key**, and it is asked for once: see `WorkspaceIdentity` in
// `project/workspace.ts`. `opfs:<name>` names one directory this origin owns; `folder:<name>` names
// a name a user can put on any folder on any drive, and there a deletion is **reported rather than
// finished** — the Project stays listed, the user is told its deletion did not finish, and deleting
// it again is one gesture.
//
// What `was` is for, once identity is settled, is the *other* question: has the Project changed
// since the gesture? `Workspace.#claim` fires from `createProject` and `duplicateProject` and never
// from merely opening one, so a Project reopened and edited after a failed deletion would otherwise
// be removed under the user at a later startup. That is the whole of its job, and it is a smaller
// job than this module used to claim for it.
//
// The two moments a record changes:
//
//   - **{@link DeletedProjects.record}** at the start of a deletion, synchronously, before the first
//     `await`. `localStorage` is the only synchronous durable write a page has (ADR-0017, "Rule 3,
//     amended"), which is the same reason the write-ahead journal uses it.
//   - **{@link DeletedProjects.forget}** when the removal has finished, and — the case that keeps
//     this from becoming a data-loss path of its own — when a *new* Project claims that directory
//     name, before a single byte of it is written.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS NOT
//
//   - **Not a trash can.** It holds no bytes and nothing can be recovered from it. Deleting a
//     Project is not undoable: an Edit History holds the edits made *on a screen* and Workspace Home,
//     where a Project is deleted, has none (ADR-0039). This does not change that.
//   - **Not a tombstone that outlives its Project.** A record is dropped the moment the removal it
//     names has actually happened, so in ordinary use this is empty between one gesture and the next.
//   - **Not durable.** Clearing site data takes it, exactly as it takes the write-ahead journal. What
//     is then lost is the *completion* of a deletion, which the next one repeats.

import type { JournalStorage } from './journal.js';
import {
	keysWithPrefix,
	parseWorkspaceScopedKey,
	workspaceScopedKey
} from './workspace-scoped-key.js';

/**
 * Every key this module owns begins with this. Nothing else in the origin may.
 *
 * ⚠ **Not under `ballastella.journal.`**, and not by accident: `journalledWorkspaces` and
 * `discardJournal` walk that prefix and treat everything under it as an edge of the write-ahead
 * journal. A deletion record living there would be counted as an unsaved edit on Workspace Home and
 * discarded by the button that offers to throw those away.
 */
export const DELETED_KEY_PREFIX = 'ballastella.deleted.';

/**
 * What the user was looking at when they pressed Delete, so a later startup can check that the
 * Project has not **changed** since.
 *
 * ⚠ **Not "check it is the same Project", which is what this said and could not deliver.** The two
 * fields come out of the manifest, and a manifest is copied verbatim by every sync client there is —
 * so two folders of the same name holding the same Project produce the same answer, which is the
 * case that has to be told apart and is the one this cannot tell apart. Identity is settled by the
 * Workspace key before this is consulted at all; see `WorkspaceIdentity`.
 */
export interface ProjectIdentity {
	/** The display name from `project.json`, or the directory name for a manifest that would not read. */
	readonly name: string;
	/** ISO 8601 from `project.json`, or `''`. */
	readonly updatedAt: string;
}

/**
 * One unfinished deletion: the folder it named, and what it was aimed at.
 *
 * ⚠ **No `at`.** The stored form carries one and this does not: it was decoded, put on the public
 * type, asserted in tests, and read by no production code — `finishInterruptedDeletions` neither
 * expires a record nor orders by age, and nothing renders a time. A field on a public type that
 * nothing consumes is a decision the next reader thinks was taken. The stored `at` stays, because
 * it is for whoever is looking at `localStorage` with the devtools open, which is the only thing
 * that ever read it.
 */
export interface DeletionRecord {
	/** The Project directory the user deleted. */
	readonly directory: string;
	/**
	 * The manifest identity at the moment of the gesture, or `null` when the caller did not supply
	 * one.
	 *
	 * `null` is a real state and not a default: it means **nothing may be destroyed on this record**.
	 * It still refuses a replay — that is `has()`, and putting a file back is additive — but
	 * `Workspace.finishInterruptedDeletions` will not remove a byte for it. See that method.
	 */
	readonly was: ProjectIdentity | null;
}

/** The stored shape, so a future field is an addition rather than a re-encoding. */
interface StoredRecord {
	readonly formatVersion: number;
	/** ISO 8601. Written for whoever is reading `localStorage` in the devtools; see {@link DeletionRecord}. */
	readonly at: string;
	readonly was?: ProjectIdentity;
}

/**
 * The stored shape this build writes and understands.
 *
 * ⚠ **Checked on the way in, which it was not.** The field was written and then ignored, so a record
 * from a build that spells `was` differently — the exact case the field exists to make survivable —
 * was read with this build's rules and could have licensed a removal on a misread identity.
 * `readJournal` validates its own version for the same reason; this is the destructive half of the
 * same chain and had the weaker check.
 */
const DELETION_FORMAT_VERSION = 1;

/**
 * The Projects deleted from **one** Workspace whose removal may not have finished.
 *
 * Bound to a Workspace at construction for the reason {@link WriteAheadJournal} is: the OPFS root
 * holds several named Workspaces and one click switches between them, so a record keyed by directory
 * alone would let a deletion performed in "Marking 2026" be finished against a same-named Project in
 * whichever Workspace happened to be open next. A class that took a Workspace per call would be one
 * argument away from deleting somebody else's work.
 *
 * ⚠ **The binding is necessary and not sufficient**, which the first cut of this module implied it
 * was. See the module header: a folder Workspace's key is its folder's *name*, which two folders may
 * share, so {@link DeletionRecord.was} is what actually fences the destructive half.
 */
export class DeletedProjects {
	readonly #storage: JournalStorage;
	readonly #workspace: string;

	constructor(storage: JournalStorage, workspace: string) {
		this.#storage = storage;
		this.#workspace = workspace;
	}

	/**
	 * Note that the user has deleted `directory`, **synchronously**. The whole point of the module.
	 *
	 * @param was what the Project's manifest said at the moment of the gesture, or `null` when the
	 *   caller does not know. `null` records the refusal for the replay and licenses **no** removal;
	 *   see {@link DeletionRecord.was}.
	 * @returns whether the note is durable. `false` means this browser will not store it — a private
	 *   window with site data blocked, or a Safari with cookies blocked, where reads answer and every
	 *   write rejects — and the deletion is back to being only as durable as the page is, which is
	 *   what it was before this module existed. Answered rather than swallowed so the loss of the
	 *   guarantee can be reported to the user; nothing is thrown, because a browser that will not
	 *   hold a note must not stop a user deleting a Project.
	 */
	record(directory: string, was: ProjectIdentity | null): boolean {
		const stored: StoredRecord = {
			formatVersion: DELETION_FORMAT_VERSION,
			at: new Date().toISOString(),
			...(was ? { was } : {})
		};
		try {
			this.#storage.setItem(this.#key(directory), JSON.stringify(stored));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Drop `directory`'s record. Idempotent.
	 *
	 * Called from **two** places, and the second is what keeps this module from opening a data-loss
	 * path of its own: when the removal has finished, and when a new Project claims that directory
	 * name. Without the second, a Project made under a folder name a half-finished deletion still
	 * named would be swept away at the next startup by a gesture aimed at its predecessor.
	 */
	forget(directory: string): void {
		try {
			this.#storage.removeItem(this.#key(directory));
		} catch {
			// Nothing a caller can do about a storage that refuses a delete, and every caller is on a
			// success path. A record that will not go is re-examined at the next startup, where the
			// removal it asks for is idempotent — a Project that is already gone deletes to nothing.
		}
	}

	/** Whether the user deleted `directory` and the removal is not known to have finished. */
	has(directory: string): boolean {
		try {
			return this.#storage.getItem(this.#key(directory)) !== null;
		} catch {
			// A storage that cannot be read is not an answer of "no", but it is also not evidence that
			// the user deleted anything. `false` is the direction that leaves files alone.
			return false;
		}
	}

	/**
	 * Every unfinished deletion in this Workspace, sorted by directory.
	 *
	 * Sorted so a startup does the same work in the same order on every browser, for the same reason
	 * `readJournal` sorts: `localStorage` enumeration order is not specified.
	 */
	pending(): DeletionRecord[] {
		const records: DeletionRecord[] = [];
		let keys: string[];
		try {
			keys = keysWithPrefix(this.#storage, DELETED_KEY_PREFIX);
		} catch {
			// A storage whose enumeration throws — the same locked-down browser `has` guards against.
			// An empty answer is the direction that leaves files alone.
			return [];
		}
		for (const key of keys) {
			const named = parseWorkspaceScopedKey(DELETED_KEY_PREFIX, key);
			if (!named || named.workspace !== this.#workspace) continue;
			records.push({ directory: named.subject, ...decode(this.#read(key)) });
		}
		return records.sort((a, b) => a.directory.localeCompare(b.directory));
	}

	#read(key: string): string | null {
		try {
			return this.#storage.getItem(key);
		} catch {
			return null;
		}
	}

	#key(directory: string): string {
		return workspaceScopedKey(DELETED_KEY_PREFIX, this.#workspace, directory);
	}
}

/**
 * What a stored value says, with anything unreadable answering "no evidence".
 *
 * ⚠ **Unreadable answers `was: null`, which licenses no removal** — never "no `was` field, so go
 * ahead". A value truncated by a full `localStorage`, or written by a build that is not this one, is
 * exactly the case where the safe direction is to leave the user's files where they are and say so.
 * A record whose `formatVersion` is not this build's is one of those: it is read by no rules this
 * build has, and {@link DELETION_FORMAT_VERSION} says why the check is here rather than assumed.
 */
function decode(value: string | null): { was: ProjectIdentity | null } {
	const nothing = { was: null };
	if (value === null) return nothing;
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== 'object' || parsed === null) return nothing;
		const record = parsed as Partial<StoredRecord>;
		if (record.formatVersion !== DELETION_FORMAT_VERSION) return nothing;
		const was = record.was;
		return {
			was:
				was && typeof was.name === 'string' && typeof was.updatedAt === 'string'
					? { name: was.name, updatedAt: was.updatedAt }
					: null
		};
	} catch {
		return nothing;
	}
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO FUNCTIONS BELOW SEE EVERY WORKSPACE, AND THE CLASS ABOVE DELIBERATELY SEES ONE
//
// The same split, for the same reason, as `journalledWorkspaces` and `discardJournal` — see the
// banner over those. The question here is *"which Workspaces does this browser hold deletion records
// for, including ones no `DeletedProjects` will ever be constructed for"*, and an instance bound to
// one Workspace is structurally unable to ask it. Neither writes a record.
//
// They exist because review found the asymmetry: `#removeWorkspace` discards a deleted Workspace's
// *journal* with the reason written on the spot — "if a Workspace of the same name is made later,
// entries are put back into somebody else's work under a name they happened to reuse" — and these
// keys have the same shape, the same reuse hazard, and a **destructive** rather than additive
// effect. They were swept by nothing and were invisible to the orphan report beside them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every Workspace key this browser holds an unfinished deletion for. */
export function workspacesWithDeletions(storage: JournalStorage): string[] {
	const names = new Set<string>();
	for (const key of keysWithPrefix(storage, DELETED_KEY_PREFIX)) {
		const named = parseWorkspaceScopedKey(DELETED_KEY_PREFIX, key);
		if (named) names.add(named.workspace);
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/** Throw away every unfinished deletion recorded for one Workspace, and answer how many there were. */
export function discardDeletions(storage: JournalStorage, workspace: string): number {
	let dropped = 0;
	for (const key of keysWithPrefix(storage, DELETED_KEY_PREFIX)) {
		const named = parseWorkspaceScopedKey(DELETED_KEY_PREFIX, key);
		if (!named || named.workspace !== workspace) continue;
		try {
			storage.removeItem(key);
			dropped += 1;
		} catch {
			// A storage that refuses a delete. Nothing to do and nothing lost: the record it kept is
			// re-examined at the next startup, where its own precondition governs what may happen.
		}
	}
	return dropped;
}
