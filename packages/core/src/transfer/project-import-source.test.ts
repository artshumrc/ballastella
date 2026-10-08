import { describe, expect, it } from 'vitest';

import { ProjectFormatTooNewError } from '../project/project-file.js';
import { REVIEW_MARK_FORMAT_VERSION, type ReviewMark } from '../project/review-workspace.js';
import { GITHUB_RAW_ORIGIN } from '../remote/github-api.js';
import { createFakeGitHub } from '../remote/fake-github.js';
import { readRemoteProjectSource } from '../remote/remote-project-source.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { PathNotFoundError, type EnumerableReadOnlyProjectStore } from '../store/project-store.js';
import { decode, encode } from '../test-support.js';
import {
	ImportSourceRefusedError,
	createProjectImportSource,
	parseImportedProjectFile,
	readReviewWorkspaceSource,
	type ProjectImportSource
} from './project-import-source.js';
import {
	REVIEW_ORIGIN,
	PLAN_LAYER,
	WAREHOUSES_LAYER,
	delivered,
	planted,
	projectJson as bundleProjectJson
} from './test-fixtures.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const DIRECTORY = 'amsterdam-1625';

const projectJson = (overrides: Record<string, unknown> = {}): string =>
	bundleProjectJson({
		layers: [
			PLAN_LAYER,
			WAREHOUSES_LAYER,
			{
				...PLAN_LAYER,
				id: 'l3',
				name: 'The unplaced sheet',
				order: 2,
				opacity: 1,
				imageId: 'unaligned-map'
			},
			{ ...PLAN_LAYER, id: 'l4', name: 'The 1625 plan again', order: 3, opacity: 0.4 }
		],
		...overrides
	});

const WORKSPACE: Record<string, string> = {
	[`${DIRECTORY}/project.json`]: projectJson(),
	[`${DIRECTORY}/annotations/warehouses.geojson`]: '{"type":"FeatureCollection","features":[]}',
	[`${DIRECTORY}/annotations/superseded.geojson`]: '{"type":"FeatureCollection","features":[1]}',
	[`${DIRECTORY}/index.html`]: '<!doctype html><title>Amsterdam</title>',
	[`${DIRECTORY}/_app/app.js`]: 'export const start = () => {};',
	[`${DIRECTORY}/base-map/glyphs/0.pbf`]: 'glyph bytes',

	'the-canal-ring/project.json': projectJson({
		name: 'The Canal Ring',
		layers: [
			{ id: 'l9', name: 'Blaeu', visible: true, order: 0, kind: 'map', imageId: 'blaeu-1649' }
		]
	}),
	'the-canal-ring/annotations/canals.geojson': '{"type":"FeatureCollection","features":[]}',

	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0/0/0.jpg': 'not really a jpeg, but bytes',
	'images/unaligned-map/info.json': '{"width":512,"height":512}',
	'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
	'images/blaeu-1649/0/0/0.jpg': 'somebody else’s tile',

	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}',

	'ballastella-site.json': '{"formatVersion":2,"projects":[]}',
	'review.json': JSON.stringify({
		formatVersion: 1,
		project: 'Amsterdam 1625',
		directory: DIRECTORY
	}),
	'base-map/tiles/protomaps/0/0/0.mvt': 'tile bytes'
};

const CLOSURE = [
	'alignments/amsterdam-1625.json',
	'annotations/warehouses.geojson',
	'images/amsterdam-1625/0/0/0.jpg',
	'images/amsterdam-1625/info.json',
	'images/unaligned-map/info.json',
	'project.json'
];

const MARK: ReviewMark = {
	formatVersion: REVIEW_MARK_FORMAT_VERSION,
	project: 'Amsterdam 1625',
	directory: DIRECTORY,
	openedAt: '2026-08-22T10:00:00.000Z',
	origin: null
};

const without = (...paths: string[]): Record<string, string> =>
	Object.fromEntries(Object.entries(WORKSPACE).filter(([path]) => !paths.includes(path)));

const remoteSource = async (
	files: Record<string, string> = WORKSPACE
): Promise<ProjectImportSource> => {
	const fake = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: files });
	return readRemoteProjectSource({
		remote: { owner: OWNER, repository: REPOSITORY, project: DIRECTORY },
		fetch: fake.fetch
	});
};

const reviewSource = async (
	files: Record<string, string> = WORKSPACE,
	mark: ReviewMark = MARK
): Promise<ProjectImportSource> => readReviewWorkspaceSource({ store: planted(files), mark });

const adapters = [
	['a Project on a GitHub Remote', remoteSource],
	['a Review Workspace', reviewSource]
] as const;

describe('one closure, whichever source it comes from', () => {
	it.each(adapters)(
		'declares, weighs without reading, and hands over exactly this Project from %s',
		async (_name, open) => {
			const source = await open();
			expect(source.paths).toEqual(CLOSURE);
			expect(source.project.name).toBe('Amsterdam 1625');
			expect(decode(source.projectFileBytes)).toBe(WORKSPACE[`${DIRECTORY}/project.json`]);
			const workspacePath = (path: string) =>
				path.startsWith('images/') || path.startsWith('alignments/')
					? path
					: `${DIRECTORY}/${path}`;
			expect(source.totalBytes).toBe(
				CLOSURE.reduce((sum, path) => sum + encode(WORKSPACE[workspacePath(path)] ?? '').length, 0)
			);

			const files = await delivered(source);
			expect(Object.keys(files).sort()).toEqual(CLOSURE);
			for (const path of ['alignments/amsterdam-1625.json', 'annotations/warehouses.geojson']) {
				expect(files[path]).toBe(WORKSPACE[workspacePath(path)]);
			}
		}
	);
});

describe('what a source observed about where it came from', () => {
	it('records the repository, branch, directory and commit of a Remote Project, and no credential', async () => {
		const fake = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: WORKSPACE });
		const source = await readRemoteProjectSource({
			remote: { owner: OWNER, repository: REPOSITORY, project: DIRECTORY },
			fetch: fake.fetch
		});
		expect(source.origin).toEqual({
			kind: 'github',
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main',
			directory: DIRECTORY,
			commit: fake.head(),
			projectName: 'Amsterdam 1625'
		});
	});

	it('copies one commit, and keeps copying it when the branch moves underneath', async () => {
		const fake = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: WORKSPACE });
		const at = fake.head();
		let pushed = false;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const response = await fake.fetch(input, init);
			if (!pushed && new URL(String(input)).origin === GITHUB_RAW_ORIGIN) {
				pushed = true;
				await fake.commitFiles({
					[`${DIRECTORY}/annotations/warehouses.geojson`]: '{"type":"FeatureCollection"}'
				});
			}
			return response;
		};

		const source = await readRemoteProjectSource({
			remote: { owner: OWNER, repository: REPOSITORY, project: DIRECTORY },
			fetch
		});
		const files = await delivered(source);
		expect(fake.head()).not.toBe(at);
		expect(source.origin).toMatchObject({ kind: 'github', commit: at });
		expect(files['annotations/warehouses.geojson']).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
	});

	it('records what the Review mark says the review copy holds', async () => {
		expect((await reviewSource()).origin).toEqual({
			kind: 'review',
			projectName: 'Amsterdam 1625',
			directory: DIRECTORY
		});
	});
});

describe('the source capability cannot write anywhere', () => {
	it('has no write, delete, destination or credential on its public type', async () => {
		type Forbidden = Extract<
			keyof ProjectImportSource,
			'write' | 'delete' | 'store' | 'destination' | 'credential' | 'token'
		>;
		const none: Forbidden extends never ? true : false = true;
		expect(none).toBe(true);
		const source = await reviewSource();
		expect(Object.keys(source).sort()).toEqual([
			'files',
			'origin',
			'paths',
			'project',
			'projectFileBytes',
			'totalBytes'
		]);
	});

	it('takes no ordinary writable destination', async () => {
		const store = new MemoryProjectStore();
		await expect(
			readReviewWorkspaceSource({
				store,
				mark: MARK,
				// @ts-expect-error -- a source reader has no destination to write into (ADR-0037)
				destination: store
			})
		).rejects.toThrow(ImportSourceRefusedError);
	});
});

describe('a source is refused before anything could be installed', () => {
	const offering = (offered: readonly string[]) =>
		createProjectImportSource({
			origin: REVIEW_ORIGIN,
			project: parseImportedProjectFile(encode(projectJson())),
			projectFileBytes: encode(projectJson()),
			offered: offered.map((path) => ({ path, bytes: 1 })),
			files: async function* () {}
		});

	it('refuses an entry that would not stay inside the Project', () => {
		expect(() => offering(['project.json', '../escape.txt'])).toThrow(
			expect.objectContaining({ name: 'ImportSourceRefusedError', refusal: 'unsafe-path' })
		);
	});

	it.each([['annotations/warehouses.geojson'], ['project.json']])(
		'refuses a source that names %s twice',
		(twice) => {
			expect(() => offering(['project.json', 'annotations/warehouses.geojson', twice])).toThrow(
				expect.objectContaining({ refusal: 'duplicate-entry' })
			);
		}
	);

	it('refuses a project.json that is not a Project', async () => {
		await expect(
			reviewSource({ ...WORKSPACE, [`${DIRECTORY}/project.json`]: 'not json at all' })
		).rejects.toMatchObject({ refusal: 'malformed-project-file' });
	});

	const refusal = (code: string) => expect.objectContaining({ refusal: code });
	const REFUSED = [
		{
			what: 'a Project from a newer build of the app',
			files: { ...WORKSPACE, [`${DIRECTORY}/project.json`]: projectJson({ formatVersion: 2 }) },
			error: ProjectFormatTooNewError as unknown
		},
		{
			what: 'a missing Annotation',
			files: without(`${DIRECTORY}/annotations/warehouses.geojson`),
			error: refusal('missing-annotation')
		},
		{
			what: 'a missing Map Image',
			files: without('images/amsterdam-1625/info.json', 'images/amsterdam-1625/0/0/0.jpg'),
			error: refusal('missing-image')
		},
		{
			what: 'an image directory nothing can read',
			files: without('images/amsterdam-1625/info.json'),
			error: refusal('incomplete-image')
		},
		{
			what: 'a Layer reference into generated site output',
			files: {
				...WORKSPACE,
				[`${DIRECTORY}/project.json`]: projectJson({
					layers: [{ ...WAREHOUSES_LAYER, order: 0, geojsonRef: '_app/app.js' }]
				})
			},
			error: refusal('missing-annotation')
		}
	];

	it.each(adapters.flatMap(([source, open]) => REFUSED.map((row) => ({ ...row, source, open }))))(
		'refuses $what in $source',
		async ({ files, open, error }) => {
			await expect(open(files)).rejects.toThrow(error as Error);
		}
	);

	it.each(adapters)(
		'accepts a referenced Map Image described by remote.json in %s',
		async (_name, open) => {
			const files = {
				...without('images/amsterdam-1625/info.json'),
				'images/amsterdam-1625/remote.json':
					'{"formatVersion":1,"service":"https://iiif.example/x"}'
			};
			expect((await open(files)).paths).toContain('images/amsterdam-1625/remote.json');
		}
	);

	it('names every unresolved reference, not only the first', async () => {
		await expect(
			reviewSource(
				without(`${DIRECTORY}/annotations/warehouses.geojson`, 'images/unaligned-map/info.json')
			)
		).rejects.toThrow(/images\/unaligned-map/);
	});

	it('refuses a source that lists an Alignment and then cannot hand it over', async () => {
		const store = planted(WORKSPACE);
		const vanishing: EnumerableReadOnlyProjectStore = {
			list: (prefix) => store.list(prefix),
			size: (path) => store.size(path),
			read: (path) => {
				if (path === 'alignments/amsterdam-1625.json') {
					return Promise.reject(new PathNotFoundError(path));
				}
				return store.read(path);
			}
		};

		const source = await readReviewWorkspaceSource({ store: vanishing, mark: MARK });
		expect(source.paths).toContain('alignments/amsterdam-1625.json');
		await expect(delivered(source)).rejects.toMatchObject({ refusal: 'missing-alignment' });
	});

	it('refuses a review copy whose mark records no Project', async () => {
		await expect(reviewSource(WORKSPACE, { ...MARK, directory: '' })).rejects.toMatchObject({
			refusal: 'no-project-file'
		});
	});
});
