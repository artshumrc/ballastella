import { describe, expect, it } from 'vitest';

import { createImagePane } from '../image-pane/iiif-image-pane';
import { MemoryProjectStore } from '../store/memory-project-store';
import { imageDirectory } from '../project/image-files';
import { buildImageInfo, imageServiceId, planPyramid } from '../tiler/pyramid';
import {
	storedPyramidTileSource,
	type OpenSeadragonTileContext
} from './openseadragon-tile-source';
import { createStoreImageFetch } from './store-image-fetch';

// The fourth ADR-0011 injection point, and the only substantial one. It is asserted against the
// *writer* rather than against a restatement of IIIF's URL syntax: every URL this source asks for
// has to be a path the tiler really wrote, or a local pyramid opens with blank tiles and an
// OpenSeadragon error about a host that does not exist.

const IMAGE_ID = 'local-1234';
const WIDTH = 1200;
const HEIGHT = 851;
const info = buildImageInfo({ imageId: IMAGE_ID, width: WIDTH, height: HEIGHT });

const source = (fetch: Parameters<typeof storedPyramidTileSource>[0]['fetch']) =>
	storedPyramidTileSource({
		imageId: IMAGE_ID,
		width: WIDTH,
		height: HEIGHT,
		tileSize: info.tiles[0].width,
		scaleFactors: info.tiles[0].scaleFactors,
		fetch,
		// Node has no `createImageBitmap`, and what is being asserted is the fetch-and-finish
		// protocol rather than the decoder.
		decode: async (bytes) => ({ decoded: await bytes.text() })
	});

const refuseNetwork = async () => {
	throw new Error('a stored pyramid must never reach the network');
};

/** One `downloadTileStart` call, awaited to whatever it finished with. */
const download = (
	tileSource: ReturnType<typeof storedPyramidTileSource>,
	url: string
): Promise<{ data: unknown; error?: string }> =>
	new Promise((resolve) => {
		const context: OpenSeadragonTileContext = {
			src: url,
			finish: (data, _request, errorMessage) =>
				resolve(errorMessage === undefined ? { data } : { data, error: errorMessage })
		};
		tileSource.downloadTileStart(context);
	});

describe('the OpenSeadragon tile source for a pyramid in a Project', () => {
	it('numbers its levels the way OpenSeadragon does — coarsest first', () => {
		// IIIF counts by scale factor, so its coarsest level is its *largest* factor; OpenSeadragon
		// counts up from 0 at the coarsest. The two orders are reverses of each other, and this is the
		// only place in the codebase that knows it.
		const tiles = source(refuseNetwork);

		expect(tiles.minLevel).toBe(0);
		expect(tiles.maxLevel).toBe(info.tiles[0].scaleFactors.length - 1);
		// Level 0 is the whole image in one tile; the deepest level is full resolution.
		expect(tiles.getNumTiles(0)).toEqual({ x: 1, y: 1 });
		expect(tiles.getLevelScale(tiles.maxLevel)).toBe(1);
		expect(tiles.getNumTiles(tiles.maxLevel)).toEqual({
			x: Math.ceil(WIDTH / 256),
			y: Math.ceil(HEIGHT / 256)
		});
	});

	it('asks only for URLs the tiler really wrote', () => {
		// **The assertion that matters.** Every tile URL is checked against `planPyramid` — the writer's
		// own list, built from `Image#getImageUrl` — so this source cannot address a tile that does not
		// exist. A second implementation of IIIF's URL syntax that agreed with the writer until
		// somebody edited one of them is exactly what ADR-0003 is written against.
		const tiles = source(refuseNetwork);
		const written = new Set(
			planPyramid(info, imageDirectory(IMAGE_ID)).map((tile) =>
				tile.path.replace(`${imageDirectory(IMAGE_ID)}/`, '')
			)
		);
		const asked: string[] = [];

		for (let level = tiles.minLevel; level <= tiles.maxLevel; level += 1) {
			const { x: columns, y: rows } = tiles.getNumTiles(level);
			for (let row = 0; row < rows; row += 1) {
				for (let column = 0; column < columns; column += 1) {
					const url = tiles.getTileUrl(level, column, row);
					expect(url.startsWith(`${imageServiceId(IMAGE_ID)}/`)).toBe(true);
					asked.push(url.slice(`${imageServiceId(IMAGE_ID)}/`.length));
				}
			}
		}

		// Same set, both ways: nothing asked for that was not written, and nothing written that the
		// source cannot reach.
		expect([...asked].sort()).toEqual([...written].sort());
	});

	it('agrees with the image pane’s reader tile for tile', () => {
		// The two readers of one pyramid — MapLibre's, through `createImagePane`, and OpenSeadragon's,
		// here. They must ask for the same bytes, or the same map looks different in the two panes.
		const pane = createImagePane(info, { storedImageId: IMAGE_ID });
		const tiles = source(refuseNetwork);
		const fromPane = new Set(pane.allTiles().map((tile) => tile.url));
		const fromSource = new Set<string>();

		for (let level = tiles.minLevel; level <= tiles.maxLevel; level += 1) {
			const { x: columns, y: rows } = tiles.getNumTiles(level);
			for (let row = 0; row < rows; row += 1) {
				for (let column = 0; column < columns; column += 1) {
					fromSource.add(tiles.getTileUrl(level, column, row));
				}
			}
		}

		expect([...fromSource].sort()).toEqual([...fromPane].sort());
	});

	it('reads a tile out of the store and never touches the network', async () => {
		const store = new MemoryProjectStore();
		const tile = planPyramid(info, imageDirectory(IMAGE_ID))[0]!;
		// At the Workspace root, which is where a pyramid lives (ADR-0023) and therefore what
		// `planPyramid` already produces: `tile.path` is the complete store path with nothing prefixed.
		await store.write(tile.path, new TextEncoder().encode('tile bytes'));
		const tiles = source(createStoreImageFetch({ store, fetch: refuseNetwork }));

		const url = `${imageServiceId(IMAGE_ID)}/${tile.path.replace(`${imageDirectory(IMAGE_ID)}/`, '')}`;
		const finished = await download(tiles, url);

		expect(finished.error).toBeUndefined();
		expect(finished.data).toEqual({ decoded: 'tile bytes' });
	});

	it('reports a tile that is not in the Workspace, rather than a DNS failure', async () => {
		// Without this the user meets `TypeError: Failed to fetch` against a `.invalid` host, which
		// says nothing about a pyramid. `.invalid` is reserved precisely so that the failure is loud —
		// this makes it legible as well.
		const tiles = source(
			createStoreImageFetch({ store: new MemoryProjectStore(), fetch: refuseNetwork })
		);

		const finished = await download(tiles, tiles.getTileUrl(tiles.maxLevel, 0, 0));

		expect(finished.data).toBeNull();
		expect(finished.error).toContain('is not in this Workspace');
	});

	it('does not decode a tile whose download was abandoned', async () => {
		// A pyramid is tens of thousands of tiles and OpenSeadragon abandons them constantly while
		// panning. A version that finished anyway would call back for a tile the drawer has forgotten,
		// and a version that leaked its bitmap would leak once per abandoned tile.
		let released = 0;
		let finishes = 0;
		const tiles = storedPyramidTileSource({
			imageId: IMAGE_ID,
			width: WIDTH,
			height: HEIGHT,
			tileSize: 256,
			scaleFactors: info.tiles[0].scaleFactors,
			fetch: async () => new Response('tile bytes'),
			decode: async () => ({ close: () => (released += 1) })
		});

		const context: OpenSeadragonTileContext = {
			src: tiles.getTileUrl(tiles.maxLevel, 0, 0),
			finish: () => (finishes += 1)
		};
		tiles.downloadTileStart(context);
		tiles.downloadTileAbort(context);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(finishes).toBe(0);
		expect(released).toBe(1);
	});

	it('refuses to be built from a pyramid it cannot describe', () => {
		const bad = (overrides: Record<string, unknown>) =>
			storedPyramidTileSource({
				imageId: IMAGE_ID,
				width: WIDTH,
				height: HEIGHT,
				tileSize: 256,
				scaleFactors: [1, 2, 4, 8],
				fetch: refuseNetwork,
				...overrides
			});

		expect(() => bad({ width: 0 })).toThrow(/dimensions must be positive/);
		expect(() => bad({ tileSize: 0 })).toThrow(/tile size must be positive/);
		expect(() => bad({ scaleFactors: [] })).toThrow(/declares no scale factors/);
	});
});
