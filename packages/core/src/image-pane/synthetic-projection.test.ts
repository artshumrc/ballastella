import { describe, expect, it } from 'vitest';

import {
	ROUND_TRIP_TOLERANCE_PX,
	WINDOW_TILE_ZOOM,
	createSyntheticProjection
} from './synthetic-projection';

const fixture = { width: 1200, height: 851, tileWidth: 256, tileHeight: 256, maxScaleFactor: 8 };

const pyramid = (width: number, height: number, tile: number, maxScaleFactor: number) => ({
	width,
	height,
	tileWidth: tile,
	tileHeight: tile,
	maxScaleFactor
});

const mercatorY = (lat: number) =>
	(180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

describe('createSyntheticProjection', () => {
	it('puts image pixel 0,0 at exactly 0°, 0°', () => {
		const { resourceToSynthetic } = createSyntheticProjection(fixture);

		expect(resourceToSynthetic({ x: 0, y: 0 })).toEqual({ lng: 0, lat: 0 });
	});

	it('places the whole image inside a window under a tenth of a degree across', () => {
		const { bounds } = createSyntheticProjection(fixture);
		const [west, south, east, north] = bounds;

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

		const [, south] = projection.bounds;
		const parting = 1 / Math.cos((south * Math.PI) / 180) - 1;
		expect(parting).toBeLessThan(2e-6);
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
		const { resourceToSynthetic, syntheticToResource } = createSyntheticProjection(fixture);
		const { width, height } = fixture;

		const points = [
			{ x: 0, y: 0 },
			{ x: width, y: 0 },
			{ x: 0, y: height },
			{ x: width, y: height },
			{ x: width / 2, y: height / 2 },
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
		const pyramids = [
			{ label: 'fixture, 1200×851, 256px tiles, coarsest scale factor 8', ...fixture },
			{
				label: 'archival scan, 60000×24000, 256px tiles, coarsest scale factor 256',
				...pyramid(60_000, 24_000, 256, 256)
			},
			{
				label: 'very large scan, 65536×40000, 512px tiles, coarsest scale factor 128',
				...pyramid(65_536, 40_000, 512, 128)
			},
			{
				label: 'the ceiling, 4194304×4194304, 512px tiles, coarsest scale factor 8192',
				...pyramid(4_194_304, 4_194_304, 512, 8192)
			}
		];

		const steps = 400;
		const sampleFraction = (index: number) => ((index * 2_654_435_761) % 1_000_003) / 1_000_003;

		for (const sampled of pyramids) {
			const { resourceToSynthetic, syntheticToResource, windowSize } =
				createSyntheticProjection(sampled);
			let worstX = 0;
			let worstY = 0;

			for (let i = 0; i <= steps; i++) {
				for (let j = 0; j <= steps; j++) {
					const point = {
						x: sampled.width * sampleFraction(i),
						y: sampled.height * sampleFraction(j + steps + 1)
					};
					const returned = syntheticToResource(resourceToSynthetic(point));
					worstX = Math.max(worstX, Math.abs(returned.x - point.x));
					worstY = Math.max(worstY, Math.abs(returned.y - point.y));
				}
			}

			const predicted = windowSize * 2 ** -42;

			console.log(
				`${sampled.label}: worst round-trip error ` +
					`Δx ${worstX.toExponential(2)}px, Δy ${worstY.toExponential(2)}px ` +
					`(predicted ${predicted.toExponential(2)}px, ` +
					`${(ROUND_TRIP_TOLERANCE_PX / Math.max(worstX, worstY)).toFixed(1)}× headroom)`
			);

			expect(worstX).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
			expect(worstY).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
			expect(Math.max(worstX, worstY)).toBeLessThanOrEqual(predicted);
			expect(Math.max(worstX, worstY)).toBeGreaterThan(predicted / 2);
		}
	});

	it('refuses a window so large that the documented tolerance would not hold', () => {
		expect(() => createSyntheticProjection(pyramid(1, 1, 1024, 8192))).toThrow(/tolerance/i);
		const largest = createSyntheticProjection(pyramid(1, 1, 512, 8192));
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

	it.each([
		['a pyramid whose coarsest level is more than one tile', { maxScaleFactor: 2 }, /single tile/i],
		['a maximum scale factor that is not a power of two', { maxScaleFactor: 3 }, /power of two/i],
		['non-square tiles', { tileHeight: 512 }, /square/i]
	])('refuses %s', (_name, change, refusal) => {
		expect(() => createSyntheticProjection({ ...fixture, ...change })).toThrow(refusal);
	});

	it('refuses a pyramid deeper than MapLibre can address a tile', () => {
		const beyond = { ...fixture, width: 1, height: 1, maxScaleFactor: 2 ** 14 };
		expect(() => createSyntheticProjection(beyond)).toThrow(/tile zoom/i);

		const deepest = createSyntheticProjection({
			...fixture,
			width: 1,
			height: 1,
			maxScaleFactor: 2 ** 13
		});
		expect(deepest.maxTileZoom).toBe(25);
		expect(deepest.windowSize).toBe(2_097_152);
	});

	it('reports the map zoom range the pyramid covers, one image pixel per map pixel at full resolution', () => {
		const projection = createSyntheticProjection(fixture);
		expect(projection.minTileZoom).toBe(WINDOW_TILE_ZOOM);
		expect(projection.maxTileZoom).toBe(WINDOW_TILE_ZOOM + 3);
		expect(projection.mapZoomFromTileZoom(WINDOW_TILE_ZOOM)).toBe(WINDOW_TILE_ZOOM - 1);
		expect(projection.fullResolutionMapZoom).toBe(WINDOW_TILE_ZOOM + 3 - 1);
		const worldPixels = 512 * 2 ** projection.fullResolutionMapZoom;
		const windowPixels = worldPixels / 2 ** WINDOW_TILE_ZOOM;
		expect(windowPixels / projection.windowSize).toBe(1);
	});
});
