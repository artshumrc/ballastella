import { isLabel, type Annotation } from '@ballastella/core';
import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2';
import Circle from '@lucide/svelte/icons/circle';
import Pentagon from '@lucide/svelte/icons/pentagon';
import Spline from '@lucide/svelte/icons/spline';
import Shapes from '@lucide/svelte/icons/shapes';
import Type from '@lucide/svelte/icons/type';

import MapNeedle from './MapNeedle.svelte';

type ToolName = 'select' | 'point' | 'line' | 'polygon' | 'circle' | 'text';

export const TOOL_ICONS = {
	select: MousePointer2,
	// Ours, not Lucide's `map-pin`: the mark on the map is a needle, and the glyph is the same drawing (`MapNeedle.svelte`, `pin-icon.ts`).
	point: MapNeedle,
	line: Spline,
	polygon: Pentagon,
	circle: Circle,
	text: Type
} as const satisfies Record<ToolName, unknown>;

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
