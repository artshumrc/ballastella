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
	type AnnotationCollection,
	type LineStyle
} from '../annotation/annotation.js';
import { createAnnotationOrdinals, type AnnotationOrdinals } from './annotation-ordinals.js';
import { PIN_ICON_SIZE, PIN_IMAGE_ID, PIN_PIXEL_RATIO, pinImage } from './pin-icon.js';
import {
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
	 * Whether this Layer's Historical Map is served from somebody else's server, as observed from the
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
 * Whether this entry is an aligned Historical Map.
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
	 * in the stack**, Historical Maps included, once per keystroke — so typing a title made the whole
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
 * thread that decodes a warped Historical Map's tiles, and an Annotation Layer of pins was otherwise
 * paying for three line layers that could never match anything. It is not only tidiness: ticket 09's
 * `warpedTiles` assertion allows three seconds for tiles to arrive *and decode*, and the unconditional
 * five were enough to push it past that on a loaded machine — a real slowdown that happened to show up
 * as somebody else's test going red.
 */
function annotationLayers(
	layerId: string,
	present: { lineStyles: ReadonlySet<LineStyle>; hasArea: boolean; hasPoint: boolean }
): { id: string; spec: Record<string, unknown> }[] {
	const source = stackLayerId(layerId, 'source');
	const strokeWidth = ['to-number', ['get', 'stroke-width']];
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
			filter: ['==', ['geometry-type'], 'Point'],
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
				'icon-halo-width': 1
			}
		}
	};

	// Fill under lines under pins, which is the order these read best in: an area's outline over its
	// own fill, and a pin over both.
	return [
		...(present.hasArea ? [fill] : []),
		...LINE_STYLES.filter((style) => present.lineStyles.has(style)).map(lineOf),
		...(present.hasPoint ? [point] : [])
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
} {
	const lineStyles = new Set<LineStyle>();
	let hasArea = false;
	let hasPoint = false;
	for (const feature of rendered.features) {
		const type = (feature['geometry'] as { type?: string } | undefined)?.type;
		const properties = feature['properties'] as Record<string, unknown> | undefined;
		if (type === 'Point') hasPoint = true;
		if (type === 'Polygon') hasArea = true;
		if (type === 'LineString' || type === 'Polygon') {
			lineStyles.add((properties?.[LINE_STYLE_PROPERTY] as LineStyle | undefined) ?? 'solid');
		}
	}
	return { lineStyles, hasArea, hasPoint };
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
		present.hasArea ? 'area' : '',
		...LINE_STYLES.filter((style) => present.lineStyles.has(style))
	].join('|');
}

/**
 * Every MapLibre layer id an Annotation Layer *could* contribute, for hit-testing a click.
 *
 * All five candidates, not only the ones added: which exist depends on what the Layer contains, and a
 * caller hit-testing has to filter by `map.getLayer(id)` anyway — asking MapLibre about a layer that is
 * not there throws. Returning the full set keeps this function free of the contents.
 */
export const annotationLayerIds = (layerId: string): string[] => [
	stackLayerId(layerId, 'fill'),
	...LINE_STYLES.map((style) => stackLayerId(layerId, `line-${style}`)),
	stackLayerId(layerId, 'point')
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
	/** Where an aligned Historical Map's tiles are read from (ADR-0011). */
	fetchTile: FetchFn;
	onBuilt?: StackBuiltListener;
}): StackRender {
	const { map, layers, fetchTile } = options;
	const outcomes: Record<string, DrawnOutcome> = {};
	const warped: Record<string, ReturnType<typeof createWarpedMapLayer>> = {};
	const added: string[] = [];
	const sources: string[] = [];
	/** Each Annotation Layer's numbers, by Layer id — display state, drawn beside the marks. */
	const ordinals: Record<string, AnnotationOrdinals> = {};

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
		map.addSource(source, { type: 'geojson', data: rendered as never });
		sources.push(source);
		const contents = whatItContains(rendered);
		// No image, no pin layer — which shows as a missing mark rather than as MapLibre logging a
		// missing image once per frame.
		if (contents.hasPoint && !ensurePinImage(map)) contents.hasPoint = false;
		for (const { id, spec } of annotationLayers(layerId, contents)) {
			map.addLayer({ id, ...spec } as never);
			added.push(id);
		}
		// The numbers over the marks (SPEC stories 37, 38). Outside the source and outside the style:
		// they are DOM elements MapLibre positions, so a Published Site with no glyphs still shows them
		// — see `annotation-ordinals.ts` for why that decided it.
		const numbers = createAnnotationOrdinals(map);
		numbers.update(drawn.annotations);
		ordinals[layerId] = numbers;
		outcomes[layerId] = { status: 'drawn' };
	}

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
			// Renumbering is this call and nothing else: an Annotation deleted here leaves the ones after
			// it counted again from a shorter list, with no file written to say so (ADR-0002).
			ordinals[layerId]?.update(collection);
		},
		destroy({ mapIsGone = false } = {}) {
			unexpose();
			// The marks are DOM elements rather than style layers, so they have to be taken off whether or
			// not the map survives — a removed map takes its container's children with it, but a `setStyle`
			// does not, and a mark left behind would outlive the Layer it belongs to.
			for (const numbers of Object.values(ordinals)) numbers.destroy();
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
