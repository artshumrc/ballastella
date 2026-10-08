import { Image } from '@allmaps/iiif-parser';
import type { ImageRequest, Region, SizeObject, TileZoomLevel } from '@allmaps/types';

import { imageServiceId } from '../tiler/pyramid.js';
import {
	createSyntheticProjection,
	type ResourcePoint,
	type SyntheticProjection
} from './synthetic-projection';

type XyzTile = { z: number; x: number; y: number };

export type ImagePaneTile = {
	scaleFactor: number;
	column: number;
	row: number;
	request: ImageRequest & { region: Region; size: SizeObject };
	url: string;
	// IIIF rounds a served tile up to whole pixels; this is the fractional extent it covers.
	placement: { width: number; height: number };
};

export type ImagePane = {
	readonly image: Image;
	readonly projection: SyntheticProjection;
	readonly tileSize: number;
	tileAt(xyz: XyzTile): ImagePaneTile | undefined;
	allTiles(): ImagePaneTile[];
	resourceToSynthetic(point: ResourcePoint): { lng: number; lat: number };
	syntheticToResource(lngLat: { lng: number; lat: number }): ResourcePoint;
};

export type ImagePaneTileBase = string | { readonly storedImageId: string };

export function createImagePane(info: unknown, tiles: ImagePaneTileBase): ImagePane {
	if (typeof tiles === 'string' && new URL(tiles).hostname.endsWith('unset.invalid')) {
		throw new Error(
			`The image pane was given the unset.invalid placeholder as a base URI. ADR-0004: the ` +
				`real base is resolved at load time from wherever the tiles are actually served. If the ` +
				`tiles are in the Project's own store, say so — pass { storedImageId } and reach them ` +
				`through the ADR-0011 injection layer, which is what routes that host.`
		);
	}

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
	if (!first) throw new Error('The pyramid declares no tile zoom levels.');
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

	return {
		image,
		projection,
		tileSize: first.width,

		tileAt: ({ z, x, y }) => {
			const scaleFactor = projection.scaleFactorFromTileZoom(z);
			const level = levels.find((one) => one.scaleFactor === scaleFactor);
			if (!level) return undefined;
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
