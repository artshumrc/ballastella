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
	PointGeometry | LineStringGeometry | PolygonGeometry | ForeignGeometry | null;

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
 * What a Point's `marker-symbol` says when the marker shows its own words.
 *
 * simplestyle's `marker-symbol` is *what this marker shows at its point*, and `"label"` is a reading
 * of that field rather than an overload of it: the value is already legal against
 * {@link simpleStyleViolations}, so a Layer of Labels is conformant with nothing relaxed and opens in
 * another tool as titled markers. See `.tracker/write-on-the-map/SPEC.md` for why this rather than an
 * extension of ours.
 */
export const LABEL_MARKER_SYMBOL = 'label';

/**
 * Whether a bare properties bag says "Label" — for a GeoJSON feature, which is not an Annotation.
 *
 * The renderer works on render copies of features and has no Annotation to hand; this is what it reads
 * instead of the literal, so that {@link LABEL_MARKER_SYMBOL} still ties every reading of the
 * discriminator together. Says nothing about the geometry, because a properties bag has none: callers
 * that hold one check it themselves, as {@link isLabel} does.
 */
export const isLabelFeature = (
	properties: { 'marker-symbol'?: unknown } | null | undefined
): boolean => properties?.['marker-symbol'] === LABEL_MARKER_SYMBOL;

/**
 * Whether this Annotation is a Label: a Point that draws its `title` on the map.
 *
 * ⚠ **The one place the discriminator is read.** Nothing else compares `marker-symbol` to a string
 * literal — with the single exception of the renderer's filter expressions, because a MapLibre filter
 * is data rather than a function call and cannot call this. {@link isLabelFeature} is the same reading
 * for a caller holding only a feature's properties.
 */
export const isLabel = (annotation: Annotation): boolean =>
	annotation.geometry?.type === 'Point' && isLabelFeature(annotation.properties);

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE NINE COLOURS AN ANNOTATION CAN BE
 *
 * **Nine literal hex values, and they are deliberately not theme tokens.** Every other colour in this
 * project comes from daisyUI so that a retheme moves it (ADR-0016, ADR-0020); this one must not. A
 * colour here is *written into the Annotation's own `properties`* and travels in the GeoJSON — it is
 * content a scholar chose, in a portability document another tool will read (ADR-0002, ADR-0009). A
 * value that followed the interface's theme would mean one thing in this app and something else in
 * QGIS, and a Project would change colour because a reader flipped to dark mode. So these are
 * constants, and this is the one place in the codebase where a hard-coded colour is correct.
 *
 * **Why a fixed palette at all.** simplestyle permits any `#RRGGBB`, and a native colour well offers
 * all sixteen million of them — which asks a historian to be a designer, and produces Projects where
 * nine routes are nine indistinguishable near-reds. Nine nameable colours are a vocabulary: they can
 * be said out loud over a student's shoulder ("the blue route"), and ADR-0022 already treats *being
 * sayable* as a design criterion.
 *
 * **The order is the palette's meaning**, so keep it: the editor draws these in one row of three
 * groups of three, which makes the first group the neutrals, the second the warm colours and the third
 * the cool ones. A scholar looking for "a grey" or "something warm" finds it by position instead of
 * reading nine labels. Adding a tenth would cost that, which is a real reason to think twice rather
 * than a decoration.
 *
 * **Grey is `#555555` on purpose**: it is simplestyle's own default for `stroke` and `fill`, so an
 * Annotation drawn with default styling is already sitting on a swatch rather than reporting a colour
 * the user was never offered. `styleForNewAnnotation` writes it explicitly for the same reason — see
 * the note there about the pin, whose spec default is a *different* grey.
 *
 * Names are plain and lowercase-hex, because the name is what reaches a screen reader and the hex is
 * what a `value` comparison sees — an `<input type="color">` normalises to lowercase, and half of this
 * palette's job is being comparable to what is already in a file.
 */
export const ANNOTATION_COLORS: readonly { readonly name: string; readonly value: string }[] = [
	{ name: 'Black', value: '#000000' },
	{ name: 'Grey', value: '#555555' },
	{ name: 'White', value: '#ffffff' },
	{ name: 'Red', value: '#d32f2f' },
	{ name: 'Orange', value: '#ef6c00' },
	{ name: 'Yellow', value: '#fbc02d' },
	{ name: 'Green', value: '#388e3c' },
	{ name: 'Blue', value: '#1976d2' },
	{ name: 'Purple', value: '#7b1fa2' }
];

/**
 * The colour a newly drawn Annotation is given when the Layer has nothing to copy from.
 *
 * Grey, which is both the palette's neutral and simplestyle's own default for a line and a fill — so
 * this changes what a new Annotation *says* rather than how the first one looks.
 */
export const DEFAULT_ANNOTATION_COLOR = '#555555';

/**
 * What this colour is called, or `null` if it is not one of the nine.
 *
 * `null` is a real answer rather than a failure: a file written by another tool, or by a future version
 * of this one, may carry any `#RRGGBB` (ADR-0009 validates the *format*, never the value), and the
 * editor has to be able to say "the colour this Annotation has is not one of the nine" instead of
 * silently drawing it as the nearest one.
 *
 * Case-insensitive, because `#FFFFFF` and `#ffffff` are the same colour and only one of them is what a
 * browser's colour input produces.
 */
export function annotationColorName(value: string): string | null {
	const wanted = value.toLowerCase();
	return ANNOTATION_COLORS.find((colour) => colour.value === wanted)?.name ?? null;
}

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
 * One Annotation's effective style: **its own `properties` → simplestyle's defaults** (ADR-0009, as
 * amended).
 *
 * **One level of fallback, where there used to be two.** A Layer carried a `defaultStyle` that sat
 * between these, and it is gone: an Annotation's style is now written onto the Annotation when it is
 * drawn, copied from the last one drawn in that Layer, so "everything in this Layer is blue" is a
 * fact about each Annotation rather than an inheritance a reader has to be told about. The amendment
 * in ADR-0009 records why that trade was taken and what it cost.
 *
 * Still per property rather than per object: an Annotation that sets only `stroke` takes the spec's
 * `stroke-width` rather than losing it.
 *
 * The one place a style is resolved, so the editor and the published viewer cannot disagree about
 * what a file looks like.
 */
export function resolveStyle(properties: AnnotationProperties | undefined): ResolvedStyle {
	const own = properties ?? {};
	const dash = own['stroke-dasharray'];
	const markerSize = own['marker-size'];
	const markerSymbol = own['marker-symbol'];
	return {
		'marker-color': pick(own['marker-color'], SIMPLESTYLE_DEFAULTS['marker-color']),
		stroke: pick(own.stroke, SIMPLESTYLE_DEFAULTS.stroke),
		'stroke-opacity': pick(own['stroke-opacity'], SIMPLESTYLE_DEFAULTS['stroke-opacity']),
		'stroke-width': pick(own['stroke-width'], SIMPLESTYLE_DEFAULTS['stroke-width']),
		fill: pick(own.fill, SIMPLESTYLE_DEFAULTS.fill),
		'fill-opacity': pick(own['fill-opacity'], SIMPLESTYLE_DEFAULTS['fill-opacity']),
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

/**
 * `style` with one of the three line styles applied — **the one place solid is written as an absence**.
 *
 * Every control that offers the three-way choice goes through this: the per-Annotation one in the
 * editor, through {@link setLineStyle}, and the Layer's own `defaultStyle`, which is a plain
 * {@link SimpleStyle} with no collection around it. Both had the rule spelled out where they stood —
 * "delete the property rather than setting something continuous" — which is two places to remember a
 * rule ADR-0009 states once, and the second one is where a `[0, 0]` eventually gets written.
 *
 * The style itself is returned when nothing changed, so a caller can tell a no-op by identity and not
 * write a file that says the same thing.
 */
export function withLineStyle<Style extends SimpleStyle>(style: Style, line: LineStyle): Style {
	return withProperty(style, 'stroke-dasharray', dashArrayFor(line));
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
	/** What it is drawn with — see {@link styleForNewAnnotation}. */
	style?: SimpleStyle;
}): Annotation {
	return {
		id: fields.id,
		geometry: fields.geometry,
		properties: {
			...(fields.style ?? {}),
			...(fields.title === undefined || fields.title === '' ? {} : { title: fields.title })
		}
	};
}

/**
 * The style property names a newly drawn Annotation inherits, so style can be told from content.
 *
 * ⚠ **`marker-symbol` is deliberately not among them** — see {@link styleForNewAnnotation}.
 */
const INHERITED_STYLE_NAMES = [
	'marker-size',
	'marker-color',
	'stroke',
	'stroke-opacity',
	'stroke-width',
	'fill',
	'fill-opacity',
	'stroke-dasharray'
] as const satisfies readonly (keyof SimpleStyle)[];

/**
 * The style a newly drawn Annotation should carry: **the last one drawn in this Layer**.
 *
 * This is what replaced a Layer's `defaultStyle` (ADR-0009, as amended). A scholar who makes every
 * conjectural route in a Layer dashed does it by drawing one dashed and then drawing; nothing is
 * named "default", nothing is inherited, and the file says plainly what each Annotation is drawn
 * with. The cost is recorded in the ADR: style repeats per feature, and there is no longer a way to
 * restyle a whole Layer in one action.
 *
 * **Style only** — `title`, `description`, and anything unknown the last Annotation carried stay
 * with it. Copying a stranger's prose onto the next shape a user draws would be a content bug
 * wearing a styling change's clothes.
 *
 * The *last* rather than the selected one, because "the most recent choice" is what a user is
 * reaching for: draw a blue pin, draw another, and it is blue. Restyling an older Annotation does
 * not change what the next one starts as, which is the one case where this and "the most recent
 * choice I made" part company.
 *
 * **The first Annotation in a Layer starts on the palette's grey**, explicitly, rather than carrying no
 * colour and leaning on simplestyle's defaults. Those defaults are two *different* greys — `#555555`
 * for a line and a fill, `#7e7e7e` for a pin — so a fresh pin was the one shape in the app whose colour
 * was not among the nine a scholar is offered, and the editor would have had to report a colour nobody
 * chose. Writing it costs three properties in the file, which is the trade ADR-0009's amendment already
 * took when it moved style onto each Annotation; the value is `DEFAULT_ANNOTATION_COLOR`, so the file
 * and the swatch cannot drift apart.
 *
 * Only the colours are defaulted. `stroke-width`, the opacities and `marker-size` stay absent, because
 * simplestyle has one default for each of those and nothing here contradicts it — writing them would be
 * bytes that say what the spec already says.
 *
 * ⚠ **`marker-symbol` is not inherited, because it says what kind of thing this is rather than how it
 * looks.** It is the discriminator that makes a Point a Label, so copying it would mean that drawing a
 * Pin straight after a Label produced a second Label — the tool the author chose overridden by the
 * previous Annotation's style. The creation path writes it instead: the Label tool writes
 * {@link LABEL_MARKER_SYMBOL} (see {@link styleForNewLabel}), every other tool writes nothing.
 * Colour, size and opacity keep inheriting across kinds, which is the rule ADR-0009's amendment chose.
 *
 * The accepted consequence: a `marker-symbol` from another tool (`"harbor"`, `"7"`) is no longer copied
 * onto the next Annotation drawn. It stays on the Annotation that has it and is still written back
 * untouched (SPEC story 51).
 */
export function styleForNewAnnotation(
	collection: AnnotationCollection | null | undefined
): SimpleStyle {
	const last = collection?.annotations.at(-1);
	if (last === undefined) {
		return {
			'marker-color': DEFAULT_ANNOTATION_COLOR,
			stroke: DEFAULT_ANNOTATION_COLOR,
			fill: DEFAULT_ANNOTATION_COLOR
		};
	}
	const style: Record<string, unknown> = {};
	for (const name of INHERITED_STYLE_NAMES) {
		const value = last.properties[name];
		if (value !== undefined) style[name] = value;
	}
	return style as SimpleStyle;
}

/**
 * What a Label starts on when there is no previous Annotation to inherit colours from: black words on
 * a white chip.
 *
 * Both are among the nine colours a scholar is offered ({@link ANNOTATION_COLORS}), so the Style face
 * has a swatch to report and the file says a colour that exists in the interface. Black on white is
 * also the pair that survives the compositing a chip actually gets — the background paints at
 * `fill-opacity`, 0.6 by default, over whatever is beneath it, so the worst case is a pale chip over a
 * dark Map Image and black words still read on it.
 *
 * A constant chosen once, never a computation: see {@link styleForNewLabel} for why no colour
 * arithmetic happens here.
 */
const DEFAULT_LABEL_COLORS = {
	'marker-color': '#000000',
	fill: '#ffffff'
} as const satisfies Pick<SimpleStyle, 'marker-color' | 'fill'>;

/**
 * The style a newly drawn **Label** should carry: {@link styleForNewAnnotation}'s, plus the
 * discriminator — and, in exactly one case, a legible pair of colours instead of two identical greys.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * **The one case.** A Label's words are `marker-color` and its background is `fill`.
 * {@link styleForNewAnnotation} writes {@link DEFAULT_ANNOTATION_COLOR} into *both* when a Layer holds
 * nothing to copy from, so the first Label drawn into a fresh Layer would be `#555555` words on a
 * `#555555` chip: placed, present in the file, and unreadable.
 *
 * That untouched default is the whole of the defect, so it is the whole of the rule: a Label whose
 * inherited `marker-color` **and** `fill` are both exactly `DEFAULT_ANNOTATION_COLOR` starts on
 * {@link DEFAULT_LABEL_COLORS} instead. Everything else inherits untouched — a scholar who set one
 * colour for both on purpose keeps it, and a Label with `fill-opacity: 0` keeps the words it was given
 * (SPEC story 25: white words straight on a dark Map Image).
 *
 * **No colour arithmetic, deliberately.** The rejected alternative measured the background's perceived
 * brightness and substituted black or white whenever the two colours agreed, and every part of it was
 * wrong: it read a background that `fill-opacity: 0` means nothing paints; it mis-parsed the 3-digit
 * hex any geojson.io-authored Layer may carry (`#fff` measured dark, so the words went white on white);
 * it measured the raw hex rather than what the chip composites to; and its threshold picked the
 * *lower*-contrast of the two for some of the nine. The only value compared here is a constant of ours,
 * which is also why a `fill` that is not a string — a foreign document's `4`, `true` or `["#fff"]`,
 * which `readProperties` carries untouched — cannot make this throw.
 */
export function styleForNewLabel(collection: AnnotationCollection | null | undefined): SimpleStyle {
	const inherited = styleForNewAnnotation(collection);
	const untouchedDefault =
		inherited['marker-color'] === DEFAULT_ANNOTATION_COLOR &&
		inherited.fill === DEFAULT_ANNOTATION_COLOR;
	return {
		...inherited,
		...(untouchedDefault ? DEFAULT_LABEL_COLORS : {}),
		'marker-symbol': LABEL_MARKER_SYMBOL
	};
}

/**
 * Where an Annotation's popup should point: **the middle of the shape**, not wherever the pointer
 * landed on it.
 *
 * A popup placed at the click follows the cursor around a long coastline, so the same Annotation
 * opened twice appears in two places and nothing on screen says which shape the words belong to. The
 * middle is stable — open it from the map, from the list, or from a keyboard, and it is in the same
 * place — and it is what "this popup is about *that* shape" reads as.
 *
 * A Point is its own coordinate. A line and a shape use the centre of their bounding box rather than
 * a true centroid: a centroid is more work, is outside the shape for a crescent or a horseshoe
 * anyway, and this is a place to hang a label rather than a measurement.
 *
 * `null` for a geometry this build cannot draw, and for an empty one — the caller falls back to
 * where the reader clicked, which is the only thing left that is true.
 */
export function annotationAnchor(annotation: Annotation): { lng: number; lat: number } | null {
	const geometry = annotation.geometry;
	if (geometry === null || geometry.type === 'foreign') return null;
	const points: readonly (readonly [number, number])[] =
		geometry.type === 'Point'
			? [geometry.coordinates]
			: geometry.type === 'LineString'
				? geometry.coordinates
				: (geometry.coordinates[0] ?? []);
	if (points.length === 0) return null;

	let west = Infinity;
	let east = -Infinity;
	let south = Infinity;
	let north = -Infinity;
	for (const [lng, lat] of points) {
		west = Math.min(west, lng);
		east = Math.max(east, lng);
		south = Math.min(south, lat);
		north = Math.max(north, lat);
	}
	return { lng: (west + east) / 2, lat: (south + north) / 2 };
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

/**
 * Put an Annotation back at `index` — the undo of {@link removeAnnotation} (ticket 11).
 *
 * Not {@link addAnnotation}, which appends: the order of a `FeatureCollection` is the order things
 * draw in, so restoring a deleted Annotation at the end would move it above shapes it was under.
 * Out-of-range indices are clamped.
 *
 * Refused, by returning the collection it was given, when an Annotation with this id is already
 * there — an id addresses one Annotation for the life of the document, and two of them would make
 * selecting, restyling, and deleting ambiguous.
 */
export function insertAnnotationAt(
	collection: AnnotationCollection,
	annotation: Annotation,
	index: number
): AnnotationCollection {
	if (collection.annotations.some((other) => other.id === annotation.id)) return collection;
	const at = Math.min(collection.annotations.length, Math.max(0, index));
	return {
		...collection,
		annotations: [
			...collection.annotations.slice(0, at),
			annotation,
			...collection.annotations.slice(at)
		]
	};
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

/**
 * `properties` with one key set, or removed when the value is `undefined` or an empty string.
 *
 * Generic over the style object, because a Layer's `defaultStyle` is a bare {@link SimpleStyle} and
 * takes the same rule as an Annotation's own `properties` — see {@link withLineStyle}. Returns what it
 * was given when nothing changed, which is how an untouched file stays byte-identical.
 */
function withProperty<Style extends SimpleStyle>(
	properties: Style,
	key: string,
	value: unknown
): Style {
	const remove = value === undefined || value === '';
	const raw = properties as Record<string, unknown>;
	if (remove && !(key in properties)) return properties;
	if (!remove && raw[key] === value) return properties;
	const next: Record<string, unknown> = { ...raw };
	if (remove) delete next[key];
	else next[key] = value;
	return next as Style;
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
	return replace(collection, id, (annotation) => {
		const properties = withLineStyle(annotation.properties, line);
		return properties === annotation.properties ? annotation : { ...annotation, properties };
	});
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
