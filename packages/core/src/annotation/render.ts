// An Annotation Layer as a renderer takes it: every style value already resolved.
//
// In `core` rather than in the editor because the Published Site draws the same Annotations with the
// same precedence, and precedence computed in two places is two answers that agree until
// somebody edits one of them (ADR-0019).
//
// **The shape of this module is decided by one MapLibre fact**: `line-dasharray` is not a
// data-driven paint property. Colour, width, and opacity can all be `['get', 'stroke']` and vary per
// Annotation inside one layer; a dash pattern cannot. So the dash has to become a *filter* — one line
// layer per pattern — and that needs a property to filter on. Resolving the whole style onto a render
// copy answers both needs at once: the paint expressions become plain `get`s with no `coalesce`
// chains duplicating the precedence rules, and the dash bucket is one more resolved field.
//
// Nothing here is ever written to disk. `serialiseAnnotations` writes the domain collection, whose
// `properties` hold only what the user actually set — which is the criterion that an Annotation
// created with default styling carries **no** style properties in the file (ADR-0009).

import {
	SIMPLESTYLE_DEFAULTS,
	lineStyleOf,
	resolveStyle,
	type AnnotationCollection,
	type LineStyle
} from './annotation.js';

/**
 * The render-copy property holding which of the three line styles an Annotation is.
 *
 * Namespaced, and the prefix is the point: this is a private convention that exists for the length of
 * one MapLibre filter expression, and a bare name like `line-style` in a `properties` object is
 * indistinguishable from something simplestyle defines. **It never reaches a file** — see the module
 * comment.
 */
export const LINE_STYLE_PROPERTY = 'ballastella:line-style';

/**
 * The render-copy property holding the Annotation's id, so that a click on the map can be traced back
 * to the Annotation it hit.
 *
 * A GeoJSON `Feature`'s own `id` would seem to be the obvious answer and is not: MapLibre requires a
 * feature id to be an integer or a string coercible to one for feature-state to work, and it drops or
 * mangles a UUID. Carrying the id in `properties` is what `queryRenderedFeatures` can be relied on to
 * hand back.
 */
export const ANNOTATION_ID_PROPERTY = 'ballastella:id';

/** The three line styles, in the order the control offers them. */
export const LINE_STYLES: readonly LineStyle[] = ['solid', 'dashed', 'dotted'];

/**
 * `collection` with every Annotation's style resolved against the Layer's default and simplestyle's
 * defaults, ready to hand to a GeoJSON source.
 *
 * `title` and `description` are carried through **unrendered**: they are the untrusted text, and
 * turning a description into HTML here would put markup into a map source and into whatever a
 * renderer chooses to do with a property. Rendering happens in `markdown.ts`, at the moment a popup
 * is built, and nowhere else.
 */
export function toRenderCollection(collection: AnnotationCollection): {
	type: 'FeatureCollection';
	features: Record<string, unknown>[];
} {
	return {
		type: 'FeatureCollection',
		features: collection.annotations.flatMap((annotation) => {
			const geometry = annotation.geometry;
			// A geometry this build cannot draw is absent from the render copy rather than handed over
			// malformed. It is still in the document, still listed, still editable as text, and still
			// written back intact — it simply has nothing to paint.
			if (geometry === null || geometry.type === 'foreign') return [];
			const style = resolveStyle(annotation.properties);
			return [
				{
					type: 'Feature',
					geometry: {
						type: geometry.type === 'Circle' ? 'Polygon' : geometry.type,
						coordinates: geometry.coordinates
					},
					properties: {
						...style,
						[ANNOTATION_ID_PROPERTY]: annotation.id,
						[LINE_STYLE_PROPERTY]: lineStyleOf(style['stroke-dasharray']),
						...(annotation.properties.title === undefined
							? {}
							: { title: annotation.properties.title }),
						...(annotation.properties.description === undefined
							? {}
							: { description: annotation.properties.description })
					}
				}
			];
		})
	};
}

/**
 * The `line-dasharray` for one bucket, in MapLibre's line-width units.
 *
 * MapLibre expresses a dash array as a multiple of the line's own width, whereas SVG — and therefore
 * `stroke-dasharray` — expresses it in the same units as the width itself. So a stored `[8, 4]` is 8px
 * on and 4px off at simplestyle's own default width of 2, which MapLibre needs as `[4, 2]`. That
 * default is the width the bucket is expressed against, and it is the whole of the conversion.
 *
 * **The pattern therefore scales with the line's width, and the stored lengths are not what is
 * drawn.** `line-dasharray` is the one paint property MapLibre will not evaluate per feature — which is
 * why there is a layer per pattern at all — while `line-width` is `['get', 'stroke-width']` and
 * multiplies it. A dashed Annotation drawn at width 6 draws 24px on and 12px off rather than the
 * stored 8 and 4. What survives is the *ratio*, which is what tells a dashed line from a dotted one at
 * any width; what does not survive is the absolute length. Honouring the file exactly would need a
 * bucket per (pattern × width), which is a MapLibre layer per half-step of a continuous slider — see
 * `stack-layers.ts` on what each of those costs per frame.
 */
export function mapLibreDashArray(dash: readonly [number, number]): [number, number] {
	const width = SIMPLESTYLE_DEFAULTS['stroke-width'];
	return [dash[0] / width, dash[1] / width];
}
