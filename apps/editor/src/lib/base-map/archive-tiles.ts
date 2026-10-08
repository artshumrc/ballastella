import { archiveUrl, type BaseMapEntry, type Bytes, type TileCoordinate } from '@ballastella/core';
import { PMTiles } from 'pmtiles';

import { resolveDeploymentAsset } from './deployment-assets';

interface ArchiveTileSource {
	readonly maxZoom: number;
	readTile(tile: TileCoordinate): Promise<Bytes | null>;
}

export async function openArchiveTiles(entry: BaseMapEntry): Promise<ArchiveTileSource> {
	const archive = new PMTiles(archiveUrl(entry, resolveDeploymentAsset));
	const header = await archive.getHeader();
	return {
		maxZoom: header.maxZoom,
		async readTile(tile) {
			const found = await archive.getZxy(tile.z, tile.x, tile.y);
			if (!found) return null;
			return new Uint8Array(found.data.slice(0)) as Bytes;
		}
	};
}
