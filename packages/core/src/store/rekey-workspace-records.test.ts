import { beforeEach, expect, it } from 'vitest';

import { rekeyWorkspaceRecords, type WorkspaceRecordStores } from './rekey-workspace-records.js';
import { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import { FakeMetadataStorage } from '../remote/fake-metadata-storage.js';
import { localChangeKey } from '../remote/local-change-index.js';
import { baselineKey, remoteRelationshipKey } from '../remote/synchronization-metadata.js';
import {
	EVERY_RECORD,
	NO_RECORDS,
	fillWorkspaceRecords,
	workspaceRecordsOf
} from './workspace-records-fixture.js';

const OLD = 'folder:maps';
const NEW = 'folder:workspace:31ff0e0c-6a2f-4f0e-9f1a-2c0c2b7f5c11';
let journal: FakeJournalStorage;
let metadata: FakeMetadataStorage;
const fillWorkspace = (key: string) => fillWorkspaceRecords(journal, metadata, key);
const familiesOf = (key: string) => workspaceRecordsOf(journal, metadata, key);

beforeEach(() => {
	journal = new FakeJournalStorage();
	metadata = new FakeMetadataStorage();
});

const rekey = (
	commit = () => Promise.resolve(true),
	stores: WorkspaceRecordStores = { journalStorage: journal, metadataStorage: metadata }
): Promise<boolean> => rekeyWorkspaceRecords({ from: OLD, to: NEW, ...stores, commit });

it('moves every family of records to the new key, and leaves none behind at the old one', async () => {
	await fillWorkspace(OLD);

	const moved = await rekey();
	expect(moved).toBe(true);
	expect(await familiesOf(NEW)).toEqual(EVERY_RECORD);
	expect(await familiesOf(OLD)).toEqual(NO_RECORDS);
});

it('touches no other Workspace’s records', async () => {
	await fillWorkspace(OLD);
	await fillWorkspace('opfs:Marking 2026');

	await rekey();

	expect(await familiesOf('opfs:Marking 2026')).toEqual(EVERY_RECORD);
});

it('claims the new identity before it removes anything from the old key', async () => {
	await fillWorkspace(OLD);
	let atCommit: Record<string, unknown> = {};

	await rekey(async () => {
		atCommit = await familiesOf(OLD);
		return true;
	});

	expect(atCommit).toEqual(EVERY_RECORD);
});

it('leaves the old records readable when a durable record will not be written', async () => {
	await fillWorkspace(OLD);
	metadata.refuseWrites.add(baselineKey(NEW));

	const moved = await rekey();
	expect(moved).toBe(false);
	expect(await familiesOf(OLD)).toEqual(EVERY_RECORD);
});

it('leaves nothing of a refused migration at the new key', async () => {
	await fillWorkspace(OLD);
	metadata.refuseWrites.add(baselineKey(NEW));

	await rekey();

	expect(await familiesOf(NEW)).toEqual(NO_RECORDS);
	expect(await metadata.keys()).not.toContain(remoteRelationshipKey(NEW));
	expect(await metadata.keys()).not.toContain(localChangeKey(NEW));
});

it('leaves the old records readable when the journal is full', async () => {
	await fillWorkspace(OLD);
	journal.setItem = () => {
		throw new Error('QuotaExceededError');
	};

	const moved = await rekey();
	expect(moved).toBe(false);
	expect(await familiesOf(OLD)).toEqual(EVERY_RECORD);
});

it('leaves the old records readable when the new identity cannot be kept', async () => {
	await fillWorkspace(OLD);

	const moved = await rekey(() => Promise.resolve(false));
	expect(moved).toBe(false);
	expect(await familiesOf(OLD)).toEqual(EVERY_RECORD);
	expect(await familiesOf(NEW)).toEqual(NO_RECORDS);
});

it('is a Workspace with nothing to move when there is nothing under the old key', async () => {
	const moved = await rekey();
	expect(moved).toBe(true);
	expect(await familiesOf(NEW)).toEqual(NO_RECORDS);
});

it('keeps the new identity where the browser holds no durable records at all', async () => {
	const moved = await rekey(undefined, { journalStorage: null, metadataStorage: null });
	expect(moved).toBe(true);
});
