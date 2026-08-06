import { describe, expect, it, vi } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import {
	referencedImage,
	referencedImagePath,
	serialiseReferencedImage
} from '../remote-iiif/referenced-image.js';
import { buildImageManifest } from '../tiler/image-manifest.js';
import { buildImageInfo, serialiseJson } from '../tiler/pyramid.js';
import { imageDirectory, imageInfoPath, imageManifestPath } from './image-files.js';
import {
	HistoricalMapInUseError,
	deleteHistoricalMap,
	historicalMapUsage,
	listWorkspaceHistoricalMaps,
	partitionByLocalCopy,
	referencedHistoricalMaps,
	tileLocation,
	unusedHistoricalMapBytes
} from './historical-maps.js';
import { newMapLayer, newAnnotationLayer } from './layer.js';
import { newProjectFile, projectFilePath, serialiseProjectFile } from './project-file.js';

// SPEC's Seam 1. "Which Historical Maps does this Workspace hold, who uses them, and what happens
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

/** A Historical Map whose tiles are on a Library's server: a `remote.json` and nothing else. */
async function seedReferencedMap(
	store: MemoryProjectStore,
	imageId: string,
	label: string,
	service = 'https://iiif.library.example/iiif/3/plan-1625'
): Promise<void> {
	await store.write(
		referencedImagePath(imageId),
		serialiseReferencedImage(
			referencedImage({ imageId, service, label, width: 4000, height: 3000 })
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

describe('where a Historical Map’s tiles are', () => {
	// ADR-0023's rule, and this is now its only implementation. It used to have five: `publish.ts`,
	// `partitionByLocalCopy`, the viewer's 404 probe, and a derived set in each app's page. The rule
	// itself is what they disagreed about most cheaply, so it is the thing that got one home.
	it('is this Workspace when an info.json of ours is beside it', () => {
		expect(tileLocation({ infoJson: true, remoteJson: false })).toBe('in-workspace');
	});

	it('is a Library’s server when only a remote.json is', () => {
		expect(tileLocation({ infoJson: false, remoteJson: true })).toBe('referenced');
	});

	it('is this Workspace once a copy has been made, though the citation stays', () => {
		// A mirrored map keeps its `remote.json` — that record is the citation ADR-0007 protects — so
		// "both" is the offline copy, not an ambiguity. Reading it the other way is what made publishing
		// warn about a network dependency the Workspace no longer had.
		expect(tileLocation({ infoJson: true, remoteJson: true })).toBe('in-workspace');
	});

	it('is nothing at all for a directory holding neither', () => {
		// The tiles of an interrupted ingest. `info.json` is written last precisely so this is not yet a
		// Historical Map, and nothing may list it, delete it, or count it.
		expect(tileLocation({ infoJson: false, remoteJson: false })).toBeNull();
	});
});

describe('listWorkspaceHistoricalMaps', () => {
	it('lists every Historical Map in the Workspace with its label and its size', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif', 40_000);
		await seedReferencedMap(store, 'bbb2', 'Plan de Paris');

		const maps = await listWorkspaceHistoricalMaps(store);

		expect(maps.map((map) => map.imageId)).toEqual(['aaa1', 'bbb2']);
		expect(maps[0]?.label).toBe('Amsterdam 1625.tif');
		expect(maps[1]?.label).toBe('Plan de Paris');
		// info.json + manifest + tile, and nothing from any other map.
		expect(maps[0]?.bytes).toBeGreaterThan(40_000);
		expect(maps[0]?.bytes).toBeLessThan(42_000);
	});

	it('says whether the tiles are in this Workspace or names the host they are on', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif');
		await seedReferencedMap(
			store,
			'bbb2',
			'Plan de Paris',
			'https://iiif.bnf.example/iiif/3/btv1b'
		);

		const maps = await listWorkspaceHistoricalMaps(store);

		expect(maps[0]).toMatchObject({ tiles: 'in-workspace', host: '' });
		expect(maps[1]).toMatchObject({ tiles: 'referenced', host: 'iiif.bnf.example' });
	});

	it('names the Projects that use each map, and reports none when none do', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Shared map');
		await seedLocalMap(store, 'ccc3', 'Nobody’s map');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['aaa1']);

		const maps = await listWorkspaceHistoricalMaps(store);
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

		const [map] = await listWorkspaceHistoricalMaps(store);

		expect(map?.usedBy).toEqual([{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }]);
	});

	it('opens no pyramid: the sizes come from ProjectStore#size', async () => {
		// ADR-0001 put `size` in the interface for exactly this, and `workspace-size.ts` keeps the
		// discipline. A version of this written with `read` returns the same numbers and is unusable on a
		// Workspace holding a mirrored pyramid — tens of thousands of tiles — so the absence of the read
		// is the claim, and no assertion about the numbers could carry it.
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif');
		await seedReferencedMap(store, 'bbb2', 'Plan de Paris');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		const read = vi.spyOn(store, 'read');

		const maps = await listWorkspaceHistoricalMaps(store);

		// Not "nothing is read": the Projects' documents are how used-by is answered, and one small
		// record per map is how it is named. What must never be opened is the pyramid — a tile or the
		// `info.json` that describes it.
		expect(read.mock.calls.map(([path]) => path).sort()).toEqual([
			'amsterdam-1625/project.json',
			imageManifestPath('aaa1'),
			referencedImagePath('bbb2')
		]);
		// And it did weigh them, so this is not passing because nothing happened.
		expect(maps.every((map) => map.bytes > 0)).toBe(true);
	});

	it('ignores an image directory that is neither: a half-written ingest is not a Historical Map', async () => {
		const store = new MemoryProjectStore();
		await store.write('images/half/0,0,256,256/256,256/0/default.jpg', bytes(4096));

		expect(await listWorkspaceHistoricalMaps(store)).toEqual([]);
	});
});

describe('historicalMapUsage', () => {
	it('skips a Project whose document will not parse rather than failing the list', async () => {
		const store = new MemoryProjectStore();
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await store.write('broken/project.json', new TextEncoder().encode('{ not json'));

		expect([...(await historicalMapUsage(store))]).toEqual([
			['aaa1', [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }]]
		]);
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

		expect((await historicalMapUsage(store)).size).toBe(0);
	});
});

describe('referencedHistoricalMaps', () => {
	it('is the maps whose tiles are on somebody else’s server, and only those', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Mine');
		await seedReferencedMap(store, 'bbb2', 'Theirs');
		// Mirrored: a copy was made and the citation stayed.
		await seedLocalMap(store, 'ccc3', 'Copied');
		await seedReferencedMap(store, 'ccc3', 'Copied');

		expect([...(await referencedHistoricalMaps(store))]).toEqual(['bbb2']);
	});
});

describe('deleting a Historical Map', () => {
	it('is refused when two Projects use it, and the refusal names both', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Shared map');
		await store.write(alignmentPath('aaa1'), bytes(120));
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['aaa1']);
		const before = [...store.snapshot().keys()];

		const refusal = await deleteHistoricalMap(store, 'aaa1').catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(HistoricalMapInUseError);
		expect((refusal as HistoricalMapInUseError).message).toContain('Amsterdam 1625');
		expect((refusal as HistoricalMapInUseError).message).toContain('Boston 1775');
		expect((refusal as HistoricalMapInUseError).projects.map((p) => p.directory)).toEqual([
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
		await store.write(alignmentPath('aaa1'), bytes(120));
		await seedLocalMap(store, 'bbb2', 'Staying');
		await store.write(alignmentPath('bbb2'), bytes(120));
		await seedProject(store, 'boston-1775', 'Boston 1775', ['bbb2']);

		await deleteHistoricalMap(store, 'aaa1');

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

		await deleteHistoricalMap(store, 'aaa1');

		expect(await listWorkspaceHistoricalMaps(store)).toEqual([]);
	});
});

describe('unusedHistoricalMapBytes', () => {
	it('weighs the maps no Project uses, and only those', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Used', 100_000);
		await seedLocalMap(store, 'bbb2', 'Unused', 500_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);

		const unused = await unusedHistoricalMapBytes(store);

		expect(unused.maps).toBe(1);
		expect(unused.bytes).toBeGreaterThan(500_000);
		expect(unused.bytes).toBeLessThan(502_000);
	});

	it('is zero when every map is in use', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Used', 100_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);

		expect(await unusedHistoricalMapBytes(store)).toEqual({ bytes: 0, maps: 0 });
	});

	it('opens nothing but the Projects’ own documents', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Unused', 100_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', []);
		const read = vi.spyOn(store, 'read');

		await unusedHistoricalMapBytes(store);

		expect(read.mock.calls.map(([path]) => path)).toEqual(['amsterdam-1625/project.json']);
	});
});

describe('partitionByLocalCopy', () => {
	// Moved here from `referenced-image.ts` so that it and `referencedHistoricalMaps` answer through
	// one rule rather than two. Its behaviour is unchanged, and `referenced-image.test.ts` still
	// asserts it end to end from the records on disk.
	const record = (imageId: string) =>
		referencedImage({
			imageId,
			service: 'https://iiif.library.example/iiif/3/plan',
			width: 100,
			height: 100
		});

	it('calls an image with a pyramid of ours mirrored, and one without referenced', () => {
		const split = partitionByLocalCopy([record('aaa1'), record('bbb2')], [{ imageId: 'aaa1' }]);

		expect(split.mirrored.map((image) => image.imageId)).toEqual(['aaa1']);
		expect(split.referenced.map((image) => image.imageId)).toEqual(['bbb2']);
	});
});
