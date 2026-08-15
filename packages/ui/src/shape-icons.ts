// Which glyph stands for which shape — in one place, because it is used twice and the two have to
// agree: the toolbar button that *draws* a pin and the list row that *is* one show the same icon, so
// that a scholar can learn the glyph once. Two copies would drift the moment one of them is restyled.
//
// Keyed by tool and reached from geometry through {@link iconForGeometry}, because those are the two
// questions asked of it: "what does this button draw?" and "what is this Annotation?".
//
// Here rather than in the editor because a Reader's row draws the same glyph as a scholar's, and a
// shared component may not reach into an app for it (ADR-0034). The toolbar that consumes
// {@link TOOL_ICONS} stays editor-side; only the table is shared.

import MapPin from '@lucide/svelte/icons/map-pin';
import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2';
import Pentagon from '@lucide/svelte/icons/pentagon';
import Spline from '@lucide/svelte/icons/spline';
import Shapes from '@lucide/svelte/icons/shapes';

/**
 * The tools this table has a glyph for.
 *
 * Spelled here rather than imported, because the editor's `AnnotationTool` lives in a module this
 * package may not reach (ADR-0034). The two cannot drift silently: the editor indexes
 * {@link TOOL_ICONS} with its own union, so a tool added there and not here fails to compile.
 */
type ToolName = 'select' | 'point' | 'line' | 'polygon';

export const TOOL_ICONS = {
	select: MousePointer2,
	point: MapPin,
	line: Spline,
	polygon: Pentagon
} as const satisfies Record<ToolName, unknown>;

/**
 * The glyph for an Annotation's own geometry.
 *
 * `Shapes` for the geometry this version cannot draw — a real case rather than a defensive default:
 * a file may carry a `MultiPolygon` or a `GeometryCollection` written by another tool, which this app
 * keeps untouched and still has to list (ADR-0009). It gets a glyph meaning "some shape" rather than
 * one of the three that would claim it is something it is not.
 */
export const iconForGeometry = (type: string | undefined) => {
	switch (type) {
		case 'Point':
			return TOOL_ICONS.point;
		case 'LineString':
			return TOOL_ICONS.line;
		case 'Polygon':
			return TOOL_ICONS.polygon;
		default:
			return Shapes;
	}
};
