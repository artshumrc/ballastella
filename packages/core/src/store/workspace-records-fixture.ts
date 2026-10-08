import { DeletedProjects } from '../autosave/deleted-projects.js';
import type { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import { WriteAheadJournal, readHeldCopies, readJournal } from '../autosave/journal.js';
import type { FakeMetadataStorage } from '../remote/fake-metadata-storage.js';
import { LocalChangeIndex } from '../remote/local-change-index.js';
import { SynchronizationMetadata } from '../remote/synchronization-metadata.js';
import type { StorePath } from './project-store.js';
import { encode } from '../test-support.js';

const REMOTE = { owner: 'ada', repository: 'atlas', branch: 'main' };
const PATH = 'amsterdam-1625/project.json' as StorePath;
const DECLINED = 'amsterdam-1625/annotations.json' as StorePath;

export const NO_RECORDS = {
	journalled: [],
	held: [],
	deletions: [],
	remote: null,
	baseline: null,
	changes: []
};

export const EVERY_RECORD = {
	journalled: [PATH],
	held: [DECLINED],
	deletions: ['rotterdam-1690'],
	remote: 'ada/atlas',
	baseline: 'c0ffee',
	changes: [DECLINED]
};

export async function fillWorkspaceRecords(
	journal: FakeJournalStorage,
	metadata: FakeMetadataStorage,
	key: string
): Promise<void> {
	new WriteAheadJournal(journal, key).record(PATH, encode('{"n":1}'));
	new WriteAheadJournal(journal, key).hold(
		DECLINED,
		encode('{"n":0}'),
		'2026-01-01T00:00:00.000Z',
		'it had been changed'
	);
	new DeletedProjects(journal, key).record('rotterdam-1690', null);
	const synchronization = new SynchronizationMetadata(metadata, key);
	await synchronization.bindRemote(REMOTE);
	await synchronization.writeBaseline({
		remote: REMOTE,
		commit: 'c0ffee',
		files: new Map([[PATH, 'blob1']])
	});
	const changes = new LocalChangeIndex(metadata, key, { flushInterval: 0 });
	await changes.mark(DECLINED, 'written');
	await changes.flush();
}

export async function workspaceRecordsOf(
	journal: FakeJournalStorage,
	metadata: FakeMetadataStorage,
	key: string
): Promise<Record<string, readonly string[] | string | null>> {
	const synchronization = new SynchronizationMetadata(metadata, key);
	const remote = await synchronization.readRemote();
	return {
		journalled: readJournal(journal, key).entries.map((entry) => entry.path),
		held: readHeldCopies(journal, key).copies.map((copy) => copy.path),
		deletions: new DeletedProjects(journal, key).pending().map((record) => record.directory),
		remote: remote === null ? null : `${remote.owner}/${remote.repository}`,
		baseline: (await synchronization.readBaseline(REMOTE))?.commit ?? null,
		changes: (await new LocalChangeIndex(metadata, key).localChanges()).written
	};
}
