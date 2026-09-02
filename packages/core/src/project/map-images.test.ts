import { describe, expect, it, vi } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { seedAlignmentFixture } from '../alignment/alignment-fixture.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX, type Bytes } from '../store/project-store.js';
import {
	referencedImage,
	referencedImagePath,
	serialiseReferencedImage
} from '../remote-iiif/referenced-image.js';
import { buildImageManifest } from '../tiler/image-manifest.js';
import { buildImageInfo, serialiseJson } from '../tiler/pyramid.js';
import { imageDirectory, imageInfoPath, imageManifestPath } from './image-files.js';
import {
	MapImageInUseError,
	MapImagePartlyDeletedError,
	deleteMapImage,
	mapImageUsage,
	listWorkspaceMapImages,
	partitionByOfflineCopy,
	referencedMapImages,
	tileLocation,
	unusedMapImageBytes,
	unusedMapImages
} from './map-images.js';
import { newMapLayer, newAnnotationLayer } from './layer.js';
import { newProjectFile, projectFilePath, serialiseProjectFile } from './project-file.js';

// The in-memory seam. "Which Map Images does this Workspace hold, who uses them, and what happens
// when one is deleted" is a question about which files exist, so the in-memory store is not standing
// in for anything: the folder is the product.

const bytes = (length: number): Bytes => new Uint8Array(length);

const info = (imageId: string) => buildImageInfo({ imageId, width: 4000, height: 3000 });

/**
 * A complete local pyramid: an `info.json` of ours, a manifest carrying the label, and a tile.
 *
 * The tile is what makes the no-`read` assertion mean something — a pyramid with nothing in it is a
 * pyramid nothing could have opened.
 */
async function seedLocalMap(
	store: MemoryProjectStore,
	imageId: string,
	label: string,
	tileBytes = 4096
): Promise<void> {
	await store.write(imageInfoPath(imageId), bytes(300));
	await store.write(
		imageManifestPath(imageId),
		serialiseJson(buildImageManifest({ imageId, label, info: info(imageId) }))
	);
	await store.write(tilePath(imageId), bytes(tileBytes));
}

/** One tile of a pyramid, at the shape `planPyramid` writes. */
const tilePath = (imageId: string): string =>
	`${imageDirectory(imageId)}/0,0,256,256/256,256/0/default.jpg`;

/** A Map Image whose tiles are on a Library's server: a `remote.json` and nothing else. */
async function seedReferencedMap(
	store: MemoryProjectStore,
	imageId: string,
	label: string,
	service = 'https://iiif.library.example/iiif/3/plan-1625',
	tileSize = 256
): Promise<void> {
	await store.write(
		referencedImagePath(imageId),
		serialiseReferencedImage(
			referencedImage({ imageId, service, label, width: 4000, height: 3000, tileSize })
		)
	);
}

/** A Project whose map Layers name `imageIds`. */
async function seedProject(
	store: MemoryProjectStore,
	directory: string,
	name: string,
	imageIds: readonly string[]
): Promise<void> {
	const file = newProjectFile(name, new Date('2026-01-02T03:04:05.000Z'));
	await store.write(
		projectFilePath(directory),
		serialiseProjectFile({
			...file,
			layers: imageIds.map((imageId, index) => ({
				...newMapLayer({ id: `layer-${index}`, name: `${imageId} layer`, imageId }),
				order: index
			}))
		})
	);
}

describe('where a Map Image’s tiles are', () => {
	// ADR-0023's rule, and this is now its only implementation. It used to have five: `published-site.ts`,
	// `partitionByOfflineCopy`, the viewer's 404 probe, and a derived set in each app's page. The rule
	// itself is what they disagreed about most cheaply, so it is the thing that got one home.
	it('is this Workspace when an info.json of ours is beside it', () => {
		expect(tileLocation({ infoJson: true, remoteJson: false })).toBe('in-workspace');
	});

	it('is a Library’s server when only a remote.json is', () => {
		expect(tileLocation({ infoJson: false, remoteJson: true })).toBe('referenced');
	});

	it('is this Workspace once a copy has been made, though the citation stays', () => {
		// A copied map keeps its `remote.json` — that record is the citation ADR-0007 protects — so
		// "both" is the offline copy, not an ambiguity. Reading it the other way is what made the site write
		// warn about a network dependency the Workspace no longer had.
		expect(tileLocation({ infoJson: true, remoteJson: true })).toBe('in-workspace');
	});

	it('is nothing at all for a directory holding neither', () => {
		// The tiles of an interrupted ingest. `info.json` is written last precisely so this is not yet a
		// Map Image, and nothing may list it, delete it, or count it.
		expect(tileLocation({ infoJson: false, remoteJson: false })).toBeNull();
	});
});

describe('listWorkspaceMapImages', () => {
	it('lists every Map Image in the Workspace with its label, its size, and how many files that is', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif', 40_000);
		await seedReferencedMap(store, 'bbb2', 'Plan de Paris');

		const maps = await listWorkspaceMapImages(store);

		expect(maps.map((map) => map.imageId)).toEqual(['aaa1', 'bbb2']);
		expect(maps[0]?.label).toBe('Amsterdam 1625.tif');
		expect(maps[1]?.label).toBe('Plan de Paris');
		// info.json + manifest + tile, and nothing from any other map.
		expect(maps[0]?.bytes).toBeGreaterThan(40_000);
		expect(maps[0]?.bytes).toBeLessThan(42_000);
		// The count beside the weight, because "50 kB in 3 files" and "50 kB in 31 000 files" are
		// different news for a scholar deciding what to share — and because a referenced map is one
		// small record rather than a pyramid, which is the whole point of the figure.
		expect(maps[0]?.files).toBe(3);
		expect(maps[1]?.files).toBe(1);
	});

	it('keeps a referenced Map Image’s source and Canvas label as provenance', async () => {
		const store = new MemoryProjectStore();
		await store.write(
			referencedImagePath('bbb2'),
			serialiseReferencedImage(
				referencedImage({
					imageId: 'bbb2',
					service: 'https://iiif.library.example/iiif/3/plan-1625',
					source: 'https://library.example/iiif/collection',
					label: 'Plan de Paris',
					partOf: 'https://library.example/iiif/manifest.json',
					canvas: 'https://library.example/iiif/canvas/1',
					width: 4000,
					height: 3000,
					tileSize: 256
				})
			)
		);

		const [map] = await listWorkspaceMapImages(store);

		expect(map?.provenance).toEqual({
			source: 'https://library.example/iiif/collection',
			canvasLabel: 'Plan de Paris'
		});
	});

	// The Alignment goes with the map when it is deleted, so it is in what the user is told the
	// deletion reclaims. A map nobody has placed yet has none, which is the ordinary first state.
	it('counts the Alignment among the files deleting the map would take', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif');
		await seedAlignmentFixture(store, 'aaa1', 120);

		const maps = await listWorkspaceMapImages(store);

		expect(maps[0]?.files).toBe(4);
	});

	it('says whether the tiles are in this Workspace or names the Library they are on', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif');
		await seedReferencedMap(
			store,
			'bbb2',
			'Plan de Paris',
			'https://iiif.bnf.example/iiif/3/btv1b'
		);

		const maps = await listWorkspaceMapImages(store);

		// `library`, never `host`: CONTEXT.md reserves Library for the institution whose server a
		// referenced map's tiles stay on, and lists "host" among the words that must not stand for it.
		expect(maps[0]).toMatchObject({ tiles: 'in-workspace', library: '' });
		expect(maps[1]).toMatchObject({ tiles: 'referenced', library: 'iiif.bnf.example' });
	});

	it('names the Projects that use each map, and reports none when none do', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Shared map');
		await seedLocalMap(store, 'ccc3', 'Nobody’s map');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['aaa1']);

		const maps = await listWorkspaceMapImages(store);
		const shared = maps.find((map) => map.imageId === 'aaa1');
		const unused = maps.find((map) => map.imageId === 'ccc3');

		expect(shared?.usedBy.map((project) => project.name)).toEqual([
			'Amsterdam 1625',
			'Boston 1775'
		]);
		expect(unused?.usedBy).toEqual([]);
	});

	it('counts a Project once however many of its Layers draw the same map', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Shared map');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1', 'aaa1']);

		const [map] = await listWorkspaceMapImages(store);

		expect(map?.usedBy).toEqual([{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }]);
	});

	it('opens no pyramid: the sizes come from ProjectStore#size', async () => {
		// ADR-0001 put `size` in the interface for exactly this, and `workspace-size.ts` keeps the
		// discipline. A version of this written with `read` returns the same numbers and is unusable on a
		// Workspace holding an offline copy's pyramid — tens of thousands of tiles — so the absence of the read
		// is the claim, and no assertion about the numbers could carry it.
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif');
		await seedReferencedMap(store, 'bbb2', 'Plan de Paris');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		const read = vi.spyOn(store, 'read');

		const maps = await listWorkspaceMapImages(store);

		// Not "nothing is read": the Projects' documents are how used-by is answered, and one small
		// record per map is how it is named. What must never be opened is the pyramid — a tile or the
		// `info.json` that describes it.
		expect(read.mock.calls.map(([path]) => path).sort()).toEqual(
			[
				'amsterdam-1625/project.json',
				// The `info.json`, for the picture the hub shows beside the name (ADR-0030): the pyramid's
				// *description*, which is three numbers, and never one of the tiles it describes. Extended
				// rather than loosened to a subset match — this list is the claim, and a subset match would
				// go on passing over a version of this that opened a tile.
				imageInfoPath('aaa1'),
				imageManifestPath('aaa1'),
				referencedImagePath('bbb2')
			].sort()
		);
		// And it did weigh them, so this is not passing because nothing happened.
		expect(maps.every((map) => map.bytes > 0)).toBe(true);
	});

	it('ignores an image directory that is neither: a half-written ingest is not a Map Image', async () => {
		const store = new MemoryProjectStore();
		await store.write('images/half/0,0,256,256/256,256/0/default.jpg', bytes(4096));

		expect(await listWorkspaceMapImages(store)).toEqual([]);
	});
});

/**
 * ADR-0030: the picture beside each name is the single tile at the coarsest level of the pyramid the
 * map already has. Nothing is generated, so the whole of the resolver is string building over three
 * numbers read out of a stored `info.json` — which is why it is asserted here and not in a browser.
 *
 * The 1200 × 851 sheet is the ADR's own worked example: its coarsest level is scale factor 8, so the
 * whole sheet is one 150 × 107 tile.
 */
describe('a Map Image’s thumbnail', () => {
	/** A Workspace-held map whose `info.json` really carries geometry, and its manifest. */
	async function seedPyramid(
		store: MemoryProjectStore,
		imageId: string,
		geometry: { width: number; height: number; tileSize?: number },
		stampedId?: string
	): Promise<void> {
		const document = buildImageInfo({ imageId, ...geometry });
		await store.write(
			imageInfoPath(imageId),
			serialiseJson(stampedId === undefined ? document : { ...document, id: stampedId })
		);
		await store.write(
			imageManifestPath(imageId),
			serialiseJson(buildImageManifest({ imageId, label: imageId, info: document }))
		);
		await store.write(tilePath(imageId), bytes(4096));
	}

	const thumbnailOf = async (store: MemoryProjectStore, imageId: string) =>
		(await listWorkspaceMapImages(store)).find((map) => map.imageId === imageId)?.thumbnail;

	it('is the coarsest tile of a Workspace-held map’s own pyramid', async () => {
		const store = new MemoryProjectStore();
		await seedPyramid(store, 'aaa1', { width: 1200, height: 851 });

		expect(await thumbnailOf(store, 'aaa1')).toBe(
			'https://unset.invalid/aaa1/0,0,1200,851/150,107/0/default.jpg'
		);
	});

	it('is at the scale factor the declared tile side makes coarsest, not this build’s own', async () => {
		// The same sheet on 512-pixel tiles fits in one tile a level sooner, so its whole-sheet
		// derivative is 300 × 213. A resolver that defaulted the tile side to 256 would name
		// `150,107` — a tile that pyramid does not contain — and the card would show a broken box.
		const store = new MemoryProjectStore();
		await seedPyramid(store, 'aaa1', { width: 1200, height: 851, tileSize: 512 });

		expect(await thumbnailOf(store, 'aaa1')).toBe(
			'https://unset.invalid/aaa1/0,0,1200,851/300,213/0/default.jpg'
		);
	});

	it('is on the placeholder host even when the info.json carries a stamped address', async () => {
		// ⚠ The reason only geometry is taken from the document. After an opt-in canonical stamp `id`
		// holds the stamped address, which the ADR-0011 shim does not route — so a URL built on it
		// would send the editor to the internet for a picture of a file it is already holding, working
		// or broken according to whether the site happens to be live.
		const store = new MemoryProjectStore();
		await seedPyramid(
			store,
			'aaa1',
			{ width: 1200, height: 851 },
			'https://example.test/atlas/aaa1'
		);

		expect(await thumbnailOf(store, 'aaa1')).toBe(
			'https://unset.invalid/aaa1/0,0,1200,851/150,107/0/default.jpg'
		);
	});

	it('is the coarsest tile on the Library’s own server for a referenced map', async () => {
		// One derivation for both tile locations, with two sources for its three inputs (ADR-0030): the
		// sheet is 4000 × 3000 on 256-pixel tiles, so the scale factors run 1, 2, 4, 8, 16 and the whole
		// sheet is one 250 × 188 tile. **Nothing is downloaded to make this**: it is a URL on the Library's
		// server, and the add-time probe has already established that this exact tile is served.
		const store = new MemoryProjectStore();
		await seedReferencedMap(
			store,
			'bbb2',
			'Plan de Paris',
			'https://iiif.bnf.example/iiif/3/btv1b'
		);

		expect(await thumbnailOf(store, 'bbb2')).toBe(
			'https://iiif.bnf.example/iiif/3/btv1b/0,0,4000,3000/250,188/0/default.jpg'
		);
	});

	it('is at the scale factor the Library’s declared tile side makes coarsest', async () => {
		// The same sheet on 512-pixel tiles fits in one tile a level sooner — coarsest factor 8, so
		// 500 × 375. This is the reason `remote.json` records the tile side at all: a resolver that assumed
		// this app's own 256 would name `250,188`, an address that service has no tile at, and the card
		// would show a broken box instead of an honest glyph.
		const store = new MemoryProjectStore();
		await seedReferencedMap(
			store,
			'bbb2',
			'Plan de Paris',
			'https://iiif.bnf.example/iiif/3/btv1b',
			512
		);

		expect(await thumbnailOf(store, 'bbb2')).toBe(
			'https://iiif.bnf.example/iiif/3/btv1b/0,0,4000,3000/500,375/0/default.jpg'
		);
	});

	it('is on the canonical spelling of the service, however the record spells it', async () => {
		// Written raw rather than through `seedReferencedMap`, because that helper builds the record with
		// `referencedImage()`, which canonicalises the address *before* the bytes are written — so a record
		// seeded through it is byte-identical to the canonical case and this test would assert nothing.
		// `parseReferencedImage` is what has to cope, and the trailing slash reaches it only from disk.
		// Trimming slashes in the resolver would be a second answer to how a service is spelled, which is
		// the defect `imagePaneSourceFor` exists to prevent for the tile base and the `info.json` URL.
		const store = new MemoryProjectStore();
		await store.write(
			referencedImagePath('bbb2'),
			serialiseJson({
				service: 'https://iiif.bnf.example/iiif/3/btv1b/',
				label: 'Plan de Paris',
				width: 4000,
				height: 3000,
				tileSize: 256
			})
		);

		expect(await thumbnailOf(store, 'bbb2')).toBe(
			'https://iiif.bnf.example/iiif/3/btv1b/0,0,4000,3000/250,188/0/default.jpg'
		);
	});

	it.each([
		['no tileSize, as a record written before the field existed', { width: 4000, height: 3000 }],
		['no dimensions', { tileSize: 256 }]
	])('is nothing at all for a referenced map whose record carries %s', async (_what, geometry) => {
		// **Never a guessed 256** (ADR-0030). Absent geometry means the glyph: a Library on 512-pixel tiles
		// would get a URL at the wrong scale factor, and a broken box claims a failure where an honest
		// blank says only that the picture is not available. Re-adding the map is the whole remedy, and
		// nothing fetches `info.json` on open to repair the record.
		const store = new MemoryProjectStore();
		await store.write(
			referencedImagePath('bbb2'),
			serialiseJson({ service: 'https://iiif.bnf.example/iiif/3/btv1b', ...geometry })
		);

		const maps = await listWorkspaceMapImages(store);

		// Still listed, and still with its Library named: this is the reclaim list.
		expect(maps.map((map) => map.imageId)).toEqual(['bbb2']);
		expect(maps[0]?.library).toBe('iiif.bnf.example');
		expect(maps[0]?.thumbnail).toBeNull();
	});

	it('is nothing at all for a referenced map whose record will not parse', async () => {
		const store = new MemoryProjectStore();
		await store.write(referencedImagePath('bbb2'), new TextEncoder().encode('{ not json'));

		expect(await thumbnailOf(store, 'bbb2')).toBeNull();
	});

	it('is the Workspace’s own tile once an Offline Copy has been made, though the citation stays', async () => {
		// The picture follows `tileLocation`, so completing an Offline Copy switches the source from the
		// Library to the Workspace with no code that knows it happened.
		const store = new MemoryProjectStore();
		await seedPyramid(store, 'ccc3', { width: 1200, height: 851 });
		await seedReferencedMap(store, 'ccc3', 'Copied');

		expect(await thumbnailOf(store, 'ccc3')).toBe(
			'https://unset.invalid/ccc3/0,0,1200,851/150,107/0/default.jpg'
		);
	});

	it('is nothing when the info.json will not yield geometry, and the map is still listed', async () => {
		// `null` is the only failure representation there is: no error field, no reason string. What the
		// user must not lose is the map — this is the reclaim list, and a map whose records are damaged is
		// one they most need to be able to see and delete.
		const store = new MemoryProjectStore();
		await store.write(imageInfoPath('aaa1'), new TextEncoder().encode('{ not json'));
		await store.write(imageInfoPath('bbb2'), serialiseJson({ id: 'https://unset.invalid/bbb2' }));

		const maps = await listWorkspaceMapImages(store);

		expect(maps.map((map) => map.imageId)).toEqual(['aaa1', 'bbb2']);
		expect(maps.map((map) => map.thumbnail)).toEqual([null, null]);
	});
});

describe('mapImageUsage', () => {
	it('skips a Project whose document will not parse rather than failing the list', async () => {
		const store = new MemoryProjectStore();
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await store.write('broken/project.json', new TextEncoder().encode('{ not json'));

		const usage = await mapImageUsage(store);

		expect([...usage.byMap]).toEqual([
			['aaa1', [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }]]
		]);
		// A corrupt file is not a Project from the future: nothing can be said about its Layers because
		// there is nothing there to read, so it stays skipped in silence.
		expect(usage.fromANewerVersion).toEqual([]);
	});

	it('ignores Layers that are not maps', async () => {
		const store = new MemoryProjectStore();
		const file = newProjectFile('Amsterdam 1625', new Date('2026-01-02T03:04:05.000Z'));
		await store.write(
			projectFilePath('amsterdam-1625'),
			serialiseProjectFile({
				...file,
				layers: [newAnnotationLayer({ id: 'notes', name: 'Notes' })]
			})
		);

		expect((await mapImageUsage(store)).byMap.size).toBe(0);
	});

	it('reports a Project from a newer version rather than skipping it', async () => {
		const store = new MemoryProjectStore();
		await seedFutureProject(store, 'from-the-future');

		const usage = await mapImageUsage(store);

		expect(usage.byMap.size).toBe(0);
		// Named by its directory, exactly as `listProjects` names the same Project on the hub.
		expect(usage.fromANewerVersion).toEqual([
			{ directory: 'from-the-future', name: 'from-the-future' }
		]);
	});
});

/**
 * A Project this build cannot read but which is emphatically not damaged (ADR-0010).
 *
 * `formatVersion: 2` is refused by `parseProjectFile` *because the file is intact*, refusal being
 * wanted rather than partial loading. Its Layer stack is right there and certainly names Map Images;
 * this build simply cannot say which.
 */
async function seedFutureProject(store: MemoryProjectStore, directory: string): Promise<void> {
	await store.write(
		projectFilePath(directory),
		new TextEncoder().encode(
			JSON.stringify({
				formatVersion: 2,
				name: 'Tomorrow',
				updatedAt: '2027-01-02T03:04:05.000Z',
				layers: [{ kind: 'something-new' }]
			})
		)
	);
}

// The whole of this describe is one defect: a Map Image drawn only by a Project from a newer
// build was reported as "No Project uses this map" and offered for deletion, on the same hub that had
// just said that Project could not be opened. Swallowing every parse failure alike is what did it.
describe('a Map Image whose only user is a Project from a newer version', () => {
	it('is not reported as unused, and names the Project that cannot be read', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Might be in use', 100_000);
		await seedFutureProject(store, 'from-the-future');

		const [map] = await listWorkspaceMapImages(store);

		expect(map?.usedBy).toEqual([]);
		expect(map?.mightBeUsedBy).toEqual([{ directory: 'from-the-future', name: 'from-the-future' }]);
	});

	it('is refused deletion, and the pyramid survives', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Might be in use', 100_000);
		await seedAlignmentFixture(store, 'aaa1', 120);
		await seedFutureProject(store, 'from-the-future');
		const before = [...store.snapshot().keys()];

		const refusal = await deleteMapImage(store, 'aaa1', { label: 'Might be in use' }).catch(
			(cause: unknown) => cause
		);

		expect(refusal).toBeInstanceOf(MapImageInUseError);
		expect((refusal as MapImageInUseError).message).toContain('from-the-future');
		expect((refusal as MapImageInUseError).message).toContain('newer version of Ballastella');
		// The claim that must not pass vacuously: the tiles and the Alignment are still on disk. A
		// refusal that deleted anyway would satisfy the two assertions above it.
		expect([...store.snapshot().keys()]).toEqual(before);
	});

	it('is not counted in the weight of maps no Project uses', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Might be in use', 500_000);
		await seedFutureProject(store, 'from-the-future');

		// The hosting warning would otherwise invite the user to reclaim half a gigabyte that a Project
		// they cannot open today is drawing.
		expect(await unusedMapImageBytes(store)).toEqual({ bytes: 0, maps: 0 });
	});

	it('still lets a map a readable Project has stopped using be deleted, when nothing is unreadable', async () => {
		// The other side of the rule: this is not "any parse failure freezes the Workspace". A corrupt
		// document is still skipped, so a map only it might have used is still deletable.
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Going', 100_000);
		await store.write('broken/project.json', new TextEncoder().encode('{ not json'));

		await deleteMapImage(store, 'aaa1');

		expect(await listWorkspaceMapImages(store)).toEqual([]);
	});
});

describe('referencedMapImages', () => {
	it('is the maps whose tiles are on somebody else’s server, and only those', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Mine');
		await seedReferencedMap(store, 'bbb2', 'Theirs');
		// Copied: a copy was made and the citation stayed.
		await seedLocalMap(store, 'ccc3', 'Copied');
		await seedReferencedMap(store, 'ccc3', 'Copied');

		expect([...(await referencedMapImages(store))]).toEqual(['bbb2']);
	});
});

describe('deleting a Map Image', () => {
	it('is refused when two Projects use it, and the refusal names both', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Shared map');
		await seedAlignmentFixture(store, 'aaa1', 120);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['aaa1']);
		const before = [...store.snapshot().keys()];

		const refusal = await deleteMapImage(store, 'aaa1').catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(MapImageInUseError);
		expect((refusal as MapImageInUseError).message).toContain('Amsterdam 1625');
		expect((refusal as MapImageInUseError).message).toContain('Boston 1775');
		expect((refusal as MapImageInUseError).projects.map((p) => p.directory)).toEqual([
			'amsterdam-1625',
			'boston-1775'
		]);
		// The claim that must not pass vacuously: the pyramid is still on disk, not merely that a
		// sentence appeared. A refusal that had already deleted half the tiles would satisfy every
		// assertion above it.
		expect([...store.snapshot().keys()]).toEqual(before);
	});

	it('removes the pyramid, the remote.json, and the Alignment, and nothing else', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Going');
		await seedReferencedMap(store, 'aaa1', 'Going');
		await seedAlignmentFixture(store, 'aaa1', 120);
		await seedLocalMap(store, 'bbb2', 'Staying');
		await seedAlignmentFixture(store, 'bbb2', 120);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['bbb2']);

		await deleteMapImage(store, 'aaa1');

		expect([...store.snapshot().keys()].sort()).toEqual(
			[
				'boston-1775/project.json',
				alignmentPath('bbb2'),
				imageInfoPath('bbb2'),
				imageManifestPath('bbb2'),
				tilePath('bbb2')
			].sort()
		);
	});

	it('is allowed once the last Project that used it has stopped', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Was used');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', []);

		await deleteMapImage(store, 'aaa1');

		expect(await listWorkspaceMapImages(store)).toEqual([]);
	});

	// A `delete` can refuse anywhere in the sequence — a lock, a folder grant revoked mid-way, a disk
	// that filled while a temporary file was open. What that must not produce is a Workspace holding
	// tiles no listing mentions and no total explains, under a message saying nothing happened.
	describe('when the Workspace refuses partway through', () => {
		/** Fail on the nth `delete`, counting from one, and succeed on the others. */
		const refuseOn = (store: MemoryProjectStore, nth: number) => {
			let seen = 0;
			return vi.spyOn(store, 'delete').mockImplementation(async function (this: void, path) {
				seen += 1;
				if (seen === nth) throw new Error('The Workspace is locked');
				return MemoryProjectStore.prototype.delete.call(store, path);
			});
		};

		it('leaves the map listed, so the next render explains the leftover rather than hiding it', async () => {
			const store = new MemoryProjectStore();
			await seedLocalMap(store, 'aaa1', 'Half gone', 40_000);
			await seedAlignmentFixture(store, 'aaa1', 120);
			// The third delete: the Alignment and one file have gone, and `info.json` has not — which is
			// the ordering claim. Written last by the ingest, deleted last here.
			refuseOn(store, 3);

			const failure = await deleteMapImage(store, 'aaa1', { label: 'Half gone' }).catch(
				(cause: unknown) => cause
			);

			expect(failure).toBeInstanceOf(MapImagePartlyDeletedError);
			expect((failure as Error).message).toContain('only partly deleted');
			expect((failure as Error).message).toContain('The Workspace is locked');
			// The claim that must not pass vacuously: the map is still *listed*, holding the bytes it
			// still holds. Deleting `info.json` first would have left the same tiles on disk with nothing
			// in the Workspace admitting they exist.
			const listed = await listWorkspaceMapImages(store);
			expect(listed.map((map) => map.imageId)).toEqual(['aaa1']);
			expect(listed[0]?.bytes).toBeGreaterThan(0);
		});

		it('takes the Alignment first, so no orphan placement can outlive the map', async () => {
			const store = new MemoryProjectStore();
			await seedLocalMap(store, 'aaa1', 'Half gone', 40_000);
			await seedAlignmentFixture(store, 'aaa1', 120);
			refuseOn(store, 3);

			await deleteMapImage(store, 'aaa1').catch(() => undefined);

			// `alignments/<id>.json` is what a later import deduplicates against, so a leftover would make
			// a colleague's copy of this map arrive without its own placement.
			expect([...store.snapshot().keys()]).not.toContain(alignmentPath('aaa1'));
		});

		it('reports the failure as itself when nothing was removed', async () => {
			const store = new MemoryProjectStore();
			await seedLocalMap(store, 'aaa1', 'Untouched', 40_000);
			await seedAlignmentFixture(store, 'aaa1', 120);
			const before = [...store.snapshot().keys()];
			refuseOn(store, 1);

			const failure = await deleteMapImage(store, 'aaa1', { label: 'Untouched' }).catch(
				(cause: unknown) => cause
			);

			// No half state to describe, so "partly deleted" would be its own false story.
			expect(failure).not.toBeInstanceOf(MapImagePartlyDeletedError);
			expect((failure as Error).message).toBe('The Workspace is locked');
			expect([...store.snapshot().keys()]).toEqual(before);
		});

		/**
		 * ⚠ **The exit that falsified the caller's rule.** The abandoned-write
		 * sweep used to run **after** every file had been deleted, so a rejection from it left the map
		 * entirely gone and threw something that is neither {@link MapImageInUseError} nor
		 * {@link MapImagePartlyDeletedError} — and `EditorSession.deleteMapImage` sweeps its
		 * journal on exactly that discrimination, so the map's journalled bytes survived a map that
		 * did not. Wrapping it in a `PartlyDeleted` would have been the opposite lie: that error tells
		 * the user the map "is still listed and deleting it again will finish the job".
		 *
		 * Swept first instead. Nothing has been removed when it runs, so a rejection is the plain
		 * failure it looks like — and no `delete` below it can create a temporary file for it to have
		 * missed.
		 */
		it('sweeps the abandoned writes before it deletes, so a failed sweep removes nothing', async () => {
			const store = new MemoryProjectStore();
			await seedLocalMap(store, 'aaa1', 'Untouched', 40_000);
			await seedAlignmentFixture(store, 'aaa1', 120);
			const before = [...store.snapshot().keys()];
			vi.spyOn(store, 'reclaimAbandonedWrites').mockRejectedValue(
				new Error('The folder grant was revoked')
			);

			const failure = await deleteMapImage(store, 'aaa1', { label: 'Untouched' }).catch(
				(cause: unknown) => cause
			);

			expect(failure).not.toBeInstanceOf(MapImagePartlyDeletedError);
			expect((failure as Error).message).toBe('The folder grant was revoked');
			expect([...store.snapshot().keys()]).toEqual(before);
		});

		/**
		 * And the sweep really happens, taking with it the half-finished writes `list` cannot report
		 * and `delete` cannot be handed. Without it a "deleted" map's directory survives on disk
		 * holding bytes that are missing from every total the reclaim list exists to explain — and in
		 * a real folder, a stray dotfile `git add -A` commits.
		 */
		it('takes the map’s abandoned writes with it', async () => {
			const store = new MemoryProjectStore();
			await seedLocalMap(store, 'aaa1', 'Doomed', 40_000);
			store.plant(
				`${imageDirectory('aaa1')}/.info.json.abandoned${TEMP_PATH_SUFFIX}`,
				new TextEncoder().encode('half a document')
			);

			await deleteMapImage(store, 'aaa1');

			expect([...store.snapshot().keys()]).toEqual([]);
		});
	});
});

describe('unusedMapImages', () => {
	// One definition of the ticket's headline figure. The hub used to reduce this itself, so the
	// reclaim list and the hosting warning were two answers to one question.
	const map = (imageId: string, bytes: number, users: number, unreadable = 0) => ({
		imageId,
		bytes,
		usedBy: Array.from({ length: users }, (_, i) => ({ directory: `p${i}`, name: `P${i}` })),
		mightBeUsedBy: Array.from({ length: unreadable }, () => ({
			directory: 'from-the-future',
			name: 'from-the-future'
		}))
	});

	it('is the maps nothing draws, and what they weigh together', () => {
		const unused = unusedMapImages([map('aaa1', 100, 1), map('bbb2', 500, 0)]);

		expect(unused.maps.map((entry) => entry.imageId)).toEqual(['bbb2']);
		expect(unused.bytes).toBe(500);
	});

	it('counts a map a Project this build cannot read might draw as used', () => {
		expect(unusedMapImages([map('aaa1', 500, 0, 1)])).toEqual({ maps: [], bytes: 0 });
	});
});

describe('unusedMapImageBytes', () => {
	it('weighs the maps no Project uses, and only those', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Used', 100_000);
		await seedLocalMap(store, 'bbb2', 'Unused', 500_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);

		const unused = await unusedMapImageBytes(store);

		expect(unused.maps).toBe(1);
		expect(unused.bytes).toBeGreaterThan(500_000);
		expect(unused.bytes).toBeLessThan(502_000);
	});

	it('is zero when every map is in use', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Used', 100_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);

		expect(await unusedMapImageBytes(store)).toEqual({ bytes: 0, maps: 0 });
	});

	it('opens nothing but the Projects’ own documents', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Unused', 100_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', []);
		const read = vi.spyOn(store, 'read');

		await unusedMapImageBytes(store);

		expect(read.mock.calls.map(([path]) => path)).toEqual(['amsterdam-1625/project.json']);
	});
});

describe('partitionByOfflineCopy', () => {
	// Moved here from `referenced-image.ts` so that it and `referencedMapImages` answer through
	// one rule rather than two. Its behaviour is unchanged, and `referenced-image.test.ts` still
	// asserts it end to end from the records on disk.
	const record = (imageId: string) =>
		referencedImage({
			imageId,
			service: 'https://iiif.library.example/iiif/3/plan',
			width: 100,
			height: 100,
			tileSize: 256
		});

	it('calls an image with a pyramid of ours copied, and one without referenced', () => {
		const split = partitionByOfflineCopy([record('aaa1'), record('bbb2')], [{ imageId: 'aaa1' }]);

		expect(split.offlineCopies.map((image) => image.imageId)).toEqual(['aaa1']);
		expect(split.referenced.map((image) => image.imageId)).toEqual(['bbb2']);
	});
});
