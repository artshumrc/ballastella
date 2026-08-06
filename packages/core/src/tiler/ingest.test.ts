// SPEC's Seam 1: the ingest job driven against an in-memory ProjectStore, with assertions on
// the resulting files. The tilers themselves are stubs here — a stub is enough to assert the
// job's behaviour, and the two real ones are asserted where their pixels can be looked at
// (`decode-and-crop-tiler.browser.test.ts` and `streaming-tiler.test.ts`).

import { Image } from '@allmaps/iiif-parser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { STREAMING_TILER_THRESHOLD_PIXELS } from './decode-ceiling.js';
import {
	NoStreamingTilerError,
	UnreadableImageError,
	ingestImageFile,
	listIngestedImages,
	type IngestProgress,
	type OpenTileSource,
	type TileSource
} from './ingest.js';
import { PYRAMID_TILE_SIZE, planPyramid, type PlannedTile } from './pyramid.js';

/** A JPEG header declaring `width` × `height` and nothing else. Enough to route on. */
function jpegHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(13);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
	bytes[7] = (height >> 8) & 0xff;
	bytes[8] = height & 0xff;
	bytes[9] = (width >> 8) & 0xff;
	bytes[10] = width & 0xff;
	return bytes;
}

const imageFile = (width: number, height: number, name = 'scan.jpg') =>
	new File([jpegHeader(width, height) as BlobPart], name, { type: 'image/jpeg' });

/** A tiler that writes the tile's own geometry as its bytes, so a test can read it back. */
const stubTiler = (
	dimensions: { width: number; height: number },
	log?: { opened: string[]; kind: string }
): OpenTileSource => {
	return async (): Promise<TileSource> => {
		log?.opened.push(log.kind);
		return {
			dimensions,
			encodeTile: async (tile: PlannedTile) =>
				new TextEncoder().encode(
					JSON.stringify({ region: tile.region, size: tile.size, scaleFactor: tile.scaleFactor })
				),
			close: async () => undefined
		};
	};
};

let store: MemoryProjectStore;

beforeEach(() => {
	store = new MemoryProjectStore();
});

describe('ingestImageFile', () => {
	it('writes a complete pyramid, an info.json and a manifest.json', async () => {
		const result = await ingestImageFile({
			store,
			projectDirectory: 'amsterdam-1625',
			file: imageFile(1200, 851, 'la-floride.jpg'),
			openDecodeAndCrop: stubTiler({ width: 1200, height: 851 })
		});

		expect(result.tileCount).toBe(29);
		expect(result.width).toBe(1200);
		expect(result.tiler).toBe('decode-and-crop');
		expect(result.directory).toBe(`amsterdam-1625/images/${result.imageId}`);

		const paths = await store.list('amsterdam-1625/');
		expect(paths).toHaveLength(31);
		expect(paths).toContain(result.infoPath);
		expect(paths).toContain(result.manifestPath);

		// The info.json that landed is one @allmaps/iiif-parser can construct an Image from, which
		// ADR-0003 makes the whole point of tiling every image.
		const info = JSON.parse(new TextDecoder().decode(await store.read(result.infoPath)));
		const image = Image.parse(info);
		expect(image.tileZoomLevels.map((level) => level.scaleFactor)).toEqual([1, 2, 4, 8]);
		expect(info.id).toBe(`https://unset.invalid/${result.imageId}`);
	});

	it('writes exactly the tile getTileImageRequest describes, at every path', async () => {
		const result = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(1200, 851),
			openDecodeAndCrop: stubTiler({ width: 1200, height: 851 })
		});

		const info = JSON.parse(new TextDecoder().decode(await store.read(result.infoPath)));
		const planned = planPyramid(info, result.directory);
		expect(planned).toHaveLength(29);

		for (const tile of planned) {
			const written = JSON.parse(new TextDecoder().decode(await store.read(tile.path)));
			expect(written, tile.path).toEqual({
				region: tile.region,
				size: tile.size,
				scaleFactor: tile.scaleFactor
			});
		}
	});

	it('gives a 2 megapixel photograph a pyramid, not a shortcut', async () => {
		// SPEC story 21, ADR-0003. 1632 × 1224 is a phone photograph, and it still gets four levels.
		const result = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(1632, 1224, 'photo.jpg'),
			openDecodeAndCrop: stubTiler({ width: 1632, height: 1224 })
		});

		const info = JSON.parse(new TextDecoder().decode(await store.read(result.infoPath)));
		expect(info.tiles[0].scaleFactors).toEqual([1, 2, 4, 8]);
		expect(result.tileCount).toBe(35 + 12 + 4 + 1);
		expect(info.tiles[0].width).toBe(PYRAMID_TILE_SIZE);
	});

	it('reports progress for both paths, and for a small file', async () => {
		for (const [kind, threshold] of [
			['decode-and-crop', STREAMING_TILER_THRESHOLD_PIXELS],
			['streaming', 1]
		] as const) {
			const local = new MemoryProjectStore();
			const progress: IngestProgress[] = [];
			await ingestImageFile({
				store: local,
				projectDirectory: 'p',
				file: imageFile(600, 400),
				openDecodeAndCrop: stubTiler({ width: 600, height: 400 }),
				openStreaming: stubTiler({ width: 600, height: 400 }),
				streamingThresholdPixels: threshold,
				onProgress: (update) => progress.push(update)
			});

			expect(progress[0]?.phase, kind).toBe('inspecting');
			expect(progress.at(-1)?.phase, kind).toBe('done');
			expect(progress.at(-1)?.fraction, kind).toBe(1);
			expect(progress.at(-1)?.tiler, kind).toBe(kind);
			expect(
				progress.map((update) => update.phase),
				kind
			).toContain('tiling');
			expect(
				progress.map((update) => update.phase),
				kind
			).toContain('finishing');

			// SPEC story 23: the number must move, and it must not claim to be finished early.
			const fractions = progress.map((update) => update.fraction);
			expect(fractions, kind).toEqual([...fractions].sort((a, b) => a - b));
			expect(Math.max(...fractions.slice(0, -1)), kind).toBeLessThan(1);
			expect(progress.filter((update) => update.phase === 'tiling').length, kind).toBe(
				progress.at(-1)!.tileCount + 1
			);
		}
	});

	it('routes an image above the ceiling to the streaming tiler', async () => {
		const log = { opened: [] as string[], kind: 'streaming' };
		const decode = { opened: log.opened, kind: 'decode-and-crop' };

		const result = await ingestImageFile({
			store,
			projectDirectory: 'p',
			// 30000 × 20000 is 600 megapixels: above the measured decode ceiling in every browser
			// measured, and well above the threshold.
			file: imageFile(30_000, 20_000),
			openDecodeAndCrop: stubTiler({ width: 30_000, height: 20_000 }, decode),
			openStreaming: stubTiler({ width: 30_000, height: 20_000 }, log)
		});

		expect(log.opened).toEqual(['streaming']);
		expect(result.tiler).toBe('streaming');
	});

	it('routes an image below the threshold to decode-and-crop', async () => {
		const log = { opened: [] as string[], kind: 'streaming' };
		const decode = { opened: log.opened, kind: 'decode-and-crop' };

		await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(4000, 3000),
			openDecodeAndCrop: stubTiler({ width: 4000, height: 3000 }, decode),
			openStreaming: stubTiler({ width: 4000, height: 3000 }, log)
		});

		expect(log.opened).toEqual(['decode-and-crop']);
	});

	it('decides from the header, before anything is decoded', async () => {
		// The routing has to happen without asking a decoder anything, because asking is the
		// allocation it exists to avoid. A file whose bytes stop after the header proves it: the
		// decode tiler is never opened.
		const openDecodeAndCrop = vi.fn(async () => {
			throw new Error('the decode path must not be opened for an image above the ceiling');
		});

		const result = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(40_000, 30_000),
			openDecodeAndCrop,
			openStreaming: stubTiler({ width: 40_000, height: 30_000 })
		});

		expect(openDecodeAndCrop).not.toHaveBeenCalled();
		expect(result.tiler).toBe('streaming');
	});

	it('refuses, without writing anything, when there is no streaming tiler to route to', async () => {
		await expect(
			ingestImageFile({
				store,
				projectDirectory: 'p',
				file: imageFile(40_000, 30_000),
				openDecodeAndCrop: stubTiler({ width: 40_000, height: 30_000 })
			})
		).rejects.toThrow(NoStreamingTilerError);

		expect(await store.list('')).toEqual([]);
	});

	it('says what is wrong when nothing can read the file', async () => {
		await expect(
			ingestImageFile({
				store,
				projectDirectory: 'p',
				file: new File([new Uint8Array([1, 2, 3]) as BlobPart], 'notes.txt'),
				openDecodeAndCrop: async () => {
					throw new Error('The source image could not be decoded.');
				}
			})
		).rejects.toThrow(UnreadableImageError);

		expect(await store.list('')).toEqual([]);
	});

	it('writes info.json last, so its presence means the pyramid is complete', async () => {
		// A Workspace is a folder in git or Dropbox (ADR-0008). An ingest interrupted halfway is a
		// folder somebody else may look at, and nothing must be able to read a half-written pyramid
		// as a whole one.
		const order: string[] = [];
		const recording = new MemoryProjectStore();
		const write = recording.write.bind(recording);
		recording.write = async (path, bytes) => {
			order.push(path);
			return write(path, bytes);
		};

		const result = await ingestImageFile({
			store: recording,
			projectDirectory: 'p',
			file: imageFile(600, 400),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});

		expect(order.at(-1)).toBe(result.infoPath);
		expect(order.at(-2)).toBe(result.manifestPath);
		expect(order.slice(0, -2).every((path) => path.endsWith('/0/default.jpg'))).toBe(true);
	});

	it('leaves nothing behind when it is cancelled', async () => {
		const controller = new AbortController();
		let written = 0;

		await expect(
			ingestImageFile({
				store,
				projectDirectory: 'p',
				file: imageFile(1200, 851),
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

	it('leaves nothing behind when a tile fails halfway', async () => {
		await expect(
			ingestImageFile({
				store,
				projectDirectory: 'p',
				file: imageFile(1200, 851),
				openDecodeAndCrop: async () => {
					let count = 0;
					return {
						dimensions: { width: 1200, height: 851 },
						encodeTile: async () => {
							if (++count === 7) throw new Error('out of memory');
							return new Uint8Array([1]);
						},
						close: async () => undefined
					};
				}
			})
		).rejects.toThrow('out of memory');

		expect(await store.list('')).toEqual([]);
	});

	it('releases the source however it ends', async () => {
		const close = vi.fn(async () => undefined);
		await expect(
			ingestImageFile({
				store,
				projectDirectory: 'p',
				file: imageFile(600, 400),
				openDecodeAndCrop: async () => ({
					dimensions: { width: 600, height: 400 },
					encodeTile: async () => {
						throw new Error('nope');
					},
					close
				})
			})
		).rejects.toThrow('nope');
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('labels the Historical Map with the file the user picked', async () => {
		const result = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(600, 400, 'Blaeu — Amsterdam, 1625.tif'),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});

		const manifest = JSON.parse(new TextDecoder().decode(await store.read(result.manifestPath)));
		expect(manifest.label).toEqual({ none: ['Blaeu — Amsterdam, 1625.tif'] });
	});

	it('gives each ingested image its own random id (@allmaps/id)', async () => {
		const first = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(600, 400),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});
		const second = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(600, 400),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});

		// `generateRandomId`, not `generateId(uri)`: two ingests of the same file are two Historical
		// Maps, and deduplicating them by content is ticket 14's question about remote resources.
		expect(first.imageId).not.toBe(second.imageId);
		expect(first.imageId).toMatch(/^[0-9a-f]{16}$/);
	});

	it('lists only images whose ingest finished', async () => {
		const first = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(600, 400),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});

		// A pyramid interrupted before its `info.json`: tiles on disk, no image.
		await store.write(
			`p/images/half-finished/0,0,256,256/256,256/0/default.jpg`,
			new Uint8Array([1])
		);

		expect(await listIngestedImages(store, 'p')).toEqual([
			{ imageId: first.imageId, directory: first.directory, infoPath: first.infoPath }
		]);
		expect(await listIngestedImages(store, 'other')).toEqual([]);
	});

	it('trusts the decoder over the header for the dimensions it writes', async () => {
		// The header decides the route; the decoder decides the truth. An EXIF-rotated JPEG is the
		// case that matters — browsers apply the orientation, so the decoded image can be the
		// transpose of what the frame header says, and a pyramid built to the header's dimensions
		// would be cut from an image that is not that shape.
		const result = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: imageFile(4000, 3000),
			openDecodeAndCrop: stubTiler({ width: 3000, height: 4000 })
		});

		const info = JSON.parse(new TextDecoder().decode(await store.read(result.infoPath)));
		expect([info.width, info.height]).toEqual([3000, 4000]);
	});
});
