import { createTarDecoder } from 'modern-tar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATALOG_WITH_STALE_DEFAULT, FORKED_CATALOG } from '../base-map/fixture-catalogs.js';
import { writeCachedTileSource } from '../base-map/offline-cache.js';
import { cachedTilePath } from '../base-map/tile-cache.js';
import { newMapLayer, newAnnotationLayer, type Layer } from '../project/layer.js';
import { Workspace } from '../project/workspace.js';
import { STATIC_HOSTING_LIMIT_BYTES } from '../project/workspace-size.js';
import { seedAlignmentFixture } from '../alignment/alignment-fixture.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { decode, encode, snapshot } from '../test-support.js';
import { exportProjectBundle } from '../transfer/export-project-bundle.js';
import { VIEWER_FILE_PATHS, isViewerFile } from '../transfer/viewer-files.js';
import {
	PublishedSiteRefusedError,
	PUBLISHED_SITE_RECORD_NAME,
	parsePublishedSite,
	planPublishedSite,
	writePublishedSite,
	publishedSiteStaleness,
	readPublishedSite,
	withdrawShareLinks,
	type PublishedSitePlan,
	type ViewerBundle
} from '../index.js';
import { parseViewerBundle } from './viewer-bundle.js';

const ARCHIVE = 'https://example.test/v4.pmtiles';
const TILE = 'images/x/0,0,256,256/256,256/0/default.jpg';
const ALIGNMENT = '{"type":"Annotation","id":"x"}';
const INFO = '{"id":"https://unset.invalid/x"}';
const EDITOR = 'https://maps.example.edu/ballastella/';
const REPOSITORY = { owner: 'ada', repository: 'atlas', branch: 'main' };

const viewerFile = (path: string, bytes: number) => ({
	path,
	source: `viewer-bundle/${path}`,
	bytes
});
const baseMapFile = (path: string, bytes: number) => ({ path, source: path, bytes });

const BASE_MAP_PATHS = [
	'base-map/extract.pmtiles',
	'base-map/fonts/Noto Sans Regular/0-255.pbf',
	'base-map/sprites/light.png'
];

const bundle: ViewerBundle = {
	version: 'v1-abcdef0123456789',
	files: [
		viewerFile('index.html', 640),
		viewerFile('robots.txt', 32),
		viewerFile('_app/immutable/entry/start.AAAA.js', 2048),
		viewerFile('_app/immutable/nodes/0.BBBB.js', 4096),
		viewerFile('_app/version.json', 30)
	],
	baseMap: [
		baseMapFile('base-map/extract.pmtiles', 4_000_000),
		baseMapFile('base-map/fonts/Noto Sans Regular/0-255.pbf', 60_000),
		baseMapFile('base-map/sprites/light.png', 12_000)
	]
};

const asset = (file: { source: string }): Promise<Bytes> =>
	Promise.resolve(encode(`bytes of ${file.source}`));

const parseRecord = (value: unknown) =>
	parsePublishedSite(encode(typeof value === 'string' ? value : JSON.stringify(value)));

let store: MemoryProjectStore;
let workspace: Workspace;

async function freshWorkspace(withMap: boolean): Promise<void> {
	store = new MemoryProjectStore();
	workspace = new Workspace(store, { now: () => new Date('2026-01-02T03:04:05.000Z') });
	await workspace.createProject('Amsterdam 1625');
	if (!withMap) return;
	await seedAlignmentFixture(store, 'x', encode(ALIGNMENT));
	await store.write('images/x/info.json', encode(INFO));
	await store.write(TILE, encode('a tile'));
}

type PlanOptions = Omit<Parameters<typeof planPublishedSite>[1], 'bundle' | 'projects'> & {
	bundle?: ViewerBundle;
};

const plan = async (options: PlanOptions = {}): Promise<PublishedSitePlan> =>
	planPublishedSite(store, { bundle, projects: await workspace.listProjects(), ...options });

const writeSite = async (
	{ at = '2026-02-03T04:05:06.000Z', ...options }: PlanOptions & { at?: string } = {},
	onProgress?: Parameters<typeof writePublishedSite>[0]['onProgress']
) =>
	writePublishedSite({
		store,
		plan: await plan(options),
		readAsset: asset,
		now: () => new Date(at),
		...(onProgress ? { onProgress } : {})
	});

const storedRecord = async () => parsePublishedSite(await store.read(PUBLISHED_SITE_RECORD_NAME));

async function setLayers(layers: Layer[]): Promise<void> {
	const file = await workspace.readProject('amsterdam-1625');
	await workspace.writeProject('amsterdam-1625', { ...file, layers });
}

const warningOf = (planned: PublishedSitePlan, kind: string) =>
	planned.warnings.find((warning) => warning.kind === kind);
const kindsOf = (planned: PublishedSitePlan) => planned.warnings.map((warning) => warning.kind);

describe('planning a site write', () => {
	beforeEach(() => freshWorkspace(false));

	it('names every Project the site will carry, by folder, display name, and front-page choice, writing nothing', async () => {
		await workspace.createProject('Boston 1775');
		await workspace.setProjectOnFrontPage('boston-1775', true);
		const before = await store.list('');

		expect((await plan()).projects).toEqual([
			{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: false },
			{ directory: 'boston-1775', name: 'Boston 1775', onFrontPage: true }
		]);
		expect(await store.list('')).toEqual(before);
	});

	it('weighs the Workspace without opening a file, counting complete Map Images apart', async () => {
		await store.write('images/x/info.json', encode('{}'));
		await store.write(TILE, encode('tile'));
		const read = vi.spyOn(store, 'read');
		const planned = await plan();

		expect(
			read.mock.calls.map(([path]) => path).filter((path) => !path.endsWith('/project.json'))
		).toEqual([]);
		expect(planned.workspace.files).toBe(3);
		expect(planned.mapImages.files).toBe(2);
		expect(planned.mapImages.bytes).toBeGreaterThan(0);
	});

	it('states the Base Map’s size before it is added', async () => {
		const planned = await plan();
		const stated = warningOf(planned, 'base-map-size');
		expect(stated?.message).toContain('4.1 MB');
		expect(stated?.message).toContain('3 more files');
		expect(planned.bytes).toBeGreaterThan(4_000_000);
		expect(planned.files.map((file) => file.path)).toContain('base-map/extract.pmtiles');
	});

	it('warns that a referenced Map Image leaves a Reader with no network seeing nothing', async () => {
		await store.write(
			'images/blaeu/remote.json',
			encode('{"service":"https://lib.example/blaeu"}')
		);
		await store.write('images/mine/info.json', encode('{"id":"https://unset.invalid/mine"}'));
		await setLayers([
			newMapLayer({ id: 'l1', name: 'Blaeu’s plan', imageId: 'blaeu' }),
			newMapLayer({ id: 'l2', name: 'My own scan', imageId: 'mine' }),
			newAnnotationLayer({ id: 'l3', name: 'Warehouses' })
		]);

		const warning = warningOf(await plan(), 'referenced-images');
		expect(warning?.message).toContain('Blaeu’s plan');
		expect(warning?.message).toContain('Amsterdam 1625');
		expect(warning?.message).toContain('no network');
		expect(warning?.message).not.toContain('My own scan');
		expect(warning?.message).not.toContain('Warehouses');
	});

	it('says nothing of the network or the hosting limit for small local and offline-copied maps', async () => {
		await store.write('images/mine/info.json', encode('{"id":"https://unset.invalid/mine"}'));
		await store.write(
			'images/blaeu/remote.json',
			encode('{"service":"https://lib.example/blaeu"}')
		);
		await store.write('images/blaeu/info.json', encode('{"id":"https://unset.invalid/blaeu"}'));
		await store.write('images/mine/small.jpg', new Uint8Array(1000));
		await setLayers([
			newMapLayer({ id: 'l1', name: 'My own scan', imageId: 'mine' }),
			newMapLayer({ id: 'l2', name: 'Blaeu’s plan', imageId: 'blaeu' })
		]);

		expect(kindsOf(await plan())).toEqual(['base-map-size']);
	});

	it('names the hosting limit, and the byte weight of the Map Images no Project uses', async () => {
		await store.write('images/nobody/info.json', encode('{"id":"https://unset.invalid/nobody"}'));
		await store.write(
			'images/nobody/big.jpg',
			new Uint8Array(STATIC_HOSTING_LIMIT_BYTES - 1_000_000)
		);

		const planned = await plan();
		expect(planned.unusedMapImages.maps).toBe(1);
		expect(planned.unusedMapImages.bytes).toBeGreaterThan(STATIC_HOSTING_LIMIT_BYTES - 1e6);
		const message = warningOf(planned, 'hosting-limit')?.message;
		expect(message).toContain('1.0 GB');
		expect(message).toContain('GitHub Pages');
		expect(message).toContain('999 MB of Map Images no Project uses');
	});

	it('reports zero unused weight, and says nothing about it, when every map is in use', async () => {
		await store.write('images/mine/info.json', encode('{"id":"https://unset.invalid/mine"}'));
		await store.write(
			'images/mine/big.jpg',
			new Uint8Array(STATIC_HOSTING_LIMIT_BYTES - 1_000_000)
		);
		await setLayers([newMapLayer({ id: 'l1', name: 'Mine', imageId: 'mine' })]);

		const planned = await plan();
		expect(planned.unusedMapImages).toEqual({ bytes: 0, maps: 0 });
		const warning = warningOf(planned, 'hosting-limit');
		expect(warning?.message).toContain('GitHub Pages');
		expect(warning?.message).not.toContain('no Project uses');
	});

	it('carries this deployment’s Base Map catalog, so the site keeps working when it changes', async () => {
		expect((await plan({ catalog: FORKED_CATALOG })).baseMap).toEqual(FORKED_CATALOG);
	});

	it('refuses a Workspace whose Project folder is named after a file the site needs', async () => {
		await expect(workspace.createProject('Base Map')).rejects.toThrow(/reserved/);
		await store.write('base-map/project.json', encode('{"formatVersion":1,"name":"Base Map"}'));

		const planned = await plan();
		expect(planned.collisions).toEqual(['base-map']);
		expect(kindsOf(planned)).toContain('name-collision');
		await expect(writePublishedSite({ store, plan: planned, readAsset: asset })).rejects.toThrow(
			PublishedSiteRefusedError
		);
		expect(await store.list('base-map/')).toEqual(['base-map/project.json']);
		expect(await store.list('index.html')).toEqual([]);
	});
});

describe('writing the site', () => {
	beforeEach(() => freshWorkspace(true));

	it('writes the viewer and the site record at the Workspace, beside the Projects', async () => {
		expect(await readPublishedSite(store)).toBeNull();
		await writeSite();

		expect(await store.list('')).toEqual(
			[
				'.nojekyll',
				'_app/immutable/entry/start.AAAA.js',
				'_app/immutable/nodes/0.BBBB.js',
				'_app/version.json',
				'alignments/x.json',
				'amsterdam-1625/project.json',
				...BASE_MAP_PATHS,
				'ballastella-site.json',
				TILE,
				'images/x/info.json',
				'index.html',
				'robots.txt'
			].sort()
		);
		expect(decode(await store.read('index.html'))).toBe('bytes of viewer-bundle/index.html');
		expect(await readPublishedSite(store)).not.toBeNull();

		const written = (await store.list('')).filter(
			(path) =>
				!path.startsWith('amsterdam-1625/') &&
				!path.startsWith('images/') &&
				!path.startsWith('alignments/')
		);
		expect(written.filter((path) => !isViewerFile(path))).toEqual([]);
		expect(
			VIEWER_FILE_PATHS.filter(
				(recorded) =>
					!written.some((path) =>
						recorded.endsWith('/') ? path.startsWith(recorded) : path === recorded
					)
			)
		).toEqual([]);
	});

	it('touches no Project, duplicates no tile, and writes the site record last', async () => {
		const before = await snapshot(store, 'amsterdam-1625/');
		const write = vi.spyOn(store, 'write');
		const read = vi.spyOn(store, 'read');

		await writeSite();

		const written = write.mock.calls.map(([path]) => path);
		expect(written.filter((path) => path.startsWith('amsterdam-1625/'))).toEqual([]);
		expect(written.length).toBeGreaterThan(1);
		expect(written.at(-1)).toBe('ballastella-site.json');
		expect(
			read.mock.calls
				.map(([path]) => path)
				.filter((path) => path.startsWith('amsterdam-1625/') && !path.endsWith('/project.json'))
		).toEqual([]);
		expect(await snapshot(store, 'amsterdam-1625/')).toEqual(before);
		const files = await snapshot(store);
		expect(Object.keys(files).filter((path) => files[path] === 'a tile')).toEqual([TILE]);
	});

	it('refuses to write a bundle file the recorded list does not name', async () => {
		const extra = viewerFile('viewer-extras/x.js', 10);

		await expect(
			writeSite({ bundle: { ...bundle, files: [...bundle.files, extra] } })
		).rejects.toThrow('VIEWER_FILE_PATHS does not record');
	});

	it('records the version stamp, every Project with its front-page choice, and the Base Map files', async () => {
		await workspace.createProject('Boston 1775');
		await workspace.setProjectOnFrontPage('amsterdam-1625', true);

		const site = await writeSite();
		const record = await storedRecord();
		expect(record).toEqual(site);
		expect(record.viewerVersion).toBe('v1-abcdef0123456789');
		expect(record.publishedAt).toBe('2026-02-03T04:05:06.000Z');
		expect(record.projects.map((project) => [project.directory, project.onFrontPage])).toEqual([
			['amsterdam-1625', true],
			['boston-1775', false]
		]);
		expect(record.baseMap.entries.length).toBeGreaterThan(0);
		expect(record.baseMapBundled).toBe(false);
		expect(record.baseMapAssetsBundled).toBe(true);
	});

	it.each([
		[EDITOR, EDITOR],
		[undefined, ''],
		['http://localhost:5173/', ''],
		['http://127.0.0.1:5173/', ''],
		['http://atlas/ballastella/', '']
	])('records the editor instance %s as %j', async (editorUrl, expected) => {
		const site = await writeSite(editorUrl === undefined ? {} : { editorUrl });
		expect(await storedRecord()).toEqual(site);
		expect(site.editorUrl).toBe(expected);
		expect(site.repository).toBeNull();
	});

	it('records the repository it was sent to in the record, and in no document of its own', async () => {
		const site = await writeSite({ editorUrl: EDITOR, repository: REPOSITORY });
		expect(await storedRecord()).toEqual(site);
		expect(site.repository).toEqual(REPOSITORY);
		expect((await readPublishedSite(store))?.repository).toEqual(REPOSITORY);
		expect(
			(await store.list('')).filter((path) => !path.includes('/') && path.endsWith('.json'))
		).toEqual([PUBLISHED_SITE_RECORD_NAME]);
	});

	it('extends the hub page on a second site write, with the Base Map assets, leaving the first Project byte-identical', async () => {
		await writeSite();
		expect(await store.list('base-map/')).toEqual(BASE_MAP_PATHS);
		const before = await snapshot(store, 'amsterdam-1625/');

		await workspace.createProject('Boston 1775');
		await writeSite({ at: '2026-03-04T05:06:07.000Z' });

		const record = await storedRecord();
		expect(record.projects.map((project) => project.name)).toEqual([
			'Amsterdam 1625',
			'Boston 1775'
		]);
		expect(await snapshot(store, 'amsterdam-1625/')).toEqual(before);
		expect(record.publishedAt).toBe('2026-03-04T05:06:07.000Z');
		expect(await store.list('base-map/')).toEqual(BASE_MAP_PATHS);
		expect(record.baseMapAssetsBundled).toBe(true);
		expect(decode(await store.read('index.html'))).toBe('bytes of viewer-bundle/index.html');
	});

	it('leaves the offline tile cache alone when writing the display assets', async () => {
		const first = cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 });
		const deep = cachedTilePath(ARCHIVE, { z: 14, x: 8414, y: 5383 });
		await store.write(first, new Uint8Array([1, 2, 3]));
		await store.write(deep, new Uint8Array([4, 5]));

		await writeSite();
		await writeSite();

		expect(await store.list('base-map/')).toEqual([...BASE_MAP_PATHS, first, deep].sort());
		expect([...(await store.read(first))]).toEqual([1, 2, 3]);
	});

	it('records cached tiles as its Base Map, claiming no archive when the provenance record is missing', async () => {
		await store.write(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }), new Uint8Array([1]));
		await writeSite();
		const record = await storedRecord();
		expect(record.baseMapBundled).toBe(true);
		expect(record.baseMapAssetsBundled).toBe(true);
		expect(record.baseMapCaches).toEqual([]);
	});

	it('names which archives it carries tiles for, because the viewer cannot list a directory', async () => {
		const other = 'https://other.test/v4.pmtiles';
		await store.write(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }), new Uint8Array([1]));
		await writeCachedTileSource(store, { archive: ARCHIVE, maxZoom: 14 });
		await store.write(cachedTilePath(other, { z: 0, x: 0, y: 0 }), new Uint8Array([2]));
		await writeCachedTileSource(store, { archive: other, maxZoom: 11 });

		await writeSite();

		expect(
			[...(await storedRecord()).baseMapCaches].sort((a, b) =>
				(a.archive ?? '').localeCompare(b.archive ?? '')
			)
		).toEqual([
			{ archive: ARCHIVE, maxZoom: 14 },
			{ archive: other, maxZoom: 11 }
		]);
	});

	it('reads an older record’s baseMapMaxZoom rather than drawing nothing', () => {
		const record = parseRecord({
			formatVersion: 1,
			viewerVersion: 'v1',
			publishedAt: '2026-01-01T00:00:00.000Z',
			projects: [],
			baseMapBundled: true,
			baseMapMaxZoom: 14
		});

		expect(record.baseMapCaches).toEqual([{ archive: null, maxZoom: 14 }]);
	});

	it('writes a legacy unkeyed pile as what it is, rather than dropping it', async () => {
		await store.write('base-map/tiles/0/0/0.mvt', new Uint8Array([1]));
		await store.write('base-map/tiles/11/1054/675.mvt', new Uint8Array([2]));

		await writeSite();

		const record = await storedRecord();
		expect(record.baseMapCaches).toEqual([{ archive: null, maxZoom: 11 }]);
		expect(record.baseMapBundled).toBe(true);
	});

	it('records no display assets when the deployment bundle has none', async () => {
		await writeSite({ bundle: { ...bundle, baseMap: [] } });
		expect((await storedRecord()).baseMapAssetsBundled).toBe(false);
	});

	it('keeps the hashed chunks an earlier viewer left', async () => {
		await store.write('_app/immutable/nodes/0.FROM-AN-OLDER-BUILD.js', encode('older'));

		await writeSite();

		expect(await store.list('_app/immutable/nodes/')).toContain(
			'_app/immutable/nodes/0.FROM-AN-OLDER-BUILD.js'
		);
	});

	it('refreshes a version stamp that has gone stale, rather than leaving what is there', async () => {
		await writeSite();
		const record = await storedRecord();
		await store.write(
			'ballastella-site.json',
			encode(JSON.stringify({ ...record, viewerVersion: 'v0-an-older-viewer' }))
		);
		expect((await readPublishedSite(store))?.viewerVersion).toBe('v0-an-older-viewer');

		await writeSite();

		expect((await readPublishedSite(store))?.viewerVersion).toBe('v1-abcdef0123456789');
	});

	it('reports progress that reaches the total it announced, both authored files included', async () => {
		const totalFiles = bundle.files.length + bundle.baseMap.length + 2;
		const seen: { files: number; totalFiles: number; path: string | null }[] = [];

		await writeSite({}, (progress) => seen.push(progress));

		expect(seen.at(-1)).toEqual({ files: totalFiles, totalFiles, path: 'ballastella-site.json' });
		expect(seen[0]).toEqual({ files: 0, totalFiles, path: null });
		expect(seen.map((progress) => progress.path)).toContain('.nojekyll');
	});

	it('surfaces a site record that is there and unreadable', async () => {
		await store.write('ballastella-site.json', encode('{ not json'));

		await expect(readPublishedSite(store)).rejects.toThrow('could not be read');
	});

	it('leaves the published viewer out of a Project bundle', async () => {
		await setLayers([newMapLayer({ id: 'l1', name: 'Blaeu’s plan', imageId: 'x' })]);
		await writeSite();

		const paths: string[] = [];
		const entries = (await exportProjectBundle(store, 'amsterdam-1625')).body.pipeThrough(
			createTarDecoder({ strict: true })
		);
		for await (const entry of entries) {
			paths.push(entry.header.name);
			await entry.body.cancel();
		}

		expect(paths.sort()).toEqual(['alignments/x.json', TILE, 'images/x/info.json', 'project.json']);
	});
});

describe('taking the Published Site back out of a Workspace', () => {
	beforeEach(async () => {
		await freshWorkspace(true);
		await store.write('base-map/tiles/9f8/12/2094/1330.mvt', encode('an mvt tile'));
	});

	it('removes the whole recorded viewer file set, `_app/` included, leaving every source file byte-identical', async () => {
		await writeSite();
		const project = decode(await store.read('amsterdam-1625/project.json'));

		await withdrawShareLinks(store);

		expect(await store.list('')).toEqual([
			'alignments/x.json',
			'amsterdam-1625/project.json',
			'base-map/tiles/9f8/12/2094/1330.mvt',
			TILE,
			'images/x/info.json'
		]);
		expect(decode(await store.read('amsterdam-1625/project.json'))).toBe(project);
		expect(decode(await store.read('alignments/x.json'))).toBe(ALIGNMENT);
		expect(decode(await store.read('images/x/info.json'))).toBe(INFO);
	});

	it('does nothing at all to a Workspace that has no site', async () => {
		const before = await store.list('');
		await withdrawShareLinks(store);
		expect(await store.list('')).toEqual(before);
	});
});

describe('telling the author a Published Site is behind', () => {
	const amsterdam = { directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: true };
	const site = {
		formatVersion: 1,
		viewerVersion: 'v1',
		publishedAt: '2026-01-01T00:00:00.000Z',
		editorUrl: '',
		repository: null,
		projects: [amsterdam],
		baseMap: FORKED_CATALOG,
		baseMapBundled: false,
		baseMapAssetsBundled: false,
		baseMapCaches: []
	};
	const summary = (directory: string, name: string, onFrontPage = true) => ({
		directory,
		name,
		description: '',
		updatedAt: '2026-01-01T00:00:00.000Z',
		onFrontPage,
		problem: null
	});
	const current = summary('amsterdam-1625', 'Amsterdam 1625');
	const staleness = (projects: ReturnType<typeof summary>[], viewerVersion = 'v1', on = site) =>
		publishedSiteStaleness(on, { viewerVersion, projects });

	it('says nothing when the site matches the Workspace, or there is no site', () => {
		expect(staleness([current])).toBe('');
		expect(publishedSiteStaleness(null, { viewerVersion: 'v1', projects: [] })).toBe('');
	});

	it.each([
		[
			'a Project the hub page does not list yet',
			[current, summary('boston-1775', 'Boston 1775')],
			'v1',
			site,
			['Boston 1775', 'not on it yet']
		],
		['a Project the hub page still lists', [], 'v1', site, ['still on it']],
		[
			'a Project listed under an older name',
			[summary('amsterdam-1625', 'Amsterdam, 1625')],
			'v1',
			site,
			['an older name']
		],
		[
			'a Project the front page still lists',
			[summary('amsterdam-1625', 'Amsterdam 1625', false)],
			'v1',
			site,
			['Amsterdam 1625', 'still on its front page']
		],
		[
			'a Project the front page does not list yet',
			[current],
			'v1',
			{ ...site, projects: [{ ...amsterdam, onFrontPage: false }] },
			['not on its front page yet']
		],
		[
			'an older viewer though the Project list agrees',
			[current],
			'v2',
			site,
			['an older version of the viewer']
		]
	])('names %s', (_what, projects, viewerVersion, on, expected) => {
		const notice = staleness(projects, viewerVersion, on);
		for (const text of expected) expect(notice).toContain(text);
	});
});

describe('reading the staged viewer bundle index', () => {
	it('reads the shape the build script writes', () => {
		const index = {
			version: 'abc',
			files: [{ path: 'index.html', source: 'viewer-bundle/index.html', bytes: 10 }],
			baseMap: []
		};

		expect(parseViewerBundle(index)).toEqual(index);
	});

	it.each([
		null,
		{ files: [{ path: 'index.html', source: 'a', bytes: 1 }] },
		{ version: 'abc', files: [] },
		{ version: 'abc', files: [{ path: '_app/x.js', source: 'a', bytes: 1 }] },
		{ version: 'abc', files: [{ path: 'index.html', source: 'a' }] },
		{ version: 'abc', files: [{ path: 'index.html', bytes: 1 }] },
		{ version: 'abc', files: [{ path: '/index.html', source: 'a', bytes: 1 }] },
		{ version: 'abc', files: 'index.html' }
	])('refuses an index that would write an incomplete site: %j', (bad) => {
		expect(() => parseViewerBundle(bad)).toThrow('could not be read');
	});
});

describe('the site record a Reader’s page is drawn from', () => {
	it('falls back to this build’s catalog rather than leaving a Reader with no Base Map', () => {
		const record = parseRecord('{"projects":[{"directory":"x"}],"baseMap":{"entries":[]}}');
		expect(record.baseMap.entries.length).toBeGreaterThan(0);
		expect(record.projects).toEqual([{ directory: 'x', name: 'x', onFrontPage: true }]);
	});

	it('keeps a catalog it does not fully understand, because resolution already falls back', () => {
		expect(parseRecord({ projects: [], baseMap: CATALOG_WITH_STALE_DEFAULT }).baseMap).toEqual(
			CATALOG_WITH_STALE_DEFAULT
		);
	});

	it.each([
		[{ baseMapBundled: true }, true, true],
		[{ baseMapBundled: false }, false, false],
		[{ baseMapBundled: true, baseMapAssetsBundled: false }, true, false]
	])('reads Base Map files from %j', (fields, tiles, assets) => {
		const record = parseRecord({ projects: [], ...fields });
		expect(record.baseMapBundled).toBe(tiles);
		expect(record.baseMapAssetsBundled).toBe(assets);
	});

	it.each([
		[
			'predate the front-page choice',
			'{"directory":"a","name":"A"},{"directory":"b","name":"B"}',
			[true, true]
		],
		[
			'carry it',
			'{"directory":"a","name":"A","onFrontPage":false},{"directory":"b","name":"B","onFrontPage":true}',
			[false, true]
		],
		['carry a string', '{"directory":"a","name":"A","onFrontPage":"no"}', [true]],
		['carry a number', '{"directory":"a","name":"A","onFrontPage":0}', [true]],
		['carry null', '{"directory":"a","name":"A","onFrontPage":null}', [true]]
	])('reads front-page choices from entries that %s', (_what, entries, expected) => {
		const record = parseRecord(`{"projects":[${entries}]}`);
		expect(record.projects.map((project) => project.onFrontPage)).toEqual(expected);
	});

	it.each([
		[undefined, ''],
		['https://maps.example.edu/ballastella', 'https://maps.example.edu/ballastella/'],
		['https://ada:hunter2@maps.example.edu/', 'https://maps.example.edu/'],
		['https://maps.example.edu:8443/ballastella/', 'https://maps.example.edu:8443/ballastella/'],
		['http://[2001:db8::1]/', 'http://[2001:db8::1]/'],
		['javascript:alert(1)', ''],
		['data:text/html,<script>alert(1)</script>', ''],
		['/ballastella/', ''],
		['not a url at all', ''],
		['http://localhost:5173/', ''],
		['http://127.0.0.1:5173/', ''],
		['http://[::1]:5173/', ''],
		['http://atlas/ballastella/', '']
	])('reads the instance address %s as %j', (editorUrl, expected) => {
		expect(parseRecord({ projects: [], editorUrl }).editorUrl).toBe(expected);
	});

	it('drops a Project entry with no folder, which is the one field ?p= needs', () => {
		const record = parseRecord('{"projects":[{"name":"nameless"},{"directory":"x","name":"X"}]}');
		expect(record.projects).toEqual([{ directory: 'x', name: 'X', onFrontPage: true }]);
	});
});
