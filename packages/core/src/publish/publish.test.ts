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
	readRemoteBinding,
	type PublishPlan,
	type PublishedRepository,
	type ViewerBundle
} from '../index.js';
import { parseViewerBundle } from './viewer-bundle.js';

// Seam 1. Publishing is a file-level behaviour end to end — "these paths now hold these
// bytes, and every Project file is exactly as it was" — so the in-memory ProjectStore is not
// standing in for anything. What only a browser can settle is whether the files it wrote *serve a
// working site*, at a domain root and at a subdirectory, and that is `e2e/editor-publish.e2e.ts`.

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** An archive, so the keyed cache directory is built rather than spelled. */
const ARCHIVE = 'https://example.test/v4.pmtiles';

/**
 * A staged viewer bundle, shaped exactly as `scripts/stage-viewer-bundle.mjs` writes it.
 *
 * Small and fictional on purpose: the real chunk names are content hashes that change on every
 * viewer edit, so a test naming them would be a test about the bundler. What matters here is the
 * shape — an `index.html`, hashed assets under `_app/`, and a Base Map set written with the viewer.
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

	const plan = async (): Promise<PublishPlan> =>
		planPublish(store, {
			bundle,
			projects: await workspace.listProjects()
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

		await plan();

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

	it('counts complete tiled Map Images separately from the published viewer', async () => {
		await store.write('images/x/info.json', encode('{}'));
		await store.write('images/x/0,0,256,256/256,256/0/default.jpg', encode('tile'));

		const planned = await plan();

		expect(planned.mapImages.files).toBe(2);
		expect(planned.mapImages.bytes).toBeGreaterThan(0);
	});

	it('states the Base Map’s size before it is added', async () => {
		const planned = await plan();

		const stated = planned.warnings.find((warning) => warning.kind === 'base-map-size');
		expect(stated?.message).toContain('4.1 MB');
		expect(stated?.message).toContain('3 more files');
		expect(planned.bytes).toBeGreaterThan(4_000_000);
		expect(planned.files.map((file) => file.path)).toContain('base-map/extract.pmtiles');
	});

	it('warns that a referenced Map Image leaves a Reader with no network seeing nothing', async () => {
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

	it('says nothing about the network when every Map Image is a local copy', async () => {
		await store.write('images/mine/info.json', encode('{"id":"https://unset.invalid/mine"}'));
		const file = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', {
			...file,
			layers: [newMapLayer({ id: 'l1', name: 'My own scan', imageId: 'mine' })]
		});

		expect((await plan()).warnings.map((warning) => warning.kind)).toEqual(['base-map-size']);
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

		const warning = (await plan()).warnings.find((entry) => entry.kind === 'hosting-limit');

		expect(warning?.message).toContain('1.0 GB');
		expect(warning?.message).toContain('GitHub Pages');
		expect(warning?.message).toContain('999 MB');
	});

	it('names the byte weight of the Map Images no Project uses', async () => {
		// Publishing is additive: those maps are already in the directory the site is written into and
		// cannot be left out of it. So the ADR-0008 warning has to say how much of the drop is dead
		// weight, or the user is told they are stuck when they are one deletion from not being.
		await store.write('images/nobody/info.json', encode('{"id":"https://unset.invalid/nobody"}'));
		await store.write(
			'images/nobody/big.jpg',
			new Uint8Array(STATIC_HOSTING_LIMIT_BYTES - 1_000_000)
		);

		const planned = await plan();
		const warning = planned.warnings.find((entry) => entry.kind === 'hosting-limit');

		expect(planned.unusedMapImages.maps).toBe(1);
		expect(planned.unusedMapImages.bytes).toBeGreaterThan(STATIC_HOSTING_LIMIT_BYTES - 1e6);
		expect(warning?.message).toContain('999 MB of Map Images no Project uses');
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

		const planned = await plan();

		expect(planned.unusedMapImages).toEqual({ bytes: 0, maps: 0 });
		// The warning is still there — the cliff is still crossed — so this is not passing because the
		// message is absent.
		const warning = planned.warnings.find((entry) => entry.kind === 'hosting-limit');
		expect(warning?.message).toContain('GitHub Pages');
		expect(warning?.message).not.toContain('no Project uses');
	});

	it('says nothing about the hosting limit for a Workspace nowhere near it', async () => {
		await store.write('images/x/small.jpg', new Uint8Array(1000));

		expect((await plan()).warnings.map((entry) => entry.kind)).toEqual(['base-map-size']);
	});

	it('carries this deployment’s Base Map catalog, so the site keeps working when it changes', async () => {
		const planned = await planPublish(store, {
			bundle,
			projects: await workspace.listProjects(),
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

	const publish = async (
		options: { at?: string; editorUrl?: string; repository?: PublishedRepository } = {}
	) =>
		publishSite({
			store,
			plan: await planPublish(store, {
				bundle,
				projects: await workspace.listProjects(),
				...(options.editorUrl === undefined ? {} : { editorUrl: options.editorUrl }),
				...(options.repository === undefined ? {} : { repository: options.repository })
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
				'base-map/extract.pmtiles',
				'base-map/fonts/Noto Sans Regular/0-255.pbf',
				'base-map/sprites/light.png',
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

		await publish();

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

		await publish();

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
				projects: await workspace.listProjects()
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

	it('duplicates no tile bytes: the pyramid is in the Workspace exactly once', async () => {
		// The other half of ADR-0006's refusal to copy, and the half a caller can check without a spy:
		// after a publish the tile's bytes appear at one path and no other. The read-count test above
		// says publishing never opened a tile; this says nothing carrying those bytes was written
		// either, which is what a scholar reading their own folder would look at.
		const tile = decode(await store.read('images/x/0,0,256,256/256,256/0/default.jpg'));

		await publish();

		const carrying: string[] = [];
		for (const path of await store.list('')) {
			if (decode(await store.read(path)) === tile) carrying.push(path);
		}
		expect(carrying).toEqual(['images/x/0,0,256,256/256,256/0/default.jpg']);
	});

	it('records exactly the paths it writes, so the data-only zip can exclude them', async () => {
		await publish();

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
			projects: await workspace.listProjects()
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

	// The site says which instance published it, which is what lets its Front Page carry a link back
	// to an editor that can clone it.
	it('records the editor instance that published the site', async () => {
		const site = await publish({ editorUrl: 'https://maps.example.edu/ballastella/' });

		expect(parsePublishedSite(await store.read('ballastella-site.json'))).toEqual(site);
		expect(site.editorUrl).toBe('https://maps.example.edu/ballastella/');
	});

	// A publish that was not told an address says nothing rather than guessing at one: a Front Page with
	// no link is the degradation the return links are designed for, and a canonical deployment invented
	// here would send a Reader to somebody else's instance.
	it('says nothing about the instance when publishing was not told one', async () => {
		const site = await publish();

		expect(parsePublishedSite(await store.read('ballastella-site.json'))).toEqual(site);
		expect(site.editorUrl).toBe('');
	});

	/**
	 * ⚠ **An address only the publishing machine can reach is not recorded at all.** The editor stamps
	 * its own origin, so an author publishing to GitHub Pages out of `pnpm dev` would otherwise record
	 * `http://localhost:5173/` — and every Reader's Front Page would offer a live link into whatever
	 * is running on *their own* port 5173. Nothing in the publish dialog shows the address or offers
	 * to override it, so the record refuses it, and the site degrades to the no-instance state the
	 * test above describes.
	 */
	it.each([['http://localhost:5173/'], ['http://127.0.0.1:5173/'], ['http://atlas/ballastella/']])(
		'records nothing for %s, which no Reader could reach',
		async (editorUrl) => {
			const site = await publish({ editorUrl });

			expect(parsePublishedSite(await store.read('ballastella-site.json'))).toEqual(site);
			expect(site.editorUrl).toBe('');
		}
	);

	/**
	 * The repository the site was published to, so its Front Page can name it in a return link.
	 *
	 * ⚠ **Generated by the Publish rather than synchronized as a local binding.** A static host cannot
	 * be asked what repository it is serving, so the coordinates have to be *in* the site — and the
	 * whole point of putting them on the record rather than leaving them in `remote.json` is that a
	 * Published Site may point back at its repository without any reader of it acquiring a Remote.
	 */
	it('records the repository it was published to, for the return links', async () => {
		const site = await publish({
			editorUrl: 'https://maps.example.edu/ballastella/',
			repository: { owner: 'ada', repository: 'atlas', branch: 'main' }
		});

		expect(parsePublishedSite(await store.read('ballastella-site.json'))).toEqual(site);
		expect(site.repository).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
	});

	it('records no repository when publishing was not told one, as a publish to a folder is', async () => {
		const site = await publish({ editorUrl: 'https://maps.example.edu/ballastella/' });

		expect(site.repository).toBeNull();
	});

	/**
	 * ⚠ **Nothing published can make this Workspace bound.** The coordinates on the record are
	 * evidence about a *site*; the Remote relationship is installation-local metadata keyed by
	 * Workspace identity. A Workspace holding a site record and no binding document is
	 * what a restored Backup, a copied folder and a forked repository's contents all look like, and
	 * every one of them must read as unbound — so the binding reader is asked here, and must not have
	 * learned to fall back to the record.
	 */
	it('creates no binding from what it published, so the record cannot bind a Workspace', async () => {
		await publish({
			editorUrl: 'https://maps.example.edu/ballastella/',
			repository: { owner: 'ada', repository: 'atlas', branch: 'main' }
		});

		expect(await store.list('remote.json')).toEqual([]);
		expect(await readRemoteBinding(store)).toBeNull();
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
		// The semester-long, one-repository workflow.
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

	it('includes Base Map display assets on every publish', async () => {
		// Re-publishing must keep the display assets beside the viewer and the site record.
		await publish();
		expect(await store.list('base-map/')).toEqual([
			'base-map/extract.pmtiles',
			'base-map/fonts/Noto Sans Regular/0-255.pbf',
			'base-map/sprites/light.png'
		]);
		const project = await snapshot('amsterdam-1625/');

		await publish();

		expect(await store.list('base-map/')).toEqual([
			'base-map/extract.pmtiles',
			'base-map/fonts/Noto Sans Regular/0-255.pbf',
			'base-map/sprites/light.png'
		]);
		expect(parsePublishedSite(await store.read('ballastella-site.json')).baseMapAssetsBundled).toBe(
			true
		);
		// The sweep never leaves the recorded list, so the Projects beside it are byte-identical.
		expect(await snapshot('amsterdam-1625/')).toEqual(project);
		expect(decode(await store.read('index.html'))).toBe('bytes of viewer-bundle/index.html');
	});

	it('leaves the offline tile cache alone when publishing display assets', async () => {
		// ⚠ The one thing the sweep above must not reach. `base-map/` is a recorded viewer directory,
		// and since ADR-0025 the opt-in tile cache lives inside it — bytes a user asked for and fetched
		// from somebody else's server. Publishing must never delete them, or the Project would silently
		// stop being available offline.
		const first = cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 });
		await store.write(first, new Uint8Array([1, 2, 3]));
		await store.write(cachedTilePath(ARCHIVE, { z: 14, x: 8414, y: 5383 }), new Uint8Array([4, 5]));

		await publish();
		await publish();

		expect(await store.list('base-map/')).toEqual(
			[
				'base-map/extract.pmtiles',
				'base-map/fonts/Noto Sans Regular/0-255.pbf',
				'base-map/sprites/light.png',
				first,
				cachedTilePath(ARCHIVE, { z: 14, x: 8414, y: 5383 })
			].sort()
		);
		expect([...(await store.read(first))]).toEqual([1, 2, 3]);
	});

	it('records a Workspace carrying cached tiles as having its Base Map', async () => {
		// ADR-0025's change of meaning: `baseMapBundled` is now an observation of the folder, and
		// publishing copies nothing to make it true — the tiles are already in the published root. The
		// glyphs and sprites are the separate display-asset half.
		await store.write(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }), new Uint8Array([1]));
		await publish();
		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(record.baseMapBundled).toBe(true);
		expect(record.baseMapAssetsBundled).toBe(true);
	});

	it('names which archives it carries tiles for, because the viewer cannot list a directory', async () => {
		// The published half of the keyed cache. The tiles are at `base-map/tiles/<key>/…` and
		// the key is one-way, so a Reader — whose store is HTTP over a static host (ADR-0006) — has no
		// way to discover which catalog entry they belong to. Drawing them under whichever entry is
		// selected is exactly the wrong-map failure the key exists to end, so the record says.
		const other = 'https://other.test/v4.pmtiles';
		await store.write(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }), new Uint8Array([1]));
		await writeCachedTileSource(store, { archive: ARCHIVE, maxZoom: 14 });
		await store.write(cachedTilePath(other, { z: 0, x: 0, y: 0 }), new Uint8Array([2]));
		await writeCachedTileSource(store, { archive: other, maxZoom: 11 });

		await publish();

		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(
			[...record.baseMapCaches].sort((a, b) => (a.archive ?? '').localeCompare(b.archive ?? ''))
		).toEqual([
			{ archive: ARCHIVE, maxZoom: 14 },
			{ archive: other, maxZoom: 11 }
		]);
	});

	it('reads an older record’s baseMapMaxZoom rather than drawing nothing', async () => {
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

	it('publishes a legacy unkeyed pile as what it is, rather than dropping it', async () => {
		// Re-publishing must not take a working offline site away from a scholar. The depth comes off
		// the files, which is exactly what the old `baseMapMaxZoom` was.
		await store.write('base-map/tiles/0/0/0.mvt', new Uint8Array([1]));
		await store.write('base-map/tiles/11/1054/675.mvt', new Uint8Array([2]));

		await publish();

		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(record.baseMapCaches).toEqual([{ archive: null, maxZoom: 11 }]);
		expect(record.baseMapBundled).toBe(true);
	});

	it('claims no archive for a cache whose provenance record is missing', async () => {
		// The tiles are still served — publishing copies nothing and deletes nothing — but there is no
		// honest thing to say about them, and attaching them to a guessed entry is worse than silence.
		await store.write(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }), new Uint8Array([1]));

		await publish();

		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(record.baseMapCaches).toEqual([]);
		// It is still a Workspace carrying tiles, and the size sentence still counts them.
		expect(record.baseMapBundled).toBe(true);
	});

	it('records the glyphs and sprites separately from the tiles', async () => {
		await publish();
		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		// No tiles cached, so the geography still needs the network; the labels do not.
		expect(record.baseMapBundled).toBe(false);
		expect(record.baseMapAssetsBundled).toBe(true);
	});

	it('records no display assets when the deployment bundle has none', async () => {
		const withoutAssets = await planPublish(store, {
			bundle: { ...bundle, baseMap: [] },
			projects: await workspace.listProjects()
		});
		await publishSite({ store, plan: withoutAssets, readAsset: asset });

		const record = parsePublishedSite(await store.read('ballastella-site.json'));
		expect(record.baseMapAssetsBundled).toBe(false);
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
				projects: await workspace.listProjects()
			}),
			readAsset: asset,
			onProgress: (progress) => seen.push(progress)
		});

		const last = seen.at(-1);
		expect(last).toEqual({
			files: bundle.files.length + bundle.baseMap.length + AUTHORED,
			totalFiles: bundle.files.length + bundle.baseMap.length + AUTHORED,
			path: 'ballastella-site.json'
		});
		expect(seen[0]).toEqual({
			files: 0,
			totalFiles: bundle.files.length + bundle.baseMap.length + AUTHORED,
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
		await publish();

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
		editorUrl: '',
		repository: null,
		projects: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: true }],
		baseMap: FORKED_CATALOG,
		baseMapBundled: false,
		baseMapAssetsBundled: false,
		baseMapCaches: []
	};
	const summary = (directory: string, name: string, onFrontPage = true) => ({
		directory,
		name,
		updatedAt: '2026-01-01T00:00:00.000Z',
		onFrontPage,
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

	/**
	 * ⚠ **A Front Page choice the site has not been told about is drift, like a rename** (ADR-0032).
	 *
	 * Taking a Project off writes `project.json` and nothing more; until the Workspace is published
	 * again the live site's Front Page still offers it to every Reader who arrives. Without this the
	 * banner stays empty and the toggle looks live when it is not — the one failure that would make a
	 * scholar believe they had taken something down.
	 */
	it('names a Project the site’s front page still lists', () => {
		const notice = publishedSiteStaleness(site, {
			viewerVersion: 'v1',
			projects: [summary('amsterdam-1625', 'Amsterdam 1625', false)]
		});

		expect(notice).toContain('Amsterdam 1625');
		expect(notice).toContain('still on its front page');
	});

	// And the other way: put back on, and the published site does not list it yet. Said separately,
	// because which answer the live site is still giving is the whole content of the sentence.
	it('names a Project the site’s front page does not list yet', () => {
		const notice = publishedSiteStaleness(
			{
				...site,
				projects: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: false }]
			},
			{ viewerVersion: 'v1', projects: [summary('amsterdam-1625', 'Amsterdam 1625')] }
		);

		expect(notice).toContain('not on its front page yet');
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

	// **The address names no Project** (ADR-0023). A Map Image is shared, so there is one citable
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
		// (ADR-0004), and it builds every URL by concatenating onto `id`. So the
		// stamped base plus a real IIIF tile path has to be where the tile actually is — which, since
		// ADR-0023, is `<site>/images/<id>/…` with no Project directory in between.
		const id = canonicalImageServiceId('https://scholar.example', 'aaa');
		const tile = '0,0,256,256/256,256/0/default.jpg';

		expect(id).toBe('https://scholar.example/images/aaa');
		expect(`${id}/${tile}`).toBe(`https://scholar.example/images/aaa/${tile}`);
	});

	/**
	 * The other state of the same field, and the one a publish is ordinarily in.
	 *
	 * Stamping is opt-in, so a publish that was given no address must leave every `id` at ADR-0004's
	 * placeholder host rather than guessing at one. A stamp derived from the store's own location
	 * would be a citation nobody could fetch, and it would be written into the user's folder on every
	 * publish without their asking.
	 */
	it('leaves an unstamped info.json id at the ADR-0004 placeholder', async () => {
		await publishSite({
			store,
			plan: await planPublish(store, {
				bundle,
				projects: await workspace.listProjects()
			}),
			readAsset: asset
		});

		expect((await infoJson('aaa')).id).toBe('https://unset.invalid/aaa');
		expect((await infoJson('bbb')).id).toBe('https://unset.invalid/bbb');
		// The site really was written, so this is not passing because publishing did nothing at all.
		expect(await store.list('index.html')).toEqual(['index.html']);
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
		// An ordinary state: tiles cached, labels left out. The fallback above must not
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

	// Only a literal `false` takes a Project off the Front Page here too, for the reason the tolerant
	// reader exists: an entry of some other shape is a record this build did not write, and reading it
	// as "not listed" would empty a Reader's Front Page over a value nothing here understands.
	it.each([
		['a string', '"no"'],
		['a number', '0'],
		['null', 'null']
	])('lists a Project whose front-page choice is %s, rather than guessing', (_what, json) => {
		const record = parsePublishedSite(
			new TextEncoder().encode(`{"projects":[{"directory":"a","name":"A","onFrontPage":${json}}]}`)
		);

		expect(record.projects.map((project) => project.onFrontPage)).toEqual([true]);
	});

	/**
	 * A record published before the field existed says nothing about an instance, and a Front Page
	 * that met one has to render no link rather than a broken one.
	 */
	it('reads no instance address out of a record written before there was one', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode('{"projects":[{"directory":"a","name":"A"}]}')
		);

		expect(record.editorUrl).toBe('');
	});

	it('gives the instance address the trailing slash a query string is appended to', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode('{"projects":[],"editorUrl":"https://maps.example.edu/ballastella"}')
		);

		expect(record.editorUrl).toBe('https://maps.example.edu/ballastella/');
	});

	/**
	 * ⚠ **The address goes into an `href` on the site's own origin.** The record is ordinarily written
	 * by the editor, but `parsePublishedSite` is the tolerant reader for files nobody here wrote — a
	 * hand-edited record, or one served by whoever controls the host — and a `javascript:` address
	 * rendered as a link is script execution on the author's domain (ADR-0009). Refused here rather
	 * than at the one place that renders it, so the field is safe by construction wherever it is used,
	 * which is `parseRemoteBinding`'s reasoning about the same class of input.
	 */
	it.each([
		['javascript:alert(1)'],
		['data:text/html,<script>alert(1)</script>'],
		['/ballastella/'],
		['not a url at all']
	])('reads no instance address out of %s, which is not a web address', (given) => {
		const record = parsePublishedSite(
			new TextEncoder().encode(JSON.stringify({ projects: [], editorUrl: given }))
		);

		expect(record.editorUrl).toBe('');
	});

	// Credentials are whoever typed them, not where the editor lives, and this address is rendered as
	// a link on the author's own domain.
	it('takes any credentials off the instance address', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode(
				JSON.stringify({ projects: [], editorUrl: 'https://ada:hunter2@maps.example.edu/' })
			)
		);

		expect(record.editorUrl).toBe('https://maps.example.edu/');
	});

	/**
	 * ⚠ **An address only the machine that published the site can reach is refused, not rendered.**
	 * The link would be live and would go somewhere — to whatever is on *the Reader's* port 5173, or
	 * to a machine on somebody else's network — which is worse than the no-link state a record with no
	 * instance already produces. The write side refuses the same addresses; see the publishing tests.
	 */
	it.each([
		['http://localhost:5173/'],
		['http://127.0.0.1:5173/'],
		['http://[::1]:5173/'],
		['http://atlas/ballastella/']
	])('reads no instance address out of %s, which no Reader could reach', (given) => {
		const record = parsePublishedSite(
			new TextEncoder().encode(JSON.stringify({ projects: [], editorUrl: given }))
		);

		expect(record.editorUrl).toBe('');
	});

	// The rule is about reachability and nothing else: an ordinary host keeps its port, and a public
	// IPv6 literal is not loopback.
	it.each([
		['https://maps.example.edu:8443/ballastella/', 'https://maps.example.edu:8443/ballastella/'],
		['http://[2001:db8::1]/', 'http://[2001:db8::1]/']
	])('reads %s back as the instance address', (given, expected) => {
		const record = parsePublishedSite(
			new TextEncoder().encode(JSON.stringify({ projects: [], editorUrl: given }))
		);

		expect(record.editorUrl).toBe(expected);
	});

	it('drops a Project entry with no folder, which is the one field ?p= needs', () => {
		const record = parsePublishedSite(
			new TextEncoder().encode('{"projects":[{"name":"nameless"},{"directory":"x","name":"X"}]}')
		);

		expect(record.projects).toEqual([{ directory: 'x', name: 'X', onFrontPage: true }]);
	});
});
