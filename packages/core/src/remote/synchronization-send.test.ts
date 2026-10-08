import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { StorePath } from '../store/project-store.js';
import { encode, rejection, seeded } from '../test-support.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub } from './fake-github.js';
import { FakeMetadataStorage } from './fake-metadata-storage.js';
import {
	ATLAS as REMOTE,
	SMALL_WORKSPACE as WORKSPACE_FILES,
	changeIndex,
	remoteText
} from './remote-test-support.js';
import { RemoteSendFailedError, RemoteSendRefusedError } from './send-to-remote.js';
import { SynchronizationMetadata, baselineKey } from './synchronization-metadata.js';
import { sendWorkspaceToRemote } from './synchronization-send.js';
import { getFromRemote } from './get-from-remote.js';

const WORKSPACE = 'opfs:Atlas';
const NOTES = 'amsterdam-1625/annotations/notes.json';
const PROJECT = 'amsterdam-1625/project.json';
const L2 = 'amsterdam-1625/annotations/l2.geojson';
const FLORIDA = { 'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}' };
const EMPTY = '{"type":"FeatureCollection","features":[]}';
const A2 = '{"formatVersion":1,"name":"A2"}';
const notesWith = (id: string) => `{"type":"FeatureCollection","features":[{"id":"${id}"}]}`;

const SOURCE_PATHS = [
	'alignments/blaeu.json',
	NOTES,
	PROJECT,
	'images/blaeu/0,0,256,256/256,256/0/default.jpg',
	'images/blaeu/info.json'
];

const workspace = async (
	files: Record<string, string> = WORKSPACE_FILES,
	tree: Record<string, string> = { 'README.md': '# Atlas\n' },
	submodules: Record<string, string> = {}
) => {
	const store = await seeded(files);
	const github = await createFakeGitHub({ ...REMOTE, tree, submodules });
	const storage = new FakeMetadataStorage();
	const metadata = new SynchronizationMetadata(storage, WORKSPACE);
	return { store, github, storage, metadata, changes: changeIndex(storage, WORKSPACE) };
};

type Apparatus = Awaited<ReturnType<typeof workspace>>;

const send = (kit: Apparatus, options: { overwrite?: readonly string[]; fetch?: FetchFn } = {}) =>
	sendWorkspaceToRemote(kit.store, {
		token: 'ghp_a-token',
		remote: REMOTE,
		metadata: kit.metadata,
		changes: kit.changes,
		fetch: kit.github.fetch,
		...options
	});

const believed = (kit: Apparatus) => kit.metadata.readBaseline(REMOTE);
const recorded = async (kit: Apparatus) => [...((await believed(kit))?.files.keys() ?? [])].sort();
const remotePaths = (kit: Apparatus) => [...kit.github.files().keys()];
const mineSha = () => gitBlobSha(encode(notesWith('mine')));

const snapshot = (kit: Apparatus) => ({
	head: kit.github.head(),
	remote: remotePaths(kit),
	blobPosts: kit.github.blobPosts,
	baseline: kit.storage.records.get(baselineKey(WORKSPACE)) ?? null
});

const afterSomebodyElseSent = async (files: Record<string, string | null>) => {
	const kit = await workspace();
	await send(kit);
	await kit.github.commitFiles(files);
	return kit;
};

describe('an ordinary Send', () => {
	it('sends the generated site and records only the source Baseline at the new commit', async () => {
		const kit = await workspace();
		const sent = await send(kit);
		expect(sent.baselineKept).toBe(true);
		expect(sent.plan.conflicts).toEqual([]);
		const baseline = await believed(kit);
		expect(baseline?.commit).toBe(kit.github.head());
		expect(baseline?.commit).toBe(sent.commit);
		expect(baseline?.remote).toEqual(REMOTE);
		expect(await recorded(kit)).toEqual(SOURCE_PATHS);
		expect(remotePaths(kit)).toEqual(
			expect.arrayContaining(['index.html', '_app/immutable/entry/start.AAAA.js', '.nojekyll'])
		);
	});

	it('records an Offline Copy’s tiles as source, and the glyphs beside them as output', async () => {
		const tile = 'base-map/tiles/9f8/12/2094/1330.mvt';
		const glyph = 'base-map/fonts/Noto Sans Regular/0-255.pbf';
		const kit = await workspace({
			...WORKSPACE_FILES,
			[tile]: 'tile-bytes',
			[glyph]: 'glyph-bytes'
		});
		await send(kit);
		expect(await recorded(kit)).toContain(tile);
		expect(await recorded(kit)).not.toContain(glyph);
	});

	it('goes ahead with local work to send, and advances the Baseline to it', async () => {
		const kit = await workspace();
		await send(kit);
		await kit.store.write(NOTES, encode(notesWith('mine')));
		expect((await send(kit)).plan.conflicts).toEqual([]);
		expect((await believed(kit))?.files.get(NOTES)).toBe(await mineSha());
		expect(remoteText(kit.github, NOTES)).toBe(notesWith('mine'));
	});

	it('preserves the repository’s own files and its submodules', async () => {
		const own = {
			'README.md': '# Atlas\n',
			CNAME: 'atlas.example\n',
			'.github/workflows/ci.yml': 'on: push\n'
		};
		const gitlink = 'a'.repeat(40);
		const kit = await workspace(WORKSPACE_FILES, own, { 'vendor/iiif': gitlink });
		await send(kit);
		for (const [path, text] of Object.entries(own)) expect(remoteText(kit.github, path)).toBe(text);
		expect(kit.github.gitlinks().get('vendor/iiif')).toBe(gitlink);
		expect(await recorded(kit)).toEqual(SOURCE_PATHS);
	});
});

describe('a send the Remote has moved under', () => {
	it('leaves Remote-only source and whole new Projects alone, and sends this Workspace’s work', async () => {
		const kit = await afterSomebodyElseSent({ [L2]: EMPTY, ...FLORIDA });
		await kit.store.write(PROJECT, encode(A2));
		expect((await send(kit)).plan.conflicts).toEqual([]);
		expect(remoteText(kit.github, L2)).toBe(EMPTY);
		expect(remotePaths(kit)).toEqual(expect.arrayContaining(Object.keys(FLORIDA)));
		expect(remoteText(kit.github, PROJECT)).toBe(A2);
		expect((await believed(kit))?.files.has(L2)).toBe(false);
	});

	it('leaves a Conflict alone on both sides and sends everything else', async () => {
		const kit = await afterSomebodyElseSent({ [NOTES]: notesWith('theirs') });
		await kit.store.write(NOTES, encode(notesWith('mine')));
		await kit.store.write('amsterdam-1625/annotations/canals.json', encode('{"canals":true}'));

		const sent = await send(kit);
		expect(sent.plan.conflicts.map((row) => row.path)).toEqual([NOTES]);
		expect(remoteText(kit.github, NOTES)).toBe(notesWith('theirs'));
		expect(remoteText(kit.github, 'amsterdam-1625/annotations/canals.json')).toBe(
			'{"canals":true}'
		);
		expect((await believed(kit))?.files.has(NOTES)).toBe(false);
	});

	it('sends a Conflict Copy in the same Sync, so the Remote tree carries it afterwards', async () => {
		const LAYER = 'amsterdam-1625/annotations/l1.geojson';
		const layers = [
			{ kind: 'annotation', id: 'l1', name: 'Notes', geojsonRef: 'annotations/l1.geojson' }
		];
		const kit = await workspace({
			...WORKSPACE_FILES,
			[PROJECT]: JSON.stringify({ formatVersion: 1, name: 'Amsterdam', layers }),
			[LAYER]: EMPTY
		});
		await send(kit);
		await kit.github.commitFiles({ [LAYER]: notesWith('theirs') });
		await kit.store.write(LAYER, encode(notesWith('mine')));

		const got = await getFromRemote(kit.store, {
			remote: REMOTE,
			token: null,
			baseline: await believed(kit),
			fetch: kit.github.fetch,
			mintLayerId: () => 'copy-1'
		});
		await kit.metadata.writeBaseline({ remote: REMOTE, commit: got.commit, files: got.baseline });
		await send(kit);

		expect(got.copies.map((copy) => copy.name)).toEqual(['Notes (from GitHub)']);
		expect(remoteText(kit.github, LAYER)).toBe(notesWith('mine'));
		expect(remoteText(kit.github, 'amsterdam-1625/annotations/copy-1.geojson')).toBe(
			notesWith('theirs')
		);
	});
});

describe('a Send with no Baseline', () => {
	it('leaves a non-empty Remote it cannot attribute exactly as it is', async () => {
		const kit = await workspace(WORKSPACE_FILES, { 'README.md': '# Atlas\n', ...FLORIDA });
		expect((await send(kit)).plan.conflicts).toEqual([]);
		expect(remotePaths(kit)).toEqual(expect.arrayContaining([...Object.keys(FLORIDA), PROJECT]));
		expect(await recorded(kit)).toEqual(SOURCE_PATHS);
	});

	it('establishes evidence where the two source namespaces are already equal', async () => {
		const kit = await workspace();
		await send(kit);
		await kit.metadata.clearBaseline();
		const sent = await send(kit);
		expect(sent.plan.conflicts).toEqual([]);
		expect((await believed(kit))?.commit).toBe(sent.commit);
	});
});

describe('Overwrite the repository', () => {
	it('replaces the owned source it was shown, and records the result', async () => {
		const kit = await afterSomebodyElseSent({ [L2]: EMPTY });
		const sent = await send(kit, { overwrite: [L2] });
		expect(remotePaths(kit)).not.toContain(L2);
		expect(remoteText(kit.github, 'README.md')).toBe('# Atlas\n');
		expect((await believed(kit))?.commit).toBe(sent.commit);
		expect(await recorded(kit)).toEqual(SOURCE_PATHS);
	});

	it('refuses when the Remote has gained a path the author never saw', async () => {
		const kit = await afterSomebodyElseSent({ [L2]: EMPTY, ...FLORIDA });
		const before = snapshot(kit);
		const refusal = await rejection(RemoteSendRefusedError, send(kit, { overwrite: [L2] }));
		expect(refusal.message).toContain('florida-1657/project.json');
		expect(snapshot(kit)).toEqual(before);
	});

	it('takes the local side of a Conflict when that is what was agreed', async () => {
		const kit = await afterSomebodyElseSent({ [NOTES]: notesWith('theirs') });
		await kit.store.write(NOTES, encode(notesWith('mine')));
		await send(kit, { overwrite: [NOTES] });
		expect(remoteText(kit.github, NOTES)).toBe(notesWith('mine'));
		expect((await believed(kit))?.files.get(NOTES)).toBe(await mineSha());
	});
});

describe('the local-change index a Send narrows', () => {
	it('clears the marks the Baseline now accounts for, and only those', async () => {
		const kit = await workspace();
		for (const path of [PROJECT, 'images/blaeu/info.json', 'index.html']) {
			await kit.changes.mark(path, 'written');
		}
		await send(kit);
		expect(await kit.changes.localChanges()).toEqual({ written: ['index.html'], deleted: [] });
	});

	it('clears the mark of a Project the mirror took down', async () => {
		const kit = await workspace();
		await send(kit);
		await kit.store.delete(NOTES as StorePath);
		await kit.changes.mark(NOTES, 'deleted');
		expect((await send(kit)).shared).toContain(NOTES);
		expect(await kit.changes.localChanges()).toEqual({ written: [], deleted: [] });
		expect(remotePaths(kit)).not.toContain(NOTES);
	});

	it('publishes without evidence, never failing, and keeps every mark when the Baseline cannot be stored', async () => {
		const kit = await workspace();
		const first = await send(kit);
		await kit.store.write(PROJECT, encode(A2));
		await kit.changes.mark(PROJECT, 'written');
		kit.storage.refuseWrites.add(baselineKey(WORKSPACE));

		const second = await send(kit);
		expect(second.baselineKept).toBe(false);
		expect(second.commit).not.toBe(first.commit);
		expect(kit.github.head()).toBe(second.commit);
		expect(remoteText(kit.github, PROJECT)).toBe(A2);
		expect(await believed(kit)).toBeNull();
		expect((await kit.changes.localChanges()).written).toEqual([PROJECT]);
	});
});

describe('a Send that failed', () => {
	const withWorkToSend = async () => {
		const kit = await workspace();
		const first = await send(kit);
		await kit.store.write(PROJECT, encode(A2));
		return { kit, first };
	};

	it('leaves everything unchanged when the account cannot push', async () => {
		const { kit, first } = await withWorkToSend();
		kit.github.permissions = { push: false, admin: false };
		const before = snapshot(kit);
		expect((await rejection(RemoteSendRefusedError, send(kit))).message).toContain('cannot push');
		expect(snapshot(kit)).toEqual(before);
		expect((await believed(kit))?.commit).toBe(first.commit);
	});

	const refusingTheRefMove =
		(upstream: FetchFn): FetchFn =>
		async (input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			return init?.method === 'PATCH' && url.includes('/git/refs/')
				? new Response(JSON.stringify({ message: 'Update is not a fast forward' }), { status: 422 })
				: upstream(input, init);
		};

	it.each([
		{
			when: 'the sign-in has expired',
			error: RemoteSendFailedError,
			fault: { rejectCredential: true }
		},
		{
			when: 'the tree listing came back truncated',
			error: RemoteSendRefusedError,
			fault: { truncateAfter: 2 }
		},
		{
			when: 'a write phase is refused part way',
			error: RemoteSendFailedError,
			fault: { refuseWrites: true }
		},
		{ when: 'the ref would not move', error: RemoteSendFailedError, fault: {}, refMove: true }
	])(
		'leaves the Remote and the Baseline unchanged when $when',
		async ({ error, fault, refMove }) => {
			const { kit, first } = await withWorkToSend();
			Object.assign(kit.github, fault);
			const fetch = refMove ? refusingTheRefMove(kit.github.fetch) : kit.github.fetch;

			await expect(send(kit, { fetch })).rejects.toThrow(error);

			expect(kit.github.head()).toBe(first.commit);
			expect((await believed(kit))?.commit).toBe(first.commit);
			expect(remoteText(kit.github, PROJECT)).toBe('{"formatVersion":1,"name":"Amsterdam"}');
		}
	);
});
