import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createImagePane } from '../image-pane/iiif-image-pane';
import { acceptRemoteImageService, readRemoteImageService } from './image-service';
import { RemoteIiifRejectedError } from './remote-resource';

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE CORPUS IS REAL, AND THAT IS THE WHOLE POINT
//
// Every test above the fold reads `fixtures/real-world-image-services.json`: fourteen `info.json`
// documents captured verbatim from live services — the Library of Congress' Geography and Map
// Division, Digital Bodleian, Harvard IDS, Cambridge, Stanford, Wellcome, e-codices, Leipzig,
// NYPL, Micrio, the two IIIF reference examples, and the Bayerische Staatsbibliothek.
//
// A fixture written by hand can only confirm what its author already believed. These documents
// were not written to be tested against, and three of them turned out to do something no
// hand-written fixture in this repository does: one declares no `tiles` at all, one omits
// `tiles[].height`, and one declares an `id` on a **different host** from the URL it was fetched
// from. Each of those is a real behaviour of this slice, and none was predicted.
//
// **Captured verbatim, so the fixture spells things the way the servers do.** Ten of the fourteen
// list `"mirroring"` in `extraFeatures` — a IIIF Image API 3 feature name, meaning the service can
// reflect an image about its vertical axis. It is a third-party API member and has nothing to do
// with CONTEXT.md's **Offline Copy**, so it is not ours to rename; editing it would make the
// corpus stop being a capture, which is the one property it has.

const corpus = JSON.parse(
	readFileSync(new URL('fixtures/real-world-image-services.json', import.meta.url), 'utf8')
) as {
	services: {
		name: string;
		note: string;
		fetchedFrom: string;
		observedHeaders: Record<string, string | null>;
		info: { width?: number; height?: number; id?: string; '@id'?: string; tiles?: unknown };
	}[];
};

const service = (name: string) => {
	const found = corpus.services.find((entry) => entry.name === name);
	if (!found) throw new Error(`No captured service called “${name}”.`);
	return found;
};

const accept = (name: string) => {
	const captured = service(name);
	return acceptRemoteImageService(captured.info, {
		requestedUrl: captured.fetchedFrom,
		fallbackUri: captured.fetchedFrom.replace(/\/info\.json$/, '')
	});
};

/**
 * Every captured service, with the tile size it declares and the coarsest scale factor this app
 * had to add for the coarsest level to be a single tile — `null` where the service already
 * declared enough.
 *
 * **The third column is the finding.** Eleven of fourteen real services declare a pyramid whose
 * coarsest level already reduces the image to one tile, which is what our own tiler produces by
 * construction. Three do not, and nothing in the Image API says they must — two of the three are
 * the specification's *own* reference examples. See `extendedTileset` for what is done about it and
 * why it is not a relaxed guard.
 */
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
		const remote = await accept(name);

		expect(remote.tileSize).toBe(tileSize);
		expect(remote.synthesisedCoarsestScaleFactor).toBe(synthesised);
		// The identifier is 16 hex characters, which is what `generateId` produces and what
		// `annotations.allmaps.org` keys on.
		expect(remote.imageId).toMatch(/^[0-9a-f]{16}$/);
	});

	it('trips neither of the image pane’s two guards on any captured service', async () => {
		// The finding, stated as an assertion rather than left implicit above: **no live service in
		// this corpus declares a finest level other than 1, and none declares levels of differing tile
		// sizes.** Both guards exist for shapes the Image API permits and that no real service in this
		// sample currently emits — so they are refusals held for the day one does, not dead code, and
		// this is the evidence for that claim rather than an assumption about it.
		for (const [name] of corpusShape) {
			const levels = (await accept(name)).pane.allTiles();
			const factors = [...new Set(levels.map((tile) => tile.scaleFactor))].sort((a, b) => a - b);
			const tileSizes = new Set(levels.map((tile) => `${tile.placement.width}`.length > 0));

			expect(Math.min(...factors), `${name} finest level`).toBe(1);
			expect(factors, `${name} contiguity`).toEqual(factors.map((_, index) => 2 ** index));
			expect(tileSizes.size, `${name} tile sizes`).toBe(1);
		}
	});

	it('extends only the three that fall short, and only by adding coarser levels', async () => {
		// The mutation guard for the table's third column: if `extendedTileset` started firing for
		// every service, or stopped firing at all, the table above would still pass as long as the
		// numbers were edited to match. This pins the *shape* of the change instead — the extension
		// only ever appends coarser levels, and never touches the finest.
		for (const [name, tileSize, synthesised] of corpusShape) {
			const remote = await accept(name);
			const factors = [...new Set(remote.pane.allTiles().map((tile) => tile.scaleFactor))];
			const coarsest = Math.max(...factors);
			const window = tileSize * coarsest;

			expect(window >= remote.width && window >= remote.height, `${name} window`).toBe(true);
			if (synthesised !== null) expect(coarsest, `${name} coarsest`).toBe(synthesised);
		}
	});

	it('takes the service’s own declared id as canonical, not the URL that was fetched', async () => {
		// `ids.lib.harvard.edu/ids/iiif/47174896/info.json` answers with a document whose `id` is on
		// `mps.lib.harvard.edu`. The Image API requires `id` to be the base every image request is
		// built on, so the fetched URL is the wrong one to build tile URLs from *and* the wrong one to
		// mint an identifier from — a second URL redirecting to the same service would otherwise
		// produce a second, different Map Image and a second, different community lookup.
		const harvard = await accept('harvard-ids');

		expect(harvard.requestedUrl).toContain('ids.lib.harvard.edu');
		expect(harvard.uri).toBe('https://mps.lib.harvard.edu/assets/images/drs:47174896');
		expect(harvard.pane.allTiles()[0]?.url).toContain('mps.lib.harvard.edu');
		expect(harvard.pane.allTiles()[0]?.url).not.toContain('ids.lib.harvard.edu');
	});

	it('reads a tileset that omits its height, rather than guessing at a non-square tile', async () => {
		// e-codices and both Library of Congress services declare `{"width": N, "scaleFactors": […]}`
		// with no `height`. ADR-0003 names this as the pitfall that makes a pyramid read back at the
		// wrong shape; `@allmaps/iiif-parser` falls back to `height || width`, which is the right
		// answer for a square tileset, and `createSyntheticProjection` refuses a non-square one.
		expect(service('e-codices').info.tiles).toEqual([
			{ width: 1024, scaleFactors: [1, 2, 4, 8, 16, 32] }
		]);
		expect((await accept('e-codices')).tileSize).toBe(1024);
	});

	it('probes a ragged tile wherever the image has one, so the geometry check can run', async () => {
		// The exact-resize check in `cors-probe.ts` is only meaningful on a tile whose served size is
		// not a whole tile — see `chooseProbeTiles`. Every captured service has one, because no real
		// scan is a whole number of tiles across; asserted here so that a change to the probe-tile
		// choice cannot quietly turn that check into a no-op.
		for (const [name] of corpusShape) {
			const remote = await accept(name);
			expect(remote.probeTileIsRagged, `${name} probe tile`).toBe(true);
			expect(remote.probeTiles[0]?.scaleFactor, `${name} probe level`).toBe(1);
		}
	});

	it('probes a second, coarse tile exactly when a level was synthesised', async () => {
		// The claim `extendedTileset` rests on is that a service declaring `supportsAnyRegionAndSize`
		// will serve a tile at a scale factor it never listed. That claim is checked rather than
		// trusted, and this is what makes sure the check is actually wired: no synthesised level, one
		// probe; a synthesised level, two — the second at exactly that level.
		for (const [name, , synthesised] of corpusShape) {
			const remote = await accept(name);
			expect(remote.probeTiles.length, `${name} probe count`).toBe(synthesised === null ? 1 : 2);
			if (synthesised !== null) {
				expect(remote.probeTiles[1]?.scaleFactor, `${name} coarse probe`).toBe(synthesised);
			}
		}
	});
});

describe('the Bayerische Staatsbibliothek, which declares no tiles at all', () => {
	it('is drawn through a tileset @allmaps/iiif-parser invents, with the missing level added', async () => {
		// **A live finding, not a synthetic case.** `api.digitale-sammlungen.de` declares `sizes` and
		// no `tiles`. `@allmaps/iiif-parser` invents a 768px tileset for any service that supports
		// arbitrary regions — and invents one level too few: `getDefaultTileset` emits `maxExponent`
		// factors starting at 2**0, so its coarsest spans `768 * 2**(maxExponent-1)` = 3072px of a
		// 4098px-wide image and never covers it. That is an upstream off-by-one; reported with the
		// ticket, and worked around here by `extendedTileset` rather than by relaxing anything.
		expect(service('mdz-bayerische-staatsbibliothek').info.tiles).toBeUndefined();

		const remote = await accept('mdz-bayerische-staatsbibliothek');

		expect(remote.tileSize).toBe(768);
		expect(remote.synthesisedCoarsestScaleFactor).toBe(8);
		// The level upstream stopped one short of. Without it the pane cannot show the whole sheet.
		expect(remote.pane.allTiles().filter((tile) => tile.scaleFactor === 8)).toHaveLength(1);
	});
});

describe('a service that declares too few levels and will not serve more', () => {
	it('is refused, naming the host, rather than drawn from levels it never offered', async () => {
		// `extendedTileset` may only add levels a service has said it will serve. A level 0 service
		// serves exactly the tiles it declares and nothing else, so for one of those an undeclared
		// scale factor really is a 404 — and this is the case that must stay a refusal.
		const failure = await acceptRemoteImageService(
			{
				'@context': 'http://iiif.io/api/image/3/context.json',
				id: 'https://static.example.test/tiles/sheet',
				type: 'ImageService3',
				protocol: 'http://iiif.io/api/image',
				profile: 'level0',
				width: 4032,
				height: 3024,
				tiles: [{ width: 512, height: 512, scaleFactors: [1, 2, 4] }]
			},
			{
				requestedUrl: 'https://static.example.test/tiles/sheet/info.json',
				fallbackUri: 'https://static.example.test/tiles/sheet'
			}
		).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure).toBeInstanceOf(RemoteIiifRejectedError);
		expect(failure?.host).toBe('static.example.test');
		expect(failure?.message).toContain('coarsest level is not a single tile');
		expect(failure?.message).toContain('make an offline copy');
	});
});

describe('the two shapes the image pane refuses, which only a stranger’s info.json can have', () => {
	const level0 = (tiles: unknown, width = 1200, height = 851) => ({
		'@context': 'http://iiif.io/api/image/3/context.json',
		id: 'https://iiif.example.test/iiif/3/sheet',
		type: 'ImageService3',
		protocol: 'http://iiif.io/api/image',
		profile: 'level0',
		width,
		height,
		tiles
	});

	it('refuses a pyramid whose finest level is not full resolution, naming the host', async () => {
		// Passes contiguity as a *sequence* — 2, 4, 8 are consecutive powers of two — and then
		// `levelForTileZoom(maxTileZoom)` finds nothing, so "zoom to full resolution" is a blank pane
		// with nothing logged anywhere.
		const failure = await acceptRemoteImageService(
			level0([{ width: 256, height: 256, scaleFactors: [2, 4, 8] }]),
			{ requestedUrl: 'https://iiif.example.test/iiif/3/sheet/info.json', fallbackUri: 'x' }
		).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure?.host).toBe('iiif.example.test');
		expect(failure?.message).toContain('finest level must be scale factor 1');
	});

	it('refuses levels of differing tile sizes, naming the host', async () => {
		// Entirely legal IIIF, and the Image API 3.0 specification gives this exact shape as an
		// example. `@allmaps/iiif-parser` flattens the two tilesets into one list of levels, so the
		// scale factors come out contiguous and every other guard passes — while the coarse levels
		// would be drawn against `levels[0]`'s tile size, at half scale: right at the tile origin and
		// progressively wrong away from it.
		const failure = await acceptRemoteImageService(
			level0([
				{ width: 256, height: 256, scaleFactors: [1, 2] },
				{ width: 512, height: 512, scaleFactors: [4, 8] }
			]),
			{ requestedUrl: 'https://iiif.example.test/iiif/3/sheet/info.json', fallbackUri: 'x' }
		).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure?.host).toBe('iiif.example.test');
		expect(failure?.message).toContain('must use one tile size');
	});

	it('is refusing shapes createImagePane really does reject — the guards are not restated here', () => {
		// The mutation check for the two tests above. They would pass just as well if this module
		// contained its own copy of the guards and `createImagePane` had none, which is the failure
		// mode reviews here keep finding. So: the same two documents, straight into the pane's reader.
		expect(() =>
			createImagePane(
				level0([{ width: 256, height: 256, scaleFactors: [2, 4, 8] }]),
				'https://x.test'
			)
		).toThrow(/finest level must be scale factor 1/);
		expect(() =>
			createImagePane(
				level0([
					{ width: 256, height: 256, scaleFactors: [1, 2] },
					{ width: 512, height: 512, scaleFactors: [4, 8] }
				]),
				'https://x.test'
			)
		).toThrow(/must use one tile size/);
	});
});

describe('bounds on what a stranger’s info.json may declare', () => {
	const withSize = (width: unknown, height: unknown) => ({
		'@context': 'http://iiif.io/api/image/3/context.json',
		id: 'https://iiif.example.test/iiif/3/sheet',
		type: 'ImageService3',
		protocol: 'http://iiif.io/api/image',
		profile: 'level0',
		width,
		height,
		tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
	});

	const reject = (info: unknown) =>
		acceptRemoteImageService(info, {
			requestedUrl: 'https://iiif.example.test/iiif/3/sheet/info.json',
			fallbackUri: 'x'
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

	it.each([
		['a fractional width', withSize(1200.5, 851), /width is 1200.5/],
		['a negative height', withSize(1200, -851), /height is -851/],
		['a width past Number.MAX_SAFE_INTEGER', withSize(2 ** 60, 851), /width is/],
		['more pixels than this app will accept', withSize(2_000_000, 3_000_000), /gigapixels/]
	])('refuses %s', async (_what, info, expected) => {
		expect((await reject(info))?.message).toMatch(expected);
	});

	it('refuses a service whose own maxWidth is smaller than the tiles it declares', async () => {
		// Nothing before this slice could carry `maxWidth`: our own generated `info.json` has no
		// reason to. A service that declares 256px tiles and `maxWidth: 200` has described a pyramid
		// it will not serve, and the dangerous version of that is a server that answers by shrinking
		// the image — the wrong number of pixels in every tile, which reads as a blurry scan.
		const failure = await reject({ ...withSize(1200, 851), maxWidth: 200 });

		expect(failure?.message).toContain('maxWidth');
		expect(failure?.message).toContain('will not serve the tiles it just described');
	});
});

describe('the id a stranger’s document declares for itself', () => {
	// A document served from `library.test` that says its own address is something else. Adopting it
	// is not optional — it is what the Image API requires and what `harvard-ids` above needs — but
	// what is adopted becomes the identifier this Map Image is filed under, the base of every
	// tile request, and the citation written into `remote.json`. So it goes through the same check a
	// pasted address does.
	const declaring = (id: unknown) => ({
		'@context': 'http://iiif.io/api/image/3/context.json',
		id,
		type: 'ImageService3',
		protocol: 'http://iiif.io/api/image',
		profile: 'level0',
		width: 1200,
		height: 851,
		tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
	});

	const adopt = (id: unknown) =>
		acceptRemoteImageService(declaring(id), {
			requestedUrl: 'https://library.test/iiif/3/sheet/info.json',
			fallbackUri: 'https://library.test/iiif/3/sheet'
		});

	it('is adopted from another host, because that is ordinary IIIF and a real service does it', async () => {
		// The synthetic twin of the `harvard-ids` case above, kept separate so the rule survives the
		// day that fixture is re-captured: a different host is *allowed*, and refusing one would refuse
		// a live library.
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
		const failure = await adopt(id).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure).toBeInstanceOf(RemoteIiifRejectedError);
		expect(failure?.host).toBe('library.test');
		expect(failure?.message).toContain('library.test');
		expect(failure?.message).toContain(id);
		expect(failure?.message).toContain('Nothing has been added');
	});
});

describe('reading a service over the network', () => {
	it('normalises a URL that ends in /info.json, because that is what people copy', async () => {
		const requests: string[] = [];
		const captured = service('bodleian');
		const remote = await readRemoteImageService(captured.fetchedFrom, {
			fetch: async (input) => {
				requests.push(String(input));
				return new Response(JSON.stringify(captured.info), {
					headers: { 'content-type': 'application/json' }
				});
			}
		});

		// One request, to `<base>/info.json`, and not to `<base>/info.json/info.json`.
		expect(requests).toEqual([
			'https://iiif.bodleian.ox.ac.uk/iiif/image/e32a277e-91e2-4a6d-8ba6-cc4bad230410/info.json'
		]);
		expect(remote.uri).toBe(
			'https://iiif.bodleian.ox.ac.uk/iiif/image/e32a277e-91e2-4a6d-8ba6-cc4bad230410'
		);
	});

	it('mints the identifier the live Allmaps API keys this image on', async () => {
		// Not a tautology about hashing. `https://annotations.allmaps.org/?url=<uri>/info.json`
		// **redirected to `/images/a8eb9e9cf936cc3d`** when measured on 2026-08-06 — so this constant
		// is Allmaps' own answer, recorded, and this assertion is what makes ADR-0015's claim ("the
		// same identifier Allmaps uses") a fact in the tree rather than a sentence in a document.
		// The community lookup is keyed on exactly this, so it is the pivot of the whole feature.
		const captured = service('bodleian');
		const remote = await readRemoteImageService(captured.fetchedFrom, {
			fetch: async () =>
				new Response(JSON.stringify(captured.info), {
					headers: { 'content-type': 'application/json' }
				})
		});

		expect(remote.imageId).toBe('a8eb9e9cf936cc3d');
	});
});
