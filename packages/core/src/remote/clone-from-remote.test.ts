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

import type { FetchFn } from '../injection/store-image-fetch.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { ProjectStore, StorePath } from '../store/project-store.js';
import type { RestoreDestination } from '../transfer/restore-workspace-tar.js';
import { CloneRefusedError, cloneFromRemote } from './clone-from-remote.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { parseRemoteBinding } from './remote-binding.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';

/**
 * What the publisher's own repository holds that is **not** the Workspace (ADR-0033).
 *
 * A `README.md` and a `LICENSE` they wrote on github.com, the `CNAME` carrying the address they cite
 * in print, the workflow that deploys their Pages site, and a folder of their own prose. A publish
 * to this repository would leave every one of them alone, and so must the Clone — anything brought
 * down here becomes the cloner's Workspace content and is published as theirs.
 */
const OUTSIDE_NAMESPACE = [
	'README.md',
	'LICENSE',
	'CNAME',
	'.github/workflows/pages.yml',
	'docs/how-to-cite.md'
];

/**
 * A published Workspace as a publish leaves it on the Remote: the viewer's files, the Jekyll marker,
 * one Project with a Historical Map and an Alignment, plus the paths a Clone must treat specially.
 *
 * {@link OUTSIDE_NAMESPACE} is the scholar's own; `remote.json` names a **different** repository, as
 * a fork's published binding would, so a Clone that copied it down instead of writing its own would
 * be caught.
 */
const PUBLISHED: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'_app/app.js': 'export const start = () => {};',
	'remote.json': JSON.stringify({ formatVersion: 1, owner: 'someone-else', repository: 'fork' }),
	'atlas/project.json': JSON.stringify({ formatVersion: 1, name: 'Atlas', layers: [] }),
	'atlas/annotations/notes.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/map-1/info.json': '{"width":1024,"height":768}',
	'images/map-1/0/0/0.jpg': 'tile-zero-bytes',
	'images/map-1/0/0/1.jpg': 'tile-one-bytes',
	// alignment-write-is-the-fixture: the Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any store — the Clone under test is what writes it, through `writeAlignmentBytes`
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[]}',
	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

/**
 * Everything a Clone brings down: the owned namespace, less the binding it writes for itself.
 */
const DOWNLOADED = Object.keys(PUBLISHED).filter(
	(path) => path !== 'remote.json' && !OUTSIDE_NAMESPACE.includes(path)
);

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

/**
 * `fake.fetch`, with one file on the raw host answered by hand.
 *
 * The tree listing is left alone, so the file is still *named* and only its bytes go wrong — which
 * is the only way a Clone fails after it has started, and the only way to reach the state the
 * write-last binding rule is about.
 */
function rawAnswer(fake: FakeGitHub, path: string, answer: () => Response): FetchFn {
	return (input, init) =>
		String(input).endsWith(`/${path}`) ? Promise.resolve(answer()) : fake.fetch(input, init);
}

describe('cloneFromRemote', () => {
	it('fills a new Workspace with the Workspace the Remote holds', async () => {
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

	it('downloads only the owned namespace, leaving the publisher’s own files behind', async () => {
		// ⚠ **The rule that keeps story 17 true, and the reason it is enforced *here*.** Everything a
		// Clone writes is Workspace content, and a publish sends every Workspace file — so a `CNAME` or
		// a `README.md` picked up from somebody else's repository would be pushed into the cloner's own
		// as authored content the first time they publish, overwriting the address they cite in print.
		// ADR-0033 rejected the full mirror for exactly this; a mirroring Clone reintroduces it.
		const fake = await github();
		const destination = destinationFor(new MemoryProjectStore());

		const result = await cloneFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY },
			fetch: fake.fetch
		});

		const arrived = await destination.store.list('');
		for (const path of OUTSIDE_NAMESPACE) expect(arrived).not.toContain(path);
		// Not merely unwritten: never asked for, so a Clone of a repository with a large `docs/` folder
		// does not spend the download on it either.
		expect(fake.rawGets).toBe(DOWNLOADED.length);
		expect(result.totalFiles).toBe(DOWNLOADED.length);
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

		it('keeps an Alignment already here, counts it in progress, and says so', async () => {
			// ⚠ ADR-0023's safe direction: Control Points somebody has already placed are never replaced
			// by a download. The file is *declined* rather than skipped — it was fetched and then not
			// written — so it belongs to neither counter, and leaving it out of progress ends a finished
			// Clone one short of the total it reports in the same call.
			const fake = await github();
			const store = new MemoryProjectStore();
			const mine = '{"formatVersion":1,"controlPoints":[{"id":"a"}]}';
			// alignment-write-is-the-fixture: the Alignment already in the Workspace is the specimen the Clone has to decline — planted as bytes so that what is under test is `writeCloned`'s refusal to replace it
			await store.write('alignments/map-1.json', new TextEncoder().encode(mine));
			const seen: { files: number; totalFiles: number }[] = [];

			const result = await cloneFromRemote(destinationFor(store).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch,
				onProgress: ({ files, totalFiles }) => seen.push({ files, totalFiles })
			});

			expect(result.declined).toEqual(['alignments/map-1.json']);
			expect(result.downloadedFiles).toBe(DOWNLOADED.length - 1);
			expect(result.skippedFiles).toBe(0);
			expect(await text(store, 'alignments/map-1.json')).toBe(mine);
			expect(seen.at(-1)).toEqual({ files: DOWNLOADED.length, totalFiles: DOWNLOADED.length });
			// Reported rather than swallowed: a transfer that quietly delivers less than it was given is
			// the failure `restore-workspace-tar.ts` was rewritten to escape.
			expect(result.notice).toContain('alignments/map-1.json');
			expect(result.notice).toContain('already had one for the same Historical Map');
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

	describe('a Clone that stops part way', () => {
		/** A Clone that meets a file the tree named and the raw host will not serve. */
		const interrupted = (fake: FakeGitHub, store: ProjectStore) =>
			cloneFromRemote(destinationFor(store).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: rawAnswer(
					fake,
					'images/map-1/0/0/1.jpg',
					() => new Response('Not Found', { status: 404 })
				)
			});

		it('leaves the Workspace unbound', async () => {
			// ⚠ **The invariant, asserted rather than left to the order of the code.** A partly filled
			// Workspace that was *bound* is one the Publish button acts on, and publishing it would
			// delete from the Remote every owned-namespace path the Clone had not yet fetched — a
			// scholar's whole site taken down by a Clone somebody interrupted. The binding is therefore
			// written after the last file, and this is what says so: a later change moving it earlier —
			// to let a resume read its own Remote back, say — fails here rather than silently.
			const fake = await github();
			const store = new MemoryProjectStore();

			await expect(interrupted(fake, store)).rejects.toMatchObject({ name: 'CloneRefusedError' });

			expect(await store.list('')).not.toContain('remote.json');
			await expect(store.read('remote.json' as StorePath)).rejects.toThrow();
			// And what did arrive is still here, which is the other half of the same design: the files
			// are kept so a resume is cheap, and only the binding is withheld.
			expect(await text(store, 'images/map-1/0/0/0.jpg')).toBe('tile-zero-bytes');
		});

		it('refuses in its own words when a listed file cannot be downloaded', async () => {
			// A file deleted between the listing and the fetch is `PathNotFoundError` out of the HTTP
			// store, whose sentence is about a store path and says nothing about cloning. The dialog
			// renders whatever it is handed, so the shape has to be right here.
			const fake = await github();
			const error = await interrupted(fake, new MemoryProjectStore()).catch(
				(cause: unknown) => cause
			);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('incomplete');
			expect((error as Error).message).toContain('images/map-1/0/0/1.jpg');
			// And it does **not** claim nothing was downloaded, because by now something was.
			expect((error as Error).message).not.toContain('Nothing has been downloaded.');
			expect((error as Error).message).toContain('left in place');
		});

		it('refuses bytes that are not the ones the tree named', async () => {
			// The blob SHA the listing gives is checked against what arrived, which costs one hash of
			// bytes already in memory. Unchecked, a proxy serving a rewritten copy makes a Workspace
			// that is silently wrong and that a later resume then skips for ever.
			const fake = await github();
			const store = new MemoryProjectStore();

			const error = await cloneFromRemote(destinationFor(store).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: rawAnswer(
					fake,
					'images/map-1/info.json',
					() => new Response('{"width":1,"height":1}', { status: 200 })
				)
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('incomplete');
			expect((error as Error).message).toContain('images/map-1/info.json');
			// Refused rather than written: the wrong bytes are not in the Workspace at all.
			expect(await store.list('')).not.toContain('images/map-1/info.json');
		});
	});

	it('asks for the branch as one path segment, not as several', async () => {
		// `/git/trees/{ref}` takes a single parameter. A branch of `feature/x` spelled per segment asks
		// for `/git/trees/feature/x`, which is a different address entirely — latent while the branch
		// is always `main`, and `CloneReference.branch` is in the type.
		const fake = await github();
		const asked: string[] = [];
		const watched: FetchFn = (input, init) => {
			asked.push(String(input));
			return fake.fetch(input, init);
		};

		await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
			remote: { owner: OWNER, repository: REPOSITORY, branch: 'feature/x' },
			fetch: watched
		}).catch(() => undefined);

		expect(asked[0]).toContain('/git/trees/feature%2Fx?recursive=1');
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

		it('refuses a repository GitHub will not read at all without signing in', async () => {
			// GitHub answers 401 rather than 404 for some private repositories, and the sentence differs
			// from the missing-repository one because only this one can be acted on: there is nothing to
			// check in the address, and cloning has no sign-in to offer.
			const demanding = (async () =>
				new Response(JSON.stringify({ message: 'Requires authentication' }), {
					status: 401,
					headers: { 'content-type': 'application/json' }
				})) as FetchFn;

			const error = await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: demanding
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('no-repository');
			expect((error as Error).message).toContain('not a public repository');
			expect((error as Error).message).toContain('send you a Backup instead');
		});

		it('tells the anonymous hourly limit apart from a repository that is not public', async () => {
			// ⚠ **A spent budget and a private repository are both 403.** A Clone signs in to nothing, so
			// the budget is GitHub's 60 requests an hour *per IP address*: a class of students on one
			// campus connection cloning their instructor's repository spends it between them (SPEC story
			// 48), and "make it public" is then an instruction about somebody else's repository that
			// would not help if they followed it. The fake answers 403 before it looks at a credential,
			// which is what makes this the anonymous reader's 403.
			const fake = await github();
			fake.rateLimit = { remaining: 0, reset: 1_800_000_000 };
			const destination = destinationFor(new MemoryProjectStore());

			const error = await cloneFromRemote(destination.open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('rate-limited');
			expect((error as Error).message).toContain('hourly limit for anonymous readers');
			expect((error as Error).message).toContain('60 requests an hour');
			// Named as a wait, and never as a fault in the repository or in the address.
			expect((error as Error).message).not.toContain('private');
			expect((error as Error).message).toContain('when the limit resets');
			expect((error as Error).message).toContain('Nothing has been downloaded.');
			expect(destination.opened).toBe(0);
			expect(fake.rawGets).toBe(0);
		});

		it('refuses legibly when the file list fails in a way it has no name for', async () => {
			// A `fetch` replaced by an extension or a service worker can answer with something that is
			// not a response at all, and the reading of it throws where nothing catches. What the user
			// gets is still a refusal rather than the first line of a stack trace.
			const answering = (async () => null) as unknown as FetchFn;

			const error = await cloneFromRemote(destinationFor(new MemoryProjectStore()).open, {
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: answering
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(CloneRefusedError);
			expect((error as CloneRefusedError).refusal).toBe('refused');
			expect((error as Error).message).toContain('Nothing has been downloaded.');
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
