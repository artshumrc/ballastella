// Rekey is all-or-none; commit runs between copy and removal, failure keeps old key.

import { DELETED_KEY_PREFIX } from '../autosave/deleted-projects.js';
import { HELD_KEY_PREFIX, JOURNAL_KEY_PREFIX, type JournalStorage } from '../autosave/journal.js';
import {
	keysNamed,
	parseWorkspaceScopedKey,
	removeQuietly,
	workspaceScopedKey
} from '../autosave/workspace-scoped-key.js';
import { localChangeKey } from '../remote/local-change-index.js';
import {
	baselineKey,
	remoteRelationshipKey,
	type MetadataStorage
} from '../remote/synchronization-metadata.js';

export interface WorkspaceRecordStores {
	readonly journalStorage: JournalStorage | null;
	readonly metadataStorage: MetadataStorage | null;
}

interface Move<T> {
	readonly from: string;
	readonly to: string;
	readonly value: T;
}

export async function rekeyWorkspaceRecords(
	options: WorkspaceRecordStores & {
		readonly from: string;
		readonly to: string;
		readonly commit: () => Promise<boolean>;
	}
): Promise<boolean> {
	const { from, to, journalStorage, metadataStorage, commit } = options;
	const local = journalStorage === null ? [] : localMoves(journalStorage, from, to);
	const durable = metadataStorage === null ? [] : await durableMoves(metadataStorage, from, to);
	const forgetLocal = (key: string) => journalStorage && removeQuietly(journalStorage, key);
	const forgetDurable = (key: string) => metadataStorage?.delete(key).catch(() => undefined);
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
		copiedLocally.forEach(forgetLocal);
		for (const key of copiedDurably) await forgetDurable(key);
		return false;
	}

	for (const move of local) forgetLocal(move.from);
	for (const move of durable) await forgetDurable(move.from);
	return true;
}

function localMoves(storage: JournalStorage, from: string, to: string): Move<string>[] {
	const moves: Move<string>[] = [];
	for (const prefix of [JOURNAL_KEY_PREFIX, HELD_KEY_PREFIX, DELETED_KEY_PREFIX]) {
		const named = keysNamed(storage, prefix, (key) => parseWorkspaceScopedKey(prefix, key));
		for (const { key, workspace, subject } of named) {
			if (workspace !== from) continue;
			const value = storage.getItem(key);
			if (value === null) continue;
			moves.push({ from: key, to: workspaceScopedKey(prefix, to, subject), value });
		}
	}
	return moves;
}

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
