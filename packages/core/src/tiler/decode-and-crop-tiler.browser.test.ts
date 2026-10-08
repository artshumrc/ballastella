import { beforeAll, describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { openDecodeAndCropSource } from './decode-and-crop-tiler.js';
import { MAX_INGEST_PIXELS } from './decode-ceiling.js';
import { ingestImageFile } from './ingest.js';
import {
	FLORIDE,
	contentExtent,
	expectRaggedTileFilled,
	fixtureTileUrls,
	fixtureUrlFor,
	luma,
	pixelsOf,
	planFor,
	raggedTiles,
	uniformRegionCanvas,
	type Pixels
} from './pixels-fixture.js';
import { PYRAMID_TILE_SIZE, type PlannedTile } from './pyramid.js';

async function edgeImage(
	width: number,
	height: number,
	edge: number,
	axis: 'rows' | 'columns'
): Promise<Blob> {
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d')!;
	context.fillStyle = 'white';
	context.fillRect(0, 0, width, height);
	context.fillStyle = 'black';
	if (axis === 'rows') context.fillRect(0, edge, width, height - edge);
	else context.fillRect(edge, 0, width - edge, height);
	return canvas.convertToBlob({ type: 'image/png' });
}

function slopeOf(points: [number, number][]): number {
	const n = points.length;
	const sx = points.reduce((sum, [x]) => sum + x, 0);
	const sy = points.reduce((sum, [, y]) => sum + y, 0);
	const sxx = points.reduce((sum, [x]) => sum + x * x, 0);
	const sxy = points.reduce((sum, [x, y]) => sum + x * y, 0);
	return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

describe('openDecodeAndCropSource', () => {
	it('reports the decoded image dimensions', async () => {
		const source = await openDecodeAndCropSource(
			await edgeImage(FLORIDE.width, FLORIDE.height, 400, 'rows')
		);
		try {
			expect(source.dimensions).toEqual(FLORIDE);
		} finally {
			await source.close();
		}
	});

	it('writes every tile at exactly the size its own URL claims', async () => {
		const source = await openDecodeAndCropSource(
			await edgeImage(FLORIDE.width, FLORIDE.height, 400, 'rows')
		);
		try {
			const tiles = planFor(FLORIDE);
			expect(tiles).toHaveLength(29);

			for (const tile of tiles) {
				const decoded = await pixelsOf(await source.encodeTile(tile));
				expect({ width: decoded.width, height: decoded.height }, tile.path).toEqual({
					width: tile.size.width,
					height: tile.size.height
				});
			}
		} finally {
			await source.close();
		}
	});

	it('fills a ragged tile completely — no half pixel of padding at the margins', async () => {
		const dimensions = { width: 1201, height: 851 };
		const ragged = raggedTiles(dimensions);
		expect(ragged.length).toBeGreaterThan(3);

		for (const tile of ragged) {
			const source = await openDecodeAndCropSource(
				await uniformRegionCanvas(dimensions, tile.region).convertToBlob({ type: 'image/png' })
			);
			try {
				expectRaggedTileFilled(await pixelsOf(await source.encodeTile(tile)), tile);
			} finally {
				await source.close();
			}
		}
	});

	it('maps the region onto the tile at size ÷ region, not at 1 ÷ scaleFactor', async () => {
		const dimensions = { width: 1201, height: 851 };
		const coarsest = planFor(dimensions).find((tile) => tile.scaleFactor === 8) as PlannedTile;
		expect(coarsest.region).toEqual({ x: 0, y: 0, width: 1201, height: 851 });
		expect(coarsest.size).toEqual({ width: 151, height: 107 });

		for (const axis of ['rows', 'columns'] as const) {
			const extent = axis === 'rows' ? coarsest.region.height : coarsest.region.width;
			const served = axis === 'rows' ? coarsest.size.height : coarsest.size.width;
			const points: [number, number][] = [];

			for (let edge = 100; edge <= extent - 100; edge += Math.floor((extent - 200) / 8)) {
				const source = await openDecodeAndCropSource(
					await edgeImage(dimensions.width, dimensions.height, edge, axis)
				);
				try {
					points.push([
						edge,
						contentExtent(await pixelsOf(await source.encodeTile(coarsest)), axis)
					]);
				} finally {
					await source.close();
				}
			}

			const slope = slopeOf(points);
			const iiif = served / extent;
			const perScaleFactor = 1 / coarsest.scaleFactor;

			expect(Math.abs(slope - iiif), `${axis}: slope ${slope}`).toBeLessThan(
				Math.abs(slope - perScaleFactor) / 2
			);
			expect(Math.abs(slope - iiif) / iiif, `${axis}: slope ${slope}`).toBeLessThan(0.005);
		}
	});
});

describe('the pyramid this tiler writes, against the committed fixture', () => {
	let reconstructed: Blob;
	let sourcePixels: Pixels;

	beforeAll(async () => {
		const canvas = new OffscreenCanvas(FLORIDE.width, FLORIDE.height);
		const context = canvas.getContext('2d')!;

		for (const [path, url] of Object.entries(fixtureTileUrls)) {
			const [region, size] = path.split('/').slice(-4, -2);
			const [x, y, width, height] = region!.split(',').map(Number);
			const [servedWidth, servedHeight] = size!.split(',').map(Number);
			if (width !== servedWidth || height !== servedHeight) continue;
			const bitmap = await createImageBitmap(await (await fetch(url)).blob());
			context.drawImage(bitmap, x!, y!);
			bitmap.close();
		}

		reconstructed = await canvas.convertToBlob({ type: 'image/png' });
		sourcePixels = await pixelsOf(reconstructed);
	});

	const committedUrl = (tile: PlannedTile): string => {
		const found = fixtureUrlFor(tile.path);
		if (!found) throw new Error(`the fixture has no ${tile.path}`);
		return found;
	};

	it('found the fixture', () => {
		expect(Object.keys(fixtureTileUrls)).toHaveLength(29);
	});

	it('writes the same 29 paths', async () => {
		const store = new MemoryProjectStore();
		const result = await ingestImageFile({
			store,
			file: reconstructed,
			label: 'floride-1657',
			openDecodeAndCrop: openDecodeAndCropSource
		});

		const written = (await store.list(`${result.directory}/`))
			.filter((path) => path.endsWith('/default.jpg'))
			.map((path) => path.slice(`${result.directory}/`.length))
			.sort();

		const committed = Object.keys(fixtureTileUrls)
			.map((path) => path.split('/').slice(-4).join('/'))
			.sort();

		expect(written).toEqual(committed);
	});

	it('reproduces the committed full-resolution tiles', async () => {
		const source = await openDecodeAndCropSource(reconstructed);
		try {
			for (const tile of planFor(FLORIDE).filter((tile) => tile.scaleFactor === 1)) {
				const mine = await pixelsOf(await source.encodeTile(tile));
				const theirs = await pixelsOf(
					new Uint8Array(await (await fetch(committedUrl(tile))).arrayBuffer())
				);
				let squared = 0;
				for (let index = 0; index < mine.data.length; index += 4) {
					for (let channel = 0; channel < 3; channel++) {
						const difference = mine.data[index + channel]! - theirs.data[index + channel]!;
						squared += difference * difference;
					}
				}
				expect(squared / ((mine.data.length / 4) * 3), tile.path).toBeLessThan(30);
			}
		} finally {
			await source.close();
		}
	});

	it('agrees with the committed ragged tiles on IIIF semantics, and not on the alternative', async () => {
		const ragged = planFor(FLORIDE).filter(
			(tile) => tile.scaleFactor > 1 && tile.region.height % tile.scaleFactor !== 0
		);
		expect(ragged.length).toBeGreaterThan(3);

		const sourceBand = (x: number, width: number, from: number, to: number): number => {
			let sum = 0;
			let weight = 0;
			for (let y = Math.floor(from); y < Math.min(FLORIDE.height, Math.ceil(to)); y++) {
				const coverage = Math.min(y + 1, to) - Math.max(y, from);
				if (coverage <= 0) continue;
				let row = 0;
				for (let column = x; column < x + width; column++) row += luma(sourcePixels, column, y);
				sum += (row / width) * coverage;
				weight += coverage;
			}
			return weight > 0 ? sum / weight : Number.NaN;
		};

		for (const tile of ragged) {
			const committed = await pixelsOf(
				new Uint8Array(await (await fetch(committedUrl(tile))).arrayBuffer())
			);

			let iiifError = 0;
			let perScaleFactorError = 0;

			for (let row = 0; row < committed.height; row++) {
				let actual = 0;
				for (let column = 0; column < committed.width; column++) {
					actual += luma(committed, column, row);
				}
				actual /= committed.width;

				const iiif = sourceBand(
					tile.region.x,
					tile.region.width,
					tile.region.y + (row * tile.region.height) / committed.height,
					tile.region.y + ((row + 1) * tile.region.height) / committed.height
				);
				const perScaleFactor = sourceBand(
					tile.region.x,
					tile.region.width,
					tile.region.y + row * tile.scaleFactor,
					Math.min(tile.region.y + tile.region.height, tile.region.y + (row + 1) * tile.scaleFactor)
				);

				iiifError += (iiif - actual) ** 2;
				perScaleFactorError += (perScaleFactor - actual) ** 2;
			}

			expect(
				iiifError,
				`${tile.path}: IIIF ${(iiifError / committed.height).toFixed(1)} vs ` +
					`1/scaleFactor ${(perScaleFactorError / committed.height).toFixed(1)}`
			).toBeLessThan(perScaleFactorError / 2);
		}
	});
});

const WIDE = { width: 20_000, height: 15_000 };

const blockValue = (tileRow: number, tileColumn: number) =>
	((tileRow * 37 + tileColumn * 11) % 251) + 2;

async function blockedPng(): Promise<Blob> {
	const crcTable = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[n] = c;
	}
	const crc32 = (bytes: Uint8Array): number => {
		let c = -1;
		for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
		return (c ^ -1) >>> 0;
	};
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
		out.set(data, 8);
		view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
		return out;
	};

	const rows: Uint8Array<ArrayBuffer>[] = [];
	for (let tileRow = 0; tileRow < Math.ceil(WIDE.height / PYRAMID_TILE_SIZE); tileRow++) {
		const row = new Uint8Array(WIDE.width + 1);
		for (let x = 0; x < WIDE.width; x++) {
			row[x + 1] = blockValue(tileRow, Math.floor(x / PYRAMID_TILE_SIZE));
		}
		rows.push(row);
	}

	const stream = new CompressionStream('deflate');
	const writer = stream.writable.getWriter();
	const written = (async () => {
		for (let y = 0; y < WIDE.height; y++) {
			await writer.write(rows[Math.floor(y / PYRAMID_TILE_SIZE)]!);
		}
		await writer.close();
	})();
	const idat = new Uint8Array(await new Response(stream.readable).arrayBuffer());
	await written;

	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, WIDE.width);
	view.setUint32(4, WIDE.height);
	header[8] = 8;
	header[9] = 0;
	return new Blob(
		[
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) as BlobPart,
			chunk('IHDR', header) as BlobPart,
			chunk('IDAT', idat) as BlobPart,
			chunk('IEND', new Uint8Array(0)) as BlobPart
		],
		{ type: 'image/png' }
	);
}

describe('an image above the old 268-megapixel threshold (ADR-0027)', () => {
	it(
		'decodes, and cuts tiles whose pixels come from the right region',
		{ timeout: 180_000 },
		async () => {
			expect(WIDE.width * WIDE.height).toBeGreaterThan(268_435_456);
			expect(WIDE.width * WIDE.height).toBeLessThan(MAX_INGEST_PIXELS);
			const source = await openDecodeAndCropSource(await blockedPng());
			try {
				expect(source.dimensions).toEqual(WIDE);
				const finest = planFor(WIDE).filter((tile) => tile.scaleFactor === 1);
				expect(finest).toHaveLength(79 * 59);

				for (const [tileColumn, tileRow] of [
					[0, 0],
					[41, 23],
					[78, 0],
					[0, 58],
					[78, 58]
				] as const) {
					const tile = finest.find(
						(candidate) =>
							candidate.region.x === tileColumn * PYRAMID_TILE_SIZE &&
							candidate.region.y === tileRow * PYRAMID_TILE_SIZE
					);
					expect(
						tile,
						`no scale-factor-1 tile at column ${tileColumn}, row ${tileRow}`
					).toBeDefined();

					const decoded = await pixelsOf(await source.encodeTile(tile!));
					expect({ width: decoded.width, height: decoded.height }, tile!.path).toEqual({
						width: tile!.size.width,
						height: tile!.size.height
					});

					const expected = blockValue(tileRow, tileColumn);
					const read = luma(decoded, Math.floor(decoded.width / 2), Math.floor(decoded.height / 2));
					expect(
						Math.abs(read - expected),
						`${tile!.path} came from the wrong region: read ${read.toFixed(1)}, expected ${expected}`
					).toBeLessThan(4);
				}
			} finally {
				await source.close();
			}
		}
	);
});
