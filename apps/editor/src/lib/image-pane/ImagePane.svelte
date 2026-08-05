<script module lang="ts">
	import type { ResourcePoint as MarkerPoint } from '@ballastella/core';

	export type PaneMarker = {
		point: MarkerPoint;
		label: string;
		kind: 'registration' | 'reported';
	};
</script>

<script lang="ts">
	// The image pane: a Historical Map's own pyramid in a MapLibre map, in image pixel space.
	//
	// Nothing here is warped. The pane shows the image unwarped in its own coordinate system,
	// laid on the synthetic projection `@ballastella/core` computes for the pyramid; warped
	// rendering through `@allmaps/maplibre` is a different layer entirely.
	//
	// Every coordinate that leaves this component is an image pixel, never a lng/lat. The
	// synthetic geography is an implementation detail of the fact that MapLibre is Web Mercator
	// only (ADR-0005), and letting it escape is how it would end up stored somewhere.

	import type { ImagePane, ResourcePoint } from '@ballastella/core';
	import { MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount } from 'svelte';

	import { imagePaneTileTemplate, registerImagePaneTiles } from './tile-protocol';

	let {
		pane,
		paneId,
		label,
		markers = [],
		onclickpoint,
		onview,
		onready
	}: {
		pane: ImagePane;
		/** Identifies this pane's pyramid to the tile protocol. */
		paneId: string;
		/** Accessible name for the map region. */
		label: string;
		markers?: PaneMarker[];
		/** An image pixel the user clicked. */
		onclickpoint?: (point: ResourcePoint) => void;
		/**
		 * The current view: the map zoom, the image pixel the pointer is over (or `undefined`
		 * when it leaves the pane), and whether every tile the view needs has arrived.
		 */
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

	/** Frames the whole image. */
	export function fitImage() {
		map?.fitBounds([...projection.bounds], { animate: false, padding: 16 });
	}

	/** Puts `point` at the centre of the view, at one image pixel per map pixel. */
	export function zoomToFullResolution(point: ResourcePoint = imageCentre) {
		map?.jumpTo({
			center: pane.resourceToSynthetic(point),
			zoom: projection.fullResolutionMapZoom
		});
	}

	/** Steps the zoom without animating, so a caller can walk the pyramid a level at a time. */
	export function zoomBy(levels: number) {
		map?.setZoom((map?.getZoom() ?? 0) + levels);
	}

	/** The image pixel at the centre of the view. */
	export function centreResourcePoint(): ResourcePoint | undefined {
		const centre = map?.getCenter();
		return centre && pane.syntheticToResource(centre);
	}

	onMount(() => {
		const unregisterTiles = registerImagePaneTiles(paneId, pane);

		const created = new MapLibreMap({
			container,
			style: {
				version: 8,
				// No glyphs and no sprite: nothing in this style needs them, and pointing at a
				// remote font endpoint would put a network dependency in the middle of a pane whose
				// whole content is local (user story 8).
				sources: {
					'historical-map': {
						type: 'raster',
						tiles: [imagePaneTileTemplate(paneId)],
						tileSize: pane.tileSize,
						// Source zooms are tile-grid zooms, which is what the pyramid is indexed by.
						minzoom: projection.minTileZoom,
						maxzoom: projection.maxTileZoom,
						// Keeps MapLibre from asking for tiles the pyramid does not have.
						bounds: [...projection.bounds]
					}
				},
				layers: [
					{
						id: 'historical-map',
						type: 'raster',
						source: 'historical-map',
						// No cross-fade: a half-faded tile is a half-visible coordinate.
						paint: { 'raster-fade-duration': 0 }
					}
				]
			},
			bounds: [...projection.bounds],
			fitBoundsOptions: { padding: 16 },
			// The coarsest level of the pyramid is the floor. Deliberately no `maxBounds`: it
			// clamps how far out the view can go, and on a small pyramid that makes the coarsest
			// levels unreachable.
			minZoom: projection.mapZoomFromTileZoom(projection.minTileZoom),
			// Two levels past full resolution, so a Control Point can be placed on a feature
			// smaller than a pixel of the scan.
			maxZoom: projection.fullResolutionMapZoom + 2,
			renderWorldCopies: false,
			// There is no north in image pixel space.
			dragRotate: false,
			pitchWithRotate: false,
			attributionControl: false,
			fadeDuration: 0
		});

		created.addControl(new NavigationControl({ showCompass: false }), 'top-right');

		created.on('click', (event) => onclickpoint?.(pane.syntheticToResource(event.lngLat)));
		created.on('mousemove', (event) => {
			pointer = pane.syntheticToResource(event.lngLat);
			report();
		});
		created.on('mouseout', () => {
			pointer = undefined;
			report();
		});
		// Whether the view is settled is real information for the user — a pane still fetching
		// tiles is showing a coarser level than the one asked for. It is also what lets a test
		// wait for a zoom to finish arriving rather than guess at a timeout.
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
			created.remove();
			unregisterTiles();
		};
	});

	// Markers are rebuilt wholesale rather than diffed: there are a handful of them, and a
	// stale marker is a coordinate claim that is no longer true.
	$effect(() => {
		const current = map;
		if (!current) {
			return;
		}

		const handles = markers.map(({ point, label: markerLabel, kind }) => {
			const element = document.createElement('div');
			element.className = `pane-marker pane-marker-${kind}`;
			element.dataset.testid = `pane-marker-${kind}`;
			element.dataset.resourceX = String(point.x);
			element.dataset.resourceY = String(point.y);
			element.title = markerLabel;
			// The same information is in the page as text; announcing it twice is noise.
			element.setAttribute('aria-hidden', 'true');

			return new Marker({ element, anchor: 'center' })
				.setLngLat(pane.resourceToSynthetic(point))
				.addTo(current);
		});

		return () => handles.forEach((handle) => handle.remove());
	});
</script>

<div
	bind:this={container}
	class="h-full w-full bg-base-300"
	role="region"
	aria-label={label}
	data-testid="image-pane"
></div>

<style>
	/* Marker elements are created imperatively by MapLibre, so their styles cannot be scoped. */
	:global(.pane-marker) {
		/* Clicks must reach the map underneath: a marker is a label, not a target. */
		pointer-events: none;
		box-sizing: border-box;
		width: 17px;
		height: 17px;
		border-radius: 9999px;
	}

	:global(.pane-marker-registration) {
		border: 2px solid oklch(0.55 0.22 25);
		box-shadow: 0 0 0 1px oklch(1 0 0 / 0.85);
	}

	:global(.pane-marker-reported) {
		border: 3px solid oklch(0.6 0.19 250);
		box-shadow: 0 0 0 1px oklch(1 0 0 / 0.85);
	}
</style>
