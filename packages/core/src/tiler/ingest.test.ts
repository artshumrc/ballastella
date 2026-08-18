// SPEC's Seam 1: the ingest job driven against an in-memory ProjectStore, with assertions on
// the resulting files. The tiler itself is a stub here — a stub is enough to assert the job's
// behaviour, and the real one is asserted where its pixels can be looked at
// (`decode-and-crop-tiler.browser.test.ts`).

import { Image } from '@allmaps/iiif-parser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { MAX_INGEST_PIXELS } from './decode-ceiling.js';
import {
	ImageTooLargeError,
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
			file: imageFile(1200, 851, 'la-floride.jpg'),
			openDecodeAndCrop: stubTiler({ width: 1200, height: 851 })
		});

		expect(result.tileCount).toBe(29);
		expect(result.width).toBe(1200);
		// At the Workspace root, shared by every Project (ADR-0023): a scan is prepared once and any
		// number of Projects can draw it.
		expect(result.directory).toBe(`images/${result.imageId}`);

		const paths = await store.list('images/');
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

	// ADR-0023, and the criterion in as many words: adding a Map Image writes
	// `images/<image-id>/info.json` at the Workspace root and **no bytes inside any Project directory**.
	// A pyramid is prepared once and shared, so a copy landing inside the Project that happened to be open
	// is the whole failure the move exists to end.
	it('writes nothing inside any Project directory', async () => {
		await store.write(
			'amsterdam-1625/project.json',
			new TextEncoder().encode('{"formatVersion":1}')
		);
		await store.write('boston-1775/project.json', new TextEncoder().encode('{"formatVersion":1}'));

		const result = await ingestImageFile({
			store,
			file: imageFile(600, 400, 'la-floride.jpg'),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});

		expect(result.infoPath).toBe(`images/${result.imageId}/info.json`);
		// Every path written is under `images/`, and the two Project directories hold only what they held.
		expect((await store.list('')).filter((path) => !path.startsWith('images/'))).toEqual([
			'amsterdam-1625/project.json',
			'boston-1775/project.json'
		]);
	});

	it('writes exactly the tile getTileImageRequest describes, at every path', async () => {
		const result = await ingestImageFile({
			store,
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
			file: imageFile(1632, 1224, 'photo.jpg'),
			openDecodeAndCrop: stubTiler({ width: 1632, height: 1224 })
		});

		const info = JSON.parse(new TextDecoder().decode(await store.read(result.infoPath)));
		expect(info.tiles[0].scaleFactors).toEqual([1, 2, 4, 8]);
		expect(result.tileCount).toBe(35 + 12 + 4 + 1);
		expect(info.tiles[0].width).toBe(PYRAMID_TILE_SIZE);
	});

	it('reports progress from inspecting to done, monotonically', async () => {
		const progress: IngestProgress[] = [];
		await ingestImageFile({
			store,
			file: imageFile(600, 400),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 }),
			onProgress: (update) => progress.push(update)
		});

		expect(progress[0]?.phase).toBe('inspecting');
		expect(progress.at(-1)?.phase).toBe('done');
		expect(progress.at(-1)?.fraction).toBe(1);
		expect(progress.map((update) => update.phase)).toContain('tiling');
		expect(progress.map((update) => update.phase)).toContain('finishing');

		// SPEC story 23: the number must move, and it must not claim to be finished early.
		const fractions = progress.map((update) => update.fraction);
		expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
		expect(Math.max(...fractions.slice(0, -1))).toBeLessThan(1);
		expect(progress.filter((update) => update.phase === 'tiling').length).toBe(
			progress.at(-1)!.tileCount + 1
		);
	});

	// **The case ADR-0027 was written to unblock, and it is asserted on the pyramid rather than on
	// the absence of an error.** 25000 × 20000 is 500 megapixels: above the 268-megapixel routing
	// threshold that used to refuse it outright, below the 528-megapixel ceiling both measured
	// engines decode. A scholar with a 500-megapixel scan could not ingest it before this decision
	// and can now, and what has to be true is that the pyramid is *correct*, not merely that nothing
	// threw — a refusal that returned an empty result would pass a `rejects.not.toThrow`.
	it('ingests an image between the old threshold and the ceiling, and cuts a real pyramid', async () => {
		expect(25_000 * 20_000).toBeGreaterThan(268_435_456);
		expect(25_000 * 20_000).toBeLessThan(MAX_INGEST_PIXELS);

		const result = await ingestImageFile({
			store,
			file: imageFile(25_000, 20_000, 'archival-master.jpg'),
			openDecodeAndCrop: stubTiler({ width: 25_000, height: 20_000 })
		});

		expect(result.width).toBe(25_000);
		expect(result.height).toBe(20_000);

		// Every tile the plan describes is on disk, at the path it names and with the geometry it
		// names. That is the same assertion the 1200 × 851 case makes, at a size that used to refuse.
		const info = JSON.parse(new TextDecoder().decode(await store.read(result.infoPath)));
		const planned = planPyramid(info, result.directory);
		expect(planned).toHaveLength(result.tileCount);
		expect(result.tileCount).toBeGreaterThan(1000);
		for (const tile of planned) {
			expect(JSON.parse(new TextDecoder().decode(await store.read(tile.path))), tile.path).toEqual({
				region: tile.region,
				size: tile.size,
				scaleFactor: tile.scaleFactor
			});
		}
	});

	// **The refusal the shipped app produces, and the wording is the assertion** (ADR-0027).
	//
	// It used to name `Cross-Origin-Embedder-Policy` and cross-origin isolation, because the real
	// obstacle was a streaming tiler that could not start on a static host. That was accurate about
	// the cause and actionable by nobody. Before that it was worse still: it arrived as
	// `UnreadableImageError`, telling a scholar their valid JPEG "could not be read as an image" and
	// to convert a TIFF they do not have. SPEC's *On the audience* makes "errors must name what is
	// wrong and what to do" binding, and the size plus the IIIF remedy is that.
	it('refuses an image above the ceiling by naming its size and the remedy', async () => {
		const opened: string[] = [];

		const failure = await ingestImageFile({
			store,
			// 30000 × 20000 is 600 megapixels, above the ceiling in both measured engines.
			file: imageFile(30_000, 20_000, 'archival-master.jpg'),
			openDecodeAndCrop: stubTiler(
				{ width: 30_000, height: 20_000 },
				{ opened, kind: 'decode-and-crop' }
			)
		}).then(
			() => undefined,
			(cause: unknown) => cause as Error
		);

		expect(failure).toBeInstanceOf(ImageTooLargeError);
		expect(failure?.message).toContain('600 megapixels');
		expect(failure?.message).toContain('528 megapixel');
		expect(failure?.message).toContain('IIIF pyramid outside the browser');
		expect(failure?.message, 'the refusal blames the file instead of the size').not.toContain(
			'could not be read as an image'
		);

		// Nothing user-facing may name the deployment any more; the tiler that needed those headers
		// is gone, and a sentence about COEP is now false as well as unactionable.
		for (const word of ['COOP', 'COEP', 'Cross-Origin', 'cross-origin', 'SharedArrayBuffer']) {
			expect(failure?.message, word).not.toContain(word);
		}

		// Decided from the header, so no decoder was ever asked and nothing was written. Asking is
		// the allocation the cap exists to avoid.
		expect(opened).toEqual([]);
		expect(await store.list('')).toEqual([]);
	});

	it('decides from the header, before anything is decoded', async () => {
		const openDecodeAndCrop = vi.fn(async () => {
			throw new Error('the decode path must not be opened for an image above the ceiling');
		});

		await expect(
			ingestImageFile({ store, file: imageFile(40_000, 30_000), openDecodeAndCrop })
		).rejects.toThrow(ImageTooLargeError);

		expect(openDecodeAndCrop).not.toHaveBeenCalled();
	});

	// The boundary itself, both sides of it, against an injected cap so the assertion is about the
	// comparison rather than about a 528-megapixel fixture. `>` and not `>=`: the measured number is
	// the largest image Firefox *decoded*, so an image of exactly that size must be admitted.
	it('admits an image of exactly the cap and refuses the next pixel', async () => {
		const at = await ingestImageFile({
			store,
			file: imageFile(1000, 1000),
			openDecodeAndCrop: stubTiler({ width: 1000, height: 1000 }),
			maxIngestPixels: 1_000_000
		});
		expect(at.tileCount).toBeGreaterThan(0);

		await expect(
			ingestImageFile({
				store,
				file: imageFile(1000, 1001),
				openDecodeAndCrop: stubTiler({ width: 1000, height: 1001 }),
				maxIngestPixels: 1_000_000
			})
		).rejects.toThrow(ImageTooLargeError);
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

	// **A big TIFF must fail as a format, not as a size** — the two refusals give opposite advice and
	// only one of them is actionable. 300 megapixels is comfortably under ADR-0027's 528-megapixel
	// cap, so the size check must let it through and the decoder must be the thing that objects.
	//
	// This pairing is why the cap being *raised* matters here: at the old 268-megapixel threshold a
	// 300-megapixel TIFF was refused for its size before any decoder saw it, and the user was told to
	// do something about a number rather than about the file.
	it('blames the format, not the size, for a TIFF under the cap', async () => {
		expect(20_000 * 15_000).toBeLessThan(MAX_INGEST_PIXELS);

		const failure = await ingestImageFile({
			store,
			file: imageFile(20_000, 15_000, 'master.tif'),
			openDecodeAndCrop: async () => {
				throw new Error('The source image could not be decoded.');
			}
		}).then(
			() => undefined,
			(cause: unknown) => cause as Error
		);

		expect(failure).toBeInstanceOf(UnreadableImageError);
		expect(failure).not.toBeInstanceOf(ImageTooLargeError);
		expect(failure?.message).toContain('Browsers read JPEG');
		expect(failure?.message).toContain('TIFF or JPEG 2000 archival master needs to be converted');
		expect(failure?.message).not.toContain('megapixels');
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

	it('leaves nothing behind when it is cancelled during `finishing`', async () => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE WINDOW WHERE CANCEL USED TO DO NOTHING AT ALL.                                    │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// The Cancel affordance stays live until the phase is `done`, and there used to be one abort
		// check at the top of `finishing` and none across the two writes that follow it. A cancel
		// landing there aborted nothing: the map the user cancelled was created — `info.json` and
		// all, so it is offered by every list in the app — with no error and nothing to notice.
		//
		// Cancelled *at* the last write, which is the far end of the window and the case the single
		// check at the top of the phase could never have caught. Its near end — a cancel landing on
		// the manifest write, which the check *before* `info.json` is the one that catches — is the
		// test below; between them the two checks added across this window are each exercised alone.
		const controller = new AbortController();
		const store = new MemoryProjectStore();
		const write = store.write.bind(store);
		store.write = async (path, bytes) => {
			if (path.endsWith('/info.json')) controller.abort();
			return write(path, bytes);
		};

		await expect(
			ingestImageFile({
				store,
				file: imageFile(600, 400),
				openDecodeAndCrop: stubTiler({ width: 600, height: 400 }),
				signal: controller.signal
			})
		).rejects.toThrow();

		// Not "no `info.json`" but nothing at all: an abandoned pyramid is unreachable and still
		// occupies the bytes ADR-0008's hosting warning counts.
		expect(await store.list('')).toEqual([]);
	});

	it('writes no `info.json` when the cancel lands on the manifest write', async () => {
		// The near end of the same window, and the only case that reaches the abort check *between*
		// the two writes. The test above cancels during the `info.json` write itself, so by then that
		// check has already passed and it is the one after it that fires — leaving the earlier check
		// asserted by nothing, which is how a guard quietly becomes decoration.
		//
		// `info.json` is the completion marker for the whole directory: everything in the app finds a
		// Map Image by finding one. So this asserts more than "nothing is left behind" — it
		// asserts the cancel was taken *before* the map became findable, rather than after it and
		// undone.
		const controller = new AbortController();
		const store = new MemoryProjectStore();
		const write = store.write.bind(store);
		const paths: string[] = [];
		store.write = async (path, bytes) => {
			paths.push(path);
			if (path.endsWith('/manifest.json')) controller.abort();
			return write(path, bytes);
		};

		await expect(
			ingestImageFile({
				store,
				file: imageFile(600, 400),
				openDecodeAndCrop: stubTiler({ width: 600, height: 400 }),
				signal: controller.signal
			})
		).rejects.toThrow();

		expect(paths.filter((path) => path.endsWith('/info.json'))).toEqual([]);
		expect(await store.list('')).toEqual([]);
	});

	it('leaves nothing behind when a tile fails halfway', async () => {
		await expect(
			ingestImageFile({
				store,
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

	it('labels the Map Image with the file the user picked', async () => {
		const result = await ingestImageFile({
			store,
			file: imageFile(600, 400, 'Blaeu — Amsterdam, 1625.tif'),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});

		const manifest = JSON.parse(new TextDecoder().decode(await store.read(result.manifestPath)));
		expect(manifest.label).toEqual({ none: ['Blaeu — Amsterdam, 1625.tif'] });
	});

	it('gives each ingested image its own random id (@allmaps/id)', async () => {
		const first = await ingestImageFile({
			store,
			file: imageFile(600, 400),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});
		const second = await ingestImageFile({
			store,
			file: imageFile(600, 400),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});

		// `generateRandomId`, not `generateId(uri)`: two ingests of the same file are two Map
		// Images, and deduplicating them by content is ticket 14's question about remote resources.
		expect(first.imageId).not.toBe(second.imageId);
		expect(first.imageId).toMatch(/^[0-9a-f]{16}$/);
	});

	it('lists only images whose ingest finished', async () => {
		const first = await ingestImageFile({
			store,
			file: imageFile(600, 400),
			openDecodeAndCrop: stubTiler({ width: 600, height: 400 })
		});

		// A pyramid interrupted before its `info.json`: tiles on disk, no image.
		await store.write(
			'images/half-finished/0,0,256,256/256,256/0/default.jpg',
			new Uint8Array([1])
		);
		// And a Project directory that happens to contain something shaped like a pyramid. It is not a
		// Map Image of this Workspace, and `listIngestedImages` no longer looks inside a Project at
		// all (ADR-0023) — which is what stops one Project's leftovers being listed as Workspace material.
		// project-rooted-path-is-the-fixture: the decoy `listIngestedImages` must not report
		await store.write('some-project/images/decoy/info.json', new Uint8Array([1]));

		expect(await listIngestedImages(store)).toEqual([
			{ imageId: first.imageId, directory: first.directory, infoPath: first.infoPath }
		]);
	});

	it('trusts the decoder over the header for the dimensions it writes', async () => {
		// The header decides the route; the decoder decides the truth. An EXIF-rotated JPEG is the
		// case that matters — browsers apply the orientation, so the decoded image can be the
		// transpose of what the frame header says, and a pyramid built to the header's dimensions
		// would be cut from an image that is not that shape.
		const result = await ingestImageFile({
			store,
			file: imageFile(4000, 3000),
			openDecodeAndCrop: stubTiler({ width: 3000, height: 4000 })
		});

		const info = JSON.parse(new TextDecoder().decode(await store.read(result.infoPath)));
		expect([info.width, info.height]).toEqual([3000, 4000]);
	});
});
