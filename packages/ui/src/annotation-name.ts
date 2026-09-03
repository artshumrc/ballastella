// What one Annotation is called, wherever it is named.
//
// **One Annotation has one name.** The row's button and what the row reveals sit a few pixels apart,
// so a second piece of wording invented in either of them is two names for one thing on one screen —
// which is what happened: the button said "Untitled pin 3" and the panel under it said "Untitled".

import { annotationOrdinal, isLabel, type Annotation } from '@ballastella/core';

/**
 * What this Annotation is called in prose, and beside its name in the row.
 *
 * A question about the **Annotation** rather than about its geometry, because a Label and a Pin are
 * both Points and are not both pins. `isLabel` is `core`'s and is read here and in the glyph lookup
 * beside it, so the word and the icon cannot disagree.
 */
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

/**
 * This Annotation's title, or what an untitled one is called instead.
 *
 * `index` is its place in the **collection**, counted from zero, rather than its place in whatever is
 * on screen: the one Annotation shown on its own under the drawing tools must read as the same
 * "Untitled pin 3" it reads as in the list a moment later.
 *
 * The number in that fallback is `annotationOrdinal`'s, which is the same number the row draws beside
 * the name and the same number the mark draws on the map — so "Untitled pin 3" and the 3 on the pin
 * are one fact rather than two counts that agree until somebody changes one of them.
 *
 * ⚠ **The title is the user's own words and therefore untrusted text.** It is safe for a different
 * reason from the rendered description beside it: every caller interpolates this return value, so the
 * DOM never parses it as markup. Nothing may put it through `{@html}`; a title that needs rendering
 * is one that needs core's sanitiser.
 */
export const annotationName = (annotation: Annotation, index: number): string => {
	const title = annotation.properties.title;
	if (title !== undefined && title !== '') return title;
	return `Untitled ${shapeWord(annotation)} ${annotationOrdinal(index)}`;
};
