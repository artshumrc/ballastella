import { describe, expect, it } from 'vitest';

import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { ATLAS } from './remote-test-support.js';
import {
	SYNCHRONIZATION_FORMAT_VERSION,
	SynchronizationMetadata,
	baselineKey,
	discardSynchronizationMetadata,
	remoteRelationshipKey
} from './synchronization-metadata.js';

const WORKSPACE = 'opfs:Marking 2026';
const OTHER = 'opfs:My Workspace';
const FOLDER = 'folder:Marking 2026';
const ATLAS_2 = { owner: 'ada', repository: 'atlas-2', branch: 'main' };
const ATLAS_DRAFT = { owner: 'ada', repository: 'atlas', branch: 'draft' };
const fresh = () => new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);

const stored = (key: string, record: Record<string, unknown>) => {
	const storage = new FakeMetadataStorage();
	storage.records.set(key, {
		formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
		at: '2026-01-01T00:00:00.000Z',
		...ATLAS,
		...record
	});
	return new SynchronizationMetadata(storage, WORKSPACE);
};

const baseline = (remote = ATLAS) => ({
	remote,
	commit: 'c0ffee',
	files: new Map([
		['amsterdam-1625/project.json', 'aaaa'],
		['amsterdam-1625/annotations/one.json', 'bbbb']
	])
});

describe('installation-local synchronization metadata', () => {
	describe('the one Remote a Workspace has', () => {
		it('is unbound until bound, reads back, is replaced rather than doubled, and clears idempotently', async () => {
			const storage = new FakeMetadataStorage();
			const metadata = new SynchronizationMetadata(storage, WORKSPACE);
			expect(await metadata.readRemote()).toBeNull();
			expect(await metadata.bindRemote(ATLAS)).toBe(true);
			expect(await metadata.readRemote()).toEqual(ATLAS);

			await metadata.bindRemote(ATLAS_2);
			expect(await metadata.readRemote()).toEqual(ATLAS_2);
			expect([...storage.records.keys()]).toEqual([remoteRelationshipKey(WORKSPACE)]);

			await metadata.clearRemote();
			await metadata.clearRemote();
			expect(await metadata.readRemote()).toBeNull();
		});

		it('is one Workspace’s, invisible to another’s, and tells a browser one from a folder', async () => {
			const storage = new FakeMetadataStorage();
			await new SynchronizationMetadata(storage, WORKSPACE).bindRemote(ATLAS);
			await new SynchronizationMetadata(storage, WORKSPACE).writeBaseline(baseline());
			expect(await new SynchronizationMetadata(storage, OTHER).readRemote()).toBeNull();
			expect(await new SynchronizationMetadata(storage, OTHER).readBaseline(ATLAS)).toBeNull();

			await new SynchronizationMetadata(storage, FOLDER).bindRemote(ATLAS_2);
			expect(await new SynchronizationMetadata(storage, WORKSPACE).readRemote()).toEqual(ATLAS);
			expect(await new SynchronizationMetadata(storage, FOLDER).readRemote()).toEqual(ATLAS_2);
		});

		it('takes only the repository identity from whatever the caller was carrying', async () => {
			const metadata = fresh();

			await metadata.bindRemote({ formatVersion: 1, ...ATLAS } as typeof ATLAS);

			expect(await metadata.readRemote()).toEqual(ATLAS);
		});

		it('is unbound when the store refuses the write', async () => {
			const storage = new FakeMetadataStorage();
			storage.refuseWrites.add(remoteRelationshipKey(WORKSPACE));
			const metadata = new SynchronizationMetadata(storage, WORKSPACE);
			expect(await metadata.bindRemote(ATLAS)).toBe(false);
			expect(await metadata.readRemote()).toBeNull();
			expect(storage.records.has(remoteRelationshipKey(WORKSPACE))).toBe(false);
		});

		it('is unbound when the store refuses the read', async () => {
			const storage = new FakeMetadataStorage();
			const metadata = new SynchronizationMetadata(storage, WORKSPACE);
			await metadata.bindRemote(ATLAS);
			storage.refuseReads.add(remoteRelationshipKey(WORKSPACE));

			expect(await metadata.readRemote()).toBeNull();
		});

		it.each([
			['refuses a stored repository name that is a path traversal', { repository: '..' }],
			[
				'refuses a relationship written by a build that spells this differently',
				{ formatVersion: SYNCHRONIZATION_FORMAT_VERSION + 1 }
			]
		])('%s', async (_, record) => {
			expect(await stored(remoteRelationshipKey(WORKSPACE), record).readRemote()).toBeNull();
		});
	});

	describe('the Synchronization Baseline', () => {
		it('is Cannot tell until synchronized, then reads back the complete path map shared', async () => {
			const metadata = fresh();
			expect(await metadata.readBaseline(ATLAS)).toBeNull();
			expect(await metadata.writeBaseline(baseline())).toBe(true);
			expect(await metadata.readBaseline(ATLAS)).toEqual(baseline());
		});

		it('keeps a path map of tens of thousands of entries whole', async () => {
			const metadata = fresh();
			const files = new Map(
				Array.from({ length: 40_000 }, (_, index) => [`tiles/${index}.jpg`, `sha${index}`])
			);

			expect(await metadata.writeBaseline({ remote: ATLAS, commit: 'c0ffee', files })).toBe(true);
			const read = await metadata.readBaseline(ATLAS);
			expect(read?.files.size).toBe(40_000);
			expect(read?.files.get('tiles/39999.jpg')).toBe('sha39999');
		});

		it.each([
			['no evidence about a repository it does not name', ATLAS_2, false],
			[
				'evidence about the repository it names however that name is cased',
				{ owner: 'Ada', repository: 'Atlas', branch: 'main' },
				true
			],
			['no evidence about another branch of the repository it names', ATLAS_DRAFT, false]
		])('is %s', async (_, remote, evidence) => {
			const metadata = fresh();
			await metadata.writeBaseline(baseline());
			expect(await metadata.readBaseline(remote)).toEqual(evidence ? baseline() : null);
		});

		it('survives a re-bind and a re-bind back', async () => {
			const metadata = fresh();
			await metadata.bindRemote(ATLAS);
			await metadata.writeBaseline(baseline());

			await metadata.bindRemote(ATLAS_2);
			expect(await metadata.readBaseline(ATLAS_2)).toBeNull();

			await metadata.bindRemote(ATLAS);
			expect(await metadata.readBaseline(ATLAS)).toEqual(baseline());
		});

		it('answers false and clears stale evidence when the store refuses the write', async () => {
			const storage = new FakeMetadataStorage();
			const metadata = new SynchronizationMetadata(storage, WORKSPACE);
			await metadata.writeBaseline(baseline());
			storage.refuseWrites.add(baselineKey(WORKSPACE));

			expect(await metadata.writeBaseline({ ...baseline(), commit: 'facade' })).toBe(false);
			expect(await metadata.readBaseline(ATLAS)).toBeNull();
			expect(storage.records.has(baselineKey(WORKSPACE))).toBe(false);
		});

		it('is Cannot tell when the store refuses the read', async () => {
			const storage = new FakeMetadataStorage();
			const metadata = new SynchronizationMetadata(storage, WORKSPACE);
			await metadata.writeBaseline(baseline());
			storage.refuseReads.add(baselineKey(WORKSPACE));

			expect(await metadata.readBaseline(ATLAS)).toBeNull();
		});

		it.each([
			[
				'a record written by an unsupported build',
				{ formatVersion: SYNCHRONIZATION_FORMAT_VERSION + 1, commit: 'c0ffee' }
			],
			['a record with no commit evidence', { commit: '' }],
			[
				'a path map with one unusable entry',
				{
					files: new Map<string, unknown>([
						['a.json', 'aaaa'],
						['b.json', null]
					])
				}
			],
			['a record whose path map is not a map at all', { files: { 'a.json': 'aaaa' } }]
		])('is Cannot tell for %s', async (_, record) => {
			const metadata = stored(baselineKey(WORKSPACE), {
				commit: 'c0ffee',
				files: new Map([['a.json', 'aaaa']]),
				...record
			});
			expect(await metadata.readBaseline(ATLAS)).toBeNull();
		});
	});

	describe('a pending Share Links withdrawal', () => {
		it('is asked for one repository, branch and Workspace only, until the Sync carries it out', async () => {
			const storage = new FakeMetadataStorage();
			const metadata = new SynchronizationMetadata(storage, WORKSPACE);
			expect(await metadata.readWithdrawal(ATLAS)).toBe(false);
			expect(await metadata.requestWithdrawal(ATLAS)).toBe(true);
			expect(await metadata.readWithdrawal(ATLAS)).toBe(true);
			expect(await metadata.readWithdrawal(ATLAS_2)).toBe(false);
			expect(await metadata.readWithdrawal(ATLAS_DRAFT)).toBe(false);
			expect(await new SynchronizationMetadata(storage, OTHER).readWithdrawal(ATLAS)).toBe(false);

			await metadata.clearWithdrawal();
			expect(await metadata.readWithdrawal(ATLAS)).toBe(false);
		});
	});

	describe('the records of a Workspace being deleted', () => {
		it('are all thrown away, leaving another Workspace’s alone', async () => {
			const storage = new FakeMetadataStorage();
			const kept = new SynchronizationMetadata(storage, OTHER);
			await kept.bindRemote(ATLAS_2);
			await kept.writeBaseline(baseline(ATLAS_2));
			await kept.requestWithdrawal(ATLAS_2);
			const going = new SynchronizationMetadata(storage, WORKSPACE);
			await going.bindRemote(ATLAS);
			await going.writeBaseline(baseline());
			await going.requestWithdrawal(ATLAS);

			await discardSynchronizationMetadata(storage, WORKSPACE);

			expect(await going.readRemote()).toBeNull();
			expect(await going.readBaseline(ATLAS)).toBeNull();
			expect(await going.readWithdrawal(ATLAS)).toBe(false);
			expect(await kept.readRemote()).toEqual(ATLAS_2);
			expect(await kept.readBaseline(ATLAS_2)).toEqual(baseline(ATLAS_2));
			expect(await kept.readWithdrawal(ATLAS_2)).toBe(true);
		});
	});
});
