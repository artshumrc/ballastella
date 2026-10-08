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

const find = (
	fetchAnnotations: () => Promise<unknown[]>,
	options: { enabled?: boolean; limit?: number } = {}
) =>
	findCommunityAlignments({
		enabled: true,
		image: parsedImage(),
		imageId: IMAGE_ID,
		fetchAnnotations,
		...options
	});

const alignmentsIn = async (pages: unknown[], options: { limit?: number } = {}) => {
	const offer = await find(async () => pages, options);
	return offer.state === 'found' ? offer.alignments : [];
};

describe('the lookup being switched off', () => {
	it('makes no request at all — the guarantee is structural, not a flag passed down', async () => {
		let calls = 0;
		const offer = await find(
			async () => {
				calls += 1;
				return [];
			},
			{ enabled: false }
		);

		expect(offer).toEqual({ state: 'off' });
		expect(calls).toBe(0);
	});

	it('is a different state from having found nothing', async () => {
		const off = await find(async () => [page([annotation(SERVICE)])], { enabled: false });
		const none = await find(async () => []);

		expect(off.state).toBe('off');
		expect(none).toEqual({ state: 'found', alignments: [] });
	});
});

describe('what the lookup finds', () => {
	it('offers each annotation as an Alignment keyed to this Project’s image', async () => {
		const found = await alignmentsIn([
			page([annotation(SERVICE, 0), annotation(SERVICE, 5), annotation(SERVICE, 10)])
		]);

		expect(found).toHaveLength(3);
		expect(found[0]?.alignment.imageId).toBe(IMAGE_ID);
		expect(found[0]?.alignment.controlPoints).toHaveLength(3);
		expect(found[0]?.alignment.controlPoints[0]?.resource).toEqual({ x: 100, y: 200 });
		expect(found[1]?.alignment.controlPoints[0]?.resource).toEqual({ x: 105, y: 200 });
		expect(found[0]?.alignment.transformationType).toBe('polynomial1');
		expect(found[0]?.alignment.resourceMask).toHaveLength(4);
	});

	it('ignores annotations for a different image in the same page', async () => {
		const other = 'https://iiif.bodleian.ox.ac.uk/iiif/image/some-other-sheet';
		expect(await generateId(other)).not.toBe(IMAGE_ID);

		expect(await alignmentsIn([page([annotation(other), annotation(SERVICE)])])).toHaveLength(1);
	});

	it.each([`${SERVICE}/`, `${SERVICE}/info.json`])(
		'matches an annotation that spells the service as %s',
		async (written) => {
			expect(await alignmentsIn([page([annotation(written)])])).toHaveLength(1);
		}
	);

	it('reads a bare Annotation as well as a page of them', async () => {
		expect(await alignmentsIn([annotation(SERVICE)])).toHaveLength(1);
	});

	it('keeps the readable annotations when one of them is broken', async () => {
		const broken = { ...annotation(SERVICE), body: { type: 'FeatureCollection' } };
		const found = await alignmentsIn([page([broken, annotation(SERVICE, 7)])]);

		expect(found).toHaveLength(1);
		expect(found[0]?.alignment.controlPoints[0]?.resource).toEqual({ x: 107, y: 200 });
	});

	it('stops at the bound rather than building a list out of whatever arrived', async () => {
		const pages = [page(Array.from({ length: 40 }, (_, index) => annotation(SERVICE, index)))];
		expect(await alignmentsIn(pages, { limit: 2 })).toHaveLength(2);
	});

	it('never throws when the third-party service is down', async () => {
		const offer = await find(async () => {
			throw new Error('Internal server error (500)');
		});

		expect(offer).toEqual({ state: 'unavailable', detail: 'Internal server error (500)' });
	});
});

describe('the disclosure', () => {
	it('names the host it contacts, and what it is asked for', () => {
		expect(COMMUNITY_ALIGNMENT_HOST).toBe('annotations.allmaps.org');
		expect(COMMUNITY_ALIGNMENT_DISCLOSURE).toContain('annotations.allmaps.org');
		expect(COMMUNITY_ALIGNMENT_DISCLOSURE).toContain('existing georeferences');
	});
});
