// Drawing a Project's Layer stack onto the Base Map.
//
// This is the half of ADR-0002 that is not a data model: the stack says what draws over what, and
// this is where that becomes MapLibre's own layer order. Adding runs bottom-to-top through
// `drawingOrder`, which is the one function that knows the list reads the other way — so the Layer at
// the top of the list is added last and therefore draws over the ones below it, **including across
// kinds**: an Annotation Layer above a map Layer draws above it.
//
// A `kind: 'map'` Layer becomes a `WarpedMapLayer` reading its tiles through the ADR-0011 shim; an
// Annotation Layer becomes a GeoJSON source and the MapLibre layers its geometries need. Anything
// else — a kind this build has never heard of — is skipped and reported, which is ADR-0014's forward
// tolerance at the render boundary.
//
// **In `core` because both apps draw the same stack** (ADR-0019, and the same argument
// `annotation/render.ts` already makes for the style precedence this reads). The editor's Layers pane
// and the Published Site's Project view are the same picture with different controls beside it, and
// ADR-0002's cross-kind rule — an Annotation Layer above a map Layer draws above it — must have one
// implementation or the Reader eventually sees a different stack from the author.

import {
	DASHED_DASHARRAY,
	DOTTED_DASHARRAY,
	LABEL_MARKER_SYMBOL,
	isLabelFeature,
	type AnnotationCollection,
	type LineStyle
} from '../annotation/annotation.js';
import {
	LABEL_CHIP_CONTENT,
	LABEL_CHIP_IMAGE_ID,
	LABEL_CHIP_PADDING,
	LABEL_CHIP_PIXEL_RATIO,
	LABEL_CHIP_STRETCH,
	LABEL_TEXT_SIZE,
	labelChipImage
} from './label-chip.js';
import { PIN_ICON_SIZE, PIN_IMAGE_ID, PIN_PIXEL_RATIO, pinImage } from './pin-icon.js';
import {
	ANNOTATION_ID_PROPERTY,
	LINE_STYLES,
	LINE_STYLE_PROPERTY,
	mapLibreDashArray,
	toRenderCollection
} from '../annotation/render.js';
import type { Alignment } from '../alignment/alignment.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { drawingOrder, type AnnotationLayer, type MapLayer } from '../project/layer.js';
import type { WarpedMapLayer } from '@allmaps/maplibre';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { createWarpedMapLayer, showAlignment, type WarpedRender } from './warped-map-layer.js';

/**
 * One Layer of the stack with the documents it references already read.
 *
 * Resolved by the caller rather than here, because reaching the store is `EditorSession`'s business
 * and nothing else in the app talks to `@ballastella/core`'s storage layer. Only **visible** Layers
 * belong in this list; hiding one is its absence, not a flag.
 */
export interface DrawnMapLayer {
	readonly layer: MapLayer;
	readonly alignment: Alignment;
	/**
	 * The remote image service this Layer's tiles come from, or `''` for a local copy (ticket 14).
	 *
	 * Resolved by the caller from the Workspace's `remote.json` records, for the same reason the
	 * Alignment is: reaching the store is `EditorSession`'s business. A referenced Layer with `''` here
	 * draws nothing at all, so the caller observes whether the image is referenced — the image directory
	 * has an `info.json` of ours, or only a `remote.json` — and passes {@link referenced} with it.
	 */
	readonly service?: string;
	/**
	 * Whether this Layer's Map Image is served from somebody else's server, as observed from the
	 * files beside it in the Workspace (ADR-0023).
	 *
	 * Passed through to `showAlignment`, which refuses a referenced Layer with no address rather than
	 * drawing a blank one and reporting it drawn.
	 */
	readonly referenced?: boolean;
}

export interface DrawnAnnotationLayer {
	readonly layer: AnnotationLayer;
	/**
	 * The Layer's Annotations, or `null` when it has no file yet.
	 *
	 * The model rather than the raw parsed JSON ticket 09 passed, because the styling this draws with
	 * is resolved per Annotation and precedence is a property of the model (ADR-0009). It is also what
	 * the editing surface beside the map needs, so the document is read once for both.
	 */
	readonly annotations: AnnotationCollection | null;
}

export type DrawnLayer = DrawnMapLayer | DrawnAnnotationLayer;

/**
 * Whether this entry is an aligned Map Image.
 *
 * Narrowed on the field only a map entry has, rather than on a `kind` copied up from the Layer
 * inside: a second copy of the discriminator is a second thing that can disagree with the first, and
 * the Layer already carries the answer.
 */
export const isDrawnMap = (drawn: DrawnLayer): drawn is DrawnMapLayer => 'alignment' in drawn;

/** What became of one Layer of the stack, for the page to surface. */
export type DrawnOutcome =
	{ readonly status: 'drawn' } | { readonly status: 'refused'; readonly reason: string };

export interface StackRender {
	/**
	 * Keyed by Layer id. A Layer that is drawn but empty still counts as drawn.
	 *
	 * A plain record rather than a `Map`, because this crosses into Svelte components where a mutable
	 * `Map` is the wrong reactive primitive and the lint fence says so. Nothing here mutates it.
	 */
	readonly outcomes: Readonly<Record<string, DrawnOutcome>>;
	/**
	 * Set a map Layer's opacity in place.
	 *
	 * Separate from the build so that dragging the slider does not tear the stack down and refetch
	 * every tile — which is what a rebuild costs, and what would make a continuous gesture the most
	 * expensive thing in the application (ADR-0017 rule 1 is about exactly this shape).
	 */
	setOpacity(layerId: string, opacity: number): void;
	/**
	 * Replace an Annotation Layer's features in place.
	 *
	 * Separate from the build for the same reason as {@link setOpacity}, and for a sharper one: an
	 * Annotation's title is typed a character at a time, each keystroke writes the file, and each
	 * write hands the page a new collection. Rebuilding on that tore down and re-added **every layer
	 * in the stack**, Map Images included, once per keystroke — so typing a title made the whole
	 * map thrash and refetch tiles. Nothing about the *structure* changed; only the data in one
	 * source did, and this is that.
	 *
	 * What a rebuild is still for is a change of structure — the first dashed line in a Layer needs a
	 * layer that was not added — which is what {@link annotationDrawKey} exists to detect.
	 *
	 * A no-op for a Layer that is not drawn, or whose source has gone with a `setStyle`.
	 */
	setAnnotations(layerId: string, collection: AnnotationCollection): void;
	/**
	 * Say which Annotation is selected, so the map draws it more strongly (SPEC story 40).
	 *
	 * **A feature state and not a rebuilt layer**: the id is written onto the feature MapLibre already
	 * holds and the paint expressions below read it, so selecting costs one repaint rather than a
	 * source's worth of work. It is applied to every Annotation source, because an Annotation id is
	 * unique within its Layer's file and nothing guarantees two files disagree — a state set on a
	 * source that has no such feature is inert.
	 *
	 * `null` clears it. Nothing here is written to disk (ADR-0002): which Annotation is open is the
	 * screen's state, not the document's.
	 */
	setSelectedAnnotation(annotationId: string | null): void;
	/**
	 * Take the whole stack off the map. Survivable after a `setStyle` has already removed it.
	 *
	 * @param options.mapIsGone the **map itself** has been removed, not just its style. Then its layers
	 *   and sources went with it and it can no longer be asked about them at all: `Map#remove` deletes
	 *   the style, so `getLayer` — the guard this uses before removing anything — throws. The caller
	 *   knows this and MapLibre offers no supported way to ask, so it is passed in rather than detected.
	 *   Letting go of the browser-test handle still happens, because a handle on a dead map is worse
	 *   than none.
	 */
	destroy(options?: { mapIsGone?: boolean }): void;
}

/**
 * The MapLibre layer id for one of this stack's layers.
 *
 * Prefixed so that a stack layer can never collide with one of the Base Map style's own, and so
 * that the browser tests can ask MapLibre what order the stack ended up in — which is the question
 * "does this Layer draw above that one?" reduced to the mechanism that answers it.
 */
export const stackLayerId = (layerId: string, part = ''): string =>
	`ballastella-layer-${layerId}${part === '' ? '' : `-${part}`}`;

/**
 * How big a pin draws, by `marker-size`. simplestyle names three sizes and gives no pixel values, so
 * these are ours; the ratios are what matter.
 */
/**
 * Register the pin image on this map if it is not already there.
 *
 * Idempotent, and **re-run on every stack build on purpose**: a theme change calls `setStyle`, which
 * discards every image along with every layer, so an image registered once at startup would vanish
 * the first time somebody switched to dark and every pin would stop drawing.
 */
function ensurePinImage(map: MapLibreMap): boolean {
	if (map.hasImage(PIN_IMAGE_ID)) return true;
	const image = pinImage();
	if (image === null) return false;
	map.addImage(PIN_IMAGE_ID, image, { sdf: true, pixelRatio: PIN_PIXEL_RATIO });
	return true;
}

/**
 * Register the Label's chip on this map if it is not already there.
 *
 * Idempotent and re-run on every stack build, for {@link ensurePinImage}'s reason: a theme change
 * calls `setStyle` and discards every registered image.
 *
 * `content` and the stretch zones are what keep the corners' aspect while `icon-text-fit` grows the
 * chip to the words, and they are in the **image's own pixels** — see `label-chip.ts`.
 */
function ensureLabelChipImage(map: MapLibreMap): void {
	if (map.hasImage(LABEL_CHIP_IMAGE_ID)) return;
	const zones = LABEL_CHIP_STRETCH.map((zone): [number, number] => [zone[0], zone[1]]);
	const [left, top, right, bottom] = LABEL_CHIP_CONTENT;
	map.addImage(LABEL_CHIP_IMAGE_ID, labelChipImage(), {
		sdf: true,
		pixelRatio: LABEL_CHIP_PIXEL_RATIO,
		content: [left, top, right, bottom],
		stretchX: zones,
		stretchY: zones
	});
}

/**
 * Whether the style on this map carries the typefaces a Label's words are shaped from.
 *
 * A Published Site written before ADR-0025 holds no `base-map/` assets, and the viewer builds its
 * style without `glyphs` rather than firing 404s at fonts that are not there — or worse, letting
 * MapLibre substitute a system one, which is invisible to every assertion about the map. A Label on
 * such a site cannot be drawn, and the page's notice says so (`baseMapNotPublishedNotice`).
 *
 * ⚠ **Asked of the map, not passed in.** The style is the fact; a boolean threaded down from two
 * applications would be a second description of it, free to disagree. Both panes wait for the style
 * to load before calling {@link drawLayerStack}, because a map with no style has nothing to add a
 * layer to either — but `Map#getStyle()` returns `undefined` before then while MapLibre's types
 * declare it non-nullable, so the absent style is read as "no glyphs" rather than left to throw
 * mid-loop and abandon the remaining Layers with sources added and no layers.
 *
 * The empty string is not a URL template either, and would hand MapLibre a Label bucket it can never
 * shape text for — the silent kind of failure this guard exists to avoid.
 */
const styleHasGlyphs = (map: MapLibreMap): boolean => {
	const glyphs = map.getStyle()?.glyphs;
	return typeof glyphs === 'string' && glyphs !== '';
};

/**
 * Choose between two paint values on whether this feature is the selected Annotation.
 *
 * The state is written by {@link StackRender.setSelectedAnnotation} against the feature id, which the
 * source promotes from `ANNOTATION_ID_PROPERTY`. `['boolean', …, false]` is the guard MapLibre needs
 * for a state that has never been set on a feature: without it the expression's type is unknown at
 * validation and the whole style is rejected.
 */
const selected = (whenSelected: number, otherwise: number): unknown[] => [
	'case',
	['boolean', ['feature-state', 'selected'], false],
	whenSelected,
	otherwise
];

/**
 * How the selected Annotation is emphasised: **a halo around it, and nothing done to it.**
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ⚠ WHY THE ANNOTATION'S OWN WIDTH IS NOT TOUCHED
 *
 * The first version of this drew the selected Annotation's outline 1.75× wider. That reads as
 * "selected" only on a Layer whose Annotations happen to share a `stroke-width`, and there is no
 * reason they would: a scholar draws a 1 px conjectural route beside a 6 px quay wall, and selecting
 * the route takes it to 3.5 px — still visibly thinner than the quay it is meant to stand out from.
 * The emphasis was *relative to the feature*, when what a reader needs is a mark that means the same
 * thing wherever it appears. And it spent the one property that is unambiguously the scholar's
 * statement about the line: how heavy the line is.
 *
 * So the selected Annotation is drawn **exactly as the file asks**, and a halo is drawn behind it.
 * The halo's width is an *addition* in screen pixels rather than a multiple, so a hairline and a
 * heavy outline get the same visible aura, and it sits under the drawing so the drawing itself is
 * unobscured. This is a sibling of the pin's `icon-halo-width`, which is why a Pin needs no separate
 * treatment — the same idea was already there for the one geometry that has no outline to ring.
 *
 * **Deliberately faint.** The width is centred on the outline, so it reads as three pixels of aura
 * either side of whatever the scholar drew. A selection mark is an answer to "which one is open", and
 * the Annotations are the thing being looked at: a heavy glow competes with the work for attention
 * and, on a Layer where several Annotations sit close together, reads as a shape of its own.
 *
 * **The halo is in the feature's own `stroke`, not a colour of ours.** A MapLibre paint value cannot
 * read a CSS custom property, so an accent colour here would be a theme token copied into this file
 * as a literal and left to drift — the cost `ReaderMapPane` records paying twice already. Taking the
 * colour from the feature means the halo needs contrast against the *base map*, which is the same
 * bet the Annotation itself already makes: an outline nobody can see against the ground is a
 * visibility problem the scholar has whether or not it is selected.
 *
 * ⚠ **Never a change of hue.** `stroke` and `marker-color` are the scholar's own choices, and a
 * selection that recoloured an Annotation would be showing them somebody else's map.
 */
const SELECTED_HALO_WIDTH = 6;
const SELECTED_HALO_OPACITY = 0.3;
/** The pin's own ring, in the same `stroke` colour, at rest and selected. */
const SELECTED_HALO = 3;

/**
 * A feature's `title` with every space, tab and newline taken out — an expression, evaluated per
 * feature.
 *
 * The one use of it is "does this title shape to anything", and the honest test for that is
 * MapLibre's own: shaping trims each line and then draws nothing, so a title of one space is as empty
 * as `''` to the text and not at all empty to a `!== ''` comparison. The expression language has no
 * `trim`, so `split`/`join` removes each whitespace character in turn; `to-string` of a missing
 * property is `''`, which covers a Label with no `title` at all.
 */
const TITLE_WITHOUT_WHITESPACE = [' ', '\t', '\n', '\r'].reduce<unknown[]>(
	(text, character) => ['join', ['split', text, character], ''],
	['to-string', ['get', 'title']]
);

/**
 * The MapLibre layers one Annotation Layer needs.
 *
 * **Every paint value is read from the feature** — `['get', 'stroke']` and not a constant — because
 * ticket 10's criterion is that a Layer's `defaultStyle` applies to Annotations lacking their own
 * properties *and* that an Annotation's own property overrides it. The precedence itself is not
 * decided here: `toRenderCollection` has already resolved each Annotation's effective style onto the
 * copy handed to the source, so this reads plain values and the rules live in one place in `core`
 * where the published viewer reads them too.
 *
 * **A line layer per dash pattern**, because `line-dasharray` is the one paint property MapLibre will
 * not evaluate per feature. So the dash becomes a filter on the bucket `toRenderCollection` computed,
 * which is how a solid, a dashed, and a dotted Annotation draw distinctly inside a single Layer.
 * Solid's layer sets no `line-dasharray` at all — absent is the representation of solid all the way to
 * the renderer (ADR-0009), not a dash array that happens to look continuous.
 *
 * **Only the layers this Layer's contents need are added**, which is why `present` is a parameter
 * rather than this returning all five every time. Every MapLibre layer is per-frame work on the same
 * thread that decodes a warped Map Image's tiles, and an Annotation Layer of pins was otherwise
 * paying for three line layers that could never match anything. It is not only tidiness: ticket 09's
 * `warpedTiles` assertion allows three seconds for tiles to arrive *and decode*, and the unconditional
 * five were enough to push it past that on a loaded machine — a real slowdown that happened to show up
 * as somebody else's test going red.
 */
function annotationLayers(
	layerId: string,
	present: {
		lineStyles: ReadonlySet<LineStyle>;
		hasArea: boolean;
		hasPoint: boolean;
		hasLabel: boolean;
	}
): { id: string; spec: Record<string, unknown> }[] {
	const source = stackLayerId(layerId, 'source');
	const strokeWidth = ['to-number', ['get', 'stroke-width']];

	/**
	 * The halo behind the selected line or shape — see {@link SELECTED_HALO_WIDTH}.
	 *
	 * **One layer for every dash pattern and every geometry with an outline**, because the halo is
	 * solid whatever the line it sits behind is: a dotted line's selection is the line still reading
	 * as dotted with an aura around it, not a dotted aura. That also keeps this to a single extra
	 * layer per Annotation Layer rather than one per bucket.
	 *
	 * ⚠ **Present always and painted only when something is selected**, because MapLibre does not
	 * allow `feature-state` in a layer's `filter` — only in its paint. So the selection lives in
	 * `line-opacity`, and at rest every feature in this layer paints it at zero.
	 */
	const selectionHalo = {
		id: stackLayerId(layerId, 'selected'),
		spec: {
			type: 'line',
			source,
			filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
			layout: { 'line-cap': 'round', 'line-join': 'round' },
			paint: {
				'line-color': ['get', 'stroke'],
				'line-width': ['+', strokeWidth, SELECTED_HALO_WIDTH],
				'line-opacity': selected(SELECTED_HALO_OPACITY, 0)
			}
		}
	};
	const lineOf = (style: LineStyle) => ({
		id: stackLayerId(layerId, `line-${style}`),
		spec: {
			type: 'line',
			source,
			filter: [
				'all',
				['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
				['==', ['get', LINE_STYLE_PROPERTY], style]
			],
			paint: {
				'line-color': ['get', 'stroke'],
				'line-opacity': ['to-number', ['get', 'stroke-opacity']],
				'line-width': strokeWidth,
				...(style === 'solid'
					? {}
					: {
							// One constant for the whole bucket, because `line-dasharray` is the one paint
							// property MapLibre will not evaluate per feature — which is why there is a layer
							// per pattern at all. MapLibre multiplies it by each feature's own `line-width`, so
							// a thicker Annotation draws a proportionally longer dash than the file states; the
							// ratio, which is what tells dashed from dotted, is what survives. See
							// `mapLibreDashArray` for why the alternative is a layer per width.
							'line-dasharray': mapLibreDashArray(
								style === 'dashed' ? DASHED_DASHARRAY : DOTTED_DASHARRAY
							)
						})
			}
		}
	});

	const fill = {
		id: stackLayerId(layerId, 'fill'),
		spec: {
			type: 'fill',
			source,
			filter: ['==', ['geometry-type'], 'Polygon'],
			paint: {
				'fill-color': ['get', 'fill'],
				'fill-opacity': ['to-number', ['get', 'fill-opacity']]
			}
		}
	};

	// **A pin, drawn as a symbol rather than a circle.** A circle reads as an area — a region, a
	// radius — and a Point Annotation is "this place, here". The image is an SDF so that each pin
	// takes its own `marker-color` through `icon-color`; see `pin-icon.ts` for why a PNG cannot.
	//
	// `icon-anchor: 'bottom'` because the *tip* is what points at the coordinate; a centred pin marks
	// a spot half its own height north of the place it means. `icon-allow-overlap` because two
	// Annotations near each other are two claims a scholar made, and MapLibre's default is to drop
	// one of them — silent loss of somebody's work from the map is not a decluttering.
	const point = {
		id: stackLayerId(layerId, 'point'),
		spec: {
			type: 'symbol',
			source,
			// ⚠ **The negation is load-bearing**: without it a Label draws its words *and* a pin under
			// them. `['get', 'marker-symbol']` is `null` on a feature carrying none and `null != 'label'`
			// is true, so an ordinary Pin is unaffected — asserted in `e2e/editor-annotations.e2e.ts`
			// rather than trusted.
			filter: [
				'all',
				['==', ['geometry-type'], 'Point'],
				['!=', ['get', 'marker-symbol'], LABEL_MARKER_SYMBOL]
			],
			layout: {
				'icon-image': PIN_IMAGE_ID,
				'icon-anchor': 'bottom',
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'icon-size': [
					'match',
					['coalesce', ['get', 'marker-size'], 'medium'],
					'small',
					PIN_ICON_SIZE['small'] ?? 0.5,
					'large',
					PIN_ICON_SIZE['large'] ?? 0.95,
					PIN_ICON_SIZE['medium'] ?? 0.7
				]
			},
			paint: {
				'icon-color': ['get', 'marker-color'],
				// **No opacity.** The circle took `fill-opacity`, which is simplestyle's *area* opacity —
				// it belongs to a polygon's interior, and a pin has no interior. Inheriting it made every
				// pin translucent by default and gave a scholar no control that explained why. A pin is a
				// mark on the map: it is there or it is not, and whether the Layer is showing is the
				// visibility toggle's job.
				//
				// The ring the pin's own `stroke` used to draw as a circle outline. Kept, because a pin
				// whose colour matches the ground under it is otherwise invisible.
				'icon-halo-color': ['get', 'stroke'],
				// Heavier while this pin is the selected Annotation — see {@link SELECTED_HALO}.
				'icon-halo-width': selected(SELECTED_HALO, 1)
			}
		}
	};

	// **A Label: the scholar's own words, on a chip coloured by the feature's `fill`.**
	//
	// Every value is read off the feature, as every other bucket's is.
	//
	// ⚠ **A Label with no words draws nothing, and an empty `text-field` is not enough to get that.**
	// MapLibre skips a symbol only when it has neither text *nor* icon (`if (!text && !icon) continue`),
	// so an untitled Label with a constant `icon-image` draws a bare coloured chip at a place nobody
	// wrote anything — story 61's exact complaint, observed in the browser rather than reasoned about.
	// The chip is therefore chosen per feature too, and `''` is MapLibre's own way of spelling "no
	// image" (`ResolvedImage.fromString` returns `null` for it). Deliberately *not* a `filter`: which
	// features are in this bucket stays a question about their kind, so `annotationDrawKey` is still
	// unmoved by a title being typed. The emptiness test is {@link TITLE_WITHOUT_WHITESPACE}, because
	// MapLibre's shaping trims each line before it measures anything and a title of one space shapes to
	// nothing while `!== ''` still resolves the chip.
	//
	// `icon-text-fit: 'both'` is what grows the chip to the words on both axes, wrapped lines
	// included; `label-chip.ts` holds the geometry that keeps its corners while it does.
	// `text-allow-overlap` and its three companions follow the pin's rule and the reason recorded
	// there: two Annotations near each other are two claims a scholar made, and MapLibre's default is
	// to drop one of them.
	const label = {
		id: stackLayerId(layerId, 'label'),
		spec: {
			type: 'symbol',
			source,
			filter: [
				'all',
				['==', ['geometry-type'], 'Point'],
				['==', ['get', 'marker-symbol'], LABEL_MARKER_SYMBOL]
			],
			layout: {
				'text-field': ['get', 'title'],
				// A stack the Base Map's bundled glyphs carry, and the one written with every Published
				// Site. There is no typeface choice: see SPEC's Out of Scope.
				'text-font': ['Noto Sans Regular'],
				'text-size': [
					'match',
					['coalesce', ['get', 'marker-size'], 'medium'],
					'small',
					LABEL_TEXT_SIZE.small,
					'large',
					LABEL_TEXT_SIZE.large,
					LABEL_TEXT_SIZE.medium
				],
				'icon-image': ['case', ['==', TITLE_WITHOUT_WHITESPACE, ''], '', LABEL_CHIP_IMAGE_ID],
				'icon-text-fit': 'both',
				'icon-text-fit-padding': [...LABEL_CHIP_PADDING],
				'text-allow-overlap': true,
				'icon-allow-overlap': true,
				'text-ignore-placement': true,
				'icon-ignore-placement': true
			},
			paint: {
				'text-color': ['get', 'marker-color'],
				// One registered SDF, tinted per feature — the whole reason the chip is an SDF.
				'icon-color': ['get', 'fill'],
				// `fill-opacity` is simplestyle's *area* opacity and the chip is an area: this is how a
				// Label's background is made transparent so the words sit straight on the map.
				'icon-opacity': ['to-number', ['get', 'fill-opacity']],
				// Selection, in the feature's own `stroke` — the pin's emphasis exactly, and never a
				// change of hue. See {@link SELECTED_HALO}. No ring at rest: the chip has an edge of its
				// own, and one drawn permanently would read as a border the scholar did not ask for.
				'icon-halo-color': ['get', 'stroke'],
				'icon-halo-width': selected(SELECTED_HALO, 0)
			}
		}
	};

	// The halo under everything, then fill under lines under pins, which is the order these read best
	// in: an area's outline over its own fill, and a pin over both. The halo is bottom-most so that
	// selecting an Annotation puts nothing in front of the drawing it is emphasising.
	//
	// Only added when this Layer has something with an outline. A Layer of pins alone would otherwise
	// pay per frame for a line layer that can never match a feature — `annotationLayers`' own rule,
	// and `lineStyles` is exactly "has a line or a shape", since a Polygon contributes to it too.
	return [
		...(present.lineStyles.size > 0 ? [selectionHalo] : []),
		...(present.hasArea ? [fill] : []),
		...LINE_STYLES.filter((style) => present.lineStyles.has(style)).map(lineOf),
		...(present.hasPoint ? [point] : []),
		// Last, so a Label's words are legible over anything else in its own Layer.
		...(present.hasLabel ? [label] : [])
	];
}

/**
 * Which geometry kinds and line styles a render-ready collection actually contains.
 *
 * Read off the render copy rather than the domain collection, because that copy is what the source is
 * given: a geometry this build cannot draw is already absent from it, so a Layer holding nothing but a
 * `MultiPolygon` correctly asks for no layers at all.
 */
function whatItContains(rendered: { features: Record<string, unknown>[] }): {
	lineStyles: ReadonlySet<LineStyle>;
	hasArea: boolean;
	hasPoint: boolean;
	hasLabel: boolean;
} {
	const lineStyles = new Set<LineStyle>();
	let hasArea = false;
	let hasPoint = false;
	let hasLabel = false;
	for (const feature of rendered.features) {
		const type = (feature['geometry'] as { type?: string } | undefined)?.type;
		const properties = feature['properties'] as Record<string, unknown> | undefined;
		// `hasPoint` is "a Point that is **not** a Label", the same split the two buckets' filters make,
		// so a Layer of Labels alone pays for no pin layer and a Layer of Pins alone pays for no symbol
		// layer. `isLabelFeature` rather than `isLabel` because this is a render copy's `properties` bag
		// and not an Annotation; the geometry is checked here instead.
		if (type === 'Point') {
			if (isLabelFeature(properties)) hasLabel = true;
			else hasPoint = true;
		}
		if (type === 'Polygon') hasArea = true;
		if (type === 'LineString' || type === 'Polygon') {
			lineStyles.add((properties?.[LINE_STYLE_PROPERTY] as LineStyle | undefined) ?? 'solid');
		}
	}
	return { lineStyles, hasArea, hasPoint, hasLabel };
}

/**
 * What about an Annotation Layer's contents decides **which** MapLibre layers it needs.
 *
 * A stable string, so a caller can hold it as "the shape of this Layer" and rebuild only when it
 * changes. Everything else about a collection — a title, a description, a colour, a moved vertex —
 * is data inside a source that is already there, and belongs in {@link StackRender.setAnnotations}
 * instead. Typing a title used to change this Layer's entry in a structure key and rebuild the whole
 * stack per keystroke; this is the value that does not move when it should not.
 */
export function annotationDrawKey(collection: AnnotationCollection | null | undefined): string {
	const present = whatItContains(toRenderCollection(collection ?? { annotations: [] }));
	return [
		present.hasPoint ? 'point' : '',
		present.hasLabel ? 'label' : '',
		present.hasArea ? 'area' : '',
		...LINE_STYLES.filter((style) => present.lineStyles.has(style))
	].join('|');
}

/**
 * Every MapLibre layer id an Annotation Layer *could* contribute, for hit-testing a click.
 *
 * Every candidate, not only the ones added: which exist depends on what the Layer contains, and a
 * caller hit-testing has to filter by `map.getLayer(id)` anyway — asking MapLibre about a layer that is
 * not there throws. Returning the full set keeps this function free of the contents.
 *
 * ⚠ **The selection halo is deliberately absent.** It is a line a dozen pixels wider than the
 * Annotation it sits behind, so including it would make the selected Annotation — and only the
 * selected one — easier to click than the rest, which is a hit target that moves as the reader
 * chooses things. What is clickable is what is drawn for the Annotation itself.
 */
export const annotationLayerIds = (layerId: string): string[] => [
	stackLayerId(layerId, 'fill'),
	...LINE_STYLES.map((style) => stackLayerId(layerId, `line-${style}`)),
	stackLayerId(layerId, 'point'),
	// Without this a Label is a mark nobody can click, in either app: hit-testing is by layer id.
	stackLayerId(layerId, 'label')
];

/**
 * The live objects a built stack consists of, handed to {@link StackBuiltListener}.
 *
 * Named rather than left inline so that an app can type a Playwright handle against it **without naming
 * `@allmaps/maplibre`**. `apps/viewer` deliberately does not depend on that package — it reaches warped
 * rendering through this module, which is where ADR-0019 wants that dependency to live — so an app-side
 * `Record<string, WarpedMapLayer>` would be an undeclared import of somebody else's dependency.
 */
export type DrawnStackObjects = {
	readonly map: MapLibreMap;
	/** The live warped layer for each `kind: 'map'` Layer of the stack, by Layer id. */
	readonly warped: Readonly<Record<string, WarpedMapLayer>>;
};

/**
 * Called with the live objects once a stack is on the map, returning the way to let go of them.
 *
 * **The seam that keeps each app's Playwright handle in its own app.** SPEC's Seam 2 is a real browser
 * with no map abstraction, so a browser test needs the `WarpedMapLayer`s themselves — but a
 * `declare global` on `Window` inside `@ballastella/core` would put one app's test scaffolding into the
 * other's types, and into a published Reader's bundle. So the exposure is injected and this module knows
 * nothing about `window`.
 */
export type StackBuiltListener = (
	map: DrawnStackObjects['map'],
	warped: DrawnStackObjects['warped']
) => (() => void) | void;

/**
 * Draw `layers` onto `map`, bottom of the stack first.
 *
 * The whole stack is built and torn down together rather than diffed. Handing an Alignment to the
 * warped renderer is keyed on the document's content, so a moved Control Point is a different map to it
 * and there is nothing to update in place; and MapLibre has no "move this layer below that one" that would let a
 * reorder be applied incrementally without the same care. What a rebuild must not be spent on is
 * opacity, which is why {@link StackRender.setOpacity} exists.
 */
export function drawLayerStack(options: {
	map: MapLibreMap;
	layers: readonly DrawnLayer[];
	/** Where an aligned Map Image's tiles are read from (ADR-0011). */
	fetchTile: FetchFn;
	onBuilt?: StackBuiltListener;
}): StackRender {
	const { map, layers, fetchTile } = options;
	const outcomes: Record<string, DrawnOutcome> = {};
	const warped: Record<string, ReturnType<typeof createWarpedMapLayer>> = {};
	const added: string[] = [];
	const sources: string[] = [];
	/** Which Annotation is drawn as selected — display state, held here so a redraw can restore it. */
	let selectedAnnotationId: string | null = null;
	// Asked once, not per Layer: `getStyle()` is a whole-style serialization — every layer spec of a
	// 100-plus-layer Protomaps style, cloned — and the style cannot gain or lose glyphs partway
	// through a rebuild.
	const hasGlyphs = styleHasGlyphs(map);

	for (const drawn of drawingOrder(layers)) {
		const layerId = drawn.layer.id;
		if (isDrawnMap(drawn)) {
			const layer = createWarpedMapLayer(fetchTile, stackLayerId(layerId));
			map.addLayer(layer);
			added.push(layer.id);
			warped[layerId] = layer;
			layer.setOpacity(drawn.layer.opacity);
			const render: WarpedRender = showAlignment(layer, drawn.alignment, {
				referenced: drawn.referenced ?? false,
				service: drawn.service ?? ''
			});
			outcomes[layerId] = describe(render);
			continue;
		}

		const source = stackLayerId(layerId, 'source');
		// `toRenderCollection` resolves each Annotation's style against this Layer's default and
		// simplestyle's own (ADR-0009). A Layer with no file yet, or one whose file could not be read,
		// draws nothing rather than taking the rest of the stack down with it.
		const rendered = toRenderCollection(drawn.annotations ?? { annotations: [] });
		// `promoteId` is what makes the Annotation's own id MapLibre's feature id, which is the only
		// handle `setFeatureState` takes — a GeoJSON source otherwise numbers its features by position,
		// so the selected one would change identity whenever the collection was reordered.
		map.addSource(source, {
			type: 'geojson',
			data: rendered as never,
			promoteId: ANNOTATION_ID_PROPERTY
		});
		sources.push(source);
		const contents = whatItContains(rendered);
		// No image, no pin layer — which shows as a missing mark rather than as MapLibre logging a
		// missing image once per frame.
		if (contents.hasPoint && !ensurePinImage(map)) contents.hasPoint = false;
		// No glyphs, no Label layer — which shows as a mark absent from the map rather than as MapLibre
		// asking, once per frame, for a font this site does not carry. See {@link styleHasGlyphs}: the
		// Layer is still drawn, and its Pins, Lines and Shapes are unaffected.
		if (contents.hasLabel && !hasGlyphs) contents.hasLabel = false;
		if (contents.hasLabel) ensureLabelChipImage(map);
		for (const { id, spec } of annotationLayers(layerId, contents)) {
			map.addLayer({ id, ...spec } as never);
			added.push(id);
		}
		outcomes[layerId] = { status: 'drawn' };
	}

	/**
	 * Write the selection onto every Annotation source.
	 *
	 * ⚠ **Re-run after a `setData`.** MapLibre drops a GeoJSON source's feature states when its data is
	 * replaced, so an Annotation that stayed selected through a keystroke would otherwise lose its
	 * emphasis on the first character typed into its title.
	 */
	const paintSelection = (): void => {
		for (const source of sources) {
			if (!map.getSource(source)) continue;
			map.removeFeatureState({ source });
			if (selectedAnnotationId !== null) {
				map.setFeatureState({ source, id: selectedAnnotationId }, { selected: true });
			}
		}
	};

	const unexpose = options.onBuilt?.(map, warped) ?? (() => undefined);

	return {
		outcomes,
		setOpacity(layerId, opacity) {
			warped[layerId]?.setOpacity(opacity);
		},
		setAnnotations(layerId, collection) {
			const source = map.getSource(stackLayerId(layerId, 'source'));
			// `getSource` returns whatever kind is there; only a GeoJSON source has `setData`, and after
			// a `setStyle` there is nothing there at all.
			const geojson = source as { setData?: (data: unknown) => void } | undefined;
			geojson?.setData?.(toRenderCollection(collection));
			paintSelection();
		},

		setSelectedAnnotation(annotationId) {
			selectedAnnotationId = annotationId;
			paintSelection();
		},
		destroy({ mapIsGone = false } = {}) {
			unexpose();
			if (mapIsGone) return;
			// `setStyle` on a theme change removes our layers along with everything else, so removing one
			// that has already gone has to be survivable rather than an exception in a teardown.
			for (const id of added.toReversed()) if (map.getLayer(id)) map.removeLayer(id);
			for (const id of sources) if (map.getSource(id)) map.removeSource(id);
		}
	};
}

/** A {@link WarpedRender} as the Layer list reads it. */
function describe(render: WarpedRender): DrawnOutcome {
	switch (render.status) {
		case 'drawn':
			return { status: 'drawn' };
		case 'too-few-points':
			return {
				status: 'refused',
				reason: `${render.need - render.have} more Control ${
					render.need - render.have === 1 ? 'Point' : 'Points'
				} and this Layer will be drawn.`
			};
		case 'refused':
			return { status: 'refused', reason: render.reason };
	}
}
