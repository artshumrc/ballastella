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

import type {
	Alignment,
	AnnotationCollection,
	AnnotationLayer,
	FetchFn,
	LineStyle,
	MapLayer
} from '@ballastella/core';
import {
	DASHED_DASHARRAY,
	DOTTED_DASHARRAY,
	LINE_STYLES,
	LINE_STYLE_PROPERTY,
	SIMPLESTYLE_DEFAULTS,
	drawingOrder,
	mapLibreDashArray,
	toRenderCollection
} from '@ballastella/core';
import type { Map as MapLibreMap } from 'maplibre-gl';

import {
	createWarpedMapLayer,
	showAlignment,
	type WarpedRender
} from '$lib/warped/warped-map-layer';

import { exposeLayerStackToBrowserTests } from './browser-test-handle';

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
	 * Resolved by the caller from the Project's `remote.json` records, for the same reason the
	 * Alignment is: reaching the store is `EditorSession`'s business. A `'referenced'` Layer with `''`
	 * here draws nothing at all, so the caller derives it from `imageMode` — see the layers pane.
	 */
	readonly service?: string;
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
const MARKER_RADIUS: Record<string, number> = { small: 4, medium: 6, large: 9 };

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
							// MapLibre expresses a dash as a multiple of the line's own width; the stored tuple
							// is in the same units as the width, like SVG's. A constant is correct here because
							// every feature in this layer is in the same bucket, and the width divides out.
							'line-dasharray': mapLibreDashArray(
								style === 'dashed' ? DASHED_DASHARRAY : DOTTED_DASHARRAY,
								SIMPLESTYLE_DEFAULTS['stroke-width']
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

	const point = {
		id: stackLayerId(layerId, 'point'),
		spec: {
			type: 'circle',
			source,
			filter: ['==', ['geometry-type'], 'Point'],
			paint: {
				'circle-color': ['get', 'marker-color'],
				'circle-radius': [
					'match',
					['coalesce', ['get', 'marker-size'], 'medium'],
					'small',
					MARKER_RADIUS['small'] ?? 4,
					'large',
					MARKER_RADIUS['large'] ?? 9,
					MARKER_RADIUS['medium'] ?? 6
				],
				'circle-stroke-color': ['get', 'stroke'],
				'circle-stroke-width': 1,
				'circle-opacity': ['to-number', ['get', 'fill-opacity']]
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
}): StackRender {
	const { map, layers, fetchTile } = options;
	const outcomes: Record<string, DrawnOutcome> = {};
	const warped: Record<string, ReturnType<typeof createWarpedMapLayer>> = {};
	const added: string[] = [];
	const sources: string[] = [];

	for (const drawn of drawingOrder(layers)) {
		const layerId = drawn.layer.id;
		if (isDrawnMap(drawn)) {
			const layer = createWarpedMapLayer(fetchTile, stackLayerId(layerId));
			map.addLayer(layer);
			added.push(layer.id);
			warped[layerId] = layer;
			layer.setOpacity(drawn.layer.opacity);
			const render: WarpedRender = showAlignment(layer, drawn.alignment, {
				service: drawn.service ?? ''
			});
			outcomes[layerId] = describe(render);
			continue;
		}

		const source = stackLayerId(layerId, 'source');
		// `toRenderCollection` resolves each Annotation's style against this Layer's default and
		// simplestyle's own (ADR-0009). A Layer with no file yet, or one whose file could not be read,
		// draws nothing rather than taking the rest of the stack down with it.
		const rendered = toRenderCollection(
			drawn.annotations ?? { annotations: [] },
			drawn.layer.defaultStyle
		);
		map.addSource(source, { type: 'geojson', data: rendered as never });
		sources.push(source);
		for (const { id, spec } of annotationLayers(layerId, whatItContains(rendered))) {
			map.addLayer({ id, ...spec } as never);
			added.push(id);
		}
		outcomes[layerId] = { status: 'drawn' };
	}

	const unexpose = exposeLayerStackToBrowserTests(map, warped);

	return {
		outcomes,
		setOpacity(layerId, opacity) {
			warped[layerId]?.setOpacity(opacity);
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
