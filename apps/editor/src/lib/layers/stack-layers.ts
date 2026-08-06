// Drawing a Project's Layer stack onto the Base Map.
//
// This is the half of ADR-0002 that is not a data model: the stack says what draws over what, and
// this is where that becomes MapLibre's own layer order. Adding runs bottom-to-top through
// `drawingOrder`, which is the one function that knows the list reads the other way — so the Layer at
// the top of the list is added last and therefore draws over the ones below it, **including across
// kinds**: an Annotation Layer above a map Layer draws above it.
//
// A `kind: 'map'` Layer becomes a `WarpedMapLayer` reading its tiles through the ADR-0011 shim; an
// Annotation Layer becomes a GeoJSON source and the three MapLibre layers a `FeatureCollection`
// needs. Anything else — a kind this build has never heard of — is skipped and reported, which is
// ADR-0014's forward tolerance at the render boundary.

import type { Alignment, AnnotationLayer, FetchFn, MapLayer, SimpleStyle } from '@ballastella/core';
import { drawingOrder } from '@ballastella/core';
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
}

export interface DrawnAnnotationLayer {
	readonly layer: AnnotationLayer;
	/** The parsed `FeatureCollection`, or `null` when the Layer has no file yet. */
	readonly features: unknown;
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
	/** Take the whole stack off the map. Survivable after a `setStyle` has already removed it. */
	destroy(): void;
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

/** simplestyle's own defaults (ADR-0009), used wherever the Layer's default style says nothing. */
const SIMPLESTYLE_DEFAULTS = {
	stroke: '#555555',
	strokeOpacity: 1,
	strokeWidth: 2,
	fill: '#555555',
	fillOpacity: 0.6,
	markerColor: '#7e7e7e'
} as const;

/** The three MapLibre layers a `FeatureCollection` needs, styled from the Layer's default style. */
function annotationLayers(
	layerId: string,
	defaultStyle: SimpleStyle
): { id: string; spec: Record<string, unknown> }[] {
	const source = stackLayerId(layerId, 'source');
	const dash = defaultStyle['stroke-dasharray'];
	return [
		{
			id: stackLayerId(layerId, 'fill'),
			spec: {
				type: 'fill',
				source,
				filter: ['==', ['geometry-type'], 'Polygon'],
				paint: {
					'fill-color': defaultStyle.fill ?? SIMPLESTYLE_DEFAULTS.fill,
					'fill-opacity': defaultStyle['fill-opacity'] ?? SIMPLESTYLE_DEFAULTS.fillOpacity
				}
			}
		},
		{
			id: stackLayerId(layerId, 'line'),
			spec: {
				type: 'line',
				source,
				filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
				paint: {
					'line-color': defaultStyle.stroke ?? SIMPLESTYLE_DEFAULTS.stroke,
					'line-opacity': defaultStyle['stroke-opacity'] ?? SIMPLESTYLE_DEFAULTS.strokeOpacity,
					'line-width': defaultStyle['stroke-width'] ?? SIMPLESTYLE_DEFAULTS.strokeWidth,
					// Absent means solid (ADR-0009), which is the property not being set at all rather than
					// a dash array that happens to look continuous.
					...(dash ? { 'line-dasharray': [...dash] } : {})
				}
			}
		},
		{
			id: stackLayerId(layerId, 'point'),
			spec: {
				type: 'circle',
				source,
				filter: ['==', ['geometry-type'], 'Point'],
				paint: {
					'circle-color': defaultStyle['marker-color'] ?? SIMPLESTYLE_DEFAULTS.markerColor,
					'circle-radius': 6,
					'circle-stroke-color': defaultStyle.stroke ?? SIMPLESTYLE_DEFAULTS.stroke,
					'circle-stroke-width': 1
				}
			}
		}
	];
}

const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

/**
 * Draw `layers` onto `map`, bottom of the stack first.
 *
 * The whole stack is built and torn down together rather than diffed. `addGeoreferencedMap` is keyed
 * on the document's content, so a moved Control Point is a different map to the renderer and there is
 * nothing to update in place; and MapLibre has no "move this layer below that one" that would let a
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
			const render: WarpedRender = showAlignment(layer, drawn.alignment);
			outcomes[layerId] = describe(render);
			continue;
		}

		const source = stackLayerId(layerId, 'source');
		map.addSource(source, {
			type: 'geojson',
			// A Layer with no file yet, or one whose file could not be read, draws nothing rather than
			// taking the rest of the stack down with it.
			data: (drawn.features ?? EMPTY_COLLECTION) as never
		});
		sources.push(source);
		for (const { id, spec } of annotationLayers(layerId, drawn.layer.defaultStyle)) {
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
		destroy() {
			unexpose();
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
