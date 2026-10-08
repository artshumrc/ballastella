import {
	SIMPLESTYLE_DEFAULTS,
	lineStyleOf,
	plainGeometry,
	resolveStyle,
	type AnnotationCollection,
	type LineStyle
} from './annotation.js';

export const LINE_STYLE_PROPERTY = 'ballastella:line-style';
export const ANNOTATION_ID_PROPERTY = 'ballastella:id';
export const LINE_STYLES: readonly LineStyle[] = ['solid', 'dashed', 'dotted'];

export function toRenderCollection(collection: AnnotationCollection): {
	type: 'FeatureCollection';
	features: Record<string, unknown>[];
} {
	return {
		type: 'FeatureCollection',
		features: collection.annotations.flatMap((annotation) => {
			const geometry = annotation.geometry;
			if (geometry === null || geometry.type === 'foreign') return [];
			const style = resolveStyle(annotation.properties);
			const { title, description } = annotation.properties;
			return [
				{
					type: 'Feature',
					geometry: plainGeometry(geometry),
					properties: {
						...style,
						[ANNOTATION_ID_PROPERTY]: annotation.id,
						[LINE_STYLE_PROPERTY]: lineStyleOf(style['stroke-dasharray']),
						...(title === undefined ? {} : { title }),
						...(description === undefined ? {} : { description })
					}
				}
			];
		})
	};
}

export function mapLibreDashArray(dash: readonly [number, number]): [number, number] {
	const width = SIMPLESTYLE_DEFAULTS['stroke-width'];
	return [dash[0] / width, dash[1] / width];
}
