// Moving every durable record of one Workspace to a new key — all of them, or none (ADR-0042).
//
// Five families hang off a Workspace key: the write-ahead journal and its held copies, interrupted
// deletions, the publish manifest, the Remote relationship with its Synchronization Baseline, and
// the local-change index. Nothing rekeyed them before, because nothing needed to: a Workspace's key
// was its name and its name did not move. A folder Workspace is now keyed by a minted reference, so
// the one folder a pre-plural installation could have has records under `folder:<folderName>` that
// have to arrive under `folder:<reference>` exactly once.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY IT IS ALL OR NONE
//
// The families are evidence about each other. A Baseline is this installation's claim that the
// Remote it names already holds these bytes; a publish manifest is what this machine last saw
// there; the change index is what has happened since. Moved apart, they describe a Workspace that
// never existed: a binding with no Baseline reads as `Cannot tell` — survivable — but a Baseline
// whose binding stayed behind is a claim about a repository the Workspace is no longer bound to,
// and a change index without its Baseline reports an author's own unpublished work as the Remote's.
//
// A lost Remote binding is recoverable: the author binds again and the next Publish establishes
// evidence. A half-moved one is not, because nothing in the result says which half is missing. So
// every failure here leaves the records where they were and answers `false`, and the caller goes on
// using the old key until the next visit tries again.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// COPY, CLAIM, REMOVE — AND WHY THE CLAIM IS IN THE MIDDLE
//
// The new key is only an identity once something durable names it: for a folder Workspace, its
// record in the installation database. If the records moved first and that record could not be
// written, they would sit under a reference nothing can ever ask for. If the record were written
// first and the copy then failed, the Workspace would be identified by a key with nothing under it
// while its journal sat at the old one, unreachable.
//
// So {@link RekeyWorkspaceRecords.commit} runs between the copy and the removal, with both keys
// answering. A tab that dies in that window leaves duplicates and loses nothing: if the claim
// landed, the old records are junk the next migration will not look at; if it did not, the next
// visit mints a reference and copies again.

import { DELETED_KEY_PREFIX } from '../autosave/deleted-projects.js';
import { HELD_KEY_PREFIX, JOURNAL_KEY_PREFIX, type JournalStorage } from '../autosave/journal.js';
import {
	keysWithPrefix,
	parseWorkspaceScopedKey,
	workspaceScopedKey
} from '../autosave/workspace-scoped-key.js';
import { localChangeKey } from '../remote/local-change-index.js';
import { publishManifestKey } from '../remote/publish-manifest.js';
import {
	baselineKey,
	remoteRelationshipKey,
	type MetadataStorage
} from '../remote/synchronization-metadata.js';

/** Where a Workspace's durable records are kept, either of which a browser may not have. */
export interface WorkspaceRecordStores {
	readonly journalStorage: JournalStorage | null;
	readonly metadataStorage: MetadataStorage | null;
}

export interface RekeyWorkspaceRecords extends WorkspaceRecordStores {
	readonly from: string;
	readonly to: string;
	/**
	 * Make `to` the Workspace's identity, once every record is readable under it and before any is
	 * removed from `from`.
	 *
	 * `false` — or a throw — is a claim that did not stick, and rolls the copy back. See the header
	 * for why this is not simply done first or last.
	 */
	readonly commit: () => Promise<boolean>;
}

/** One record on its way from one key to the other. */
interface Move<T> {
	readonly from: string;
	readonly to: string;
	readonly value: T;
}

/**
 * Re-key one Workspace's durable records, and answer whether it happened.
 *
 * `false` leaves every record readable under `from`, which is the state the caller was already in.
 */
export async function rekeyWorkspaceRecords(options: RekeyWorkspaceRecords): Promise<boolean> {
	const { from, to, journalStorage, metadataStorage, commit } = options;
	const local = journalStorage === null ? [] : localMoves(journalStorage, from, to);
	const durable = metadataStorage === null ? [] : await durableMoves(metadataStorage, from, to);

	const copiedLocally: string[] = [];
	const copiedDurably: string[] = [];
	try {
		for (const move of local) {
			journalStorage?.setItem(move.to, move.value);
			copiedLocally.push(move.to);
		}
		for (const move of durable) {
			await metadataStorage?.put(move.to, move.value);
			copiedDurably.push(move.to);
		}
		if (!(await commit())) throw new Error('The new Workspace identity was not kept.');
	} catch {
		for (const key of copiedLocally) forgetLocal(journalStorage, key);
		for (const key of copiedDurably) await forgetDurable(metadataStorage, key);
		return false;
	}

	for (const move of local) forgetLocal(journalStorage, move.from);
	for (const move of durable) await forgetDurable(metadataStorage, move.from);
	return true;
}

/**
 * Everything in `localStorage` filed under `from`, and the key it takes under `to`.
 *
 * The three families that live here are keyed two ways — the journal, its held copies and the
 * deletion records name a subject inside the Workspace, and the publish manifest is one record for
 * the whole of it — so the shapes are read through the same helpers that write them rather than
 * rebuilt by hand here.
 */
function localMoves(storage: JournalStorage, from: string, to: string): Move<string>[] {
	const moves: Move<string>[] = [];
	for (const prefix of [JOURNAL_KEY_PREFIX, HELD_KEY_PREFIX, DELETED_KEY_PREFIX]) {
		for (const key of keysWithPrefix(storage, prefix)) {
			const named = parseWorkspaceScopedKey(prefix, key);
			if (named === null || named.workspace !== from) continue;
			const value = storage.getItem(key);
			if (value === null) continue;
			moves.push({ from: key, to: workspaceScopedKey(prefix, to, named.subject), value });
		}
	}
	const manifest = storage.getItem(publishManifestKey(from));
	if (manifest !== null) {
		moves.push({
			from: publishManifestKey(from),
			to: publishManifestKey(to),
			value: manifest
		});
	}
	return moves;
}

/** The three records the installation database holds for a Workspace, where each one exists. */
async function durableMoves(
	storage: MetadataStorage,
	from: string,
	to: string
): Promise<Move<unknown>[]> {
	const moves: Move<unknown>[] = [];
	for (const keyOf of [remoteRelationshipKey, baselineKey, localChangeKey]) {
		const value = await storage.get(keyOf(from));
		if (value === null || value === undefined) continue;
		moves.push({ from: keyOf(from), to: keyOf(to), value });
	}
	return moves;
}

// Both removals are best effort on their own, and neither can turn a completed move into a failure:
// a record that will not go is a duplicate under a key nothing asks for any more.

function forgetLocal(storage: JournalStorage | null, key: string): void {
	try {
		storage?.removeItem(key);
	} catch {
		// A storage that refuses a delete. See above.
	}
}

async function forgetDurable(storage: MetadataStorage | null, key: string): Promise<void> {
	try {
		await storage?.delete(key);
	} catch {
		// A store that refuses a delete. See above.
	}
}
