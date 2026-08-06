// The parser boundary (ADR-0018): triiiceratops selects, and **only an image service URI
// crosses**.
//
// The bundle carries two independent IIIF parsers. triiiceratops navigates Manifests and
// Collections with `manifesto.js`; the alignment path reads tile geometry with
// `@allmaps/iiif-parser`. That is accepted — they do genuinely different jobs — on one condition:
// neither may ever consume the other's interpretation. If it did, the two parsers' readings of the
// same Manifest could disagree, and the disagreement would be invisible, because each half would
// look internally consistent.
//
// So the contract is a *string*. A user browses in triiiceratops, picks a canvas, and what comes
// back is the canvas's image service URI. `@allmaps/iiif-parser` then re-parses from that URI
// independently, from its own fetch of its own `info.json`. Nothing structured is shared, so any
// disagreement about anything else in the document has nowhere to land.
//
// **A contract this easy to break by accident needs to be a function.** Handing a parsed canvas
// across would compile perfectly well — `imageService` is a property on both parsers' canvas
// objects — and it would work, right up to the manifest where the two disagree. So the crossing is
// this one call, it refuses anything that is not a URI string, and the refusal names the rule.

import { RemoteIiifRejectedError, remoteIiifUrl } from './remote-resource.js';

/**
 * Thrown when something other than an image service URI is handed across the parser boundary.
 *
 * A programming error rather than a user's, and deliberately not a `RemoteIiifRejectedError`: this
 * is not "that resource cannot be used", it is "this code violated ADR-0018", and the two must not
 * be reported to a scholar in the same words.
 */
export class ParserBoundaryError extends Error {
	constructor(received: unknown) {
		super(
			`Only an image service URI may cross from triiiceratops to the alignment path ` +
				`(ADR-0018), and this is a ${describe(received)}. The two IIIF parsers in this bundle — ` +
				`manifesto.js inside triiiceratops, @allmaps/iiif-parser in the alignment path — must ` +
				`never consume each other's interpretation, because a disagreement between them would ` +
				`be invisible rather than loud. Pass the canvas's image service URI as a string and let ` +
				`the alignment path re-parse it from there.`
		);
		this.name = 'ParserBoundaryError';
	}
}

/**
 * The image service URI a selection is handing over, or a refusal.
 *
 * The one door in the wall. Every path from browsing to alignment goes through it, and it accepts
 * exactly one kind of thing: an absolute `http`/`https` URI string. A parsed canvas, a `Canvas`
 * object, an `EmbeddedImage`, a `{ uri }` wrapper — all refused, by design, because each of them
 * is a plausible thing for a future contributor to pass and every one of them would work until it
 * did not.
 *
 * The URI itself is then validated by the same function that validates a pasted one, so a canvas
 * whose image service is `data:` or carries credentials is refused here too rather than two
 * requests later.
 */
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
	// Returns the normalised href rather than the input: the fragment stripping and scheme check in
	// `remoteIiifUrl` are the point, and returning the original would make them advisory.
	return remoteIiifUrl(trimmed)
		.href.replace(/\/info\.json$/, '')
		.replace(/\/$/, '');
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
