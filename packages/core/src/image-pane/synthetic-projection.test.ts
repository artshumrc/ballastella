import { describe, expect, it } from 'vitest';

import {
	ROUND_TRIP_TOLERANCE_PX,
	WINDOW_TILE_ZOOM,
	createSyntheticProjection
} from './synthetic-projection';

// The fixture pyramid's geometry, restated as plain numbers. `iiif-image-pane.test.ts`
// asserts that the committed fixture really has these, so the two cannot drift.
const fixture = {
	width: 1200,
	height: 851,
	tileWidth: 256,
	tileHeight: 256,
	maxScaleFactor: 8
};

describe('createSyntheticProjection', () => {
	it('puts image pixel 0,0 at exactly 0°, 0°', () => {
		const { resourceToSynthetic } = createSyntheticProjection(fixture);

		// Not "within a tolerance" — exactly. The window is the Web Mercator tile whose
		// north-west corner is the intersection of the equator and the prime meridian, so
		// this is the one assertion in the projection that can be made on equality.
		expect(resourceToSynthetic({ x: 0, y: 0 })).toEqual({ lng: 0, lat: 0 });
	});

	it('places the whole image inside a window under a tenth of a degree across', () => {
		const { bounds } = createSyntheticProjection(fixture);
		const [west, south, east, north] = bounds;

		// The window is 360 / 2 ** WINDOW_TILE_ZOOM degrees of longitude wide, and the image
		// occupies the top-left of it. Recorded as an assertion because the whole argument
		// for negligible Mercator distortion rests on the window being this small.
		const windowSpan = 360 / 2 ** WINDOW_TILE_ZOOM;
		expect(windowSpan).toBeCloseTo(0.0879, 4);
		expect(west).toBe(0);
		expect(north).toBe(0);
		expect(east).toBeGreaterThan(0);
		expect(east).toBeLessThan(windowSpan);
		expect(south).toBeLessThan(0);
		expect(south).toBeGreaterThan(-windowSpan);
	});

	it('draws the image at an exactly uniform scale, with no stretch anywhere', () => {
		const { resourceToSynthetic } = createSyntheticProjection(fixture);

		// The rendered scale is what a contributor will worry about, so assert on it directly
		// rather than on sec(latitude). MapLibre's screen transform is affine in Mercator at
		// pitch 0 and a raster tile's texture is interpolated linearly across its Mercator cell,
		// so "how much is the image stretched on screen" *is* "how much does the Mercator
		// distance per image pixel vary". Answer: not at all — bit-identical, not merely close,
		// because `resourceToSynthetic` is linear in Mercator by construction.
		const mercatorY = (lat: number) =>
			(180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
		const stepAt = (y: number) =>
			mercatorY(resourceToSynthetic({ x: 0, y: y + 1 }).lat) -
			mercatorY(resourceToSynthetic({ x: 0, y }).lat);

		const atTop = stepAt(0);
		for (let y = 0; y < fixture.height; y++) {
			expect(stepAt(y)).toBe(atTop);
		}
	});

	it('keeps degrees of latitude within two parts per million of Mercator y', () => {
		const projection = createSyntheticProjection(fixture);

		// sec(latitude) is *not* an on-screen stretch — see the test above. It is how far degrees
		// of latitude have parted company with Mercator y over this window, and the only reason
		// to bound it is to record how small the window is. What it would cost to get wrong is
		// asserted below, in image pixels, which is the unit that means something here.
		const [, south] = projection.bounds;
		const parting = 1 / Math.cos((south * Math.PI) / 180) - 1;

		expect(parting).toBeLessThan(2e-6);

		// The cost of conflating the two: a `resourceToSynthetic` whose latitude was linear in
		// image y instead of linear in Mercator. Two orders of magnitude past the tolerance, and
		// the reason the mapping is defined in Mercator — asserted so that "the distortion is
		// negligible" can never be read as "so degrees would have done".
		const north = projection.resourceToSynthetic({ x: 0, y: 0 }).lat;
		const bottom = projection.resourceToSynthetic({ x: 0, y: fixture.height }).lat;
		let worstLinearInDegrees = 0;

		for (let step = 0; step <= 1000; step++) {
			const fraction = step / 1000;
			const linearLat = north + (bottom - north) * fraction;
			const trueY = projection.syntheticToResource({ lng: 0, lat: linearLat }).y;

			worstLinearInDegrees = Math.max(
				worstLinearInDegrees,
				Math.abs(trueY - fraction * fixture.height)
			);
		}

		expect(worstLinearInDegrees).toBeGreaterThan(20 * ROUND_TRIP_TOLERANCE_PX);
		expect(worstLinearInDegrees).toBeLessThan(1e-4);
	});

	it('maps equal distances in x and y to equal distances in Mercator space', () => {
		const { resourceToSynthetic } = createSyntheticProjection(fixture);

		// A transposed width/height, or a window sized from one axis only, would show up as
		// an anisotropic scale here. Compared in Mercator space rather than in degrees,
		// because degrees of latitude are deliberately not linear in image y.
		const mercatorY = (lat: number) =>
			(180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

		const origin = resourceToSynthetic({ x: 0, y: 0 });
		const alongX = resourceToSynthetic({ x: 800, y: 0 });
		const alongY = resourceToSynthetic({ x: 0, y: 800 });

		const dx = (alongX.lng - origin.lng) / 360;
		const dy = mercatorY(alongY.lat) - mercatorY(origin.lat);

		expect(dy / dx).toBeCloseTo(1, 12);
	});

	it('is monotonic: x grows eastward and y grows southward', () => {
		const { resourceToSynthetic } = createSyntheticProjection(fixture);

		const a = resourceToSynthetic({ x: 100, y: 100 });
		const b = resourceToSynthetic({ x: 200, y: 200 });

		expect(b.lng).toBeGreaterThan(a.lng);
		expect(b.lat).toBeLessThan(a.lat);
	});

	it('is invertible over the corners, the centre and the ragged edges', () => {
		// **This establishes invertibility and nothing more.** It computes f⁻¹(f(x)) == x, which
		// is self-consistent by construction: it would pass unchanged if both functions were
		// composed with any bijection of the plane, so it cannot tell you the mapping is the
		// *right* one. What it does buy is a bound on the arithmetic — see
		// `ROUND_TRIP_TOLERANCE_PX` — and that is worth having, because drift is what this pane
		// fails by.
		//
		// The test that anchors the mapping to MapLibre's grid is "lands every tile of every zoom
		// level on its own pixel origin" in `iiif-image-pane.test.ts`, which uses different
		// algebra and asserts an exact identity.
		const { resourceToSynthetic, syntheticToResource } = createSyntheticProjection(fixture);
		const { width, height } = fixture;

		const points = [
			{ x: 0, y: 0 },
			{ x: width, y: 0 },
			{ x: 0, y: height },
			{ x: width, y: height },
			{ x: width / 2, y: height / 2 },
			// The ragged margins: the first pixel past the last full tile column and row.
			{ x: 1024, y: 768 },
			{ x: 1199.5, y: 850.5 },
			{ x: 1112, y: 809.5 }
		];

		for (const point of points) {
			const returned = syntheticToResource(resourceToSynthetic(point));

			expect(Math.abs(returned.x - point.x)).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
			expect(Math.abs(returned.y - point.y)).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
		}
	});

	it('round-trips within the tolerance at every window size the pane will accept', () => {
		// The tolerance has to hold for a real archival scan, not only for a 1200-pixel fixture,
		// because the error is proportional to the window — see `ROUND_TRIP_TOLERANCE_PX`.
		//
		// Sampling matters here, and the obvious scheme hides the effect. A grid at
		// `width * i / steps` lands on dyadic rationals, and `x / windowSize * WINDOW_FRACTION`
		// is then an exact power-of-two scaling, so `WINDOW_ORIGIN + t` comes out exact and the
		// one rounding this whole tolerance is about never happens. That is how the earlier
		// version of this test logged Δy 0 for the 60000×24000 pyramid whose true worst case is
		// 1.5e-8 — harmless for the assertion, misleading in the CI log the test exists to print.
		// `sampleFraction` below is deliberately not a dyadic rational.
		const pyramids = [
			{ label: 'fixture, 1200×851, 256px tiles, coarsest scale factor 8', ...fixture },
			{
				label: 'archival scan, 60000×24000, 256px tiles, coarsest scale factor 256',
				width: 60_000,
				height: 24_000,
				tileWidth: 256,
				tileHeight: 256,
				maxScaleFactor: 256
			},
			{
				label: 'very large scan, 65536×40000, 512px tiles, coarsest scale factor 128',
				width: 65_536,
				height: 40_000,
				tileWidth: 512,
				tileHeight: 512,
				maxScaleFactor: 128
			},
			{
				// The deepest pyramid `createSyntheticProjection` will accept at all: tile zoom 25,
				// a window of 2**22 image pixels. This is where the tolerance is tightest.
				label: 'the ceiling, 4194304×4194304, 512px tiles, coarsest scale factor 8192',
				width: 4_194_304,
				height: 4_194_304,
				tileWidth: 512,
				tileHeight: 512,
				maxScaleFactor: 8192
			}
		];

		const steps = 400;
		const sampleFraction = (index: number) => ((index * 2_654_435_761) % 1_000_003) / 1_000_003;

		for (const pyramid of pyramids) {
			const { resourceToSynthetic, syntheticToResource, windowSize } =
				createSyntheticProjection(pyramid);
			let worstX = 0;
			let worstY = 0;

			for (let i = 0; i <= steps; i++) {
				for (let j = 0; j <= steps; j++) {
					const point = {
						x: pyramid.width * sampleFraction(i),
						y: pyramid.height * sampleFraction(j + steps + 1)
					};
					const returned = syntheticToResource(resourceToSynthetic(point));

					worstX = Math.max(worstX, Math.abs(returned.x - point.x));
					worstY = Math.max(worstY, Math.abs(returned.y - point.y));
				}
			}

			const predicted = windowSize * 2 ** -42;

			console.log(
				`${pyramid.label}: worst round-trip error ` +
					`Δx ${worstX.toExponential(2)}px, Δy ${worstY.toExponential(2)}px ` +
					`(predicted ${predicted.toExponential(2)}px, ` +
					`${(ROUND_TRIP_TOLERANCE_PX / Math.max(worstX, worstY)).toFixed(1)}× headroom)`
			);

			expect(worstX).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
			expect(worstY).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
			// The scaling law itself, not merely the bound: the error is one rounding of a
			// Mercator coordinate near 0.5, so it is exactly `windowSize * 2 ** -42` and neither
			// grows nor shrinks for any other reason. Pinning it is what makes the tolerance's
			// headroom a statement about all supported pyramids rather than about these four.
			expect(Math.max(worstX, worstY)).toBeLessThanOrEqual(predicted);
			expect(Math.max(worstX, worstY)).toBeGreaterThan(predicted / 2);
		}
	});

	it('refuses a window so large that the documented tolerance would not hold', () => {
		// 1024-pixel tiles are legal IIIF, and at scale factor 8192 they sit at tile zoom 25 —
		// inside MapLibre's addressing limit — but span a window of 2**23 image pixels, where
		// `windowSize * 2 ** -42` is 1.9e-6 and the documented tolerance is 1e-6. Refused rather
		// than silently exceeded, because `ROUND_TRIP_TOLERANCE_PX` is what every caller is
		// promised and the overshoot would be invisible.
		expect(() =>
			createSyntheticProjection({
				width: 1,
				height: 1,
				tileWidth: 1024,
				tileHeight: 1024,
				maxScaleFactor: 8192
			})
		).toThrow(/tolerance/i);

		// Half that window is the largest that holds, and it must be accepted.
		const largest = createSyntheticProjection({
			width: 1,
			height: 1,
			tileWidth: 512,
			tileHeight: 512,
			maxScaleFactor: 8192
		});
		expect(largest.windowSize).toBe(2 ** 22);
		expect(largest.windowSize * 2 ** -42).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
	});

	it('does not accept a transposed width and height as equivalent', () => {
		const upright = createSyntheticProjection(fixture);
		const transposed = createSyntheticProjection({
			...fixture,
			width: fixture.height,
			height: fixture.width
		});

		expect(transposed.bounds).not.toEqual(upright.bounds);
	});

	it('refuses a pyramid whose coarsest level is more than one tile', () => {
		// maxScaleFactor 2 over a 1200-pixel image leaves a 512-pixel window: the grid
		// alignment the whole projection depends on would silently not hold.
		expect(() => createSyntheticProjection({ ...fixture, maxScaleFactor: 2 })).toThrow(
			/single tile/i
		);
	});

	it('refuses a maximum scale factor that is not a power of two', () => {
		expect(() => createSyntheticProjection({ ...fixture, maxScaleFactor: 3 })).toThrow(
			/power of two/i
		);
	});

	it('refuses non-square tiles', () => {
		expect(() => createSyntheticProjection({ ...fixture, tileHeight: 512 })).toThrow(/square/i);
	});

	it('refuses a pyramid deeper than MapLibre can address a tile', () => {
		// MapLibre's hard ceiling is on *tile* zoom, not on map zoom: `MAX_TILE_ZOOM` is 25 and
		// `CanonicalTileID` throws for anything past it. Verified in a real browser against
		// maplibre-gl 5.24.0 — a raster source with `maxzoom: 26` produces
		//   pageerror: x=33554432, y=33554432, z=26 outside of bounds. … 0<=z<=25
		// and requests no tiles at all, so the pane is blank and the message says nothing about a
		// pyramid. That is a diagnosis this module can hand over instead.
		const beyond = { ...fixture, width: 1, height: 1, maxScaleFactor: 2 ** 14 };
		expect(() => createSyntheticProjection(beyond)).toThrow(/tile zoom/i);

		// One level shallower is the deepest pyramid the pane supports, and it must be accepted:
		// tile zoom 25 exactly, a window 2 097 152 image pixels on a side.
		const deepest = createSyntheticProjection({ ...fixture, width: 1, height: 1, maxScaleFactor: 2 ** 13 });
		expect(deepest.maxTileZoom).toBe(25);
		expect(deepest.windowSize).toBe(2_097_152);
	});

	it('reports the map zoom range the pyramid covers', () => {
		const projection = createSyntheticProjection(fixture);

		// Tile zoom: the coarsest level is the window itself, one tile at WINDOW_TILE_ZOOM,
		// and each halving of the scale factor is one zoom deeper.
		expect(projection.minTileZoom).toBe(WINDOW_TILE_ZOOM);
		expect(projection.maxTileZoom).toBe(WINDOW_TILE_ZOOM + 3);

		// Map zoom: MapLibre defines zoom against 512-pixel tiles, so a 256-pixel pyramid
		// renders one map zoom shallower than its tile zoom.
		expect(projection.mapZoomFromTileZoom(WINDOW_TILE_ZOOM)).toBe(WINDOW_TILE_ZOOM - 1);
		expect(projection.fullResolutionMapZoom).toBe(WINDOW_TILE_ZOOM + 3 - 1);
	});

	it('renders one image pixel per map pixel at the full-resolution map zoom', () => {
		const projection = createSyntheticProjection(fixture);

		// **One of the three tests that anchor the projection to something outside itself.** The
		// 512-pixel world is MapLibre's convention, not ours, and it is stated here as an
		// external fact: MapLibre's world is 512 * 2 ** mapZoom pixels across, and the window is
		// one tile of 2 ** WINDOW_TILE_ZOOM. If this ratio is not 1 the pane is showing a
		// resampled image at what it calls full resolution — and every round-trip assertion in
		// this file would still pass, because a uniform scale error is a bijection.
		//
		// The same fact is pinned in real screen pixels by the browser test "pans by the distance
		// the pointer moved", and the mapping's *placement* by the tile-origin test in
		// `iiif-image-pane.test.ts`.
		const worldPixels = 512 * 2 ** projection.fullResolutionMapZoom;
		const windowPixels = worldPixels / 2 ** WINDOW_TILE_ZOOM;

		expect(windowPixels / projection.windowSize).toBe(1);
	});
});
