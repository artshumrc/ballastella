// A piece of scholarly content a user places on the map (CONTEXT.md, Annotation).
//
// One GeoJSON `FeatureCollection` per Annotation Layer, at `annotations/<layer-id>.geojson`, with
// `properties` following **simplestyle-spec 1.1.0** plus ADR-0009's one extension. That is what
// makes the portability claim true rather than aspirational: a Layer dropped into geojson.io,
// committed to a GitHub repository, or opened in desktop GIS renders with its titles and colours
// intact, with no work from us.
//
// **CONTEXT.md lists "feature" and "marker" under the words to avoid for an Annotation**, and
// CONTRIBUTING makes that binding on code as well as on the UI. GeoJSON's own vocabulary — `Feature`,
// `FeatureCollection` — is confined to `geojson.ts`, which is the module that reads and writes the
// format, exactly as `georeference-annotation.ts` is the only module permitted "Georeference
// Annotation". Note those are different things entirely: a Georeference Annotation is the IIIF
// document an *Alignment* serialises to, and conflating the two would confuse every later reader.
//
// Free of everything editor-only, because `apps/viewer` draws Annotations too (ADR-0019).

import type { SimpleStyle } from '../project/layer.js';

/**
 * The geometry kinds a user can draw (SPEC stories 57, 58, and 59).
 *
 * `Point`, `LineString`, and `Polygon` only — a pin, a route, and a shape — which is the whole of
 * what the three drawing tools produce. The multi-part kinds are not offered, but a document that
 * arrives carrying one is not destroyed: see {@link ForeignGeometry}.
 */
export type DrawnGeometryType = 'Point' | 'LineString' | 'Polygon';

export interface PointGeometry {
	readonly type: 'Point';
	/** `[lng, lat]`, which is GeoJSON's order and the opposite of how a human says it. */
	readonly coordinates: readonly [number, number];
}

export interface LineStringGeometry {
	readonly type: 'LineString';
	readonly coordinates: readonly (readonly [number, number])[];
}

export interface PolygonGeometry {
	readonly type: 'Polygon';
	/** Rings. The first is the outer ring; this app draws exactly one, and carries any others. */
	readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

/**
 * A geometry this build does not draw, carried whole rather than interpreted.
 *
 * The same forward tolerance {@link import('../project/layer.js').ForeignLayer} gives the Layer
 * stack, and for the same reason: a `MultiPolygon` from QGIS, or a `GeometryCollection`, is a
 * geography somebody meant. It can be titled, described, styled, reordered, and deleted like
 * anything else, and it serialises back byte-identical — what it cannot be is *reshaped*, because
 * this app has no vertex editor for it.
 */
export interface ForeignGeometry {
	readonly type: 'foreign';
	/** The `type` the document carried, written back unchanged. */
	readonly declaredType: string;
	/** The whole geometry object as it arrived. */
	readonly raw: Readonly<Record<string, unknown>>;
}

/** An Annotation's shape on the earth, or `null` — which RFC 7946 permits and geojson.io writes. */
export type AnnotationGeometry =
	| PointGeometry
	| LineStringGeometry
	| PolygonGeometry
	| ForeignGeometry
	| null;

/**
 * What an Annotation says and how it looks.
 *
 * `title` and `description` are simplestyle's own content fields; everything else is
 * {@link SimpleStyle}, which ticket 09 already defined and which this module deliberately does not
 * redeclare. **Every field is optional and an absent one means "fall through"** rather than "use
 * zero": precedence runs Annotation `properties` → Layer `defaultStyle` → simplestyle's defaults
 * (ADR-0009), and stamping defaults onto everything at creation time would produce much larger files
 * that cannot be restyled in bulk.
 */
export interface AnnotationProperties extends SimpleStyle {
	readonly title?: string;
	/** **Markdown**, chosen for how it degrades (ADR-0009). Untrusted — see `markdown.ts`. */
	readonly description?: string;
	/** Anything else the record carried, kept so that writing it back cannot drop it. */
	readonly unknownProperties?: Readonly<Record<string, unknown>>;
}

/** One Annotation. */
export interface Annotation {
	/**
	 * Addresses this Annotation for the life of the document. Written as the GeoJSON `Feature`'s own
	 * `id`, which RFC 7946 §3.2 provides for exactly this, so it is portable rather than ours.
	 *
	 * Minted when a document arrives without one, because selecting, restyling, and deleting all need
	 * to name one Annotation out of many. That means a foreign id-less document gains `id` fields the
	 * first time it is written — see {@link import('./geojson.js').serialiseAnnotations} for why that
	 * is not a byte-identity problem in practice.
	 */
	readonly id: string;
	readonly geometry: AnnotationGeometry;
	readonly properties: AnnotationProperties;
	/** Anything else the `Feature` object carried, at its top level. */
	readonly unknownFields?: Readonly<Record<string, unknown>>;
}

/** One Annotation Layer's content: the whole `FeatureCollection`, in drawing order. */
export interface AnnotationCollection {
	readonly annotations: readonly Annotation[];
	/** Anything else the `FeatureCollection` object carried — `bbox`, `crs`, a `name`. */
	readonly unknownFields?: Readonly<Record<string, unknown>>;
}

/** An Annotation Layer with nothing in it. */
export const emptyCollection = (): AnnotationCollection => ({ annotations: [] });

// ---------------------------------------------------------------------------------------------
// simplestyle
// ---------------------------------------------------------------------------------------------

/**
 * simplestyle-spec 1.1.0's own defaults (ADR-0009), the last step of the precedence chain.
 *
 * The spec's literal values, so that a consumer which knows simplestyle and one which reads this
 * agree about what an absent property means. `marker-size` and `marker-symbol` have no default in
 * the spec and so have none here.
 */
export const SIMPLESTYLE_DEFAULTS = {
	'marker-color': '#7e7e7e',
	stroke: '#555555',
	'stroke-opacity': 1,
	'stroke-width': 2,
	fill: '#555555',
	'fill-opacity': 0.6
} as const;

/** Every property name simplestyle 1.1.0 defines, plus ADR-0009's one extension. */
export const SIMPLESTYLE_PROPERTIES: readonly string[] = [
	'title',
	'description',
	'marker-size',
	'marker-symbol',
	'marker-color',
	'stroke',
	'stroke-opacity',
	'stroke-width',
	'fill',
	'fill-opacity',
	'stroke-dasharray'
];

/** The three values simplestyle allows for `marker-size`. */
export const MARKER_SIZES: readonly string[] = ['small', 'medium', 'large'];

/**
 * A style with every value resolved: what a renderer paints with.
 *
 * `stroke-dasharray` stays optional, because **absent is the representation of solid** (ADR-0009) all
 * the way to the renderer. Resolving it to a tuple that happens to look continuous would lose the
 * distinction the file makes.
 */
export interface ResolvedStyle {
	readonly 'marker-size'?: string;
	readonly 'marker-symbol'?: string;
	readonly 'marker-color': string;
	readonly stroke: string;
	readonly 'stroke-opacity': number;
	readonly 'stroke-width': number;
	readonly fill: string;
	readonly 'fill-opacity': number;
	readonly 'stroke-dasharray'?: readonly [number, number];
}

/** `value` when it is not `undefined`, otherwise `fallback`. Precedence, one field at a time. */
const pick = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);

/**
 * One Annotation's effective style: **`properties` → Layer `defaultStyle` → simplestyle defaults**
 * (ADR-0009).
 *
 * Per property rather than per object, which is the whole of what "overrides" means here: an
 * Annotation that sets only `stroke` takes the Layer's `fill` and the spec's `stroke-width`. An
 * object-level fallback — "use the Layer's style if the Annotation has none" — would make setting one
 * colour silently discard every other value the Layer carried.
 *
 * The one place precedence is decided, so the editor and the published viewer cannot disagree about
 * what a file looks like.
 */
export function resolveStyle(
	properties: AnnotationProperties | undefined,
	layerDefault: SimpleStyle | undefined
): ResolvedStyle {
	const own = properties ?? {};
	const layer = layerDefault ?? {};
	const dash = pick(own['stroke-dasharray'], layer['stroke-dasharray']);
	const markerSize = pick(own['marker-size'], layer['marker-size']);
	const markerSymbol = pick(own['marker-symbol'], layer['marker-symbol']);
	return {
		'marker-color': pick(
			own['marker-color'],
			pick(layer['marker-color'], SIMPLESTYLE_DEFAULTS['marker-color'])
		),
		stroke: pick(own.stroke, pick(layer.stroke, SIMPLESTYLE_DEFAULTS.stroke)),
		'stroke-opacity': pick(
			own['stroke-opacity'],
			pick(layer['stroke-opacity'], SIMPLESTYLE_DEFAULTS['stroke-opacity'])
		),
		'stroke-width': pick(
			own['stroke-width'],
			pick(layer['stroke-width'], SIMPLESTYLE_DEFAULTS['stroke-width'])
		),
		fill: pick(own.fill, pick(layer.fill, SIMPLESTYLE_DEFAULTS.fill)),
		'fill-opacity': pick(
			own['fill-opacity'],
			pick(layer['fill-opacity'], SIMPLESTYLE_DEFAULTS['fill-opacity'])
		),
		// `exactOptionalPropertyTypes`: these three are absent rather than `undefined` when nothing in
		// the chain set them, because absent is what "solid" and "no symbol" mean.
		...(dash === undefined ? {} : { 'stroke-dasharray': dash }),
		...(markerSize === undefined ? {} : { 'marker-size': markerSize }),
		...(markerSymbol === undefined ? {} : { 'marker-symbol': markerSymbol })
	};
}

// ---------------------------------------------------------------------------------------------
// Line style
// ---------------------------------------------------------------------------------------------

/**
 * The user-facing line-style choice: exactly three options, so a certain route and a conjectural one
 * can be told apart (SPEC story 61).
 *
 * **A presentation concept, never a stored one.** The file holds the `stroke-dasharray` tuple —
 * intelligible to anything SVG-aware — and a keyword like `"dashed"` would be legible only to us
 * (ADR-0009). This type exists so the three-way control has something to be, and
 * {@link dashArrayFor} and {@link lineStyleOf} are the only translation between the two.
 */
export type LineStyle = 'solid' | 'dashed' | 'dotted';

/** `[dash, gap]` for a dashed line. */
export const DASHED_DASHARRAY: readonly [number, number] = [8, 4];

/** `[dash, gap]` for a dotted line. */
export const DOTTED_DASHARRAY: readonly [number, number] = [1, 3];

/**
 * The tuple to store for a line style, or `undefined` for solid.
 *
 * **Solid is the property being absent**, not `[0, 0]` and not `[1, 0]` (ADR-0009). `undefined` is
 * therefore the honest return, and every caller that writes a style has to decide to *remove* the
 * property rather than to set it to something.
 */
export function dashArrayFor(style: LineStyle): readonly [number, number] | undefined {
	switch (style) {
		case 'solid':
			return undefined;
		case 'dashed':
			return DASHED_DASHARRAY;
		case 'dotted':
			return DOTTED_DASHARRAY;
	}
}

/**
 * Which of the three options a stored `stroke-dasharray` is.
 *
 * A tuple that is neither of ours — `[4, 2, 1, 2]` from some other tool, or `[3, 3]` — reads as
 * `'dashed'`, because the control has three positions and a dashed line is what it is. It is
 * classified rather than rewritten: the stored tuple is left exactly as it arrived unless the user
 * picks a different option, so opening somebody's file and looking at it changes nothing (ADR-0010).
 */
export function lineStyleOf(dash: readonly number[] | undefined): LineStyle {
	if (dash === undefined || dash.length === 0) return 'solid';
	const [on, off] = dash;
	if (on === undefined || off === undefined) return 'solid';
	if (on === DOTTED_DASHARRAY[0] && off === DOTTED_DASHARRAY[1]) return 'dotted';
	return 'dashed';
}

// ---------------------------------------------------------------------------------------------
// Editing a collection
// ---------------------------------------------------------------------------------------------

/** The Annotation with this id, or `undefined`. */
export function findAnnotation(
	collection: AnnotationCollection,
	id: string
): Annotation | undefined {
	return collection.annotations.find((annotation) => annotation.id === id);
}

/**
 * A new Annotation, **carrying no style properties at all**.
 *
 * That absence is a criterion rather than an omission: precedence means a Layer's `defaultStyle`
 * reaches an Annotation that says nothing, so an Annotation created with default styling must have
 * nothing in its `properties` — otherwise restyling a Layer in bulk stops working the moment
 * anything is drawn into it, and every file is several times larger for no gain (ADR-0009).
 */
export function newAnnotation(fields: {
	id: string;
	geometry: AnnotationGeometry;
	title?: string;
}): Annotation {
	return {
		id: fields.id,
		geometry: fields.geometry,
		properties: fields.title === undefined || fields.title === '' ? {} : { title: fields.title }
	};
}

/** Put an Annotation at the end of the collection, where a newly drawn one belongs. */
export function addAnnotation(
	collection: AnnotationCollection,
	annotation: Annotation
): AnnotationCollection {
	return { ...collection, annotations: [...collection.annotations, annotation] };
}

/** Take an Annotation out (SPEC story 66). */
export function removeAnnotation(
	collection: AnnotationCollection,
	id: string
): AnnotationCollection {
	const annotations = collection.annotations.filter((annotation) => annotation.id !== id);
	// The collection itself when nothing matched, so a caller can tell a no-op by identity and not
	// write an unchanged document — the same discipline `layer.ts` uses, and what keeps an untouched
	// `annotations/*.geojson` byte-identical.
	return annotations.length === collection.annotations.length
		? collection
		: { ...collection, annotations };
}

/** `collection` with `change` applied to the one Annotation with this id. */
function replace(
	collection: AnnotationCollection,
	id: string,
	change: (annotation: Annotation) => Annotation
): AnnotationCollection {
	let changed = false;
	const annotations = collection.annotations.map((annotation) => {
		if (annotation.id !== id) return annotation;
		const next = change(annotation);
		if (next !== annotation) changed = true;
		return next;
	});
	return changed ? { ...collection, annotations } : collection;
}

/**
 * Reshape an Annotation (SPEC story 60).
 *
 * Called **once per gesture**, on gesture end, which is ADR-0017 rule 1 — not once per vertex and
 * not once per pointer-move.
 */
export function setGeometry(
	collection: AnnotationCollection,
	id: string,
	geometry: AnnotationGeometry
): AnnotationCollection {
	return replace(collection, id, (annotation) => ({ ...annotation, geometry }));
}

/**
 * Set or clear `title` and `description` (SPEC stories 62 and 67).
 *
 * An empty string **removes** the property rather than writing `""`. A title nobody typed should not
 * be a field in a portable document, and `{"title": ""}` in geojson.io is an empty label where no
 * label was meant.
 */
export function setText(
	collection: AnnotationCollection,
	id: string,
	text: { title?: string; description?: string }
): AnnotationCollection {
	return replace(collection, id, (annotation) => {
		let properties = annotation.properties;
		if (text.title !== undefined) properties = withProperty(properties, 'title', text.title);
		if (text.description !== undefined) {
			properties = withProperty(properties, 'description', text.description);
		}
		return properties === annotation.properties ? annotation : { ...annotation, properties };
	});
}

/** `properties` with one key set, or removed when the value is `undefined` or an empty string. */
function withProperty(
	properties: AnnotationProperties,
	key: string,
	value: unknown
): AnnotationProperties {
	const remove = value === undefined || value === '';
	const current = (properties as Record<string, unknown>)[key];
	if (remove && !(key in properties)) return properties;
	if (!remove && current === value) return properties;
	const next: Record<string, unknown> = { ...properties };
	if (remove) delete next[key];
	else next[key] = value;
	return next as AnnotationProperties;
}

/**
 * Set one Annotation's style properties, by their **exact simplestyle names** (SPEC stories 63–65).
 *
 * A key whose value is `undefined` is **removed**, which is how "back to the Layer's default" is
 * expressed and how solid is stored: there is no sentinel meaning "no dash", there is the absence of
 * `stroke-dasharray` (ADR-0009).
 */
export function setStyle(
	collection: AnnotationCollection,
	id: string,
	style: Readonly<Record<string, unknown>>
): AnnotationCollection {
	return replace(collection, id, (annotation) => {
		let properties = annotation.properties;
		for (const [key, value] of Object.entries(style)) {
			properties = withProperty(properties, key, value);
		}
		return properties === annotation.properties ? annotation : { ...annotation, properties };
	});
}

/** Set one Annotation's line style, storing the tuple and never a keyword (ADR-0009). */
export function setLineStyle(
	collection: AnnotationCollection,
	id: string,
	line: LineStyle
): AnnotationCollection {
	return setStyle(collection, id, { 'stroke-dasharray': dashArrayFor(line) });
}

// ---------------------------------------------------------------------------------------------
// Conformance
// ---------------------------------------------------------------------------------------------

const isHexColour = (value: unknown): boolean =>
	typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);

const isFraction = (value: unknown): boolean =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Every way one Annotation's `properties` departs from simplestyle-spec 1.1.0, in words.
 *
 * The portability claim in prose is that a file opens correctly in other tools; this is that claim
 * made checkable. It is a **test and review instrument, not a gate**: nothing in the app refuses to
 * draw a non-conforming Annotation, because a file somebody else wrote is not ours to reject, and
 * `parseAnnotations` carries what it cannot interpret. What this catches is *our own* controls
 * writing `strokeWidth`, or `"0.5"` where a number belongs, or `stroke` overloaded to hold a line
 * style — which ADR-0009 warns about by name.
 *
 * @returns `[]` when the properties conform
 */
export function simpleStyleViolations(properties: AnnotationProperties): string[] {
	const raw = properties as Record<string, unknown>;
	const problems: string[] = [];

	const wrongType = (key: string, expected: string) =>
		problems.push(`${key} should be ${expected}, and is ${JSON.stringify(raw[key])}`);

	if ('title' in raw && typeof raw['title'] !== 'string') wrongType('title', 'a string');
	if ('description' in raw && typeof raw['description'] !== 'string') {
		wrongType('description', 'a string');
	}
	if ('marker-size' in raw && !MARKER_SIZES.includes(raw['marker-size'] as string)) {
		wrongType('marker-size', 'small, medium, or large');
	}
	if ('marker-symbol' in raw && !/^([0-9]|[a-z]|[\w-]{2,})$/.test(String(raw['marker-symbol']))) {
		wrongType('marker-symbol', 'an icon id, 0–9, or a–z');
	}
	for (const key of ['marker-color', 'stroke', 'fill']) {
		if (key in raw && !isHexColour(raw[key])) wrongType(key, 'a #RRGGBB colour');
	}
	for (const key of ['stroke-opacity', 'fill-opacity']) {
		if (key in raw && !isFraction(raw[key])) wrongType(key, 'a number from 0.0 to 1.0');
	}
	if ('stroke-width' in raw) {
		const width = raw['stroke-width'];
		if (typeof width !== 'number' || !Number.isFinite(width) || width < 0) {
			wrongType('stroke-width', 'a number ≥ 0');
		}
	}
	if ('stroke-dasharray' in raw) {
		const dash = raw['stroke-dasharray'];
		const ok =
			Array.isArray(dash) &&
			dash.length === 2 &&
			dash.every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0);
		// The extension's whole point is that it is a tuple. A keyword here is the mistake ADR-0009
		// names, so it is worth saying so rather than reporting a generic type error.
		if (!ok) wrongType('stroke-dasharray', 'a [dash, gap] tuple of two numbers, never a keyword');
	}

	// Not an error, and deliberately not reported as one: `unknownProperties` is how a property from
	// another tool survives a round trip. What would be an error is one of *our* controls writing a
	// name that is not simplestyle's, and that shows up as the name being absent from the properties
	// this function was given rather than as something to find here.
	return problems;
}
