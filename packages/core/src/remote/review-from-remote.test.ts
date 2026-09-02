// Seam 1 for the Review: the engine against the shared fake GitHub, with no browser anywhere.
//
// What is asserted is what arrived — the files in the Review Workspace, the mark on it, and what is
// *not* there — rather than which calls were made. The fake's request counter appears twice, for the
// two claims no assertion on the result can make: that a refusal stopped before a byte was asked
// for, and that nothing on this path ever carries a credential.

import { describe, expect, it, vi } from 'vitest';

import { readReviewMark, type ReviewOrigin } from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { ProjectStore, StorePath } from '../store/project-store.js';
import type { ReviewDestination } from '../transfer/open-project-bundle.js';
import { bindWorkspaceToRemote } from './bind-remote.js';
import { closedWhileReviewing, memoryCredentialStore } from './credential-store.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { isOwnedPath, projectDirectories } from './synchronization-paths.js';
import { ReviewRefusedError, reviewFromRemote } from './review-from-remote.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const AMSTERDAM = 'amsterdam-1625';
const BOSTON = 'boston-1710';

const projectJson = (name: string, imageId: string, annotation: string): string =>
	JSON.stringify({
		formatVersion: 1,
		name,
		updatedAt: '2025-03-04T11:22:33.000Z',
		layers: [
			{
				id: 'l1',
				kind: 'annotation',
				name: 'Warehouses',
				visible: true,
				order: 0,
				geojsonRef: annotation,
				defaultStyle: {}
			},
			{ id: 'l2', kind: 'map', name: 'The sheet', visible: true, order: 1, opacity: 1, imageId }
		],
		baseMap: null
	});

/** The publisher's own work on their own repository, which no reader of it may take (ADR-0033). */
const OUTSIDE_NAMESPACE = ['README.md', 'CNAME', 'LICENSE', '.github/workflows/pages.yml'];

/**
 * A published Workspace holding **two** Projects and **three** Map Images.
 *
 * `map-3` is drawn by no Layer of either Project — a Workspace holds a shared pool (ADR-0023) — and
 * `map-2` is drawn only by the Boston Project. Both are what make "only what this Project references
 * travels" assertable rather than merely true of a fixture with nothing else in it.
 */
const PUBLISHED: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'_app/app.js': 'export const start = () => {};',
	'ballastella-site.json': '{"formatVersion":2,"projects":[]}',

	[`${AMSTERDAM}/project.json`]: projectJson(
		'Amsterdam 1625',
		'map-1',
		'annotations/warehouses.geojson'
	),
	[`${AMSTERDAM}/annotations/warehouses.geojson`]: '{"type":"FeatureCollection","features":[]}',
	[`${BOSTON}/project.json`]: projectJson('Boston 1710', 'map-2', 'annotations/wharves.geojson'),
	[`${BOSTON}/annotations/wharves.geojson`]: '{"type":"FeatureCollection","features":[]}',

	'images/map-1/info.json': '{"width":1024,"height":768}',
	'images/map-1/0/0/0.jpg': 'amsterdam-tile-bytes',
	'images/map-2/info.json': '{"width":2048,"height":1536}',
	'images/map-2/0/0/0.jpg': 'boston-tile-bytes',
	'images/map-3/info.json': '{"width":512,"height":512}',
	'images/map-3/0/0/0.jpg': 'unused-tile-bytes',
	// alignment-write-is-the-fixture: the reviewed Project's Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any store — the Review under test is what writes it, through `writeAlignmentBytes`
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":["amsterdam"]}',
	// alignment-write-is-the-fixture: the other Project's Alignment on the Remote, seeded so that leaving it out of the Review is assertable
	'alignments/map-2.json': '{"formatVersion":1,"controlPoints":["boston"]}',
	// alignment-write-is-the-fixture: the unused map's Alignment on the Remote, seeded so that leaving it out of the Review is assertable
	'alignments/map-3.json': '{"formatVersion":1,"controlPoints":["nobody"]}',

	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

/** Everything reviewing the Amsterdam Project brings down, and nothing else. */
const AMSTERDAM_CLOSURE = [
	'alignments/map-1.json',
	`${AMSTERDAM}/annotations/warehouses.geojson`,
	`${AMSTERDAM}/project.json`,
	'images/map-1/0/0/0.jpg',
	'images/map-1/info.json'
];

const github = (tree: Record<string, string> = PUBLISHED): Promise<FakeGitHub> =>
	createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree });

/** The published tree with some of it never published — an author's mistake, as it reaches a reviewer. */
const withoutFiles = (...paths: string[]): Record<string, string> =>
	Object.fromEntries(Object.entries(PUBLISHED).filter(([path]) => !paths.includes(path)));

/** A destination whose store and discards are inspectable. */
function destinationFor(
	store: ProjectStore = new MemoryProjectStore(),
	name = REPOSITORY,
	origin: ReviewOrigin | null = null
) {
	let opened = 0;
	let discarded = 0;
	return {
		store,
		get opened() {
			return opened;
		},
		get discarded() {
			return discarded;
		},
		open: async (preferred: string): Promise<ReviewDestination> => {
			opened += 1;
			return {
				name: preferred === REPOSITORY ? name : preferred,
				store,
				origin,
				discard: async () => {
					discarded += 1;
					for (const path of await store.list('')) await store.delete(path as StorePath);
				}
			};
		}
	};
}

const text = async (store: ProjectStore, path: string): Promise<string> =>
	new TextDecoder().decode(await store.read(path as StorePath));

/** `fake.fetch`, with one file on the raw host answered by hand. The listing is left alone. */
const rawAnswer = (fake: FakeGitHub, path: string, answer: () => Response) =>
	((input: string | URL, init?: RequestInit) =>
		String(input).endsWith(`/${path}`)
			? Promise.resolve(answer())
			: fake.fetch(input, init)) as typeof fake.fetch;

describe('reviewFromRemote', () => {
	it('fills a Review Workspace with one Project and what its Layers reference', async () => {
		const fake = await github();
		const destination = destinationFor();

		const result = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		expect(result.workspaceName).toBe(REPOSITORY);
		expect(result.directory).toBe(AMSTERDAM);
		expect(result.project.name).toBe('Amsterdam 1625');
		expect(result.totalFiles).toBe(AMSTERDAM_CLOSURE.length);
		// Nothing the Layers name was missing, which is every ordinary Project.
		expect(result.unmet).toEqual([]);
		// The mark is the Review Workspace's own file and is not one of the Project's.
		expect(await destination.store.list('')).toEqual([...AMSTERDAM_CLOSURE, 'review.json'].sort());
		// The bytes themselves, so this is a Project that can be opened rather than a list of names.
		expect(await text(destination.store, 'images/map-1/0/0/0.jpg')).toBe('amsterdam-tile-bytes');
		expect(await text(destination.store, 'alignments/map-1.json')).toBe(
			'{"formatVersion":1,"controlPoints":["amsterdam"]}'
		);
		expect(await text(destination.store, `${AMSTERDAM}/annotations/warehouses.geojson`)).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
	});

	it('leaves behind every Map Image no Layer of that Project references', async () => {
		// ADR-0023: the pool is the Workspace's, and a reviewer has no business receiving a colleague's
		// other scans. `map-2` belongs to the other Project and `map-3` to no Project at all.
		const fake = await github();
		const destination = destinationFor();

		await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		const written = await destination.store.list('');
		for (const path of written) {
			expect(path.startsWith('images/map-2/')).toBe(false);
			expect(path.startsWith('images/map-3/')).toBe(false);
		}
		expect(written).not.toContain('alignments/map-2.json');
		expect(written).not.toContain('alignments/map-3.json');
		expect(written).not.toContain(`${BOSTON}/project.json`);
	});

	it('takes nothing of the publisher’s own, and no path outside the owned namespace', async () => {
		// The closure is inside ADR-0033's namespace by construction rather than by a filter, so the
		// containment is asserted here — with `isOwnedPath` itself, so the two cannot drift apart.
		const fake = await github();
		const destination = destinationFor();

		await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		const projects = projectDirectories(Object.keys(PUBLISHED));
		for (const path of await destination.store.list('')) {
			if (path === 'review.json') continue;
			expect(isOwnedPath(path, projects, true)).toBe(true);
		}
		for (const path of OUTSIDE_NAMESPACE) {
			await expect(destination.store.read(path as StorePath)).rejects.toThrow();
		}
	});

	it('marks the Workspace as a review copy before any Project byte lands', async () => {
		// The mark is what makes the banner appear. Written last, an interrupted Review would leave a
		// Workspace full of somebody else's work looking exactly like the user's own (ADR-0024).
		const fake = await github();
		const store = new MemoryProjectStore();
		const written: string[] = [];
		// Delegating rather than spread: `MemoryProjectStore` is a class, so its methods are on the
		// prototype and a spread copy would have none of them.
		const watched: ProjectStore = {
			read: (path) => store.read(path),
			list: (prefix) => store.list(prefix),
			delete: (path) => store.delete(path),
			size: (path) => store.size(path),
			reclaimAbandonedWrites: (prefix) => store.reclaimAbandonedWrites(prefix),
			write: async (path, bytes) => {
				written.push(path);
				return store.write(path, bytes);
			}
		};

		const result = await reviewFromRemote(destinationFor(watched).open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch,
			now: () => new Date('2026-05-01T09:00:00.000Z')
		});

		expect(written[0]).toBe('review.json');
		// And `project.json` last, so a Project lists on the hub only once it is whole (ADR-0008).
		expect(written.at(-1)).toBe(`${AMSTERDAM}/project.json`);
		expect(await readReviewMark(store)).toEqual({
			formatVersion: 1,
			project: 'Amsterdam 1625',
			directory: AMSTERDAM,
			openedAt: '2026-05-01T09:00:00.000Z',
			origin: null
		});
		expect(result.notice).toContain('review copy');
	});

	// ADR-0037. The same fact the bundle path records, from the other source of bytes: which of the
	// reader's own Workspaces this review copy was opened from, written now rather than looked up when
	// the Import runs — by which time they may be standing in a different one.
	it('records the ordinary Workspace review began from, as the destination supplies it', async () => {
		const fake = await github();
		const origin: ReviewOrigin = {
			workspaceKey: 'folder:maps',
			backing: 'folder',
			name: 'maps',
			folderReference: 'retained:8f1c'
		};
		const destination = destinationFor(new MemoryProjectStore(), REPOSITORY, origin);

		await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		expect((await readReviewMark(destination.store))?.origin).toEqual(origin);
	});

	it('refuses to connect what it made to a repository', async () => {
		// ⚠ The hard refusal a Review Workspace carries, asserted at the route that *creates* the
		// Workspace it protects against. The refusal is called directly rather than inferred from an
		// absent button: a guard that lives in markup is one route away from gone.
		const fake = await github();
		const destination = destinationFor();

		await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		await expect(
			bindWorkspaceToRemote(destination.store, REPOSITORY, {
				token: 'ghp_whatever',
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			})
		).rejects.toThrow(/review copy/);
	});

	it('seals the credential store for as long as the Workspace it made is open', async () => {
		// The seal, at the route that makes the Workspace. It is `closedWhileReviewing`'s and the
		// mark it reads is this Review's, so what is asserted is the pair rather than either alone.
		const fake = await github();
		const destination = destinationFor();
		await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		const held = memoryCredentialStore();
		held.write('github_pat_the-teachers-own-token');
		const mark = await readReviewMark(destination.store);
		const sealed = closedWhileReviewing(() => mark !== null, held);

		expect(mark).not.toBeNull();
		expect(sealed.read()).toBeNull();
		sealed.write('github_pat_something-else');
		sealed.clear();
		// Neither read nor written: the teacher's own credential is untouched underneath.
		expect(held.read()).toBe('github_pat_the-teachers-own-token');
	});

	it('needs no credential, and sends none', async () => {
		// `rejectCredential` answers 401 to every request *carrying* a token and leaves anonymous ones
		// alone, exactly as the real API does for a public repository — so a Review that attached an
		// `Authorization` header anywhere would fail here.
		const fake = await github();
		fake.rejectCredential = true;
		const destination = destinationFor();

		const result = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		expect(result.totalFiles).toBe(AMSTERDAM_CLOSURE.length);
		expect(fake.rawGets).toBe(AMSTERDAM_CLOSURE.length);
	});

	it('reviews two Projects from two Remotes into two Workspaces that hold their own', async () => {
		// A teacher marking submissions moves between them, and two students' conflicting Alignments of
		// the same sheet never meet (ADR-0023, ADR-0024).
		const one = await github();
		const other = await createFakeGitHub({
			owner: 'grace',
			repository: 'harbours',
			tree: PUBLISHED
		});
		const first = destinationFor(new MemoryProjectStore(), 'atlas');
		const second = destinationFor(new MemoryProjectStore(), 'harbours');

		await reviewFromRemote(first.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: one.fetch
		});
		await reviewFromRemote(second.open, {
			remote: { owner: 'grace', repository: 'harbours', project: BOSTON },
			fetch: other.fetch
		});

		expect(await text(first.store, 'alignments/map-1.json')).toContain('amsterdam');
		expect(await first.store.list('')).not.toContain('alignments/map-2.json');
		expect(await text(second.store, 'alignments/map-2.json')).toContain('boston');
		expect(await second.store.list('')).not.toContain('alignments/map-1.json');
	});

	it('says which Map Image the Remote did not hold, rather than dropping the Layer', async () => {
		// ⚠ **A transfer that quietly delivers less than it was given is the failure the whole tar
		// format change escaped**, and here it is invisible without this: nothing on a Layer card says
		// an image is missing, so a map Layer whose pyramid never arrived draws blank and looks exactly
		// like one nobody has aligned yet. The bundle path refuses this by name; a Review reports it,
		// because refusing would leave the reviewer unable to read the Annotations that *did* come.
		const fake = await github(withoutFiles('images/map-1/info.json', 'images/map-1/0/0/0.jpg'));
		const destination = destinationFor();

		const result = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		expect(result.unmet).toEqual([
			{ reference: 'images/map-1/', layer: 'The sheet', kind: 'image' }
		]);
		expect(result.notice).toContain('1 Layer names a Map Image the Remote does not hold');
		expect(result.notice).toContain('“The sheet” (images/map-1/)');
		// And the rest of the Project is there to read, which is the whole reason not to refuse.
		expect(await text(destination.store, `${AMSTERDAM}/annotations/warehouses.geojson`)).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
		// The Alignment does not travel alone: without the pyramid it names there is nothing to place.
		expect(await destination.store.list('')).not.toContain('alignments/map-1.json');
	});

	it('says so for an image directory that describes itself as neither kind', async () => {
		// A heap of tiles with no `info.json` — and no `remote.json`, which is how a referenced image
		// says its tiles are on somebody else's server — is a directory no client can open, so the map
		// is missing whether or not the directory is there. `assertReferencesPresent` draws the same
		// line, and the reference names the file an author has to publish.
		const fake = await github(withoutFiles('images/map-1/info.json'));

		const result = await reviewFromRemote(destinationFor().open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		expect(result.unmet).toEqual([
			{ reference: 'images/map-1/info.json', layer: 'The sheet', kind: 'image' }
		]);
		expect(result.notice).toContain('will draw nothing');
	});

	it('says which Annotation document the Remote did not hold', async () => {
		// The case the bundle path refuses by name — "this bundle is missing X, which the Layer Y needs
		// to be drawn" — and the one the first cut of this module dropped without a word, because it
		// took whatever happened to be under the Project's directory and asked nothing.
		const fake = await github(withoutFiles(`${AMSTERDAM}/annotations/warehouses.geojson`));
		const destination = destinationFor();

		const result = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		});

		expect(result.unmet).toEqual([
			{
				reference: `${AMSTERDAM}/annotations/warehouses.geojson`,
				layer: 'Warehouses',
				kind: 'annotation'
			}
		]);
		expect(result.notice).toContain('1 Layer names an Annotation file the Remote does not hold');
		expect(result.notice).toContain('“Warehouses”');
		// And the Map Image still came, so the reviewer sees the sheet the Annotations were about.
		expect(await text(destination.store, 'images/map-1/info.json')).toBe(
			'{"width":1024,"height":768}'
		);
	});

	it('refuses rather than count a file the destination would not take', async () => {
		// ⚠ The invariant the count depends on: a review copy is made empty and filled once, so
		// `writeAlignmentBytes` cannot decline against it. A destination that is *not* new breaks that,
		// and the alternative to refusing is a Review reporting every file delivered while an Alignment
		// is not in the Workspace — which is exactly what `unmet` exists to make impossible.
		const notNew = new MemoryProjectStore();
		// alignment-write-is-the-fixture: the Alignment already in the destination *is* the specimen — what makes the destination not new, so the decline this guard answers becomes reachable
		await notNew.write(
			'alignments/map-1.json' as StorePath,
			new TextEncoder().encode('{"formatVersion":1,"controlPoints":["somebody else’s"]}')
		);
		const fake = await github();
		const destination = destinationFor(notNew);

		const refusal = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('incomplete');
		expect((refusal as Error).message).toMatch(/already there/);
		expect(destination.discarded).toBe(1);
	});

	it('reports per-file progress against the Project’s own total', async () => {
		const fake = await github();
		const progress: { files: number; totalFiles: number }[] = [];

		await reviewFromRemote(destinationFor().open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch,
			onProgress: ({ files, totalFiles }) => progress.push({ files, totalFiles })
		});

		expect(progress.at(-1)).toEqual({
			files: AMSTERDAM_CLOSURE.length,
			totalFiles: AMSTERDAM_CLOSURE.length
		});
		expect(progress.every((step) => step.totalFiles === AMSTERDAM_CLOSURE.length)).toBe(true);
	});
});

describe('what a Review refuses', () => {
	it('a truncated file list, before a byte is asked for', async () => {
		// ⚠ A truncated listing answers **200**, so nothing throws anywhere. Proceeding would hand the
		// reviewer a Project drawing a map full of holes and say nothing at all about why.
		const fake = await github();
		fake.truncateAfter = 4;
		const destination = destinationFor();

		const refusal = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		}).catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(ReviewRefusedError);
		expect((refusal as ReviewRefusedError).refusal).toBe('truncated');
		expect((refusal as Error).message).toMatch(/silently missing/);
		expect((refusal as Error).message).toMatch(/Nothing has been opened\./);
		expect(fake.rawGets).toBe(0);
		expect(destination.opened).toBe(0);
	});

	it('too little room, named in bytes, before a Workspace is made', async () => {
		const fake = await github();
		const destination = destinationFor();

		const refusal = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch,
			estimateStorage: async () => ({ quota: 1_000_010, usage: 1_000_000 })
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('insufficient-quota');
		expect((refusal as Error).message).toMatch(/needs about/);
		expect((refusal as Error).message).toMatch(/already in use/);
		expect(destination.opened).toBe(0);
	});

	it('a Project folder the Remote does not hold, naming the ones it does', async () => {
		// A Project's identity is its folder (ADR-0008), which is not what a colleague says out loud —
		// so a right repository and a wrong folder is the likeliest way to be here.
		const fake = await github();
		const destination = destinationFor();

		const refusal = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: 'amsterdam' },
			fetch: fake.fetch
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('no-project');
		expect((refusal as Error).message).toContain(AMSTERDAM);
		expect((refusal as Error).message).toContain(BOSTON);
		expect(destination.opened).toBe(0);
	});

	it('a folder that is not a Project at all, however it is spelled', async () => {
		// The path validation, and the whole of it: the answer is a set of directory names read out of
		// the tree, so nothing a user types reaches a URL unless the Remote named it first.
		const fake = await github();

		for (const project of ['images', '../secrets', 'alignments/map-1.json']) {
			const refusal = await reviewFromRemote(destinationFor().open, {
				remote: { owner: OWNER, repository: REPOSITORY, project },
				fetch: fake.fetch
			}).catch((cause: unknown) => cause);
			expect((refusal as ReviewRefusedError).refusal).toBe('no-project');
		}
		expect(fake.rawGets).toBe(0);
	});

	it('a repository no anonymous reader can see', async () => {
		const fake = await github();

		const refusal = await reviewFromRemote(destinationFor().open, {
			remote: { owner: OWNER, repository: 'not-published', project: AMSTERDAM },
			fetch: fake.fetch
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('no-repository');
		// A private repository and a missing one are one answer to an anonymous reader, and the
		// sentence says so rather than sending the user off to check a name that may be fine.
		expect((refusal as Error).message).toMatch(/private/);
		expect((refusal as Error).message).toMatch(/Nothing has been opened\./);
	});

	it('bytes that are not the ones the tree named, discarding the whole review copy', async () => {
		// ⚠ The only refusal that can happen after the Workspace exists — and it leaves nothing, which
		// is the deliberate divergence from the Clone. A Clone keeps its partial Workspace because it
		// can resume into it; a review copy is a thing you throw away, so there is nothing to protect.
		const fake = await github();
		const destination = destinationFor();
		const rewritten = rawAnswer(
			fake,
			'images/map-1/0/0/0.jpg',
			() => new Response('a proxy rewrote this', { status: 200 })
		);

		const refusal = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: rewritten
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('incomplete');
		expect((refusal as Error).message).toMatch(/different bytes/);
		expect(destination.discarded).toBe(1);
		expect(await destination.store.list('')).toEqual([]);
	});

	it('a file the tree listed and the host will not serve', async () => {
		const fake = await github();
		const destination = destinationFor();
		const missing = rawAnswer(
			fake,
			`${AMSTERDAM}/annotations/warehouses.geojson`,
			() => new Response('gone', { status: 404 })
		);

		const refusal = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: missing
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('incomplete');
		expect(destination.discarded).toBe(1);
		expect(await destination.store.list('')).toEqual([]);
	});

	it('a Project from a newer version of the app, before a Workspace is made', async () => {
		// ADR-0010, re-ended for this path. It lands while there is still nothing to throw away,
		// because a tree is an index and the manifest can be read before the destination exists.
		const fake = await github({
			...PUBLISHED,
			[`${AMSTERDAM}/project.json`]: JSON.stringify({
				formatVersion: 99,
				name: 'Next year’s',
				updatedAt: '2026-01-01T00:00:00.000Z',
				layers: []
			})
		});
		const destination = destinationFor();

		const refusal = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		}).catch((cause: unknown) => cause);

		expect((refusal as Error).name).toBe('ProjectFormatTooNewError');
		expect((refusal as Error).message).toMatch(/Nothing has been opened\./);
		expect(destination.opened).toBe(0);
	});

	it('a repository GitHub will not read at all without signing in', async () => {
		// GitHub answers 401 rather than 404 for some private repositories, and the sentence differs
		// from the missing-repository one because only this one can be acted on: there is nothing to
		// check in the address, and reviewing has no sign-in to offer.
		const demanding = (async () =>
			new Response(JSON.stringify({ message: 'Requires authentication' }), {
				status: 401,
				headers: { 'content-type': 'application/json' }
			})) as FakeGitHub['fetch'];

		const refusal = await reviewFromRemote(destinationFor().open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: demanding
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('no-repository');
		expect((refusal as Error).message).toMatch(/not a public repository/);
		expect((refusal as Error).message).toMatch(/bundle instead/);
		expect((refusal as Error).message).toMatch(/Nothing has been opened\./);
	});

	it('the anonymous hourly limit, told apart from a repository that is not public', async () => {
		// ⚠ **A spent budget and a private repository are both 403**, and this is the path where the
		// difference bites: reviewing signs in to nothing, so the budget is GitHub's 60 requests an hour
		// *per IP address* — and the scenario is a class of students reviewing one
		// instructor's Project from one campus connection, where the 61st reader meets this having made
		// no requests at all. "Ask whoever published it to make it public" is then an instruction about
		// a repository none of them own, and following it would not help.
		const fake = await github();
		fake.rateLimit = { remaining: 0, reset: 1_800_000_000 };
		const destination = destinationFor();

		const refusal = await reviewFromRemote(destination.open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: fake.fetch
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('rate-limited');
		expect((refusal as Error).message).toMatch(/hourly limit for anonymous readers/);
		expect((refusal as Error).message).toMatch(/60 requests an hour/);
		// Said as a wait, never as a fault in the repository or in what the user typed.
		expect((refusal as Error).message).not.toMatch(/private/);
		expect((refusal as Error).message).toMatch(/when the limit resets/);
		expect((refusal as Error).message).toMatch(/Nothing has been opened\./);
		expect(fake.rawGets).toBe(0);
		expect(destination.opened).toBe(0);
	});

	it('a file list that fails in a way it has no name for', async () => {
		// A `fetch` replaced by an extension or a service worker can answer with something that is not a
		// response at all. What the user gets is still a refusal rather than a stack trace's first line.
		const answering = (async () => null) as unknown as FakeGitHub['fetch'];

		const refusal = await reviewFromRemote(destinationFor().open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: answering
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('refused');
		expect((refusal as Error).message).toMatch(/Nothing has been opened\./);
	});

	it('a connection that never answers', async () => {
		const failing = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});

		const refusal = await reviewFromRemote(destinationFor().open, {
			remote: { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM },
			fetch: failing as unknown as FakeGitHub['fetch']
		}).catch((cause: unknown) => cause);

		expect((refusal as ReviewRefusedError).refusal).toBe('refused');
		expect((refusal as Error).message).toMatch(/could not be reached/);
	});
});
