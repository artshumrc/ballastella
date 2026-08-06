// The shape of a level-0 IIIF pyramid: what files exist, and what each one must contain.
//
// This module is the writer's half of the contract ADR-0003 sets up, and it is deliberately
// pure — no bytes, no store, no canvas. Given an image's dimensions it says exactly which
// files a complete pyramid has and what region of the source, at what size, belongs in each.
// The two tilers differ only in how they turn a region into pixels.
//
// **Every tile's region and size comes from `@allmaps/iiif-parser`'s
// `Image#getTileImageRequest`, and every tile's path from its `Image#getImageUrl`.** Not from
// arithmetic here. Ticket 03's image pane reads the pyramid through the same two functions, so
// reader and writer cannot disagree about what a tile is or where it lives — which is the
// entire reason ADR-0003 names that function rather than describing the geometry in prose.

import { Image } from '@allmaps/iiif-parser';
import type { Region, SizeObject } from '@allmaps/types';

import type { StorePath } from '../store/project-store.js';

/**
 * Tile side, in pixels. **Square** (ADR-0003): `getTileZoomLevelFromScaleFactor` falls back to
 * `tileset.height || tileset.width`, so a non-square tileset whose `height` is dropped from
 * `info.json` is silently read back at the wrong shape. Square tiles make that pitfall
 * unreachable. 256 is also what MapLibre expects of a raster source by default.
 */
export const PYRAMID_TILE_SIZE = 256;

/**
 * JPEG quality for tiles, as a percentage.
 *
 * One constant for both tilers, because a user must not be able to tell which one ran by
 * looking at the result. 85 is the usual archival-web compromise: the ringing it leaves around
 * engraved linework is below what matters for placing a Control Point, and a gigapixel scan at
 * a higher setting is a Workspace that runs into ADR-0008's ~1 GB static-hosting cliff much
 * sooner.
 */
export const TILE_JPEG_QUALITY = 85;

/** The media type every tile is written as. IIIF's `default.jpg`, per the ADR-0003 contract. */
export const TILE_MEDIA_TYPE = 'image/jpeg';

/**
 * The origin of the deliberately unusable `id` every generated `info.json` carries (ADR-0004).
 *
 * `.invalid` is reserved by RFC 2606, so DNS always fails: a code path that forgets to override
 * `Image#uri` at load time fails loudly instead of quietly fetching somebody else's tiles. It
 * is an `https:` URL rather than a `urn:` because `Image3Schema` validates `id` with
 * `z.string().url()` and a URN parses under some zod versions and not others.
 */
export const IMAGE_SERVICE_PLACEHOLDER_ORIGIN = 'https://unset.invalid';

/** The placeholder `id` written into `info.json` for a locally ingested image. */
export const imageServiceId = (imageId: string): string =>
	`${IMAGE_SERVICE_PLACEHOLDER_ORIGIN}/${imageId}`;

/** A level-0 IIIF Image API 3.0 image information document. */
export type Level0ImageInfo = {
	'@context': 'http://iiif.io/api/image/3/context.json';
	id: string;
	type: 'ImageService3';
	protocol: 'http://iiif.io/api/image';
	profile: 'level0';
	width: number;
	height: number;
	tiles: [{ width: number; height: number; scaleFactors: number[] }];
};

/** One tile of the pyramid: where its pixels come from, and where its bytes go. */
export type PlannedTile = {
	readonly scaleFactor: number;
	readonly column: number;
	readonly row: number;
	/** The region of the **source** image this tile covers, in source pixels. */
	readonly region: Region;
	/**
	 * The size the tile must be served at, in pixels — `ceil(region / scaleFactor)` for a ragged
	 * tile at the right or bottom margin.
	 *
	 * IIIF Image API 3.0 `size=w,h` means the returned image **is** exactly `w` by `h`: an exact
	 * resize of the whole region onto those dimensions. Ticket 03's reader draws the tile at
	 * `region / scaleFactor` — 106.375 rather than the served 107 — which is only the right
	 * placement if the file's full extent is the region's full extent. A tiler that instead
	 * scaled by exactly 1 / scaleFactor and padded the leftover fraction, or that scaled to
	 * `floor` and padded, would leave every ragged tile in every Historical Map stretched by up
	 * to 0.6% at the right and bottom margins: sub-pixel, systematic, in the margins, and
	 * invisible to any test that only checks coordinates. Both tilers assert this property
	 * directly rather than inheriting it.
	 */
	readonly size: SizeObject;
	/** Where the tile's bytes go, relative to the workspace root. */
	readonly path: StorePath;
};

/**
 * The scale factors a complete pyramid needs: `1, 2, 4, …` up to the first factor at which the
 * whole image fits in a single tile.
 *
 * Contiguous and starting at 1 because ticket 03's `createImagePane` refuses anything else —
 * the map's zoom range is derived from the coarsest level down, so a gap is a zoom that renders
 * blank with nothing anywhere to say why. Ending at one tile because that is the level the pane
 * shows when the whole image is in view; going further would add levels no zoom can reach.
 */
export function pyramidScaleFactors(
	dimensions: { width: number; height: number },
	tileSize = PYRAMID_TILE_SIZE
): number[] {
	const factors = [1];
	while (
		Math.ceil(dimensions.width / (tileSize * factors[factors.length - 1]!)) > 1 ||
		Math.ceil(dimensions.height / (tileSize * factors[factors.length - 1]!)) > 1
	) {
		factors.push(factors[factors.length - 1]! * 2);
	}
	return factors;
}

/** The `info.json` for a locally ingested image (ADR-0003, ADR-0004). */
export function buildImageInfo({
	imageId,
	width,
	height,
	tileSize = PYRAMID_TILE_SIZE
}: {
	imageId: string;
	width: number;
	height: number;
	tileSize?: number;
}): Level0ImageInfo {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new Error(`An image's dimensions must be positive integers, got ${width}×${height}.`);
	}

	return {
		'@context': 'http://iiif.io/api/image/3/context.json',
		id: imageServiceId(imageId),
		type: 'ImageService3',
		protocol: 'http://iiif.io/api/image',
		profile: 'level0',
		width,
		height,
		// `height` is written even though it equals `width`, because omitting it is only safe while
		// the tiles stay square and this file is what a stranger's IIIF client reads.
		tiles: [
			{
				width: tileSize,
				height: tileSize,
				scaleFactors: pyramidScaleFactors({ width, height }, tileSize)
			}
		]
	};
}

/**
 * Every tile a complete pyramid contains, coarsest level last.
 *
 * `directory` is where the pyramid lives in the store. It is spliced in as the parsed image's
 * `uri` so that the paths come out of `Image#getImageUrl` — the same function that builds the
 * URLs the image pane fetches — rather than out of a second implementation of IIIF's URL
 * syntax that could drift from the first.
 */
export function planPyramid(info: unknown, directory: StorePath): PlannedTile[] {
	const image = Image.parse(info);
	image.uri = directory.replace(/\/$/, '');

	const levels = [...image.tileZoomLevels].sort((a, b) => a.scaleFactor - b.scaleFactor);

	return levels.flatMap((level) =>
		Array.from({ length: level.rows }, (_, row) =>
			Array.from({ length: level.columns }, (_, column) => {
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
					region,
					size,
					path: image.getImageUrl(request)
				};
			})
		).flat()
	);
}

/** Tab-indented with a trailing newline, matching this project's other JSON writer. */
export const serialiseJson = (value: unknown): Uint8Array<ArrayBuffer> =>
	new TextEncoder().encode(`${JSON.stringify(value, null, '\t')}\n`);
