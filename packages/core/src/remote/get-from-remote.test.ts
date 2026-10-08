import { describe, expect, it } from 'vitest';

import { newAlignment, type ControlPoint } from '../alignment/alignment.js';
import { serialiseAlignment } from '../alignment/georeference-annotation.js';
import { newAnnotationLayer, newMapLayer } from '../project/layer.js';
import { parseProjectFile } from '../project/project-file.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import type { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import { decode, encode, rejection, seeded as workspace, snapshot } from '../test-support.js';
import { gitBlobSha } from './blob-sha.js';
import { compareWorkspace } from './synchronization-planner.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import {
	ATLAS as REMOTE,
	baselineOf,
	inventory,
	projectFile,
	rawAnswer,
	shas,
	storedText
} from './remote-test-support.js';
import { readAlignmentQuestions, type AlignmentQuestion } from './conflict-resolution.js';
import { getFromRemote } from './get-from-remote.js';
import {
	UPDATE_BEFORE_DIRECTORY,
	UPDATE_TRANSACTION_FORMAT_VERSION,
	UPDATE_TRANSACTION_PATH,
	UpdateRefusedError,
	recoverWorkspaceUpdate,
	serialiseUpdateTransaction
} from './update-transaction.js';

const AMSTERDAM = projectFile('Amsterdam 1625', [
	newMapLayer({ id: 'l1', name: 'The sheet', imageId: 'map-1' }),
	newAnnotationLayer({ id: 'l2', name: 'Warehouses' })
]);

const NOTES = 'amsterdam-1625/annotations/l2.geojson';
const TILE_0 = 'images/map-1/0/0/0.jpg';
const TILE_1 = 'images/map-1/0/0/1.jpg';

const SHARED: Record<string, string> = {
	'amsterdam-1625/project.json': AMSTERDAM,
	[NOTES]: '{"type":"FeatureCollection","features":[]}',
	'images/map-1/info.json': '{"width":1024,"height":768}',
	[TILE_0]: 'tile-zero',
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[]}'
};

const DELFT: Record<string, string> = {
	'delft/project.json': projectFile('Delft 1650', [
		newAnnotationLayer({ id: 'l3', name: 'Canals' })
	]),
	'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":[]}'
};

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
	createFakeGitHub({ ...REMOTE, tree: files });

const withoutTile0 = (files: Record<string, string>) =>
	Object.fromEntries(Object.entries(files).filter(([path]) => path !== TILE_0));
const sharedBaseline = () => baselineOf(SHARED);

const fromShared = async (
	changes: Record<string, string | null> | null = null,
	local: Record<string, string> = SHARED
) => {
	const fake = await github(SHARED);
	const store = await workspace(local);
	if (changes !== null) await fake.commitFiles(changes);
	return { fake, store, baseline: await sharedBaseline() };
};

const update = (
	store: ProjectStore,
	fake: FakeGitHub,
	baseline: SynchronizationBaseline | null,
	options: Partial<Parameters<typeof getFromRemote>[1]> = {}
) => getFromRemote(store, { remote: REMOTE, token: null, baseline, fetch: fake.fetch, ...options });

const refusal = (run: Promise<unknown>): Promise<UpdateRefusedError> =>
	rejection(UpdateRefusedError, run);

async function refusedLeaving(
	store: ProjectStore,
	run: () => Promise<unknown>
): Promise<UpdateRefusedError> {
	const before = await snapshot(store);
	const refused = await refusal(run());
	expect(await snapshot(store)).toEqual(before);
	return refused;
}

describe('getFromRemote', () => {
	it('brings every kind of Remote-only source addition in byte for byte', async () => {
		const added = {
			'delft/project.json': projectFile('Delft', [newAnnotationLayer({ id: 'n1', name: 'Notes' })]),
			'delft/annotations/n1.geojson': '{"type":"FeatureCollection","features":[{"id":"theirs"}]}',
			'images/map-2/info.json': '{"width":512,"height":512}',
			'images/map-2/0/0/0.jpg': 'another-tile',
			'images/map-3/info.json': '{"width":256,"height":256}',
			'images/map-3/remote.json': '{"formatVersion":1,"service":"https://library.example/iiif"}',
			'alignments/map-2.json': '{"formatVersion":1,"controlPoints":[{"id":"cp1"}]}',
			'base-map/tiles/3/4/5.pbf': 'offline-base-map-tile'
		};
		const fake = await github({ ...SHARED, ...NOT_SOURCE, ...added });
		const store = await workspace({ ...SHARED, ...NOT_SOURCE });
		const result = await update(store, fake, await sharedBaseline());
		expect([result.added, result.replaced]).toEqual([Object.keys(added).sort(), []]);
		for (const [path, text] of Object.entries(added)) {
			expect(await storedText(store, path)).toBe(text);
		}
	});

	it('never downloads generated Published Site output or the repository’s own files', async () => {
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
		expect([result.added, result.replaced, fake.rawGets]).toEqual([[], [], 0]);
		expect(await snapshot(store)).toEqual(before);
		expect(result.notice).toContain('nothing has been downloaded');
	});

	it('replaces and removes locally unchanged files as the Remote did, leaving no transaction', async () => {
		const theirs = '{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}';
		const alignment = '{"formatVersion":1,"controlPoints":[{"id":"theirs"}]}';
		const { fake, store, baseline } = await fromShared({
			[NOTES]: theirs,
			'alignments/map-1.json': alignment,
			[TILE_0]: null,
			[TILE_1]: 'a tile they added'
		});

		const result = await update(store, fake, baseline);

		expect(await snapshot(store)).toEqual({
			...withoutTile0(SHARED),
			[NOTES]: theirs,
			'alignments/map-1.json': alignment,
			[TILE_1]: 'a tile they added'
		});
		expect([result.replaced, result.removed, result.added]).toEqual([
			['alignments/map-1.json', NOTES],
			[TILE_0],
			[TILE_1]
		]);
		expect(result.baseline.has(TILE_0)).toBe(false);
		expect(result.baseline.get(TILE_1)).toBe(await gitBlobSha(encode('a tile they added')));
		expect(result.notice).toContain('Removed 1 file');
		expect(await store.list(UPDATE_BEFORE_DIRECTORY)).toEqual([]);
		expect(await store.list(UPDATE_TRANSACTION_PATH)).toEqual([]);
	});

	it('leaves a local-only change exactly as it was, says so, and advances only the shared paths', async () => {
		const mine = '{"type":"FeatureCollection","features":[{"id":"mine, unsent"}]}';
		const theirs = 'a tile they added';
		const { fake, store, baseline } = await fromShared(
			{ [TILE_1]: theirs },
			{ ...SHARED, [NOTES]: mine }
		);

		const result = await update(store, fake, baseline);
		expect([result.added, result.retained]).toEqual([[TILE_1], [NOTES]]);
		expect(await storedText(store, NOTES)).toBe(mine);
		expect(result.notice).toContain('Nothing has been sent');
		expect(result.baseline.get(TILE_1)).toBe(await gitBlobSha(encode(theirs)));
		expect(result.baseline.get(NOTES)).toBe(baseline.files.get(NOTES));
		expect(result.baseline.get(NOTES)).not.toBe(await gitBlobSha(encode(mine)));
		expect(result.shared).toContain(TILE_1);
		expect(result.shared).not.toContain(NOTES);
	});

	it('updates a Remote it cannot push to with no credential, sending nothing and moving nothing', async () => {
		const { fake, store, baseline } = await fromShared({
			'delft/project.json': projectFile('Delft')
		});
		fake.permissions = { push: false, admin: false };
		fake.rejectCredential = true;
		const head = fake.head();
		const files = fake.files();

		const credentialed: string[] = [];
		const fetch: FetchFn = (input, init) => {
			if (new Headers(init?.headers ?? {}).has('Authorization')) credentialed.push(String(input));
			return fake.fetch(input, init);
		};

		const result = await update(store, fake, baseline, { fetch });
		expect([result.added, credentialed, fake.blobPosts]).toEqual([['delft/project.json'], [], 0]);
		expect(fake.head()).toBe(head);
		expect(fake.files()).toEqual(files);
	});

	it('reports progress per file, ending on the count it started against', async () => {
		const { fake, store, baseline } = await fromShared({
			[TILE_1]: 'one',
			'images/map-1/0/0/2.jpg': 'two'
		});

		const seen: { files: number; totalFiles: number; path: string | null }[] = [];
		await update(store, fake, baseline, {
			onProgress: ({ files, totalFiles, path }) => seen.push({ files, totalFiles, path })
		});

		expect(seen[0]).toEqual({ files: 0, totalFiles: 2, path: null });
		expect(seen.at(-1)).toEqual({ files: 2, totalFiles: 2, path: null });
		expect(
			seen
				.filter((step) => step.path !== null)
				.map((step) => step.path)
				.sort()
		).toEqual([TILE_1, 'images/map-1/0/0/2.jpg']);
	});

	it('never removes a deleted path this Workspace changed: that is a Conflict', async () => {
		const { fake, store, baseline } = await fromShared(
			{ [NOTES]: null },
			{ ...SHARED, [NOTES]: '{"features":["my afternoon"]}' }
		);
		const before = await snapshot(store);
		const result = await update(store, fake, baseline);
		expect([result.removed, result.copies]).toEqual([[], []]);
		expect(await snapshot(store)).toEqual(before);
	});

	it.each([
		[
			'a combination that would leave the Workspace incomplete',
			projectFile('Amsterdam 1625', [newAnnotationLayer({ id: 'l9', name: 'Newly needed' })]),
			{ refusal: 'invalid', paths: ['amsterdam-1625/annotations/l9.geojson'] }
		],
		[
			'a Project this build cannot read',
			JSON.stringify({ formatVersion: 99, name: 'From the future' }),
			{ refusal: 'unsupported', message: expect.stringContaining('newer version of Ballastella') }
		],
		['a Project that is not a Project at all', 'not json', { refusal: 'invalid' }]
	])('refuses %s on the Remote', async (_case, project, expected) => {
		const fake = await github({ ...SHARED, 'amsterdam-1625/project.json': project });
		const store = await workspace(SHARED);
		const baseline = await sharedBaseline();
		const refused = await refusedLeaving(store, () => update(store, fake, baseline));
		expect(refused).toMatchObject(expected);
	});

	const notFound = () => new Response('{"message":"Not Found"}', { status: 404 });
	it.each<
		[
			string,
			string,
			(fake: FakeGitHub, store: MemoryProjectStore) => Partial<Parameters<typeof getFromRemote>[1]>,
			string?
		]
	>([
		[
			'a file the tree listed and the host would not serve',
			'incomplete',
			(fake) => ({ fetch: rawAnswer(fake, TILE_1, () => new Response('', { status: 404 })) })
		],
		[
			'bytes that are not the ones the file list named',
			'incomplete',
			(fake) => ({
				fetch: rawAnswer(fake, TILE_1, () => new Response('a rewritten copy from a proxy'))
			}),
			'different bytes'
		],
		[
			'a write into the Workspace that fails',
			'write-failed',
			(_fake, store) => {
				store.failWriteAt(5, 'rename');
				return {};
			}
		],
		[
			'a planned-against commit that can no longer be listed',
			'no-repository',
			(fake) => ({
				fetch: (input, init) =>
					String(input).includes('/git/trees/')
						? Promise.resolve(notFound())
						: fake.fetch(input, init)
			})
		],
		[
			'a truncated file list rather than treat the rest as deleted',
			'truncated',
			(fake) => {
				fake.truncateAfter = 2;
				return {};
			}
		]
	])(
		'refuses %s, leaving the Workspace as it was',
		async (_case, expected, arrange, message = '') => {
			const { fake, store, baseline } = await fromShared({
				[NOTES]: '{"features":["theirs"]}',
				'images/map-1/info.json': '{"width":2048,"height":1536}',
				'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[{"id":"theirs"}]}',
				[TILE_1]: 'one'
			});

			const refused = await refusedLeaving(store, () =>
				update(store, fake, baseline, arrange(fake, store))
			);
			expect(refused.refusal).toBe(expected);
			expect(refused.message).toContain(message);
		}
	);

	it('refuses a Workspace it cannot read, rather than plan from a partial one', async () => {
		const { fake, store: backing, baseline } = await fromShared({ [TILE_1]: 'one' });
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

		const refused = await refusedLeaving(backing, () => update(store, fake, baseline));
		expect([refused.refusal, refused.paths]).toEqual(['unreadable', ['images/map-1/info.json']]);
	});

	it('takes a whole Remote into a Workspace that holds no source at all', async () => {
		const fake = await github(SHARED);
		const store = await workspace({});
		const result = await update(store, fake, null);
		expect(result.added).toEqual(Object.keys(SHARED).sort());
		expect([...result.baseline.keys()].sort()).toEqual(Object.keys(SHARED).sort());
	});

	it('with no Baseline, brings in what only the Remote has and removes nothing', async () => {
		const fake = await github(withoutTile0({ ...SHARED, ...DELFT }));
		const store = await workspace(SHARED);
		const result = await update(store, fake, null);
		expect([result.added, result.removed]).toEqual([Object.keys(DELFT).sort(), []]);
		expect(await snapshot(store)).toEqual({ ...SHARED, ...DELFT });
	});

	it('copies a path the two non-empty sides hold differently, with no Baseline at all', async () => {
		const fake = await github(SHARED);
		const store = await workspace({ ...SHARED, [NOTES]: '{"features":["mine"]}' });

		const result = await update(store, fake, null);
		expect(result.copies.map((copy) => copy.name)).toEqual(['Warehouses (from GitHub)']);
		expect(await storedText(store, NOTES)).toBe('{"features":["mine"]}');
	});

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
			[NOTES]: '{"features":["half-arrived"]}',
			'images/map-1/0/0/9.jpg': 'half-arrived',
			[`${UPDATE_BEFORE_DIRECTORY}0`]: '{"type":"FeatureCollection","features":[]}'
		});
		await store.write(
			UPDATE_TRANSACTION_PATH,
			marker('writing', {
				added: ['images/map-1/0/0/9.jpg'],
				replaced: [{ path: NOTES, image: `${UPDATE_BEFORE_DIRECTORY}0` }]
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
		await store.write(UPDATE_TRANSACTION_PATH, encode('{ not a marker'));

		const refused = await refusal(update(store, fake, await sharedBaseline()));
		expect(refused.refusal).toBe('unresolved-transaction');
		expect(await store.list(UPDATE_TRANSACTION_PATH)).toEqual([UPDATE_TRANSACTION_PATH]);
	});
});

describe('a conflict becomes a copy', () => {
	it('adds theirs as a second Layer, keeps mine, moves everything else, and leaves both to send', async () => {
		const { fake, store, baseline } = await fromShared(
			{ [NOTES]: '{"features":["theirs"]}', ...DELFT },
			{ ...SHARED, [NOTES]: '{"features":["mine"]}' }
		);

		const result = await update(store, fake, baseline, { mintLayerId: () => 'copy-1' });

		expect(await storedText(store, NOTES)).toBe('{"features":["mine"]}');
		expect(await storedText(store, 'amsterdam-1625/annotations/copy-1.geojson')).toBe(
			'{"features":["theirs"]}'
		);
		const manifest = parseProjectFile(await store.read('amsterdam-1625/project.json' as StorePath));
		expect(manifest.layers.map((layer) => layer.name)).toEqual([
			'The sheet',
			'Warehouses',
			'Warehouses (from GitHub)'
		]);
		expect(result.added).toEqual(
			expect.arrayContaining(['delft/annotations/l3.geojson', 'delft/project.json'])
		);
		expect(result.notice).toContain('Warehouses (from GitHub)');
		expect(result.notice).toContain('Nothing has been combined');

		const remote = await shas({ [NOTES]: '{"features":["theirs"]}' });
		expect(result.baseline.get(NOTES)).toBe(remote.get(NOTES));
		expect(result.shared).not.toContain(NOTES);
		expect(result.baseline.has('amsterdam-1625/annotations/copy-1.geojson')).toBe(false);
		const comparison = compareWorkspace({
			local: await inventory(store),
			remote: await inventory(fake),
			baseline: { remote: REMOTE, commit: result.commit, files: result.baseline }
		});
		expect(comparison.status).toBe('changes-to-send');
	});

	it('doubles a Project whose manifest is contested, without doubling its Layers', async () => {
		const warehouses = [newAnnotationLayer({ id: 'l2', name: 'Warehouses' })];
		const { fake, store, baseline } = await fromShared(
			{
				'amsterdam-1625/project.json': projectFile('Amsterdam, theirs', warehouses),
				[NOTES]: '{"features":["theirs"]}'
			},
			{
				...SHARED,
				'amsterdam-1625/project.json': projectFile('Amsterdam, mine', warehouses),
				[NOTES]: '{"features":["mine"]}'
			}
		);

		const result = await update(store, fake, baseline);

		expect(result.copies).toEqual([
			{
				kind: 'project',
				contested: 'amsterdam-1625/project.json',
				name: 'Amsterdam, theirs (from GitHub)',
				directory: 'amsterdam-theirs-from-github'
			}
		]);
		const duplicate = parseProjectFile(
			await store.read('amsterdam-theirs-from-github/project.json' as StorePath)
		);
		expect([duplicate.name, duplicate.onFrontPage]).toEqual([
			'Amsterdam, theirs (from GitHub)',
			false
		]);
		expect(await storedText(store, 'amsterdam-theirs-from-github/annotations/l2.geojson')).toBe(
			'{"features":["theirs"]}'
		);
		const mine = parseProjectFile(await store.read('amsterdam-1625/project.json' as StorePath));
		expect(mine.layers.map((layer) => layer.name)).toEqual(['Warehouses']);
		expect(
			[...store.snapshot().keys()].filter(
				(path) => path.startsWith('amsterdam-1625/annotations/') && !SHARED[path]
			)
		).toEqual([]);
	});

	it('refuses when the result including the copies would not open, writing nothing', async () => {
		const { fake, store, baseline } = await fromShared(
			{ [NOTES]: '{"features":["theirs"]}' },
			{
				...SHARED,
				'amsterdam-1625/project.json': projectFile('Amsterdam 1625', [
					newAnnotationLayer({ id: 'l2', name: 'Warehouses' }),
					newAnnotationLayer({ id: 'l9', name: 'Newly needed' })
				])
			}
		);

		const refused = await refusedLeaving(store, () => update(store, fake, baseline));
		expect([refused.refusal, refused.paths]).toEqual([
			'invalid',
			['amsterdam-1625/annotations/l9.geojson']
		]);
	});
});

describe('a contested Alignment', () => {
	const aligned = (points: number): string => {
		const controlPoints: ControlPoint[] = Array.from({ length: points }, (_, index) => ({
			id: `cp${index}`,
			ordinal: index,
			resource: { x: 100 * (index + 1), y: 200 * (index + 1) },
			geo: { lng: 4.9 + index / 100, lat: 52.37 + index / 100 }
		}));
		return decode(
			serialiseAlignment({ ...newAlignment('map-1', { width: 1024, height: 768 }), controlPoints })
		);
	};

	const MINE = aligned(1);
	const THEIRS = aligned(2);
	const ALIGNMENT = 'alignments/map-1.json';

	const contested = () =>
		fromShared({ [ALIGNMENT]: THEIRS, ...DELFT }, { ...SHARED, [ALIGNMENT]: MINE });

	it('makes no second file, and does not stop the rest of the Sync', async () => {
		const { fake, store, baseline } = await contested();

		const result = await update(store, fake, baseline);
		expect([result.copies, result.unansweredAlignments]).toEqual([[], [ALIGNMENT]]);
		expect([...store.snapshot().keys()].filter((path) => path.startsWith('alignments/'))).toEqual([
			ALIGNMENT
		]);
		expect(await storedText(store, ALIGNMENT)).toBe(MINE);
		expect(result.added).toContain('delft/project.json');
	});

	it('writes exactly one of the two when the author answers', async () => {
		const answering = async (choice: 'take-theirs' | 'keep-mine') => {
			const { fake, store, baseline } = await contested();
			const result = await update(store, fake, baseline, {
				alignmentChoices: new Map([[ALIGNMENT, choice]])
			});
			return { result, text: await storedText(store, ALIGNMENT) };
		};
		const theirs = await answering('take-theirs');
		expect([theirs.text, theirs.result.unansweredAlignments]).toEqual([THEIRS, []]);
		const mine = await answering('keep-mine');
		expect(mine.text).toBe(MINE);
		expect(mine.result.baseline.get(ALIGNMENT)).toBe(
			(await shas({ [ALIGNMENT]: THEIRS })).get(ALIGNMENT)
		);
		expect(mine.result.shared).not.toContain(ALIGNMENT);
	});

	it('shows each side’s Control Point count and date', async () => {
		const { fake, store } = await contested();

		const questions = await readAlignmentQuestions({
			contested: [{ imageId: 'map-1', path: ALIGNMENT }],
			store,
			readRemote: async (path) => (fake.files().get(path) ?? encode('')) as Bytes,
			remoteAt: new Date('2026-02-03T04:05:06Z')
		});

		expect(questions).toHaveLength(1);
		const question = questions[0] as AlignmentQuestion;
		expect([question.mine.controlPoints, question.theirs.controlPoints]).toEqual([1, 2]);
		expect(question.theirs.at?.toISOString()).toBe('2026-02-03T04:05:06.000Z');
		expect(question.mine.at).toBeInstanceOf(Date);
	});
});
