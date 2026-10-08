import { Image } from '@allmaps/iiif-parser';
import type { Region, SizeObject } from '@allmaps/types';

import { isRecord, type StorePath } from '../store/project-store.js';

export const PYRAMID_TILE_SIZE = 256;
export const TILE_JPEG_QUALITY = 85;
export const TILE_MEDIA_TYPE = 'image/jpeg';
export const IMAGE_SERVICE_PLACEHOLDER_ORIGIN = 'https://unset.invalid';

export const imageServiceId = (imageId: string): string =>
	`${IMAGE_SERVICE_PLACEHOLDER_ORIGIN}/${imageId}`;

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

export type PlannedTile = {
	readonly scaleFactor: number;
	readonly column: number;
	readonly row: number;
	readonly region: Region;
	readonly size: SizeObject;
	readonly path: StorePath;
};

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
		tiles: [
			{
				width: tileSize,
				height: tileSize,
				scaleFactors: pyramidScaleFactors({ width, height }, tileSize)
			}
		]
	};
}

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

export function imageSizeFromInfo(info: unknown): { width: number; height: number } | null {
	if (!isRecord(info)) return null;
	const { width, height } = info;
	if (typeof width !== 'number' || typeof height !== 'number') return null;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
	return { width, height };
}

export function imageGeometryFromInfo(
	info: unknown
): { width: number; height: number; tileSize: number } | null {
	const size = imageSizeFromInfo(info);
	if (size === null) return null;
	const { tiles } = info as { tiles?: unknown };
	if (!Array.isArray(tiles)) return null;
	const first: unknown = tiles[0];
	if (typeof first !== 'object' || first === null) return null;
	const { width: tileSize = 0 } = first as { width?: number };
	if (!Number.isInteger(tileSize) || tileSize < 1) return null;
	return { ...size, tileSize };
}
