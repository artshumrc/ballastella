<script module lang="ts">
	import type { ResourcePoint } from '@ballastella/core';

	import type { OverlayPoint } from '$lib/overlay/overlay-points';

	export type PaneOverlayPoint = OverlayPoint<ResourcePoint>;
</script>

<script lang="ts">
	import type { FetchFn, ImagePane } from '@ballastella/core';
	import { whenStyleLoaded } from '@ballastella/core/render';
	import { MapLibreMap, NavigationControl, type GeoJSONSource } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount } from 'svelte';

	import { showOverlayPoints } from '$lib/map/pane.svelte';

	import { exposeImagePaneToBrowserTests } from '$lib/browser-test-handles';
	import { imagePaneTileTemplate, registerImagePaneTiles } from './tile-protocol';

	let {
		pane,
		paneId,
		label,
		fetchTile,
		overlayPoints = [],
		maskRing = [],
		onclickpoint,
		onview,
		onready
	}: {
		pane: ImagePane;
		paneId: string;
		label: string;
		fetchTile?: FetchFn;
		overlayPoints?: PaneOverlayPoint[];
		maskRing?: readonly ResourcePoint[];
		onclickpoint?: (point: ResourcePoint) => void;
		onview?: (view: {
			mapZoom: number;
			pointer: ResourcePoint | undefined;
			tilesLoaded: boolean;
		}) => void;
		onready?: () => void;
	} = $props();

	const projection = $derived(pane.projection);
	const imageCentre = $derived({ x: pane.image.width / 2, y: pane.image.height / 2 });
	let container: HTMLDivElement;
	let map: MapLibreMap | undefined = $state.raw();
	let pointer: ResourcePoint | undefined;
	let tilesLoaded = false;
	const report = () => onview?.({ mapZoom: map?.getZoom() ?? 0, pointer, tilesLoaded });

	export function fitImage() {
		map?.fitBounds([...projection.bounds], { animate: false, padding: 16 });
	}

	export function zoomToFullResolution(point: ResourcePoint = imageCentre) {
		map?.jumpTo({
			center: pane.resourceToSynthetic(point),
			zoom: projection.fullResolutionMapZoom
		});
	}

	export function zoomBy(levels: number) {
		map?.setZoom((map?.getZoom() ?? 0) + levels);
	}

	export function centreResourcePoint(): ResourcePoint | undefined {
		const centre = map?.getCenter();
		return centre && pane.syntheticToResource(centre);
	}

	onMount(() => {
		const unregisterTiles = registerImagePaneTiles(paneId, pane, fetchTile);

		const created = new MapLibreMap({
			container,
			style: {
				version: 8,
				sources: {
					'map-image': {
						type: 'raster',
						tiles: [imagePaneTileTemplate(paneId)],
						tileSize: pane.tileSize,
						minzoom: projection.minTileZoom,
						maxzoom: projection.maxTileZoom,
						bounds: [...projection.bounds]
					}
				},
				layers: [
					{
						id: 'map-image',
						type: 'raster',
						source: 'map-image',
						paint: { 'raster-fade-duration': 0 }
					}
				]
			},
			bounds: [...projection.bounds],
			fitBoundsOptions: { padding: 16 },
			minZoom: projection.mapZoomFromTileZoom(projection.minTileZoom),
			maxZoom: projection.fullResolutionMapZoom + 4,
			renderWorldCopies: false,
			dragRotate: false,
			pitchWithRotate: false,
			attributionControl: false,
			fadeDuration: 0
		});
		const unexpose = exposeImagePaneToBrowserTests(created);

		created.addControl(new NavigationControl({ showCompass: false }), 'bottom-left');

		created.on('click', (event) => onclickpoint?.(pane.syntheticToResource(event.lngLat)));
		created.on('mousemove', (event) => {
			pointer = pane.syntheticToResource(event.lngLat);
			report();
		});
		created.on('mouseout', () => {
			pointer = undefined;
			report();
		});
		const settling = () => {
			tilesLoaded = false;
			report();
		};
		created.on('movestart', settling);
		created.on('zoom', settling);
		created.on('dataloading', settling);
		created.on('idle', () => {
			tilesLoaded = true;
			report();
		});

		created.on('move', report);
		created.once('idle', () => onready?.());

		map = created;
		report();

		return () => {
			unexpose();
			created.remove();
			unregisterTiles();
		};
	});

	showOverlayPoints<ResourcePoint>(
		() => map,
		{
			toLngLat: (point) => pane.resourceToSynthetic(point),
			fromLngLat: (lngLat) => pane.syntheticToResource(lngLat),
			datasetFor: (point) => ({ resourceX: String(point.x), resourceY: String(point.y) })
		},
		() => overlayPoints
	);

	const maskGeoJson = $derived.by(() => {
		const bounds = projection.bounds;
		const outer = [
			[bounds[0], bounds[1]],
			[bounds[2], bounds[1]],
			[bounds[2], bounds[3]],
			[bounds[0], bounds[3]],
			[bounds[0], bounds[1]]
		];
		const hole = maskRing.map((point) => {
			const at = pane.resourceToSynthetic(point);
			return [at.lng, at.lat];
		});
		if (hole.length >= 3) hole.push(hole[0] as number[]);

		return {
			type: 'FeatureCollection' as const,
			features:
				hole.length >= 4
					? [
							{
								type: 'Feature' as const,
								properties: {},
								geometry: { type: 'Polygon' as const, coordinates: [outer, hole] }
							},
							{
								type: 'Feature' as const,
								properties: {},
								geometry: { type: 'LineString' as const, coordinates: hole }
							}
						]
					: []
		};
	});

	const MASK_SOURCE = 'resource-mask';

	$effect(() => {
		const current = map;
		if (!current) return;
		const data = maskGeoJson;

		return whenStyleLoaded(current, () => {
			const source = current.getSource<GeoJSONSource>(MASK_SOURCE);
			if (source) {
				source.setData(data);
				return;
			}
			current.addSource(MASK_SOURCE, { type: 'geojson', data });
			current.addLayer({
				id: 'resource-mask-outside',
				type: 'fill',
				source: MASK_SOURCE,
				filter: ['==', ['geometry-type'], 'Polygon'],
				paint: { 'fill-color': '#000000', 'fill-opacity': 0.45 }
			});
			current.addLayer({
				id: 'resource-mask-outline',
				type: 'line',
				source: MASK_SOURCE,
				filter: ['==', ['geometry-type'], 'LineString'],
				paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [3, 2] }
			});
		});
	});
</script>

<div
	bind:this={container}
	class="h-full w-full bg-base-300"
	role="region"
	aria-label={label}
	data-testid="image-pane"
></div>
