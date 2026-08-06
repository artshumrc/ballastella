// SPEC's Seam 1: the injection layer driven against an in-memory ProjectStore.
//
// The whole of ADR-0011 is in the two describes below. The first asserts the routing rule —
// what is captured, what is passed through, and what a missing tile answers — against files put
// in the store by hand, so the rule is readable. The second asserts it against a pyramid
// `ingestImageFile` actually wrote, because a routing rule that agrees with a hand-written path
// and disagrees with the tiler would be worse than no rule at all.

import { describe, expect, it } from 'vitest';

import { createImagePane } from '../image-pane/iiif-image-pane.js';
import { ROUND_TRIP_TOLERANCE_PX } from '../image-pane/synthetic-projection.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { ingestImageFile, type OpenTileSource, type TileSource } from '../tiler/ingest.js';
import {
	buildImageInfo,
	imageServiceId,
	serialiseJson,
	type PlannedTile
} from '../tiler/pyramid.js';
import {
	MissingImageServiceOverrideError,
	createStoreImageFetch,
	isImageServicePlaceholderUrl,
	refuseUnroutedImageServiceRequests,
	type FetchFn
} from './store-image-fetch.js';

const bytes = (text: string) => new TextEncoder().encode(text);

/** A store holding one Project directory with one image's `info.json` and one tile. */
async function storeWithTile(): Promise<MemoryProjectStore> {
	const store = new MemoryProjectStore();
	await store.write('amsterdam-1625/images/abc123/info.json', bytes('{"id":"x"}'));
	await store.write(
		'amsterdam-1625/images/abc123/0,0,256,256/256,256/0/default.jpg',
		bytes('tile bytes')
	);
	return store;
}

const placeholderTile = `${imageServiceId('abc123')}/0,0,256,256/256,256/0/default.jpg`;

describe('createStoreImageFetch', () => {
	it('serves a tile that only exists in the store, keyed on the placeholder base URL', async () => {
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625'
		});

		const response = await fetchImage(placeholderTile);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(await response.text()).toBe('tile bytes');
	});

	it('serves the info.json through the same route, so the pane has one way in', async () => {
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625'
		});

		const response = await fetchImage(`${imageServiceId('abc123')}/info.json`);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(await response.json()).toEqual({ id: 'x' });
	});

	it('accepts a URL and a Request, not only a string', async () => {
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625'
		});

		const fromUrl = await fetchImage(new URL(placeholderTile));
		const fromRequest = await fetchImage(new Request(placeholderTile));

		expect(fromUrl.status).toBe(200);
		expect(fromRequest.status).toBe(200);
	});

	it('percent-encoded IIIF commas resolve to the same tile', async () => {
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625'
		});

		const response = await fetchImage(
			`${imageServiceId('abc123')}/0%2C0%2C256%2C256/256%2C256/0/default.jpg`
		);

		expect(await response.text()).toBe('tile bytes');
	});

	it('answers 404 for a tile the pyramid does not hold, naming the path it looked at', async () => {
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625'
		});

		const response = await fetchImage(`${imageServiceId('abc123')}/9,9,1,1/1,1/0/default.jpg`);

		expect(response.status).toBe(404);
		expect(await response.text()).toContain(
			'amsterdam-1625/images/abc123/9,9,1,1/1,1/0/default.jpg'
		);
	});

	it('answers 404 for an image id that is not in this Project', async () => {
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625'
		});

		const response = await fetchImage(`${imageServiceId('not-here')}/info.json`);

		expect(response.status).toBe(404);
	});

	it('answers 404, and never reads, for a placeholder path that is not a store path', async () => {
		const store = await storeWithTile();
		const fetchImage = createStoreImageFetch({ store, projectDirectory: 'amsterdam-1625' });

		// Traversal out of the Project, an empty segment, and the bare base with no IIIF path.
		// A `fetchFn` must answer rather than throw — a stray request must not become an
		// unhandled rejection inside somebody else's renderer — but it must also never turn into
		// a read of a path the caller did not name.
		for (const path of ['../../etc/passwd/1,1/1,1/0/default.jpg', '//info.json', '']) {
			const response = await fetchImage(`${imageServiceId('abc123')}/${path}`);
			expect(response.status, path).toBe(404);
		}

		const bare = await fetchImage(imageServiceId('abc123'));
		expect(bare.status).toBe(404);
	});

	it('answers 405 to a method that is not a read', async () => {
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625'
		});

		const response = await fetchImage(placeholderTile, { method: 'PUT' });

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD');
	});

	it('answers a HEAD with the length and no body, so a size question costs no bytes', async () => {
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625'
		});

		const response = await fetchImage(placeholderTile, { method: 'HEAD' });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('10');
		expect(await response.text()).toBe('');
	});

	it('passes a request to any other host straight through, arguments untouched', async () => {
		const seen: { input: unknown; init: unknown }[] = [];
		const network: FetchFn = async (input, init) => {
			seen.push({ input, init });
			return new Response('from the network');
		};
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625',
			fetch: network
		});

		const init = { headers: { accept: 'image/jpeg' } };
		const remote = 'https://iiif.example.org/abc/0,0,256,256/256,256/0/default.jpg';
		const response = await fetchImage(remote, init);

		expect(await response.text()).toBe('from the network');
		// The same values, not a rebuilt URL: a remote IIIF service is entitled to the request
		// its caller made, including whatever headers a CORS or auth flow put on it.
		expect(seen).toEqual([{ input: remote, init }]);
	});

	it('passes a relative URL through rather than trying to parse it as a placeholder', async () => {
		const seen: unknown[] = [];
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			projectDirectory: 'amsterdam-1625',
			fetch: async (input) => {
				seen.push(input);
				return new Response('from the network');
			}
		});

		await fetchImage('/fixtures/images/floride-1657/info.json');

		expect(seen).toEqual(['/fixtures/images/floride-1657/info.json']);
	});

	it('refuses a Project directory that is not a usable store path, at construction', async () => {
		const store = await storeWithTile();

		expect(() => createStoreImageFetch({ store, projectDirectory: '/absolute' })).toThrow(
			/Invalid store path/
		);
	});
});

describe('isImageServicePlaceholderUrl', () => {
	it('matches the reserved host and nothing else', () => {
		expect(isImageServicePlaceholderUrl(placeholderTile)).toBe(true);
		expect(isImageServicePlaceholderUrl('http://unset.invalid/a/b')).toBe(true);
		expect(isImageServicePlaceholderUrl('https://tiles.unset.invalid/a/b')).toBe(true);
		// A real host that merely ends in the same letters is not the placeholder, and a
		// relative URL is not a host at all.
		expect(isImageServicePlaceholderUrl('https://notunset.invalid/a/b')).toBe(false);
		expect(isImageServicePlaceholderUrl('https://iiif.example.org/a/b')).toBe(false);
		expect(isImageServicePlaceholderUrl('/fixtures/info.json')).toBe(false);
	});
});

describe('refuseUnroutedImageServiceRequests', () => {
	it('turns a placeholder request that escaped the injection layer into a named error', async () => {
		const reached: unknown[] = [];
		const scope = {
			fetch: (async (input) => {
				reached.push(input);
				return new Response('');
			}) as FetchFn
		};

		const restore = refuseUnroutedImageServiceRequests(scope);

		await expect(scope.fetch(placeholderTile)).rejects.toThrow(MissingImageServiceOverrideError);
		// The message has to name the override, because the alternative — what the browser says
		// on its own — is "TypeError: Failed to fetch" from a DNS failure, which diagnoses nothing.
		await expect(scope.fetch(placeholderTile)).rejects.toThrow(/Image#uri/);
		// And nothing left for the network: the request is refused before it is made.
		expect(reached).toEqual([]);

		await scope.fetch('https://iiif.example.org/info.json');
		expect(reached).toEqual(['https://iiif.example.org/info.json']);

		restore();
		await scope.fetch(placeholderTile);
		expect(reached).toHaveLength(2);
	});

	it('is idempotent, and its teardown does not undo somebody else’s wrapper', async () => {
		const scope = { fetch: (async () => new Response('')) as FetchFn };
		const original = scope.fetch;

		const restore = refuseUnroutedImageServiceRequests(scope);
		const wrapped = scope.fetch;
		const second = refuseUnroutedImageServiceRequests(scope);

		expect(scope.fetch).toBe(wrapped);
		second();
		expect(scope.fetch).toBe(wrapped);
		restore();
		expect(scope.fetch).toBe(original);
	});
});

/** A tiler whose bytes are the tile's own geometry, so a test can tell tiles apart. */
const stubTiler =
	(dimensions: { width: number; height: number }): OpenTileSource =>
	async () =>
		({
			dimensions,
			encodeTile: async (tile: PlannedTile) =>
				bytes(`${tile.scaleFactor}/${tile.column},${tile.row}`),
			close: async () => undefined
		}) satisfies TileSource;

/** A PNG header declaring `width` × `height`, so ingest routes on the header and not a decode. */
function pngHeader(width: number, height: number): Uint8Array {
	const header = new Uint8Array(24);
	header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(header.buffer).setUint32(16, width);
	new DataView(header.buffer).setUint32(20, height);
	return header;
}

describe('a pyramid the tiler wrote, read back through the pane', () => {
	/** Ingest one image into a Project and build the pane over it, store-backed throughout. */
	async function ingestAndOpen(width: number, height: number) {
		const store = new MemoryProjectStore();
		const result = await ingestImageFile({
			store,
			projectDirectory: 'amsterdam-1625',
			file: new File([pngHeader(width, height) as BlobPart], 'scan.png', { type: 'image/png' }),
			openDecodeAndCrop: stubTiler({ width, height })
		});

		const fetchImage = createStoreImageFetch({ store, projectDirectory: 'amsterdam-1625' });
		const info = await (await fetchImage(`${imageServiceId(result.imageId)}/info.json`)).json();
		const pane = createImagePane(info, { storedImageId: result.imageId });

		return { store, result, pane, fetchImage };
	}

	it('resolves every tile of every level, ragged edges included, with nothing missing', async () => {
		const { result, pane, fetchImage } = await ingestAndOpen(700, 500);

		const tiles = pane.allTiles();
		expect(tiles).toHaveLength(result.tileCount);

		const statuses = await Promise.all(
			tiles.map(async (tile) => {
				const response = await fetchImage(tile.url);
				return { url: tile.url, status: response.status, body: await response.text() };
			})
		);

		// Not "most of them": a hole in this list is a hole in the pane, and the reader and the
		// writer agreeing everywhere is the whole reason both go through `getTileImageRequest`.
		expect(statuses.filter((tile) => tile.status !== 200)).toEqual([]);
		// Every tile the pane asked for is the tile the tiler wrote there, not merely *a* tile —
		// **paired per URL**, not compared as two sorted lists. Sorting both sides accepted any
		// bijection of the pyramid's paths, so a shim that resolved each URL to the *next* tile's
		// file would have answered 200 nine times, matched as a set, and drawn the pyramid scrambled.
		expect(
			statuses.map(({ url, body }) => ({ url, body })),
			'the pane and the tiler disagree about which tile is where'
		).toEqual(
			tiles.map((tile) => ({
				url: tile.url,
				body: `${tile.scaleFactor}/${tile.column},${tile.row}`
			}))
		);

		// Every level is represented, and the right and bottom margins are ragged at each of them.
		expect([...new Set(tiles.map((tile) => tile.scaleFactor))]).toEqual([1, 2, 4]);
		for (const scaleFactor of [1, 2, 4]) {
			const atLevel = tiles.filter((tile) => tile.scaleFactor === scaleFactor);
			expect(
				atLevel.some((tile) => tile.placement.width < pane.tileSize),
				`no ragged right-margin tile at scale factor ${scaleFactor}`
			).toBe(true);
			expect(
				atLevel.some((tile) => tile.placement.height < pane.tileSize),
				`no ragged bottom-margin tile at scale factor ${scaleFactor}`
			).toBe(true);
		}
	});

	it('builds tile URLs on the placeholder host, so the shim is the only way to reach them', async () => {
		const { result, pane } = await ingestAndOpen(700, 500);

		expect(pane.image.uri).toBe(imageServiceId(result.imageId));
		expect(pane.allTiles().every((tile) => isImageServicePlaceholderUrl(tile.url))).toBe(true);
	});

	/**
	 * Worst round-trip error over a grid of points deliberately **off** the binary grid.
	 *
	 * Ticket 03's review recorded why that matters: sample at integers or half-integers on a
	 * power-of-two window and `WINDOW_ORIGIN + t` comes out exact, so the measurement reads 0 and
	 * says nothing about float64. The strides below are chosen to be non-dyadic.
	 */
	const worstRoundTrip = (pane: ReturnType<typeof createImagePane>) => {
		let x = 0;
		let y = 0;
		const { width, height } = pane.image;

		for (let column = 0; column <= 97; column++) {
			for (let row = 0; row <= 89; row++) {
				const point = { x: (width * column) / 97 + 1 / 3, y: (height * row) / 89 + 1 / 7 };
				const back = pane.syntheticToResource(pane.resourceToSynthetic(point));
				x = Math.max(x, Math.abs(back.x - point.x));
				y = Math.max(y, Math.abs(back.y - point.y));
			}
		}

		return { x, y };
	};

	it('keeps the projection’s round-trip precision on a store-backed pyramid', async () => {
		// The measured number, against a pyramid that came out of the tiler rather than out of a
		// committed fixture. `ROUND_TRIP_TOLERANCE_PX` is a scaling law with documented headroom and
		// this slice must not be what spends it: where the bytes come from does not enter the
		// arithmetic, so the expected answer is that nothing changed at all.
		const { pane } = await ingestAndOpen(700, 500);
		const small = worstRoundTrip(pane);

		// And at a size a real archival scan reaches, where the window is large enough for the
		// error to be non-zero. Only `info.json` is written for this one — thirty thousand stub
		// tiles would measure the test's patience rather than the projection — and it is still read
		// back out of the store through the shim, which is what the pane depends on.
		const store = new MemoryProjectStore();
		const info = buildImageInfo({ imageId: 'big', width: 60000, height: 24000 });
		await store.write('amsterdam-1625/images/big/info.json', serialiseJson(info));
		const fetchImage = createStoreImageFetch({ store, projectDirectory: 'amsterdam-1625' });
		const large = worstRoundTrip(
			createImagePane(await (await fetchImage(`${imageServiceId('big')}/info.json`)).json(), {
				storedImageId: 'big'
			})
		);

		console.log(
			`store-backed round trip (worst Δ over 8 800 off-grid points), tolerance ` +
				`${ROUND_TRIP_TOLERANCE_PX} px:\n` +
				`  700 × 500, scale factors 1–4:      Δx ${small.x.toExponential(2)} px, ` +
				`Δy ${small.y.toExponential(2)} px\n` +
				`  60000 × 24000, scale factors 1–256: Δx ${large.x.toExponential(2)} px, ` +
				`Δy ${large.y.toExponential(2)} px`
		);

		for (const [label, worst] of [
			['700 × 500', small],
			['60000 × 24000', large]
		] as const) {
			expect(worst.x, `${label} Δx`).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
			expect(worst.y, `${label} Δy`).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
		}
	});

	it('keeps two images in one Project apart', async () => {
		const store = new MemoryProjectStore();
		const ingest = (width: number, height: number) =>
			ingestImageFile({
				store,
				projectDirectory: 'amsterdam-1625',
				file: new File([pngHeader(width, height) as BlobPart], 'scan.png', { type: 'image/png' }),
				openDecodeAndCrop: stubTiler({ width, height })
			});

		const wide = await ingest(700, 500);
		const tall = await ingest(300, 900);
		const fetchImage = createStoreImageFetch({ store, projectDirectory: 'amsterdam-1625' });

		const panes = await Promise.all(
			[wide, tall].map(async (result) =>
				createImagePane(
					await (await fetchImage(`${imageServiceId(result.imageId)}/info.json`)).json(),
					{ storedImageId: result.imageId }
				)
			)
		);

		expect(panes.map((pane) => [pane.image.width, pane.image.height])).toEqual([
			[700, 500],
			[300, 900]
		]);

		// The two pyramids answer on their own ids and on nobody else's. Both hold a tile at
		// `0,0,256,256` — the same IIIF path in two images — so the id is doing the whole of the
		// work, and asking the wrong one is the failure a single shared prefix would hide.
		const [widePane, tallPane] = panes as [(typeof panes)[0], (typeof panes)[0]];
		const shared = '0,0,256,256/256,256/0/default.jpg';
		const wideShared = widePane.allTiles().find((tile) => tile.url.endsWith(shared))!;
		const tallShared = tallPane.allTiles().find((tile) => tile.url.endsWith(shared))!;

		expect(await (await fetchImage(wideShared.url)).text()).toBe('1/0,0');
		expect(await (await fetchImage(tallShared.url)).text()).toBe('1/0,0');
		expect(wideShared.url).not.toBe(tallShared.url);

		// And a tile only the wider image has is not there under the taller one's id: 700 pixels
		// wide is three columns at full resolution, 300 is two.
		const wideOnly = widePane
			.allTiles()
			.find((tile) => tile.column === 2 && tile.scaleFactor === 1)!;
		expect((await fetchImage(wideOnly.url)).status).toBe(200);
		expect(
			(await fetchImage(wideOnly.url.replace(wide.imageId, tall.imageId))).status,
			'one image answered for another'
		).toBe(404);
	});
});
