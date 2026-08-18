import { describe, expect, it } from 'vitest';

import { newAlignment, type Alignment } from '../alignment/alignment';
import { parseAlignment, serialiseAlignment } from '../alignment/georeference-annotation';
import { createImagePane } from '../image-pane/iiif-image-pane';
import { createStoreImageFetch } from '../injection/store-image-fetch';
import { partitionByOfflineCopy } from '../project/map-images';
import { imageInfoPath } from '../project/image-files';
import { MemoryProjectStore } from '../store/memory-project-store';
import { imageServiceId } from '../tiler/pyramid';
import {
	ReferencedImageUnreadableError,
	imagePaneSourceFor,
	isReferenced,
	listReferencedImages,
	parseReferencedImage,
	referencedRendererDocument,
	referencedImage,
	referencedImagePath,
	referencedAlignmentAddress,
	serialiseReferencedImage,
	sourceOf,
	tileBaseFor
} from './referenced-image';

const SERVICE = 'https://tile.loc.gov/image-services/iiif/service:gmd:sheet';

const record = () =>
	referencedImage({
		imageId: 'a8eb9e9cf936cc3d',
		service: SERVICE,
		label: 'A new map of Florida',
		partOf: 'https://www.loc.gov/item/2022594752/manifest.json',
		canvas: 'https://www.loc.gov/item/2022594752/canvas/1',
		rights: 'http://rightsstatements.org/vocab/NoC-US/1.0/',
		attribution: 'Library of Congress, Geography and Map Division',
		width: 2781,
		height: 3622,
		tileSize: 512
	});

/**
 * The local half of the union, written out.
 *
 * ADR-0023 deleted the local-copy constructor along with the stored image mode it existed to derive.
 * The union itself stays — it is how a pane is told where to fetch from — but nothing constructs the
 * local half from a Layer any more, because a Layer no longer claims which half it is.
 */
const offlineCopySource = { imageMode: 'offline-copy', imageId: 'local-1234' } as const;

const alignment = (): Alignment => ({
	...newAlignment('a8eb9e9cf936cc3d', { width: 2781, height: 3622 }),
	controlPoints: [
		{ id: '0', ordinal: 1, resource: { x: 100, y: 200 }, geo: { lng: -82, lat: 27 } },
		{ id: '1', ordinal: 2, resource: { x: 2000, y: 300 }, geo: { lng: -80, lat: 28 } },
		{ id: '2', ordinal: 3, resource: { x: 900, y: 3000 }, geo: { lng: -81, lat: 25 } }
	]
});

describe('where a Map Image’s tiles come from', () => {
	it('sends a local copy through the injection layer and a reference to its own host', () => {
		// The whole distinction. `{ storedImageId }` means "in this Workspace, reach it through the
		// ADR-0011 shim"; a string means "served over HTTP from here". They are different *types*, so
		// getting them the wrong way round is a compile error rather than a blank pane.
		expect(tileBaseFor(offlineCopySource)).toEqual({ storedImageId: 'local-1234' });
		expect(tileBaseFor(sourceOf(record()))).toBe(SERVICE);
	});

	it('says which of the two a source is, and nothing stores that answer', () => {
		expect(isReferenced(sourceOf(record()))).toBe(true);
		expect(isReferenced(offlineCopySource)).toBe(false);
	});

	it('is asserted by ticket 03’s own guard: a local base as a string is refused', () => {
		// The distinction would be worth nothing if a caller could pass the placeholder as a string
		// and have it work by accident. `createImagePane` refuses it, naming the missing override —
		// which is the assertion that makes `tileBaseFor`'s two branches mean different things.
		const info = {
			'@context': 'http://iiif.io/api/image/3/context.json',
			id: imageServiceId('local-1234'),
			type: 'ImageService3',
			protocol: 'http://iiif.io/api/image',
			profile: 'level0',
			width: 1200,
			height: 851,
			tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
		};

		expect(() => createImagePane(info, imageServiceId('local-1234'))).toThrow(
			/unset\.invalid placeholder as a base URI/
		);
		// The same document, through the answer `tileBaseFor` gives for a local copy: accepted.
		expect(() => createImagePane(info, tileBaseFor(offlineCopySource))).not.toThrow();
	});

	it('leaves a remote request alone in the ADR-0011 shim, which is the half that is easy to break', async () => {
		// ADR-0011's pass-through. A referenced image's tiles must go to the network unmodified, and
		// the shim's own header says this is the half that matters as much — so it is asserted here,
		// against the base `tileBaseFor` actually produces, rather than assumed.
		const store = new MemoryProjectStore();
		const seen: string[] = [];
		const fetch = createStoreImageFetch({
			store,
			fetch: async (input) => {
				seen.push(String(input));
				return new Response('remote tile', { status: 200 });
			}
		});

		const base = tileBaseFor(sourceOf(record()));
		const response = await fetch(`${base as string}/0,0,256,256/256,256/0/default.jpg`);

		expect(await response.text()).toBe('remote tile');
		expect(seen).toEqual([`${SERVICE}/0,0,256,256/256,256/0/default.jpg`]);
	});

	it('answers a local copy out of the store through the same shim', async () => {
		const store = new MemoryProjectStore();
		// At the Workspace root (ADR-0023). `imageInfoPath` is already the whole store path.
		await store.write(imageInfoPath('local-1234'), new TextEncoder().encode('{"width":1200}'));
		const fetch = createStoreImageFetch({
			store,
			fetch: async () => {
				throw new Error('a local copy must never reach the network');
			}
		});

		// `createImagePane` resolves `{ storedImageId }` to the placeholder base, which is the shim's
		// routing key — so the URL a local copy's pane asks for is this one.
		const base = tileBaseFor(offlineCopySource);
		expect(base).toEqual({ storedImageId: 'local-1234' });

		const response = await fetch(`${imageServiceId('local-1234')}/info.json`);
		expect(await response.text()).toBe('{"width":1200}');
	});
});

/**
 * The pair a pane is handed (ticket 07): the tile base and the `info.json` beside it.
 *
 * The point of the pair is that it is built in one place from one fact, so a pane cannot be given a
 * Library's tiles with the Workspace's description of them. That combination has no symptom — the
 * geometry is a plausible pyramid either way — and it puts every Control Point the scholar then
 * places at the wrong image pixel.
 */
describe('everything a pane needs to read one Map Image', () => {
	it('reads a referenced map from the Library, document and tiles from the same base', () => {
		const source = imagePaneSourceFor(sourceOf(record()));

		expect(source.tiles).toBe(SERVICE);
		expect(source.infoUrl).toBe(`${SERVICE}/info.json`);
		// Nothing about a referenced map may mention the ADR-0004 placeholder: it is the shim's routing
		// key, and a request carrying it would be answered out of a Workspace that has no such pyramid.
		expect(source.infoUrl).not.toContain('unset.invalid');
	});

	it('reads an offline copy out of the store, document and tiles from the same base', () => {
		const source = imagePaneSourceFor(offlineCopySource);

		expect(source.tiles).toEqual({ storedImageId: 'local-1234' });
		// The placeholder is *correct* here and is the whole mechanism: it is what `createStoreImageFetch`
		// routes into the store, which is why this URL needs no network and works with none.
		expect(source.infoUrl).toBe('https://unset.invalid/local-1234/info.json');
	});

	it('resolves the tiles and the info.json from one fact, so they cannot name different servers', () => {
		// The unguarded direction. Both fields are derived from one `MapImageSource`, so there is no
		// input that produces a Library's tile base beside the store's `info.json` — the pairing that
		// draws a stranger's sheet under our own pyramid's geometry with nothing raising anywhere.
		for (const source of [sourceOf(record()), offlineCopySource]) {
			const { tiles, infoUrl } = imagePaneSourceFor(source);
			const base = typeof tiles === 'string' ? tiles : imageServiceId(tiles.storedImageId);
			expect(infoUrl).toBe(`${base}/info.json`);
		}
	});

	it('uses the canonical spelling of the service, so one map is one address', () => {
		// A trailing slash is the ordinary way the same service arrives spelled two ways. It must not
		// produce `…/sheet//info.json`, and it must not make the pane's base differ from the address
		// written into the Alignment — `referencedAlignmentAddress` canonicalises the same way.
		const source = imagePaneSourceFor({
			imageMode: 'referenced',
			imageId: 'a8eb9e9cf936cc3d',
			service: `${SERVICE}/`
		});

		expect(source.infoUrl).toBe(`${SERVICE}/info.json`);
		expect(source.tiles).toBe(referencedAlignmentAddress(`${SERVICE}/`).imageService);
	});

	it('builds a pane that really reads from where it said', async () => {
		// Not a restatement of the two strings: the reader is handed the pair and asked where its tiles
		// are. Without this the test above passes against an `imagePaneSourceFor` whose `tiles` field
		// `createImagePane` happens to reject.
		const info = {
			'@context': 'http://iiif.io/api/image/3/context.json',
			id: SERVICE,
			type: 'ImageService3',
			protocol: 'http://iiif.io/api/image',
			profile: 'level0',
			width: 1200,
			height: 851,
			tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
		};

		const remote = createImagePane(info, imagePaneSourceFor(sourceOf(record())).tiles);
		expect(remote.allTiles().every((tile) => tile.url.startsWith(`${SERVICE}/`))).toBe(true);

		const stored = createImagePane(info, imagePaneSourceFor(offlineCopySource).tiles);
		expect(
			stored.allTiles().every((tile) => tile.url.startsWith('https://unset.invalid/local-1234/'))
		).toBe(true);
	});
});

describe('the record beside a referenced image', () => {
	it('lives where a local pyramid’s own files live, so making an offline copy is a re-tiling job', () => {
		// An offline copy writes a pyramid into this same directory and the record of where the image came
		// from stays, which is the canonical citation ADR-0007 protects. It is also — since ADR-0023 —
		// what *says* the image is referenced at all, so the two files sitting side by side is the whole
		// state machine.
		expect(referencedImagePath('a8eb9e9cf936cc3d')).toBe('images/a8eb9e9cf936cc3d/remote.json');
		// A store path, complete: no Project directory in it.
		expect(referencedImagePath('a8eb9e9cf936cc3d').startsWith('images/')).toBe(true);
	});

	it('round-trips, keeping the provenance a scholar cannot recover later', () => {
		const original = record();
		const read = parseReferencedImage(serialiseReferencedImage(original), {
			imageId: original.imageId
		});

		expect(read).toEqual(original);
		// ADR-0007 asks for rights and attribution again at the moment an offline copy is made, which
		// is long after the Manifest has been navigated away from. So they are written now.
		expect(read.rights).toBe('http://rightsstatements.org/vocab/NoC-US/1.0/');
		expect(read.attribution).toBe('Library of Congress, Geography and Map Division');
		// The service's declared tile side, which is what makes the picture the hub shows beside this map's
		// name namable at all (ADR-0030): with the sheet's pixels it says which power of two reduces the
		// whole sheet to one tile. Nothing else in the Workspace records it for a referenced map.
		expect(read.tileSize).toBe(512);
	});

	it('is tab indented with a trailing newline, like every other JSON this app writes', () => {
		// The whole document, member by member and in order. Exact rather than a prefix and a suffix: this
		// is the file a colleague's build and a later version of this one both read, so which members it
		// carries is the claim — and a looser assertion would go on passing over a `tileSize` that had
		// stopped being written, which costs the picture silently.
		expect(new TextDecoder().decode(serialiseReferencedImage(record()))).toBe(
			`{
\t"service": "${SERVICE}",
\t"label": "A new map of Florida",
\t"partOf": "https://www.loc.gov/item/2022594752/manifest.json",
\t"canvas": "https://www.loc.gov/item/2022594752/canvas/1",
\t"rights": "http://rightsstatements.org/vocab/NoC-US/1.0/",
\t"attribution": "Library of Congress, Geography and Map Division",
\t"width": 2781,
\t"height": 3622,
\t"tileSize": 512
}
`
		);
	});

	it.each([
		['no service at all', '{}', /names no image service/],
		['a relative address', '{"service":"/iiif/3/sheet"}', /is not an absolute web address/],
		['a data URL', '{"service":"data:image/png;base64,AA"}', /only http and https can be fetched/],
		['not JSON', 'oh dear', /Unexpected|JSON/]
	])('refuses a record with %s rather than losing the map quietly', (_what, body, expected) => {
		// Strict about the address and tolerant about everything else. An empty base would make
		// `@allmaps/iiif-parser` build *relative* tile URLs against this app's own origin, quietly
		// requesting tiles from ourselves; falling back to the ADR-0004 placeholder would send them
		// into the injection layer to look for a pyramid that by definition is not there.
		expect(() =>
			parseReferencedImage(new TextEncoder().encode(body), { imageId: 'a8eb9e9cf936cc3d' })
		).toThrow(expected);
		expect(() =>
			parseReferencedImage(new TextEncoder().encode(body), { imageId: 'a8eb9e9cf936cc3d' })
		).toThrow(ReferencedImageUnreadableError);
	});

	it('is spelled one way however the address arrived', () => {
		// The same service reached three ways — bare, with a trailing slash, and as the URL a user
		// copies out of their address bar — is one Map Image. It has to be: `generateId` hashes
		// this string into the image's identity and into the key the Allmaps lookup is made on, so two
		// spellings are two Layers that cannot be told apart and an existing Alignment silently not
		// found. See `canonicalServiceUri`, which is the one place that decides it.
		for (const written of [SERVICE, `${SERVICE}/`, `${SERVICE}/info.json`]) {
			expect(
				referencedImage({ imageId: 'x', service: written, width: 1, height: 1, tileSize: 256 })
					.service
			).toBe(SERVICE);
		}
	});

	it('loses a field rather than the map when provenance is missing or the wrong type', () => {
		const read = parseReferencedImage(
			new TextEncoder().encode(JSON.stringify({ service: SERVICE, label: 42, width: 'wide' })),
			{ imageId: 'a8eb9e9cf936cc3d' }
		);

		expect(read.service).toBe(SERVICE);
		expect(read.label).toBe('');
		expect(read.width).toBe(0);
	});

	it.each([
		['a record written before the field existed', undefined],
		['a tileSize of the wrong type', '256'],
		['a fractional one', 256.5],
		['zero', 0],
		['a negative one', -256]
	])('reads %s as a tileSize of 0, and still hands back the map', (_what, tileSize) => {
		// The same tolerance the dimensions get, and for the same reason: losing this costs the picture the
		// hub shows and nothing else, so refusing the record over it would trade a glyph for a map a
		// scholar can neither see nor delete. Only a bad service URI costs the map (ADR-0030: no backfill,
		// re-adding is the remedy).
		const read = parseReferencedImage(
			new TextEncoder().encode(
				JSON.stringify({ service: SERVICE, width: 2781, height: 3622, tileSize })
			),
			{ imageId: 'a8eb9e9cf936cc3d' }
		);

		expect(read.tileSize).toBe(0);
		expect(read.service).toBe(SERVICE);
		expect(read.width).toBe(2781);
	});
});

describe('every referenced image a Project records', () => {
	const project = async (files: Record<string, string>) => {
		const store = new MemoryProjectStore();
		for (const [path, body] of Object.entries(files)) {
			await store.write(path, new TextEncoder().encode(body));
		}
		return store;
	};

	it('skips a record that will not parse and hands its id back, rather than failing the open', async () => {
		// One unreadable `remote.json` must not stop the Project opening — but it must not vanish
		// either: the user has a Layer naming an image nothing can draw, and the Project view has to be
		// able to say so. Drawing the rest and reporting this one is the only outcome in which neither
		// half is lost.
		const store = await project({
			'images/a8eb9e9cf936cc3d/remote.json': `{"service":"${SERVICE}","width":2781,"height":3622}`,
			'images/ffff0000ffff0000/remote.json': '{"label":"no address at all"}',
			'images/eeee1111eeee1111/remote.json': 'this is not JSON'
		});

		const { images, unreadable } = await listReferencedImages(store);

		expect(images.map((image) => image.imageId)).toEqual(['a8eb9e9cf936cc3d']);
		expect(unreadable.map((failure) => failure.imageId).sort()).toEqual([
			'eeee1111eeee1111',
			'ffff0000ffff0000'
		]);
		// The reason is the sentence the user sees, so it says what is missing and what it costs.
		const noAddress = unreadable.find((failure) => failure.imageId === 'ffff0000ffff0000');
		expect(noAddress?.reason).toContain('names no image service');
		expect(noAddress?.reason).toContain('nowhere to fetch its tiles from');
	});

	it('reads only the Workspace’s own images, not a remote.json nested below one', async () => {
		const store = await project({
			'images/a8eb9e9cf936cc3d/remote.json': `{"service":"${SERVICE}","width":1,"height":1}`,
			'images/a8eb9e9cf936cc3d/tiles/remote.json': 'not a Map Image',
			'images/a8eb9e9cf936cc3d/info.json': '{}',
			// A Project directory that happens to hold something shaped like an image. Not a Map Image
			// of this Workspace, and not looked at (ADR-0023).
			// project-rooted-path-is-the-fixture: the decoy `listReferencedImages` must not report
			'amsterdam-1625/images/decoy/remote.json': `{"service":"${SERVICE}","width":1,"height":1}`
		});

		const { images, unreadable } = await listReferencedImages(store);

		expect(images.map((image) => image.imageId)).toEqual(['a8eb9e9cf936cc3d']);
		expect(unreadable).toEqual([]);
	});
});

describe('an Alignment of a referenced image', () => {
	it('names the remote service in the document it hands the renderer', () => {
		// `toRendererDocument` writes the ADR-0004 placeholder, which is right for a stored pyramid and
		// blank-map wrong here: `@allmaps/maplibre` fetches tiles from that `id`, so left alone a
		// referenced image asks the injection layer for a pyramid the Project does not contain.
		const map = referencedRendererDocument(alignment(), SERVICE) as {
			resource: { id: string; width: number; height: number };
		};

		expect(map.resource.id).toBe(SERVICE);
		expect(map.resource.id).not.toContain('unset.invalid');
		expect(map.resource.width).toBe(2781);
	});

	it('writes a Georeference Annotation Allmaps can actually resolve', () => {
		// ADR-0007's interoperability claim, made true rather than aspirational. For a referenced image
		// — the one case where the resource has a real public URI — the file is directly consumable by
		// Allmaps and by anything else implementing the extension (SPEC stories 91, 92). The
		// placeholder would produce a standard-shaped document nothing in the world can resolve.
		const bytes = serialiseAlignment(alignment(), referencedAlignmentAddress(SERVICE));
		const document = JSON.parse(new TextDecoder().decode(bytes)) as {
			target: { source: { id: string } };
		};

		expect(document.target.source.id).toBe(SERVICE);
		expect(new TextDecoder().decode(bytes)).not.toContain('unset.invalid');
		// And the same document read back by the one reader that owns the format.
		expect(parseAlignment(bytes, { imageId: 'a8eb9e9cf936cc3d' }).controlPoints).toHaveLength(3);
	});

	it('changes only the address — everything else is still the one writer’s output', () => {
		// The point of rewriting one field rather than re-implementing `serialiseAlignment`: the
		// Resource Mask's plain-decimal fix, the deliberately absent timestamps, and the byte-for-byte
		// formatting all still come from the single writer that owns them.
		const local = JSON.parse(new TextDecoder().decode(serialiseAlignment(alignment()))) as Record<
			string,
			unknown
		>;
		const remote = JSON.parse(
			new TextDecoder().decode(serialiseAlignment(alignment(), referencedAlignmentAddress(SERVICE)))
		) as Record<string, unknown>;

		expect((local['target'] as { source: { id: string } }).source.id).toBe(
			imageServiceId('a8eb9e9cf936cc3d')
		);
		// Substitute the one field back and the two documents are identical.
		(remote['target'] as { source: { id: string } }).source.id = imageServiceId('a8eb9e9cf936cc3d');
		expect(remote).toEqual(local);
	});

	it('is byte-identical when serialised twice, so a reopened Project rewrites nothing', () => {
		// ADR-0010, via the same property `serialiseAlignment` has: no clock in the output.
		const first = serialiseAlignment(alignment(), referencedAlignmentAddress(SERVICE));
		const second = serialiseAlignment(alignment(), referencedAlignmentAddress(SERVICE));
		expect(new TextDecoder().decode(first)).toBe(new TextDecoder().decode(second));
	});

	it('trims a trailing slash, so one service cannot produce two addresses', () => {
		const map = referencedRendererDocument(alignment(), `${SERVICE}/`) as {
			resource: { id: string };
		};
		expect(map.resource.id).toBe(SERVICE);
	});
});

describe('a Map Image that has been copied offline', () => {
	const other = () =>
		referencedImage({
			imageId: 'ffff0000ffff0000',
			service: 'https://digital.bodleian.ox.ac.uk/iiif/image/other',
			width: 10,
			height: 10,
			tileSize: 256
		});

	it('is told apart from a referenced one by the pyramid being there, and by nothing else', () => {
		// ADR-0023: there is no longer a claim in `project.json` for this to be the better of two answers
		// than. It is the only answer, so a copy can no longer be half-recorded and the whole "finish the
		// offline copy" repair path is gone with the state it repaired.
		const split = partitionByOfflineCopy([record(), other()], [{ imageId: 'a8eb9e9cf936cc3d' }]);

		expect(split.offlineCopies.map((image) => image.imageId)).toEqual(['a8eb9e9cf936cc3d']);
		expect(split.referenced.map((image) => image.imageId)).toEqual(['ffff0000ffff0000']);
	});

	it('keeps its record, so it can still be cited and traced back', () => {
		// ADR-0007's whole reason for keeping `remote.json` where it is: making an offline copy must not orphan the copy.
		const [copied] = partitionByOfflineCopy(
			[record()],
			[{ imageId: 'a8eb9e9cf936cc3d' }]
		).offlineCopies;

		expect(copied?.service).toBe(SERVICE);
		expect(copied?.rights).toBe('http://rightsstatements.org/vocab/NoC-US/1.0/');
		expect(copied?.attribution).toBe('Library of Congress, Geography and Map Division');
	});

	it('reaches its tiles through the injection layer once the pyramid is beside it', () => {
		// The transition the `MapImageSource` union was shaped for, in one assertion: the same image
		// id, and a base that has stopped being a URL on somebody else's host. What decides which side of
		// it a map is on is `partitionByOfflineCopy` reading the folder, not a field anybody wrote.
		const before = sourceOf(record());
		const after = { imageMode: 'offline-copy', imageId: record().imageId } as const;

		expect(tileBaseFor(before)).toBe(SERVICE);
		expect(tileBaseFor(after)).toEqual({ storedImageId: 'a8eb9e9cf936cc3d' });
		expect(isReferenced(before)).toBe(true);
		expect(isReferenced(after)).toBe(false);
	});
});
