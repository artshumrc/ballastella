import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { imageService3 } from '../test-support.js';
import { createImagePane } from './iiif-image-pane';
import { ROUND_TRIP_TOLERANCE_PX, WINDOW_TILE_ZOOM } from './synthetic-projection';

const fixtureDirectory = new URL(
	'../../../../apps/editor/static/fixtures/images/floride-1657/',
	import.meta.url
);

const fixtureBaseUri = 'https://example.test/fixtures/images/floride-1657';

const readInfoJson = () =>
	JSON.parse(readFileSync(new URL('info.json', fixtureDirectory), 'utf8')) as unknown;

const createFixturePane = () => createImagePane(readInfoJson(), fixtureBaseUri);

const committedTilePaths = (): string[] =>
	readdirSync(fixtureDirectory, { recursive: true, encoding: 'utf8' })
		.filter((path) => path.split('/').pop() === 'default.jpg')
		.sort();

const tileNorthWest = (z: number, x: number, y: number) => {
	const tiles = 2 ** z;
	return {
		lng: (x / tiles) * 360 - 180,
		lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / tiles))) * 180) / Math.PI
	};
};

describe('the committed fixture pyramid', () => {
	it('is a real level-0 pyramid with non-square dimensions and four scale factors', () => {
		const { image, tileSize } = createFixturePane();

		expect([image.width, image.height]).toEqual([1200, 851]);
		expect(tileSize).toBe(256);
		expect(image.width % tileSize).not.toBe(0);
		expect(image.height % tileSize).not.toBe(0);
		expect(image.tileZoomLevels.map((level) => level.scaleFactor)).toEqual([1, 2, 4, 8]);
		expect(
			image.tileZoomLevels.map(({ scaleFactor, columns, rows }) => [scaleFactor, columns, rows])
		).toEqual([
			[1, 5, 4],
			[2, 3, 2],
			[4, 2, 1],
			[8, 1, 1]
		]);
	});

	it('contains exactly the tiles asked for, under a placeholder id overridden at load time (ADR-0004)', () => {
		const info = readInfoJson() as { id: string };
		expect(info.id).toBe('https://unset.invalid/floride-1657');
		const pane = createImagePane(info, fixtureBaseUri);
		expect(pane.image.uri).toBe(fixtureBaseUri);

		for (const tile of pane.allTiles()) {
			expect(tile.url.startsWith(`${fixtureBaseUri}/`)).toBe(true);
		}
		const requested = pane
			.allTiles()
			.map((tile) => tile.url.slice(`${fixtureBaseUri}/`.length))
			.sort();
		expect(requested).toEqual(committedTilePaths());
		expect(requested).toHaveLength(29);
	});

	it('has ragged edge tiles at the right and bottom margins of every scale factor', () => {
		const pane = createFixturePane();

		for (const level of pane.image.tileZoomLevels) {
			const atLevel = pane.allTiles().filter((tile) => tile.scaleFactor === level.scaleFactor);
			const cell = pane.tileSize * level.scaleFactor;
			const raggedRight = atLevel.filter((tile) => tile.request.region.width < cell);
			const raggedBottom = atLevel.filter((tile) => tile.request.region.height < cell);
			expect(raggedRight.length).toBeGreaterThan(0);
			expect(raggedBottom.length).toBeGreaterThan(0);
		}
	});
});

describe('createImagePane tile grid', () => {
	const gridTiles = (pane: ReturnType<typeof createFixturePane>) =>
		pane.image.tileZoomLevels.flatMap((level) => {
			const z = pane.projection.tileZoomFromScaleFactor(level.scaleFactor);
			const origin = pane.projection.tileGridOrigin(z);
			return Array.from({ length: level.rows * level.columns }, (_, index) => {
				const [row, column] = [Math.floor(index / level.columns), index % level.columns];
				return { level, row, column, xyz: { z, x: origin.x + column, y: origin.y + row } };
			});
		});

	it('maps every tile of every zoom level onto exactly one XYZ tile and back, on its own pixel origin', () => {
		const pane = createFixturePane();
		const grid = gridTiles(pane);
		expect(grid).toHaveLength(29);
		let worst = 0;

		for (const { level, row, column, xyz } of grid) {
			const tile = pane.tileAt(xyz);
			expect([tile?.scaleFactor, tile?.column, tile?.row]).toEqual([
				level.scaleFactor,
				column,
				row
			]);
			const corner = pane.projection.syntheticToResource(tileNorthWest(xyz.z, xyz.x, xyz.y));
			worst = Math.max(
				worst,
				Math.abs(corner.x - (tile?.request.region.x ?? NaN)),
				Math.abs(corner.y - (tile?.request.region.y ?? NaN))
			);
		}

		console.log(`tile origin agreement: worst error ${worst.toExponential(2)}px`);
		expect(worst).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
	});

	it('is invertible over corners, centre and ragged edges at every zoom level', () => {
		const pane = createFixturePane();
		const { resourceToSynthetic, syntheticToResource } = pane.projection;
		const { width, height } = pane.image;
		let worst = 0;
		let levelsChecked = 0;

		for (const level of pane.image.tileZoomLevels) {
			const cell = pane.tileSize * level.scaleFactor;

			const points = [
				{ x: 0, y: 0 },
				{ x: width, y: 0 },
				{ x: 0, y: height },
				{ x: width, y: height },
				{ x: width / 2, y: height / 2 },
				{ x: (level.columns - 1) * cell, y: (level.rows - 1) * cell },
				{ x: ((level.columns - 1) * cell + width) / 2, y: height / 2 },
				{ x: width / 2, y: ((level.rows - 1) * cell + height) / 2 },
				...Array.from({ length: 32 }, (_, step) => ({
					x: width - step * level.scaleFactor,
					y: height - step * level.scaleFactor
				}))
			];

			for (let row = 0; row <= level.rows; row++) {
				for (let column = 0; column <= level.columns; column++) {
					points.push({ x: Math.min(column * cell, width), y: Math.min(row * cell, height) });
					points.push({
						x: Math.min(column * cell + cell / 2, width),
						y: Math.min(row * cell + cell / 2, height)
					});
				}
			}

			for (const point of points) {
				const returned = syntheticToResource(resourceToSynthetic(point));
				worst = Math.max(worst, Math.abs(returned.x - point.x), Math.abs(returned.y - point.y));
			}

			levelsChecked++;
		}

		console.log(`round-trip at every zoom level: worst error ${worst.toExponential(2)}px`);
		expect(levelsChecked).toBe(4);
		expect(worst).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
	});

	it('places a ragged tile at its true fractional size, not at the size it was served', () => {
		const pane = createFixturePane();
		const coarsest = pane.projection.tileGridOrigin(WINDOW_TILE_ZOOM);
		const single = pane.tileAt({ z: WINDOW_TILE_ZOOM, x: coarsest.x, y: coarsest.y });
		expect(single?.request.region).toEqual({ x: 0, y: 0, width: 1200, height: 851 });
		expect(single?.request.size).toEqual({ width: 150, height: 107 });
		expect(single?.placement).toEqual({ width: 150, height: 106.375 });

		const interior = pane.tileAt({
			z: pane.projection.maxTileZoom,
			x: pane.projection.tileGridOrigin(pane.projection.maxTileZoom).x,
			y: pane.projection.tileGridOrigin(pane.projection.maxTileZoom).y
		});
		expect(interior?.placement).toEqual({ width: 256, height: 256 });
	});

	it('has no tile outside the pyramid', () => {
		const pane = createFixturePane();
		const { minTileZoom, maxTileZoom } = pane.projection;
		const origin = pane.projection.tileGridOrigin(maxTileZoom);
		expect(pane.tileAt({ z: maxTileZoom, x: origin.x + 5, y: origin.y })).toBeUndefined();
		expect(pane.tileAt({ z: maxTileZoom, x: origin.x, y: origin.y + 4 })).toBeUndefined();
		expect(pane.tileAt({ z: maxTileZoom, x: origin.x - 1, y: origin.y })).toBeUndefined();
		expect(pane.tileAt({ z: maxTileZoom, x: origin.x, y: origin.y - 1 })).toBeUndefined();
		expect(pane.tileAt({ z: minTileZoom - 1, x: 1024, y: 1024 })).toBeUndefined();
		expect(pane.tileAt({ z: maxTileZoom + 1, x: origin.x * 2, y: origin.y * 2 })).toBeUndefined();
	});

	it.each([
		['scale factors are not contiguous powers of two', [[256, 1, 2, 8]], /with no gaps/i],
		['finest level is not full resolution', [[256, 2, 4, 8]], /full resolution/i],
		[
			'levels do not all use one tile size',
			[
				[256, 1, 2],
				[512, 4, 8]
			],
			/one tile size/i
		]
	])('refuses a pyramid whose %s', (_name, tilesets, refusal) => {
		const tiles = tilesets.map(([size, ...scaleFactors]) => ({
			width: size,
			height: size,
			scaleFactors
		}));

		expect(() => createImagePane({ ...(readInfoJson() as object), tiles }, fixtureBaseUri)).toThrow(
			refusal
		);
	});

	it('refuses a base URI that is still the unset.invalid placeholder', () => {
		expect(() => createImagePane(readInfoJson(), 'https://unset.invalid/floride-1657')).toThrow(
			/unset\.invalid/i
		);
	});

	it('takes the placeholder as the base only when the caller says the store holds the tiles', () => {
		const pane = createImagePane(readInfoJson(), { storedImageId: 'floride-1657' });
		expect(pane.image.uri).toBe('https://unset.invalid/floride-1657');
		expect(pane.allTiles()[0]?.url).toMatch(/^https:\/\/unset\.invalid\/floride-1657\//);
		expect([pane.image.width, pane.image.height, pane.tileSize]).toEqual([1200, 851, 256]);
	});

	it('refuses info.id where a stored image id belongs, by name', () => {
		const info = readInfoJson() as { id: string };

		for (const storedImageId of [info.id, 'images/floride-1657']) {
			expect(() => createImagePane(info, { storedImageId })).toThrow(/not a stored image id/);
		}
		expect(() => createImagePane(info, { storedImageId: info.id })).toThrow(/info\.id/);
	});
});

describe('a Library’s image service, aligned in place', () => {
	const service = 'https://library.example.test/iiif/3/sheet';

	const remoteInfo = (extra: Record<string, unknown>) =>
		imageService3({ id: service, width: 1200, height: 851, ...extra });

	const tiles = [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }];

	it('reads a level 2 service, and a level 0 one that publishes tiles identically, on the Library’s base', () => {
		const level2 = createImagePane(remoteInfo({ profile: 'level2', tiles }), service);
		expect([level2.image.width, level2.image.height, level2.tileSize]).toEqual([1200, 851, 256]);
		const urls = level2.allTiles().map((tile) => tile.url);
		expect(urls).not.toHaveLength(0);
		expect(urls.every((url) => url.startsWith(`${service}/`))).toBe(true);
		expect(urls.some((url) => url.includes('unset.invalid'))).toBe(false);

		const level0 = createImagePane(remoteInfo({ profile: 'level0', tiles }), service);

		expect(level0.allTiles().map((tile) => tile.url)).toEqual(
			level2.allTiles().map((tile) => tile.url)
		);
		expect(level0.projection.fullResolutionMapZoom).toBe(level2.projection.fullResolutionMapZoom);
	});

	it.each([{}, { sizes: [{ width: 1200, height: 851 }] }])(
		'refuses a level 0 service that publishes no tiles at all: %j',
		(extra) => {
			expect(() => createImagePane(remoteInfo({ profile: 'level0', ...extra }), service)).toThrow(
				/does not support tiles or custom regions and sizes/i
			);
		}
	);

	it('keeps the Library’s base out of the store, and the store’s base off the network', () => {
		const remote = createImagePane(remoteInfo({ profile: 'level2', tiles }), service);
		const stored = createImagePane(remoteInfo({ profile: 'level2', tiles }), {
			storedImageId: 'sheet'
		});

		expect(remote.image.uri).toBe(service);
		expect(stored.image.uri).toBe('https://unset.invalid/sheet');
		expect(stored.allTiles()).toHaveLength(remote.allTiles().length);
	});
});
