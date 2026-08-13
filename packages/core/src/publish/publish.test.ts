import { createTarDecoder } from 'modern-tar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CATALOG_WITH_STALE_DEFAULT, FORKED_CATALOG } from '../base-map/fixture-catalogs.js';
import { writeCachedTileSource } from '../base-map/offline-cache.js';
import { cachedTilePath } from '../base-map/tile-cache.js';
import { imageInfoPath } from '../project/image-files.js';
import { newMapLayer, newAnnotationLayer } from '../project/layer.js';
import { newProjectFile, parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
import { Workspace } from '../project/workspace.js';
import { STATIC_HOSTING_LIMIT_BYTES } from '../project/workspace-size.js';
import { seedAlignmentFixture } from '../alignment/alignment-fixture.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { exportProjectBundle } from '../transfer/export-project-bundle.js';
import { VIEWER_FILE_PATHS, isViewerFile } from '../transfer/viewer-files.js';
import {
	PublishRefusedError,
	canonicalImageServiceId,
	normaliseCanonicalUrl,
	parsePublishedSite,
	planPublish,
	publishSite,
	publishedSiteStaleness,
	readPublishedSite,
	stampCanonicalUrl,
	type PublishPlan,
	type ViewerBundle
} from '../index.js';
import { parseViewerBundle } from './viewer-bundle.js';

// SPEC's Seam 1. Publishing is a file-level behaviour end to end — "these paths now hold these
// bytes, and every Project file is exactly as it was" — so the in-memory ProjectStore is not
// standing in for anything. What only a browser can settle is whether the files it wrote *serve a
// working site*, at a domain root and at a subdirectory, and that is `e2e/editor-publish.e2e.ts`.

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** An archive, so the keyed cache directory is built rather than spelled (ticket 12). */
const ARCHIVE = 'https://example.test/v4.pmtiles';

/**
 * A staged viewer bundle, shaped exactly as `scripts/stage-viewer-bundle.mjs` writes it.
 *
 * Small and fictional on purpose: the real chunk names are content hashes that change on every
 * viewer edit, so a test naming them would be a test about the bundler. What matters here is the
 * shape — an `index.html`, hashed assets under `_app/`, and a Base Map set that is written only on
 * request.
 */
const bundle: ViewerBundle = {
	version: 'v1-abcdef0123456789',
	files: [
		{ path: 'index.html', source: 'viewer-bundle/index.html', bytes: 640 },
		{ path: 'robots.txt', source: 'viewer-bundle/robots.txt', bytes: 32 },
		{
			path: '_app/immutable/entry/start.AAAA.js',
			source: 'viewer-bundle/_app/immutable/entry/start.AAAA.js',
			bytes: 2048
		},
		{
			path: '_app/immutable/nodes/0.BBBB.js',
			source: 'viewer-bundle/_app/immutable/nodes/0.BBBB.js',
			bytes: 4096
		},
		{ path: '_app/version.json', source: 'viewer-bundle/_app/version.json', bytes: 30 }
	],
	baseMap: [
		{ path: 'base-map/extract.pmtiles', source: 'base-map/extract.pmtiles', bytes: 4_000_000 },
		{
			path: 'base-map/fonts/Noto Sans Regular/0-255.pbf',
			source: 'base-map/fonts/Noto Sans Regular/0-255.pbf',
			bytes: 60_000
		},
		{ path: 'base-map/sprites/light.png', source: 'base-map/sprites/light.png', bytes: 12_000 }
	]
};

/**
 * The bytes the editor's deployment would serve for each of those paths.
 *
 * Keyed on `source` rather than on `path`, because that is the distinction that goes wrong: fetching
 * the Workspace-relative `index.html` from the editor's own base fetches the *editor's* page, and a
 * Published Site whose `index.html` is the authoring app is the whole failure in one file.
 */
const asset = (file: { source: string }): Promise<Bytes> =>
	Promise.resolve(encode(`bytes of ${file.source}`));

describe('planning a publish', () => {
	let store: MemoryProjectStore;
	let workspace: Workspace;

	beforeEach(async () => {
		store = new MemoryProjectStore();
		workspace = new Workspace(store, { now: () => new Date('2026-01-02T03:04:05.000Z') });
		await workspace.createProject('Amsterdam 1625');
	});

	const plan = async (options: { includeBaseMap?: boolean } = {}): Promise<PublishPlan> =>
		planPublish(store, {
			bundle,
			projects: await workspace.listProjects(),
			includeBaseMap: options.includeBaseMap ?? false
		});

	it('names every Project the site will carry, by folder, display name, and front-page choice', async () => {
		await workspace.createProject('Boston 1775');

		expect((await plan()).projects).toEqual([
			{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: true },
			{ directory: 'boston-1775', name: 'Boston 1775', onFrontPage: true }
		]);
	});

	it('writes nothing while planning, because two of its warnings are questions', async () => {
		const before = await store.list('');

		await plan({ includeBaseMap: true });

		expect(await store.list('')).toEqual(before);
	});

	it('weighs the Workspace without opening a single file', async () => {
		// ADR-0008's cliff has to be answerable about a Workspace holding an offline copy's pyramid, which is
		// tens of thousands of tiles. The *absence* of a read is the claim, and it is the one thing
		// here no assertion about files could carry: a version written with `read` returns exactly the
		// same total, correct in every respect and unusable on a real Workspace.
		await store.write('images/x/0,0,256,256/256,256/0/default.jpg', encode('tile'));
		const read = vi.spyOn(store, 'read');

		const planned = await plan();

		// `project.json` is read — the referenced-image warning is a fact about the Layer stack — but
		// nothing else is, and in particular no tile.
		expect(
			read.mock.calls.map(([path]) => path).filter((path) => !path.endsWith('/project.json'))
		).toEqual([]);
		// The tile and the `project.json`, so this is not passing because nothing was weighed at all.
		expect(planned.workspace.files).toBe(2);
	});

	it('states the Base Map’s size before it is added, and leaves it out otherwise', async () => {
		const without = await plan();
		const withBaseMap = await plan({ includeBaseMap: true });

		expect(without.files.map((file) => file.path)).not.toContain('base-map/extract.pmtiles');
		expect(without.warnings.map((warning) => warning.kind)).not.toContain('base-map-size');

		const stated = withBaseMap.warnings.find((warning) => warning.kind === 'base-map-size');
		expect(stated?.message).toContain('4.1 MB');
		expect(stated?.message).toContain('3 more files');
		expect(withBaseMap.bytes).toBeGreaterThan(4_000_000);
		expect(withBaseMap.files.map((file) => file.path)).toContain('base-map/extract.pmtiles');
	});

	it('warns that a referenced Historical Map leaves a Reader with no network seeing nothing', async () => {
		// **Which maps need the network is read off the Workspace's files, not off `project.json`**
		// (ADR-0023). `blaeu` has only a `remote.json`, so its tiles are on a Library's server; `mine` has
		// an `info.json` of ours. There is no field either Layer could carry to say otherwise, which is
		// what stopped the warning outliving an offline copy that made it false.
		await store.write(
			'images/blaeu/remote.json',
			encode('{"service":"https://lib.example/blaeu"}')
		);
		await store.write('images/mine/info.json', encode('{"id":"https://unset.invalid/mine"}'));
		const file = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', {
			...file,
			layers: [
				newMapLayer({ id: 'l1', name: 'Blaeu’s plan', imageId: 'blaeu' }),
				newMapLayer({ id: 'l2', name: 'My own scan', imageId: 'mine' }),
				newAnnotationLayer({ id: 'l3', name: 'Warehouses' })
			]
		});

		const warning = (await plan()).warnings.find((entry) => entry.kind === 'referenced-images');

		expect(warning?.message).toContain('Blaeu’s plan');
		expect(warning?.message).toContain('Amsterdam 1625');
		expect(warning?.message).toContain('no network');
		// Only the referenced one. A warning that named every Layer would train the user to ignore it.
		expect(warning?.message).not.toContain('My own scan');
		expect(warning?.message).not.toContain('Warehouses');
	});

	it('says nothing about the network when every Historical Map is a local copy', async () => {
		await store.write('images/mine/info.json', encode('{"id":"https://unset.invalid/mine"}'));
		const file = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', {
			...file,
			layers: [newMapLayer({ id: 'l1', name: 'My own scan', imageId: 'mine' })]
		});

		expect((await plan()).warnings).toEqual([]);
	});

	// A copy keeps its `remote.json` for the citation (ADR-0007), so being in both lists means the tiles
	// are here. Warning about a map the Workspace has already copied is the failure the stored `imageMode`
	// produced: the claim outlived the copy, and the user was told to make one they had already made.
	it('says nothing about a map that has been copied offline, though it kept its remote.json', async () => {
		await store.write(
			'images/blaeu/remote.json',
			encode('{"service":"https://lib.example/blaeu"}')
		);
		await store.write('images/blaeu/info.json', encode('{"id":"https://unset.invalid/blaeu"}'));
		const file = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', {
			...file,
			layers: [newMapLayer({ id: 'l1', name: 'Blaeu’s plan', imageId: 'blaeu' })]
		});

		expect((await plan()).warnings.map((warning) => warning.kind)).not.toContain(
			'referenced-images'
		);
	});

	it('names the hosting limit when the site would take the Workspace past it', async () => {
		// One large file rather than many, because what is being asserted is the arithmetic and the
		// sentence, not the walk.
		await store.write('images/x/big.jpg', new Uint8Array(STATIC_HOSTING_LIMIT_BYTES - 1_000_000));

		const warning = (await plan({ includeBaseMap: true })).warnings.find(
			(entry) => entry.kind === 'hosting-limit'
		);

		expect(warning?.message).toContain('1.0 GB');
		expect(warning?.message).toContain('GitHub Pages');
		expect(warning?.message).toContain('999 MB');
	});

	it('names the byte weight of the Historical Maps no Project uses (SPEC story 98)', async () => {
		// Publishing is additive: those maps are already in the directory the site is written into and
		// cannot be left out of it. So the ADR-0008 warning has to say how much of the drop is dead
		// weight, or the user is told they are stuck when they are one deletion from not being.
		await store.write('images/nobody/info.json', encode('{"id":"https://unset.invalid/nobody"}'));
		await store.write(
			'images/nobody/big.jpg',
			new Uint8Array(STATIC_HOSTING_LIMIT_BYTES - 1_000_000)
		);

		const planned = await plan({ includeBaseMap: true });
		const warning = planned.warnings.find((entry) => entry.kind === 'hosting-limit');

		expect(planned.unusedHistoricalMaps.maps).toBe(1);
		expect(planned.unusedHistoricalMaps.bytes).toBeGreaterThan(STATIC_HOSTING_LIMIT_BYTES - 1e6);
		expect(warning?.message).toContain('999 MB of Historical Maps no Project uses');
	});

	it('reports zero unused weight, and says nothing about it, when every map is in use', async () => {
		await store.write('images/mine/info.json', encode('{"id":"https://unset.invalid/mine"}'));
		await store.write(
			'images/mine/big.jpg',
			new Uint8Array(STATIC_HOSTING_LIMIT_BYTES - 1_000_000)
		);
		const file = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', {
			...file,
			layers: [newMapLayer({ id: 'l1', name: 'Mine', imageId: 'mine' })]
		});

		const planned = await plan({ includeBaseMap: true });

		expect(planned.unusedHistoricalMaps).toEqual({ bytes: 0, maps: 0 });
		// The warning is still there — the cliff is still crossed — so this is not passing because the
		// message is absent.
		const warning = planned.warnings.find((entry) => entry.kind === 'hosting-limit');
		expect(warning?.message).toContain('GitHub Pages');
		expect(warning?.message).not.toContain('no Project uses');
	});

	it('says nothing about the hosting limit for a Workspace nowhere near it', async () => {
		await store.write('images/x/small.jpg', new Uint8Array(1000));

		expect((await plan({ includeBaseMap: true })).warnings.map((entry) => entry.kind)).toEqual([
			'base-map-size'
		]);
	});

	it('carries this deployment’s Base Map catalog, so the site keeps working when it changes', async () => {
		const planned = await planPublish(store, {
			bundle,
			projects: await workspace.listProjects(),
			includeBaseMap: false,
			catalog: FORKED_CATALOG
		});

		expect(planned.baseMap).toEqual(FORKED_CATALOG);
	});

	it('refuses a Workspace whose Project folder is named after a file the site needs', async () => {
		// **No longer reachable by naming a Project**, and that is ADR-0023's reserved names doing their
		// job: `createProject('Base Map')` derives `base-map` and is refused outright, because that folder
		// is where the offline Base Map cache goes. So the refusal is asserted first, and then the state is
		// reached the way it still can be — a folder written directly, which is a hand-edited Workspace or
		// one restored from a backup made elsewhere.
		await expect(workspace.createProject('Base Map')).rejects.toThrow(/reserved/);
		await store.write('base-map/project.json', encode('{"formatVersion":1,"name":"Base Map"}'));

		const planned = await plan();

		expect(planned.collisions).toEqual(['base-map']);
		expect(planned.warnings.map((entry) => entry.kind)).toContain('name-collision');
		await expect(publishSite({ store, plan: planned, readAsset: asset })).rejects.toThrow(
			PublishRefusedError
		);
		// Refused before anything was written, so the Project it was protecting is still whole.
		expect(await store.list('base-map/')).toEqual(['base-map/project.json']);
		expect(await store.list('index.html')).toEqual([]);
	});
});

describe('publishing', () => {
	let store: MemoryProjectStore;
	let workspace: Workspace;

	beforeEach(async () => {
		store = new MemoryProjectStore();
		workspace = new Workspace(store, { now: () => new Date('2026-01-02T03:04:05.000Z') });
		await workspace.createProject('Amsterdam 1625');
		// At the Workspace root, shared by every Project (ADR-0023).
		await seedAlignmentFixture(store, 'x', encode('{"type":"Annotation","id":"x"}'));
		await store.write('images/x/info.json', encode('{"id":"https://unset.invalid/x"}'));
		await store.write('images/x/0,0,256,256/256,256/0/default.jpg', encode('a tile'));
	});

	const publish = async (options: { includeBaseMap?: boolean; at?: string } = {}) =>
		publishSite({
			store,
			plan: await planPublish(store, {
				bundle,
				projects: await workspace.listProjects(),
				includeBaseMap: options.includeBaseMap ?? false
			}),
			readAsset: asset,
			now: () => new Date(options.at ?? '2026-02-03T04:05:06.000Z')
		});

	/** Every file in the Workspace, with its bytes, so "unchanged" can be a claim about bytes. */
	const snapshot = async (prefix: string): Promise<Record<string, string>> => {
		const files: Record<string, string> = {};
		for (const path of await store.list(prefix)) files[path] = decode(await store.read(path));
		return files;
	};

	it('writes the viewer and the site record at the Workspace, beside the Projects', async () => {
		await publish();

		expect(await store.list('')).toEqual(
			[
				'.nojekyll',
				'_app/immutable/entry/start.AAAA.js',
				'_app/immutable/nodes/0.BBBB.js',
				'_app/version.json',
				'alignments/x.json',
				'amsterdam-1625/project.json',
				'ballastella-site.json',
				'images/x/0,0,256,256/256,256/0/default.jpg',
				'images/x/info.json',
				'index.html',
				'robots.txt'
			].sort()
		);
		expect(decode(await store.read('index.html'))).toBe('bytes of viewer-bundle/index.html');
	});

	it('writes nothing at all inside a Project directory', async () => {
		// Stronger than comparing bytes before and after, and it has to be. A publish that re-serialised
		// `project.json` to the same bytes passes a byte comparison — while still touching the file's
		// modification time, which is a Dropbox sync to every other machine and a rewrite in a folder
		// Workspace, the two failures ADR-0010 names. So the claim asserted is that no write is even
		// addressed at a Project.
		const write = vi.spyOn(store, 'write');

		await publish({ includeBaseMap: true });

		expect(
			write.mock.calls.map(([path]) => path).filter((path) => path.includes('/project.json'))
		).toEqual([]);
		expect(
			write.mock.calls.map(([path]) => path).filter((path) => path.startsWith('amsterdam-1625/'))
		).toEqual([]);
		// The counterpart: it did write, so this is not passing because nothing happened.
		expect(write.mock.calls.length).toBeGreaterThan(1);
	});

	it('modifies no Project data, asserted on the bytes of every Project file', async () => {
		const before = await snapshot('amsterdam-1625/');

		await publish({ includeBaseMap: true });

		expect(await snapshot('amsterdam-1625/')).toEqual(before);
	});

	it('duplicates no image pyramid: nothing inside a Project is even read', async () => {
		// ADR-0006 rejected copying the data outright, on tile bytes. The strongest form of that claim
		// is not "the tiles are still there" — a copy leaves them there too — but that publishing
		// never opens one.
		const read = vi.spyOn(store, 'read');

		await publishSite({
			store,
			plan: await planPublish(store, {
				bundle,
				projects: await workspace.listProjects(),
				includeBaseMap: true
			}),
			readAsset: asset
		});

		// `project.json` is read while planning, for the referenced-image warning. Nothing else in the
		// Project is — no `info.json`, no Alignment, and above all no tile.
		expect(
			read.mock.calls
				.map(([path]) => path)
				.filter((path) => path.startsWith('amsterdam-1625/') && !path.endsWith('/project.json'))
		).toEqual([]);
	});

	it('records exactly the paths it writes, so the data-only zip can exclude them', async () => {
		await publish({ includeBaseMap: true });

		// Everything that is not the user's data. Since ADR-0023 that means the Project's own directory *and*
		// the shared `images/` and `alignments/` at the Workspace root — publishing must claim none of them.
		const written = (await store.list('')).filter(
			(path) =>
				!path.startsWith('amsterdam-1625/') &&
				!path.startsWith('images/') &&
				!path.startsWith('alignments/')
		);
		// Every file publishing wrote is recognised by the recorded list…
		expect(written.filter((path) => !isViewerFile(path))).toEqual([]);
		// …and nothing in the list is idle: each recorded path matched something that was written.
		expect(
			VIEWER_FILE_PATHS.filter(
				(recorded) =>
					!written.some((path) =>
						recorded.endsWith('/') ? path.startsWith(recorded) : path === recorded
					)
			)
		).toEqual([]);
	});

	it('refuses to write a bundle file the recorded list does not name', async () => {
		// The failure this guards is a chunk arriving in the bundle at a path nobody added to
		// `VIEWER_FILE_PATHS`, after which a data-only zip carries it and nothing says so.
		const planned = await planPublish(store, {
			bundle: {
				...bundle,
				files: [
					...bundle.files,
					{ path: 'viewer-extras/x.js', source: 'viewer-bundle/viewer-extras/x.js', bytes: 10 }
				]
			},
			projects: await workspace.listProjects(),
			includeBaseMap: false
		});

		await expect(publishSite({ store, plan: planned, readAsset: asset })).rejects.toThrow(
			'VIEWER_FILE_PATHS does not record'
		);
	});

	it('carries the version stamp and the Project list into the site record', async () => {
		await workspace.createProject('Boston 1775');

		const site = await publish();
		const record = parsePublishedSite(await store.read('ballastella-site.json'));

		expect(record).toEqual(site);
		expect(record.viewerVersion).toBe('v1-abcdef0123456789');
		expect(record.publishedAt).toBe('2026-02-03T04:05:06.000Z');
		expect(record.projects.map((project) => project.directory).sort()).toEqual([
			'amsterdam-1625',
			'boston-1775'
		]);
		expect(record.baseMap.entries.length).toBeGreaterThan(0);
		expect(record.baseMapBundled).toBe(false);
	});

	// ADR-0032: the record is the site's whole account of itself, so a Project taken off the Front Page
	// is *on the record and marked*, never left out of it. Omitting it would make the choice into a
	// claim about who can read the Project — and the files are on a public host either way.
	it('records each Project’s front-page choice, listing every Project either way', async () => {
		await workspace.createProject('Boston 1775');
		await workspace.setProjectOnFrontPage('boston-1775', false);

		const site = await publish();
		const record = parsePublishedSite(await store.read('ballastella-site.json'));

		expect(record).toEqual(site);
		expect(record.projects.map((project) => [project.directory, project.onFrontPage])).toEqual([
			['amsterdam-1625', true],
			['boston-1775', false]
		]);
	});

	it('writes the site record last, so an interrupted publish leaves a site that works', async () => {
		const order: string[] = [];
		vi.spyOn(store, 'write').mockImplementation(async function (
			this: MemoryProjectStore,
			path: StorePath,
			bytes: Bytes
		) {
			order.push(path);
			return MemoryProjectStore.prototype.write.call(this, path, bytes);
		});

		await publish();

		expect(order.at(-1)).toBe('ballastella-site.json');
	});

	it('extends the hub page on a second publish and leaves the first Project byte-identical', async () => {
		// The semester-long, one-repository workflow (SPEC story 81).
		await publish();
		const before = await snapshot('amsterdam-1625/');

		await workspace.createProject('Boston 1775');
		await publish({ at: '2026-03-04T05:06:07.000Z' });

		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(record.projects.map((project) => project.name)).toEqual([
			'Amsterdam 1625',
			'Boston 1775'
		]);
		expect(await snapshot('amsterdam-1625/')).toEqual(before);
		expect(record.publishedAt).toBe('2026-03-04T05:06:07.000Z');
	});

	it('removes a Base Map it published before, when this publish leaves it out', async () => {
		// The order the folder gets wrong: with, then without. Publishing only ever wrote, so ~5 MB of
		// `base-map/` stayed behind while the record beside it said `baseMapBundled: false` — the
		// Workspace and the site's own account of itself disagreeing about what the site is.
		await publish({ includeBaseMap: true });
		expect(await store.list('base-map/')).toEqual([
			'base-map/extract.pmtiles',
			'base-map/fonts/Noto Sans Regular/0-255.pbf',
			'base-map/sprites/light.png'
		]);
		const project = await snapshot('amsterdam-1625/');

		await publish({ includeBaseMap: false });

		expect(await store.list('base-map/')).toEqual([]);
		expect(parsePublishedSite(await store.read('ballastella-site.json')).baseMapBundled).toBe(
			false
		);
		// The sweep never leaves the recorded list, so the Projects beside it are byte-identical.
		expect(await snapshot('amsterdam-1625/')).toEqual(project);
		expect(decode(await store.read('index.html'))).toBe('bytes of viewer-bundle/index.html');
	});

	it('leaves the offline tile cache alone when this publish omits the Base Map', async () => {
		// ⚠ The one thing the sweep above must not reach. `base-map/` is a recorded viewer directory,
		// and since ADR-0025 the opt-in tile cache lives inside it — bytes a user asked for and fetched
		// from somebody else's server. Publishing once with the checkbox off used to delete every one of
		// them silently, and the Project would simply stop being available offline with nothing said.
		const first = cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 });
		await store.write(first, new Uint8Array([1, 2, 3]));
		await store.write(cachedTilePath(ARCHIVE, { z: 14, x: 8414, y: 5383 }), new Uint8Array([4, 5]));

		await publish({ includeBaseMap: true });
		await publish({ includeBaseMap: false });

		expect(await store.list('base-map/')).toEqual(
			[first, cachedTilePath(ARCHIVE, { z: 14, x: 8414, y: 5383 })].sort()
		);
		expect([...(await store.read(first))]).toEqual([1, 2, 3]);
	});

	it('records a Workspace carrying cached tiles as having its Base Map, whatever the checkbox said', async () => {
		// ADR-0025's change of meaning: `baseMapBundled` is now an observation of the folder, and
		// publishing copies nothing to make it true — the tiles are already in the published root. The
		// glyphs and sprites are the separate, chosen half.
		await store.write(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }), new Uint8Array([1]));
		await publish({ includeBaseMap: false });
		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(record.baseMapBundled).toBe(true);
		expect(record.baseMapAssetsBundled).toBe(false);
	});

	it('names which archives it carries tiles for, because the viewer cannot list a directory', async () => {
		// The published half of ticket 12's keyed cache. The tiles are at `base-map/tiles/<key>/…` and
		// the key is one-way, so a Reader — whose store is HTTP over a static host (ADR-0006) — has no
		// way to discover which catalog entry they belong to. Drawing them under whichever entry is
		// selected is exactly the wrong-map failure the key exists to end, so the record says.
		const other = 'https://other.test/v4.pmtiles';
		await store.write(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }), new Uint8Array([1]));
		await writeCachedTileSource(store, { archive: ARCHIVE, maxZoom: 14 });
		await store.write(cachedTilePath(other, { z: 0, x: 0, y: 0 }), new Uint8Array([2]));
		await writeCachedTileSource(store, { archive: other, maxZoom: 11 });

		await publish({ includeBaseMap: false });

		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(
			[...record.baseMapCaches].sort((a, b) => (a.archive ?? '').localeCompare(b.archive ?? ''))
		).toEqual([
			{ archive: ARCHIVE, maxZoom: 14 },
			{ archive: other, maxZoom: 11 }
		]);
	});

	it('reads a pre-ticket-12 record’s baseMapMaxZoom rather than drawing nothing', async () => {
		// ⚠ The silent failure this fallback exists for. A site published before the cache was keyed
		// says `baseMapBundled: true` and carries `baseMapMaxZoom`, with its tiles at the unkeyed
		// `base-map/tiles/{z}/…`. Read strictly, its `baseMapCaches` is empty, the viewer draws no
		// geography at all, and nothing says why — indistinguishable from the archive being down.
		const record = parsePublishedSite(
			new TextEncoder().encode(
				JSON.stringify({
					formatVersion: 1,
					viewerVersion: 'v1',
					publishedAt: '2026-01-01T00:00:00.000Z',
					projects: [],
					baseMapBundled: true,
					baseMapMaxZoom: 14
				})
			)
		);

		// No archive, because the old layout belonged to no entry in particular: one directory served
		// whichever the Reader had selected, and `ReaderMapPane` matches a `null` against any entry.
		expect(record.baseMapCaches).toEqual([{ archive: null, maxZoom: 14 }]);
	});

	it('publishes a pre-ticket-12 pile as what it is, rather than dropping it', async () => {
		// Re-publishing must not take a working offline site away from a scholar. The depth comes off
		// the files, which is exactly what the old `baseMapMaxZoom` was.
		await store.write('base-map/tiles/0/0/0.mvt', new Uint8Array([1]));
		await store.write('base-map/tiles/11/1054/675.mvt', new Uint8Array([2]));

		await publish({ includeBaseMap: false });

		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(record.baseMapCaches).toEqual([{ archive: null, maxZoom: 11 }]);
		expect(record.baseMapBundled).toBe(true);
	});

	it('claims no archive for a cache whose provenance record is missing', async () => {
		// The tiles are still served — publishing copies nothing and deletes nothing — but there is no
		// honest thing to say about them, and attaching them to a guessed entry is worse than silence.
		await store.write(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }), new Uint8Array([1]));

		await publish({ includeBaseMap: false });

		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(record.baseMapCaches).toEqual([]);
		// It is still a Workspace carrying tiles, and the size sentence still counts them.
		expect(record.baseMapBundled).toBe(true);
	});

	it('records the glyphs and sprites separately from the tiles', async () => {
		await publish({ includeBaseMap: true });
		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		// No tiles cached, so the geography still needs the network; the labels do not.
		expect(record.baseMapBundled).toBe(false);
		expect(record.baseMapAssetsBundled).toBe(true);
	});

	it('keeps the hashed chunks an earlier viewer left, which ADR-0006 accepts', async () => {
		// The counterpart to the sweep above, and the reason it is not simply "delete what is not in
		// the plan": `_app/` holds content-hashed names, so an edited viewer writes new ones beside the
		// old and ADR-0006 takes that accumulation as the cost of publishing into the working folder.
		// Changing that is a decision for the ADR, so a test holds the line rather than a comment.
		await store.write('_app/immutable/nodes/0.FROM-AN-OLDER-BUILD.js', encode('older'));

		await publish();

		expect(await store.list('_app/immutable/nodes/')).toContain(
			'_app/immutable/nodes/0.FROM-AN-OLDER-BUILD.js'
		);
	});

	it('refreshes a version stamp that has gone stale, rather than leaving what is there', async () => {
		await publish();
		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		await store.write(
			'ballastella-site.json',
			encode(JSON.stringify({ ...record, viewerVersion: 'v0-an-older-viewer' }))
		);
		expect((await readPublishedSite(store))?.viewerVersion).toBe('v0-an-older-viewer');

		await publish();

		expect((await readPublishedSite(store))?.viewerVersion).toBe('v1-abcdef0123456789');
	});

	it('reports progress that reaches the total it announced, both authored files included', async () => {
		// The two publishing authors rather than fetches — `ballastella-site.json` and `.nojekyll` —
		// are counted like any other file. A total that omitted one would tick past its own maximum,
		// which is the progress bar going backwards in front of the user.
		const AUTHORED = 2;
		const seen: { files: number; totalFiles: number; path: string | null }[] = [];

		await publishSite({
			store,
			plan: await planPublish(store, {
				bundle,
				projects: await workspace.listProjects(),
				includeBaseMap: false
			}),
			readAsset: asset,
			onProgress: (progress) => seen.push(progress)
		});

		const last = seen.at(-1);
		expect(last).toEqual({
			files: bundle.files.length + AUTHORED,
			totalFiles: bundle.files.length + AUTHORED,
			path: 'ballastella-site.json'
		});
		expect(seen[0]).toEqual({
			files: 0,
			totalFiles: bundle.files.length + AUTHORED,
			path: null
		});
		// The record stays last, so "the site is complete" still means the record landed.
		expect(seen.map((progress) => progress.path)).toContain('.nojekyll');
	});

	it('has never been published until it has, and says so as null rather than as a failure', async () => {
		expect(await readPublishedSite(store)).toBeNull();

		await publish();

		expect(await readPublishedSite(store)).not.toBeNull();
	});

	it('surfaces a site record that is there and unreadable', async () => {
		await store.write('ballastella-site.json', encode('{ not json'));

		await expect(readPublishedSite(store)).rejects.toThrow('could not be read');
	});

	it('leaves the published viewer out of a Project bundle', async () => {
		// The end-to-end form of ADR-0006's requirement, across the two features: publish, then
		// export. The published files are at the Workspace and a bundle is rooted at the Project, so
		// this asserts the arrangement as much as the list.
		// The Layer is what makes the export gather the shared material: a bundle carries the
		// `images/<id>/` and `alignments/<id>.json` its Layers reference, out of the Workspace and in at
		// the paths the format has always used (ADR-0023).
		const file = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', {
			...file,
			layers: [newMapLayer({ id: 'l1', name: 'Blaeu’s plan', imageId: 'x' })]
		});
		await publish({ includeBaseMap: true });

		const paths: string[] = [];
		const entries = (await exportProjectBundle(store, 'amsterdam-1625')).body.pipeThrough(
			createTarDecoder({ strict: true })
		);
		for await (const entry of entries) {
			paths.push(entry.header.name);
			await entry.body.cancel();
		}

		expect([...paths].sort()).toEqual([
			'alignments/x.json',
			'images/x/0,0,256,256/256,256/0/default.jpg',
			'images/x/info.json',
			'project.json'
		]);
	});
});

describe('telling the author a Published Site is behind', () => {
	const site = {
		formatVersion: 1,
		viewerVersion: 'v1',
		publishedAt: '2026-01-01T00:00:00.000Z',
		projects: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: true }],
		baseMap: FORKED_CATALOG,
		baseMapBundled: false,
		baseMapAssetsBundled: false,
		baseMapCaches: []
	};
	const summary = (directory: string, name: string) => ({
		directory,
		name,
		updatedAt: '2026-01-01T00:00:00.000Z',
		onFrontPage: true,
		problem: null
	});

	it('says nothing when the site matches the Workspace', () => {
		expect(
			publishedSiteStaleness(site, {
				viewerVersion: 'v1',
				projects: [summary('amsterdam-1625', 'Amsterdam 1625')]
			})
		).toBe('');
	});

	it('says nothing at all about a Workspace that has never been published', () => {
		expect(publishedSiteStaleness(null, { viewerVersion: 'v1', projects: [] })).toBe('');
	});

	it('names a Project the hub page does not list yet', () => {
		const notice = publishedSiteStaleness(site, {
			viewerVersion: 'v1',
			projects: [summary('amsterdam-1625', 'Amsterdam 1625'), summary('boston-1775', 'Boston 1775')]
		});

		expect(notice).toContain('Boston 1775');
		expect(notice).toContain('not on it yet');
	});

	it('names a Project the hub page still lists, and one listed under an older name', () => {
		expect(publishedSiteStaleness(site, { viewerVersion: 'v1', projects: [] })).toContain(
			'still on it'
		);
		expect(
			publishedSiteStaleness(site, {
				viewerVersion: 'v1',
				projects: [summary('amsterdam-1625', 'Amsterdam, 1625')]
			})
		).toContain('an older name');
	});

	it('notices an older viewer even when the Project list agrees', () => {
		expect(
			publishedSiteStaleness(site, {
				viewerVersion: 'v2',
				projects: [summary('amsterdam-1625', 'Amsterdam 1625')]
			})
		).toContain('an older version of the viewer');
	});
});

describe('stamping a canonical URL', () => {
	let store: MemoryProjectStore;
	let workspace: Workspace;

	beforeEach(async () => {
		store = new MemoryProjectStore();
		workspace = new Workspace(store, { now: () => new Date('2026-01-02T03:04:05.000Z') });
		await workspace.createProject('Amsterdam 1625');
		for (const imageId of ['aaa', 'bbb']) {
			await store.write(
				imageInfoPath(imageId),
				encode(
					`${JSON.stringify(
						{
							'@context': 'http://iiif.io/api/image/3/context.json',
							id: `https://unset.invalid/${imageId}`,
							type: 'ImageService3',
							profile: 'level0',
							width: 4096,
							height: 3072,
							somethingNewer: 'kept'
						},
						null,
						'\t'
					)}\n`
				)
			);
		}
	});

	const infoJson = async (imageId: string) =>
		JSON.parse(decode(await store.read(imageInfoPath(imageId))));

	// **The address names no Project** (ADR-0023). A Historical Map is shared, so there is one citable
	// endpoint for it however many Projects draw it — and the per-Project spelling was a citation that
	// broke the moment a second Project used the map or the first one was renamed.
	it('rewrites every info.json id to the address the tiles are published at', async () => {
		const stamp = await stampCanonicalUrl(store, 'https://scholar.example/atlas/', ['aaa', 'bbb']);

		expect(stamp.url).toBe('https://scholar.example/atlas');
		expect(stamp.images).toEqual(['aaa', 'bbb']);
		expect((await infoJson('aaa')).id).toBe('https://scholar.example/atlas/images/aaa');
		expect((await infoJson('bbb')).id).toBe('https://scholar.example/atlas/images/bbb');
	});

	it('is the address a IIIF client concatenates a tile path onto', async () => {
		// The whole value of stamping is that somebody else's client can fetch these tiles
		// (ADR-0004, SPEC story 92), and it builds every URL by concatenating onto `id`. So the
		// stamped base plus a real IIIF tile path has to be where the tile actually is — which, since
		// ADR-0023, is `<site>/images/<id>/…` with no Project directory in between.
		const id = canonicalImageServiceId('https://scholar.example', 'aaa');
		const tile = '0,0,256,256/256,256/0/default.jpg';

		expect(id).toBe('https://scholar.example/images/aaa');
		expect(`${id}/${tile}`).toBe(`https://scholar.example/images/aaa/${tile}`);
	});

	it('keeps every other field of info.json, including one it does not understand', async () => {
		await stampCanonicalUrl(store, 'https://scholar.example', ['aaa']);

		expect(await infoJson('aaa')).toMatchObject({
			'@context': 'http://iiif.io/api/image/3/context.json',
			type: 'ImageService3',
			profile: 'level0',
			width: 4096,
			height: 3072,
			somethingNewer: 'kept'
		});
	});

	it('is remembered in the Project the caller recorded it in', async () => {
		await workspace.createProject('Boston 1775');
		const stamp = await stampCanonicalUrl(store, 'https://scholar.example', ['aaa']);
		const file = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', { ...file, canonicalUrl: stamp.url });

		expect((await workspace.readProject('amsterdam-1625')).canonicalUrl).toBe(
			'https://scholar.example'
		);
		expect((await workspace.readProject('boston-1775')).canonicalUrl).toBeNull();
		// And it survives the round trip through the file rather than only through the object.
		expect(decode(await store.read('amsterdam-1625/project.json'))).toContain(
			'"canonicalUrl": "https://scholar.example"'
		);
	});

	it('leaves an unstamped project.json byte-identical to one written before the field existed', async () => {
		// The byte-identity contract this codebase asserts across reorder, rename, toggle, and
		// opacity. A `canonicalUrl: null` written out would break every one of them and would put a
		// diff in every Project of every Workspace kept in git, on the day the app was updated.
		const file = newProjectFile('Amsterdam 1625', new Date('2026-01-02T03:04:05.000Z'));

		expect(decode(serialiseProjectFile(file))).not.toContain('canonicalUrl');
		expect(decode(serialiseProjectFile(parseProjectFile(serialiseProjectFile(file))))).toBe(
			decode(serialiseProjectFile(file))
		);
	});

	it('refuses an address a IIIF client could not fetch from, before touching a file', async () => {
		const before = decode(await store.read(imageInfoPath('aaa')));

		for (const bad of ['', '   ', 'scholar.example', 'ftp://scholar.example', 'not a url']) {
			await expect(stampCanonicalUrl(store, bad, ['aaa'])).rejects.toThrow(PublishRefusedError);
		}

		expect(decode(await store.read(imageInfoPath('aaa')))).toBe(before);
	});

	it('normalises what the user typed into a base other paths hang off', () => {
		expect(normaliseCanonicalUrl('  https://scholar.example/atlas/  ')).toBe(
			'https://scholar.example/atlas'
		);
		expect(normaliseCanonicalUrl('https://scholar.example/atlas?utm=x#top')).toBe(
			'https://scholar.example/atlas'
		);
		expect(normaliseCanonicalUrl('http://localhost:8080')).toBe('http://localhost:8080');
		expect(normaliseCanonicalUrl('mailto:someone@example.com')).toBe('');
	});
});

describe('reading the staged viewer bundle index', () => {
	it('reads the shape the build script writes', () => {
		expect(
			parseViewerBundle({
				version: 'abc',
				files: [{ path: 'index.html', source: 'viewer-bundle/index.html', bytes: 10 }],
				baseMap: []
			})
		).toEqual({
			version: 'abc',
			files: [{ path: 'index.html', source: 'viewer-bundle/index.html', bytes: 10 }],
			baseMap: []
		});
	});

	it('refuses an index that would publish an incomplete site', () => {
		// A staging step that half ran is the failure here, and its symptom without this check is a
		// Published Site missing whichever chunks the index forgot — a blank page and a 404.
		for (const bad of [
			null,
			{ files: [{ path: 'index.html', source: 'a', bytes: 1 }] },
			{ version: 'abc', files: [] },
			{ version: 'abc', files: [{ path: '_app/x.js', source: 'a', bytes: 1 }] },
			{ version: 'abc', files: [{ path: 'index.html', source: 'a' }] },
			{ version: 'abc', files: [{ path: 'index.html', bytes: 1 }] },
			{ version: 'abc', files: [{ path: '/index.html', source: 'a', bytes: 1 }] },
			{ version: 'abc', files: 'index.html' }
		]) {
			expect(() => parseViewerBundle(bad)).toThrow('could not be read');
		}
	});
});

describe('the site record a Reader’s page is drawn from', () => {
	it('falls back to this build’s catalog rather than leaving a Reader with no Base Map', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode('{"projects":[{"directory":"x"}],"baseMap":{"entries":[]}}')
		);

		expect(record.baseMap.entries.length).toBeGreaterThan(0);
		expect(record.projects).toEqual([{ directory: 'x', name: 'x', onFrontPage: true }]);
	});

	it('keeps a catalog it does not fully understand, because resolution already falls back', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode(
				JSON.stringify({ projects: [], baseMap: CATALOG_WITH_STALE_DEFAULT })
			)
		);

		expect(record.baseMap).toEqual(CATALOG_WITH_STALE_DEFAULT);
	});

	it('reads a record written before the field split as having its Base Map files', () => {
		// ⚠ ADR-0025 moved `baseMapBundled` from "the deployment's Base Map files were copied" to "this
		// Workspace carries cached tiles". A site published before that move records the old meaning and
		// has no `baseMapAssetsBundled` at all — and `ReaderMapPane` drops `glyphs`, `sprite`, and every
		// symbol layer when that field is false. Read strictly, every already-published site reopened
		// with no place names on its map and a notice saying the labels had not been copied, while
		// `base-map/fonts/` sat on the host. Nothing threw, and nothing else would have noticed.
		const record = parsePublishedSite(
			new TextEncoder().encode(JSON.stringify({ projects: [], baseMapBundled: true }))
		);

		expect(record.baseMapAssetsBundled).toBe(true);
	});

	it('does not invent Base Map files for an old record that had none', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode(JSON.stringify({ projects: [], baseMapBundled: false }))
		);

		expect(record.baseMapAssetsBundled).toBe(false);
	});

	it('lets a record that states both fields disagree with itself', () => {
		// The state ticket 11 makes ordinary: tiles cached, labels left out. The fallback above must not
		// override an explicit `false`, or a site that deliberately omitted its glyphs would claim them.
		const record = parsePublishedSite(
			new TextEncoder().encode(
				JSON.stringify({ projects: [], baseMapBundled: true, baseMapAssetsBundled: false })
			)
		);

		expect(record.baseMapBundled).toBe(true);
		expect(record.baseMapAssetsBundled).toBe(false);
	});

	/**
	 * ⚠ **An entry with no `onFrontPage` is on the Front Page** (ADR-0032).
	 *
	 * Every site published before this field is in front of Readers now, and its entries carry none.
	 * Reading the field strictly would empty those Front Pages: every Project still on the host, still
	 * fetchable, none of them listed, and nothing on the page to say why. `parsePublishedSite` is the
	 * tolerant reader for exactly this class of thing, and this is the case where "must still list the
	 * Projects" is the whole point rather than a nicety.
	 */
	it('lists every Project when the entries predate the front-page choice', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode(
				'{"projects":[{"directory":"a","name":"A"},{"directory":"b","name":"B"}]}'
			)
		);

		expect(record.projects.map((project) => project.onFrontPage)).toEqual([true, true]);
	});

	it('reads a choice the record does carry', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode(
				'{"projects":[{"directory":"a","name":"A","onFrontPage":false},' +
					'{"directory":"b","name":"B","onFrontPage":true}]}'
			)
		);

		expect(record.projects.map((project) => project.onFrontPage)).toEqual([false, true]);
	});

	it('drops a Project entry with no folder, which is the one field ?p= needs', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode('{"projects":[{"name":"nameless"},{"directory":"x","name":"X"}]}')
		);

		expect(record.projects).toEqual([{ directory: 'x', name: 'X', onFrontPage: true }]);
	});
});
