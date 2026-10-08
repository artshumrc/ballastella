import { describe, expect, it } from 'vitest';

import { newAlignment, type Alignment } from '../alignment/alignment';
import { parseAlignment, serialiseAlignment } from '../alignment/georeference-annotation';
import { createImagePane } from '../image-pane/iiif-image-pane';
import { createStoreImageFetch } from '../injection/store-image-fetch';
import { partitionByOfflineCopy } from '../project/map-images';
import { imageInfoPath } from '../project/image-files';
import { MemoryProjectStore } from '../store/memory-project-store';
import { decode, encode, imageService3, seeded } from '../test-support.js';
import { imageServiceId } from '../tiler/pyramid';
import {
	ReferencedImageUnreadableError,
	imagePaneSourceFor,
	listReferencedImages,
	parseReferencedImage,
	referencedRendererDocument,
	referencedImage,
	referencedImagePath,
	referencedAlignmentAddress,
	serialiseReferencedImage,
	sourceOf
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

const offlineCopySource = { imageMode: 'offline-copy', imageId: 'local-1234' } as const;

const info = (id: string) =>
	imageService3({
		id,
		width: 1200,
		height: 851,
		tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
	});

const alignment = (): Alignment => ({
	...newAlignment('a8eb9e9cf936cc3d', { width: 2781, height: 3622 }),
	controlPoints: [
		{ id: '0', ordinal: 1, resource: { x: 100, y: 200 }, geo: { lng: -82, lat: 27 } },
		{ id: '1', ordinal: 2, resource: { x: 2000, y: 300 }, geo: { lng: -80, lat: 28 } },
		{ id: '2', ordinal: 3, resource: { x: 900, y: 3000 }, geo: { lng: -81, lat: 25 } }
	]
});

describe('where a Map Image’s tiles come from', () => {
	it('is asserted by the image pane’s own guard: a local base as a string is refused', () => {
		const local = info(imageServiceId('local-1234'));
		expect(() => createImagePane(local, imageServiceId('local-1234'))).toThrow(
			/unset\.invalid placeholder as a base URI/
		);
		expect(() => createImagePane(local, imagePaneSourceFor(offlineCopySource).tiles)).not.toThrow();
	});

	it('leaves a remote request alone in the ADR-0011 shim, which is the half that is easy to break', async () => {
		const store = new MemoryProjectStore();
		const seen: string[] = [];
		const fetch = createStoreImageFetch({
			store,
			fetch: async (input) => {
				seen.push(String(input));
				return new Response('remote tile', { status: 200 });
			}
		});

		const base = imagePaneSourceFor(sourceOf(record())).tiles;
		const response = await fetch(`${base as string}/0,0,256,256/256,256/0/default.jpg`);
		expect(await response.text()).toBe('remote tile');
		expect(seen).toEqual([`${SERVICE}/0,0,256,256/256,256/0/default.jpg`]);
	});

	it('answers a local copy out of the store through the same shim', async () => {
		const store = await seeded({ [imageInfoPath('local-1234')]: '{"width":1200}' });
		const fetch = createStoreImageFetch({
			store,
			fetch: async () => {
				throw new Error('a local copy must never reach the network');
			}
		});

		const response = await fetch(`${imageServiceId('local-1234')}/info.json`);
		expect(await response.text()).toBe('{"width":1200}');
	});
});

describe('everything a pane needs to read one Map Image', () => {
	it('reads a referenced map from its Library and an offline copy from the store, each from one base', () => {
		expect(imagePaneSourceFor(sourceOf(record()))).toEqual({
			tiles: SERVICE,
			infoUrl: `${SERVICE}/info.json`
		});
		expect(imagePaneSourceFor(offlineCopySource)).toEqual({
			tiles: { storedImageId: 'local-1234' },
			infoUrl: 'https://unset.invalid/local-1234/info.json'
		});
	});

	it('uses the canonical spelling of the service, so one map is one address', () => {
		const source = imagePaneSourceFor({
			imageMode: 'referenced',
			imageId: 'a8eb9e9cf936cc3d',
			service: `${SERVICE}/`
		});

		expect(source.infoUrl).toBe(`${SERVICE}/info.json`);
		expect(source.tiles).toBe(referencedAlignmentAddress(`${SERVICE}/`).imageService);
	});

	it('builds a pane that really reads from where it said', async () => {
		const remote = createImagePane(info(SERVICE), imagePaneSourceFor(sourceOf(record())).tiles);
		expect(remote.allTiles().every((tile) => tile.url.startsWith(`${SERVICE}/`))).toBe(true);
		const stored = createImagePane(info(SERVICE), imagePaneSourceFor(offlineCopySource).tiles);
		expect(
			stored.allTiles().every((tile) => tile.url.startsWith('https://unset.invalid/local-1234/'))
		).toBe(true);
	});
});

describe('the record beside a referenced image', () => {
	it('lives where a local pyramid’s own files live, so making an offline copy is a re-tiling job', () => {
		expect(referencedImagePath('a8eb9e9cf936cc3d')).toBe('images/a8eb9e9cf936cc3d/remote.json');
	});

	it('round-trips, keeping the provenance a scholar cannot recover later', () => {
		const original = record();
		expect(
			parseReferencedImage(serialiseReferencedImage(original), { imageId: original.imageId })
		).toEqual(original);
	});

	it('is tab indented with a trailing newline, like every other JSON this app writes', () => {
		expect(decode(serialiseReferencedImage(record()))).toBe(
			`{
\t"service": "${SERVICE}",
\t"source": "https://www.loc.gov/item/2022594752/manifest.json",
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
		const parse = () => parseReferencedImage(encode(body), { imageId: 'a8eb9e9cf936cc3d' });
		expect(parse).toThrow(expected);
		expect(parse).toThrow(ReferencedImageUnreadableError);
	});

	it('is spelled one way however the address arrived', () => {
		for (const written of [SERVICE, `${SERVICE}/`, `${SERVICE}/info.json`]) {
			expect(
				referencedImage({ imageId: 'x', service: written, width: 1, height: 1, tileSize: 256 })
					.service
			).toBe(SERVICE);
		}
	});

	it('loses a field rather than the map when provenance is missing or the wrong type', () => {
		const read = parseReferencedImage(
			encode(JSON.stringify({ service: SERVICE, label: 42, width: 'wide' })),
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
		const read = parseReferencedImage(
			encode(JSON.stringify({ service: SERVICE, width: 2781, height: 3622, tileSize })),
			{ imageId: 'a8eb9e9cf936cc3d' }
		);

		expect(read.tileSize).toBe(0);
		expect(read.service).toBe(SERVICE);
		expect(read.width).toBe(2781);
	});
});

describe('every referenced image a Project records', () => {
	it('skips a record that will not parse and hands its id back, rather than failing the open', async () => {
		const store = await seeded({
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
		const noAddress = unreadable.find((failure) => failure.imageId === 'ffff0000ffff0000');
		expect(noAddress?.reason).toContain('names no image service');
		expect(noAddress?.reason).toContain('nowhere to fetch its tiles from');
	});

	it('reads only the Workspace’s own images, not a remote.json nested below one', async () => {
		const store = await seeded({
			'images/a8eb9e9cf936cc3d/remote.json': `{"service":"${SERVICE}","width":1,"height":1}`,
			'images/a8eb9e9cf936cc3d/tiles/remote.json': 'not a Map Image',
			'images/a8eb9e9cf936cc3d/info.json': '{}',
			// project-rooted-path-is-the-fixture: the decoy `listReferencedImages` must not report
			'amsterdam-1625/images/decoy/remote.json': `{"service":"${SERVICE}","width":1,"height":1}`
		});

		const { images, unreadable } = await listReferencedImages(store);

		expect(images.map((image) => image.imageId)).toEqual(['a8eb9e9cf936cc3d']);
		expect(unreadable).toEqual([]);
	});
});

describe('an Alignment of a referenced image', () => {
	it('names the remote service, one way, in the document it hands the renderer', () => {
		type Rendered = { resource: { id: string; width: number } };
		const map = referencedRendererDocument(alignment(), SERVICE) as Rendered;
		expect(map.resource.id).toBe(SERVICE);
		expect(map.resource.width).toBe(2781);
		const slashed = referencedRendererDocument(alignment(), `${SERVICE}/`) as Rendered;
		expect(slashed.resource.id).toBe(SERVICE);
	});

	it('writes a Georeference Annotation Allmaps can resolve, byte-identically each time', () => {
		const bytes = serialiseAlignment(alignment(), referencedAlignmentAddress(SERVICE));
		const again = serialiseAlignment(alignment(), referencedAlignmentAddress(SERVICE));
		expect(decode(again)).toBe(decode(bytes));
		expect(JSON.parse(decode(bytes)).target.source.id).toBe(SERVICE);
		expect(decode(bytes)).not.toContain('unset.invalid');
		expect(parseAlignment(bytes, { imageId: 'a8eb9e9cf936cc3d' }).controlPoints).toHaveLength(3);
	});

	it('changes only the address — everything else is still the one writer’s output', () => {
		const local = JSON.parse(decode(serialiseAlignment(alignment()))) as Record<string, unknown>;
		const remote = JSON.parse(
			decode(serialiseAlignment(alignment(), referencedAlignmentAddress(SERVICE)))
		) as Record<string, unknown>;

		expect((local['target'] as { source: { id: string } }).source.id).toBe(
			imageServiceId('a8eb9e9cf936cc3d')
		);
		(remote['target'] as { source: { id: string } }).source.id = imageServiceId('a8eb9e9cf936cc3d');
		expect(remote).toEqual(local);
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

	it('is told apart by the pyramid being there and nothing else, keeping its record to cite', () => {
		const split = partitionByOfflineCopy([record(), other()], [{ imageId: 'a8eb9e9cf936cc3d' }]);
		expect(split.offlineCopies).toEqual([record()]);
		expect(split.referenced.map((image) => image.imageId)).toEqual(['ffff0000ffff0000']);
	});
});
