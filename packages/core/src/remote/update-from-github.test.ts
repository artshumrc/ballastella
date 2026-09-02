// Seam 1 for Update from GitHub: the inbound engine against the shared fake GitHub, with no browser.
//
// What is asserted is what arrived and what did not — the bytes in the Workspace, the Baseline the
// caller is handed, and the fake's own counters — rather than which calls were made in which order.
// The counters are the exception, and they are counters of *requests* because the two properties they
// pin are invisible in the result: an Update that downloaded a Published Site and then declined to
// write it leaves a Workspace identical to one that never asked for it, and an Update that sent a
// blob leaves a Remote whose head has not moved.
//
// ⚠ **Every refusal is asserted against a complete before-snapshot of the Workspace**, not against
// the one path the refusal names. Half of the failures this engine can have are silent and plausible,
// and the only assertion that catches "it put back the file it named and left the other three" is the
// whole directory compared with the whole directory.

import { describe, expect, it } from 'vitest';

import { newAnnotationLayer, newMapLayer } from '../project/layer.js';
import { newProjectFile, serialiseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import type { RemoteRelationship, SynchronizationBaseline } from './synchronization-metadata.js';
import {
	UPDATE_BEFORE_DIRECTORY,
	UPDATE_TRANSACTION_FORMAT_VERSION,
	UPDATE_TRANSACTION_PATH,
	UpdateRefusedError,
	recoverWorkspaceUpdate,
	serialiseUpdateTransaction,
	updateFromGitHub
} from './update-from-github.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE: RemoteRelationship = { owner: OWNER, repository: REPOSITORY, branch: 'main' };

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** A `project.json` with the Layers given, as bytes a real serialiser produced. */
const projectFile = (
	name: string,
	layers: Parameters<typeof serialiseProjectFile>[0]['layers'] = []
): string =>
	decode(serialiseProjectFile({ ...newProjectFile(name, new Date('2026-01-01')), layers }));

const AMSTERDAM = projectFile('Amsterdam 1625', [
	newMapLayer({ id: 'l1', name: 'The sheet', imageId: 'map-1' }),
	newAnnotationLayer({ id: 'l2', name: 'Warehouses' })
]);

/**
 * A Workspace both sides hold, byte for byte: one Project, its Annotation, a Map Image and its
 * Alignment.
 *
 * Deliberately a *complete* graph, so that every refusal below is about the thing it is named for
 * rather than about a Project that was never valid.
 */
const SHARED: Record<string, string> = {
	'amsterdam-1625/project.json': AMSTERDAM,
	'amsterdam-1625/annotations/l2.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/map-1/info.json': '{"width":1024,"height":768}',
	'images/map-1/0/0/0.jpg': 'tile-zero',
	// alignment-write-is-the-fixture: the Alignment as it sits on both sides, seeded into the fake and the store rather than written by the code under test
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[]}'
};

/** A second Project, so a deletion that takes one whole Project can be seen not to take the other. */
const DELFT: Record<string, string> = {
	'delft/project.json': projectFile('Delft 1650', [
		newAnnotationLayer({ id: 'l3', name: 'Canals' })
	]),
	'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":[]}'
};

/** What a Publish generates, and what the scholar's own repository holds beside it. */
const NOT_SOURCE: Record<string, string> = {
	'index.html': '<!doctype html><title>Atlas</title>',
	'_app/immutable/app.js': 'export const start = () => {};',
	'ballastella-site.json': '{"formatVersion":2}',
	'.nojekyll': '',
	'README.md': '# Atlas, by hand\n',
	CNAME: 'atlas.example\n',
	'.github/workflows/pages.yml': 'name: pages\n'
};

const github = (files: Record<string, string>): Promise<FakeGitHub> =>
	createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: files });

/** A store holding `files`, seeded directly rather than through the engine. */
async function workspace(files: Record<string, string>): Promise<MemoryProjectStore> {
	const store = new MemoryProjectStore();
	for (const [path, text] of Object.entries(files)) {
		// alignment-write-is-the-fixture: seeding the Workspace a test starts from, not a write under test
		await store.write(path as StorePath, encode(text));
	}
	return store;
}

/** Every path in a store with its bytes as text: the before-and-after snapshot every refusal gets. */
async function snapshot(store: ProjectStore): Promise<Record<string, string>> {
	const held: Record<string, string> = {};
	for (const path of await store.list('')) held[path] = decode(await store.read(path));
	return held;
}

const shas = async (files: Record<string, string>): Promise<Map<string, string>> => {
	const map = new Map<string, string>();
	for (const [path, text] of Object.entries(files)) map.set(path, await gitBlobSha(encode(text)));
	return map;
};

/** A Baseline recording exactly `files` as the state the two sides last shared. */
const baselineOf = async (files: Record<string, string>): Promise<SynchronizationBaseline> => ({
	remote: REMOTE,
	commit: 'c0ffee',
	files: await shas(files)
});

/** The source half of {@link SHARED}: a Baseline an Open would have written. */
const sharedBaseline = () => baselineOf(SHARED);

const update = (store: ProjectStore, fake: FakeGitHub, baseline: SynchronizationBaseline | null) =>
	updateFromGitHub(store, { remote: REMOTE, baseline, fetch: fake.fetch });

/** The refusal an Update raised, having asserted it raised one at all. */
async function refusal(run: Promise<unknown>): Promise<UpdateRefusedError> {
	const caught = await run.then(
		() => null,
		(cause: unknown) => cause
	);
	if (!(caught instanceof UpdateRefusedError)) {
		throw new Error(`expected an UpdateRefusedError, got ${String(caught)}`);
	}
	return caught;
}

/**
 * `fake.fetch`, with one raw-host path answered by hand.
 *
 * The tree listing is left alone, so the file is still *named* and only its bytes go wrong — which is
 * the only way this engine fails after it has begun writing, and the only way to reach the rollback.
 */
function rawAnswer(fake: FakeGitHub, path: string, answer: () => Response): FetchFn {
	return (input, init) =>
		String(input).endsWith(`/${path}`) ? Promise.resolve(answer()) : fake.fetch(input, init);
}

describe('updateFromGitHub', () => {
	it('brings every kind of Remote-only source addition in byte for byte', async () => {
		const added = {
			'delft/project.json': projectFile('Delft', [newAnnotationLayer({ id: 'n1', name: 'Notes' })]),
			'delft/annotations/n1.geojson': '{"type":"FeatureCollection","features":[{"id":"theirs"}]}',
			'images/map-2/info.json': '{"width":512,"height":512}',
			'images/map-2/0/0/0.jpg': 'another-tile',
			// An Offline Copy: a pyramid whose `remote.json` records the Library it was copied from.
			'images/map-3/info.json': '{"width":256,"height":256}',
			'images/map-3/remote.json': '{"formatVersion":1,"service":"https://library.example/iiif"}',
			// alignment-write-is-the-fixture: the Remote's Alignment for the new Map Image, seeded into the fake
			'alignments/map-2.json': '{"formatVersion":1,"controlPoints":[{"id":"cp1"}]}',
			'base-map/tiles/3/4/5.pbf': 'offline-base-map-tile'
		};
		const fake = await github({ ...SHARED, ...NOT_SOURCE, ...added });
		const store = await workspace({ ...SHARED, ...NOT_SOURCE });

		const result = await update(store, fake, await sharedBaseline());

		expect(result.added).toEqual(Object.keys(added).sort());
		expect(result.replaced).toEqual([]);
		for (const [path, text] of Object.entries(added)) {
			expect(decode(await store.read(path as StorePath))).toBe(text);
		}
	});

	it('never downloads generated Published Site output or the repository’s own files', async () => {
		// Both sides hold the source identically; only the site and the scholar's own files differ, and
		// neither is a reason to fetch anything at all.
		const fake = await github({
			...SHARED,
			...NOT_SOURCE,
			'index.html': '<!doctype html><title>Atlas, rebuilt by another editor</title>',
			'_app/immutable/app.other.js': 'export const start = () => {};',
			'README.md': '# Atlas, edited on github.com\n'
		});
		const store = await workspace({ ...SHARED, ...NOT_SOURCE });
		const before = await snapshot(store);

		const result = await update(store, fake, await sharedBaseline());

		expect(result.added).toEqual([]);
		expect(result.replaced).toEqual([]);
		// Not one byte read from the raw host, which is the only assertion that can tell "downloaded
		// and discarded" from "never asked for".
		expect(fake.rawGets).toBe(0);
		expect(await snapshot(store)).toEqual(before);
		expect(result.notice).toContain('nothing has been downloaded');
	});

	it('replaces a locally unchanged file with the Remote’s bytes', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({
			'amsterdam-1625/annotations/l2.geojson':
				'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}',
			// ⚠ **An Alignment among them**, so the `replace` intent through the one writer (ADR-0023) is
			// asserted as *written* rather than only as rolled back: it is the path where Control Points
			// somebody placed are at stake, and the writer's other two intents both decline instead.
			// alignment-write-is-the-fixture: the Remote's own Alignment, committed into the fake GitHub rather than into any Workspace
			'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[{"id":"theirs"}]}'
		});

		const result = await update(store, fake, baseline);

		expect(result.replaced).toEqual([
			'alignments/map-1.json',
			'amsterdam-1625/annotations/l2.geojson'
		]);
		expect(decode(await store.read('amsterdam-1625/annotations/l2.geojson' as StorePath))).toBe(
			'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}'
		);
		expect(decode(await store.read('alignments/map-1.json' as StorePath))).toBe(
			'{"formatVersion":1,"controlPoints":[{"id":"theirs"}]}'
		);
		// And nothing of the transaction is left behind.
		expect(await store.list(UPDATE_BEFORE_DIRECTORY)).toEqual([]);
		expect(await store.list(UPDATE_TRANSACTION_PATH)).toEqual([]);
	});

	it('leaves a local-only change on another path exactly as it was, and says so', async () => {
		const mine = '{"type":"FeatureCollection","features":[{"id":"mine, unpublished"}]}';
		const fake = await github(SHARED);
		const store = await workspace({ ...SHARED, 'amsterdam-1625/annotations/l2.geojson': mine });
		const baseline = await sharedBaseline();
		await fake.commitFiles({ 'images/map-1/0/0/1.jpg': 'a tile they added' });

		const result = await update(store, fake, baseline);

		expect(result.added).toEqual(['images/map-1/0/0/1.jpg']);
		expect(result.retained).toEqual(['amsterdam-1625/annotations/l2.geojson']);
		expect(decode(await store.read('amsterdam-1625/annotations/l2.geojson' as StorePath))).toBe(
			mine
		);
		expect(result.notice).toContain('Nothing has been published');
	});

	it('advances the Baseline only for the paths now shared', async () => {
		const mine = '{"type":"FeatureCollection","features":[{"id":"mine"}]}';
		const theirs = 'a tile they added';
		const fake = await github(SHARED);
		const store = await workspace({ ...SHARED, 'amsterdam-1625/annotations/l2.geojson': mine });
		const baseline = await sharedBaseline();
		await fake.commitFiles({ 'images/map-1/0/0/1.jpg': theirs });

		const result = await update(store, fake, baseline);

		// The inbound path is recorded at the Remote's SHA; the local-only path keeps the SHA the
		// Baseline already had, which is what leaves it reporting as Changes to publish.
		expect(result.baseline.get('images/map-1/0/0/1.jpg')).toBe(await gitBlobSha(encode(theirs)));
		expect(result.baseline.get('amsterdam-1625/annotations/l2.geojson')).toBe(
			baseline.files.get('amsterdam-1625/annotations/l2.geojson')
		);
		expect(result.baseline.get('amsterdam-1625/annotations/l2.geojson')).not.toBe(
			await gitBlobSha(encode(mine))
		);
		// And only the shared paths may have their local-change marks cleared.
		expect(result.shared).not.toContain('amsterdam-1625/annotations/l2.geojson');
		expect(result.shared).toContain('images/map-1/0/0/1.jpg');
	});

	it('sends nothing to GitHub and leaves the Remote exactly where it was', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({ 'delft/project.json': projectFile('Delft') });
		const head = fake.head();
		const files = fake.files();

		await update(store, fake, baseline);

		expect(fake.blobPosts).toBe(0);
		expect(fake.head()).toBe(head);
		expect(fake.files()).toEqual(files);
	});

	it('updates a public Remote the signed-in account cannot push to, with no credential at all', async () => {
		const fake = await github(SHARED);
		fake.permissions = { push: false, admin: false };
		// Every credential this fake is shown is refused, so a request that carried one would fail.
		fake.rejectCredential = true;
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({ 'delft/project.json': projectFile('Delft') });

		const credentialed: string[] = [];
		const fetch: FetchFn = (input, init) => {
			const headers = new Headers(init?.headers ?? {});
			if (headers.has('Authorization')) credentialed.push(String(input));
			return fake.fetch(input, init);
		};

		const result = await updateFromGitHub(store, { remote: REMOTE, baseline, fetch });

		expect(result.added).toEqual(['delft/project.json']);
		expect(credentialed).toEqual([]);
	});

	it('reports progress per file, ending on the count it started against', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({
			'images/map-1/0/0/1.jpg': 'one',
			'images/map-1/0/0/2.jpg': 'two'
		});

		const seen: { files: number; totalFiles: number; path: string | null }[] = [];
		await updateFromGitHub(store, {
			remote: REMOTE,
			baseline,
			fetch: fake.fetch,
			onProgress: ({ files, totalFiles, path }) => seen.push({ files, totalFiles, path })
		});

		expect(seen[0]).toEqual({ files: 0, totalFiles: 2, path: null });
		expect(seen.at(-1)).toEqual({ files: 2, totalFiles: 2, path: null });
		expect(
			seen
				.filter((step) => step.path !== null)
				.map((step) => step.path)
				.sort()
		).toEqual(['images/map-1/0/0/1.jpg', 'images/map-1/0/0/2.jpg']);
	});

	// ── Refusals, each against a complete before-snapshot ─────────────────────────────────────

	it('refuses a path changed differently on both sides and changes neither', async () => {
		const fake = await github(SHARED);
		const store = await workspace({
			...SHARED,
			'amsterdam-1625/annotations/l2.geojson': '{"features":["mine"]}'
		});
		const baseline = await sharedBaseline();
		await fake.commitFiles({
			'amsterdam-1625/annotations/l2.geojson': '{"features":["theirs"]}'
		});
		const before = await snapshot(store);
		const head = fake.head();

		const refused = await refusal(update(store, fake, baseline));

		expect(refused.refusal).toBe('conflict');
		expect(refused.paths).toEqual(['amsterdam-1625/annotations/l2.geojson']);
		expect(await snapshot(store)).toEqual(before);
		expect(fake.head()).toBe(head);
		expect(fake.rawGets).toBe(0);
	});

	// ── Deletions, which are named on the Sync modal rather than confirmed here ────────────────
	//
	// There is no confirmer to pass any more (ADR-0044): every path a get would remove is on the modal
	// the author read before pressing, so what a test asserts is what the Workspace holds afterwards.

	it('removes a locally unchanged path the Remote deleted', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		// A deletion and an addition together: one operation, and the whole of it applies.
		await fake.commitFiles({
			'images/map-1/0/0/0.jpg': null,
			'images/map-1/0/0/1.jpg': 'a tile they added'
		});

		const result = await update(store, fake, baseline);

		const kept = Object.fromEntries(
			Object.entries(SHARED).filter(([path]) => path !== 'images/map-1/0/0/0.jpg')
		);
		expect(await snapshot(store)).toEqual({
			...kept,
			'images/map-1/0/0/1.jpg': 'a tile they added'
		});
		expect(result.removed).toEqual(['images/map-1/0/0/0.jpg']);
		expect(result.added).toEqual(['images/map-1/0/0/1.jpg']);
		// The Baseline no longer claims the two sides share the deleted path, so it cannot come back.
		expect(result.baseline.has('images/map-1/0/0/0.jpg')).toBe(false);
		expect(result.baseline.get('images/map-1/0/0/1.jpg')).toBe(
			await gitBlobSha(encode('a tile they added'))
		);
		expect(result.notice).toContain('Removed 1 file');
		// And nothing of the transaction is left behind.
		expect(await store.list(UPDATE_BEFORE_DIRECTORY)).toEqual([]);
		expect(await store.list(UPDATE_TRANSACTION_PATH)).toEqual([]);
	});

	// ⚠ **The removal rule, from the inbound side.** A path the Baseline never recorded is not a
	// deletion however absent it is from the Remote's tree: with no Baseline there is nothing to
	// remove at all, which is what makes a first get against a populated repository safe.
	it('removes nothing at all with no record of what the two sides last shared', async () => {
		const fake = await github(SHARED);
		const store = await workspace({ ...SHARED, ...DELFT });
		await fake.commitFiles({ 'images/map-1/0/0/0.jpg': null });
		const before = await snapshot(store);

		const result = await update(store, fake, null);

		expect(result.removed).toEqual([]);
		expect(await snapshot(store)).toEqual(before);
	});

	it('never removes a deleted path this Workspace changed: that is a Conflict', async () => {
		const fake = await github(SHARED);
		const store = await workspace({
			...SHARED,
			'amsterdam-1625/annotations/l2.geojson': '{"features":["my afternoon"]}'
		});
		const baseline = await sharedBaseline();
		await fake.commitFiles({ 'amsterdam-1625/annotations/l2.geojson': null });
		const before = await snapshot(store);

		const refused = await refusal(update(store, fake, baseline));

		expect(refused.refusal).toBe('conflict');
		expect(refused.paths).toEqual(['amsterdam-1625/annotations/l2.geojson']);
		expect(await snapshot(store)).toEqual(before);
	});

	it('refuses a combination that would leave the Workspace incomplete', async () => {
		// The Layer's Annotation is deleted here and its `project.json` is unchanged on both sides — so
		// no single path changed on both sides and the result is a Project that cannot draw.
		const fake = await github({
			...SHARED,
			'amsterdam-1625/project.json': projectFile('Amsterdam 1625', [
				newAnnotationLayer({ id: 'l9', name: 'Newly needed' })
			])
		});
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		const before = await snapshot(store);

		const refused = await refusal(update(store, fake, baseline));

		// `'invalid'` rather than `'conflict'`: no single path changed on both sides, and what is
		// wrong is the Workspace the combination would leave rather than an argument about bytes.
		expect(refused.refusal).toBe('invalid');
		expect(refused.paths).toEqual(['amsterdam-1625/annotations/l9.geojson']);
		expect(await snapshot(store)).toEqual(before);
	});

	it('refuses a Project on the Remote this build cannot read', async () => {
		const fake = await github({
			...SHARED,
			'amsterdam-1625/project.json': JSON.stringify({ formatVersion: 99, name: 'From the future' })
		});
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		const before = await snapshot(store);

		const refused = await refusal(update(store, fake, baseline));

		expect(refused.refusal).toBe('unsupported');
		expect(refused.message).toContain('newer version of Ballastella');
		expect(await snapshot(store)).toEqual(before);
	});

	it('refuses a Project on the Remote that is not a Project at all', async () => {
		const fake = await github({ ...SHARED, 'amsterdam-1625/project.json': 'not json' });
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		const before = await snapshot(store);

		const refused = await refusal(update(store, fake, baseline));

		expect(refused.refusal).toBe('invalid');
		expect(await snapshot(store)).toEqual(before);
	});

	it('refuses a file the tree listed and the host would not serve', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({
			'images/map-1/0/0/1.jpg': 'one',
			'amsterdam-1625/annotations/l2.geojson': '{"features":["theirs"]}'
		});
		const before = await snapshot(store);

		const refused = await refusal(
			updateFromGitHub(store, {
				remote: REMOTE,
				baseline,
				fetch: rawAnswer(fake, 'images/map-1/0/0/1.jpg', () => new Response('', { status: 404 }))
			})
		);

		expect(refused.refusal).toBe('incomplete');
		// ⚠ The whole Workspace, because the replacement in the same plan may already have landed: what
		// this asserts is that the *before-image* went back, not merely that the missing file is absent.
		expect(await snapshot(store)).toEqual(before);
	});

	it('refuses bytes that are not the ones the file list named, and puts the replacement back', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({
			// alignment-write-is-the-fixture: the Remote's own Alignment, committed into the fake GitHub rather than into any Workspace
			'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[{"id":"theirs"}]}',
			'images/map-1/0/0/1.jpg': 'one'
		});
		const before = await snapshot(store);

		const refused = await refusal(
			updateFromGitHub(store, {
				remote: REMOTE,
				baseline,
				fetch: rawAnswer(
					fake,
					'images/map-1/0/0/1.jpg',
					() => new Response('a rewritten copy from a proxy')
				)
			})
		);

		expect(refused.refusal).toBe('incomplete');
		expect(refused.message).toContain('different bytes');
		expect(await snapshot(store)).toEqual(before);
	});

	it('puts every replaced path back when a write into the Workspace fails', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({
			'amsterdam-1625/annotations/l2.geojson': '{"features":["theirs"]}',
			'images/map-1/info.json': '{"width":2048,"height":1536}',
			'images/map-1/0/0/1.jpg': 'one'
		});
		const before = await snapshot(store);

		// Far enough in that the marker, the before-images and at least one replacement have landed.
		store.failWriteAt(5, 'rename');
		const refused = await refusal(update(store, fake, baseline));

		expect(refused.refusal).toBe('write-failed');
		expect(await snapshot(store)).toEqual(before);
	});

	it('refuses when the commit it planned against can no longer be listed', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({ 'images/map-1/0/0/1.jpg': 'one' });
		const before = await snapshot(store);

		// A force-push and a collection: the ref answers, and the commit it named is gone. The engine
		// pins every read to one commit, so this is the shape a branch moving under it takes.
		const fetch: FetchFn = (input, init) =>
			String(input).includes('/git/trees/')
				? Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }))
				: fake.fetch(input, init);

		const refused = await refusal(updateFromGitHub(store, { remote: REMOTE, baseline, fetch }));

		expect(refused.refusal).toBe('no-repository');
		expect(await snapshot(store)).toEqual(before);
	});

	it('refuses a truncated file list rather than treat the rest as deleted', async () => {
		const fake = await github(SHARED);
		fake.truncateAfter = 2;
		const store = await workspace(SHARED);
		const before = await snapshot(store);

		const refused = await refusal(update(store, fake, await sharedBaseline()));

		expect(refused.refusal).toBe('truncated');
		expect(await snapshot(store)).toEqual(before);
	});

	it('refuses a Workspace it cannot read, rather than plan from a partial one', async () => {
		const fake = await github(SHARED);
		const backing = await workspace(SHARED);
		const baseline = await sharedBaseline();
		await fake.commitFiles({ 'images/map-1/0/0/1.jpg': 'one' });
		// A file the Workspace lists and will not hand over. Read as "not there", it would be an
		// inbound addition rather than a local file nobody can vouch for — so the whole pass refuses.
		const store: ProjectStore = {
			...backing,
			list: (prefix) => backing.list(prefix),
			read: (path) =>
				path === 'images/map-1/info.json'
					? Promise.reject(new Error('the folder was unmounted'))
					: backing.read(path),
			write: (path, bytes) => backing.write(path, bytes),
			delete: (path) => backing.delete(path),
			size: (path) => backing.size(path),
			reclaimAbandonedWrites: (prefix) => backing.reclaimAbandonedWrites(prefix)
		};
		const before = await snapshot(backing);

		const refused = await refusal(update(store, fake, baseline));

		expect(refused.refusal).toBe('unreadable');
		expect(refused.paths).toEqual(['images/map-1/info.json']);
		expect(await snapshot(backing)).toEqual(before);
	});

	// ── No Baseline ───────────────────────────────────────────────────────────────────────────

	it('takes a whole Remote into a Workspace that holds no source at all', async () => {
		const fake = await github(SHARED);
		const store = await workspace({});

		const result = await update(store, fake, null);

		expect(result.added).toEqual(Object.keys(SHARED).sort());
		expect([...result.baseline.keys()].sort()).toEqual(Object.keys(SHARED).sort());
	});

	it('refuses a path the two non-empty sides hold differently as a Conflict', async () => {
		const fake = await github(SHARED);
		const store = await workspace({
			...SHARED,
			'amsterdam-1625/annotations/l2.geojson': '{"features":["mine"]}'
		});
		const before = await snapshot(store);

		const refused = await refusal(update(store, fake, null));

		expect(refused.refusal).toBe('conflict');
		expect(refused.paths).toEqual(['amsterdam-1625/annotations/l2.geojson']);
		expect(await snapshot(store)).toEqual(before);
	});

	it('brings in what the Remote has and this Workspace has not, with no Baseline at all', async () => {
		const fake = await github({ ...SHARED, ...DELFT });
		const store = await workspace(SHARED);

		const result = await update(store, fake, null);

		expect(result.added).toEqual(Object.keys(DELFT).sort());
		expect(result.removed).toEqual([]);
	});

	// ── The transaction, resolved before anything is planned ──────────────────────────────────

	const marker = (state: 'writing' | 'committed', body: Record<string, unknown>) =>
		serialiseUpdateTransaction({
			formatVersion: UPDATE_TRANSACTION_FORMAT_VERSION,
			transaction: 'interrupted',
			workspace: 'Atlas',
			state,
			commit: 'c0ffee',
			added: [],
			replaced: [],
			deleted: [],
			startedAt: '2026-08-01T09:00:00.000Z',
			...body
		} as Parameters<typeof serialiseUpdateTransaction>[0]);

	it('rolls back an Update a dead tab left half written, before planning another', async () => {
		const fake = await github(SHARED);
		const store = await workspace({
			...SHARED,
			// What the interrupted Update had done: one path replaced, one added, one before-image kept.
			'amsterdam-1625/annotations/l2.geojson': '{"features":["half-arrived"]}',
			'images/map-1/0/0/9.jpg': 'half-arrived',
			[`${UPDATE_BEFORE_DIRECTORY}0`]: '{"type":"FeatureCollection","features":[]}'
		});
		// alignment-write-is-the-fixture: seeding the interrupted Update's own marker, not a write under test
		await store.write(
			UPDATE_TRANSACTION_PATH,
			marker('writing', {
				added: ['images/map-1/0/0/9.jpg'],
				replaced: [
					{ path: 'amsterdam-1625/annotations/l2.geojson', image: `${UPDATE_BEFORE_DIRECTORY}0` }
				]
			})
		);

		const result = await update(store, fake, await sharedBaseline());

		expect(await snapshot(store)).toEqual(SHARED);
		expect(result.added).toEqual([]);
	});

	it('sweeps an Update that was durably committed, keeping every byte of it', async () => {
		const arrived = { ...SHARED, 'images/map-1/0/0/9.jpg': 'arrived and durable' };
		const store = await workspace({
			...arrived,
			[`${UPDATE_BEFORE_DIRECTORY}0`]: 'the bytes it replaced'
		});
		// alignment-write-is-the-fixture: seeding a committed marker, not a write under test
		await store.write(
			UPDATE_TRANSACTION_PATH,
			marker('committed', {
				added: ['images/map-1/0/0/9.jpg'],
				replaced: [{ path: 'images/map-1/info.json', image: `${UPDATE_BEFORE_DIRECTORY}0` }]
			})
		);

		const recovery = await recoverWorkspaceUpdate(store);

		expect(recovery).toEqual({ outcome: 'completed', transaction: 'interrupted' });
		expect(await snapshot(store)).toEqual(arrived);
	});

	it('will not start an Update over a record of one it cannot read', async () => {
		const fake = await github(SHARED);
		const store = await workspace(SHARED);
		// alignment-write-is-the-fixture: seeding an unreadable marker, not a write under test
		await store.write(UPDATE_TRANSACTION_PATH, encode('{ not a marker'));

		const refused = await refusal(update(store, fake, await sharedBaseline()));

		expect(refused.refusal).toBe('unresolved-transaction');
		// The marker is left exactly where it is, so the next attempt works from the same inventory.
		expect(await store.list(UPDATE_TRANSACTION_PATH)).toEqual([UPDATE_TRANSACTION_PATH]);
	});
});
