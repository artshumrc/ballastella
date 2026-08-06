// The image pane's synthetic projection: image pixel space ↔ a small geographic window.
//
// MapLibre GL is Web Mercator only (ADR-0005), so the image pane cannot simply declare a
// pixel coordinate system the way Leaflet's `CRS.Simple` does. Image pixels are mapped into
// a geographic window instead, and a Control Point placed in the pane is recovered as the
// image pixel it came from through `syntheticToResource`.
//
// The failure mode this file exists to prevent is silent: a mapping that is very nearly
// right produces Control Points that drift as the user zooms, which reads as imprecision
// rather than as a bug and would poison every Alignment made with the tool.
//
// **What is asserted, and by which test.** Worth being exact about, because the round-trip
// assertions are the obvious answer and they are the weakest of the four.
//
//   * That the two functions are mutually inverse — `synthetic-projection.test.ts`'s
//     round-trip tests, and `iiif-image-pane.test.ts`'s per-zoom-level one. These compute
//     f⁻¹(f(x)) == x, so they bound the arithmetic's precision and nothing else: they would
//     pass just as well if both functions were composed with any bijection of the plane. They
//     are also zoom-independent, because neither function takes a zoom — see below.
//   * **That the mapping is the right one** — `iiif-image-pane.test.ts`'s "lands every tile of
//     every zoom level on its own pixel origin". It derives each tile's north-west corner from
//     the canonical slippy-map formulae, genuinely different algebra from anything here, and
//     requires `syntheticToResource` to return the IIIF region origin that tile was cut at.
//     Exact identity, error 0. This is the anchor; the round-trips are not.
//   * That the scale is MapLibre's — `synthetic-projection.test.ts`'s "renders one image pixel
//     per map pixel", which pins the 512-pixel-world convention as an external fact, and the
//     browser test "pans by the distance the pointer moved", which pins it in real screen
//     pixels through a real drag.
//
// **On "at every zoom level".** The round-trip is zoom-independent by design: `WINDOW_TILE_ZOOM`
// fixes one window for the whole pyramid and neither function takes a zoom argument, so there is
// no per-zoom behaviour for a round-trip to vary. What genuinely holds *per zoom level* is the
// tile-origin identity above, and that is where the per-level loop earns its keep.
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
// 3. **Degrees of latitude have barely parted company with Mercator y.** The window spans
//    360 / 2**12 = 0.087890625°. Over that span sec(latitude) — the Mercator scale factor —
//    reaches 1 + 1.2e-6 at the window's south edge, and 1 + 2.0e-7 at the bottom of this
//    fixture's image.
//
//    **This is not an on-screen stretch, and there is none.** Image pixels are linear in
//    Mercator by construction below, MapLibre's screen transform is affine in Mercator at
//    pitch 0, and each raster tile's texture is interpolated linearly across its Mercator
//    cell — so the rendered scale is exactly uniform, not nearly. Measured: the Mercator-y
//    step per image pixel is bit-identical at every row of the fixture.
//
//    What the number bounds is how wrong you would be to treat degrees of latitude as
//    interchangeable with Mercator y — which is the temptation this window's smallness
//    invites, and the reason the mapping is defined in Mercator instead. Made linear in
//    degrees, `resourceToSynthetic` would be off by up to 2.2e-5 image pixels over the
//    fixture's height and 3.1e-4 over the whole window, and would fail the tile-origin
//    identity in `iiif-image-pane.test.ts` by 3.1e-4 px against a 1e-6 tolerance. Done in
//    Mercator, as here, it costs nothing at all: the number never enters the round-trip and
//    never reaches the screen.
//
// 4. **There is zoom headroom left.** The binding ceiling is not on map zoom. MapLibre's
//    `maxZoom` option is unvalidated in v5 — 25 and 30 are both accepted, verified against
//    maplibre-gl 5.24.0 in a real browser — and the pane asks for
//    `fullResolutionMapZoom + 2` so a Control Point can be placed on a feature smaller than a
//    pixel of the scan (`ImagePane.svelte`). What is enforced is `MAX_TILE_ZOOM = 25` on the
//    *tile* zoom: `CanonicalTileID` throws past it, and the observed symptom is that the source
//    requests no tiles at all while the console says
//    `x=33554432, y=33554432, z=26 outside of bounds` and nothing about a pyramid.
//
//    So the constraint is `12 + log2(maxScaleFactor) <= 25`, i.e. maxScaleFactor at most
//    2**13, i.e. a window of `tileWidth * 8192` image pixels — two million pixels on a side
//    for 256-pixel tiles, four million for 512, far past anything real. It is checked below
//    rather than left to MapLibre, because the failure is silent where it is diagnosable here.
//
// A shallower window zoom (a larger window) buys nothing and moves degrees of latitude
// further from Mercator y; a deeper one costs precision, because the window's coordinates sit
// that many more bits below the leading bit of 0.5 — see `ROUND_TRIP_TOLERANCE_PX`. Twelve is
// the middle of that trade.
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
// linear-in-Mercator image is drawn at an exactly uniform scale, and the XYZ grid is uniform in
// Mercator, so the tiles land on cell boundaries. Latitude is therefore *not* linear in image
// y, and the gap between the two is the number quantified in (3).

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
 * MapLibre's `MAX_TILE_ZOOM` (`src/util/util.ts`), the deepest tile zoom `CanonicalTileID` will
 * accept. Not the same thing as its documented 0–24 range for the map's own `minZoom`/`maxZoom`,
 * which v5 does not enforce at all.
 */
const MAPLIBRE_MAX_TILE_ZOOM = 25;

/**
 * Documented round-trip tolerance, in image pixels.
 *
 * Five orders of magnitude tighter than a pixel, so a Control Point placed at full resolution
 * cannot move visibly when the user zooms out and back in: the stored value is the lng/lat, and
 * the conversion back is this exact.
 *
 * **The headroom is not a constant — it is a scaling law.** The error is proportional to the
 * window, so quoting a single figure invites a later contributor to assume the margin they
 * measured on a small pyramid is the margin everywhere. It is not:
 *
 * | window (image px)      | worst error | headroom |
 * |------------------------|-------------|----------|
 * | 2 048, this fixture    | 4.7e-10 px  | 2 100×   |
 * | 65 536                 | 1.5e-8 px   | 67×      |
 * | 131 072                | 3.0e-8 px   | 34×      |
 * | 4 194 304, the ceiling | 9.5e-7 px   | 1.05×    |
 *
 * `roundTripErrorPx` below states the law, and `createSyntheticProjection` refuses any pyramid
 * whose window would break it — so this tolerance is an invariant of every projection this
 * module hands out, not a claim about the pyramids that happened to get measured.
 *
 * **Where the error comes from, since the obvious answer is wrong.** Not the transcendentals:
 * Δx is the same size as Δy at every window, and x passes through no transcendental at all —
 * `lngFromMercatorX` is `x * 360 - 180` and `mercatorXFromLng` is `(180 + lng) / 360`, and that
 * pair round-trips these values exactly. Measured by isolating each step: the *entire* error is
 * the single addition `WINDOW_ORIGIN + t` in `resourceToSynthetic`. `t` is at most 2**-12, and
 * adding it to 0.5 rounds it to the ulp of 0.5, discarding everything below 2**-53. That is
 * `WINDOW_TILE_ZOOM` bits of `t`, which is the one place in this file where the choice of window
 * zoom is load-bearing for *precision* rather than for grid alignment.
 */
export const ROUND_TRIP_TOLERANCE_PX = 1e-6;

/**
 * Worst-case round-trip error, in image pixels, for a window of `windowSize` image pixels.
 *
 * Half an ulp of a float64 in [0.5, 1) is 2**-54 — the rounding of `WINDOW_ORIGIN + t` — and one
 * Mercator unit is `windowSize * 2 ** WINDOW_TILE_ZOOM` image pixels. Exact, not a fit: every
 * measurement in the table above is this expression to three significant figures.
 */
const roundTripErrorPx = (windowSize: number) => windowSize * 2 ** (WINDOW_TILE_ZOOM - 54);

/** Fraction of the Mercator world spanned by the window, in each direction. */
const WINDOW_FRACTION = 2 ** -WINDOW_TILE_ZOOM;

/**
 * North-west corner of the window in normalised Mercator coordinates: the equator meets the
 * prime meridian at exactly (0.5, 0.5), and the window runs east and south from there.
 */
const WINDOW_ORIGIN = 0.5;

// MapLibre's own conversions, from `maplibre-gl/src/geo/mercator_coordinate.ts`.
//
// The first three are transcribed expression for expression, so they agree with the arithmetic
// inside the map to the bit. That matters for `mercatorXFromLng` and `mercatorYFromLat` in
// particular: the click path is MapLibre's `event.lngLat` — produced by *its*
// `lngFromMercatorX`/`latFromMercatorY` — straight into `syntheticToResource`, so those two are
// composed with MapLibre's own inverses on every click.
//
// `latFromMercatorY` below is deliberately *not* MapLibre's arrangement. MapLibre writes
// `360 / Math.PI * Math.atan(Math.exp(y2 * Math.PI / 180)) - 90`; this is the algebraically
// identical `(180 / Math.PI) * (2 * atan(exp(…)) - Math.PI / 2)`, and in float64 the two differ
// by up to 7.5e-15° across the window. Keeping the rearrangement is a measured choice, not an
// oversight:
//
//   * it is the better-conditioned form here, because it never subtracts 90 from a number very
//     close to 90 — this window sits at latitude ~0, which is where that cancellation is worst;
//   * it inverts `mercatorYFromLat` *exactly* over the window (zero error at every one of
//     200 000 samples), where MapLibre's form is out by one ulp;
//   * substituting MapLibre's form doubles the fixture's worst round-trip error, 4.7e-10 →
//     9.3e-10 px.
//
// And nothing composes this function with MapLibre's `mercatorYfromLat`, so the divergence has
// nowhere to show up: it is only ever used to *emit* a latitude, which MapLibre then re-projects
// with its own forward transform.
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

	const deepestTileZoom = WINDOW_TILE_ZOOM + Math.log2(maxScaleFactor);

	if (deepestTileZoom > MAPLIBRE_MAX_TILE_ZOOM) {
		throw new Error(
			`The pyramid's finest level sits at tile zoom ${deepestTileZoom}, past MapLibre's ` +
				`maximum tile zoom of ${MAPLIBRE_MAX_TILE_ZOOM}. Scale factor ${maxScaleFactor} is ` +
				`${deepestTileZoom - MAPLIBRE_MAX_TILE_ZOOM} level(s) too deep: the deepest the window ` +
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

	const maxTileZoom = deepestTileZoom;
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
			// The window's north-west corner is the middle of the world, and the middle of a
			// 2**z × 2**z grid is tile (2**(z-1), 2**(z-1)) — for any z, which is the whole point.
			// `WINDOW_TILE_ZOOM` cancels out of this expression, so this is emphatically *not* one
			// of the places the constant is load-bearing; writing it in as
			// `2 ** (WINDOW_TILE_ZOOM - 1 + (tileZoom - WINDOW_TILE_ZOOM))` only hid that.
			const origin = 2 ** (tileZoom - 1);
			return { x: origin, y: origin };
		},
		mapZoomFromTileZoom: (tileZoom) => tileZoom - mapZoomOffset
	};
}
