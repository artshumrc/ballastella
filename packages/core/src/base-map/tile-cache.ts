import type { GeoBounds } from '../project/opening-view.js';
import type { ReadOnlyProjectStore } from '../store/project-store.js';

export interface TileCoordinate {
	readonly z: number;
	readonly x: number;
	readonly y: number;
}

export const BASE_MAP_TILE_ROOT = 'base-map/tiles/';

export function baseMapArchiveKey(archive: string): string {
	const slug = (archive.split(/[/\\]/).pop() ?? '')
		.replace(/\.pmtiles$/i, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24)
		.replace(/-+$/, '');
	return `${slug || 'archive'}-${fingerprint(archive)}`;
}

function fingerprint(value: string): string {
	const bytes = new TextEncoder().encode(value);
	const round = (basis: number): string => {
		let hash = basis;
		for (const byte of bytes) {
			hash ^= byte;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, '0');
	};
	return `${round(0x811c9dc5)}${round(0x9dc5811c)}`;
}

export const baseMapTileDirectory = (archive: string): string =>
	`${BASE_MAP_TILE_ROOT}${baseMapArchiveKey(archive)}/`;

export const cachedTilePath = (archive: string, tile: TileCoordinate): string =>
	`${baseMapTileDirectory(archive)}${tile.z}/${tile.x}/${tile.y}.mvt`;

export const legacyCachedTilePath = (tile: TileCoordinate): string =>
	`${BASE_MAP_TILE_ROOT}${tile.z}/${tile.x}/${tile.y}.mvt`;

export const cachedTileReader =
	(store: ReadOnlyProjectStore, pathOf: (tile: TileCoordinate) => string) =>
	(tile: TileCoordinate): Promise<Uint8Array | null> =>
		store.read(pathOf(tile)).catch(() => null);

const CACHED_TILE_PATH = new RegExp(
	`^${BASE_MAP_TILE_ROOT}(?:([^/]+)/)?(\\d+)/(\\d+)/(\\d+)\\.mvt$`
);

export function parseAnyCachedTilePath(
	path: string
): { readonly key: string | null; readonly tile: TileCoordinate } | null {
	const matched = CACHED_TILE_PATH.exec(path);
	if (!matched) return null;
	const [, key, z, x, y] = matched;
	return { key: key ?? null, tile: { z: Number(z), x: Number(x), y: Number(y) } };
}

export function parseCachedTilePath(archive: string, path: string): TileCoordinate | null {
	const parsed = parseAnyCachedTilePath(path);
	return parsed !== null && parsed.key === baseMapArchiveKey(archive) ? parsed.tile : null;
}

export const ESTIMATED_BYTES_PER_TILE = 152_000;
export const OFFLINE_TILE_LIMIT = 500;
const MERCATOR_LATITUDE_LIMIT = 85.0511287798066;

const clamp = (value: number, low: number, high: number): number =>
	Math.min(high, Math.max(low, value));

const tileX = (lng: number, z: number): number => Math.floor(((lng + 180) / 360) * 2 ** z);

const tileY = (lat: number, z: number): number => {
	const bounded = clamp(lat, -MERCATOR_LATITUDE_LIMIT, MERCATOR_LATITUDE_LIMIT);
	const radians = (bounded * Math.PI) / 180;
	const fraction = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
	return clamp(Math.floor(fraction * 2 ** z), 0, 2 ** z - 1);
};

function* zoomSpans(bounds: GeoBounds, maxZoom: number) {
	if (!Number.isFinite(maxZoom) || maxZoom < 0) return;
	for (let z = 0; z <= Math.floor(maxZoom); z += 1) {
		const width = 2 ** z;
		const first = tileX(bounds.west, z);
		const columns = Math.min(Math.max(0, tileX(bounds.east, z) - first + 1), width);
		yield {
			z,
			width,
			first,
			columns,
			north: tileY(bounds.north, z),
			south: tileY(bounds.south, z)
		};
	}
}

export function tilesForBounds(bounds: GeoBounds, maxZoom: number): TileCoordinate[] {
	const tiles: TileCoordinate[] = [];
	for (const { z, width, first, columns, north, south } of zoomSpans(bounds, maxZoom)) {
		for (let step = 0; step < columns; step += 1) {
			const x = (((first + step) % width) + width) % width;
			for (let y = north; y <= south; y += 1) tiles.push({ z, x, y });
		}
	}
	return tiles;
}

export function countTilesForBounds(bounds: GeoBounds, maxZoom: number): number {
	let total = 0;
	for (const { columns, north, south } of zoomSpans(bounds, maxZoom)) {
		total += columns * Math.max(0, south - north + 1);
	}
	return total;
}

export interface TileBudget {
	readonly tiles: readonly TileCoordinate[];
	readonly count: number;
	readonly estimatedBytes: number;
	readonly maxZoom: number;
	readonly overThreshold: boolean;
	readonly limit: number;
}

export function tileBudget(bounds: GeoBounds, maxZoom: number): TileBudget {
	const count = countTilesForBounds(bounds, maxZoom);
	const overThreshold = count > OFFLINE_TILE_LIMIT;
	return {
		tiles: overThreshold ? [] : tilesForBounds(bounds, maxZoom),
		count,
		estimatedBytes: count * ESTIMATED_BYTES_PER_TILE,
		maxZoom: Math.max(0, Math.floor(maxZoom)),
		overThreshold,
		limit: OFFLINE_TILE_LIMIT
	};
}
