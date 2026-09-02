// Whether a warped renderer has asked for the frame on screen.
//
// The rest of this module talks to `@allmaps/maplibre` and is asserted through what a real map draws
// (`e2e/editor-annotations.e2e.ts`, and the Epic's manual checklist for the Map Snapshot itself).
// This one question is arithmetic over three fields, and it decides whether a scholar is offered a
// picture of the view they are looking at or of the one before it — so it is driven here, against a
// renderer that is a plain object.

import { describe, expect, test } from 'vitest';

import { warpedTilesRequestedForViewport, type WarpedViewportTiles } from './warped-map-layer.js';

/** A renderer's state as this question sees it: who is in the viewport, what they need, what is cached. */
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

test('a renderer that has asked for everything this viewport needs has asked', () => {
	expect(warpedTilesRequestedForViewport(renderer({ blaeu: ['a', 'b'] }, ['a', 'b']))).toBe(true);
});

test('one tile short is not asked', () => {
	// The case the request counter cannot see: nothing is in flight, because the request for this
	// tile has not been made yet.
	expect(warpedTilesRequestedForViewport(renderer({ blaeu: ['a', 'b'] }, ['a']))).toBe(false);
});

test('every map in the viewport has to have asked, not merely one of them', () => {
	expect(warpedTilesRequestedForViewport(renderer({ blaeu: ['a'], ortelius: ['b'] }, ['a']))).toBe(
		false
	);
	expect(
		warpedTilesRequestedForViewport(renderer({ blaeu: ['a'], ortelius: ['b'] }, ['a', 'b']))
	).toBe(true);
});

describe('nothing to wait for', () => {
	test('a viewport with no warped map in it is asked', () => {
		// Every Layer hidden, or the map panned off them: readiness describes what this frame draws,
		// and this frame draws no Map Image.
		expect(warpedTilesRequestedForViewport(renderer({}, []))).toBe(true);
	});

	test('a map in the viewport that needs no tile is asked', () => {
		expect(warpedTilesRequestedForViewport(renderer({ blaeu: [] }, []))).toBe(true);
	});

	test('a map the list has forgotten does not hold the frame back', () => {
		// Upstream's two records are updated in the same pass but are not one object; a map named in
		// the viewport set and absent from the list is a torn read, and waiting for a map that is not
		// there would never end.
		const torn: WarpedViewportTiles = {
			mapsWithFetchableTilesForViewport: new Set(['gone']),
			warpedMapList: { getWarpedMap: () => undefined },
			tileCache: { getCacheableTile: () => undefined }
		};

		expect(warpedTilesRequestedForViewport(torn)).toBe(true);
	});
});

test('a tile that was asked for and refused still counts as asked', () => {
	// **The reason this asks about requests rather than about decoded content.** A healthy pyramid
	// answers 404 to some of the cells `@allmaps/iiif-parser` derives, so a tile can be in the cache,
	// finished, and empty for ever. Blocking on those would leave the Map Snapshot control disabled
	// over a map that is drawing perfectly — see the function's own note, and ADR-0028.
	const refused: WarpedViewportTiles = {
		mapsWithFetchableTilesForViewport: new Set(['blaeu']),
		warpedMapList: {
			getWarpedMap: () => ({ fetchableTilesForViewport: [{ tileUrl: 'a' }] })
		},
		// In the cache, as upstream leaves a tile whose fetch failed: present, and holding no data.
		tileCache: { getCacheableTile: () => ({ data: undefined }) }
	};

	expect(warpedTilesRequestedForViewport(refused)).toBe(true);
});
