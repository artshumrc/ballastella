<script module lang="ts">
	import type { GeoPoint } from '@ballastella/core';

	import type { OverlayPoint } from '$lib/overlay/overlay-points';

	export type BaseMapOverlayPoint = OverlayPoint<GeoPoint>;
</script>

<script lang="ts">
	import {
		BASE_MAP_CATALOG,
		DEFAULT_DISTORTION_VIEW,
		applyOpeningFit,
		openingViewFit,
		DEFAULT_BASE_MAP_APPEARANCE,
		DEFAULT_BASE_MAP_BORDER_STYLE,
		DEFAULT_BASE_MAP_BORDERS,
		type Alignment,
		type Annotation,
		type BaseMapAppearance,
		type BaseMapBorders,
		type BaseMapBorderStyle,
		type DistortionView,
		type FetchFn,
		type MapImageSource,
		type OpeningViewFit,
		type Place
	} from '@ballastella/core';
	import {
		annotationMarkBox,
		createWarpedMapLayer,
		showAlignment,
		updateAlignment,
		whenStyleLoaded,
		type DrawnLayer,
		type DrawnOutcome,
		type FrameInvalidator,
		type ReadCachedTile,
		type ScreenBox,
		type WarpedRender
	} from '@ballastella/core/render';
	import LayerStackMap, {
		type AnnotationDragPreview,
		type AnnotationHit
	} from '@ballastella/ui/LayerStackMap.svelte';
	import type { Map as MapLibreMap } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { untrack, type Snippet } from 'svelte';

	import { showOverlayPoints } from '$lib/map/pane.svelte';
	import PlaceSearch from '$lib/places/PlaceSearch.svelte';
	import { theme } from '$lib/theme.svelte';

	import {
		exposeBaseMapToBrowserTests,
		exposeWarpedLayerToBrowserTests
	} from '$lib/browser-test-handles';
	import { resolveDeploymentAsset } from './deployment-assets';

	let {
		entryId,
		appearance = DEFAULT_BASE_MAP_APPEARANCE,
		borders = DEFAULT_BASE_MAP_BORDERS,
		borderStyle = DEFAULT_BASE_MAP_BORDER_STYLE,
		cachedBaseMap = null,
		overlayPoints = [],
		alignment = null,
		alignmentSource = null,
		alignmentOpacity = 1,
		layers = [],
		openingFit = null,
		distortion = DEFAULT_DISTORTION_VIEW,
		fetchTile,
		onclickpoint,
		onclickannotation,
		onfinishshape,
		onwarped,
		onstack,
		onbasemapstatus,
		snapshotGeneration = 0,
		oninvalidateframe,
		onframesettled,
		overlayDocked = false,
		selectedAnnotationId = null,
		annotationDragPreview = null,
		controls,
		overlay
	}: {
		entryId: string;
		appearance?: BaseMapAppearance;
		borders?: BaseMapBorders;
		borderStyle?: BaseMapBorderStyle;
		cachedBaseMap?: { maxZoom: number; readTile: ReadCachedTile } | null;
		overlayPoints?: BaseMapOverlayPoint[];
		alignment?: Alignment | null;
		alignmentSource?: MapImageSource | null;
		alignmentOpacity?: number;
		layers?: readonly DrawnLayer[];
		openingFit?: OpeningViewFit | null;
		distortion?: DistortionView;
		fetchTile?: FetchFn;
		onclickpoint?: (point: GeoPoint) => void;
		onclickannotation?: (hit: AnnotationHit) => void;
		onfinishshape?: () => void;
		onwarped?: (render: WarpedRender | null) => void;
		onstack?: (outcomes: Readonly<Record<string, DrawnOutcome>>) => void;
		onbasemapstatus?: (status: 'drawing' | 'unavailable') => void;
		selectedAnnotationId?: string | null;
		annotationDragPreview?: AnnotationDragPreview | null;
		snapshotGeneration?: number;
		oninvalidateframe?: (by: FrameInvalidator) => void;
		onframesettled?: (generation: number) => void;
		controls?: Snippet;
		overlayDocked?: boolean;
		overlay?: Snippet;
	} = $props();

	let stackMap: LayerStackMap;
	let map = $state.raw<MapLibreMap | undefined>(undefined);
	// The map is removed by LayerStackMap before this component's effects are torn down.
	let mapIsGone = false;

	const drawingInProgress = (): boolean =>
		overlayPoints.some((point) => point.kind === 'annotation-draft');

	const attach = (created: MapLibreMap): (() => void) => {
		created.on('click', (event) =>
			onclickpoint?.({ lng: event.lngLat.lng, lat: event.lngLat.lat })
		);

		created.on('dblclick', (event) => {
			if (onfinishshape === undefined || !drawingInProgress()) return;
			event.preventDefault();
			onfinishshape();
		});

		created.getCanvas().addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			if (event.shiftKey) {
				onfinishshape?.();
				return;
			}
			const centre = created.getCenter();
			onclickpoint?.({ lng: centre.lng, lat: centre.lat });
		});

		map = created;
		const unexpose = exposeBaseMapToBrowserTests(created);
		return () => {
			mapIsGone = true;
			unexpose();
		};
	};

	export const onCameraMove = (watcher: () => void): (() => void) => stackMap.onCameraMove(watcher);

	export const annotationBox = (annotation: Annotation): ScreenBox | null =>
		stackMap.annotationBox(annotation);

	export const captureSnapshot = (): Promise<Blob> => stackMap.captureSnapshot();

	export function frameOnPlace(place: Place): void {
		applyOpeningFit(map, openingViewFit(place.bounds), null);
	}

	const MARK_COMFORT = 16;

	const mostReservable = (extent: number, markExtent: number) =>
		Math.max(extent - markExtent - 2 * MARK_COMFORT, 0);

	const RESERVATION_EASE_MS = 300;

	export function keepAnnotationClear(annotation: Annotation, occluder: ScreenBox | null): void {
		const current = map;
		if (current === undefined) return;
		const mark = annotationMarkBox(current, annotation);
		if (mark === null) return;
		const pane = current.getCanvas().getBoundingClientRect();
		const onThePane =
			mark.left >= pane.left + MARK_COMFORT &&
			mark.right <= pane.right - MARK_COMFORT &&
			mark.top >= pane.top + MARK_COMFORT &&
			mark.bottom <= pane.bottom - MARK_COMFORT;
		const behindThePanel =
			occluder !== null &&
			mark.right >= occluder.left - MARK_COMFORT &&
			mark.left <= occluder.right + MARK_COMFORT &&
			mark.bottom >= occluder.top - MARK_COMFORT &&
			mark.top <= occluder.bottom + MARK_COMFORT;
		if (onThePane && !behindThePanel) return;
		const markWidth = mark.right - mark.left;
		const markHeight = mark.bottom - mark.top;
		const reserved = { x: 0, y: 0 };
		if (occluder !== null) {
			const roomBesideIt = occluder.left - pane.left;
			if (roomBesideIt >= markWidth + 2 * MARK_COMFORT) {
				reserved.x = Math.min(
					pane.right - occluder.left + MARK_COMFORT,
					mostReservable(pane.width, markWidth)
				);
			} else {
				reserved.y = Math.min(
					pane.bottom - occluder.top + MARK_COMFORT,
					mostReservable(pane.height, markHeight)
				);
			}
		}
		current.easeTo({
			center: current.unproject([
				(mark.left + mark.right) / 2 - pane.left,
				(mark.top + mark.bottom) / 2 - pane.top
			]),
			offset: [-reserved.x / 2, -reserved.y / 2],
			duration: RESERVATION_EASE_MS
		});
	}

	showOverlayPoints<GeoPoint>(
		() => map,
		{
			toLngLat: (point) => point,
			fromLngLat: (lngLat) => ({ lng: lngLat.lng, lat: lngLat.lat }),
			datasetFor: (point) => ({ lng: String(point.lng), lat: String(point.lat) })
		},
		() => overlayPoints
	);

	let drawnAlignment = $state.raw<{
		layer: ReturnType<typeof createWarpedMapLayer>;
		mapId: string;
	} | null>(null);

	const hasAlignment = $derived(alignment !== null);
	const warpedReferenced = $derived(alignmentSource?.imageMode === 'referenced');
	const warpedService = $derived(
		alignmentSource?.imageMode === 'referenced' ? alignmentSource.service : ''
	);

	$effect(() => {
		const current = map;
		const drawing = hasAlignment;
		const readTiles = fetchTile;
		const referenced = warpedReferenced;
		const service = warpedService;
		const shown = untrack(() => alignment);
		if (!current || !drawing || !shown || !readTiles) {
			drawnAlignment = null;
			onwarped?.(null);
			return;
		}

		const layer = createWarpedMapLayer(readTiles);
		let unexpose = () => undefined as void;
		let added = false;

		const stopWaiting = whenStyleLoaded(current, () => {
			current.addLayer(layer);
			added = true;
			unexpose = exposeWarpedLayerToBrowserTests(current, layer);
			const render = showAlignment(layer, shown, {
				distortion: untrack(() => distortion),
				referenced,
				service
			});
			drawnAlignment = render.status === 'drawn' ? { layer, mapId: render.mapId } : null;
			onwarped?.(render);
		});

		return () => {
			stopWaiting();
			unexpose();
			drawnAlignment = null;
			if (added && !mapIsGone && current.getLayer(layer.id)) current.removeLayer(layer.id);
			onwarped?.(null);
		};
	});

	$effect(() => {
		const shown = drawnAlignment;
		void theme.current;
		if (shown && alignment) updateAlignment(shown.layer, shown.mapId, alignment, distortion);
	});

	$effect(() => {
		drawnAlignment?.layer.setOpacity(alignmentOpacity);
	});
</script>

<LayerStackMap
	bind:this={stackMap}
	testid="base-map-pane"
	stackHandle="ballastellaLayerStack"
	hitRadius={6}
	{entryId}
	catalog={BASE_MAP_CATALOG}
	theme={theme.current}
	{appearance}
	{borders}
	{borderStyle}
	resolveAsset={resolveDeploymentAsset}
	{cachedBaseMap}
	{layers}
	{fetchTile}
	{openingFit}
	{selectedAnnotationId}
	{annotationDragPreview}
	{snapshotGeneration}
	onmap={attach}
	{onclickannotation}
	{onstack}
	{onbasemapstatus}
	{oninvalidateframe}
	{onframesettled}
>
	<!-- z-[6]: with MapLibre's controls, above the leader (5), below the Inspector (7). -->
	<div
		class="absolute top-2 left-2 z-[6] flex max-w-[calc(100%-1rem)] flex-wrap items-start gap-2 {overlayDocked
			? 'lg:max-w-[max(18rem,calc(100%-21.5rem))]'
			: ''}"
	>
		<div class="w-72 max-w-full">
			<PlaceSearch testid="base-map-place-search" onchoose={frameOnPlace} />
		</div>
		{@render controls?.()}
	</div>
	{@render overlay?.()}
</LayerStackMap>
