import { describe, expect, it } from 'vitest';

import { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import {
	PUBLISH_MANIFEST_FORMAT_VERSION,
	PublishManifests,
	discardPublishManifest,
	publishManifestKey
} from './publish-manifest.js';

// The manifest is *evidence about a Remote*, and ticket 05 refuses a publish on it. So the tests
// that matter are the ones about not believing something: a record from another build, a truncated
// one, a storage that will not answer, and a key belonging to a different Workspace. Every one of
// them has to come back "we cannot say" rather than "the Remote held nothing", because those two
// answers licence opposite actions.

const WORKSPACE = 'opfs:Marking 2026';
const OTHER = 'opfs:My Workspace';

const ATLAS = { owner: 'ada', repository: 'atlas', branch: 'main' };
const ATLAS_2 = { owner: 'ada', repository: 'atlas-2', branch: 'main' };

const manifest = (remote = ATLAS) => ({
	remote,
	commit: 'c0ffee',
	files: new Map([
		['index.html', 'aaaa'],
		['amsterdam-1625/project.json', 'bbbb']
	])
});

describe('the publish manifest', () => {
	it('reads back what the last publish put on the Remote', () => {
		const storage = new FakeJournalStorage();
		const manifests = new PublishManifests(storage, WORKSPACE);

		expect(manifests.write(manifest())).toBe(true);

		expect(manifests.read(ATLAS)).toEqual(manifest());
	});

	it('answers nothing for a Workspace that has never published', () => {
		expect(new PublishManifests(new FakeJournalStorage(), WORKSPACE).read(ATLAS)).toBeNull();
	});

	// One click switches Workspaces, and what this machine saw on one Remote is no evidence at all
	// about another — the reason `WriteAheadJournal` and `DeletedProjects` are bound the same way.
	it('is one Workspace’s and is invisible to another’s', () => {
		const storage = new FakeJournalStorage();
		new PublishManifests(storage, WORKSPACE).write(manifest());

		expect(new PublishManifests(storage, OTHER).read(ATLAS)).toBeNull();
	});

	// ⚠ **The hazard the Workspace key alone does not cover.** `bindRemote` may be called on a
	// Workspace that is already bound, and unbinding leaves everything else where it is — so without
	// this, this machine's claim about `ada/atlas` would stand as evidence about `ada/atlas-2`, and
	// ticket 05 would read every legitimately changed path there as somebody else's work.
	it('is no evidence about a repository it does not name', () => {
		const storage = new FakeJournalStorage();
		const manifests = new PublishManifests(storage, WORKSPACE);
		manifests.write(manifest());

		expect(manifests.read(ATLAS_2)).toBeNull();
		// And a re-bind back is where it was: self-validation keeps a record clearing would have lost.
		expect(manifests.read(ATLAS)).toEqual(manifest());
	});

	// Two branches of one repository are two different trees, and a publish moves one of them.
	it('is no evidence about another branch of the same repository', () => {
		const storage = new FakeJournalStorage();
		const manifests = new PublishManifests(storage, WORKSPACE);
		manifests.write(manifest());

		expect(manifests.read({ ...ATLAS, branch: 'gh-pages' })).toBeNull();
	});

	it('is forgotten when it is cleared', () => {
		const storage = new FakeJournalStorage();
		const manifests = new PublishManifests(storage, WORKSPACE);
		manifests.write(manifest());

		manifests.clear();

		expect([manifests.read(ATLAS), storage.items.size]).toEqual([null, 0]);
	});

	// The key shape is a contract with `discardPublishManifest`, which walks the prefix, and with a
	// Workspace name that may hold a `/` in either half.
	it('escapes the Workspace name into its key', () => {
		expect(publishManifestKey('folder:a/b')).toBe('ballastella.publish-manifest.folder%3Aa%2Fb');
	});

	it('lives under a prefix of its own, so the journal’s own sweeps cannot see it', () => {
		const storage = new FakeJournalStorage();
		new PublishManifests(storage, WORKSPACE).write(manifest());

		expect(
			[...storage.items.keys()].every((key) => key.startsWith('ballastella.publish-manifest.'))
		).toBe(true);
	});
});

describe('a record this build has no rules for', () => {
	const stored = (value: string) => {
		const storage = new FakeJournalStorage();
		storage.setItem(publishManifestKey(WORKSPACE), value);
		return new PublishManifests(storage, WORKSPACE);
	};

	it('is no evidence when it comes from another format version', () => {
		expect(
			stored(
				JSON.stringify({
					formatVersion: PUBLISH_MANIFEST_FORMAT_VERSION + 1,
					at: '2026-08-13T00:00:00.000Z',
					commit: 'c0ffee',
					files: { 'index.html': 'aaaa' }
				})
			).read(ATLAS)
		).toBeNull();
	});

	it('is no evidence when it will not parse at all', () => {
		expect(stored('{"formatVersion":1,"files":{"index').read(ATLAS)).toBeNull();
	});

	// ⚠ **The whole record, not the entries that survived.** A manifest truncated by a full
	// `localStorage` mid-write would otherwise read as "the Remote held these six paths and no
	// others", which ticket 05 would take as licence rather than as the absence of evidence it is.
	it('is no evidence when one entry names no blob', () => {
		expect(
			stored(
				JSON.stringify({
					formatVersion: PUBLISH_MANIFEST_FORMAT_VERSION,
					at: '2026-08-13T00:00:00.000Z',
					commit: 'c0ffee',
					files: { 'index.html': 'aaaa', 'amsterdam-1625/project.json': null }
				})
			).read(ATLAS)
		).toBeNull();
	});

	it('is no evidence when it names no commit', () => {
		expect(
			stored(
				JSON.stringify({
					formatVersion: PUBLISH_MANIFEST_FORMAT_VERSION,
					at: '2026-08-13T00:00:00.000Z',
					files: {}
				})
			).read(ATLAS)
		).toBeNull();
	});
});

describe('a storage that will not co-operate', () => {
	/** Safari with cookies blocked: the object is there and every property of it throws. */
	const hostile = () => ({
		get length(): number {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		},
		key(): string | null {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		},
		getItem(): string | null {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		},
		setItem(): void {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		},
		removeItem(): void {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		}
	});

	it('reports that the manifest was not kept rather than failing a publish that succeeded', () => {
		expect(new PublishManifests(hostile(), WORKSPACE).write(manifest())).toBe(false);
	});

	it('answers “we cannot say” rather than “the Remote held nothing”', () => {
		expect(new PublishManifests(hostile(), WORKSPACE).read(ATLAS)).toBeNull();
	});

	/**
	 * ⚠ **A refused write must not leave the last one standing.**
	 *
	 * The failing publish is the second, and the record that survives it describes the *first* — same
	 * key, same shape, nothing to tell them apart. Read back, it says the Remote holds the tree it
	 * held an hour ago, so ticket 05 would meet every path this publish legitimately changed as
	 * somebody else's work. "We cannot say" is the only answer a failed write can honestly leave.
	 */
	it('throws the last publish’s record away when this one will not fit', () => {
		const storage = new FakeJournalStorage();
		const manifests = new PublishManifests(storage, WORKSPACE);
		expect(manifests.write(manifest())).toBe(true);

		// A `localStorage` with room for the first record and none for the second, which is what a
		// Workspace that has grown by a pyramid since its last publish meets.
		storage.setItem = () => {
			throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
		};

		expect(manifests.write({ ...manifest(), commit: 'deadbeef' })).toBe(false);
		expect(manifests.read(ATLAS)).toBeNull();
	});
});

// The same reuse hazard the journal and the deletion records carry: a manifest outliving its
// Workspace is this machine's claim about a Remote, standing ready for whatever is made under that
// name next.
describe('discarding a deleted Workspace’s manifest', () => {
	it('removes that Workspace’s and leaves every other alone', () => {
		const storage = new FakeJournalStorage();
		new PublishManifests(storage, WORKSPACE).write(manifest());
		new PublishManifests(storage, OTHER).write(manifest());

		expect(discardPublishManifest(storage, WORKSPACE)).toBe(true);

		expect([
			new PublishManifests(storage, WORKSPACE).read(ATLAS),
			new PublishManifests(storage, OTHER).read(ATLAS)
		]).toEqual([null, manifest()]);
	});

	it('says so when there was nothing to discard', () => {
		expect(discardPublishManifest(new FakeJournalStorage(), WORKSPACE)).toBe(false);
	});
});
