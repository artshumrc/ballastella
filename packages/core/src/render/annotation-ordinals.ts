// An Annotation's number, drawn on its mark on the map (SPEC stories 37, 38, 42, 43).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A DOM MARKER AND NOT A SYMBOL LAYER
//
// A Pin is a MapLibre symbol layer — `stack-layers.ts` registers an SDF and paints it per feature —
// so a `text-field` beside it looks like the obvious home for the number, and it is not:
//
//   * **MapLibre text needs a glyph source, and a Published Site is allowed not to have one.**
//     `ReaderMapPane.styleFor` deletes `glyphs` and filters *every* symbol layer out of the style for
//     a site published without its Base Map files, on the recorded grounds that nothing the Layer
//     stack draws needs them. A `text-field` ordinal would therefore be silently absent for exactly
//     those Readers, which breaks story 38 in the place it is hardest to notice — no error, no
//     missing image, just no numbers.
//   * **A MapLibre paint value is not CSS**, so it cannot be `var(--color-info)` and cannot be the
//     `oklch()` behind it either; `ReaderMapPane` records having to write two theme colours out as
//     literals for this reason. A DOM element reads the theme's own custom properties, which is what
//     lets the number stay legible in both flavours without a colour being copied anywhere.
//   * **The prior art for a numbered mark here is a DOM element**: `.pane-overlay-point-control-point`
//     draws a Control Point's ordinal *inside* it, because ADR-0022 wanted "look at point 7" to work
//     over a student's shoulder. This is that mark's sibling on the Project screen.
//
// The cost accepted is one DOM node per drawn Annotation, repositioned by MapLibre on every map move.
// That is the same arrangement the alignment route already runs with its Control Points.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ NOTHING HERE IS WRITTEN (ADR-0002)
//
// The number is `annotationOrdinal`'s reading of the collection's order at the moment this draws, and
// the mark is a DOM element outside the GeoJSON source entirely — the features MapLibre is handed are
// `toRenderCollection`'s and gain nothing from this. Deleting an Annotation renumbers the rest
// because {@link AnnotationOrdinals.update} runs again over a shorter list.
//
// The stylesheet is here rather than in either app's `layout.css`, which is `annotation-popup.ts`'s
// own argument: a mark drawn by one function in `core` and styled by two copies of a stylesheet is a
// mark that looks like two different things in the authoring app and the Published Site.

import { annotationAnchor, type AnnotationCollection } from '../annotation/annotation.js';
import { annotationOrdinal } from '../annotation/ordinal.js';
import { Marker, type Map as MapLibreMap } from 'maplibre-gl';

import { pinHeight } from './pin-icon.js';

/** The id of the one stylesheet below, so it is added once per document. */
const STYLE_ELEMENT_ID = 'ballastella-annotation-ordinal-style';

/** The class the mark is drawn with, and what a leader line (ticket 12) will find its end by. */
export const ANNOTATION_ORDINAL_CLASS = 'annotation-ordinal';

/**
 * How the number looks on the map.
 *
 * **A sibling of `.pane-overlay-point-control-point`**, which is the repository's other numbered mark:
 * a small filled disc with the ordinal inside it as text, ringed in the page's own background so it
 * stays separate from whatever it is sitting on. Same idea, same weight, `info` rather than `primary`
 * because `info` is the Annotation kind's colour throughout the Layer stack (`layer-kind-style.ts`)
 * and `primary` is reserved for the application's own actions.
 *
 * **The contrast is between two theme tokens and not against the Annotation's own colour**, which is
 * the whole reason the number has a mark of its own rather than being drawn on the pin: `marker-color`
 * is the scholar's choice and can be anything, so no ink could be guaranteed to carry against it.
 * `info-content` on `info` is **6.31:1 in both the light and the dark theme** — measured from the
 * shipped daisyUI palette, `oklch(29% .066 243.157)` on `oklch(74% .16 232.661)`, which the two
 * themes happen to share — against the 4.5:1 WCAG 2.1 AA asks of text this size. For comparison the
 * Control Point's own `primary-content` on `primary` is 6.76:1 in light and 4.14:1 in dark, so this
 * pair is the better of the two in the flavour where it matters. `e2e/editor-annotations.e2e.ts`
 * re-measures it from the running application's own computed styles in both themes, because a theme
 * generator is free to redefine either token.
 *
 * `pointer-events: none`, because this is a label: the click that selects an Annotation has to reach
 * the map underneath, and the mark can sit over the shape it names.
 */
const ORDINAL_STYLE = `
.${ANNOTATION_ORDINAL_CLASS} {
	box-sizing: border-box;
	display: grid;
	place-items: center;
	min-width: 20px;
	height: 20px;
	padding: 0 4px;
	border-radius: 9999px;
	border: 2px solid var(--color-base-100);
	background: var(--color-info);
	color: var(--color-info-content);
	font-size: 11px;
	font-weight: 700;
	line-height: 1;
	font-variant-numeric: tabular-nums;
	box-shadow: 0 1px 3px oklch(0 0 0 / 0.4);
	pointer-events: none;
}
`;

/** Put the stylesheet in the document once. */
function ensureOrdinalStyle(): void {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
	const style = document.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = ORDINAL_STYLE;
	document.head.append(style);
}

/**
 * The mark's own radius plus a hair, so a Pin's number clears the crown of its pin rather than
 * sitting on it. The mark is offset from its *centre*, so half its height is the whole of this.
 */
const MARK_RADIUS = 12;

/** One Annotation's number, and where on the earth it is drawn. */
export interface AnnotationMark {
	readonly id: string;
	/** Its place in the collection, counted from one — {@link annotationOrdinal}'s. */
	readonly ordinal: number;
	readonly at: { lng: number; lat: number };
	/**
	 * How far above {@link at}, in screen pixels, the number sits.
	 *
	 * The height of a Pin's own pin plus this mark's radius, because a pin is anchored at its tip: a
	 * number drawn at the coordinate would sit underneath the mark it names, and one drawn at the
	 * pin's height would sit on its crown. Zero for a line and a shape — their number sits *on* the
	 * middle of them, which is what says the number belongs to that shape rather than beside it.
	 */
	readonly clearance: number;
}

/**
 * Every Annotation in `collection` that has somewhere on the earth to put a number.
 *
 * **Where a line's and a shape's number is anchored is `annotationAnchor`'s answer** — the middle of
 * the geometry's extent — and that is a reuse rather than a new decision. The alternatives were the
 * first vertex, which puts the label at the end of a coastline or in a corner of a parish and reads as
 * belonging to the vertex rather than to the shape; and letting MapLibre place a symbol itself, which
 * for a polygon is computed per *tile* and so moves as the map is zoomed and a shape is clipped
 * differently. The middle of the extent is a pure function of the coordinates, so it is the same place
 * at every zoom and every centre, and it is already where the Annotation's popup points — so the
 * number, the popup, and (ticket 12) the leader all name one point instead of three.
 *
 * Its known limit, accepted here as it is there: for a crescent or a horseshoe the middle of the
 * extent is outside the shape. This is a place to hang a label rather than a measurement, and a
 * guaranteed-interior point costs a pole-of-inaccessibility search for a case a scholar's quay or
 * parish is not.
 *
 * An Annotation whose geometry this build cannot draw has no mark, and **takes its number with it**:
 * the ordinals of the rest are unchanged, because an ordinal is the collection's position and the
 * sidebar still lists that Annotation as what it is.
 */
export function annotationMarks(collection: AnnotationCollection | null): AnnotationMark[] {
	return (collection?.annotations ?? []).flatMap((annotation, index) => {
		const at = annotationAnchor(annotation);
		if (at === null) return [];
		return [
			{
				id: annotation.id,
				ordinal: annotationOrdinal(index),
				at,
				clearance:
					annotation.geometry?.type === 'Point'
						? pinHeight(annotation.properties['marker-size']) + MARK_RADIUS
						: 0
			}
		];
	});
}

/** The numbers of one Annotation Layer, on the map, and the way to take them off again. */
export interface AnnotationOrdinals {
	/** Draw the numbers this collection has now, adding, moving and removing marks to match. */
	update(collection: AnnotationCollection | null): void;
	destroy(): void;
}

/**
 * Draw and maintain one Annotation Layer's numbers.
 *
 * Reconciled by Annotation id rather than rebuilt, for the reason `overlay-points.ts` records about
 * Control Points: a mark that is destroyed and recreated on every change is a mark that flickers
 * through every keystroke of a title, since each keystroke hands the page a new collection.
 */
export function createAnnotationOrdinals(map: MapLibreMap): AnnotationOrdinals {
	ensureOrdinalStyle();
	const marks = new Map<string, { marker: Marker; element: HTMLElement }>();

	const create = (): { marker: Marker; element: HTMLElement } => {
		const element = document.createElement('div');
		// Toggled rather than assigned, because MapLibre puts its own classes on this element inside
		// `new Marker(...)` — overwriting `className` costs it `position: absolute` and leaves every
		// mark laid out in the container's normal flow (`overlay-points.ts` records the measurement).
		element.classList.add(ANNOTATION_ORDINAL_CLASS);
		element.dataset.testid = 'annotation-ordinal';
		// The map's canvas is not a surface a screen reader reads, and the number reaches assistive
		// technology from the Annotation's own row, inside its button (story 42). A second copy of it
		// here would be a decoration announcing itself.
		element.setAttribute('aria-hidden', 'true');
		return { marker: new Marker({ element, anchor: 'center' }), element };
	};

	return {
		update(collection) {
			const seen = new Set<string>();
			for (const mark of annotationMarks(collection)) {
				seen.add(mark.id);
				const held = marks.get(mark.id) ?? create();
				if (!marks.has(mark.id)) marks.set(mark.id, held);
				held.element.textContent = String(mark.ordinal);
				held.element.dataset.ordinal = String(mark.ordinal);
				held.element.dataset.annotationId = mark.id;
				// Negative y is up. Re-set on every update because `marker-size` is a control the scholar
				// can change while the mark is on the map.
				held.marker.setOffset([0, -mark.clearance]);
				held.marker.setLngLat([mark.at.lng, mark.at.lat]).addTo(map);
			}
			for (const [id, held] of marks) {
				if (seen.has(id)) continue;
				held.marker.remove();
				marks.delete(id);
			}
		},

		destroy() {
			for (const held of marks.values()) held.marker.remove();
			marks.clear();
		}
	};
}
