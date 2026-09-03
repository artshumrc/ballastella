// Which glyph stands for which shape — in one place, because it is used twice and the two have to
// agree: the toolbar button that *draws* a pin and the list row that *is* one show the same icon, so
// that a scholar can learn the glyph once. Two copies would drift the moment one of them is restyled.
//
// Keyed by tool and reached from an Annotation through {@link iconForAnnotation}, because those are the two
// questions asked of it: "what does this button draw?" and "what is this Annotation?".
//
// Here rather than in the editor because a Reader's row draws the same glyph as a scholar's, and a
// shared component may not reach into an app for it (ADR-0034). The toolbar that consumes
// {@link TOOL_ICONS} stays editor-side; only the table is shared.

import { isLabel, type Annotation } from '@ballastella/core';
import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2';
import Circle from '@lucide/svelte/icons/circle';
import Pentagon from '@lucide/svelte/icons/pentagon';
import Spline from '@lucide/svelte/icons/spline';
import Shapes from '@lucide/svelte/icons/shapes';
import Type from '@lucide/svelte/icons/type';

import MapNeedle from './MapNeedle.svelte';

/**
 * The tools this table has a glyph for.
 *
 * Spelled here rather than imported, because the editor's `AnnotationTool` lives in a module this
 * package may not reach (ADR-0034). The two cannot drift silently: the editor indexes
 * {@link TOOL_ICONS} with its own union, so a tool added there and not here fails to compile.
 */
type ToolName = 'select' | 'point' | 'line' | 'polygon' | 'circle' | 'text';

export const TOOL_ICONS = {
	select: MousePointer2,
	// Ours, not Lucide's `map-pin`: the mark on the map is a needle, and the glyph is the same
	// drawing (`MapNeedle.svelte`, `pin-icon.ts`).
	point: MapNeedle,
	line: Spline,
	polygon: Pentagon,
	circle: Circle,
	// The Label. Named `text` because that is what the editor's tool union will spell it, while the word
	// a user meets is always **Label**; the tool itself is not built yet, and this entry is what makes
	// adding it compile.
	text: Type
} as const satisfies Record<ToolName, unknown>;

/**
 * The glyph for one Annotation.
 *
 * **A question about the Annotation, not about its geometry**, because a Label and a Pin are both
 * Points and are not both pins. `shapeWord` reads the same `isLabel` beside this, so the glyph and the
 * word cannot disagree.
 *
 * `Shapes` for the geometry this version cannot draw — a real case rather than a defensive default:
 * a file may carry a `MultiPolygon` or a `GeometryCollection` written by another tool, which this app
 * keeps untouched and still has to list (ADR-0009). It gets a glyph meaning "some shape" rather than
 * one of the three that would claim it is something it is not.
 */
export const iconForAnnotation = (annotation: Annotation) => {
	if (isLabel(annotation)) return TOOL_ICONS.text;
	switch (annotation.geometry?.type) {
		case 'Point':
			return TOOL_ICONS.point;
		case 'LineString':
			return TOOL_ICONS.line;
		case 'Polygon':
			return TOOL_ICONS.polygon;
		case 'Circle':
			return TOOL_ICONS.circle;
		default:
			return Shapes;
	}
};
