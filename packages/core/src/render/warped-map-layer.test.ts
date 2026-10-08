import { describe, expect, test } from 'vitest';

import { warpedTilesRequestedForViewport, type WarpedViewportTiles } from './warped-map-layer.js';

const renderer = (
	needs: Readonly<Record<string, readonly string[]>>,
	cached: readonly string[]
): WarpedViewportTiles => ({
	mapsWithFetchableTilesForViewport: new Set(Object.keys(needs)),
	warpedMapList: {
		getWarpedMap: (mapId) => {
			const urls = needs[mapId];
			if (!urls) return undefined;
			return { fetchableTilesForViewport: urls.map((tileUrl) => ({ tileUrl })) };
		}
	},
	tileCache: {
		getCacheableTile: (tileUrl) => (cached.includes(tileUrl) ? { tileUrl } : undefined)
	}
});

test.each([
	['everything this viewport needs has been asked for', { blaeu: ['a', 'b'] }, ['a', 'b'], true],
	['one tile short is not asked', { blaeu: ['a', 'b'] }, ['a'], false],
	['one map of two having asked is not asked', { blaeu: ['a'], ortelius: ['b'] }, ['a'], false],
	['both maps having asked is asked', { blaeu: ['a'], ortelius: ['b'] }, ['a', 'b'], true],
	['a viewport with no warped map in it is asked', {}, [], true],
	['a map in the viewport that needs no tile is asked', { blaeu: [] }, [], true]
])('%s', (_name, needs: Record<string, string[]>, cached: string[], asked) => {
	expect(warpedTilesRequestedForViewport(renderer(needs, cached))).toBe(asked);
});

describe('nothing to wait for', () => {
	test('a map the list has forgotten does not hold the frame back', () => {
		const torn: WarpedViewportTiles = {
			mapsWithFetchableTilesForViewport: new Set(['gone']),
			warpedMapList: { getWarpedMap: () => undefined },
			tileCache: { getCacheableTile: () => undefined }
		};

		expect(warpedTilesRequestedForViewport(torn)).toBe(true);
	});
});

test('a tile that was asked for and refused still counts as asked', () => {
	const refused: WarpedViewportTiles = {
		mapsWithFetchableTilesForViewport: new Set(['blaeu']),
		warpedMapList: {
			getWarpedMap: () => ({ fetchableTilesForViewport: [{ tileUrl: 'a' }] })
		},
		tileCache: { getCacheableTile: () => ({ data: undefined }) }
	};

	expect(warpedTilesRequestedForViewport(refused)).toBe(true);
});
