import {
	annotationAnchor,
	isLabel,
	type Annotation,
	type LineStringGeometry
} from '../annotation/annotation.js';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { pinHeight } from './pin-icon.js';

export interface ScreenBox {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

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

export function annotationMarkBox(map: MapLibreMap, annotation: Annotation): ScreenBox | null {
	const geometry = annotation.geometry;
	const at =
		geometry?.type === 'LineString' ? westmostVertex(geometry) : annotationAnchor(annotation);
	if (at === null) return null;
	const container = map.getCanvasContainer().getBoundingClientRect();
	const point = map.project([at.lng, at.lat]);
	const x = container.left + point.x;
	const y = container.top + point.y;

	if (geometry?.type !== 'Point' || isLabel(annotation)) {
		return { left: x, top: y, right: x, bottom: y };
	}
	const height = pinHeight(annotation.properties['marker-size']);
	return { left: x - height / 2, top: y - height, right: x + height / 2, bottom: y };
}
