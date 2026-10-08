import { RemoteIiifRejectedError, remoteIiifUrl } from './remote-resource.js';
import { canonicalServiceUri } from './service-uri.js';

export class ParserBoundaryError extends Error {
	override readonly name = 'ParserBoundaryError';

	constructor(received: unknown) {
		super(
			`Only an image service URI may cross from browsing to the alignment path (ADR-0018), and ` +
				`this is a ${describe(received)}. The alignment path must never inherit browsing's ` +
				`reading of a document — it fetches and re-parses the image service itself, so that a ` +
				`disagreement about the document is loud rather than invisible. Pass the canvas's image ` +
				`service URI as a string and let the alignment path re-parse it from there.`
		);
	}
}

export function imageServiceUriCrossingBoundary(selected: unknown): string {
	if (typeof selected !== 'string') {
		throw new ParserBoundaryError(selected);
	}
	const trimmed = selected.trim();
	if (trimmed === '') {
		throw new RemoteIiifRejectedError({
			url: '',
			reason:
				`That canvas does not paint a IIIF image service, so there is nothing to align. It may ` +
				`be a video, a plain image file, or a choice of layers — any of those can still be ` +
				`viewed, but aligning needs a tiled image service (ADR-0014).`
		});
	}
	return canonicalServiceUri(remoteIiifUrl(trimmed).href);
}

const describe = (value: unknown): string => {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'object') {
		const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
		return typeof name === 'string' && name !== 'Object'
			? `parsed ${name} object`
			: 'parsed object';
	}
	return typeof value;
};
