// Seam 1 for Open a Workspace from GitHub: the relationship half, against the shared fake GitHub and
// the shared fake record store, with no browser anywhere.
//
// The transfer itself — the tree listing, the resume, the refusals and their sentences — is asserted
// in `clone-from-remote.test.ts`. What is asserted here is what the *installation* believes
// afterwards: which Workspace a repository resolves to, what Baseline was recorded, and that every
// way an Open can go wrong leaves both of those untouched.

import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { ProjectStore, StorePath } from '../store/project-store.js';
import type { RestoreDestination } from '../transfer/restore-workspace-tar.js';
import { CloneRefusedError } from './clone-from-remote.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { FakeMetadataStorage } from './fake-metadata-storage.js';
import {
	findWorkspaceForRepository,
	openWorkspaceFromGitHub
} from './open-workspace-from-github.js';
import { SynchronizationMetadata } from './synchronization-metadata.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = { owner: OWNER, repository: REPOSITORY, branch: 'main' };

/** The publisher's own files in the same repository, which are never the Workspace (ADR-0033). */
const OUTSIDE_NAMESPACE = ['README.md', 'CNAME', '.github/workflows/pages.yml'];

const PROJECT_JSON = JSON.stringify({
	formatVersion: 1,
	name: 'Atlas',
	layers: [
		{
			id: 'l1',
			kind: 'annotation',
			name: 'Warehouses',
			visible: true,
			order: 0,
			geojsonRef: 'annotations/notes.geojson',
			defaultStyle: {}
		},
		{
			id: 'l2',
			kind: 'map',
			name: 'The plan',
			visible: true,
			order: 1,
			opacity: 1,
			imageId: 'map-1'
		}
	],
	baseMap: null
});

/**
 * A published Workspace as a publish leaves it, with the three kinds of path an Open has to tell
 * apart: the Workspace's source, the viewer a publish generated, and the scholar's own files.
 *
 * `remote.json` names a **different** repository, as a fork's published binding would.
 */
const PUBLISHED: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'_app/app.js': 'export const start = () => {};',
	'remote.json': JSON.stringify({ formatVersion: 1, owner: 'someone-else', repository: 'fork' }),
	// The Published Site record, which carries the editor address its return links point at. Written by
	// whoever published, so on a fork or a mirror it describes somebody else's deployment entirely.
	'ballastella-site.json': JSON.stringify({
		formatVersion: 1,
		editorUrl: 'https://someone-else.example/editor/',
		projects: []
	}),
	'atlas/project.json': PROJECT_JSON,
	'atlas/annotations/notes.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/map-1/info.json': '{"width":1024,"height":768}',
	'images/map-1/0/0/0.jpg': 'tile-zero-bytes',
	// alignment-write-is-the-fixture: the Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any store — the Open under test is what writes it, through `writeAlignmentBytes`
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[]}',
	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

/** The Workspace's **source**, which is the whole of what a Baseline may describe (ticket 02). */
const SOURCE = [
	'alignments/map-1.json',
	'atlas/annotations/notes.geojson',
	'atlas/project.json',
	'images/map-1/0/0/0.jpg',
	'images/map-1/info.json'
];

/** What a publish generated, which an Open downloads and a Baseline never mentions. */
const PUBLISHED_OUTPUT = ['.nojekyll', '_app/app.js', 'ballastella-site.json', 'index.html'];

const github = (tree: Record<string, string> = PUBLISHED): Promise<FakeGitHub> =>
	createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree });

/** How this fake installation spells a browser-backed Workspace's key. */
const workspaceKey = (name: string): string => `opfs:${name}`;

/**
 * A fake installation: named Workspaces in memory, and one record store for all of them.
 *
 * The destination maker suffixes a taken name, exactly as `createOpfsWorkspace` does, so a second
 * Open that reached the download at all would be visible as a second directory rather than as an
 * overwrite of the first.
 */
function installation() {
	const stores = new Map<string, MemoryProjectStore>();
	const metadata = new FakeMetadataStorage();
	const open = async (preferred: string): Promise<RestoreDestination> => {
		let name = preferred;
		for (let suffix = 2; stores.has(name); suffix += 1) name = `${preferred} (${suffix})`;
		const store = new MemoryProjectStore();
		stores.set(name, store);
		return { name, store, discard: async () => void stores.delete(name) };
	};
	return {
		stores,
		metadata,
		open,
		workspaces: () => [...stores.keys()].sort(),
		store: (name: string) => stores.get(name) ?? null,
		/** Everything this installation believes about one Workspace's Remote. */
		synchronization: (name: string) => new SynchronizationMetadata(metadata, workspaceKey(name))
	};
}

type Installation = ReturnType<typeof installation>;

const openFrom = (
	place: Installation,
	fetch: FetchFn,
	remote: { owner: string; repository: string; branch?: string } = REMOTE
) =>
	openWorkspaceFromGitHub({
		remote,
		metadata: place.metadata,
		workspaceKey,
		open: place.open,
		fetch
	});

const text = async (store: ProjectStore, path: string): Promise<string> =>
	new TextDecoder().decode(await store.read(path as StorePath));

/** `fake.fetch`, with one file on the raw host answered by hand. See `clone-from-remote.test.ts`. */
function rawAnswer(fake: FakeGitHub, path: string, answer: () => Response): FetchFn {
	return (input, init) =>
		String(input).endsWith(`/${path}`) ? Promise.resolve(answer()) : fake.fetch(input, init);
}

describe('openWorkspaceFromGitHub', () => {
	it('makes one complete Workspace out of a public repository, anonymously', async () => {
		// ⚠ `rejectCredential` answers 401 to every request *carrying* a token, exactly as the real API
		// does for a public repository — so an Open that attached an `Authorization` header anywhere
		// would fail here. Nothing signs in: the student with no GitHub account is who this is for.
		const fake = await github();
		fake.rejectCredential = true;
		const place = installation();

		const opened = await openFrom(place, fake.fetch);

		expect(opened.outcome).toBe('opened');
		if (opened.outcome !== 'opened') return;
		expect(opened.workspaceName).toBe(REPOSITORY);
		expect(place.workspaces()).toEqual([REPOSITORY]);
		const store = place.store(REPOSITORY);
		expect(store).not.toBeNull();
		expect(await store!.list('')).toEqual([...SOURCE, ...PUBLISHED_OUTPUT].sort());
		expect(await text(store!, 'images/map-1/info.json')).toBe('{"width":1024,"height":768}');
		expect(await text(store!, 'alignments/map-1.json')).toBe(
			'{"formatVersion":1,"controlPoints":[]}'
		);
		// The publisher's own files, and the binding their tree carried, are not Workspace content.
		for (const path of [...OUTSIDE_NAMESPACE, 'remote.json']) {
			expect(await store!.list('')).not.toContain(path);
		}
	});

	it('records the selected Remote and a Baseline of the verified source paths', async () => {
		const fake = await github();
		const place = installation();

		const opened = await openFrom(place, fake.fetch);
		if (opened.outcome !== 'opened') throw new Error('expected an Open');

		expect(opened.baselineRecorded).toBe(true);
		const synchronization = place.synchronization(REPOSITORY);
		expect(await synchronization.readRemote()).toEqual(REMOTE);
		const baseline = await synchronization.readBaseline(REMOTE);
		expect(baseline).not.toBeNull();
		// ⚠ **Source only.** The viewer, `.nojekyll` and `remote.json` are what a Publish generates
		// (ticket 02): staleness there is a Published Site fact, never source drift, so a Baseline that
		// named them would report every publish from another editor version as inbound change.
		expect([...baseline!.files.keys()].sort()).toEqual(SOURCE);
		for (const path of PUBLISHED_OUTPUT) expect(baseline!.files.has(path)).toBe(false);
		// The commit the branch stood at, so the record says which *state* the two sides share — a tree
		// listing reports the tree object's hash and names no history at all.
		expect(baseline!.commit).toBe(fake.head());
		// And every SHA is the one the bytes on disk actually hash to, not merely one a listing claimed.
		const store = place.store(REPOSITORY)!;
		for (const [path, sha] of baseline!.files) {
			expect(await gitBlobShaOf(store, path)).toBe(sha);
		}
	});

	it('takes the Remote from the repository selected, not from the published tree', async () => {
		// ⚠ The tree carries a `remote.json` naming `someone-else/fork`, as a fork's published binding
		// would, and a `ballastella-site.json` whose return links point at somebody else's deployment.
		// Reading either would aim this author's Publish button at a repository they have never seen.
		const fake = await github();
		const place = installation();

		await openFrom(place, fake.fetch);

		expect(await place.synchronization(REPOSITORY).readRemote()).toEqual(REMOTE);
		expect(await findWorkspaceForRepository(place.metadata, REMOTE)).toBe(workspaceKey(REPOSITORY));
		expect(
			await findWorkspaceForRepository(place.metadata, {
				owner: 'someone-else',
				repository: 'fork',
				branch: 'main'
			})
		).toBeNull();
	});

	describe('opening the same repository again', () => {
		it('returns to the Workspace it already has, downloading nothing', async () => {
			const fake = await github();
			const place = installation();
			const first = await openFrom(place, fake.fetch);
			if (first.outcome !== 'opened') throw new Error('expected an Open');
			const requests = fake.rawGets;

			const second = await openFrom(place, fake.fetch);

			expect(second.outcome).toBe('selected');
			expect(second.workspaceKey).toBe(first.workspaceKey);
			// No second directory, and not one more request: reopening is a way back to work already
			// here, not a transfer (SPEC stories 100, 101).
			expect(place.workspaces()).toEqual([REPOSITORY]);
			expect(fake.rawGets).toBe(requests);
		});

		it('selects it however the address was spelled', async () => {
			// `github.com/Ada/Atlas` is one repository with `github.com/ada/atlas`, so the two spellings
			// must not become two synchronized Workspaces.
			const fake = await github();
			const place = installation();
			await openFrom(place, fake.fetch);

			const again = await openFrom(place, fake.fetch, {
				owner: 'Ada',
				repository: 'Atlas'
			});

			expect(again.outcome).toBe('selected');
			expect(place.workspaces()).toEqual([REPOSITORY]);
		});

		it('leaves its local files and its Baseline exactly as they were', async () => {
			// The author has gone on working. Reopening must not replace that, and must not advance the
			// Baseline from a fresh listing either — which would report their own unpublished edits as
			// the Remote's work.
			const fake = await github();
			const place = installation();
			await openFrom(place, fake.fetch);
			const store = place.store(REPOSITORY)!;
			const mine = '{"type":"FeatureCollection","features":[{"id":"mine"}]}';
			await store.write('atlas/annotations/notes.geojson', new TextEncoder().encode(mine));
			const before = await place.synchronization(REPOSITORY).readBaseline(REMOTE);

			await openFrom(place, fake.fetch);

			expect(await text(store, 'atlas/annotations/notes.geojson')).toBe(mine);
			const after = await place.synchronization(REPOSITORY).readBaseline(REMOTE);
			expect(after).toEqual(before);
		});

		it('cannot make two bindings out of two presses at once', async () => {
			// ⚠ **The race the whole lookup would otherwise lose.** Look up, download for four minutes,
			// then record: two presses inside that window both find nothing and both bind, and the
			// installation ends up with exactly the two competing Publish buttons this refuses to create.
			const fake = await github();
			const place = installation();

			const [first, second] = await Promise.all([
				openFrom(place, fake.fetch),
				openFrom(place, fake.fetch)
			]);

			expect([first.outcome, second.outcome].sort()).toEqual(['opened', 'selected']);
			expect(place.workspaces()).toEqual([REPOSITORY]);
			const bound = (await listRelationships(place)).filter(
				(entry) => entry.remote.repository === REPOSITORY
			);
			expect(bound).toHaveLength(1);
		});

		it('opens a different repository beside it rather than selecting it', async () => {
			const fake = await github();
			const other = await createFakeGitHub({
				owner: OWNER,
				repository: 'ledgers',
				tree: PUBLISHED
			});
			const place = installation();
			await openFrom(place, fake.fetch);

			const opened = await openFrom(place, other.fetch, {
				owner: OWNER,
				repository: 'ledgers'
			});

			expect(opened.outcome).toBe('opened');
			expect(place.workspaces()).toEqual(['atlas', 'ledgers']);
		});
	});

	describe('a Remote that is refused', () => {
		/** Nothing bound, nothing recorded, and every Workspace that existed still exactly as it was. */
		const expectUntouched = async (place: Installation, kept: readonly string[]) => {
			expect(await listRelationships(place)).toEqual([]);
			expect(place.workspaces()).toEqual([...kept].sort());
		};

		it('refuses a truncated file list before a byte or a record exists', async () => {
			const fake = await github();
			fake.truncateAfter = 3;
			const place = installation();

			await expect(openFrom(place, fake.fetch)).rejects.toMatchObject({
				name: 'CloneRefusedError',
				refusal: 'truncated'
			});

			await expectUntouched(place, []);
			expect(fake.rawGets).toBe(0);
		});

		it('refuses when there is not enough room, before a Workspace exists', async () => {
			const fake = await github();
			const place = installation();

			const error = await openWorkspaceFromGitHub({
				remote: REMOTE,
				metadata: place.metadata,
				workspaceKey,
				open: place.open,
				fetch: fake.fetch,
				estimateStorage: async () => ({ quota: 1000, usage: 998 })
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('insufficient-quota');
			await expectUntouched(place, []);
		});

		it('refuses a Workspace whose Projects would not open, having downloaded it', async () => {
			// ⚠ **The reason a Baseline is established at the *end*.** Everything the tree listed
			// arrived and every byte matched its SHA, and the result is still not a Workspace: the
			// Project's annotation Layer names a file the publisher never published. Adopting it would
			// record trustworthy-looking evidence about a Project that opens to an error.
			const incomplete = { ...PUBLISHED };
			delete incomplete['atlas/annotations/notes.geojson'];
			const fake = await github(incomplete);
			const place = installation();

			const error = await openFrom(place, fake.fetch).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('invalid');
			expect((error as Error).message).toContain('annotations/notes.geojson');
			expect((error as Error).message).toContain('left in place');
			// The bytes are kept so a later attempt is cheap, and nothing calls them synchronized work.
			expect(await listRelationships(place)).toEqual([]);
		});

		it('refuses a Project written by a newer Ballastella', async () => {
			const fake = await github({
				...PUBLISHED,
				'atlas/project.json': JSON.stringify({ formatVersion: 99, name: 'Atlas', layers: [] })
			});
			const place = installation();

			const error = await openFrom(place, fake.fetch).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('unsupported');
			expect((error as Error).message).toContain('newer version of Ballastella');
			expect(await listRelationships(place)).toEqual([]);
		});

		it('refuses a corrupt file, leaving the existing Workspace and its evidence alone', async () => {
			const fake = await github();
			const place = installation();
			// One Workspace already open on this repository's sibling, with its own Baseline.
			const other = await createFakeGitHub({
				owner: OWNER,
				repository: 'ledgers',
				tree: PUBLISHED
			});
			await openFrom(place, other.fetch, { owner: OWNER, repository: 'ledgers' });
			const before = await place.synchronization('ledgers').readBaseline({
				owner: OWNER,
				repository: 'ledgers',
				branch: 'main'
			});

			const error = await openWorkspaceFromGitHub({
				remote: REMOTE,
				metadata: place.metadata,
				workspaceKey,
				open: place.open,
				fetch: rawAnswer(
					fake,
					'images/map-1/info.json',
					() => new Response('{"width":1,"height":1}', { status: 200 })
				)
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('incomplete');
			expect(await findWorkspaceForRepository(place.metadata, REMOTE)).toBeNull();
			expect(
				await place.synchronization('ledgers').readBaseline({
					owner: OWNER,
					repository: 'ledgers',
					branch: 'main'
				})
			).toEqual(before);
		});

		it('refuses when the record store will not keep the relationship', async () => {
			// A durable store that refuses means the Workspace is not synchronized with anything, so it
			// is said out loud rather than reported as an Open that bound nothing.
			const fake = await github();
			const place = installation();
			place.metadata.refuseWrites.add(
				`synchronization/${encodeURIComponent(workspaceKey(REPOSITORY))}/remote`
			);

			const error = await openFrom(place, fake.fetch).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as Error).message).toContain('would not keep the record');
			expect(await listRelationships(place)).toEqual([]);
		});

		it('reports Cannot tell rather than a failed Open when only the Baseline cannot be kept', async () => {
			// SPEC: never report an operation that reached GitHub as failed because durable storage
			// refused afterwards. The Workspace is bound; its status is Cannot tell.
			const fake = await github();
			const place = installation();
			place.metadata.refuseWrites.add(
				`synchronization/${encodeURIComponent(workspaceKey(REPOSITORY))}/baseline`
			);

			const opened = await openFrom(place, fake.fetch);

			expect(opened.outcome).toBe('opened');
			if (opened.outcome !== 'opened') return;
			expect(opened.baselineRecorded).toBe(false);
			expect(await place.synchronization(REPOSITORY).readRemote()).toEqual(REMOTE);
			expect(await place.synchronization(REPOSITORY).readBaseline(REMOTE)).toBeNull();
		});
	});

	it('leaves another installation to keep its own Workspace and Baseline', async () => {
		// ⚠ **Uniqueness is per installation and deliberately not global** (SPEC story 102). A scholar
		// working on a laptop and a lab machine has one Remote and two Workspaces, each with its own
		// evidence of what it last shared — which is the whole reason to have a Remote at all. Nothing
		// here asks GitHub whether the repository has been opened somewhere else.
		const fake = await github();
		const laptop = installation();
		const lab = installation();

		await openFrom(laptop, fake.fetch);
		const second = await openFrom(lab, fake.fetch);

		expect(second.outcome).toBe('opened');
		expect(lab.workspaces()).toEqual([REPOSITORY]);
		expect(await lab.synchronization(REPOSITORY).readRemote()).toEqual(REMOTE);
		expect(await lab.synchronization(REPOSITORY).readBaseline(REMOTE)).not.toBeNull();
		// Two installations, two records, and neither can see the other's.
		expect(await findWorkspaceForRepository(laptop.metadata, REMOTE)).toBe(
			workspaceKey(REPOSITORY)
		);
		expect(laptop.stores).not.toBe(lab.stores);
	});

	it('resumes an interrupted transfer without fetching what is already verified', async () => {
		// ⚠ The retry is what makes keeping the partial download worthwhile, and the request counter is
		// the only place it shows: a retry that re-downloaded everything leaves a byte-identical
		// Workspace. Modelled by handing the second attempt the same destination, which is what a
		// resume is — the first attempt refused, so nothing named that directory as synchronized work.
		const fake = await github();
		const place = installation();
		const interrupted = await openWorkspaceFromGitHub({
			remote: REMOTE,
			metadata: place.metadata,
			workspaceKey,
			open: place.open,
			fetch: rawAnswer(fake, 'atlas/project.json', () => new Response('', { status: 404 }))
		}).catch((cause: unknown) => cause);
		expect(interrupted).toBeInstanceOf(CloneRefusedError);
		expect(await listRelationships(place)).toEqual([]);
		const partial = place.store(REPOSITORY)!;
		const spent = fake.rawGets;

		const opened = await openWorkspaceFromGitHub({
			remote: REMOTE,
			metadata: place.metadata,
			workspaceKey,
			// The same directory: the resume the engine's skip-by-blob-SHA rule exists for.
			open: async () => ({ name: REPOSITORY, store: partial, discard: async () => undefined }),
			fetch: fake.fetch
		});

		expect(opened.outcome).toBe('opened');
		if (opened.outcome !== 'opened') return;
		expect(opened.transfer.skippedFiles).toBeGreaterThan(0);
		// Only what was missing, and only now is any of it synchronized work.
		expect(fake.rawGets - spent).toBe(opened.transfer.downloadedFiles);
		expect(await place.synchronization(REPOSITORY).readRemote()).toEqual(REMOTE);
		expect(
			[...(await place.synchronization(REPOSITORY).readBaseline(REMOTE))!.files.keys()].sort()
		).toEqual(SOURCE);
	});

	it('reports per-file progress while it runs', async () => {
		const fake = await github();
		const place = installation();
		const seen: { files: number; totalFiles: number }[] = [];

		await openWorkspaceFromGitHub({
			remote: REMOTE,
			metadata: place.metadata,
			workspaceKey,
			open: place.open,
			fetch: fake.fetch,
			onProgress: ({ files, totalFiles }) => seen.push({ files, totalFiles })
		});

		const total = SOURCE.length + PUBLISHED_OUTPUT.length;
		expect(seen[0]).toEqual({ files: 0, totalFiles: total });
		expect(seen.at(-1)).toEqual({ files: total, totalFiles: total });
	});

	it('keeps no relationship and no Baseline where the browser has no record store', async () => {
		// A browser with site data blocked can still read a public Workspace — that is the one operation
		// in this epic meant to need nothing — and its Remote Status is Cannot tell rather than invented.
		const fake = await github();
		const place = installation();

		const opened = await openWorkspaceFromGitHub({
			remote: REMOTE,
			metadata: null,
			workspaceKey,
			open: place.open,
			fetch: fake.fetch
		});

		expect(opened.outcome).toBe('opened');
		if (opened.outcome !== 'opened') return;
		expect(opened.baselineRecorded).toBe(false);
		expect(place.metadata.records.size).toBe(0);
	});

	it('refuses something that is not a repository address', async () => {
		const place = installation();
		const error = await openWorkspaceFromGitHub({
			remote: { owner: 'ada', repository: '..' },
			metadata: place.metadata,
			workspaceKey,
			open: place.open,
			fetch: (async () => new Response('', { status: 500 })) as FetchFn
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CloneRefusedError);
		expect((error as Error).message).toContain('is not a repository address');
		expect(place.workspaces()).toEqual([]);
	});
});

/** Every relationship this installation holds, sorted, for the "nothing was recorded" assertions. */
async function listRelationships(place: Installation) {
	const { listRemoteRelationships } = await import('./synchronization-metadata.js');
	const found = await listRemoteRelationships(place.metadata);
	return [...found].sort((a, b) => a.workspaceKey.localeCompare(b.workspaceKey));
}

/** The blob SHA of what is on disk at `path`, so a Baseline's SHAs are checked against the bytes. */
async function gitBlobShaOf(store: ProjectStore, path: string): Promise<string> {
	const { gitBlobSha } = await import('./blob-sha.js');
	return gitBlobSha(await store.read(path as StorePath));
}
