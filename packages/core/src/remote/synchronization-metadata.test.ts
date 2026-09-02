import { describe, expect, it } from 'vitest';

import { FakeMetadataStorage } from './fake-metadata-storage.js';
import {
	SYNCHRONIZATION_FORMAT_VERSION,
	SynchronizationMetadata,
	baselineKey,
	discardSynchronizationMetadata,
	listRemoteRelationships,
	remoteRelationshipKey
} from './synchronization-metadata.js';

// This module is the evidence every later synchronization decision rests on, so the tests that matter
// are the ones about *not believing something*: a record from another build, a truncated path map, a
// record naming another repository, a store that will not answer. Every one of them has to come back
// "no valid Baseline" — `Cannot tell` — rather than "the Remote held nothing", because those two
// answers licence opposite actions.

const WORKSPACE = 'opfs:Marking 2026';
const OTHER = 'opfs:My Workspace';
/** The same display name in a folder rather than in browser storage: a different subject. */
const FOLDER = 'folder:Marking 2026';

const ATLAS = { owner: 'ada', repository: 'atlas', branch: 'main' };
const ATLAS_2 = { owner: 'ada', repository: 'atlas-2', branch: 'main' };
const ATLAS_DRAFT = { owner: 'ada', repository: 'atlas', branch: 'draft' };

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
		it('reads back the repository it was bound to', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);

			expect(await metadata.bindRemote(ATLAS)).toBe(true);

			expect(await metadata.readRemote()).toEqual(ATLAS);
		});

		it('is unbound until something binds it', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);

			expect(await metadata.readRemote()).toBeNull();
		});

		// A Workspace has zero or one active Remote. Binding again replaces; there is no API through
		// which a second one could exist.
		it('replaces the relationship rather than holding two', async () => {
			const storage = new FakeMetadataStorage();
			const metadata = new SynchronizationMetadata(storage, WORKSPACE);

			await metadata.bindRemote(ATLAS);
			await metadata.bindRemote(ATLAS_2);

			expect(await metadata.readRemote()).toEqual(ATLAS_2);
			expect([...storage.records.keys()]).toEqual([remoteRelationshipKey(WORKSPACE)]);
		});

		it('clears the relationship, idempotently', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);
			await metadata.bindRemote(ATLAS);

			await metadata.clearRemote();
			await metadata.clearRemote();

			expect(await metadata.readRemote()).toBeNull();
		});

		// One click switches Workspaces, and what this machine knows about one Remote is no evidence at
		// all about another.
		it('is one Workspace’s and is invisible to another’s', async () => {
			const storage = new FakeMetadataStorage();
			await new SynchronizationMetadata(storage, WORKSPACE).bindRemote(ATLAS);

			expect(await new SynchronizationMetadata(storage, OTHER).readRemote()).toBeNull();
		});

		// The key carries the backing, so a folder that happens to share a Workspace's display name is
		// a different subject: identity and backing together are what a record is keyed by.
		it('tells a browser-backed Workspace from a folder of the same name', async () => {
			const storage = new FakeMetadataStorage();
			await new SynchronizationMetadata(storage, WORKSPACE).bindRemote(ATLAS);
			await new SynchronizationMetadata(storage, FOLDER).bindRemote(ATLAS_2);

			expect(await new SynchronizationMetadata(storage, WORKSPACE).readRemote()).toEqual(ATLAS);
			expect(await new SynchronizationMetadata(storage, FOLDER).readRemote()).toEqual(ATLAS_2);
		});

		// ⚠ **A `RemoteBinding` read off disk carries its own `formatVersion`.** Spread over the stored
		// record's, it wrote a version this build's reader refuses — a Workspace that reported itself
		// unbound the instant it was bound, which is what a Clone met.
		it('takes only the repository identity from whatever the caller was carrying', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);

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

		// ⚠ Browser storage is user-writable, and both fields are interpolated straight into a GitHub
		// API path. `ada/..` normalises to an endpoint about a *user*; `encodeURIComponent` leaves the
		// dot alone, so the check has to be here.
		it('refuses a stored repository name that is a path traversal', async () => {
			const storage = new FakeMetadataStorage();
			storage.records.set(remoteRelationshipKey(WORKSPACE), {
				formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
				at: '2026-01-01T00:00:00.000Z',
				owner: 'ada',
				repository: '..',
				branch: 'main'
			});

			expect(await new SynchronizationMetadata(storage, WORKSPACE).readRemote()).toBeNull();
		});

		it('refuses a relationship written by a build that spells this differently', async () => {
			const storage = new FakeMetadataStorage();
			storage.records.set(remoteRelationshipKey(WORKSPACE), {
				formatVersion: SYNCHRONIZATION_FORMAT_VERSION + 1,
				at: '2026-01-01T00:00:00.000Z',
				...ATLAS
			});

			expect(await new SynchronizationMetadata(storage, WORKSPACE).readRemote()).toBeNull();
		});
	});

	describe('the Synchronization Baseline', () => {
		it('reads back the complete path map the last transfer shared', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);

			expect(await metadata.writeBaseline(baseline())).toBe(true);

			expect(await metadata.readBaseline(ATLAS)).toEqual(baseline());
		});

		// This store is sized for tens of thousands of paths rather than for the origin's 5 MB of
		// `localStorage`, which is the whole reason it is not the v1 manifest.
		it('keeps a path map of tens of thousands of entries whole', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);
			const files = new Map(
				Array.from({ length: 40_000 }, (_, index) => [`tiles/${index}.jpg`, `sha${index}`])
			);

			expect(await metadata.writeBaseline({ remote: ATLAS, commit: 'c0ffee', files })).toBe(true);

			const read = await metadata.readBaseline(ATLAS);
			expect(read?.files.size).toBe(40_000);
			expect(read?.files.get('tiles/39999.jpg')).toBe('sha39999');
		});

		it('is Cannot tell for a Workspace that has never synchronized', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);

			expect(await metadata.readBaseline(ATLAS)).toBeNull();
		});

		// ⚠ The hazard the Workspace key alone does not cover: a Workspace can be re-bound with the
		// Baseline untouched, and this machine's claim about `ada/atlas` standing as evidence about
		// `ada/atlas-2` would read every legitimately different path there as somebody else's work.
		it('is no evidence about a repository it does not name', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);
			await metadata.writeBaseline(baseline());

			expect(await metadata.readBaseline(ATLAS_2)).toBeNull();
		});

		// GitHub owner and repository names are case-insensitive, and `remoteIdentityKey` is where this
		// codebase says so — the Open that reuses a Workspace and the Import that refuses its own Remote
		// both ask it. Compared byte for byte here, re-binding by pasting a differently-cased address
		// would throw away a Baseline that describes this very Remote and report `Cannot tell` over
		// evidence there is.
		it('is evidence about the repository it names however that name is cased', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);
			await metadata.writeBaseline(baseline());

			expect(
				await metadata.readBaseline({ owner: 'Ada', repository: 'Atlas', branch: 'main' })
			).toEqual(baseline());
		});

		it('is no evidence about another branch of the repository it names', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);
			await metadata.writeBaseline(baseline());

			expect(await metadata.readBaseline(ATLAS_DRAFT)).toBeNull();
		});

		// Unbinding leaves it, so a Workspace re-bound to the repository it came from still has its
		// evidence. Clearing on unbind would throw away a record that is still good.
		it('survives a re-bind and a re-bind back', async () => {
			const metadata = new SynchronizationMetadata(new FakeMetadataStorage(), WORKSPACE);
			await metadata.bindRemote(ATLAS);
			await metadata.writeBaseline(baseline());

			await metadata.bindRemote(ATLAS_2);
			expect(await metadata.readBaseline(ATLAS_2)).toBeNull();

			await metadata.bindRemote(ATLAS);
			expect(await metadata.readBaseline(ATLAS)).toEqual(baseline());
		});

		// Stale evidence is never retained, and the Publish is never reported as failed. A refused write
		// leaves the previous transfer's map in place, which the reader cannot tell from a record of the
		// transfer that has just happened.
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

		it('is Cannot tell for a record written by an unsupported build', async () => {
			const storage = new FakeMetadataStorage();
			storage.records.set(baselineKey(WORKSPACE), {
				formatVersion: SYNCHRONIZATION_FORMAT_VERSION + 1,
				at: '2026-01-01T00:00:00.000Z',
				...ATLAS,
				commit: 'c0ffee',
				files: new Map([['a.json', 'aaaa']])
			});

			expect(await new SynchronizationMetadata(storage, WORKSPACE).readBaseline(ATLAS)).toBeNull();
		});

		it('is Cannot tell for a record with no commit evidence', async () => {
			const storage = new FakeMetadataStorage();
			storage.records.set(baselineKey(WORKSPACE), {
				formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
				at: '2026-01-01T00:00:00.000Z',
				...ATLAS,
				commit: '',
				files: new Map([['a.json', 'aaaa']])
			});

			expect(await new SynchronizationMetadata(storage, WORKSPACE).readBaseline(ATLAS)).toBeNull();
		});

		// One bad entry is a truncated or foreign record, not a Baseline missing one file. Reading it as
		// the latter is how a partial belief comes to licence an overwrite.
		it('is Cannot tell for a path map with one unusable entry', async () => {
			const storage = new FakeMetadataStorage();
			storage.records.set(baselineKey(WORKSPACE), {
				formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
				at: '2026-01-01T00:00:00.000Z',
				...ATLAS,
				commit: 'c0ffee',
				files: new Map<string, unknown>([
					['a.json', 'aaaa'],
					['b.json', null]
				])
			});

			expect(await new SynchronizationMetadata(storage, WORKSPACE).readBaseline(ATLAS)).toBeNull();
		});

		it('is Cannot tell for a record whose path map is not a map at all', async () => {
			const storage = new FakeMetadataStorage();
			storage.records.set(baselineKey(WORKSPACE), {
				formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
				at: '2026-01-01T00:00:00.000Z',
				...ATLAS,
				commit: 'c0ffee',
				files: { 'a.json': 'aaaa' }
			});

			expect(await new SynchronizationMetadata(storage, WORKSPACE).readBaseline(ATLAS)).toBeNull();
		});

		it('is one Workspace’s and is invisible to another’s', async () => {
			const storage = new FakeMetadataStorage();
			await new SynchronizationMetadata(storage, WORKSPACE).writeBaseline(baseline());

			expect(await new SynchronizationMetadata(storage, OTHER).readBaseline(ATLAS)).toBeNull();
		});
	});

	describe('the records of a Workspace being deleted', () => {
		it('are both thrown away, leaving another Workspace’s alone', async () => {
			const storage = new FakeMetadataStorage();
			const kept = new SynchronizationMetadata(storage, OTHER);
			await kept.bindRemote(ATLAS_2);
			await kept.writeBaseline(baseline(ATLAS_2));
			const going = new SynchronizationMetadata(storage, WORKSPACE);
			await going.bindRemote(ATLAS);
			await going.writeBaseline(baseline());

			await discardSynchronizationMetadata(storage, WORKSPACE);

			expect(await going.readRemote()).toBeNull();
			expect(await going.readBaseline(ATLAS)).toBeNull();
			expect(await kept.readRemote()).toEqual(ATLAS_2);
			expect(await kept.readBaseline(ATLAS_2)).toEqual(baseline(ATLAS_2));
		});
	});

	// The hook under "reopening a repository returns to its existing Workspace".
	describe('the repository-to-Workspace lookup', () => {
		it('names every Workspace holding a relationship, and nothing else', async () => {
			const storage = new FakeMetadataStorage();
			await new SynchronizationMetadata(storage, WORKSPACE).bindRemote(ATLAS);
			await new SynchronizationMetadata(storage, FOLDER).bindRemote(ATLAS_2);
			// A Baseline with no relationship is not a bound Workspace.
			await new SynchronizationMetadata(storage, OTHER).writeBaseline(baseline());

			expect(await listRemoteRelationships(storage)).toEqual([
				{ workspaceKey: WORKSPACE, remote: ATLAS },
				{ workspaceKey: FOLDER, remote: ATLAS_2 }
			]);
		});

		it('is empty rather than throwing when the store cannot be listed', async () => {
			const storage = new FakeMetadataStorage();
			storage.keys = () => Promise.reject(new Error('no'));

			expect(await listRemoteRelationships(storage)).toEqual([]);
		});
	});
});
