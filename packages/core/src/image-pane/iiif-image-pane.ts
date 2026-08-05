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
 * Builds the image pane's reader from a level-0 `info.json` and the base URL its tiles are
 * actually served from.
 *
 * `baseUri` is required rather than optional because of ADR-0004: `info.json` is written with
 * the deliberately unusable `https://unset.invalid/<image-id>` placeholder, and every code
 * path constructing an `Image` must set `uri` before requesting a tile. Making the caller
 * pass it means that invariant cannot be forgotten here.
 */
export function createImagePane(info: unknown, baseUri: string): ImagePane {
	if (new URL(baseUri).hostname.endsWith('unset.invalid')) {
		throw new Error(
			`The image pane was given the unset.invalid placeholder as a base URI. ADR-0004: the ` +
				`real base is resolved at load time from wherever the tiles are actually served.`
		);
	}

	const image = Image.parse(info);
	image.uri = baseUri.replace(/\/$/, '');

	const levels = [...image.tileZoomLevels].sort((a, b) => a.scaleFactor - b.scaleFactor);
	const first = levels[0];

	if (!first) {
		throw new Error('The pyramid declares no tile zoom levels.');
	}

	const scaleFactors = levels.map((level) => level.scaleFactor);
	const expected = scaleFactors.map((_, index) => first.scaleFactor * 2 ** index);

	if (scaleFactors.join() !== expected.join()) {
		throw new Error(
			`The pyramid's scale factors must be contiguous powers of two, got ` +
				`[${scaleFactors.join(', ')}]. A missing intermediate level is a zoom at which the ` +
				`image pane renders nothing, with no error anywhere to say why.`
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
