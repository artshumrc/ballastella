import { describe, expect, it } from 'vitest';

import { newAlignment, type Alignment } from '../alignment/alignment';
import { parseAlignment, serialiseAlignment } from '../alignment/georeference-annotation';
import { createImagePane } from '../image-pane/iiif-image-pane';
import { createStoreImageFetch } from '../injection/store-image-fetch';
import { imageInfoPath } from '../project/image-files';
import { MemoryProjectStore } from '../store/memory-project-store';
import { imageServiceId } from '../tiler/pyramid';
import {
	ReferencedImageUnreadableError,
	imageModeOf,
	isReferenced,
	localCopySource,
	parseReferencedImage,
	referencedRendererDocument,
	referencedImage,
	referencedImagePath,
	serialiseReferencedAlignment,
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
		height: 3622
	});

const alignment = (): Alignment => ({
	...newAlignment('a8eb9e9cf936cc3d', { width: 2781, height: 3622 }),
	controlPoints: [
		{ id: '0', ordinal: 1, resource: { x: 100, y: 200 }, geo: { lng: -82, lat: 27 } },
		{ id: '1', ordinal: 2, resource: { x: 2000, y: 300 }, geo: { lng: -80, lat: 28 } },
		{ id: '2', ordinal: 3, resource: { x: 900, y: 3000 }, geo: { lng: -81, lat: 25 } }
	]
});

describe('where a Historical Map’s tiles come from', () => {
	it('sends a local copy through the injection layer and a reference to its own host', () => {
		// The whole distinction. `{ storedImageId }` means "in this Project, reach it through the
		// ADR-0011 shim"; a string means "served over HTTP from here". They are different *types*, so
		// getting them the wrong way round is a compile error rather than a blank pane.
		expect(tileBaseFor(localCopySource('local-1234'))).toEqual({ storedImageId: 'local-1234' });
		expect(tileBaseFor(sourceOf(record()))).toBe(SERVICE);
	});

	it('agrees with the Layer’s imageMode, because both come from the one source', () => {
		// A Layer that says `'referenced'` while its tiles resolve into the store — or the reverse —
		// is a Layer that claims a local pyramid it does not have, which is what ticket 13's import
		// check refuses. Derived from one value so the two cannot be written independently.
		expect(imageModeOf(localCopySource('local-1234'))).toBe('mirrored');
		expect(imageModeOf(sourceOf(record()))).toBe('referenced');
		expect(isReferenced(sourceOf(record()))).toBe(true);
		expect(isReferenced(localCopySource('local-1234'))).toBe(false);
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
		expect(() => createImagePane(info, tileBaseFor(localCopySource('local-1234')))).not.toThrow();
	});

	it('leaves a remote request alone in the ADR-0011 shim, which is the half that is easy to break', async () => {
		// ADR-0011's pass-through. A referenced image's tiles must go to the network unmodified, and
		// the shim's own header says this is the half that matters as much — so it is asserted here,
		// against the base `tileBaseFor` actually produces, rather than assumed.
		const store = new MemoryProjectStore();
		await store.write('amsterdam-1625/project.json', new TextEncoder().encode('{}'));
		const seen: string[] = [];
		const fetch = createStoreImageFetch({
			store,
			projectDirectory: 'amsterdam-1625',
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
		await store.write(
			`amsterdam-1625/${imageInfoPath('local-1234')}`,
			new TextEncoder().encode('{"width":1200}')
		);
		const fetch = createStoreImageFetch({
			store,
			projectDirectory: 'amsterdam-1625',
			fetch: async () => {
				throw new Error('a local copy must never reach the network');
			}
		});

		// `createImagePane` resolves `{ storedImageId }` to the placeholder base, which is the shim's
		// routing key — so the URL a local copy's pane asks for is this one.
		const base = tileBaseFor(localCopySource('local-1234'));
		expect(base).toEqual({ storedImageId: 'local-1234' });

		const response = await fetch(`${imageServiceId('local-1234')}/info.json`);
		expect(await response.text()).toBe('{"width":1200}');
	});
});

describe('the record beside a referenced image', () => {
	it('lives where a local pyramid’s own files live, so mirroring is a re-tiling job', () => {
		// Ticket 15 writes a pyramid into this same directory and flips the Layer's `imageMode`; the
		// record of where the image came from stays, which is the canonical citation ADR-0007 protects.
		expect(referencedImagePath('a8eb9e9cf936cc3d')).toBe('images/a8eb9e9cf936cc3d/remote.json');
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
	});

	it('is tab indented with a trailing newline, like every other JSON this app writes', () => {
		const text = new TextDecoder().decode(serialiseReferencedImage(record()));
		expect(text.startsWith('{\n\t"service"')).toBe(true);
		expect(text.endsWith('\n')).toBe(true);
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

	it('loses a field rather than the map when provenance is missing or the wrong type', () => {
		const read = parseReferencedImage(
			new TextEncoder().encode(JSON.stringify({ service: SERVICE, label: 42, width: 'wide' })),
			{ imageId: 'a8eb9e9cf936cc3d' }
		);

		expect(read.service).toBe(SERVICE);
		expect(read.label).toBe('');
		expect(read.width).toBe(0);
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
		const bytes = serialiseReferencedAlignment(alignment(), SERVICE);
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
			new TextDecoder().decode(serialiseReferencedAlignment(alignment(), SERVICE))
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
		const first = serialiseReferencedAlignment(alignment(), SERVICE);
		const second = serialiseReferencedAlignment(alignment(), SERVICE);
		expect(new TextDecoder().decode(first)).toBe(new TextDecoder().decode(second));
	});

	it('trims a trailing slash, so one service cannot produce two addresses', () => {
		const map = referencedRendererDocument(alignment(), `${SERVICE}/`) as {
			resource: { id: string };
		};
		expect(map.resource.id).toBe(SERVICE);
	});
});
