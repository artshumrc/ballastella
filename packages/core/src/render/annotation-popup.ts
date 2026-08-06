// An Annotation's popup on the Base Map (SPEC story 67).
//
// **The rendering is not here.** `renderAnnotationPopup` in `../annotation/markdown.ts` builds the
// HTML, escaping the title and sanitising the description, and this module only puts the result on the
// map. That split is the whole reason ticket 17 can assert the same payload is inert in a Published
// Site: the viewer draws its popups with this very function, and there is no second place where a
// `description` becomes HTML (ADR-0009).
//
// **There is one `setHTML` call in this repository and it is below.** That is why this module is in
// `core` rather than duplicated per app: a second copy would be a second place for an edit to reach
// for `setDOMContent`, an interpolation, or a "just add a class" that reintroduced markup assembly
// outside the sanitiser — on the origin a Reader's browser trusts.

import type { Annotation } from '../annotation/annotation.js';
import { renderAnnotationPopup } from '../annotation/markdown.js';
import { Popup, type Map as MapLibreMap } from 'maplibre-gl';

/** A popup on the map, and the way to take it off again. */
export interface AnnotationPopup {
	destroy(): void;
}

/**
 * Show one Annotation's title and description at `at`.
 *
 * `closeOnClick: false`, because the click that opens this popup is a click on the map and MapLibre
 * would close it in the same gesture. Closing is the popup's own button, Escape, or opening another.
 *
 * @returns `null` when the Annotation has nothing to say, so an empty popup never appears
 */
export function showAnnotationPopup(options: {
	map: MapLibreMap;
	annotation: Annotation;
	at: { lng: number; lat: number };
	/** The reader dismissed it — the close button, or Escape. */
	onclose?: (() => void) | undefined;
}): AnnotationPopup | null {
	const { map, annotation, at, onclose } = options;
	const html = renderAnnotationPopup({
		title: annotation.properties.title,
		description: annotation.properties.description
	});
	if (html === '') return null;

	const popup = new Popup({
		closeOnClick: false,
		closeButton: true,
		maxWidth: '22rem',
		className: 'annotation-popup'
	});
	popup.setLngLat([at.lng, at.lat]);
	// `setHTML` rather than `setDOMContent`, and safe **because of what it is given**: the string is
	// DOMPurify's own output. Note the difference from `setText`, which would show the Markdown source
	// rather than rendering it, and from building the element here, which would put a second assembly
	// of untrusted text in the app.
	popup.setHTML(html);
	if (onclose) popup.on('close', onclose);
	popup.addTo(map);

	return {
		destroy() {
			// The listener first: `remove()` fires `close`, and reporting a dismissal the page asked for
			// would send it round again to clear a selection the user had just made somewhere else.
			if (onclose) popup.off('close', onclose);
			popup.remove();
		}
	};
}
