import { annotationOrdinal, isLabel, type Annotation } from '@ballastella/core';

export const shapeWord = (annotation: Annotation): string => {
	if (isLabel(annotation)) return 'label';
	switch (annotation.geometry?.type) {
		case 'Point':
			return 'pin';
		case 'LineString':
			return 'line';
		case 'Polygon':
			return 'shape';
		case 'Circle':
			return 'circle';
		default:
			return 'Annotation';
	}
};

// The same ordinal the row and the map mark draw.
export const annotationName = (annotation: Annotation, index: number): string => {
	const title = annotation.properties.title;
	if (title !== undefined && title !== '') return title;
	return `Untitled ${shapeWord(annotation)} ${annotationOrdinal(index)}`;
};
