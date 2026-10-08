import { generateId } from '@allmaps/id';
import type { Image } from '@allmaps/iiif-parser';

import type { Alignment } from '../alignment/alignment.js';
import { parseAlignment } from '../alignment/georeference-annotation.js';
import { messageOf } from '../store/project-store.js';
import { canonicalServiceUri } from './service-uri.js';

export const COMMUNITY_ALIGNMENT_HOST = 'annotations.allmaps.org';
export const COMMUNITY_ALIGNMENT_DISCLOSURE = `Check ${COMMUNITY_ALIGNMENT_HOST} for existing georeferences of this image.`;
const MAX_COMMUNITY_ALIGNMENTS = 25;

type CommunityAlignment = {
	readonly index: number;
	readonly alignment: Alignment;
};

export type CommunityAlignmentOffer =
	| { readonly state: 'off' }
	| { readonly state: 'found'; readonly alignments: readonly CommunityAlignment[] }
	| { readonly state: 'unavailable'; readonly detail: string };

export async function findCommunityAlignments(options: {
	readonly enabled: boolean;
	readonly image: Image;
	readonly imageId: string;
	readonly fetchAnnotations: (parsed: Image) => Promise<unknown[]>;
	readonly limit?: number;
}): Promise<CommunityAlignmentOffer> {
	if (!options.enabled) return { state: 'off' };
	let documents: unknown[];
	try {
		documents = await options.fetchAnnotations(options.image);
	} catch (cause) {
		return { state: 'unavailable', detail: messageOf(cause) };
	}

	const limit = options.limit ?? MAX_COMMUNITY_ALIGNMENTS;
	const alignments: CommunityAlignment[] = [];

	for (const document of documents) {
		for (const map of await maps(document)) {
			if (map.imageId !== options.imageId) continue;
			let alignment: Alignment;
			try {
				alignment = parseAlignment(map.bytes, { imageId: options.imageId });
			} catch {
				continue;
			}
			alignments.push({ index: alignments.length, alignment });
			if (alignments.length >= limit) return { state: 'found', alignments };
		}
	}

	return { state: 'found', alignments };
}

async function maps(document: unknown): Promise<{ imageId: string; bytes: Uint8Array }[]> {
	const items = pageItems(document);
	const out: { imageId: string; bytes: Uint8Array }[] = [];

	for (const item of items) {
		const resourceId = readResourceId(item);
		if (resourceId === null) continue;
		let bytes: Uint8Array;
		try {
			bytes = new TextEncoder().encode(JSON.stringify(item));
		} catch {
			continue;
		}
		// Canonicalised so `…/sheet/info.json` and `…/sheet` hash to the same image id.
		out.push({ imageId: await generateId(canonicalServiceUri(resourceId)), bytes });
	}

	return out;
}

function pageItems(document: unknown): unknown[] {
	if (Array.isArray(document)) return document.flatMap((entry) => pageItems(entry));
	const record = document as { type?: unknown; items?: unknown } | null;
	if (record === null || typeof record !== 'object') return [];
	if (Array.isArray(record.items)) return record.items;
	return [record];
}

function readResourceId(item: unknown): string | null {
	const record = item as {
		target?: { source?: { id?: unknown } | string };
		resource?: { id?: unknown };
	} | null;
	const source = record?.target?.source;
	const candidates = [typeof source === 'string' ? source : source?.id, record?.resource?.id];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate !== '') return candidate;
	}
	return null;
}
