import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub } from './fake-github.js';
import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { LocalChangeIndex } from './local-change-index.js';
import {
	RemotePublishFailedError,
	RemotePublishRefusedError,
	type RemoteRepository
} from './publish-to-remote.js';
import {
	SynchronizationMetadata,
	baselineKey,
	type SynchronizationBaseline
} from './synchronization-metadata.js';
import { publishWorkspaceToRemote } from './synchronization-publish.js';

// This module's own assertions and nothing the transport's tests already cover. The transport — the
// resulting tree, the exact mirror, truncation, budgets, the branch move — is
// `publish-to-remote.test.ts`; the three-way table is `synchronization-planner.test.ts`. What is
// asserted here is the join: which refusals stop a publish before it touches anything, and what
// this installation durably believes afterwards.
//
// **Persisted evidence rather than a returned value, wherever the two differ.** A publish that
// answered the right Baseline and stored the wrong one — or stored the right one under a key the
// reader validates away — passes every assertion made on its return value and leaves the next
// publish saying `Cannot tell`. So the Baseline is read back through `SynchronizationMetadata`,
// which is the reader the application uses.

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const EMPTY = new Uint8Array(0);

const REMOTE: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };
const TOKEN = 'ghp_a-token';
const WORKSPACE = 'opfs:Atlas';

/** A Workspace of one Project, its shared pyramid, and the website a previous publish wrote. */
const WORKSPACE_FILES = {
	'ballastella-site.json': '{"formatVersion":2,"projects":[{"directory":"amsterdam-1625"}]}',
	'index.html': '<!doctype html>',
	'_app/immutable/entry/start.AAAA.js': 'export const start = 1;',
	'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
	'amsterdam-1625/annotations/notes.json': '{"type":"FeatureCollection","features":[]}',
	'images/blaeu/info.json': '{"id":"https://unset.invalid/blaeu"}',
	'images/blaeu/0,0,256,256/256,256/0/default.jpg': 'jpeg-bytes',
	// alignment-write-is-the-fixture: an Alignment already in the Workspace, seeded so the publish has one to send; nothing here edits Control Points
	'alignments/blaeu.json': '{"type":"Annotation"}'
};

/** Every source path of {@link WORKSPACE_FILES}: what a complete Baseline for it holds. */
const SOURCE_PATHS = [
	'alignments/blaeu.json',
	'amsterdam-1625/annotations/notes.json',
	'amsterdam-1625/project.json',
	'images/blaeu/0,0,256,256/256,256/0/default.jpg',
	'images/blaeu/info.json'
];

const seeded = async (files: Record<string, string>): Promise<MemoryProjectStore> => {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(files)) await store.write(path, encode(content));
	return store;
};

/** The whole apparatus one Workspace publishes through: the store, the fake, and the evidence. */
const workspace = async (
	files: Record<string, string> = WORKSPACE_FILES,
	tree: Record<string, string> = { 'README.md': '# Atlas\n' }
) => {
	const store = await seeded(files);
	const github = await createFakeGitHub({ ...REMOTE, tree });
	const storage = new FakeMetadataStorage();
	const metadata = new SynchronizationMetadata(storage, WORKSPACE);
	const changes = new LocalChangeIndex(storage, WORKSPACE, { flushInterval: 0 });
	return { store, github, storage, metadata, changes };
};

type Apparatus = Awaited<ReturnType<typeof workspace>>;

const publish = (kit: Apparatus, options: { overwrite?: readonly string[] } = {}) =>
	publishWorkspaceToRemote(kit.store, {
		token: TOKEN,
		remote: REMOTE,
		metadata: kit.metadata,
		changes: kit.changes,
		fetch: kit.github.fetch,
		...(options.overwrite === undefined ? {} : { overwrite: options.overwrite })
	});

/** What this installation believes, read back through the reader the application uses. */
const believed = (kit: Apparatus): Promise<SynchronizationBaseline | null> =>
	kit.metadata.readBaseline(REMOTE);

/** The state a refusal has to leave untouched, in one value. */
const snapshot = (kit: Apparatus) => ({
	head: kit.github.head(),
	remote: [...kit.github.files().keys()],
	blobPosts: kit.github.blobPosts,
	baseline: kit.storage.records.get(baselineKey(WORKSPACE)) ?? null
});

/** Somebody else's commit, which is the one thing no gesture in this app can produce. */
const somebodyElsePublishes = (kit: Apparatus, files: Record<string, string | null>) =>
	kit.github.commitFiles(files);

describe('an ordinary Publish', () => {
	it('records the complete source Baseline at the commit the branch now holds', async () => {
		const kit = await workspace();

		const published = await publish(kit);

		expect(published.baselineKept).toBe(true);
		const baseline = await believed(kit);
		// The *actual resulting commit*, not the parent the plan was made against: a record naming the
		// commit before this one is a record of a publish that did not happen.
		expect(baseline?.commit).toBe(kit.github.head());
		expect(baseline?.commit).toBe(published.commit);
		expect([...(baseline?.files.keys() ?? [])].sort()).toEqual(SOURCE_PATHS);
		expect(baseline?.remote).toEqual(REMOTE);
	});

	// Generated output is sent and never recorded as shared *source*. Two
	// editor versions synchronizing would otherwise trade obsolete `_app` bundles forever, each side
	// reading the other's chunk names as an inbound change to somebody's scholarship.
	it('sends the generated site and leaves every generated path out of the Baseline', async () => {
		const kit = await workspace();

		await publish(kit);

		const committed = [...kit.github.files().keys()];
		expect(committed).toEqual(
			expect.arrayContaining(['index.html', '_app/immutable/entry/start.AAAA.js', '.nojekyll'])
		);
		const recorded = [...((await believed(kit))?.files.keys() ?? [])];
		expect(recorded).not.toEqual(expect.arrayContaining(['index.html', '.nojekyll']));
		expect(recorded.filter((path) => path.startsWith('_app/'))).toEqual([]);
	});

	// An Offline Copy's tiles live under `base-map/tiles/**`, which is the one part of `base-map/`
	// that is the author's own decision rather than rebuilt viewer machinery. Recorded as generated
	// output, every Update would offer to delete them as obsolete.
	it('records an Offline Copy’s tiles as source, and the glyphs beside them as output', async () => {
		const kit = await workspace({
			...WORKSPACE_FILES,
			'base-map/tiles/9f8/12/2094/1330.mvt': 'tile-bytes',
			'base-map/fonts/Noto Sans Regular/0-255.pbf': 'glyph-bytes'
		});

		await publish(kit);

		const recorded = [...((await believed(kit))?.files.keys() ?? [])];
		expect(recorded).toContain('base-map/tiles/9f8/12/2094/1330.mvt');
		expect(recorded).not.toContain('base-map/fonts/Noto Sans Regular/0-255.pbf');
	});

	it('goes ahead with local work to publish, and advances the Baseline to it', async () => {
		const kit = await workspace();
		await publish(kit);

		await kit.store.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"mine"}]}')
		);
		const second = await publish(kit);

		expect(second.plan.conflict).toBeNull();
		const baseline = await believed(kit);
		expect(baseline?.files.get('amsterdam-1625/annotations/notes.json')).toBe(
			await gitBlobSha(encode('{"type":"FeatureCollection","features":[{"id":"mine"}]}'))
		);
		expect(decode(kit.github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"mine"}]}'
		);
	});

	// Restated here only as the promise the *synchronization* rules must not have broken: the owned
	// namespace is what a mirror replaces, and everything else is somebody's own repository. The
	// exact-mirror assertions themselves are `publish-to-remote.test.ts`'s.
	it('preserves the repository’s own files and its submodules', async () => {
		const store = await seeded(WORKSPACE_FILES);
		const github = await createFakeGitHub({
			...REMOTE,
			tree: {
				'README.md': '# Atlas\n',
				CNAME: 'atlas.example\n',
				'.github/workflows/ci.yml': 'on: push\n'
			},
			submodules: { 'vendor/iiif': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
		});
		const storage = new FakeMetadataStorage();
		const kit = {
			store,
			github,
			storage,
			metadata: new SynchronizationMetadata(storage, WORKSPACE),
			changes: new LocalChangeIndex(storage, WORKSPACE, { flushInterval: 0 })
		};

		await publish(kit);

		const files = kit.github.files();
		expect([
			decode(files.get('README.md') ?? EMPTY),
			decode(files.get('CNAME') ?? EMPTY),
			decode(files.get('.github/workflows/ci.yml') ?? EMPTY)
		]).toEqual(['# Atlas\n', 'atlas.example\n', 'on: push\n']);
		expect(kit.github.gitlinks().get('vendor/iiif')).toBe(
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		);
		// Preserved and unclaimed: on the Remote, and no part of what this machine says it shared.
		expect([...((await believed(kit))?.files.keys() ?? [])]).toEqual(SOURCE_PATHS);
	});
});

describe('a send the Remote has moved under', () => {
	/** A published Workspace, and then somebody else's afternoon arriving on the Remote. */
	const afterSomebodyElsePublished = async (files: Record<string, string | null>) => {
		const kit = await workspace();
		const ours = await publish(kit);
		await somebodyElsePublishes(kit, files);
		return { ...kit, ours };
	};

	// ⚠ **Not a refusal any more, and the Baseline is what makes that safe** (ADR-0044). Their file is
	// neither overwritten with this Workspace's older copy nor dropped out of the tree, so a send
	// from a machine that has never seen their afternoon leaves it exactly where it is.
	it('leaves Remote-only source change alone and sends this Workspace’s own work', async () => {
		const kit = await afterSomebodyElsePublished({
			'amsterdam-1625/annotations/l2.geojson': '{"type":"FeatureCollection","features":[]}'
		});
		await kit.store.write('amsterdam-1625/project.json', encode('{"formatVersion":1,"name":"A2"}'));

		const published = await publish(kit);

		expect(published.plan.conflict).toBeNull();
		expect(decode(kit.github.files().get('amsterdam-1625/annotations/l2.geojson') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
		expect(decode(kit.github.files().get('amsterdam-1625/project.json') ?? EMPTY)).toBe(
			'{"formatVersion":1,"name":"A2"}'
		);
		// ⚠ **And the Baseline does not claim their file.** Recorded, it would read as agreed and the
		// next send would be entitled to overwrite it.
		expect((await believed(kit))?.files.has('amsterdam-1625/annotations/l2.geojson')).toBe(false);
	});

	it('leaves alone a whole Project that arrived on the Remote after the last agreement', async () => {
		const kit = await afterSomebodyElsePublished({
			'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}'
		});

		await publish(kit);

		expect([...kit.github.files().keys()]).toContain('florida-1657/project.json');
	});

	// Ballastella will not choose between two versions of an Annotation, so the row with no safe
	// answer in either direction must not send the author round a loop to a get that refuses it for
	// the same reason.
	it('refuses a Conflict without offering a get that would refuse it too', async () => {
		const kit = await workspace();
		const ours = await publish(kit);
		await somebodyElsePublishes(kit, {
			'amsterdam-1625/annotations/notes.json':
				'{"type":"FeatureCollection","features":[{"id":"theirs"}]}'
		});
		await kit.store.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"mine"}]}')
		);
		const before = snapshot(kit);

		const refusal = await publish(kit).catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(RemotePublishRefusedError);
		const message = refusal instanceof Error ? refusal.message : '';
		expect(message).toContain('changed both here and on ada/atlas');
		expect(message).toContain('will refuse this for the same reason');
		expect(message).toContain('overwrite the repository');
		expect(snapshot(kit)).toEqual(before);
		// Their bytes, still theirs.
		expect(decode(kit.github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"theirs"}]}'
		);
		// The Baseline is still the one *our* last publish left, at our commit rather than at the one
		// the tree listing just saw: a refusal that advanced it would make the next send delete the
		// file it has this moment declined to overwrite.
		expect((await believed(kit))?.commit).toBe(ours.commit);
	});
});

describe('a Publish with no Baseline', () => {
	// ⚠ **The case the whole rule exists for**: an existing Workspace joined to an existing
	// repository, with no record of what the two last shared. Nothing is removed, so this goes ahead.
	it('leaves a non-empty Remote it cannot attribute exactly as it is', async () => {
		const kit = await workspace(WORKSPACE_FILES, {
			'README.md': '# Atlas\n',
			'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}'
		});

		const published = await publish(kit);

		expect(published.plan.conflict).toBeNull();
		expect([...kit.github.files().keys()]).toContain('florida-1657/project.json');
		expect([...kit.github.files().keys()]).toContain('amsterdam-1625/project.json');
		// The Baseline covers what this send wrote and not the Project it left alone.
		expect([...((await believed(kit))?.files.keys() ?? [])].sort()).toEqual(SOURCE_PATHS);
	});

	// An empty side establishes a Baseline safely, because there is no history to invent. This is the
	// first publish from a new Workspace, which must not meet a refusal.
	it('establishes evidence against a Remote with no source of ours on it', async () => {
		const kit = await workspace();

		const published = await publish(kit);

		expect(published.plan.conflict).toBeNull();
		expect([...((await believed(kit))?.files.keys() ?? [])].sort()).toEqual(SOURCE_PATHS);
	});

	// The other half of that, and the commonest one: a browser whose storage was cleared, or a
	// Workspace opened from a complete Clone. The two source namespaces are byte-for-byte equal, so
	// there is nothing to be uncertain about and nothing at stake in going ahead.
	it('establishes evidence where the two source namespaces are already equal', async () => {
		const kit = await workspace();
		await publish(kit);
		await kit.metadata.clearBaseline();

		const published = await publish(kit);

		expect(published.plan.conflict).toBeNull();
		expect((await believed(kit))?.commit).toBe(published.commit);
	});
});

describe('Overwrite the repository', () => {
	it('replaces the owned source it was shown, and records the result', async () => {
		const kit = await workspace();
		await publish(kit);
		await somebodyElsePublishes(kit, {
			'amsterdam-1625/annotations/l2.geojson': '{"type":"FeatureCollection","features":[]}'
		});

		const published = await publish(kit, {
			overwrite: ['amsterdam-1625/annotations/l2.geojson']
		});

		// Gone, because an overwrite is an exact mirror of the owned namespace and this Workspace has no
		// file for it — which is what "local wins" means and why the consent had to name it.
		expect([...kit.github.files().keys()]).not.toContain('amsterdam-1625/annotations/l2.geojson');
		expect(decode(kit.github.files().get('README.md') ?? EMPTY)).toBe('# Atlas\n');
		const baseline = await believed(kit);
		expect(baseline?.commit).toBe(published.commit);
		expect([...(baseline?.files.keys() ?? [])].sort()).toEqual(SOURCE_PATHS);
	});

	// ⚠ **The consent is about a set of files, and a set that has grown is a set nobody agreed to.**
	// A large send runs for minutes and this replans against a listing taken after the local publish
	// wrote — so an agreement to remove one Annotation must not become an agreement to delete a
	// Project that arrived in the window.
	it('refuses when the Remote has gained a path the author never saw', async () => {
		const kit = await workspace();
		await publish(kit);
		await somebodyElsePublishes(kit, {
			'amsterdam-1625/annotations/l2.geojson': '{"type":"FeatureCollection","features":[]}',
			'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}'
		});
		const before = snapshot(kit);

		const refusal = await publish(kit, {
			// Only the one they were shown, a listing ago.
			overwrite: ['amsterdam-1625/annotations/l2.geojson']
		}).catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(RemotePublishRefusedError);
		expect(refusal instanceof Error ? refusal.message : '').toContain('florida-1657/project.json');
		expect(snapshot(kit)).toEqual(before);
	});

	it('takes the local side of a Conflict when that is what was agreed', async () => {
		const kit = await workspace();
		await publish(kit);
		await somebodyElsePublishes(kit, {
			'amsterdam-1625/annotations/notes.json':
				'{"type":"FeatureCollection","features":[{"id":"theirs"}]}'
		});
		await kit.store.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"mine"}]}')
		);

		await publish(kit, { overwrite: ['amsterdam-1625/annotations/notes.json'] });

		expect(decode(kit.github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"mine"}]}'
		);
		expect((await believed(kit))?.files.get('amsterdam-1625/annotations/notes.json')).toBe(
			await gitBlobSha(encode('{"type":"FeatureCollection","features":[{"id":"mine"}]}'))
		);
	});
});

describe('the local-change index a Publish narrows', () => {
	it('clears the marks the Baseline now accounts for, and only those', async () => {
		const kit = await workspace();
		await kit.changes.mark('amsterdam-1625/project.json', 'written');
		await kit.changes.mark('images/blaeu/info.json', 'written');
		// Publish-owned output, which the source Baseline never claims — so its mark is not this
		// publish's to drop, however certainly the file was sent.
		await kit.changes.mark('index.html', 'written');

		await publish(kit);

		expect(await kit.changes.localChanges()).toEqual({ written: ['index.html'], deleted: [] });
	});

	// ⚠ **A deletion is a mark the Baseline accounts for by *not* holding the path.** A Project
	// deleted here is removed on the Remote by the mirror, so leaving its mark standing would report
	// `Changes to publish` forever over a path neither side has any more.
	it('clears the mark of a Project the mirror took down', async () => {
		const kit = await workspace();
		await publish(kit);
		await kit.store.delete('amsterdam-1625/annotations/notes.json' as StorePath);
		await kit.changes.mark('amsterdam-1625/annotations/notes.json', 'deleted');

		const published = await publish(kit);

		expect(published.shared).toContain('amsterdam-1625/annotations/notes.json');
		expect(await kit.changes.localChanges()).toEqual({ written: [], deleted: [] });
		expect([...kit.github.files().keys()]).not.toContain('amsterdam-1625/annotations/notes.json');
	});

	// Stale evidence is never retained, and this is that rule's counterpart on the index. Under a
	// refused Baseline write there is nothing left to compare the marks against, so dropping them would
	// report a Workspace full of unpublished work as having none.
	it('keeps every mark when the Baseline could not be stored', async () => {
		const kit = await workspace();
		await kit.changes.mark('amsterdam-1625/project.json', 'written');
		kit.storage.refuseWrites.add(baselineKey(WORKSPACE));

		const published = await publish(kit);

		expect(published.baselineKept).toBe(false);
		expect((await kit.changes.localChanges()).written).toEqual(['amsterdam-1625/project.json']);
	});
});

// If durable Baseline storage fails after Remote publication succeeds, the Publish succeeded and the
// status is now Cannot tell: never the Publish reported as failed, and never stale evidence retained.
describe('a Publish whose Remote commit succeeded and whose record did not', () => {
	it('is a successful publication with no evidence, and never a failure', async () => {
		const kit = await workspace();
		const first = await publish(kit);
		await kit.store.write('amsterdam-1625/project.json', encode('{"formatVersion":1,"name":"A2"}'));
		kit.storage.refuseWrites.add(baselineKey(WORKSPACE));

		const second = await publish(kit);

		expect(second.baselineKept).toBe(false);
		expect(second.commit).not.toBe(first.commit);
		// The publication itself: the branch moved and the Remote holds the new bytes.
		expect(kit.github.head()).toBe(second.commit);
		expect(decode(kit.github.files().get('amsterdam-1625/project.json') ?? EMPTY)).toBe(
			'{"formatVersion":1,"name":"A2"}'
		);
		// ⚠ **And the *previous* publish's record is gone rather than left standing.** A reader cannot
		// tell a stale map from a current one, so keeping it would make every path this publish
		// legitimately changed come back as somebody else's work on the next press.
		expect(await believed(kit)).toBeNull();
	});
});

// Each of these leaves the Baseline exactly as the last successful publish left it,
// and the check is the persisted record rather than a returned value: evidence advanced from a
// forecast is evidence about a transfer that never happened.
describe('a Publish that failed', () => {
	/** A Workspace with one published state behind it, and an unpublished edit in front of it. */
	const withWorkToSend = async () => {
		const kit = await workspace();
		const first = await publish(kit);
		await kit.store.write('amsterdam-1625/project.json', encode('{"formatVersion":1,"name":"A2"}'));
		return { kit, first };
	};

	it('leaves the Baseline unchanged when the account cannot push', async () => {
		const { kit, first } = await withWorkToSend();
		kit.github.permissions = { push: false, admin: false };
		const before = snapshot(kit);

		const refusal = await publish(kit).catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(RemotePublishRefusedError);
		expect(refusal instanceof Error ? refusal.message : '').toContain('cannot push');
		// ⚠ **Before the upload begins**, and that is the point: not one blob was posted, so the author is
		// not waiting on a transfer that cannot complete.
		expect(snapshot(kit)).toEqual(before);
		expect((await believed(kit))?.commit).toBe(first.commit);
	});

	it('leaves the Baseline unchanged when the sign-in has expired', async () => {
		const { kit, first } = await withWorkToSend();
		kit.github.rejectCredential = true;

		await expect(publish(kit)).rejects.toThrow(RemotePublishFailedError);

		expect((await believed(kit))?.commit).toBe(first.commit);
	});

	it('leaves the Baseline unchanged when the tree listing came back truncated', async () => {
		const { kit, first } = await withWorkToSend();
		kit.github.truncateAfter = 2;

		await expect(publish(kit)).rejects.toThrow(RemotePublishRefusedError);

		expect((await believed(kit))?.commit).toBe(first.commit);
	});

	// Blobs, tree, commit and ref alike: `refuseWrites` is the whole set, because that is what a
	// credential without `contents: write` meets once the upload has started.
	it('leaves the Baseline unchanged when a write phase is refused part way', async () => {
		const { kit, first } = await withWorkToSend();
		kit.github.refuseWrites = true;
		const head = kit.github.head();

		await expect(publish(kit)).rejects.toThrow(RemotePublishFailedError);

		expect(kit.github.head()).toBe(head);
		expect((await believed(kit))?.commit).toBe(first.commit);
		expect(decode(kit.github.files().get('amsterdam-1625/project.json') ?? EMPTY)).toBe(
			'{"formatVersion":1,"name":"Amsterdam"}'
		);
	});

	// The last request a publish makes, and the one moment anything becomes visible. Every blob, the
	// tree and the commit have landed; the branch has not moved, so the Published Site is exactly as
	// it was — and evidence recorded from the commit that was written rather than the ref that moved
	// would claim a publication no Reader can see.
	it('leaves the Baseline unchanged when the ref would not move', async () => {
		const { kit, first } = await withWorkToSend();
		const upstream = kit.github.fetch;
		const refusingTheRefMove: FetchFn = async (input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (init?.method === 'PATCH' && url.includes('/git/refs/')) {
				return new Response(JSON.stringify({ message: 'Update is not a fast forward' }), {
					status: 422
				});
			}
			return upstream(input, init);
		};

		await expect(
			publishWorkspaceToRemote(kit.store, {
				token: TOKEN,
				remote: REMOTE,
				metadata: kit.metadata,
				changes: kit.changes,
				fetch: refusingTheRefMove
			})
		).rejects.toThrow(RemotePublishFailedError);

		expect(kit.github.head()).toBe(first.commit);
		expect((await believed(kit))?.commit).toBe(first.commit);
	});
});
