import { Image, Manifest } from '@allmaps/iiif-parser';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { decode } from '../test-support.js';
import { imageDirectory, imageInfoPath, imageManifestPath } from '../project/image-files.js';
import { buildImageManifest, wholeImageDerivative } from './image-manifest.js';
import {
	IMAGE_SERVICE_PLACEHOLDER_ORIGIN,
	PYRAMID_TILE_SIZE,
	buildImageInfo,
	imageGeometryFromInfo,
	imageSizeFromInfo,
	planPyramid,
	pyramidScaleFactors
} from './pyramid.js';
import { serialiseJson } from '../store/project-store.js';

const FIXTURE_DIRECTORY = new URL(
	'../../../../apps/editor/static/fixtures/images/floride-1657/',
	import.meta.url
);

const fixtureInfo = JSON.parse(
	await readFile(new URL('info.json', FIXTURE_DIRECTORY), 'utf8')
) as Record<string, unknown>;

const FLORIDE = { width: 1200, height: 851 };

describe('pyramidScaleFactors', () => {
	it.each([
		['stops at the factor where the whole image is one tile', FLORIDE, [1, 2, 4, 8]],
		[
			'gives a 2 megapixel photograph a real pyramid rather than a shortcut',
			{ width: 1632, height: 1224 },
			[1, 2, 4, 8]
		],
		['still produces a level for an image smaller than one tile', { width: 100, height: 40 }, [1]]
	])('%s', (_, dimensions, factors) => {
		expect(pyramidScaleFactors(dimensions)).toEqual(factors);
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

	it('matches the committed fixture, under the unset.invalid placeholder id (ADR-0004)', () => {
		expect(info).toEqual(fixtureInfo);
		expect(info.id).toBe('https://unset.invalid/floride-1657');
		expect(IMAGE_SERVICE_PLACEHOLDER_ORIGIN).toBe('https://unset.invalid');
	});

	it('parses as an @allmaps/iiif-parser Image, with square tiles and no sizes array (ADR-0003)', () => {
		const image = Image.parse(info);
		expect([image.width, image.height]).toEqual([1200, 851]);
		expect(image.tileZoomLevels.map((level) => level.scaleFactor)).toEqual([1, 2, 4, 8]);
		expect(info.tiles).toHaveLength(1);
		expect(info.tiles[0].width).toBe(PYRAMID_TILE_SIZE);
		expect(info.tiles[0].height).toBe(PYRAMID_TILE_SIZE);
		expect(Object.keys(info)).not.toContain('sizes');
	});

	it.each([0, 10.5])('refuses a width of %s, which is not a positive integer', (width) => {
		expect(() => buildImageInfo({ imageId: 'x', width, height: 10 })).toThrow(/positive integers/);
	});
});

describe('planPyramid', () => {
	const info = buildImageInfo({ imageId: 'floride-1657', ...FLORIDE });
	const directory = imageDirectory('floride-1657');
	const tiles = planPyramid(info, directory);

	it('is exactly what getTileImageRequest describes, for every level, column and row', () => {
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
		expect(bottomRight?.region).toEqual({ x: 1024, y: 768, width: 176, height: 83 });
		expect(bottomRight?.size).toEqual({ width: 176, height: 83 });
		const coarsest = tiles.find((tile) => tile.scaleFactor === 8);
		expect(coarsest?.region).toEqual({ x: 0, y: 0, width: 1200, height: 851 });
		expect(coarsest?.size).toEqual({ width: 150, height: 107 });
		expect(Math.ceil(851 / 8)).toBe(107);
	});

	it('serves every tile under its directory at ceil(region ÷ scaleFactor) — never floor, never round', () => {
		for (const tile of tiles) {
			expect(tile.size.width).toBe(Math.ceil(tile.region.width / tile.scaleFactor));
			expect(tile.size.height).toBe(Math.ceil(tile.region.height / tile.scaleFactor));
			expect(tile.size.width).toBeLessThanOrEqual(PYRAMID_TILE_SIZE);
			expect(tile.size.height).toBeLessThanOrEqual(PYRAMID_TILE_SIZE);
			expect(tile.path.startsWith('images/floride-1657/')).toBe(true);
			expect(tile.path.endsWith('/0/default.jpg')).toBe(true);
		}
		expect(imageInfoPath('abc')).toBe('images/abc/info.json');
		expect(imageManifestPath('abc')).toBe('images/abc/manifest.json');
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

	it('parses as a IIIF Presentation 3 Manifest carrying the image service, and a language-free label', () => {
		const parsed = Manifest.parse(manifest);
		expect(parsed.canvases).toHaveLength(1);
		expect(parsed.canvases[0]?.width).toBe(1200);
		expect(parsed.canvases[0]?.height).toBe(851);
		expect(parsed.canvases[0]?.image?.uri).toBe('https://unset.invalid/floride-1657');
		expect(parsed.canvases[0]?.image?.width).toBe(1200);
		expect(manifest.label).toEqual({ none: ['la-floride.jpg'] });
	});

	it('paints a body URL that the pyramid actually contains', () => {
		const body = manifest.items[0].items[0].items[0].body;
		expect(body.id).toBe('https://unset.invalid/floride-1657/0,0,1200,851/150,107/0/default.jpg');
		const planned = planPyramid(info, 'https://unset.invalid/floride-1657').map(
			(tile) => tile.path
		);
		expect(planned).toContain(body.id);
	});

	it('derives the whole-image derivative from the coarsest level', () => {
		expect(wholeImageDerivative(1200, 851)).toMatchObject({ width: 150, height: 107 });
		expect(wholeImageDerivative(100, 40)).toMatchObject({ width: 100, height: 40 });
	});
});

describe('imageSizeFromInfo', () => {
	it('reads the dimensions out of an info.json, this build’s or one with members it never heard of', () => {
		const info = buildImageInfo({ imageId: 'abc123', width: 700, height: 500 });
		expect(imageSizeFromInfo(info)).toEqual({ width: 700, height: 500 });
		const unknown = { width: 12, height: 9, sizes: [], somethingNew: true };
		expect(imageSizeFromInfo(unknown)).toEqual({ width: 12, height: 9 });
	});

	it('refuses anything that is not a pair of positive whole numbers', () => {
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
	it.each([
		['this build wrote', buildImageInfo({ imageId: 'abc', width: 700, height: 500 }), 256],
		[
			'declaring its own tile side',
			buildImageInfo({ imageId: 'abc', width: 700, height: 500, tileSize: 512 }),
			512
		],
		[
			'carrying members this build has never heard of',
			{
				width: 700,
				height: 500,
				tiles: [{ width: 8, height: 8, scaleFactors: [1, 2], somethingNew: true }],
				somethingNew: true
			},
			8
		]
	])('reads the dimensions and the tile side out of an info.json %s', (_, info, tileSize) => {
		expect(imageGeometryFromInfo(info)).toEqual({ width: 700, height: 500, tileSize });
	});

	it('refuses a document that does not carry all three as positive whole numbers', () => {
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
		expect(decode(serialiseJson({ a: 1 }))).toBe('{\n\t"a": 1\n}\n');
	});
});
