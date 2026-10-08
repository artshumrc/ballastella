import { Image } from '@allmaps/iiif-parser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { decode, encode, jpegHeader, rejection, stubTiler } from '../test-support.js';
import { MAX_INGEST_PIXELS } from './decode-ceiling.js';
import {
	ImageTooLargeError,
	UnreadableImageError,
	ingestImageFile,
	listIngestedImages,
	type IngestProgress
} from './ingest.js';
import { PYRAMID_TILE_SIZE, planPyramid } from './pyramid.js';

const imageFile = (width: number, height: number, name = 'scan.jpg') =>
	new File([jpegHeader(width, height) as BlobPart], name, { type: 'image/jpeg' });

let store: MemoryProjectStore;

beforeEach(() => {
	store = new MemoryProjectStore();
});

const ingest = (
	width: number,
	height: number,
	overrides: Partial<Parameters<typeof ingestImageFile>[0]> = {}
) =>
	ingestImageFile({
		store,
		file: imageFile(width, height),
		openDecodeAndCrop: stubTiler({ width, height }),
		...overrides
	});

const readJson = async (path: string) => JSON.parse(decode(await store.read(path)));

async function expectPlannedTiles(result: { infoPath: string; directory: string }) {
	const planned = planPyramid(await readJson(result.infoPath), result.directory);
	for (const tile of planned) {
		expect(await readJson(tile.path), tile.path).toEqual({
			region: tile.region,
			size: tile.size,
			scaleFactor: tile.scaleFactor
		});
	}
	return planned;
}

const failingTiler =
	(width: number, height: number, failAt: number, close = async () => undefined) =>
	async () => {
		let count = 0;
		return {
			dimensions: { width, height },
			encodeTile: async () => {
				if (++count === failAt) throw new Error('out of memory');
				return new Uint8Array([1]);
			},
			close
		};
	};

describe('ingestImageFile', () => {
	it('writes the planned tiles, an info.json and a labelled manifest.json, and nothing in any Project', async () => {
		await store.write('amsterdam-1625/project.json', encode('{"formatVersion":1}'));
		await store.write('boston-1775/project.json', encode('{"formatVersion":1}'));
		const name = 'Blaeu — Amsterdam, 1625.tif';
		const result = await ingest(1200, 851, { file: imageFile(1200, 851, name) });

		expect(result.tileCount).toBe(29);
		expect(result.width).toBe(1200);
		expect(result.directory).toBe(`images/${result.imageId}`);
		expect(result.infoPath).toBe(`images/${result.imageId}/info.json`);
		const paths = await store.list('images/');
		expect(paths).toHaveLength(31);
		expect(paths).toContain(result.manifestPath);
		expect((await store.list('')).filter((path) => !path.startsWith('images/'))).toEqual([
			'amsterdam-1625/project.json',
			'boston-1775/project.json'
		]);
		const info = await readJson(result.infoPath);
		const image = Image.parse(info);
		expect(image.tileZoomLevels.map((level) => level.scaleFactor)).toEqual([1, 2, 4, 8]);
		expect(info.id).toBe(`https://unset.invalid/${result.imageId}`);
		expect(await expectPlannedTiles(result)).toHaveLength(29);
		expect((await readJson(result.manifestPath)).label).toEqual({ none: [name] });
	});

	it('gives a 2 megapixel photograph a pyramid, not a shortcut', async () => {
		const result = await ingest(1632, 1224, { file: imageFile(1632, 1224, 'photo.jpg') });
		const info = await readJson(result.infoPath);
		expect(info.tiles[0].scaleFactors).toEqual([1, 2, 4, 8]);
		expect(result.tileCount).toBe(35 + 12 + 4 + 1);
		expect(info.tiles[0].width).toBe(PYRAMID_TILE_SIZE);
	});

	it('reports progress from inspecting to done, monotonically', async () => {
		const progress: IngestProgress[] = [];
		await ingest(600, 400, { onProgress: (update) => progress.push(update) });

		expect(progress[0]?.phase).toBe('inspecting');
		expect(progress.at(-1)?.phase).toBe('done');
		expect(progress.at(-1)?.fraction).toBe(1);
		expect(progress.map((update) => update.phase)).toContain('tiling');
		expect(progress.map((update) => update.phase)).toContain('finishing');
		const fractions = progress.map((update) => update.fraction);
		expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
		expect(Math.max(...fractions.slice(0, -1))).toBeLessThan(1);
		expect(progress.filter((update) => update.phase === 'tiling').length).toBe(
			progress.at(-1)!.tileCount + 1
		);
	});

	it('ingests an image between the old threshold and the ceiling, and cuts a real pyramid', async () => {
		expect(25_000 * 20_000).toBeGreaterThan(268_435_456);
		expect(25_000 * 20_000).toBeLessThan(MAX_INGEST_PIXELS);

		const result = await ingest(25_000, 20_000, {
			file: imageFile(25_000, 20_000, 'archival-master.jpg')
		});

		expect(result.width).toBe(25_000);
		expect(result.height).toBe(20_000);
		expect(await expectPlannedTiles(result)).toHaveLength(result.tileCount);
		expect(result.tileCount).toBeGreaterThan(1000);
	});

	it('refuses an image above the ceiling by naming its size and the remedy', async () => {
		const openDecodeAndCrop = vi.fn(stubTiler({ width: 30_000, height: 20_000 }));

		const failure = await rejection(
			ImageTooLargeError,
			ingest(30_000, 20_000, {
				file: imageFile(30_000, 20_000, 'archival-master.jpg'),
				openDecodeAndCrop
			})
		);

		expect(failure.message).toContain('600 megapixels');
		expect(failure.message).toContain('528 megapixel');
		expect(failure.message).toContain('IIIF pyramid outside the browser');
		expect(failure.message, 'the refusal blames the file instead of the size').not.toContain(
			'could not be read as an image'
		);

		for (const word of ['COOP', 'COEP', 'Cross-Origin', 'cross-origin', 'SharedArrayBuffer']) {
			expect(failure.message, word).not.toContain(word);
		}

		expect(openDecodeAndCrop).not.toHaveBeenCalled();
		expect(await store.list('')).toEqual([]);
	});

	it('admits an image of exactly the cap and refuses the next pixel', async () => {
		const at = await ingest(1000, 1000, { maxIngestPixels: 1_000_000 });
		expect(at.tileCount).toBeGreaterThan(0);

		await expect(ingest(1000, 1001, { maxIngestPixels: 1_000_000 })).rejects.toThrow(
			ImageTooLargeError
		);
	});

	it('says what is wrong when nothing can read the file', async () => {
		await expect(
			ingestImageFile({
				store,
				file: new File([new Uint8Array([1, 2, 3]) as BlobPart], 'notes.txt'),
				openDecodeAndCrop: async () => {
					throw new Error('The source image could not be decoded.');
				}
			})
		).rejects.toThrow(UnreadableImageError);

		expect(await store.list('')).toEqual([]);
	});

	it('blames the format, not the size, for a TIFF under the cap', async () => {
		expect(20_000 * 15_000).toBeLessThan(MAX_INGEST_PIXELS);

		const failure = await rejection(
			UnreadableImageError,
			ingest(20_000, 15_000, {
				file: imageFile(20_000, 15_000, 'master.tif'),
				openDecodeAndCrop: async () => {
					throw new Error('The source image could not be decoded.');
				}
			})
		);

		expect(failure.message).toContain('Browsers read JPEG');
		expect(failure.message).toContain('TIFF or JPEG 2000 archival master needs to be converted');
		expect(failure.message).not.toContain('megapixels');
	});

	it('writes info.json last, so its presence means the pyramid is complete', async () => {
		const order: string[] = [];
		const recording = new MemoryProjectStore();
		const write = recording.write.bind(recording);
		recording.write = async (path, bytes) => {
			order.push(path);
			return write(path, bytes);
		};

		const result = await ingest(600, 400, { store: recording });
		expect(order.at(-1)).toBe(result.infoPath);
		expect(order.at(-2)).toBe(result.manifestPath);
		expect(order.slice(0, -2).every((path) => path.endsWith('/0/default.jpg'))).toBe(true);
	});

	it('leaves nothing behind when it is cancelled', async () => {
		const controller = new AbortController();
		let written = 0;

		await expect(
			ingest(1200, 851, {
				openDecodeAndCrop: async () => ({
					dimensions: { width: 1200, height: 851 },
					encodeTile: async () => {
						written += 1;
						if (written === 5) controller.abort();
						return new Uint8Array([1]);
					},
					close: async () => undefined
				}),
				signal: controller.signal
			})
		).rejects.toThrow();

		expect(written).toBe(5);
		expect(await store.list('')).toEqual([]);
	});

	it.each([
		['during `finishing`, on the info.json write', '/info.json'],
		['on the manifest write, before any info.json', '/manifest.json']
	])('leaves nothing behind when it is cancelled %s', async (_, at) => {
		const controller = new AbortController();
		const store = new MemoryProjectStore();
		const write = store.write.bind(store);
		const paths: string[] = [];
		store.write = async (path, bytes) => {
			paths.push(path);
			if (path.endsWith(at)) controller.abort();
			return write(path, bytes);
		};

		await expect(ingest(600, 400, { store, signal: controller.signal })).rejects.toThrow();

		if (at === '/manifest.json') {
			expect(paths.filter((path) => path.endsWith('/info.json'))).toEqual([]);
		}
		expect(await store.list('')).toEqual([]);
	});

	it.each([
		['halfway', 7],
		['on the first tile', 1]
	])('leaves nothing behind, and releases the source, when a tile fails %s', async (_, failAt) => {
		const close = vi.fn(async () => undefined);
		await expect(
			ingest(1200, 851, { openDecodeAndCrop: failingTiler(1200, 851, failAt, close) })
		).rejects.toThrow('out of memory');
		expect(close).toHaveBeenCalledTimes(1);
		expect(await store.list('')).toEqual([]);
	});

	it('gives each image its own random id, and lists only images whose ingest finished', async () => {
		const first = await ingest(600, 400);
		const second = await ingest(600, 400);
		expect(first.imageId).not.toBe(second.imageId);
		expect(first.imageId).toMatch(/^[0-9a-f]{16}$/);

		await store.write(
			'images/half-finished/0,0,256,256/256,256/0/default.jpg',
			new Uint8Array([1])
		);
		// project-rooted-path-is-the-fixture: the decoy `listIngestedImages` must not report
		await store.write('some-project/images/decoy/info.json', new Uint8Array([1]));

		const listed = ({ imageId, directory, infoPath }: typeof first) => ({
			imageId,
			directory,
			infoPath
		});
		expect(await listIngestedImages(store)).toEqual(
			expect.arrayContaining([listed(first), listed(second)])
		);
		expect(await listIngestedImages(store)).toHaveLength(2);
	});

	it('trusts the decoder over the header for the dimensions it writes', async () => {
		const result = await ingest(4000, 3000, {
			openDecodeAndCrop: stubTiler({ width: 3000, height: 4000 })
		});

		const info = await readJson(result.infoPath);
		expect([info.width, info.height]).toEqual([3000, 4000]);
	});
});
