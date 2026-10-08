import { describe, expect, it } from 'vitest';

import { readReviewMark, type ReviewOrigin } from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import type { ProjectStore, StorePath } from '../store/project-store.js';
import type { ReviewDestination } from '../transfer/project-import-source.js';
import { bindWorkspaceToRemote } from './bind-remote.js';
import { closedWhileReviewing, memoryCredentialStore } from './credential-store.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { ReviewRefusedError, reviewFromRemote } from './review-from-remote.js';
import { rawAnswer, storedText as text } from './remote-test-support.js';
import { encode, rejection } from '../test-support.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const AMSTERDAM = 'amsterdam-1625';
const BOSTON = 'boston-1710';
const EMPTY = '{"type":"FeatureCollection","features":[]}';

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

const ON_REMOTE: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'_app/app.js': 'export const start = () => {};',
	'ballastella-site.json': '{"formatVersion":2,"projects":[]}',
	[`${AMSTERDAM}/project.json`]: projectJson(
		'Amsterdam 1625',
		'map-1',
		'annotations/warehouses.geojson'
	),
	[`${AMSTERDAM}/annotations/warehouses.geojson`]: EMPTY,
	[`${BOSTON}/project.json`]: projectJson('Boston 1710', 'map-2', 'annotations/wharves.geojson'),
	[`${BOSTON}/annotations/wharves.geojson`]: EMPTY,
	'images/map-1/info.json': '{"width":1024,"height":768}',
	'images/map-1/0/0/0.jpg': 'amsterdam-tile-bytes',
	'images/map-2/info.json': '{"width":2048,"height":1536}',
	'images/map-2/0/0/0.jpg': 'boston-tile-bytes',
	'images/map-3/info.json': '{"width":512,"height":512}',
	'images/map-3/0/0/0.jpg': 'unused-tile-bytes',
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":["amsterdam"]}',
	'alignments/map-2.json': '{"formatVersion":1,"controlPoints":["boston"]}',
	'alignments/map-3.json': '{"formatVersion":1,"controlPoints":["nobody"]}',
	...Object.fromEntries(
		['README.md', 'CNAME', 'LICENSE', '.github/workflows/pages.yml'].map((path) => [
			path,
			`${path}, the scholar's own\n`
		])
	)
};

const AMSTERDAM_CLOSURE = [
	'alignments/map-1.json',
	`${AMSTERDAM}/annotations/warehouses.geojson`,
	`${AMSTERDAM}/project.json`,
	'images/map-1/0/0/0.jpg',
	'images/map-1/info.json'
];

const github = (tree: Record<string, string> = ON_REMOTE): Promise<FakeGitHub> =>
	createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree });

const withoutFiles = (...paths: string[]): Record<string, string> =>
	Object.fromEntries(Object.entries(ON_REMOTE).filter(([path]) => !paths.includes(path)));

function destinationFor(
	store: ProjectStore = new MemoryProjectStore(),
	name = REPOSITORY,
	origin: ReviewOrigin | null = null
) {
	const counts = { opened: 0, discarded: 0 };
	return {
		store,
		counts,
		open: async (preferred: string): Promise<ReviewDestination> => {
			counts.opened += 1;
			return {
				name: preferred === REPOSITORY ? name : preferred,
				store,
				origin,
				discard: async () => {
					counts.discarded += 1;
					for (const path of await store.list('')) await store.delete(path as StorePath);
				}
			};
		}
	};
}

const AMSTERDAM_REVIEW = { owner: OWNER, repository: REPOSITORY, project: AMSTERDAM };

const review = (
	open: (preferred: string) => Promise<ReviewDestination>,
	fetch: FetchFn,
	options: Partial<Parameters<typeof reviewFromRemote>[1]> = {}
) => reviewFromRemote(open, { remote: AMSTERDAM_REVIEW, fetch, ...options });

const refused = (...args: Parameters<typeof review>): Promise<ReviewRefusedError> =>
	rejection(ReviewRefusedError, review(...args));

describe('reviewFromRemote', () => {
	it('fills a Review Workspace with one Project and what its Layers reference, and nothing else', async () => {
		const fake = await github();
		fake.rejectCredential = true;
		const destination = destinationFor();
		const progress: { files: number; totalFiles: number }[] = [];

		const result = await review(destination.open, fake.fetch, {
			onProgress: ({ files, totalFiles }) => progress.push({ files, totalFiles })
		});

		expect([result.workspaceName, result.directory, result.project.name]).toEqual([
			REPOSITORY,
			AMSTERDAM,
			'Amsterdam 1625'
		]);
		expect([result.totalFiles, fake.rawGets, result.unmet]).toEqual([
			AMSTERDAM_CLOSURE.length,
			AMSTERDAM_CLOSURE.length,
			[]
		]);
		expect(await destination.store.list('')).toEqual([...AMSTERDAM_CLOSURE, 'review.json'].sort());
		expect(await text(destination.store, 'images/map-1/0/0/0.jpg')).toBe('amsterdam-tile-bytes');
		expect(await text(destination.store, 'alignments/map-1.json')).toBe(
			ON_REMOTE['alignments/map-1.json']
		);
		expect(await text(destination.store, `${AMSTERDAM}/annotations/warehouses.geojson`)).toBe(
			EMPTY
		);
		const total = AMSTERDAM_CLOSURE.length;
		expect(progress.at(-1)).toEqual({ files: total, totalFiles: total });
		expect(progress.every((step) => step.totalFiles === total)).toBe(true);
	});

	it('marks the Workspace as a review copy, with its origin, before any Project byte lands', async () => {
		const fake = await github();
		const store = new MemoryProjectStore();
		const written: string[] = [];
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
		const origin: ReviewOrigin = {
			workspaceKey: 'folder:maps',
			backing: 'folder',
			name: 'maps',
			folderReference: 'retained:8f1c'
		};

		const result = await review(destinationFor(watched, REPOSITORY, origin).open, fake.fetch, {
			now: () => new Date('2026-05-01T09:00:00.000Z')
		});

		expect([written[0], written.at(-1)]).toEqual(['review.json', `${AMSTERDAM}/project.json`]);
		expect(await readReviewMark(store)).toEqual({
			formatVersion: 1,
			project: 'Amsterdam 1625',
			directory: AMSTERDAM,
			openedAt: '2026-05-01T09:00:00.000Z',
			origin
		});
		expect(result.notice).toContain('review copy');
	});

	it('refuses to connect what it made to a repository, and seals the credential store while open', async () => {
		const fake = await github();
		const destination = destinationFor();
		await review(destination.open, fake.fetch);

		await expect(
			bindWorkspaceToRemote(destination.store, REPOSITORY, {
				token: 'ghp_whatever',
				remote: { owner: OWNER, repository: REPOSITORY },
				fetch: fake.fetch
			})
		).rejects.toThrow(/review copy/);

		const held = memoryCredentialStore();
		held.write('github_pat_the-teachers-own-token');
		const mark = await readReviewMark(destination.store);
		const sealed = closedWhileReviewing(() => mark !== null, held);
		expect(mark).not.toBeNull();
		expect(sealed.read()).toBeNull();
		sealed.write('github_pat_something-else');
		sealed.clear();
		expect(held.read()).toBe('github_pat_the-teachers-own-token');
	});

	it('reviews two Projects from two Remotes into two Workspaces that hold their own', async () => {
		const one = await github();
		const other = await createFakeGitHub({
			owner: 'grace',
			repository: 'harbours',
			tree: ON_REMOTE
		});
		const first = destinationFor(new MemoryProjectStore(), 'atlas');
		const second = destinationFor(new MemoryProjectStore(), 'harbours');

		await review(first.open, one.fetch);
		await review(second.open, other.fetch, {
			remote: { owner: 'grace', repository: 'harbours', project: BOSTON }
		});

		expect(await text(first.store, 'alignments/map-1.json')).toContain('amsterdam');
		expect(await first.store.list('')).not.toContain('alignments/map-2.json');
		expect(await text(second.store, 'alignments/map-2.json')).toContain('boston');
		expect(await second.store.list('')).not.toContain('alignments/map-1.json');
	});

	it.each([
		{
			missing: 'a Map Image',
			paths: ['images/map-1/info.json', 'images/map-1/0/0/0.jpg'],
			unmet: { reference: 'images/map-1/', layer: 'The sheet', kind: 'image' },
			notice: ['1 Layer names a Map Image the Remote does not hold', '“The sheet” (images/map-1/)'],
			kept: [`${AMSTERDAM}/annotations/warehouses.geojson`, EMPTY],
			absent: 'alignments/map-1.json'
		},
		{
			missing: 'an image directory that describes itself as neither kind',
			paths: ['images/map-1/info.json'],
			unmet: { reference: 'images/map-1/info.json', layer: 'The sheet', kind: 'image' },
			notice: ['will draw nothing'],
			kept: null,
			absent: null
		},
		{
			missing: 'an Annotation document',
			paths: [`${AMSTERDAM}/annotations/warehouses.geojson`],
			unmet: {
				reference: `${AMSTERDAM}/annotations/warehouses.geojson`,
				layer: 'Warehouses',
				kind: 'annotation'
			},
			notice: ['1 Layer names an Annotation file the Remote does not hold', '“Warehouses”'],
			kept: ['images/map-1/info.json', '{"width":1024,"height":768}'],
			absent: null
		}
	])('says the Remote did not hold $missing, rather than dropping the Layer', async (row) => {
		const fake = await github(withoutFiles(...row.paths));
		const destination = destinationFor();
		const result = await review(destination.open, fake.fetch);

		expect(result.unmet).toEqual([row.unmet]);
		for (const part of row.notice) expect(result.notice).toContain(part);
		if (row.kept) expect(await text(destination.store, row.kept[0]!)).toBe(row.kept[1]);
		if (row.absent) expect(await destination.store.list('')).not.toContain(row.absent);
	});
});

describe('what a Review refuses', () => {
	const demanding = (async () =>
		new Response(JSON.stringify({ message: 'Requires authentication' }), {
			status: 401,
			headers: { 'content-type': 'application/json' }
		})) as FetchFn;

	it.each<{
		what: string;
		refusal: string;
		says?: RegExp[];
		naming?: string[];
		not?: RegExp;
		reads?: number;
		arrange?: (fake: FakeGitHub) => void;
		fetch?: FetchFn;
		options?: Partial<Parameters<typeof reviewFromRemote>[1]>;
	}>([
		{
			what: 'a truncated file list',
			refusal: 'truncated',
			says: [/silently missing/, /Nothing has been opened\./],
			arrange: (fake) => (fake.truncateAfter = 4)
		},
		{
			what: 'too little room, named in bytes',
			refusal: 'insufficient-quota',
			says: [/needs about/, /already in use/],
			reads: 1,
			options: { estimateStorage: async () => ({ quota: 1_000_010, usage: 1_000_000 }) }
		},
		{
			what: 'a Project folder the Remote does not hold, naming the ones it does',
			refusal: 'no-project',
			naming: [AMSTERDAM, BOSTON],
			options: { remote: { ...AMSTERDAM_REVIEW, project: 'amsterdam' } }
		},
		...['images', '../secrets', 'alignments/map-1.json'].map((project) => ({
			what: `“${project}”, which is not a Project at all`,
			refusal: 'no-project',
			options: { remote: { ...AMSTERDAM_REVIEW, project } }
		})),
		{
			what: 'a repository no anonymous reader can see',
			refusal: 'no-repository',
			says: [/private/, /Nothing has been opened\./],
			options: { remote: { ...AMSTERDAM_REVIEW, repository: 'nothing-sent' } }
		},
		{
			what: 'a repository GitHub will not read at all without signing in',
			refusal: 'no-repository',
			says: [/not a public repository/, /bundle instead/, /Nothing has been opened\./],
			fetch: demanding
		},
		{
			what: 'the anonymous hourly limit, told apart from a repository that is not public',
			refusal: 'rate-limited',
			says: [
				/hourly limit for anonymous readers/,
				/60 requests an hour/,
				/when the limit resets/,
				/Nothing has been opened\./
			],
			not: /private/,
			arrange: (fake) => (fake.rateLimit = { remaining: 0, reset: 1_800_000_000 })
		},
		{
			what: 'a file list that fails in a way it has no name for',
			refusal: 'refused',
			says: [/Nothing has been opened\./],
			fetch: (async () => null) as unknown as FetchFn
		},
		{
			what: 'a connection that never answers',
			refusal: 'refused',
			says: [/could not be reached/],
			fetch: async () => {
				throw new TypeError('Failed to fetch');
			}
		}
	])('$what, before a Workspace is made', async (row) => {
		const fake = await github();
		row.arrange?.(fake);
		const destination = destinationFor();

		const refusal = await refused(destination.open, row.fetch ?? fake.fetch, row.options);

		expect(refusal.refusal).toBe(row.refusal);
		for (const pattern of row.says ?? []) expect(refusal.message).toMatch(pattern);
		for (const name of row.naming ?? []) expect(refusal.message).toContain(name);
		if (row.not) expect(refusal.message).not.toMatch(row.not);
		expect([fake.rawGets, destination.counts.opened]).toEqual([row.reads ?? 0, 0]);
	});

	it.each<{
		what: string;
		says?: RegExp;
		arrange: (fake: FakeGitHub, store: ProjectStore) => Promise<FetchFn>;
	}>([
		{
			what: 'a file the destination would not take, rather than count it',
			says: /already there/,
			arrange: async (fake, store) => {
				await store.write(
					'alignments/map-1.json' as StorePath,
					encode('{"formatVersion":1,"controlPoints":["somebody else’s"]}')
				);
				return fake.fetch;
			}
		},
		{
			what: 'bytes that are not the ones the tree named',
			says: /different bytes/,
			arrange: async (fake) =>
				rawAnswer(fake, 'images/map-1/0/0/0.jpg', () => new Response('a proxy rewrote this'))
		},
		{
			what: 'a file the tree listed and the host will not serve',
			arrange: async (fake) =>
				rawAnswer(
					fake,
					`${AMSTERDAM}/annotations/warehouses.geojson`,
					() => new Response('gone', { status: 404 })
				)
		}
	])('$what, discarding the whole review copy', async ({ says, arrange }) => {
		const fake = await github();
		const destination = destinationFor();
		const fetch = await arrange(fake, destination.store);

		const refusal = await refused(destination.open, fetch);

		expect(refusal.refusal).toBe('incomplete');
		if (says) expect(refusal.message).toMatch(says);
		expect(destination.counts.discarded).toBe(1);
		expect(await destination.store.list('')).toEqual([]);
	});

	it('a Project from a newer version of the app, before a Workspace is made', async () => {
		const fake = await github({
			...ON_REMOTE,
			[`${AMSTERDAM}/project.json`]: JSON.stringify({
				formatVersion: 99,
				name: 'Next year’s',
				updatedAt: '2026-01-01T00:00:00.000Z',
				layers: []
			})
		});
		const destination = destinationFor();
		const refusal = (await review(destination.open, fake.fetch).catch((cause) => cause)) as Error;
		expect(refusal.name).toBe('ProjectFormatTooNewError');
		expect(refusal.message).toMatch(/Nothing has been opened\./);
		expect(destination.counts.opened).toBe(0);
	});
});
