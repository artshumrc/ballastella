<script module lang="ts">
	import type { AnnotationGeometry } from '@ballastella/core';

	export type AnnotationDragPreview = {
		layerId: string;
		annotationId: string;
		geometry: AnnotationGeometry;
	};

	export type AnnotationHit = { layerId: string; annotationId: string };
</script>

<script lang="ts">
	import {
		ANNOTATION_ID_PROPERTY,
		BASE_MAP_SOURCE_ID,
		applyOpeningFit,
		baseMapStyle,
		isAbsoluteUrl,
		keepAskingForMissingTiles,
		resolveBaseMap,
		setGeometry,
		type Annotation,
		type BaseMapAppearance,
		type BaseMapBorders,
		type BaseMapBorderStyle,
		type BaseMapCatalog,
		type FetchFn,
		type OpeningViewFit,
		type Theme
	} from '@ballastella/core';
	import {
		annotationDrawKey,
		annotationLayerIds,
		annotationMarkBox,
		baseMapPaintKey,
		cachedBaseMapTileTemplate,
		captureMapFrame,
		drawLayerStack,
		isDrawnMap,
		registerCachedBaseMapTiles,
		registerPmtilesProtocol,
		registerTerrainProtocols,
		themeColour,
		whenMapIdle,
		whenStyleLoaded,
		type DrawnLayer,
		type DrawnOutcome,
		type FrameInvalidator,
		type ReadCachedTile,
		type ScreenBox,
		type StackRender
	} from '@ballastella/core/render';
	import { Map as MapLibreMap, NavigationControl, type StyleSpecification } from 'maplibre-gl';
	import { onMount, untrack, type Snippet } from 'svelte';

	import { exposeStackToBrowserTests, recordCachedBaseMapTiles } from './browser-test-handles';

	let {
		testid,
		stackHandle,
		hitRadius,
		entryId,
		catalog,
		theme,
		appearance,
		borders,
		borderStyle,
		resolveAsset,
		bundledAssets = true,
		cachedBaseMap,
		layers,
		fetchTile,
		openingFit,
		selectedAnnotationId,
		annotationDragPreview = null,
		tilesMissing = false,
		snapshotGeneration,
		onmap,
		onclickannotation,
		onstack,
		onbasemapstatus,
		oninvalidateframe,
		onframesettled,
		children
	}: {
		testid: string;
		stackHandle: 'ballastellaLayerStack' | 'ballastellaReaderMap';
		hitRadius: number;
		entryId: string;
		catalog: BaseMapCatalog;
		theme: Theme;
		appearance: BaseMapAppearance;
		borders: BaseMapBorders;
		borderStyle: BaseMapBorderStyle;
		resolveAsset: (path: string) => string;
		bundledAssets?: boolean;
		cachedBaseMap: { maxZoom: number; readTile: ReadCachedTile } | null;
		layers: readonly DrawnLayer[];
		fetchTile: FetchFn | undefined;
		openingFit: OpeningViewFit | null;
		selectedAnnotationId: string | null;
		annotationDragPreview?: AnnotationDragPreview | null;
		// Whether, not which: a per-refusal signal would re-arm the retry it triggers.
		tilesMissing?: boolean;
		snapshotGeneration: number;
		onmap?: (map: MapLibreMap) => (() => void) | void;
		onclickannotation?: (hit: AnnotationHit) => void;
		onstack?: (outcomes: Readonly<Record<string, DrawnOutcome>>) => void;
		onbasemapstatus?: (status: 'drawing' | 'unavailable') => void;
		oninvalidateframe?: (by: FrameInvalidator) => void;
		onframesettled?: (generation: number) => void;
		children?: Snippet;
	} = $props();

	const exposeStack = exposeStackToBrowserTests(untrack(() => stackHandle));
	let container: HTMLDivElement;
	let map = $state<MapLibreMap | undefined>(undefined);
	let removed = false;
	let painted = '';

	// Not reactive: per-frame camera updates must not flush through $state.
	const cameraWatchers: (() => void)[] = [];

	export function onCameraMove(watcher: () => void): () => void {
		cameraWatchers.push(watcher);
		return () => {
			const at = cameraWatchers.indexOf(watcher);
			if (at !== -1) cameraWatchers.splice(at, 1);
		};
	}

	export function annotationBox(annotation: Annotation): ScreenBox | null {
		return map ? annotationMarkBox(map, annotation) : null;
	}

	// Id from properties: MapLibre mangles UUID feature ids to integers.
	export function annotationAt(at: { x: number; y: number }): AnnotationHit | null {
		const current = map;
		if (!current) return null;
		for (const drawn of layers) {
			if (isDrawnMap(drawn)) continue;
			const ids = annotationLayerIds(drawn.layer.id).filter((id) => current.getLayer(id));
			if (ids.length === 0) continue;
			const box: [[number, number], [number, number]] = [
				[at.x - hitRadius, at.y - hitRadius],
				[at.x + hitRadius, at.y + hitRadius]
			];
			for (const feature of current.queryRenderedFeatures(box, { layers: ids })) {
				const annotationId = feature.properties?.[ANNOTATION_ID_PROPERTY];
				if (typeof annotationId === 'string' && annotationId !== '') {
					return { layerId: drawn.layer.id, annotationId };
				}
			}
		}
		return null;
	}

	const paintKey = $derived(
		baseMapPaintKey({
			entryId,
			theme,
			cachedTo: cachedBaseMap?.maxZoom ?? null,
			appearance,
			borders,
			borderStyle
		})
	);

	const style = (): StyleSpecification => {
		const entry = resolveBaseMap(entryId, catalog).entry;
		if (!cachedBaseMap && !bundledAssets && !isAbsoluteUrl(entry.archive)) {
			return {
				version: 8,
				sources: {},
				layers: [
					{
						id: 'ballastella-no-base-map',
						type: 'background',
						paint: { 'background-color': themeColour('--color-base-100') || '#ffffff' }
					}
				]
			};
		}
		const built = baseMapStyle(entry, {
			theme,
			appearance,
			catalog,
			resolveAsset,
			borders,
			borderStyle,
			pixelRatio: devicePixelRatio,
			...(cachedBaseMap
				? {
						cachedTiles: {
							maxZoom: cachedBaseMap.maxZoom,
							tileTemplate: cachedBaseMapTileTemplate()
						}
					}
				: catalog.terrain && appearance.relief
					? { terrainTiles: registerTerrainProtocols(catalog.terrain) }
					: {})
		});
		if (bundledAssets) return built;
		// Without the site's glyphs and sprites, symbols would 404 or fall back to a system font.
		const withoutDisplayAssets = { ...built };
		delete withoutDisplayAssets.glyphs;
		delete withoutDisplayAssets.sprite;
		return {
			...withoutDisplayAssets,
			layers: built.layers.filter((layer) => layer.type !== 'symbol')
		};
	};

	onMount(() => {
		registerPmtilesProtocol();

		const created = new MapLibreMap({
			container,
			style: style(),
			center: [...catalog.initialView.center],
			zoom: catalog.initialView.zoom,
			maxPitch: 0,
			attributionControl: { compact: false },
			locale: { 'Map.Title': 'Base Map' }
		});
		created.addControl(new NavigationControl({}), 'bottom-left');

		const cameraMoved = (): void => {
			for (const watcher of cameraWatchers) watcher();
			oninvalidateframe?.('camera');
		};
		created.on('move', cameraMoved);
		created.on('zoom', cameraMoved);
		created.on('resize', () => oninvalidateframe?.('resize'));

		created.on('error', (event) => {
			if ((event as { sourceId?: string }).sourceId !== BASE_MAP_SOURCE_ID) return;
			onbasemapstatus?.('unavailable');
		});
		// Not `load`: it fires for the style whether the archive answered or not.
		created.on('sourcedata', (event) => {
			if (event.sourceId !== BASE_MAP_SOURCE_ID || !event.isSourceLoaded) return;
			onbasemapstatus?.('drawing');
		});

		created.on('click', (event) => {
			const hit = annotationAt(event.point);
			if (hit) onclickannotation?.(hit);
		});

		painted = paintKey;
		map = created;
		return onmap?.(created);
	});

	// Its own effect: registered before the style that reads it, and kept across setStyle.
	$effect(() => {
		const cache = cachedBaseMap;
		if (!cache) return;
		return registerCachedBaseMapTiles(cache.readTile, recordCachedBaseMapTiles());
	});

	$effect(() => {
		const wanted = paintKey;
		const current = map;
		if (current === undefined || painted === wanted) return;
		painted = wanted;
		oninvalidateframe?.('base-map');
		current.setStyle(style());
	});

	// A settled map paints nothing, so the renderer would never ask again for missing tiles.
	$effect(() => {
		if (!tilesMissing) return;
		const current = map;
		if (current === undefined) return;
		let waiting: (() => void) | undefined;
		const stop = keepAskingForMissingTiles((delivered) => {
			if (removed) return;
			waiting = () => {
				waiting = undefined;
				delivered();
			};
			current.once('render', waiting);
			current.triggerRepaint();
		});
		return () => {
			stop();
			if (waiting !== undefined) current.off('render', waiting);
		};
	});

	let fitted: OpeningViewFit | null = null;

	$effect(() => {
		fitted = applyOpeningFit(map, openingFit, fitted);
	});

	// No opacity: a rebuild refetches every tile. Theme: setStyle strips our layers.
	const stackStructure = $derived(
		JSON.stringify([
			theme,
			layers.map((stacked) =>
				isDrawnMap(stacked)
					? [stacked.layer.id, 'map', stacked.alignment, stacked.service ?? '']
					: [stacked.layer.id, 'annotation', annotationDrawKey(stacked.annotations)]
			)
		])
	);

	let stack = $state.raw<StackRender | undefined>(undefined);

	$effect(() => {
		void stackStructure;
		const current = map;
		const readTiles = fetchTile;
		const stackLayers = untrack(() => layers);
		oninvalidateframe?.('layer-stack');
		if (!current || !readTiles || stackLayers.length === 0) {
			onstack?.({});
			return;
		}

		let built: StackRender | undefined;
		const stopWaiting = whenStyleLoaded(
			current,
			() => {
				built = drawLayerStack({
					map: current,
					layers: stackLayers,
					fetchTile: readTiles,
					onBuilt: exposeStack
				});
				stack = built;
				onstack?.(built.outcomes);
			},
			() => {
				onstack?.(
					Object.fromEntries(
						stackLayers.map((entry) => [
							entry.layer.id,
							{
								status: 'refused',
								reason:
									'The Base Map has not finished loading, so there is nothing to draw this Layer ' +
									'on yet. Check your connection and reload the page.'
							} as const
						])
					)
				);
			}
		);

		return () => {
			stopWaiting();
			built?.destroy();
			stack = undefined;
			onstack?.({});
		};
	});

	const paintAnnotations = (built: StackRender, preview: AnnotationDragPreview | null): void => {
		for (const stacked of layers) {
			if (isDrawnMap(stacked)) continue;
			const annotations = stacked.annotations ?? { annotations: [] };
			built.setAnnotations(
				stacked.layer.id,
				preview?.layerId === stacked.layer.id
					? setGeometry(annotations, preview.annotationId, preview.geometry)
					: annotations
			);
		}
	};

	$effect(() => {
		const built = stack;
		if (!built) return;
		oninvalidateframe?.('annotations');
		paintAnnotations(built, annotationDragPreview);
	});

	$effect(() => {
		oninvalidateframe?.('selection');
		stack?.setSelectedAnnotation(selectedAnnotationId);
	});

	$effect(() => {
		const built = stack;
		if (!built) return;
		oninvalidateframe?.('layer-opacity');
		for (const stacked of layers) {
			if (isDrawnMap(stacked)) built.setOpacity(stacked.layer.id, stacked.layer.opacity);
		}
	});

	// Warped tiles land after the first quiet, so wait for idle twice.
	$effect(() => {
		const current = map;
		const built = stack;
		const generation = snapshotGeneration;
		if (!current) return;
		let live = true;
		void (async () => {
			await whenMapIdle(current);
			await built?.whenTilesSettled();
			await whenMapIdle(current);
			if (live) onframesettled?.(generation);
		})();
		return () => {
			live = false;
		};
	});

	export async function captureSnapshot(): Promise<Blob> {
		const current = map;
		if (!current) throw new Error('There is no Base Map on screen to capture.');
		const built = stack;
		if (built) {
			paintAnnotations(built, null);
			built.setSelectedAnnotation(null);
		}
		try {
			await whenMapIdle(current);
			return await captureMapFrame(current);
		} finally {
			if (built) {
				paintAnnotations(built, annotationDragPreview);
				built.setSelectedAnnotation(selectedAnnotationId);
			}
		}
	}

	// Created last so it is destroyed last: `remove()` breaks `getLayer` for every earlier teardown.
	$effect(() => {
		const created = map;
		if (!created) return;
		return () => {
			removed = true;
			created.remove();
		};
	});
</script>

<div class="relative h-full w-full">
	<div bind:this={container} class="h-full w-full" data-testid={testid}></div>
	{@render children?.()}
</div>
