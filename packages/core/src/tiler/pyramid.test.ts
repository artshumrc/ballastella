import { Image, Manifest } from '@allmaps/iiif-parser';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { imageDirectory, imageInfoPath, imageManifestPath } from '../project/image-files.js';
import { buildImageManifest, wholeImageDerivative } from './image-manifest.js';
import {
	IMAGE_SERVICE_PLACEHOLDER_ORIGIN,
	PYRAMID_TILE_SIZE,
	buildImageInfo,
	imageGeometryFromInfo,
	imageSizeFromInfo,
	planPyramid,
	pyramidScaleFactors,
	serialiseJson
} from './pyramid.js';

/**
 * The committed fixture pyramid, which `apps/editor/static/fixtures/README.md` names as what
 * this tiler's output is compared against. Read from disk rather than restated, so the bytes
 * these assertions reason about are the bytes ticket 03's image pane fetches.
 */
const FIXTURE_DIRECTORY = new URL(
	'../../../../apps/editor/static/fixtures/images/floride-1657/',
	import.meta.url
);

const fixtureInfo = JSON.parse(
	await readFile(new URL('info.json', FIXTURE_DIRECTORY), 'utf8')
) as Record<string, unknown>;

const FLORIDE = { width: 1200, height: 851 };

describe('pyramidScaleFactors', () => {
	it('stops at the factor where the whole image is one tile', () => {
		// 1200 × 851 needs 8: at 4 the image is 300 × 213 — two tiles wide.
		expect(pyramidScaleFactors(FLORIDE)).toEqual([1, 2, 4, 8]);
	});

	it('gives a 2 megapixel photograph a real pyramid rather than a shortcut', () => {
		// SPEC story 21 and ADR-0003: there is no exemption for small images, because
		// @allmaps/iiif-parser cannot construct an Image for an untiled level-0 service at all.
		expect(pyramidScaleFactors({ width: 1632, height: 1224 })).toEqual([1, 2, 4, 8]);
	});

	it('still produces a level for an image smaller than one tile', () => {
		expect(pyramidScaleFactors({ width: 100, height: 40 })).toEqual([1]);
	});

	it('is contiguous from 1, which is what the image pane refuses to do without', () => {
		for (const dimensions of [
			{ width: 1200, height: 851 },
			{ width: 40000, height: 31000 },
			{ width: 257, height: 1 }
		]) {
			const factors = pyramidScaleFactors(dimensions);
			expect(factors).toEqual(factors.map((_, index) => 2 ** index));
		}
	});
});

describe('buildImageInfo', () => {
	const info = buildImageInfo({ imageId: 'floride-1657', ...FLORIDE });

	it('carries the unset.invalid placeholder id (ADR-0004)', () => {
		expect(info.id).toBe('https://unset.invalid/floride-1657');
		// The same check `Image3Schema`'s `id: z.string().url()` makes, stated here so that the
		// requirement is visible where the value is produced and not only inside the parser.
		const url = new URL(info.id);
		expect(url.protocol).toBe('https:');
		expect(url.hostname.endsWith('unset.invalid')).toBe(true);
		expect(IMAGE_SERVICE_PLACEHOLDER_ORIGIN).toBe('https://unset.invalid');
	});

	it('constructs an @allmaps/iiif-parser Image without throwing', () => {
		// The acceptance criterion, and the reason ADR-0003 exists: `getTileZoomLevels` throws
		// 'Image does not support tiles or custom regions and sizes.' for a level-0 service with no
		// usable `tiles`, inside the constructor. An untiled pyramid cannot even be parsed.
		const image = Image.parse(info);
		expect(image.width).toBe(1200);
		expect(image.height).toBe(851);
		expect(image.tileZoomLevels.map((level) => level.scaleFactor)).toEqual([1, 2, 4, 8]);
	});

	it('emits square tiles, with height stated', () => {
		expect(info.tiles).toHaveLength(1);
		expect(info.tiles[0].width).toBe(PYRAMID_TILE_SIZE);
		expect(info.tiles[0].height).toBe(PYRAMID_TILE_SIZE);
	});

	it('emits no sizes array, which would do nothing (ADR-0003)', () => {
		expect(Object.keys(info)).not.toContain('sizes');
	});

	it('matches the committed fixture pyramid document exactly', () => {
		// `apps/editor/static/fixtures/README.md`: the throwaway script that made that pyramid is
		// replaced by this tiler, and the pyramid is what its output is compared against.
		expect(info).toEqual(fixtureInfo);
	});

	it('refuses dimensions that are not positive integers', () => {
		expect(() => buildImageInfo({ imageId: 'x', width: 0, height: 10 })).toThrow(
			/positive integers/
		);
		expect(() => buildImageInfo({ imageId: 'x', width: 10.5, height: 10 })).toThrow(
			/positive integers/
		);
	});
});

describe('planPyramid', () => {
	const info = buildImageInfo({ imageId: 'floride-1657', ...FLORIDE });
	const directory = imageDirectory('floride-1657');
	const tiles = planPyramid(info, directory);

	it('is exactly what getTileImageRequest describes, for every level, column and row', () => {
		// Exhaustive, not sampled. Both sides of ADR-0003's contract are re-derived here from the
		// parser rather than from any arithmetic in this repository: if the plan and the parser ever
		// disagree, the image pane reads a URL the tiler never wrote and the pane goes blank.
		const image = Image.parse(info);
		image.uri = directory;
		const levels = [...image.tileZoomLevels].sort((a, b) => a.scaleFactor - b.scaleFactor);

		const expected = levels.flatMap((level) =>
			Array.from({ length: level.rows }, (_, row) =>
				Array.from({ length: level.columns }, (_, column) => {
					const request = image.getTileImageRequest(level, column, row);
					return {
						scaleFactor: level.scaleFactor,
						column,
						row,
						region: request.region,
						size: request.size,
						path: image.getImageUrl(request)
					};
				})
			).flat()
		);

		expect(tiles).toEqual(expected);
		expect(tiles).toHaveLength(29);
	});

	it('plans exactly the 29 tiles the committed fixture contains', async () => {
		const paths = new Set(tiles.map((tile) => tile.path));
		expect(paths.size).toBe(29);

		// Every planned tile exists in the fixture, at the same region/size/quality/format path.
		for (const tile of tiles) {
			const relative = tile.path.slice(`${directory}/`.length);
			await expect(
				readFile(new URL(relative, FIXTURE_DIRECTORY)).then((bytes) => bytes.length > 0),
				`fixture is missing ${relative}`
			).resolves.toBe(true);
		}
	});

	it('truncates edge tiles at the right and bottom margins', () => {
		const bottomRight = tiles.find(
			(tile) => tile.scaleFactor === 1 && tile.column === 4 && tile.row === 3
		);
		// 1200 − 4×256 = 176 wide, 851 − 3×256 = 83 tall, and at scale factor 1 the served size is
		// the region.
		expect(bottomRight?.region).toEqual({ x: 1024, y: 768, width: 176, height: 83 });
		expect(bottomRight?.size).toEqual({ width: 176, height: 83 });

		const coarsest = tiles.find((tile) => tile.scaleFactor === 8);
		// One tile covering everything, served at ceil(1200/8) × ceil(851/8) = 150 × 107. 851/8 is
		// 106.375: the ceiling is what makes a tile file whole pixels, and the fraction is what
		// ticket 03's `placement` is about.
		expect(coarsest?.region).toEqual({ x: 0, y: 0, width: 1200, height: 851 });
		expect(coarsest?.size).toEqual({ width: 150, height: 107 });
		expect(Math.ceil(851 / 8)).toBe(107);
	});

	it('serves every tile at ceil(region ÷ scaleFactor) — never floor, never round', () => {
		// The rounding that decides a tile's file size, asserted for every tile in the pyramid. A
		// `round` here would make the coarsest tile 106 pixels tall, which is a size no IIIF client
		// asks for, so every request for it would 404.
		for (const tile of tiles) {
			expect(tile.size.width).toBe(Math.ceil(tile.region.width / tile.scaleFactor));
			expect(tile.size.height).toBe(Math.ceil(tile.region.height / tile.scaleFactor));
			expect(tile.size.width).toBeLessThanOrEqual(PYRAMID_TILE_SIZE);
			expect(tile.size.height).toBeLessThanOrEqual(PYRAMID_TILE_SIZE);
		}
	});

	it('covers the whole image exactly once at every level', () => {
		const byLevel = new Map<number, typeof tiles>();
		for (const tile of tiles) {
			byLevel.set(tile.scaleFactor, [...(byLevel.get(tile.scaleFactor) ?? []), tile]);
		}
		for (const [scaleFactor, level] of byLevel) {
			const area = level.reduce((sum, tile) => sum + tile.region.width * tile.region.height, 0);
			expect(area, `scale factor ${scaleFactor} does not tile the image exactly`).toBe(
				FLORIDE.width * FLORIDE.height
			);
		}
	});

	it('writes tiles under the directory it was given', () => {
		for (const tile of tiles) {
			expect(tile.path.startsWith('images/floride-1657/')).toBe(true);
			expect(tile.path.endsWith('/0/default.jpg')).toBe(true);
		}
		expect(imageInfoPath('abc')).toBe('images/abc/info.json');
		expect(imageManifestPath('abc')).toBe('images/abc/manifest.json');
	});

	it('scales to tens of thousands of tiles without losing the invariant', () => {
		const big = buildImageInfo({ imageId: 'big', width: 41000, height: 29000 });
		const plan = planPyramid(big, imageDirectory('big'));
		expect(plan.length).toBeGreaterThan(20_000);
		expect(new Set(plan.map((tile) => tile.path)).size).toBe(plan.length);
		for (const tile of plan) {
			expect(tile.size.width).toBe(Math.ceil(tile.region.width / tile.scaleFactor));
			expect(tile.size.height).toBe(Math.ceil(tile.region.height / tile.scaleFactor));
		}
	});
});

describe('buildImageManifest', () => {
	const info = buildImageInfo({ imageId: 'floride-1657', ...FLORIDE });
	const manifest = buildImageManifest({ imageId: 'floride-1657', label: 'la-floride.jpg', info });

	it('parses as a IIIF Presentation 3 Manifest', () => {
		const parsed = Manifest.parse(manifest);
		expect(parsed.canvases).toHaveLength(1);
		expect(parsed.canvases[0]?.width).toBe(1200);
		expect(parsed.canvases[0]?.height).toBe(851);
	});

	it('carries the image service, so that a viewer which is not this app can tile it', () => {
		const parsed = Manifest.parse(manifest);
		const image = parsed.canvases[0]?.image;
		expect(image?.uri).toBe('https://unset.invalid/floride-1657');
		expect(image?.width).toBe(1200);
	});

	it('paints a body URL that the pyramid actually contains', () => {
		// Not `/full/max/`, which a level-0 service does not serve: the coarsest single tile.
		const body = manifest.items[0].items[0].items[0].body;
		expect(body.id).toBe('https://unset.invalid/floride-1657/0,0,1200,851/150,107/0/default.jpg');
		const planned = planPyramid(info, 'https://unset.invalid/floride-1657').map(
			(tile) => tile.path
		);
		expect(planned).toContain(body.id);
	});

	it('names the label without claiming a language for it', () => {
		expect(manifest.label).toEqual({ none: ['la-floride.jpg'] });
	});

	it('derives the whole-image derivative from the coarsest level', () => {
		expect(wholeImageDerivative(1200, 851)).toMatchObject({ width: 150, height: 107 });
		expect(wholeImageDerivative(100, 40)).toMatchObject({ width: 100, height: 40 });
	});
});

describe('imageSizeFromInfo', () => {
	it('reads the dimensions out of an info.json this build wrote', () => {
		const info = buildImageInfo({ imageId: 'abc123', width: 700, height: 500 });
		expect(imageSizeFromInfo(info)).toEqual({ width: 700, height: 500 });
	});

	it('reads a document carrying members this build has never heard of', () => {
		// The tolerance ADR-0010 asks for, in the direction that costs nothing: a newer build's
		// `info.json` still has to give a Map Image its starter Alignment.
		expect(imageSizeFromInfo({ width: 12, height: 9, sizes: [], somethingNew: true })).toEqual({
			width: 12,
			height: 9
		});
	});

	it('refuses anything that is not a pair of positive whole numbers', () => {
		// Every one of these would otherwise become a Resource Mask over a degenerate rectangle — an
		// Alignment that can never be solved, on a Layer that draws nothing and says nothing.
		for (const info of [
			null,
			undefined,
			'{"width":700,"height":500}',
			[700, 500],
			{},
			{ width: 700 },
			{ height: 500 },
			{ width: '700', height: '500' },
			{ width: 0, height: 500 },
			{ width: 700, height: 0 },
			{ width: -700, height: 500 },
			{ width: 700.5, height: 500 },
			{ width: Number.NaN, height: 500 },
			{ width: Number.POSITIVE_INFINITY, height: 500 }
		]) {
			expect(imageSizeFromInfo(info), JSON.stringify(info) ?? 'undefined').toBeNull();
		}
	});
});

describe('imageGeometryFromInfo', () => {
	it('reads the dimensions and the tile side out of an info.json this build wrote', () => {
		const info = buildImageInfo({ imageId: 'abc123', width: 700, height: 500 });
		expect(imageGeometryFromInfo(info)).toEqual({ width: 700, height: 500, tileSize: 256 });
	});

	it('reads the tile side the document declares rather than this build’s own', () => {
		// The whole reason this reader exists (ADR-0030). A pyramid on 512-pixel tiles has a different
		// coarsest scale factor, so a reader that assumed 256 would name a tile nothing ever wrote.
		const info = buildImageInfo({ imageId: 'abc123', width: 700, height: 500, tileSize: 512 });
		expect(imageGeometryFromInfo(info)).toEqual({ width: 700, height: 500, tileSize: 512 });
	});

	it('reads a document carrying members this build has never heard of', () => {
		expect(
			imageGeometryFromInfo({
				width: 12,
				height: 9,
				tiles: [{ width: 8, height: 8, scaleFactors: [1, 2], somethingNew: true }],
				somethingNew: true
			})
		).toEqual({ width: 12, height: 9, tileSize: 8 });
	});

	it('refuses a document that does not carry all three as positive whole numbers', () => {
		// Each of these costs a picture and nothing else. A guessed tile side would cost a broken box on
		// a card, which is worse than an honest blank: the sheet's own proportions are the thing a
		// scholar is recognising.
		const tiles = [{ width: 256, height: 256, scaleFactors: [1] }];
		for (const info of [
			null,
			undefined,
			'{"width":700,"height":500}',
			{},
			{ width: 700, height: 500 },
			{ width: 700, height: 500, tiles: [] },
			{ width: 700, height: 500, tiles: {} },
			{ width: 700, height: 500, tiles: [null] },
			{ width: 700, height: 500, tiles: [{ height: 256 }] },
			{ width: 700, height: 500, tiles: [{ width: '256' }] },
			{ width: 700, height: 500, tiles: [{ width: 0 }] },
			{ width: 700, height: 500, tiles: [{ width: -256 }] },
			{ width: 700, height: 500, tiles: [{ width: 256.5 }] },
			{ width: 700, height: 500, tiles: [{ width: Number.NaN }] },
			{ width: 0, height: 500, tiles },
			{ width: 700, tiles }
		]) {
			expect(imageGeometryFromInfo(info), JSON.stringify(info) ?? 'undefined').toBeNull();
		}
	});
});

describe('serialiseJson', () => {
	it('is tab-indented with a trailing newline, like project.json', () => {
		expect(new TextDecoder().decode(serialiseJson({ a: 1 }))).toBe('{\n\t"a": 1\n}\n');
	});
});
