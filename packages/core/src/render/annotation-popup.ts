// An Annotation's popup on a MapLibre map.
//
// ⚠ **No screen calls this today, and it is kept deliberately.** The map popup retired from the
// Project screen in both apps (`one-shell-two-apps` ticket 07): an Annotation is read in its own row
// in the Layer sidebar, which is one destination for one gesture instead of two that can disagree.
// What did *not* retire is the sanitiser — this is the module the payload matrix in
// `../annotation/markdown.browser.test.ts` exercises, and it is the shape any future popup surface
// has to take rather than a shape somebody would have to rediscover.
//
// **The rendering is not here.** `renderAnnotationPopup` in `../annotation/markdown.ts` builds the
// HTML, escaping the title and sanitising the description, and this module only puts the result on the
// map. That split is what lets the same payload be asserted inert wherever an Annotation is rendered:
// there is no second place where a `description` becomes HTML (ADR-0009).
//
// **There is one `setHTML` call in this repository and it is below.** That is why this module is in
// `core` rather than duplicated per app: a second copy would be a second place for an edit to reach
// for `setDOMContent`, an interpolation, or a "just add a class" that reintroduced markup assembly
// outside the sanitiser — on the origin a Reader's browser trusts.

import { annotationAnchor, isLabel, type Annotation } from '../annotation/annotation.js';
import { renderAnnotationPopup } from '../annotation/markdown.js';
import { pinHeight } from './pin-icon.js';
import { Popup, type Map as MapLibreMap } from 'maplibre-gl';

/** The id of the one stylesheet below, so it is added once per document. */
const STYLE_ELEMENT_ID = 'ballastella-annotation-popup-style';

/**
 * How the popup looks, **here rather than in either app's `layout.css`**.
 *
 * The same argument this module already makes about `setHTML`: a popup drawn by one function in
 * `core` and styled by two copies of a stylesheet is a popup that looks like two different things in
 * the authoring app and the Published Site, and the drift is invisible until somebody compares them
 * side by side. MapLibre ships its own popup CSS with both apps, so *something* has to override it;
 * doing that once, beside the code that creates the element, is what keeps the two agreeing.
 *
 * Every colour is a daisyUI theme token, so the popup follows the theme — including dark — and Tracy
 * still owns what the colours are (ADR-0016, ADR-0020). Nothing here is a literal colour.
 */
const POPUP_STYLE = `
.annotation-popup .maplibregl-popup-content {
	padding: 0.7rem 2.1rem 0.7rem 0.9rem;
	border-radius: 0.5rem;
	background: var(--color-base-100);
	color: var(--color-base-content);
	box-shadow: 0 2px 12px oklch(0 0 0 / 0.25);
	font: inherit;
	line-height: 1.45;
}
/* The tip is a CSS triangle made of borders, so the one facing the map takes the popup's own
   background and the other three stay transparent — which is why this is eight rules and not one. */
.annotation-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip,
.annotation-popup.maplibregl-popup-anchor-bottom-left .maplibregl-popup-tip,
.annotation-popup.maplibregl-popup-anchor-bottom-right .maplibregl-popup-tip {
	border-top-color: var(--color-base-100);
}
.annotation-popup.maplibregl-popup-anchor-top .maplibregl-popup-tip,
.annotation-popup.maplibregl-popup-anchor-top-left .maplibregl-popup-tip,
.annotation-popup.maplibregl-popup-anchor-top-right .maplibregl-popup-tip {
	border-bottom-color: var(--color-base-100);
}
.annotation-popup.maplibregl-popup-anchor-left .maplibregl-popup-tip {
	border-right-color: var(--color-base-100);
}
.annotation-popup.maplibregl-popup-anchor-right .maplibregl-popup-tip {
	border-left-color: var(--color-base-100);
}
/* MapLibre's own close button is a bare "×" at the text's own size in the corner's padding — a
   target a few pixels across, which fails WCAG 2.1 AA's 24px minimum and is most of why the popup
   felt unfinished. It is a real button here, and the padding above keeps the text clear of it. */
.annotation-popup .maplibregl-popup-close-button {
	top: 0.15rem;
	right: 0.15rem;
	width: 1.75rem;
	height: 1.75rem;
	border-radius: 0.375rem;
	font-size: 1.15rem;
	line-height: 1;
	color: var(--color-base-content);
	opacity: 0.65;
}
.annotation-popup .maplibregl-popup-close-button:hover,
.annotation-popup .maplibregl-popup-close-button:focus-visible {
	background: var(--color-base-200);
	opacity: 1;
}
/* The title. Bold because it is the Annotation's name and, for most Annotations, the whole of what
   the popup says — unstyled it read as the first line of a paragraph. */
.annotation-popup .ballastella-annotation-title {
	margin: 0;
	font-weight: 600;
}
.annotation-popup .ballastella-annotation-title + * {
	margin-top: 0.4rem;
}
.annotation-popup p {
	margin: 0 0 0.4rem;
}
.annotation-popup p:last-child {
	margin-bottom: 0;
}
`;

/** Put the stylesheet in the document once. */
function ensurePopupStyle(): void {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
	const style = document.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = POPUP_STYLE;
	document.head.append(style);
}

/**
 * How far above the anchor the popup floats, in pixels.
 *
 * For a Point that is the height of its own pin: the anchor is the coordinate, the pin stands on it,
 * and a popup offset by nothing covers the mark it is describing. {@link pinHeight} is where that
 * measurement lives, rather than repeating it here — the ordinal above the pin needs the same number.
 *
 * A Label is a Point with no pin, so it takes the small clearance a line and a shape take: a pin's
 * height above a Label would float the popup over unrelated map with a gap under it. Same reading as
 * `annotation-mark.ts` makes of the same fact.
 *
 * A number rather than a per-anchor object, so MapLibre offsets radially from the anchor point.
 */
function clearance(annotation: Annotation): number {
	if (annotation.geometry?.type !== 'Point' || isLabel(annotation)) return 10;
	return pinHeight(annotation.properties['marker-size']) + 4;
}

/** A popup on the map, and the way to take it off again. */
export interface AnnotationPopup {
	destroy(): void;
}

/**
 * Show one Annotation's title and description, over the middle of the Annotation itself.
 *
 * **`at` is a fallback, not the position.** It is where the reader clicked, and a popup placed there
 * follows the pointer around a long shape — so the same Annotation opened twice appears in two
 * places, and nothing on screen ties the words to the shape. {@link annotationAnchor} gives the
 * middle instead, and `at` is used only for a geometry this build cannot measure.
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

	ensurePopupStyle();
	const popup = new Popup({
		closeOnClick: false,
		closeButton: true,
		maxWidth: '22rem',
		className: 'annotation-popup',
		// **Above the Annotation, centred on it, and not wherever MapLibre would have put it.** Left to
		// choose, MapLibre picks an anchor from where the point sits in the container — so the same
		// Annotation opened near the top of the map got its popup *below* the mark and, off to one
		// side, beside it. That is three placements for one thing, and none of them says "these words
		// belong to that shape" as plainly as sitting over it does. `'bottom'` is the popup's bottom
		// edge on the anchor, which is the popup above.
		anchor: 'bottom',
		offset: clearance(annotation)
	});
	const anchor = annotationAnchor(annotation) ?? at;
	popup.setLngLat([anchor.lng, anchor.lat]);
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
