// Where an Annotation is drawn on the screen, for whatever has to point at it (SPEC stories 39–41).
//
// ⚠ **This is the only place that turns an Annotation's coordinate into a box on the screen.** The
// leader used to find its map end by querying for a numbered mark that MapLibre had positioned, so
// the projection was MapLibre's and the leader only had to read a `getBoundingClientRect`. With the
// mark gone the leader points at the Annotation's own drawing, and the projection has to be done
// here — against the live camera, so there is no listener-ordering hazard of the kind
// `LeaderLine.svelte` records: `map.project` answers for the camera as it is now, not as it was one
// `move` ago.

import {
	annotationAnchor,
	isLabel,
	type Annotation,
	type LineStringGeometry
} from '../annotation/annotation.js';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { pinHeight } from './pin-icon.js';

/** A rectangle in the viewport's own coordinates — what `getBoundingClientRect` returns. */
export interface ScreenBox {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

/**
 * Where a line is pointed at: its **westmost vertex**, which is a place on the line itself.
 *
 * ⚠ **A line is the one geometry the middle of the extent is wrong for.** For a shape that middle is
 * inside the drawing nearly always, and for a Pin it is the Pin; for an `L` or a `C` of coastline it
 * is off the line altogether, so the leader ended in open water beside the quay it was naming. A
 * vertex is on the line by construction, whatever the line's shape.
 *
 * **Westmost, and by longitude rather than by projected x.** The sidebar is on the left on both
 * screens that draw a leader over Annotations, so the west end is the end of the line facing its own
 * row and the leader crosses as little of the drawing as it can. Choosing by the stored coordinate
 * rather than by where the vertex currently lands keeps the choice still while the map is panned and
 * zoomed — a rule stated in screen pixels would hop from vertex to vertex mid-gesture. Its one limit
 * is a rotated map, where the west end is no longer the left end; the leader is then drawn to a
 * vertex that is still on the line, which is the property that matters.
 *
 * Latitude breaks a tie, so a north–south line has one answer rather than two.
 */
function westmostVertex(geometry: LineStringGeometry): { lng: number; lat: number } | null {
	let westmost: readonly [number, number] | null = null;
	for (const vertex of geometry.coordinates) {
		if (
			westmost === null ||
			vertex[0] < westmost[0] ||
			(vertex[0] === westmost[0] && vertex[1] < westmost[1])
		) {
			westmost = vertex;
		}
	}
	return westmost === null ? null : { lng: westmost[0], lat: westmost[1] };
}

/**
 * The box an Annotation occupies on screen, or `null` when it has nothing drawn to point at.
 *
 * **A Pin and a shape are anchored at `annotationAnchor`'s point** — the middle of the geometry's
 * extent — which is where the popup pointed too, so the leader and the popup name one place rather
 * than two. Its known limit is that middle's: for a crescent or a horseshoe it is outside the shape.
 * This is a place to aim a line rather than a measurement, and a guaranteed-interior point costs a
 * pole-of-inaccessibility search for a case a scholar's quay or parish is not. A line is
 * {@link westmostVertex}'s instead, and that note says why.
 *
 * **A Pin gets its pin's box and everything else gets a point.** A pin is anchored at its *tip*
 * (`icon-anchor: 'bottom'` in `stack-layers.ts`), so a line drawn to the coordinate would run under
 * the pin and end beneath it — pointing at the ground the pin stands on rather than at the pin. The
 * box returned is the pin's own extent, which puts the centre halfway up it and lets a caller that
 * shortens by half the box stop at its edge. A line, a shape and a Label are their anchor exactly: the
 * leader ends on the drawing itself, and there is no mark around it to clear.
 *
 * The icon is square in `pin-icon.ts` — 96 px at `PIN_PIXEL_RATIO` 2, scaled by `marker-size` — so
 * its width is its height.
 */
export function annotationMarkBox(map: MapLibreMap, annotation: Annotation): ScreenBox | null {
	const geometry = annotation.geometry;
	const at =
		geometry?.type === 'LineString' ? westmostVertex(geometry) : annotationAnchor(annotation);
	if (at === null) return null;

	const container = map.getCanvasContainer().getBoundingClientRect();
	const point = map.project([at.lng, at.lat]);
	const x = container.left + point.x;
	const y = container.top + point.y;

	// A Label is centred on its coordinate and has no pin, so the leader ends on the words themselves —
	// like a line's and a shape's, and unlike the pin's box below.
	if (geometry?.type !== 'Point' || isLabel(annotation)) {
		return { left: x, top: y, right: x, bottom: y };
	}
	const height = pinHeight(annotation.properties['marker-size']);
	return { left: x - height / 2, top: y - height, right: x + height / 2, bottom: y };
}
