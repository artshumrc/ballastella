// The parser boundary (ADR-0018): browsing selects, and **only an image service URI crosses**.
//
// ADR-0018 stated this as a rule about two IIIF parsers meeting — `manifesto.js` inside
// triiiceratops for navigation, `@allmaps/iiif-parser` for tile geometry — because that is how the
// editor was expected to browse. **It is not how the editor browses, and the editor does not carry
// triiiceratops at all**: navigation is the editor's own canvas list in
// `AddRemoteMap.svelte`, over `@allmaps/iiif-parser`, and triiiceratops now lives only in
// `apps/viewer` (see ADR-0018's amendment note).
//
// **The rule survives its original reason, and this is the part worth reading.** What the boundary
// really forbids is a *parsed structure* crossing from the browsing step to the alignment step. Both
// steps use the same parser today, so a disagreement is not the hazard it was; the hazard that
// remains is a canvas object carried across and read as authoritative, so alignment inherits
// browsing's interpretation of the document instead of fetching and re-reading the image service
// itself. That difference is visible the moment the two views of a Manifest are not the same — a
// library edits it, a canvas paints a choice of layers, a service is behind a redirect.
//
// So the contract is a *string*. A user picks a canvas, and what comes back is that canvas's image
// service URI. The alignment path re-parses from that URI independently, from its own fetch of its
// own `info.json`. Nothing structured is shared, so any reading of anything else in the document has
// nowhere to land. If a triiiceratops-driven browsing UI ever returns to the editor, the boundary is
// already where it needs to be.
//
// **A contract this easy to break by accident needs to be a function.** Handing a parsed canvas
// across would compile perfectly well — `imageService` is right there on the object the browsing
// step already holds — and it would work, right up to the document the two readings disagree
// about. So the crossing is this one call, it refuses anything that is not a URI string, and the
// refusal names the rule.

import { RemoteIiifRejectedError, remoteIiifUrl } from './remote-resource.js';
import { canonicalServiceUri } from './service-uri.js';

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
			`Only an image service URI may cross from browsing to the alignment path (ADR-0018), and ` +
				`this is a ${describe(received)}. The alignment path must never inherit browsing's ` +
				`reading of a document — it fetches and re-parses the image service itself, so that a ` +
				`disagreement about the document is loud rather than invisible. Pass the canvas's image ` +
				`service URI as a string and let the alignment path re-parse it from there.`
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
	// `remoteIiifUrl` are the point, and returning the original would make them advisory. The spelling
	// is then `canonicalServiceUri`'s, the same one the pasted-URL path and `remote.json` use, so a
	// canvas and a paste that name one service cannot become two Map Images.
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
