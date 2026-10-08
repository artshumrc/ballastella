import { describe, expect, it, vi } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { seedAlignmentFixture } from '../alignment/alignment-fixture.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX, serialiseJson, type Bytes } from '../store/project-store.js';
import {
	referencedImage,
	referencedImagePath,
	serialiseReferencedImage
} from '../remote-iiif/referenced-image.js';
import { encode, rejection } from '../test-support.js';
import { buildImageManifest } from '../tiler/image-manifest.js';
import { buildImageInfo } from '../tiler/pyramid.js';
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
import { newMapLayer, newAnnotationLayer, type Layer } from './layer.js';
import { newProjectFile, projectFilePath, serialiseProjectFile } from './project-file.js';

const bytes = (length: number): Bytes => new Uint8Array(length);
const BNF = 'https://iiif.bnf.example/iiif/3/btv1b';

const tilePath = (imageId: string): string =>
	`${imageDirectory(imageId)}/0,0,256,256/256,256/0/default.jpg`;

async function seedLocalMap(
	store: MemoryProjectStore,
	imageId: string,
	{
		label = imageId,
		tileBytes = 4096,
		width = 4000,
		height = 3000,
		tileSize,
		stampedId
	}: {
		label?: string;
		tileBytes?: number;
		width?: number;
		height?: number;
		tileSize?: number | undefined;
		stampedId?: string | undefined;
	} = {}
): Promise<MemoryProjectStore> {
	const info = buildImageInfo({ imageId, width, height, ...(tileSize && { tileSize }) });
	await store.write(
		imageInfoPath(imageId),
		serialiseJson(stampedId === undefined ? info : { ...info, id: stampedId })
	);
	await store.write(
		imageManifestPath(imageId),
		serialiseJson(buildImageManifest({ imageId, label, info }))
	);
	await store.write(tilePath(imageId), bytes(tileBytes));
	return store;
}

const seedReferencedMap = (
	store: MemoryProjectStore,
	imageId: string,
	fields: Partial<Parameters<typeof referencedImage>[0]> = {}
): Promise<void> =>
	store.write(
		referencedImagePath(imageId),
		serialiseReferencedImage(
			referencedImage({
				imageId,
				service: 'https://iiif.library.example/iiif/3/plan-1625',
				width: 4000,
				height: 3000,
				tileSize: 256,
				...fields
			})
		)
	);

const seedLayers = (
	store: MemoryProjectStore,
	directory: string,
	name: string,
	layers: readonly Layer[]
): Promise<void> =>
	store.write(
		projectFilePath(directory),
		serialiseProjectFile({
			...newProjectFile(name, new Date('2026-01-02T03:04:05.000Z')),
			layers
		})
	);

const seedProject = (
	store: MemoryProjectStore,
	directory: string,
	name: string,
	imageIds: readonly string[]
): Promise<void> =>
	seedLayers(
		store,
		directory,
		name,
		imageIds.map((imageId, index) => ({
			...newMapLayer({ id: `layer-${index}`, name: `${imageId} layer`, imageId }),
			order: index
		}))
	);

const seedFutureProject = (store: MemoryProjectStore, directory: string): Promise<void> =>
	store.write(
		projectFilePath(directory),
		encode(
			JSON.stringify({
				formatVersion: 2,
				name: 'Tomorrow',
				updatedAt: '2027-01-02T03:04:05.000Z',
				layers: [{ kind: 'something-new' }]
			})
		)
	);

const FUTURE = { directory: 'from-the-future', name: 'from-the-future' };
const AMSTERDAM = { directory: 'amsterdam-1625', name: 'Amsterdam 1625' };
const paths = (store: MemoryProjectStore): string[] => [...store.snapshot().keys()];

describe('where a Map Image’s tiles are', () => {
	it.each([
		[true, false, 'in-workspace'],
		[false, true, 'referenced'],
		[true, true, 'in-workspace'],
		[false, false, null]
	])('with info.json %s and remote.json %s is %s', (infoJson, remoteJson, where) => {
		expect(tileLocation({ infoJson, remoteJson })).toBe(where);
	});
});

describe('listWorkspaceMapImages', () => {
	it('lists every Map Image with its label, size, file count, and where its tiles are', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', { label: 'Amsterdam 1625.tif', tileBytes: 40_000 });
		await seedReferencedMap(store, 'bbb2', { label: 'Plan de Paris', service: BNF });

		const [local, referenced] = await listWorkspaceMapImages(store);
		expect(local).toMatchObject({
			imageId: 'aaa1',
			label: 'Amsterdam 1625.tif',
			files: 3,
			tiles: 'in-workspace',
			library: ''
		});
		expect(local?.bytes).toBeGreaterThan(40_000);
		expect(local?.bytes).toBeLessThan(42_000);
		expect(referenced).toMatchObject({
			imageId: 'bbb2',
			label: 'Plan de Paris',
			files: 1,
			tiles: 'referenced',
			library: 'iiif.bnf.example'
		});
	});

	it('keeps a referenced Map Image’s source and Canvas label as provenance', async () => {
		const store = new MemoryProjectStore();
		await seedReferencedMap(store, 'bbb2', {
			source: 'https://library.example/iiif/collection',
			label: 'Plan de Paris',
			partOf: 'https://library.example/iiif/manifest.json',
			canvas: 'https://library.example/iiif/canvas/1'
		});

		const [map] = await listWorkspaceMapImages(store);

		expect(map?.provenance).toEqual({
			source: 'https://library.example/iiif/collection',
			canvasLabel: 'Plan de Paris'
		});
	});

	it('counts the Alignment among the files deleting the map would take', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1');
		await seedAlignmentFixture(store, 'aaa1', 120);

		expect((await listWorkspaceMapImages(store))[0]?.files).toBe(4);
	});

	it('names the Projects that use each map, once each, and reports none when none do', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1');
		await seedLocalMap(store, 'ccc3');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1', 'aaa1']);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['aaa1']);

		const [shared, unused] = await listWorkspaceMapImages(store);

		expect(shared?.usedBy).toEqual([AMSTERDAM, { directory: 'boston-1775', name: 'Boston 1775' }]);
		expect(unused?.usedBy).toEqual([]);
	});

	it('opens no pyramid: the sizes come from ProjectStore#size', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1');
		await seedReferencedMap(store, 'bbb2');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		const read = vi.spyOn(store, 'read');
		const maps = await listWorkspaceMapImages(store);

		expect(read.mock.calls.map(([path]) => path).sort()).toEqual(
			[
				'amsterdam-1625/project.json',
				imageInfoPath('aaa1'),
				imageManifestPath('aaa1'),
				referencedImagePath('bbb2')
			].sort()
		);
		expect(maps.every((map) => map.bytes > 0)).toBe(true);
	});

	it('ignores an image directory that is neither: a half-written ingest is not a Map Image', async () => {
		const store = new MemoryProjectStore();
		await store.write('images/half/0,0,256,256/256,256/0/default.jpg', bytes(4096));

		expect(await listWorkspaceMapImages(store)).toEqual([]);
	});
});

describe('a Map Image’s thumbnail', () => {
	const thumbnailOf = async (store: MemoryProjectStore, imageId: string) =>
		(await listWorkspaceMapImages(store)).find((map) => map.imageId === imageId)?.thumbnail;
	const OWN = 'https://unset.invalid/aaa1/0,0,1200,851';

	it.each([
		['the coarsest tile of its own pyramid', undefined, undefined, '150,107'],
		['at the scale factor the declared tile side makes coarsest', 512, undefined, '300,213'],
		[
			'on the placeholder host despite a stamped address',
			undefined,
			'https://example.test/atlas/aaa1',
			'150,107'
		]
	])('of a Workspace-held map is %s', async (_case, tileSize, stampedId, size) => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1', {
			width: 1200,
			height: 851,
			tileSize,
			stampedId
		});

		expect(await thumbnailOf(store, 'aaa1')).toBe(`${OWN}/${size}/0/default.jpg`);
	});

	it.each([
		[256, '250,188'],
		[512, '500,375']
	])(
		'of a referenced map with tile side %d is the Library’s coarsest tile',
		async (tileSize, size) => {
			const store = new MemoryProjectStore();
			await seedReferencedMap(store, 'bbb2', { service: BNF, tileSize });

			expect(await thumbnailOf(store, 'bbb2')).toBe(`${BNF}/0,0,4000,3000/${size}/0/default.jpg`);
		}
	);

	it('is on the canonical spelling of the service, however the record spells it', async () => {
		const store = new MemoryProjectStore();
		await store.write(
			referencedImagePath('bbb2'),
			serialiseJson({ service: `${BNF}/`, width: 4000, height: 3000, tileSize: 256 })
		);

		expect(await thumbnailOf(store, 'bbb2')).toBe(`${BNF}/0,0,4000,3000/250,188/0/default.jpg`);
	});

	it.each([
		['no tileSize, as a record written before the field existed', { width: 4000, height: 3000 }],
		['no dimensions', { tileSize: 256 }]
	])('is nothing at all for a referenced map whose record carries %s', async (_what, geometry) => {
		const store = new MemoryProjectStore();
		await store.write(referencedImagePath('bbb2'), serialiseJson({ service: BNF, ...geometry }));

		const maps = await listWorkspaceMapImages(store);
		expect(maps).toMatchObject([{ imageId: 'bbb2', library: 'iiif.bnf.example', thumbnail: null }]);
	});

	it('is nothing at all for a referenced map whose record will not parse', async () => {
		const store = new MemoryProjectStore();
		await store.write(referencedImagePath('bbb2'), encode('{ not json'));

		expect(await thumbnailOf(store, 'bbb2')).toBeNull();
	});

	it('is the Workspace’s own tile once an Offline Copy has been made, though the citation stays', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1', {
			width: 1200,
			height: 851
		});
		await seedReferencedMap(store, 'aaa1');

		expect(await thumbnailOf(store, 'aaa1')).toBe(`${OWN}/150,107/0/default.jpg`);
	});

	it('is nothing when the info.json will not yield geometry, and the map is still listed', async () => {
		const store = new MemoryProjectStore();
		await store.write(imageInfoPath('aaa1'), encode('{ not json'));
		await store.write(imageInfoPath('bbb2'), serialiseJson({ id: 'https://unset.invalid/bbb2' }));

		const maps = await listWorkspaceMapImages(store);
		expect(maps.map((map) => [map.imageId, map.thumbnail])).toEqual([
			['aaa1', null],
			['bbb2', null]
		]);
	});
});

describe('mapImageUsage', () => {
	it('reports a Project from a newer version, and skips one that will not parse and Layers that are not maps', async () => {
		const store = new MemoryProjectStore();
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await seedLayers(store, 'notes-only', 'Notes', [
			newAnnotationLayer({ id: 'notes', name: 'Notes' })
		]);
		await store.write('broken/project.json', encode('{ not json'));
		await seedFutureProject(store, 'from-the-future');

		const usage = await mapImageUsage(store);

		expect([...usage.byMap]).toEqual([['aaa1', [AMSTERDAM]]]);
		expect(usage.fromANewerVersion).toEqual([FUTURE]);
	});
});

describe('a Map Image whose only user is a Project from a newer version', () => {
	it('is not reported as unused, names the Project that cannot be read, and is refused deletion', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1', { tileBytes: 100_000 });
		await seedAlignmentFixture(store, 'aaa1', 120);
		await seedFutureProject(store, 'from-the-future');
		const before = paths(store);

		const [map] = await listWorkspaceMapImages(store);
		expect([map?.usedBy, map?.mightBeUsedBy]).toEqual([[], [FUTURE]]);
		expect(await unusedMapImageBytes(store)).toEqual({ bytes: 0, maps: 0 });

		const { message } = await rejection(
			MapImageInUseError,
			deleteMapImage(store, 'aaa1', { label: 'Might be in use' })
		);
		expect(message).toContain('from-the-future');
		expect(message).toContain('newer version of Ballastella');
		expect(paths(store)).toEqual(before);
	});

	it('still lets a map a readable Project has stopped using be deleted, when nothing is unreadable', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1', { tileBytes: 100_000 });
		await store.write('broken/project.json', encode('{ not json'));

		await deleteMapImage(store, 'aaa1');

		expect(await listWorkspaceMapImages(store)).toEqual([]);
	});
});

describe('referencedMapImages', () => {
	it('is the maps whose tiles are on somebody else’s server, and only those', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1');
		await seedReferencedMap(store, 'bbb2');
		await seedLocalMap(store, 'ccc3');
		await seedReferencedMap(store, 'ccc3');

		expect([...(await referencedMapImages(store))]).toEqual(['bbb2']);
	});
});

describe('deleting a Map Image', () => {
	it('is refused when two Projects use it, and the refusal names both', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1');
		await seedAlignmentFixture(store, 'aaa1', 120);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['aaa1']);
		const before = paths(store);
		const refusal = await rejection(MapImageInUseError, deleteMapImage(store, 'aaa1'));
		expect(refusal.message).toContain('Amsterdam 1625');
		expect(refusal.message).toContain('Boston 1775');
		expect(refusal.projects.map((p) => p.directory)).toEqual(['amsterdam-1625', 'boston-1775']);
		expect(paths(store)).toEqual(before);
	});

	it('removes the pyramid, the remote.json, and the Alignment, and nothing else', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1');
		await seedReferencedMap(store, 'aaa1');
		await seedAlignmentFixture(store, 'aaa1', 120);
		await seedLocalMap(store, 'bbb2');
		await seedAlignmentFixture(store, 'bbb2', 120);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['bbb2']);

		await deleteMapImage(store, 'aaa1');

		expect(paths(store).sort()).toEqual(
			[
				'boston-1775/project.json',
				alignmentPath('bbb2'),
				imageInfoPath('bbb2'),
				imageManifestPath('bbb2'),
				tilePath('bbb2')
			].sort()
		);
	});

	it('is allowed once the last Project that used it has stopped, and takes its abandoned writes', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1', { tileBytes: 40_000 });
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', []);
		store.plant(
			`${imageDirectory('aaa1')}/.info.json.abandoned${TEMP_PATH_SUFFIX}`,
			encode('half a document')
		);

		await deleteMapImage(store, 'aaa1');

		expect(paths(store)).toEqual(['amsterdam-1625/project.json']);
	});

	describe('when the Workspace refuses partway through', () => {
		const seededMap = async () => {
			const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1', { tileBytes: 40_000 });
			await seedAlignmentFixture(store, 'aaa1', 120);
			return store;
		};

		const refuseOn = (store: MemoryProjectStore, nth: number) => {
			let seen = 0;
			vi.spyOn(store, 'delete').mockImplementation(async function (this: void, path) {
				seen += 1;
				if (seen === nth) throw new Error('The Workspace is locked');
				return MemoryProjectStore.prototype.delete.call(store, path);
			});
		};

		it('takes the Alignment first and leaves the map listed, so the leftover is explained', async () => {
			const store = await seededMap();
			refuseOn(store, 3);

			const { message } = await rejection(
				MapImagePartlyDeletedError,
				deleteMapImage(store, 'aaa1', { label: 'Half gone' })
			);

			expect(message).toContain('only partly deleted');
			expect(message).toContain('The Workspace is locked');
			expect(paths(store)).not.toContain(alignmentPath('aaa1'));
			const listed = await listWorkspaceMapImages(store);
			expect(listed.map((map) => map.imageId)).toEqual(['aaa1']);
			expect(listed[0]?.bytes).toBeGreaterThan(0);
		});

		it.each([
			['a delete', 'The Workspace is locked', (store: MemoryProjectStore) => refuseOn(store, 1)],
			[
				'the sweep of abandoned writes',
				'The folder grant was revoked',
				(store: MemoryProjectStore) => {
					vi.spyOn(store, 'reclaimAbandonedWrites').mockRejectedValue(
						new Error('The folder grant was revoked')
					);
				}
			]
		])(
			'reports the failure as itself when %s fails before anything is removed',
			async (_case, text, fail) => {
				const store = await seededMap();
				const before = paths(store);
				fail(store);

				const failure = await rejection(
					Error,
					deleteMapImage(store, 'aaa1', { label: 'Untouched' })
				);

				expect(failure).not.toBeInstanceOf(MapImagePartlyDeletedError);
				expect(failure.message).toBe(text);
				expect(paths(store)).toEqual(before);
			}
		);
	});
});

describe('unusedMapImages', () => {
	const map = (imageId: string, bytes: number, users: number, unreadable = 0) => ({
		imageId,
		bytes,
		usedBy: Array.from({ length: users }, (_, i) => ({ directory: `p${i}`, name: `P${i}` })),
		mightBeUsedBy: Array.from({ length: unreadable }, () => FUTURE)
	});

	it('is the maps nothing draws, and what they weigh together, counting a possible draw as used', () => {
		const unused = unusedMapImages([map('aaa1', 100, 1), map('bbb2', 500, 0)]);
		expect([unused.maps.map((entry) => entry.imageId), unused.bytes]).toEqual([['bbb2'], 500]);
		expect(unusedMapImages([map('aaa1', 500, 0, 1)])).toEqual({ maps: [], bytes: 0 });
	});
});

describe('unusedMapImageBytes', () => {
	it('weighs the maps no Project uses, and only those, opening nothing but the Projects’ own documents', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1', { tileBytes: 100_000 });
		await seedLocalMap(store, 'bbb2', { tileBytes: 500_000 });
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		const read = vi.spyOn(store, 'read');

		const unused = await unusedMapImageBytes(store);
		expect(unused.maps).toBe(1);
		expect(unused.bytes).toBeGreaterThan(500_000);
		expect(unused.bytes).toBeLessThan(502_000);
		expect(read.mock.calls.map(([path]) => path)).toEqual(['amsterdam-1625/project.json']);
	});

	it('is zero when every map is in use', async () => {
		const store = await seedLocalMap(new MemoryProjectStore(), 'aaa1', { tileBytes: 100_000 });
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);

		expect(await unusedMapImageBytes(store)).toEqual({ bytes: 0, maps: 0 });
	});
});

describe('partitionByOfflineCopy', () => {
	it('calls an image with a pyramid of ours copied, and one without referenced', () => {
		const record = (imageId: string) =>
			referencedImage({
				imageId,
				service: 'https://iiif.library.example/iiif/3/plan',
				width: 100,
				height: 100,
				tileSize: 256
			});

		const split = partitionByOfflineCopy([record('aaa1'), record('bbb2')], [{ imageId: 'aaa1' }]);
		expect(split.offlineCopies.map((image) => image.imageId)).toEqual(['aaa1']);
		expect(split.referenced.map((image) => image.imageId)).toEqual(['bbb2']);
	});
});
