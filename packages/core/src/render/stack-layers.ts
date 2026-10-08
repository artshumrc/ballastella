import {
	DASHED_DASHARRAY,
	DOTTED_DASHARRAY,
	LABEL_MARKER_SYMBOL,
	emptyCollection,
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

import {
	createWarpedMapLayer,
	showAlignment,
	warpedTilesRequestedForViewport,
	type WarpedRender
} from './warped-map-layer.js';

interface DrawnMapLayer {
	readonly layer: MapLayer;
	readonly alignment: Alignment;
	readonly service?: string;
	readonly referenced?: boolean;
}

interface DrawnAnnotationLayer {
	readonly layer: AnnotationLayer;
	readonly annotations: AnnotationCollection | null;
}

export type DrawnLayer = DrawnMapLayer | DrawnAnnotationLayer;

export const isDrawnMap = (drawn: DrawnLayer): drawn is DrawnMapLayer => 'alignment' in drawn;

export type DrawnOutcome =
	{ readonly status: 'drawn' } | { readonly status: 'refused'; readonly reason: string };

export interface StackRender {
	readonly outcomes: Readonly<Record<string, DrawnOutcome>>;
	setOpacity(layerId: string, opacity: number): void;
	setAnnotations(layerId: string, collection: AnnotationCollection): void;
	setSelectedAnnotation(annotationId: string | null): void;
	whenTilesSettled(): Promise<void>;
	destroy(options?: { mapIsGone?: boolean }): void;
}

export const stackLayerId = (layerId: string, part = ''): string =>
	`ballastella-layer-${layerId}${part === '' ? '' : `-${part}`}`;

// Re-run on every build: a theme change's `setStyle` discards every registered image.
function ensurePinImage(map: MapLibreMap): boolean {
	if (map.hasImage(PIN_IMAGE_ID)) return true;
	const image = pinImage();
	if (image === null) return false;
	map.addImage(PIN_IMAGE_ID, image, { sdf: true, pixelRatio: PIN_PIXEL_RATIO });
	return true;
}

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

const styleHasGlyphs = (map: MapLibreMap): boolean => {
	const glyphs = map.getStyle()?.glyphs;
	return typeof glyphs === 'string' && glyphs !== '';
};

const selected = (whenSelected: number, otherwise: number): unknown[] => [
	'case',
	['boolean', ['feature-state', 'selected'], false],
	whenSelected,
	otherwise
];

const bySize = (size: { small: number; medium: number; large: number }): unknown[] => [
	'match',
	['coalesce', ['get', 'marker-size'], 'medium'],
	'small',
	size.small,
	'large',
	size.large,
	size.medium
];

const SELECTED_HALO_WIDTH = 6;
const SELECTED_HALO_OPACITY = 0.3;
const PIN_HALO = 1;
const SELECTED_HALO = 3;
const PIN_HALO_COLOR = '#ffffff';

type Contents = {
	lineStyles: ReadonlySet<LineStyle>;
	hasArea: boolean;
	hasPoint: boolean;
	hasLabel: boolean;
};

const TITLE_WITHOUT_WHITESPACE = [' ', '\t', '\n', '\r'].reduce<unknown[]>(
	(text, character) => ['join', ['split', text, character], ''],
	['to-string', ['get', 'title']]
);

const IS_LINE = ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]];

function annotationLayers(
	layerId: string,
	present: Contents
): { id: string; spec: Record<string, unknown> }[] {
	const source = stackLayerId(layerId, 'source');
	const strokeWidth = ['to-number', ['get', 'stroke-width']];

	const selectionHalo = {
		id: stackLayerId(layerId, 'selected'),
		spec: {
			type: 'line',
			source,
			filter: IS_LINE,
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
			filter: ['all', IS_LINE, ['==', ['get', LINE_STYLE_PROPERTY], style]],
			paint: {
				'line-color': ['get', 'stroke'],
				'line-opacity': ['to-number', ['get', 'stroke-opacity']],
				'line-width': strokeWidth,
				...(style === 'solid'
					? {}
					: {
							// MapLibre will not evaluate `line-dasharray` per feature, hence a layer per pattern.
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

	const point = {
		id: stackLayerId(layerId, 'point'),
		spec: {
			type: 'symbol',
			source,
			// `null != 'label'` is true, so a Pin without `marker-symbol` passes.
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
				'icon-size': bySize(PIN_ICON_SIZE)
			},
			paint: {
				'icon-color': ['get', 'marker-color'],
				'icon-halo-color': PIN_HALO_COLOR,
				'icon-halo-width': selected(SELECTED_HALO, PIN_HALO)
			}
		}
	};

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
				'text-font': ['Noto Sans Regular'],
				'text-size': bySize(LABEL_TEXT_SIZE),
				// MapLibre skips a symbol only with neither text nor icon, so an empty title gets no chip.
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
				'icon-color': ['get', 'fill'],
				'icon-opacity': ['to-number', ['get', 'fill-opacity']],
				'icon-halo-color': ['get', 'stroke'],
				'icon-halo-width': selected(SELECTED_HALO, 0)
			}
		}
	};

	return [
		...(present.lineStyles.size > 0 ? [selectionHalo] : []),
		...(present.hasArea ? [fill] : []),
		...LINE_STYLES.filter((style) => present.lineStyles.has(style)).map(lineOf),
		...(present.hasPoint ? [point] : []),
		...(present.hasLabel ? [label] : [])
	];
}

function whatItContains(rendered: { features: Record<string, unknown>[] }): Contents {
	const lineStyles = new Set<LineStyle>();
	let hasArea = false;
	let hasPoint = false;
	let hasLabel = false;
	for (const feature of rendered.features) {
		const type = (feature['geometry'] as { type?: string } | undefined)?.type;
		const properties = feature['properties'] as Record<string, unknown> | undefined;
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

export function annotationDrawKey(collection: AnnotationCollection | null | undefined): string {
	const present = whatItContains(toRenderCollection(collection ?? emptyCollection()));
	return [
		present.hasPoint ? 'point' : '',
		present.hasLabel ? 'label' : '',
		present.hasArea ? 'area' : '',
		...LINE_STYLES.filter((style) => present.lineStyles.has(style))
	].join('|');
}

export const annotationLayerIds = (layerId: string): string[] => [
	stackLayerId(layerId, 'fill'),
	...LINE_STYLES.map((style) => stackLayerId(layerId, `line-${style}`)),
	stackLayerId(layerId, 'point'),
	stackLayerId(layerId, 'label')
];

export type DrawnStackObjects = {
	readonly map: MapLibreMap;
	readonly warped: Readonly<Record<string, WarpedMapLayer>>;
};

export type StackBuiltListener = (
	map: DrawnStackObjects['map'],
	warped: DrawnStackObjects['warped']
) => (() => void) | void;

export function drawLayerStack(options: {
	map: MapLibreMap;
	layers: readonly DrawnLayer[];
	fetchTile: FetchFn;
	onBuilt?: StackBuiltListener;
}): StackRender {
	const { map, layers, fetchTile } = options;
	const outcomes: Record<string, DrawnOutcome> = {};
	const warped: Record<string, ReturnType<typeof createWarpedMapLayer>> = {};
	const added: string[] = [];
	const sources: string[] = [];
	let selectedAnnotationId: string | null = null;
	const hasGlyphs = styleHasGlyphs(map);

	for (const drawn of drawingOrder(layers)) {
		const layerId = drawn.layer.id;
		if (isDrawnMap(drawn)) {
			const layer = createWarpedMapLayer(fetchTile, stackLayerId(layerId));
			map.addLayer(layer);
			added.push(layer.id);
			warped[layerId] = layer;
			layer.setOpacity(drawn.layer.opacity);
			const render = showAlignment(layer, drawn.alignment, {
				referenced: drawn.referenced ?? false,
				service: drawn.service ?? ''
			});
			outcomes[layerId] = describe(render);
			continue;
		}

		const source = stackLayerId(layerId, 'source');
		const rendered = toRenderCollection(drawn.annotations ?? emptyCollection());
		// `promoteId` makes the Annotation id the feature id `setFeatureState` keys on.
		map.addSource(source, {
			type: 'geojson',
			data: rendered as never,
			promoteId: ANNOTATION_ID_PROPERTY
		});
		sources.push(source);
		const contents = whatItContains(rendered);
		if (contents.hasPoint && !ensurePinImage(map)) contents.hasPoint = false;
		if (contents.hasLabel && !hasGlyphs) contents.hasLabel = false;
		if (contents.hasLabel) ensureLabelChipImage(map);
		for (const { id, spec } of annotationLayers(layerId, contents)) {
			map.addLayer({ id, ...spec } as never);
			added.push(id);
		}
		outcomes[layerId] = { status: 'drawn' };
	}

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
			const geojson = source as { setData?: (data: unknown) => void } | undefined;
			geojson?.setData?.(toRenderCollection(collection));
			paintSelection();
		},

		setSelectedAnnotation(annotationId) {
			selectedAnnotationId = annotationId;
			paintSelection();
		},
		async whenTilesSettled() {
			await Promise.all(Object.values(warped).map((layer) => settleWarpedTiles(map, layer)));
		},
		destroy({ mapIsGone = false } = {}) {
			unexpose();
			if (mapIsGone) return;
			for (const id of added.toReversed()) if (map.getLayer(id)) map.removeLayer(id);
			for (const id of sources) if (map.getSource(id)) map.removeSource(id);
		}
	};
}

// `Map#idle` can fire while a warped Map Image's tiles are still unrequested.
async function settleWarpedTiles(map: MapLibreMap, layer: WarpedMapLayer): Promise<void> {
	const renderer = layer.renderer;
	if (!renderer) return;
	for (;;) {
		await renderer.tileCache.allRequestedTilesLoaded();
		if (warpedTilesRequestedForViewport(renderer)) return;
		await new Promise<void>((resolve) => {
			map.once('idle', () => resolve());
		});
	}
}

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
