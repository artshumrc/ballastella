// The image pane's synthetic projection: image pixel space ↔ a small geographic window.
//
// MapLibre GL is Web Mercator only (ADR-0005), so the image pane cannot simply declare a
// pixel coordinate system the way Leaflet's `CRS.Simple` does. Image pixels are mapped into
// a geographic window instead, and a Control Point placed in the pane is recovered as the
// image pixel it came from through `syntheticToResource`.
//
// The failure mode this file exists to prevent is silent: a mapping that is very nearly
// right produces Control Points that drift as the user zooms, which reads as imprecision
// rather than as a bug and would poison every Alignment made with the tool. Hence the
// numeric round-trip assertions in `synthetic-projection.test.ts` and
// `iiif-image-pane.test.ts`, at every zoom level the pyramid offers.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE WINDOW, AND WHY THESE CONSTANTS
//
// The window is exactly **one tile of the Web Mercator tile grid at zoom 12** — the tile
// whose north-west corner is the intersection of the equator and the prime meridian. The
// image occupies the top-left of that square. This looks arbitrary and is not. Four things
// are being bought:
//
// 1. **The pyramid's tile grid coincides with MapLibre's XYZ grid.** One tile at zoom 12
//    subdivides into exactly 2**k tiles at zoom 12+k, which is the same halving the IIIF
//    `scaleFactors` do. So IIIF tile (scaleFactor 2**j, column c, row r) *is* an XYZ tile,
//    with no resampling and no fractional offset. An arbitrary rectangle for a window would
//    put every tile boundary between MapLibre's cells, and the ragged edge tiles at the
//    right and bottom margins would land in visibly wrong places.
//
// 2. **Image pixel (0, 0) is exactly 0°, 0°.** Not nearly: exactly. That is an invariant a
//    test can assert on equality rather than on a tolerance, and it keeps every coordinate
//    the pane produces a small number either side of zero, where float64 has the most room.
//
// 3. **Mercator distortion is negligible.** The window spans 360 / 2**12 = 0.087890625° of
//    longitude. Mercator stretches north-south by sec(latitude), so the bottom edge of the
//    window is stretched about 1.2 parts per million relative to the top: 0.0014 image
//    pixels over this fixture, 0.08 over a 65 536-pixel scan. It never enters the
//    round-trip, which inverts the same transcendental exactly; it is only how much the
//    bottom of the image is stretched on screen.
//
// 4. **There is zoom headroom left.** The deepest map zoom the pane needs is
//    12 + log2(maxScaleFactor) - log2(512 / tileWidth). MapLibre's own ceiling is 24, which
//    leaves room for a pyramid with maxScaleFactor 2**12 — an image a million pixels on a
//    side, far past anything real.
//
// A shallower window zoom (a larger window) buys nothing and costs distortion; a deeper one
// costs map zoom levels. Twelve is the middle of that trade.
//
// **Do not "clean up" `WINDOW_TILE_ZOOM`.** Changing it changes every lng/lat the pane
// produces. Alignments are stored as image pixels so committed work survives, but the value
// has to stay a whole tile zoom or the grid alignment in (1) silently stops holding — and
// nothing about the pane will look wrong when it does.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE MAPPING IS LINEAR IN MERCATOR, NOT IN DEGREES
//
// Image pixels map linearly onto normalised Web Mercator coordinates, and only then to
// lng/lat. That is deliberate twice over: MapLibre draws Mercator linearly on screen, so a
// linear-in-Mercator image is drawn undistorted, and the XYZ grid is uniform in Mercator, so
// the tiles land on cell boundaries. Latitude is therefore *not* linear in image y, which is
// exactly where the 1.2 ppm in (3) comes from.

/** A point in image pixel space — the IIIF Georeference Extension's "resource" coordinates. */
export type ResourcePoint = { x: number; y: number };

/** A point in the synthetic geographic window. */
export type SyntheticLngLat = { lng: number; lat: number };

/**
 * The pyramid geometry the projection needs, as plain numbers so that this module stays
 * free of IIIF. `iiif-image-pane.ts` reads these off a parsed `Image`.
 */
export type PyramidGeometry = {
	/** Width of the Historical Map image, in pixels. */
	width: number;
	/** Height of the Historical Map image, in pixels. */
	height: number;
	tileWidth: number;
	tileHeight: number;
	/** The coarsest level's scale factor — the level that is a single tile. */
	maxScaleFactor: number;
};

export type SyntheticProjection = {
	resourceToSynthetic(point: ResourcePoint): SyntheticLngLat;
	syntheticToResource(lngLat: SyntheticLngLat): ResourcePoint;

	/** Side of the square synthetic window, in image pixels: `tileWidth * maxScaleFactor`. */
	readonly windowSize: number;
	/** The image's extent as `[west, south, east, north]`, ready for a MapLibre source. */
	readonly bounds: readonly [number, number, number, number];

	/** Tile-grid zoom of the coarsest level — always `WINDOW_TILE_ZOOM`. */
	readonly minTileZoom: number;
	/** Tile-grid zoom of the finest level in the pyramid. */
	readonly maxTileZoom: number;
	/** Map zoom at which one image pixel covers one map pixel. */
	readonly fullResolutionMapZoom: number;

	tileZoomFromScaleFactor(scaleFactor: number): number;
	scaleFactorFromTileZoom(tileZoom: number): number;
	/** North-west corner of the tile grid at `tileZoom`, in XYZ tile coordinates. */
	tileGridOrigin(tileZoom: number): { x: number; y: number };
	/**
	 * MapLibre states zoom against 512-pixel tiles, so a pyramid of 256-pixel tiles renders
	 * one map zoom shallower than its tile zoom.
	 */
	mapZoomFromTileZoom(tileZoom: number): number;
};

/**
 * Zoom of the Web Mercator tile grid whose single tile is the synthetic window. See the
 * reasoning at the top of this file before changing it — the constant is load-bearing.
 */
export const WINDOW_TILE_ZOOM = 12;

/**
 * Documented round-trip tolerance, in image pixels.
 *
 * Measured over a dense grid: 4.5e-10 px worst case over the fixture pyramid, and 1.4e-8 px
 * over a 65 536-pixel window — the cost of inverting one logarithm and one exponential in
 * float64, which grows with the window because the information sits in the low bits of a
 * Mercator coordinate near 0.5. So this tolerance carries some seventy-fold headroom while
 * still being five orders of magnitude tighter than a pixel. A Control Point placed at full
 * resolution cannot move visibly when the user zooms out and back in: the stored value is
 * the lng/lat, and the conversion back is this exact.
 */
export const ROUND_TRIP_TOLERANCE_PX = 1e-6;

/** Fraction of the Mercator world spanned by the window, in each direction. */
const WINDOW_FRACTION = 2 ** -WINDOW_TILE_ZOOM;

/**
 * North-west corner of the window in normalised Mercator coordinates: the equator meets the
 * prime meridian at exactly (0.5, 0.5), and the window runs east and south from there.
 */
const WINDOW_ORIGIN = 0.5;

// MapLibre's own conversions, kept in the form MapLibre writes them so that our arithmetic
// and the arithmetic inside the map agree to the bit. A rearrangement that is algebraically
// identical is not necessarily identical in float64, and the click path runs through both.
const mercatorXFromLng = (lng: number) => (180 + lng) / 360;
const mercatorYFromLat = (lat: number) =>
	(180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
const lngFromMercatorX = (x: number) => x * 360 - 180;
const latFromMercatorY = (y: number) =>
	(180 / Math.PI) * (2 * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - Math.PI / 2);

const isPowerOfTwo = (value: number) =>
	Number.isInteger(value) && value >= 1 && (value & (value - 1)) === 0;

/**
 * Builds the projection for one pyramid. Throws rather than approximating when the pyramid
 * cannot be laid on the Mercator tile grid, because every such case renders a pane that
 * looks plausible and reports the wrong pixel.
 */
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

	const windowSize = tileWidth * maxScaleFactor;

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

	const maxTileZoom = WINDOW_TILE_ZOOM + Math.log2(maxScaleFactor);
	// MapLibre's world is 512 map pixels per tile regardless of the source's tile size.
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
			// The window's north-west corner is the middle of the world, so its origin tile at
			// WINDOW_TILE_ZOOM is (2 ** (zoom - 1), 2 ** (zoom - 1)), and each zoom deeper
			// doubles it.
			const origin = 2 ** (WINDOW_TILE_ZOOM - 1 + (tileZoom - WINDOW_TILE_ZOOM));
			return { x: origin, y: origin };
		},
		mapZoomFromTileZoom: (tileZoom) => tileZoom - mapZoomOffset
	};
}
