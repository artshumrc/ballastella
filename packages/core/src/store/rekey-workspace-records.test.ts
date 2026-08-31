// Moving one Workspace's durable records to another key, and what an interruption leaves behind.

import { beforeEach, expect, it } from 'vitest';

import { rekeyWorkspaceRecords } from './rekey-workspace-records.js';
import { DeletedProjects } from '../autosave/deleted-projects.js';
import { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import { WriteAheadJournal, readHeldCopies, readJournal } from '../autosave/journal.js';
import { FakeMetadataStorage } from '../remote/fake-metadata-storage.js';
import { LocalChangeIndex, localChangeKey } from '../remote/local-change-index.js';
import { PublishManifests, publishManifestKey } from '../remote/publish-manifest.js';
import {
	SynchronizationMetadata,
	baselineKey,
	remoteRelationshipKey
} from '../remote/synchronization-metadata.js';
import type { StorePath } from './project-store.js';

// The two keys of the migration this exists for: the one folder a pre-plural installation could
// have, keyed by its directory's name, and the same folder keyed by the reference minted for it.
const OLD = 'folder:maps';
const NEW = 'folder:workspace:31ff0e0c-6a2f-4f0e-9f1a-2c0c2b7f5c11';

const REMOTE = { owner: 'ada', repository: 'atlas', branch: 'main' };
const PATH = 'amsterdam-1625/project.json' as StorePath;
// A declined copy is kept out of the live journal, so the two families need two paths to both hold
// something at once.
const DECLINED = 'amsterdam-1625/annotations.json' as StorePath;

let journal: FakeJournalStorage;
let metadata: FakeMetadataStorage;

/** All five families, with something of the user's in each, under one Workspace key. */
async function fillWorkspace(key: string): Promise<void> {
	new WriteAheadJournal(journal, key).record(PATH, new TextEncoder().encode('{"n":1}'));
	new WriteAheadJournal(journal, key).hold(
		DECLINED,
		new TextEncoder().encode('{"n":0}'),
		'2026-01-01T00:00:00.000Z',
		'it had been changed'
	);
	new DeletedProjects(journal, key).record('rotterdam-1690', null);
	new PublishManifests(journal, key).write({
		remote: REMOTE,
		commit: 'c0ffee',
		files: new Map([['amsterdam-1625/project.json', 'blob1']])
	});
	const synchronization = new SynchronizationMetadata(metadata, key);
	await synchronization.bindRemote(REMOTE);
	await synchronization.writeBaseline({
		remote: REMOTE,
		commit: 'c0ffee',
		files: new Map([['amsterdam-1625/project.json', 'blob1']])
	});
	const changes = new LocalChangeIndex(metadata, key, { flushInterval: 0 });
	await changes.mark('amsterdam-1625/annotations.json', 'written');
	await changes.flush();
}

/** What each of the five families answers for a Workspace key, read the way the app reads them. */
async function familiesOf(
	key: string
): Promise<Record<string, readonly string[] | string | null | number>> {
	const synchronization = new SynchronizationMetadata(metadata, key);
	const remote = await synchronization.readRemote();
	return {
		journalled: readJournal(journal, key).entries.map((entry) => entry.path),
		held: readHeldCopies(journal, key).copies.map((copy) => copy.path),
		deletions: new DeletedProjects(journal, key).pending().map((record) => record.directory),
		manifest: new PublishManifests(journal, key).read(REMOTE)?.commit ?? null,
		remote: remote === null ? null : `${remote.owner}/${remote.repository}`,
		baseline: (await synchronization.readBaseline(REMOTE))?.commit ?? null,
		changes: (await new LocalChangeIndex(metadata, key).localChanges()).written
	};
}

const nothing = {
	journalled: [],
	held: [],
	deletions: [],
	manifest: null,
	remote: null,
	baseline: null,
	changes: []
};

const everything = {
	journalled: [PATH],
	held: [DECLINED],
	deletions: ['rotterdam-1690'],
	manifest: 'c0ffee',
	remote: 'ada/atlas',
	baseline: 'c0ffee',
	changes: ['amsterdam-1625/annotations.json']
};

beforeEach(() => {
	journal = new FakeJournalStorage();
	metadata = new FakeMetadataStorage();
});

it('moves every family of records to the new key, and leaves none behind at the old one', async () => {
	await fillWorkspace(OLD);

	const moved = await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: journal,
		metadataStorage: metadata,
		commit: () => Promise.resolve(true)
	});

	expect(moved).toBe(true);
	expect(await familiesOf(NEW)).toEqual(everything);
	expect(await familiesOf(OLD)).toEqual(nothing);
});

it('touches no other Workspace’s records', async () => {
	await fillWorkspace(OLD);
	await fillWorkspace('opfs:Marking 2026');

	await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: journal,
		metadataStorage: metadata,
		commit: () => Promise.resolve(true)
	});

	expect(await familiesOf('opfs:Marking 2026')).toEqual(everything);
});

it('claims the new identity before it removes anything from the old key', async () => {
	await fillWorkspace(OLD);
	let atCommit: Record<string, unknown> = {};

	await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: journal,
		metadataStorage: metadata,
		commit: async () => {
			atCommit = await familiesOf(OLD);
			return true;
		}
	});

	// A crash at exactly this moment loses nothing: both keys answer, and the next visit reads the
	// old key again because no record names the new one.
	expect(atCommit).toEqual(everything);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A migration that cannot finish leaves the old records where they are. A lost Remote binding is
// recoverable — the author binds again — and a half-moved one is not.

it('leaves the old records readable when a durable record will not be written', async () => {
	await fillWorkspace(OLD);
	metadata.refuseWrites.add(baselineKey(NEW));

	const moved = await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: journal,
		metadataStorage: metadata,
		commit: () => Promise.resolve(true)
	});

	expect(moved).toBe(false);
	expect(await familiesOf(OLD)).toEqual(everything);
});

it('leaves nothing of a refused migration at the new key', async () => {
	await fillWorkspace(OLD);
	metadata.refuseWrites.add(baselineKey(NEW));

	await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: journal,
		metadataStorage: metadata,
		commit: () => Promise.resolve(true)
	});

	// Not merely unread: gone. A half-written record under a reference this installation is about to
	// mint again would be somebody's Remote binding waiting for the next Workspace to take it.
	expect(await familiesOf(NEW)).toEqual(nothing);
	expect(await metadata.keys()).not.toContain(remoteRelationshipKey(NEW));
	expect(await metadata.keys()).not.toContain(localChangeKey(NEW));
	expect(journal.items.has(publishManifestKey(NEW))).toBe(false);
});

it('leaves the old records readable when the journal is full', async () => {
	await fillWorkspace(OLD);
	journal.setItem = () => {
		throw new Error('QuotaExceededError');
	};

	const moved = await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: journal,
		metadataStorage: metadata,
		commit: () => Promise.resolve(true)
	});

	expect(moved).toBe(false);
	expect(await familiesOf(OLD)).toEqual(everything);
});

it('leaves the old records readable when the new identity cannot be kept', async () => {
	await fillWorkspace(OLD);

	// The Workspace record itself is what `commit` writes. Without it nothing names the new key, so
	// records moved there would be reachable by nothing at all.
	const moved = await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: journal,
		metadataStorage: metadata,
		commit: () => Promise.resolve(false)
	});

	expect(moved).toBe(false);
	expect(await familiesOf(OLD)).toEqual(everything);
	expect(await familiesOf(NEW)).toEqual(nothing);
});

it('is a Workspace with nothing to move when there is nothing under the old key', async () => {
	const moved = await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: journal,
		metadataStorage: metadata,
		commit: () => Promise.resolve(true)
	});

	expect(moved).toBe(true);
	expect(await familiesOf(NEW)).toEqual(nothing);
});

it('keeps the new identity where the browser holds no durable records at all', async () => {
	const moved = await rekeyWorkspaceRecords({
		from: OLD,
		to: NEW,
		journalStorage: null,
		metadataStorage: null,
		commit: () => Promise.resolve(true)
	});

	expect(moved).toBe(true);
});
