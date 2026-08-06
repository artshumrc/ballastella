// The image pane's reader: a level-0 IIIF pyramid laid on the Web Mercator tile grid.
//
// This is the only place that knows both the IIIF tile geometry and the synthetic projection,
// and it exists so that nothing else has to hold the two in its head at once. Everything the
// pane needs — the projection, the source's zoom range and bounds, and the URL of the tile
// MapLibre is asking for — comes off one object built from one `info.json`.
//
// Tile geometry comes from `@allmaps/iiif-parser`'s `getTileImageRequest`, never from string
// arithmetic here. That function is also what the tiler in ticket 05 uses to decide what to
// *write*, and using it on both sides is what guarantees the reader and the writer cannot
// disagree (ADR-0003).

import { Image } from '@allmaps/iiif-parser';
import type { ImageRequest, Region, SizeObject, TileZoomLevel } from '@allmaps/types';

import { imageServiceId } from '../tiler/pyramid.js';
import {
	createSyntheticProjection,
	type ResourcePoint,
	type SyntheticProjection
} from './synthetic-projection';

/** A tile of the Web Mercator XYZ grid, as MapLibre asks for it. */
export type XyzTile = { z: number; x: number; y: number };

export type ImagePaneTile = {
	/** The IIIF zoom level's scale factor: 1 is full resolution. */
	scaleFactor: number;
	column: number;
	row: number;
	/**
	 * Exactly what `Image#getTileImageRequest` returned, unmodified. `region` and `size` are
	 * optional on `ImageRequest` because a request for the whole image at `max` needs neither;
	 * a tile request always has both, and `createImagePane` refuses one that does not.
	 */
	request: ImageRequest & { region: Region; size: SizeObject };
	/** Absolute tile URL, built by `@allmaps/iiif-parser` from `Image#uri`. */
	url: string;
	/**
	 * Size, in tile pixels, that the fetched image must occupy inside the `tileSize`-square
	 * cell MapLibre draws it into.
	 *
	 * This is not `request.size`. IIIF rounds a served tile *up* to whole pixels, so the
	 * coarsest level of a 851-pixel-high image at scale factor 8 is served 107 pixels high
	 * while covering 106.375 pixels of the cell. Drawing it at the size it was served would
	 * stretch it by 0.6% — sub-pixel on screen at the zoom where that level is shown, but a
	 * systematic error, and systematic errors in this pane are what drift is made of.
	 *
	 * Interior tiles fill their cell exactly and need no correction.
	 *
	 * **This binds the writer as much as the reader.** `placement` is `region / scaleFactor`, so
	 * it is only the right number if a ragged tile's bytes are an *exact* resize of its region by
	 * 1 / scaleFactor — IIIF's own semantics, where a 851-pixel region at scale factor 8 becomes
	 * 106.375 pixels' worth of content in a 107-pixel-wide file, the last row of pixels only
	 * fractionally covered. It is **not** correct for a tiler that resizes to `floor` or `round`
	 * and pads the remainder, nor for one that resizes to the rounded `size` and calls it done:
	 * either of those stretches every ragged tile by up to 0.6% at the right and bottom margins
	 * of every Historical Map in the app. Sub-pixel, systematic, in the margins — and invisible
	 * to every test in this slice, because the coordinates would all still be right.
	 *
	 * The committed fixture satisfies this (verified by decoding all 29 tiles: every ragged tile
	 * sits at the JPEG noise floor against exact-resize semantics and 20–45× above it against
	 * resize-and-pad). Ticket 05's tiler must assert it rather than inherit it.
	 */
	placement: { width: number; height: number };
};

export type ImagePane = {
	/** The parsed IIIF Image, with `uri` already resolved (ADR-0004). */
	readonly image: Image;
	readonly projection: SyntheticProjection;
	/** Tile side in pixels — square, per ADR-0003. */
	readonly tileSize: number;

	/** The tile MapLibre is asking for, or `undefined` if the pyramid has no such tile. */
	tileAt(xyz: XyzTile): ImagePaneTile | undefined;
	/** Every tile in the pyramid, coarsest level last. Used by tests and by the tiler. */
	allTiles(): ImagePaneTile[];
	/** Where an image pixel is, as a MapLibre `LngLatLike`. */
	resourceToSynthetic(point: ResourcePoint): { lng: number; lat: number };
	/** Which image pixel a point in the pane is. */
	syntheticToResource(lngLat: { lng: number; lat: number }): ResourcePoint;
};

/**
 * Where a pyramid's tiles are really served from — the answer ADR-0004 requires at load time.
 *
 * Two forms, and the distinction is the invariant rather than a convenience. A **string** is an
 * absolute base the tiles are served from over HTTP, and it is refused if it is still the
 * `unset.invalid` placeholder: a caller that passes `info.id` through has not decided anything,
 * which is the mistake ADR-0004 is written against. `{ storedImageId }` says the tiles are in
 * the Project's own store and are reached through the ADR-0011 injection layer, whose routing
 * key *is* the placeholder — so the base comes out the same string, deliberately, and the shim
 * resolves it. Forgetting and choosing therefore cannot look alike here: they are different
 * types.
 */
export type ImagePaneTileBase = string | { readonly storedImageId: string };

/**
 * Builds the image pane's reader from a level-0 `info.json` and the base its tiles are actually
 * served from.
 *
 * `tiles` is required rather than optional because of ADR-0004: `info.json` is written with the
 * deliberately unusable `https://unset.invalid/<image-id>` placeholder, and every code path
 * constructing an `Image` must set `uri` before requesting a tile. Making the caller say where
 * they come from means that invariant cannot be forgotten here.
 */
export function createImagePane(info: unknown, tiles: ImagePaneTileBase): ImagePane {
	if (typeof tiles === 'string' && new URL(tiles).hostname.endsWith('unset.invalid')) {
		throw new Error(
			`The image pane was given the unset.invalid placeholder as a base URI. ADR-0004: the ` +
				`real base is resolved at load time from wherever the tiles are actually served. If the ` +
				`tiles are in the Project's own store, say so — pass { storedImageId } and reach them ` +
				`through the ADR-0011 injection layer, which is what routes that host.`
		);
	}

	// An image **id**, not a URL. `{ storedImageId: info.id }` is the plausible slip — the two are
	// adjacent in every caller — and it produces a base of
	// `https://unset.invalid/https://unset.invalid/<id>`, which the shim resolves to a path no
	// pyramid is at: every tile 404s and the pane is blank, with the guard above satisfied because
	// the caller did use the object form. So the id is checked for the shape of a URL rather than
	// the base being checked for the shape of an id.
	if (typeof tiles === 'object' && !/^[\w.-]+$/.test(tiles.storedImageId)) {
		throw new Error(
			`"${tiles.storedImageId}" is not a stored image id. It looks like a URL or a path, and ` +
				`storedImageId is the id alone — the last segment of info.json's "id", which is what ` +
				`images/<image-id>/ is named after (ADR-0004, ADR-0008). Passing info.id here builds a ` +
				`base with the placeholder host twice in it, and every tile then 404s out of the store.`
		);
	}

	const baseUri = typeof tiles === 'string' ? tiles : imageServiceId(tiles.storedImageId);
	const image = Image.parse(info);
	image.uri = baseUri.replace(/\/$/, '');

	const levels = [...image.tileZoomLevels].sort((a, b) => a.scaleFactor - b.scaleFactor);
	const first = levels[0];

	if (!first) {
		throw new Error('The pyramid declares no tile zoom levels.');
	}

	const scaleFactors = levels.map((level) => level.scaleFactor);
	const expected = scaleFactors.map((_, index) => 2 ** index);

	if (scaleFactors.join() !== expected.join()) {
		throw new Error(
			`The pyramid's scale factors must be 1, 2, 4, … with no gaps, got ` +
				`[${scaleFactors.join(', ')}]. The finest level must be scale factor 1 — full ` +
				`resolution — because the map zoom range is derived from the coarsest level down, so ` +
				`a pyramid starting at 2 has no level at the zoom it calls full resolution: the pane ` +
				`renders blank there with no error anywhere to say why. A missing intermediate level ` +
				`is the same failure one zoom higher.`
		);
	}

	// Every level must be cut into the same square tile, because a MapLibre raster source carries
	// one `tileSize` for the whole pyramid. `@allmaps/iiif-parser` flattens several `tiles` entries
	// into one list of levels, so an `info.json` that is entirely legal — 256-pixel tiles for the
	// fine levels, 512-pixel tiles for the coarse ones — arrives here as contiguous scale factors
	// that pass every other guard. Drawn against `levels[0]`'s tile size the coarse levels would
	// render at half scale: right at the tile origin and progressively wrong away from it, which
	// is indistinguishable from imprecision and is the exact failure this module exists to refuse.
	const mixed = levels.find(
		(level) => level.width !== first.width || level.height !== first.height
	);

	if (mixed) {
		throw new Error(
			`Every level of the pyramid must use one tile size, got ${first.width}×${first.height} ` +
				`at scale factor ${first.scaleFactor} and ${mixed.width}×${mixed.height} at scale ` +
				`factor ${mixed.scaleFactor}. A MapLibre raster source has a single tile size, so the ` +
				`levels that disagree with it would be drawn at the wrong scale — correct at the tile ` +
				`origin and progressively wrong away from it.`
		);
	}

	const coarsest = levels[levels.length - 1] as TileZoomLevel;

	const projection = createSyntheticProjection({
		width: image.width,
		height: image.height,
		tileWidth: first.width,
		tileHeight: first.height,
		maxScaleFactor: coarsest.scaleFactor
	});

	const tileSize = first.width;

	const tileFor = (level: TileZoomLevel, column: number, row: number): ImagePaneTile => {
		const request = image.getTileImageRequest(level, column, row);
		const { region, size } = request;

		if (!region || !size) {
			throw new Error(
				`@allmaps/iiif-parser returned a tile request with no region or size for scale ` +
					`factor ${level.scaleFactor}, column ${column}, row ${row}. Every tile request has ` +
					`both; this is a change in the parser, not a bad pyramid.`
			);
		}

		return {
			scaleFactor: level.scaleFactor,
			column,
			row,
			request: { ...request, region, size },
			url: image.getImageUrl(request),
			placement: {
				width: region.width / level.scaleFactor,
				height: region.height / level.scaleFactor
			}
		};
	};

	const levelForTileZoom = (tileZoom: number): TileZoomLevel | undefined => {
		const scaleFactor = projection.scaleFactorFromTileZoom(tileZoom);
		return levels.find((level) => level.scaleFactor === scaleFactor);
	};

	return {
		image,
		projection,
		tileSize,

		tileAt: ({ z, x, y }) => {
			const level = levelForTileZoom(z);
			if (!level) {
				return undefined;
			}

			const origin = projection.tileGridOrigin(z);
			const column = x - origin.x;
			const row = y - origin.y;

			if (column < 0 || row < 0 || column >= level.columns || row >= level.rows) {
				return undefined;
			}

			return tileFor(level, column, row);
		},

		allTiles: () =>
			levels.flatMap((level) =>
				Array.from({ length: level.rows }, (_, row) =>
					Array.from({ length: level.columns }, (_, column) => tileFor(level, column, row))
				).flat()
			),

		resourceToSynthetic: projection.resourceToSynthetic,
		syntheticToResource: projection.syntheticToResource
	};
}
