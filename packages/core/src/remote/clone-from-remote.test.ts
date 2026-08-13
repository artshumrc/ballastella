// Seam 1 for the Clone: the engine against the shared fake GitHub, with no browser anywhere.
//
// What is asserted here is what arrived — the bytes in the destination, the binding written, and the
// fake's own request counters — rather than which calls were made in which order. The counters are
// the exception, and they are counters *of requests* precisely because the two properties they pin
// are invisible in the result: a resumed Clone that re-downloaded everything and wrote the same
// bytes back leaves a Workspace identical to one that skipped them, and a refusal that happened
// after the first byte leaves a Workspace identical to one that happened before it only when it is
// the *first* file that is missing.

import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { ProjectStore, StorePath } from '../store/project-store.js';
import type { RestoreDestination } from '../transfer/restore-workspace-tar.js';
import { CloneRefusedError, cloneFromRemote } from './clone-from-remote.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { parseRemoteBinding } from './remote-binding.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';

/**
 * A published Workspace as a publish leaves it on the Remote: the viewer's files, the Jekyll marker,
 * one Project with a Historical Map and an Alignment, plus two paths a Clone must treat specially.
 *
 * `README.md` is outside the owned namespace — something the scholar added on github.com — and
 * `remote.json` names a **different** repository, as a fork's published binding would, so a Clone
 * that copied it down instead of writing its own would be caught.
 */
const PUBLISHED: Record<string, string> = {
	'.nojekyll': '',
	'README.md': '# Atlas\n',
	'index.html': '<!doctype html><title>Atlas</title>',
	'_app/app.js': 'export const start = () => {};',
	'remote.json': JSON.stringify({ formatVersion: 1, owner: 'someone-else', repository: 'fork' }),
	'atlas/project.json': JSON.stringify({ formatVersion: 1, name: 'Atlas', layers: [] }),
	'atlas/annotations/notes.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/map-1/info.json': '{"width":1024,"height":768}',
	'images/map-1/0/0/0.jpg': 'tile-zero-bytes',
	'images/map-1/0/0/1.jpg': 'tile-one-bytes',
	// alignment-write-is-the-fixture: the Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any store — the Clone under test is what writes it, through `writeAlignmentBytes`
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[]}'
};

/** Everything above except the binding, which a Clone writes rather than downloads. */
const DOWNLOADED = Object.keys(PUBLISHED).filter((path) => path !== 'remote.json');

const github = (tree: Record<string, string> = PUBLISHED): Promise<FakeGitHub> =>
	createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree });

/** A destination that hands back one store, so a second Clone into it is a resumed one. */
function destinationFor(store: ProjectStore, name = REPOSITORY) {
	let opened = 0;
	return {
		store,
		get opened() {
			return opened;
		},
		open: async (preferred: string): Promise<RestoreDestination> => {
			opened += 1;
			return {
				name: preferred === REPOSITORY ? name : preferred,
				store,
				discard: async () => undefined
			};
		}
	};
}

const text = async (store: ProjectStore, path: string): Promise<string> =>
	new TextDecoder().decode(await store.read(path as StorePath));

describe('cloneFromRemote', () => {
	it('fills a new Workspace with everything the Remote holds', async () => {
		const fake = await github();
		const destination = destinationFor(new MemoryProjectStore());

		const result = await cloneFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY },
			fetch: fake.fetch
		});

		expect(result.workspaceName).toBe(REPOSITORY);
		expect(await destination.store.list('')).toEqual([...DOWNLOADED, 'remote.json'].sort());
		expect(await text(destination.store, 'images/map-1/0/0/1.jpg')).toBe('tile-one-bytes');
		expect(await text(destination.store, 'atlas/annotations/notes.geojson')).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
		expect(await text(destination.store, 'alignments/map-1.json')).toBe(
			'{"formatVersion":1,"controlPoints":[]}'
		);
		expect(result.projects).toEqual(['atlas']);
		expect(result.downloadedFiles).toBe(DOWNLOADED.length);
		expect(result.skippedFiles).toBe(0);
		expect(result.declined).toEqual([]);
	});

	it('reads the bytes from raw.githubusercontent.com, one request per file', async () => {
		// The positive half of "no tarball, ever" (ADR-0031): every byte came from the raw host. A
		// Clone that had reached for `codeload` would leave this counter at nought — and would in fact
		// have failed outright, because the fake answers 404 to every origin it does not implement.
		const fake = await github();
		await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
			remote: { owner: OWNER, repository: REPOSITORY },
			fetch: fake.fetch
		});
		expect(fake.rawGets).toBe(DOWNLOADED.length);
	});

	it('succeeds with no credential, against a GitHub that rejects every credential it is sent', async () => {
		// ⚠ **This is the criterion "cloning with no credential present succeeds", and it is pinned
		// rather than vacuous.** `rejectCredential` answers 401 to every request *carrying* a token and
		// leaves anonymous ones alone, exactly as the real API does for a public repository — so a
		// Clone that attached an `Authorization` header anywhere would fail here, and only one that
		// sends none can pass.
		const fake = await github();
		fake.rejectCredential = true;
		const destination = destinationFor(new MemoryProjectStore());

		const result = await cloneFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY },
			fetch: fake.fetch
		});

		expect(result.downloadedFiles).toBe(DOWNLOADED.length);
		expect(await text(destination.store, 'images/map-1/info.json')).toBe(
			'{"width":1024,"height":768}'
		);
	});

	it('binds the result to the repository it was told to clone, not the one on the wire', async () => {
		const fake = await github();
		const destination = destinationFor(new MemoryProjectStore());

		const result = await cloneFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY },
			fetch: fake.fetch
		});

		expect(result.remote).toEqual({
			formatVersion: 1,
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main'
		});
		// The published tree carried a binding naming `someone-else/fork`. Read back off disk, because
		// what matters is the document a later Publish will act on.
		const written = parseRemoteBinding(await destination.store.read('remote.json' as StorePath));
		expect(written).toEqual({
			formatVersion: 1,
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main'
		});
	});

	describe('resuming an interrupted Clone', () => {
		it('skips the files already here and does not fetch them again', async () => {
			// An interrupted Clone is a destination holding some of the tree and not the rest. Modelled
			// by putting those files there rather than by breaking a request part way, so what is under
			// test is the skip rule itself and not a fault injector's idea of where a stop happens.
			const fake = await github();
			const store = new MemoryProjectStore();
			const alreadyHere = ['index.html', '_app/app.js', 'images/map-1/0/0/0.jpg'];
			for (const path of alreadyHere) {
				await store.write(path, new TextEncoder().encode(PUBLISHED[path]));
			}

			const result = await cloneFromRemote(destinationFor(store).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			});

			expect(result.skippedFiles).toBe(alreadyHere.length);
			expect(result.downloadedFiles).toBe(DOWNLOADED.length - alreadyHere.length);
			// The counter, which is the only place the difference shows: the finished Workspace is
			// byte-identical either way.
			expect(fake.rawGets).toBe(DOWNLOADED.length - alreadyHere.length);
		});

		it('fetches nothing at all when the Workspace is already complete', async () => {
			const fake = await github();
			const store = new MemoryProjectStore();
			const destination = destinationFor(store);
			await cloneFromRemote(destination.open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			});
			const afterFirst = fake.rawGets;

			const second = await cloneFromRemote(destination.open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			});

			expect(second.skippedFiles).toBe(DOWNLOADED.length);
			expect(second.downloadedFiles).toBe(0);
			expect(fake.rawGets).toBe(afterFirst);
		});

		it('re-fetches a file whose bytes here differ from the Remote', async () => {
			// The skip is by blob SHA rather than by presence, which is the difference between resuming
			// and quietly keeping a truncated file forever.
			const fake = await github();
			const store = new MemoryProjectStore();
			await store.write('images/map-1/0/0/0.jpg', new TextEncoder().encode('half a tile'));

			await cloneFromRemote(destinationFor(store).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			});

			expect(await text(store, 'images/map-1/0/0/0.jpg')).toBe('tile-zero-bytes');
			expect(fake.rawGets).toBe(DOWNLOADED.length);
		});
	});

	describe('refusals, all of them before a byte is written', () => {
		it('refuses a truncated tree, and never opens a destination', async () => {
			const fake = await github();
			fake.truncateAfter = 3;
			const destination = destinationFor(new MemoryProjectStore());

			await expect(
				cloneFromRemote(destination.open, {
					remote: { owner: OWNER, repository: REPOSITORY },
					fetch: fake.fetch
				})
			).rejects.toMatchObject({ name: 'CloneRefusedError', refusal: 'truncated' });

			expect(destination.opened).toBe(0);
			expect(fake.rawGets).toBe(0);
			expect(await destination.store.list('')).toEqual([]);
		});

		it('says what a truncated listing costs rather than quoting a status', async () => {
			const fake = await github();
			fake.truncateAfter = 2;
			const error = await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as Error).message).toContain('silently missing');
			expect((error as Error).message).toContain('Nothing has been downloaded.');
		});

		it('refuses when there is not enough room, naming the shortfall', async () => {
			const fake = await github();
			const destination = destinationFor(new MemoryProjectStore());

			const error = await cloneFromRemote(destination.open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch,
				// Two bytes free, against a Workspace of rather more than two bytes.
				estimateStorage: async () => ({ quota: 1000, usage: 998 })
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('insufficient-quota');
			// The numbers, because "not enough space" without them is a message nobody can act on.
			expect((error as Error).message).toMatch(/free/);
			expect((error as Error).message).toContain('already in use');
			expect(destination.opened).toBe(0);
			expect(fake.rawGets).toBe(0);
		});

		it('proceeds when the browser will not say what the quota is', async () => {
			// Refusing over an unavailable quota API would refuse every Clone on Safari.
			const fake = await github();
			const result = await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch,
				estimateStorage: async () => null
			});
			expect(result.downloadedFiles).toBe(DOWNLOADED.length);
		});

		it('refuses a repository that is not there, or not public', async () => {
			const fake = await github();
			const error = await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
				remote: { owner: OWNER, repository: 'no-such-atlas' },
				fetch: fake.fetch
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('no-repository');
			// A private repository looks exactly like a missing one to an anonymous reader, and the
			// sentence says so rather than asserting the first of the two.
			expect((error as Error).message).toContain('private');
		});

		it('tells an empty repository apart from a missing one', async () => {
			// ⚠ 409 `Git Repository is empty.`, which is what a repository made at github.com/new with
			// no README answers. Reported as "no such repository" it sends the user to check an address
			// that is perfectly correct.
			const fake = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY });
			const error = await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('empty');
			expect((error as Error).message).toContain('nothing in it yet');
		});
	});

	it('leaves another Workspace holding the same content untouched', async () => {
		// Restore's rule (ADR-0024): a Clone creates, and never merges into or overwrites what is
		// already there. The Workspace of the user's own is a different store, and nothing addresses it.
		const fake = await github();
		const mine = new MemoryProjectStore();
		await mine.write(
			'atlas/project.json',
			new TextEncoder().encode(JSON.stringify({ formatVersion: 1, name: 'My own Atlas' }))
		);

		await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
			remote: { owner: OWNER, repository: REPOSITORY },
			fetch: fake.fetch
		});

		expect(await mine.list('')).toEqual(['atlas/project.json']);
		expect(await text(mine, 'atlas/project.json')).toContain('My own Atlas');
	});

	it('reports per-file progress, ending on the file count it started with', async () => {
		const fake = await github();
		const seen: { files: number; totalFiles: number; path: string | null }[] = [];

		const result = await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
			remote: { owner: OWNER, repository: REPOSITORY },
			fetch: fake.fetch,
			onProgress: ({ files, totalFiles, path }) => seen.push({ files, totalFiles, path })
		});

		// A real denominator, unlike a tar being read: the tree listed everything before a byte moved.
		expect(seen[0]).toEqual({ files: 0, totalFiles: DOWNLOADED.length, path: null });
		expect(seen.at(-1)).toEqual({
			files: DOWNLOADED.length,
			totalFiles: DOWNLOADED.length,
			path: null
		});
		expect(seen.map((step) => step.path)).toContain('images/map-1/0/0/1.jpg');
		expect(result.totalFiles).toBe(DOWNLOADED.length);
	});

	it('writes a Project manifest only once everything it names is here', async () => {
		// `restore-workspace-tar.ts`'s discipline, for its reason: the Workspace's list of Projects *is*
		// whichever directories hold a `project.json` (ADR-0008), so an interrupted Clone must leave
		// orphaned files rather than a Project that lists on the hub and opens with half its Layers
		// missing. Asserted on the order the files were written in.
		const fake = await github();
		const store = new MemoryProjectStore();
		const written: string[] = [];
		// Delegated explicitly rather than through a `Proxy`: `MemoryProjectStore` keeps its state in
		// `#private` fields, and a proxied method called with the proxy as its receiver cannot reach
		// them — which surfaces here as an unreadable `review.json`, and so as a Workspace this refuses
		// to bind, several layers from the cause.
		const watched: ProjectStore = {
			read: (path) => store.read(path),
			write: async (path, bytes) => {
				written.push(path);
				await store.write(path, bytes);
			},
			list: (prefix) => store.list(prefix),
			delete: (path) => store.delete(path),
			size: (path) => store.size(path),
			reclaimAbandonedWrites: (prefix) => store.reclaimAbandonedWrites(prefix)
		};

		await cloneFromRemote(destinationFor(watched).open, {
			remote: { owner: OWNER, repository: REPOSITORY },
			fetch: fake.fetch
		});

		const manifest = written.indexOf('atlas/project.json');
		expect(manifest).toBeGreaterThanOrEqual(0);
		expect(written.indexOf('atlas/annotations/notes.geojson')).toBeLessThan(manifest);
		expect(written.indexOf('images/map-1/0/0/0.jpg')).toBeLessThan(manifest);
	});
});
