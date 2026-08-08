// Which Projects the user deleted, written synchronously so the answer survives the page (ticket 21).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: A DELETION IS AS ASYNCHRONOUS AS AN EDIT, AND NOBODY HAD NOTICED
//
// Ticket 20 measured that `ProjectStore.write` cannot finish while a document is being unloaded, and
// built the write-ahead journal so an *edit* survives a real navigation. `Workspace.deleteProject`
// is the same shape and had none of that protection: it lists the Project's files, deletes them one
// by one, and reclaims the abandoned writes — several awaits deep, against OPFS.
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
// ticket 20's whole subject.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS RECORDED IS THE GESTURE, NOT A GUESS ABOUT THE FILES
//
// The discrimination this makes available is **"the user deleted this Project"**, which the
// application knows for certain because it is the thing the user just did. It is deliberately *not*
// "this Project's files are not there right now", which is a guess — and the guess is the shape of
// the two data-loss paths ticket 20's first cut opened, where an empty listing was read as proof a
// file was gone. `replay.ts` keeps its "unreadable is not absent" rule exactly as it was; this adds
// the one fact that rule could never derive.
//
// So there is nothing here but a set of Project directory names, per Workspace, and the two moments
// it changes:
//
//   - **{@link DeletedProjects.record}** at the start of a deletion, synchronously, before the first
//     `await`. `localStorage` is the only synchronous durable write a page has (ADR-0017, "Rule 3,
//     amended"), which is the same reason ticket 20 chose it.
//   - **{@link DeletedProjects.forget}** when the removal has finished, and — the case that keeps
//     this from becoming a data-loss path of its own — when a *new* Project claims that directory
//     name, before a single byte of it is written.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS NOT
//
//   - **Not a trash can.** It holds no bytes and nothing can be recovered from it. Deleting a
//     Project is not undoable (ADR-0014 covers four other actions), and this does not change that.
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
 * journal. A deletion record living there would be counted as an unsaved edit in the Workspace
 * settings screen and discarded by the button that offers to throw those away.
 */
const DELETED_KEY_PREFIX = 'ballastella.deleted.';

/**
 * The Projects deleted from **one** Workspace whose removal may not have finished.
 *
 * Bound to a Workspace at construction for the reason {@link WriteAheadJournal} is: since ticket 12
 * the OPFS root holds several named Workspaces and one click switches between them, so a record
 * keyed by directory alone would let a deletion performed in "Marking 2026" be finished against a
 * same-named Project in whichever Workspace happened to be open next. A class that took a Workspace
 * per call would be one argument away from deleting somebody else's work.
 */
export class DeletedProjects {
	readonly #storage: JournalStorage;
	readonly #workspace: string;

	constructor(storage: JournalStorage, workspace: string) {
		this.#storage = storage;
		this.#workspace = workspace;
	}

	/** The Workspace these records belong to. */
	get workspace(): string {
		return this.#workspace;
	}

	/**
	 * Note that the user has deleted `directory`, **synchronously**. The whole point of the module.
	 *
	 * @returns whether the note is durable. `false` means this browser will not store it — a private
	 *   window with site data blocked — and the deletion is back to being only as durable as the page
	 *   is, which is what it was before this module existed. Answered rather than swallowed so the
	 *   loss of the guarantee is a thing a test can assert and a caller could report; nothing is
	 *   thrown, because a browser that will not hold a note must not stop a user deleting a Project.
	 */
	record(directory: string): boolean {
		try {
			this.#storage.setItem(this.#key(directory), new Date().toISOString());
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

	/** Every Project directory in this Workspace whose deletion may be unfinished, sorted. */
	pending(): string[] {
		const directories: string[] = [];
		for (const key of keysWithPrefix(this.#storage, DELETED_KEY_PREFIX)) {
			const named = parseWorkspaceScopedKey(DELETED_KEY_PREFIX, key);
			if (!named || named.workspace !== this.#workspace) continue;
			directories.push(named.subject);
		}
		// Sorted so a startup does the same work in the same order on every browser, for the same
		// reason `readJournal` sorts: `localStorage` enumeration order is not specified.
		return directories.sort((a, b) => a.localeCompare(b));
	}

	#key(directory: string): string {
		return workspaceScopedKey(DELETED_KEY_PREFIX, this.#workspace, directory);
	}
}
