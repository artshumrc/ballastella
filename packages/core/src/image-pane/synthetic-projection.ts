export type ResourcePoint = { x: number; y: number };

type SyntheticLngLat = { lng: number; lat: number };

type PyramidGeometry = {
	width: number;
	height: number;
	tileWidth: number;
	tileHeight: number;
	maxScaleFactor: number;
};

export type SyntheticProjection = {
	resourceToSynthetic(point: ResourcePoint): SyntheticLngLat;
	syntheticToResource(lngLat: SyntheticLngLat): ResourcePoint;
	readonly windowSize: number;
	readonly bounds: readonly [number, number, number, number];
	readonly minTileZoom: number;
	readonly maxTileZoom: number;
	readonly fullResolutionMapZoom: number;
	tileZoomFromScaleFactor(scaleFactor: number): number;
	scaleFactorFromTileZoom(tileZoom: number): number;
	tileGridOrigin(tileZoom: number): { x: number; y: number };
	mapZoomFromTileZoom(tileZoom: number): number;
};

export const WINDOW_TILE_ZOOM = 12;
const MAPLIBRE_MAX_TILE_ZOOM = 25;
export const ROUND_TRIP_TOLERANCE_PX = 1e-6;
const roundTripErrorPx = (windowSize: number) => windowSize * 2 ** (WINDOW_TILE_ZOOM - 54);
const WINDOW_FRACTION = 2 ** -WINDOW_TILE_ZOOM;
const WINDOW_ORIGIN = 0.5;
const mercatorXFromLng = (lng: number) => (180 + lng) / 360;
const mercatorYFromLat = (lat: number) =>
	(180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
const lngFromMercatorX = (x: number) => x * 360 - 180;
const latFromMercatorY = (y: number) =>
	(180 / Math.PI) * (2 * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - Math.PI / 2);

const isPowerOfTwo = (value: number) =>
	Number.isInteger(value) && value >= 1 && (value & (value - 1)) === 0;

export function createSyntheticProjection(pyramid: PyramidGeometry): SyntheticProjection {
	const { width, height, tileWidth, tileHeight, maxScaleFactor } = pyramid;

	if (!(width > 0) || !(height > 0)) {
		throw new Error(`Image dimensions must be positive, got ${width}×${height}.`);
	}
	if (tileWidth !== tileHeight) {
		throw new Error(
			`Tiles must be square to sit on the Web Mercator tile grid (ADR-0003), got ` +
				`${tileWidth}×${tileHeight}.`
		);
	}
	if (!isPowerOfTwo(maxScaleFactor)) {
		throw new Error(
			`The coarsest scale factor must be a power of two, got ${maxScaleFactor}. The XYZ ` +
				`grid halves at every zoom, so anything else cannot be aligned to it.`
		);
	}

	const maxTileZoom = WINDOW_TILE_ZOOM + Math.log2(maxScaleFactor);

	if (maxTileZoom > MAPLIBRE_MAX_TILE_ZOOM) {
		throw new Error(
			`The pyramid's finest level sits at tile zoom ${maxTileZoom}, past MapLibre's ` +
				`maximum tile zoom of ${MAPLIBRE_MAX_TILE_ZOOM}. Scale factor ${maxScaleFactor} is ` +
				`${maxTileZoom - MAPLIBRE_MAX_TILE_ZOOM} level(s) too deep: the deepest the window ` +
				`allows is ${2 ** (MAPLIBRE_MAX_TILE_ZOOM - WINDOW_TILE_ZOOM)}, a window of ` +
				`${tileWidth * 2 ** (MAPLIBRE_MAX_TILE_ZOOM - WINDOW_TILE_ZOOM)} image pixels. Past ` +
				`that MapLibre requests no tiles at all and reports a tile coordinate out of bounds, ` +
				`which says nothing about the pyramid it came from.`
		);
	}

	const windowSize = tileWidth * maxScaleFactor;

	if (roundTripErrorPx(windowSize) > ROUND_TRIP_TOLERANCE_PX) {
		throw new Error(
			`A window of ${windowSize} image pixels round-trips to no better than ` +
				`${roundTripErrorPx(windowSize).toExponential(2)} image pixels, past the documented ` +
				`tolerance of ${ROUND_TRIP_TOLERANCE_PX}. ${tileWidth}px tiles at scale factor ` +
				`${maxScaleFactor} are past what float64 can carry through a Mercator coordinate near ` +
				`0.5, and every caller of this projection is promised that tolerance.`
		);
	}

	if (windowSize < width || windowSize < height) {
		throw new Error(
			`The pyramid's coarsest level is not a single tile: ${tileWidth}px tiles at scale ` +
				`factor ${maxScaleFactor} span ${windowSize}px, which does not cover ${width}×` +
				`${height}. The synthetic window is that single tile, so the grid alignment the ` +
				`projection depends on would not hold.`
		);
	}

	const resourceToSynthetic = ({ x, y }: ResourcePoint): SyntheticLngLat => ({
		lng: lngFromMercatorX(WINDOW_ORIGIN + (x / windowSize) * WINDOW_FRACTION),
		lat: latFromMercatorY(WINDOW_ORIGIN + (y / windowSize) * WINDOW_FRACTION)
	});

	const syntheticToResource = ({ lng, lat }: SyntheticLngLat): ResourcePoint => ({
		x: ((mercatorXFromLng(lng) - WINDOW_ORIGIN) / WINDOW_FRACTION) * windowSize,
		y: ((mercatorYFromLat(lat) - WINDOW_ORIGIN) / WINDOW_FRACTION) * windowSize
	});

	const northWest = resourceToSynthetic({ x: 0, y: 0 });
	const southEast = resourceToSynthetic({ x: width, y: height });
	const mapZoomOffset = Math.log2(512 / tileWidth);

	return {
		resourceToSynthetic,
		syntheticToResource,
		windowSize,
		bounds: [northWest.lng, southEast.lat, southEast.lng, northWest.lat],
		minTileZoom: WINDOW_TILE_ZOOM,
		maxTileZoom,
		fullResolutionMapZoom: maxTileZoom - mapZoomOffset,
		tileZoomFromScaleFactor: (scaleFactor) => maxTileZoom - Math.log2(scaleFactor),
		scaleFactorFromTileZoom: (tileZoom) => 2 ** (maxTileZoom - tileZoom),
		tileGridOrigin: (tileZoom) => {
			const origin = 2 ** (tileZoom - 1);
			return { x: origin, y: origin };
		},
		mapZoomFromTileZoom: (tileZoom) => tileZoom - mapZoomOffset
	};
}
