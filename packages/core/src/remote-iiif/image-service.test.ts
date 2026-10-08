import { describe, expect, it } from 'vitest';

import { createImagePane } from '../image-pane/iiif-image-pane';
import { imageService3, rejection } from '../test-support.js';
import { acceptCaptured, captured } from './corpus-fixture.js';
import { acceptRemoteImageService, readRemoteImageService } from './image-service';
import { RemoteIiifRejectedError } from './remote-resource';

const corpusShape: [name: string, tileSize: number, synthesised: number | null][] = [
	['loc-gmd-map', 512, null],
	['loc-world-digital-library', 512, null],
	['bodleian', 256, null],
	['harvard-ids', 512, null],
	['cambridge', 256, null],
	['stanford', 1024, null],
	['wellcome', 1024, null],
	['e-codices', 1024, null],
	['leipzig', 256, null],
	['nypl', 512, null],
	['rijks-micrio', 1024, null],
	['iiif-cookbook', 512, 8],
	['iiif-2-1-reference', 512, 16],
	['mdz-bayerische-staatsbibliothek', 768, 8]
];

describe('real IIIF services in the wild', () => {
	it.each(corpusShape)('%s is accepted, with %ipx tiles', async (name, tileSize, synthesised) => {
		const remote = await acceptCaptured(name);
		expect(remote.tileSize).toBe(tileSize);
		expect(remote.synthesisedCoarsestScaleFactor).toBe(synthesised);
		expect(remote.imageId).toMatch(/^[0-9a-f]{16}$/);
	});

	it('trips neither of the image pane’s two guards on any captured service, extending only the three that fall short, by coarser levels', async () => {
		for (const [name, tileSize, synthesised] of corpusShape) {
			const remote = await acceptCaptured(name);
			const levels = remote.pane.allTiles();
			const factors = [...new Set(levels.map((tile) => tile.scaleFactor))].sort((a, b) => a - b);
			const tileSizes = new Set(levels.map((tile) => `${tile.placement.width}`.length > 0));
			expect(Math.min(...factors), `${name} finest level`).toBe(1);
			expect(factors, `${name} contiguity`).toEqual(factors.map((_, index) => 2 ** index));
			expect(tileSizes.size, `${name} tile sizes`).toBe(1);
			const coarsest = Math.max(...factors);
			const window = tileSize * coarsest;
			expect(window >= remote.width && window >= remote.height, `${name} window`).toBe(true);
			if (synthesised !== null) expect(coarsest, `${name} coarsest`).toBe(synthesised);
		}
	});

	it('takes the service’s own declared id as canonical, not the URL that was fetched', async () => {
		const harvard = await acceptCaptured('harvard-ids');
		expect(harvard.requestedUrl).toContain('ids.lib.harvard.edu');
		expect(harvard.uri).toBe('https://mps.lib.harvard.edu/assets/images/drs:47174896');
		expect(harvard.pane.allTiles()[0]?.url).toContain('mps.lib.harvard.edu');
		expect(harvard.pane.allTiles()[0]?.url).not.toContain('ids.lib.harvard.edu');
	});

	it('reads a tileset that omits its height, rather than guessing at a non-square tile', async () => {
		expect(captured('e-codices').info.tiles).toEqual([
			{ width: 1024, scaleFactors: [1, 2, 4, 8, 16, 32] }
		]);
		expect((await acceptCaptured('e-codices')).tileSize).toBe(1024);
	});

	it('probes a ragged tile so the geometry check can run, and a second, coarse tile exactly when a level was synthesised', async () => {
		for (const [name, , synthesised] of corpusShape) {
			const remote = await acceptCaptured(name);
			expect(remote.probeTileIsRagged, `${name} probe tile`).toBe(true);
			expect(remote.probeTiles[0]?.scaleFactor, `${name} probe level`).toBe(1);
			expect(remote.probeTiles.length, `${name} probe count`).toBe(synthesised === null ? 1 : 2);
			if (synthesised !== null) {
				expect(remote.probeTiles[1]?.scaleFactor, `${name} coarse probe`).toBe(synthesised);
			}
		}
	});
});

describe('the Bayerische Staatsbibliothek, which declares no tiles at all', () => {
	it('is drawn through a tileset @allmaps/iiif-parser invents, with the missing level added', async () => {
		expect(captured('mdz-bayerische-staatsbibliothek').info.tiles).toBeUndefined();
		const remote = await acceptCaptured('mdz-bayerische-staatsbibliothek');
		expect(remote.tileSize).toBe(768);
		expect(remote.synthesisedCoarsestScaleFactor).toBe(8);
		expect(remote.pane.allTiles().filter((tile) => tile.scaleFactor === 8)).toHaveLength(1);
	});
});

const SHEET = 'https://iiif.example.test/iiif/3/sheet';

const sheet = (fields: Record<string, unknown> = {}) =>
	imageService3({
		id: SHEET,
		width: 1200,
		height: 851,
		tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }],
		...fields
	});

const refusal = (info: unknown, requestedUrl = `${SHEET}/info.json`, fallbackUri = 'x') =>
	rejection(RemoteIiifRejectedError, acceptRemoteImageService(info, { requestedUrl, fallbackUri }));

describe('a service that declares too few levels and will not serve more', () => {
	it('is refused, naming the host, rather than drawn from levels it never offered', async () => {
		const failure = await refusal(
			sheet({
				id: 'https://static.example.test/tiles/sheet',
				width: 4032,
				height: 3024,
				tiles: [{ width: 512, height: 512, scaleFactors: [1, 2, 4] }]
			}),
			'https://static.example.test/tiles/sheet/info.json',
			'https://static.example.test/tiles/sheet'
		);

		expect(failure.host).toBe('static.example.test');
		expect(failure.message).toContain('coarsest level is not a single tile');
		expect(failure.message).toContain('make an offline copy');
	});
});

describe('the two shapes the image pane refuses, which only a stranger’s info.json can have', () => {
	const notFull = sheet({ tiles: [{ width: 256, height: 256, scaleFactors: [2, 4, 8] }] });
	const mixed = sheet({
		tiles: [
			{ width: 256, height: 256, scaleFactors: [1, 2] },
			{ width: 512, height: 512, scaleFactors: [4, 8] }
		]
	});

	it('refuses a pyramid whose finest level is not full resolution, naming the host', async () => {
		const failure = await refusal(notFull);
		expect(failure.host).toBe('iiif.example.test');
		expect(failure.message).toContain('finest level must be scale factor 1');
	});

	it('refuses levels of differing tile sizes, naming the host', async () => {
		const failure = await refusal(mixed);
		expect(failure.host).toBe('iiif.example.test');
		expect(failure.message).toContain('must use one tile size');
	});

	it('is refusing shapes createImagePane really does reject — the guards are not restated here', () => {
		expect(() => createImagePane(notFull, 'https://x.test')).toThrow(
			/finest level must be scale factor 1/
		);
		expect(() => createImagePane(mixed, 'https://x.test')).toThrow(/must use one tile size/);
	});
});

describe('bounds on what a stranger’s info.json may declare', () => {
	const withSize = (width: unknown, height: unknown) => sheet({ width, height });

	it.each([
		['a fractional width', withSize(1200.5, 851), /width is 1200.5/],
		['a negative height', withSize(1200, -851), /height is -851/],
		['a width past Number.MAX_SAFE_INTEGER', withSize(2 ** 60, 851), /width is/],
		['more pixels than this app will accept', withSize(2_000_000, 3_000_000), /gigapixels/]
	])('refuses %s', async (_what, info, expected) => {
		expect((await refusal(info)).message).toMatch(expected);
	});

	it('refuses a service whose own maxWidth is smaller than the tiles it declares', async () => {
		const failure = await refusal(sheet({ maxWidth: 200 }));
		expect(failure.message).toContain('maxWidth');
		expect(failure.message).toContain('will not serve the tiles it just described');
	});
});

describe('the id a stranger’s document declares for itself', () => {
	const adopt = (id: unknown) =>
		acceptRemoteImageService(sheet({ id }), {
			requestedUrl: 'https://library.test/iiif/3/sheet/info.json',
			fallbackUri: 'https://library.test/iiif/3/sheet'
		});

	it('is adopted from another host, because that is ordinary IIIF and a real service does it', async () => {
		const remote = await adopt('https://mps.other.test/assets/images/drs:47174896');
		expect(remote.uri).toBe('https://mps.other.test/assets/images/drs:47174896');
		expect(remote.requestedUrl).toContain('library.test');
		expect(remote.pane.allTiles()[0]?.url).toContain('mps.other.test');
	});

	it.each([
		['a relative address', '/iiif/3/sheet'],
		['a javascript: URL', 'javascript:alert(1)'],
		['a data: URL', 'data:application/json,%7B%7D'],
		['an address carrying a password', 'https://alice:secret@other.test/iiif/3/sheet']
	])('refuses %s, naming the host that sent it', async (_what, id) => {
		const failure = await rejection(RemoteIiifRejectedError, adopt(id));
		expect(failure.host).toBe('library.test');
		expect(failure.message).toContain('library.test');
		expect(failure.message).toContain(id);
		expect(failure.message).toContain('Nothing has been added');
	});
});

describe('reading a service over the network', () => {
	const bodleian = captured('bodleian');
	const serve = (requests: string[] = []) =>
		readRemoteImageService(bodleian.fetchedFrom, {
			fetch: async (input) => {
				requests.push(String(input));
				return new Response(JSON.stringify(bodleian.info), {
					headers: { 'content-type': 'application/json' }
				});
			}
		});

	it('normalises a URL that ends in /info.json, because that is what people copy, and mints the id the live Allmaps API keys it on', async () => {
		const requests: string[] = [];
		const remote = await serve(requests);

		expect(requests).toEqual([
			'https://iiif.bodleian.ox.ac.uk/iiif/image/e32a277e-91e2-4a6d-8ba6-cc4bad230410/info.json'
		]);
		expect(remote.uri).toBe(
			'https://iiif.bodleian.ox.ac.uk/iiif/image/e32a277e-91e2-4a6d-8ba6-cc4bad230410'
		);
		expect(remote.imageId).toBe('a8eb9e9cf936cc3d');
	});
});
