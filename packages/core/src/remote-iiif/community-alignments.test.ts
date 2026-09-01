import { generateAnnotation } from '@allmaps/annotation';
import { generateId } from '@allmaps/id';
import { Image } from '@allmaps/iiif-parser';
import { describe, expect, it } from 'vitest';

import {
	COMMUNITY_ALIGNMENT_DISCLOSURE,
	COMMUNITY_ALIGNMENT_HOST,
	findCommunityAlignments
} from './community-alignments';

const SERVICE = 'https://iiif.bodleian.ox.ac.uk/iiif/image/e32a277e-91e2-4a6d-8ba6-cc4bad230410';

/** The identifier Allmaps itself keys this image on — measured against the live API. */
const IMAGE_ID = 'a8eb9e9cf936cc3d';

const parsedImage = (): Image =>
	Image.parse({
		'@context': 'http://iiif.io/api/image/3/context.json',
		id: SERVICE,
		type: 'ImageService3',
		protocol: 'http://iiif.io/api/image',
		profile: 'level2',
		width: 1000,
		height: 1500,
		tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
	});

/** A Georeference Annotation of the sort the Allmaps API answers with. */
const annotation = (service: string, offset = 0) =>
	generateAnnotation({
		'@context': 'https://schemas.allmaps.org/map/2/context.json',
		type: 'GeoreferencedMap',
		resource: { id: service, type: 'ImageService3', width: 1000, height: 1500 },
		gcps: [
			{ resource: [100 + offset, 200], geo: [-1.25, 51.75] },
			{ resource: [800, 300], geo: [-1.2, 51.76] },
			{ resource: [400, 1200], geo: [-1.24, 51.7] }
		],
		resourceMask: [
			[0, 0],
			[1000, 0],
			[1000, 1500],
			[0, 1500]
		],
		transformation: { type: 'polynomial', options: { order: 1 } }
	});

const page = (items: unknown[]) => ({
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	type: 'AnnotationPage',
	items
});

describe('the lookup being switched off', () => {
	it('makes no request at all — the guarantee is structural, not a flag passed down', async () => {
		// `fetchAnnotationsFromApi` reaches the network through the page's own `fetch` and takes no
		// injection point, so the only way to guarantee silence is not to call it. That is why this
		// asserts on the seam never being invoked rather than on a request count somewhere below.
		let calls = 0;
		const offer = await findCommunityAlignments({
			enabled: false,
			image: parsedImage(),
			imageId: IMAGE_ID,
			fetchAnnotations: async () => {
				calls += 1;
				return [];
			}
		});

		expect(offer).toEqual({ state: 'off' });
		expect(calls).toBe(0);
	});

	it('is a different state from having found nothing', async () => {
		// A user who switched the lookup off must not be told there are no community alignments. That
		// would be a claim made without asking, and it is the sort of thing that makes a privacy
		// setting feel decorative.
		const off = await findCommunityAlignments({
			enabled: false,
			image: parsedImage(),
			imageId: IMAGE_ID,
			fetchAnnotations: async () => [page([annotation(SERVICE)])]
		});
		const none = await findCommunityAlignments({
			enabled: true,
			image: parsedImage(),
			imageId: IMAGE_ID,
			fetchAnnotations: async () => []
		});

		expect(off.state).toBe('off');
		expect(none).toEqual({ state: 'found', alignments: [] });
	});
});

describe('what the lookup finds', () => {
	it('offers each annotation as an Alignment keyed to this Project’s image', async () => {
		const offer = await findCommunityAlignments({
			enabled: true,
			image: parsedImage(),
			imageId: IMAGE_ID,
			fetchAnnotations: async () => [
				page([annotation(SERVICE, 0), annotation(SERVICE, 5), annotation(SERVICE, 10)])
			]
		});

		expect(offer.state).toBe('found');
		const found = offer.state === 'found' ? offer.alignments : [];
		// "Import existing alignment — 3 found."
		expect(found).toHaveLength(3);
		expect(found[0]?.alignment.imageId).toBe(IMAGE_ID);
		expect(found[0]?.alignment.controlPoints).toHaveLength(3);
		expect(found[0]?.alignment.controlPoints[0]?.resource).toEqual({ x: 100, y: 200 });
		expect(found[1]?.alignment.controlPoints[0]?.resource).toEqual({ x: 105, y: 200 });
		expect(found[0]?.alignment.transformationType).toBe('polynomial1');
		// The Resource Mask came across too, which is what makes an imported Alignment a *working*
		// one rather than a set of points over the whole sheet.
		expect(found[0]?.alignment.resourceMask).toHaveLength(4);
	});

	it('ignores annotations for a different image in the same page', async () => {
		// The API answers for a whole resource, so a page may describe several canvases of a volume.
		// Matched on the identifier rather than the URI string, because that is the comparison that
		// survives a service redirecting its own canonical id — and it is the identifier the API keyed
		// the annotation on in the first place.
		const other = 'https://iiif.bodleian.ox.ac.uk/iiif/image/some-other-sheet';
		expect(await generateId(other)).not.toBe(IMAGE_ID);

		const offer = await findCommunityAlignments({
			enabled: true,
			image: parsedImage(),
			imageId: IMAGE_ID,
			fetchAnnotations: async () => [page([annotation(other), annotation(SERVICE)])]
		});

		expect(offer.state === 'found' && offer.alignments).toHaveLength(1);
	});

	it.each([`${SERVICE}/`, `${SERVICE}/info.json`])(
		'matches an annotation that spells the service as %s',
		async (written) => {
			// The identifier is a hash of the address, so a spelling this app would not have minted from
			// is an identifier that does not match and an existing Alignment silently not offered — the
			// feature failing in the one direction nobody can see. Both sides go through
			// `canonicalServiceUri`, which is what makes them the same string before they are hashed.
			const offer = await findCommunityAlignments({
				enabled: true,
				image: parsedImage(),
				imageId: IMAGE_ID,
				fetchAnnotations: async () => [page([annotation(written)])]
			});

			expect(offer.state === 'found' && offer.alignments).toHaveLength(1);
		}
	);

	it('reads a bare Annotation as well as a page of them', async () => {
		const offer = await findCommunityAlignments({
			enabled: true,
			image: parsedImage(),
			imageId: IMAGE_ID,
			fetchAnnotations: async () => [annotation(SERVICE)]
		});

		expect(offer.state === 'found' && offer.alignments).toHaveLength(1);
	});

	it('keeps the readable annotations when one of them is broken', async () => {
		// A single bad Resource Mask vertex took a whole Alignment down once already, upstream. Here
		// the document belongs to a stranger, so one unreadable annotation must not hide the others.
		const broken = { ...annotation(SERVICE), body: { type: 'FeatureCollection' } };
		const offer = await findCommunityAlignments({
			enabled: true,
			image: parsedImage(),
			imageId: IMAGE_ID,
			fetchAnnotations: async () => [page([broken, annotation(SERVICE, 7)])]
		});

		expect(offer.state === 'found' && offer.alignments).toHaveLength(1);
		expect(
			offer.state === 'found' && offer.alignments[0]?.alignment.controlPoints[0]?.resource
		).toEqual({ x: 107, y: 200 });
	});

	it('stops at the bound rather than building a list out of whatever arrived', async () => {
		const offer = await findCommunityAlignments({
			enabled: true,
			image: parsedImage(),
			imageId: IMAGE_ID,
			limit: 2,
			fetchAnnotations: async () => [
				page(Array.from({ length: 40 }, (_, index) => annotation(SERVICE, index)))
			]
		});

		expect(offer.state === 'found' && offer.alignments).toHaveLength(2);
	});

	it('never throws when the third-party service is down', async () => {
		// A lookup is an offer of help. Allmaps being unavailable must not stop a scholar adding a map,
		// so the failure is a note beside the disclosure rather than an error over the whole flow.
		const offer = await findCommunityAlignments({
			enabled: true,
			image: parsedImage(),
			imageId: IMAGE_ID,
			fetchAnnotations: async () => {
				throw new Error('Internal server error (500)');
			}
		});

		expect(offer).toEqual({ state: 'unavailable', detail: 'Internal server error (500)' });
	});
});

describe('the disclosure', () => {
	it('names the host it contacts, and what it is asked for', () => {
		// ADR-0015 asks for a one-line note at the point of use. Held beside the request rather than in
		// a component, so whoever changes what is asked has to change what the user is told in the same
		// file. The other half of the ADR — that the setting is reachable there — is the toggle this
		// sentence labels, and is asserted in `editor-remote-iiif.e2e.ts`.
		expect(COMMUNITY_ALIGNMENT_HOST).toBe('annotations.allmaps.org');
		expect(COMMUNITY_ALIGNMENT_DISCLOSURE).toContain('annotations.allmaps.org');
		expect(COMMUNITY_ALIGNMENT_DISCLOSURE).toContain('existing georeferences');
	});
});
