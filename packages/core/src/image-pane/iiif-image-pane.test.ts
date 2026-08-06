import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createImagePane } from './iiif-image-pane';
import { ROUND_TRIP_TOLERANCE_PX, WINDOW_TILE_ZOOM } from './synthetic-projection';

// The fixture pyramid is committed where the editor serves it from, so the bytes this test
// reasons about are literally the bytes the browser fetches. Reading it here rather than
// restating its info.json is what keeps the two from drifting.
const fixtureDirectory = new URL(
	'../../../../apps/editor/static/fixtures/images/floride-1657/',
	import.meta.url
);

const fixtureBaseUri = 'https://example.test/fixtures/images/floride-1657';

const readInfoJson = () =>
	JSON.parse(readFileSync(new URL('info.json', fixtureDirectory), 'utf8')) as unknown;

const createFixturePane = () => createImagePane(readInfoJson(), fixtureBaseUri);

/** Every `default.jpg` in the committed pyramid, as a path relative to the image directory. */
const committedTilePaths = (): string[] => {
	const found: string[] = [];

	const walk = (directory: URL, prefix: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				walk(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
			} else if (entry.name === 'default.jpg') {
				found.push(`${prefix}${entry.name}`);
			}
		}
	};

	walk(fixtureDirectory, '');
	return found.sort();
};

/**
 * North-west corner of an XYZ tile, by the canonical slippy-map formulae. Deliberately not
 * the projection's own arithmetic: this is the independent statement of where MapLibre will
 * draw the tile, so that agreement between the two means something.
 */
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

		// Non-square, so a transposed width and height cannot pass unnoticed, and neither
		// dimension is a multiple of the tile size, so ragged edge tiles exist at both the
		// right and the bottom margin.
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

	it('carries the unset.invalid placeholder id, overridden at load time (ADR-0004)', () => {
		const info = readInfoJson() as { id: string };

		expect(info.id).toBe('https://unset.invalid/floride-1657');

		// The single most important invariant in the IIIF layer: `uri` is assigned before any
		// tile is requested, so no URL the pane builds can reach unset.invalid.
		const pane = createImagePane(info, fixtureBaseUri);
		expect(pane.image.uri).toBe(fixtureBaseUri);

		for (const tile of pane.allTiles()) {
			expect(tile.url.startsWith(`${fixtureBaseUri}/`)).toBe(true);
		}
	});

	it('contains exactly the tiles getTileImageRequest asks for, and no others', () => {
		const pane = createFixturePane();

		const requested = pane
			.allTiles()
			.map((tile) => tile.url.slice(`${fixtureBaseUri}/`.length))
			.sort();

		// Both directions. A missing file is a hole in the pane; an extra file means the
		// fixture was written by arithmetic that disagrees with the reader.
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
	it('maps every tile of every zoom level onto exactly one XYZ tile, and back', () => {
		const pane = createFixturePane();
		let tilesChecked = 0;

		for (const level of pane.image.tileZoomLevels) {
			const tileZoom = pane.projection.tileZoomFromScaleFactor(level.scaleFactor);
			const origin = pane.projection.tileGridOrigin(tileZoom);

			for (let row = 0; row < level.rows; row++) {
				for (let column = 0; column < level.columns; column++) {
					const xyz = { z: tileZoom, x: origin.x + column, y: origin.y + row };
					const tile = pane.tileAt(xyz);

					expect(tile).toBeDefined();
					expect([tile?.scaleFactor, tile?.column, tile?.row]).toEqual([
						level.scaleFactor,
						column,
						row
					]);
					tilesChecked++;
				}
			}
		}

		expect(tilesChecked).toBe(29);
	});

	it('lands every tile of every zoom level on its own pixel origin', () => {
		const pane = createFixturePane();
		const { syntheticToResource } = pane.projection;
		let worst = 0;

		// **This is the test that proves the projection is the right one.** Not the round-trips:
		// those compute f⁻¹(f(x)) == x, which is self-consistent by construction and would pass
		// for any bijection of the plane. This one is an independent statement, and the only one
		// in the suite that could fail while every round-trip still passed.
		//
		// `tileNorthWest` above is the canonical slippy-map form, `atan(sinh(π(1 − 2y/n)))` —
		// genuinely different algebra from `latFromMercatorY`'s `atan(exp(…))`, and MapLibre's own
		// view of where it will draw the tile. Requiring its output through `syntheticToResource`
		// to equal the IIIF region the tile was cut at is what catches a half-tile offset, an
		// off-by-one zoom, or a window that is not a whole tile — each of which renders a pane
		// that looks entirely plausible.
		//
		// It is also the assertion that is genuinely per-zoom-level, because `tileZoom` and
		// `tileGridOrigin` both vary with the level. It holds as an exact algebraic identity,
		// error 0; a `resourceToSynthetic` made linear in degrees instead of linear in Mercator
		// fails it by 3.1e-4 px against a 1e-6 tolerance.
		for (const level of pane.image.tileZoomLevels) {
			const tileZoom = pane.projection.tileZoomFromScaleFactor(level.scaleFactor);
			const origin = pane.projection.tileGridOrigin(tileZoom);

			for (let row = 0; row < level.rows; row++) {
				for (let column = 0; column < level.columns; column++) {
					const tile = pane.tileAt({ z: tileZoom, x: origin.x + column, y: origin.y + row });
					const corner = syntheticToResource(
						tileNorthWest(tileZoom, origin.x + column, origin.y + row)
					);

					worst = Math.max(
						worst,
						Math.abs(corner.x - (tile?.request.region.x ?? NaN)),
						Math.abs(corner.y - (tile?.request.region.y ?? NaN))
					);
				}
			}
		}

		console.log(`tile origin agreement: worst error ${worst.toExponential(2)}px`);
		expect(worst).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
	});

	it('is invertible over corners, centre and ragged edges at every zoom level', () => {
		// **This establishes invertibility only**, and the loop over `tileZoomLevels` varies the
		// point set rather than the behaviour: neither `resourceToSynthetic` nor
		// `syntheticToResource` takes a zoom argument, because `WINDOW_TILE_ZOOM` fixes one window
		// for the whole pyramid. That is the right design — a zoom-dependent projection is how
		// drift gets in — so this is not a gap, but it does mean the ticket's "at every zoom
		// level" criterion is carried by the tile-origin test above, not by this one.
		//
		// What the per-level point sets do buy is coverage of the places a *tile geometry* error
		// would show: each level's own ragged strip, sampled at that level's resolution.
		//
		// The logged worst error is 0 because every point here is an integer or a half-integer on
		// a 2048-pixel window, so `WINDOW_ORIGIN + t` comes out exact. The real magnitudes are in
		// `synthetic-projection.test.ts`'s window-size sweep, which samples off-grid on purpose.
		const pane = createFixturePane();
		const { resourceToSynthetic, syntheticToResource } = pane.projection;
		const { width, height } = pane.image;
		let worst = 0;
		let levelsChecked = 0;

		for (const level of pane.image.tileZoomLevels) {
			const cell = pane.tileSize * level.scaleFactor;

			const points = [
				// The four corners of the image and its centre.
				{ x: 0, y: 0 },
				{ x: width, y: 0 },
				{ x: 0, y: height },
				{ x: width, y: height },
				{ x: width / 2, y: height / 2 },
				// The ragged margins at this level: the first pixel of the last column and row,
				// and the midpoints of the ragged strips.
				{ x: (level.columns - 1) * cell, y: (level.rows - 1) * cell },
				{ x: ((level.columns - 1) * cell + width) / 2, y: height / 2 },
				{ x: width / 2, y: ((level.rows - 1) * cell + height) / 2 },
				// One point per pixel of the level's own resolution along both ragged strips,
				// which is where a rounding error in the level's tile geometry would show.
				...Array.from({ length: 32 }, (_, step) => ({
					x: width - step * level.scaleFactor,
					y: height - step * level.scaleFactor
				}))
			];

			// …and every tile corner and tile centre at this level.
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

		// The coarsest level is one tile covering the whole 1200×851 image at scale factor 8.
		// IIIF rounds the served size up to whole pixels — 851 / 8 is 106.375, served as 107 —
		// so drawing it at its served size would stretch the image vertically by 0.6%. The
		// placement is the unrounded size, which is where the content actually belongs.
		expect(single?.request.region).toEqual({ x: 0, y: 0, width: 1200, height: 851 });
		expect(single?.request.size).toEqual({ width: 150, height: 107 });
		expect(single?.placement).toEqual({ width: 150, height: 106.375 });

		// An interior tile needs no correction and fills its cell exactly.
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

		// Past the last column and the last row of the finest level.
		expect(pane.tileAt({ z: maxTileZoom, x: origin.x + 5, y: origin.y })).toBeUndefined();
		expect(pane.tileAt({ z: maxTileZoom, x: origin.x, y: origin.y + 4 })).toBeUndefined();
		// West and north of the window.
		expect(pane.tileAt({ z: maxTileZoom, x: origin.x - 1, y: origin.y })).toBeUndefined();
		expect(pane.tileAt({ z: maxTileZoom, x: origin.x, y: origin.y - 1 })).toBeUndefined();
		// Outside the zoom range the pyramid covers.
		expect(pane.tileAt({ z: minTileZoom - 1, x: 1024, y: 1024 })).toBeUndefined();
		expect(pane.tileAt({ z: maxTileZoom + 1, x: origin.x * 2, y: origin.y * 2 })).toBeUndefined();
	});

	it('refuses a pyramid whose scale factors are not contiguous powers of two', () => {
		const info = readInfoJson() as { tiles: { scaleFactors: number[] }[] };
		const gappy = {
			...info,
			tiles: [{ ...info.tiles[0], scaleFactors: [1, 2, 8] }]
		};

		// A missing intermediate level is a zoom at which the pane would render nothing, with
		// no error anywhere to say why.
		expect(() => createImagePane(gappy, fixtureBaseUri)).toThrow(/with no gaps/i);
	});

	it('refuses a pyramid whose finest level is not full resolution', () => {
		const info = readInfoJson() as { tiles: { scaleFactors: number[] }[] };
		// Contiguous powers of two, but starting at 2: `getTileImageRequest` is happy, and so is
		// the contiguity check, because [2, 4, 8] is 2 × 2**index.
		const coarseOnly = {
			...info,
			tiles: [{ ...info.tiles[0], scaleFactors: [2, 4, 8] }]
		};

		// Left unguarded this is a blank pane and a silent one. `maxTileZoom` comes off the
		// coarsest level, so it is 15, and `scaleFactorFromTileZoom(15)` is 1 — a level that does
		// not exist. Every tile request at the pane's own `fullResolutionMapZoom` misses, the tile
		// protocol answers a transparent tile by design, and "Zoom to full resolution" shows
		// nothing at all with nothing logged anywhere.
		expect(() => createImagePane(coarseOnly, fixtureBaseUri)).toThrow(/full resolution/i);
	});

	it('refuses a pyramid whose levels do not all use one tile size', () => {
		const info = readInfoJson() as { tiles: { width: number; scaleFactors: number[] }[] };
		// `@allmaps/iiif-parser` flattens several tilesets into one sorted list of levels, so a
		// perfectly legal `info.json` can offer scale factors [1, 2, 4, 8] where the coarse half
		// of them is cut into 512-pixel tiles. Sorted scale factors are contiguous, `levels[0]` is
		// square and 256 pixels, and every existing guard passes.
		const twoTilesets = {
			...info,
			tiles: [
				{ width: 256, height: 256, scaleFactors: [1, 2] },
				{ width: 512, height: 512, scaleFactors: [4, 8] }
			]
		};

		// Left unguarded this is the ticket's stated nightmare. A MapLibre raster source has one
		// `tileSize`, taken from `levels[0]`, so the scale-factor 4 and 8 levels are drawn into a
		// 256-pixel cell while covering 512 pixels' worth of image: correct at the tile origin and
		// progressively wrong away from it, at half scale, looking exactly like imprecision.
		expect(() => createImagePane(twoTilesets, fixtureBaseUri)).toThrow(/one tile size|same tile/i);
	});

	it('refuses a base URI that is still the unset.invalid placeholder', () => {
		expect(() => createImagePane(readInfoJson(), 'https://unset.invalid/floride-1657')).toThrow(
			/unset\.invalid/i
		);
	});

	it('takes the placeholder as the base only when the caller says the store holds the tiles', () => {
		// ADR-0011 makes the placeholder the routing key of the injection layer, so a pyramid read
		// out of the Project's own store really does answer on that host — and the string above is
		// still refused. The two are told apart by type rather than by value, because the value is
		// identical: `{ storedImageId }` is a decision, `info.id` passed through is a forgetting.
		const pane = createImagePane(readInfoJson(), { storedImageId: 'floride-1657' });

		expect(pane.image.uri).toBe('https://unset.invalid/floride-1657');
		expect(pane.allTiles()[0]?.url).toMatch(/^https:\/\/unset\.invalid\/floride-1657\//);
		// And it is still a real reader: the geometry does not depend on where the bytes come from.
		expect([pane.image.width, pane.image.height, pane.tileSize]).toEqual([1200, 851, 256]);
	});

	it('refuses info.id where a stored image id belongs, by name', () => {
		// The slip the type distinction above cannot catch, because the object form is the *correct*
		// form and only its contents are wrong. `{ storedImageId: info.id }` builds a base of
		// `https://unset.invalid/https://unset.invalid/floride-1657`, which the ADR-0011 shim
		// resolves to a path no pyramid is at — so every tile 404s and the pane is blank, which is
		// the failure mode ADR-0004 exists to make impossible.
		const info = readInfoJson() as { id: string };

		expect(() => createImagePane(info, { storedImageId: info.id })).toThrow(
			/not a stored image id/
		);
		expect(() => createImagePane(info, { storedImageId: 'images/floride-1657' })).toThrow(
			/not a stored image id/
		);
		// The message has to name the mistake rather than the symptom: what a caller got before was
		// a doubled host in a URL and a bare 404.
		expect(() => createImagePane(info, { storedImageId: info.id })).toThrow(/info\.id/);
	});
});
