<script module lang="ts">
	import type { ResourcePoint } from '@ballastella/core';

	import type { OverlayPoint } from '$lib/overlay/overlay-points';

	/**
	 * A labelled point drawn over the pane at an image pixel.
	 *
	 * Deliberately not called a marker and deliberately not called a registration point.
	 * CONTEXT.md lists **marker** under the words to avoid for a Control Point and **register**
	 * under those to avoid for an Alignment, and CONTRIBUTING makes that binding on the code as
	 * well as the UI. It matters more than usual here: ticket 07 adds Control Points to this pane
	 * through this exact interface, so a banned word in the name would become the name of the
	 * seam Control Points arrive on, and renaming it then is a cross-ticket change.
	 *
	 * `reference` and `reported` are **not** Control Points. A Control Point pairs an image pixel
	 * with a place on the earth and is incomplete without both halves (ADR-0022); those two are
	 * one-sided annotations of the pane's own coordinate space — `reference` for the fixed points
	 * whose pixel is known in advance, `reported` for the pixel the user last asked about.
	 *
	 * A Control Point's image half arrives here as `kind: 'control-point'`, through this same
	 * interface and not a parallel one, which is what ticket 03 renamed `PaneMarker` for.
	 */
	export type PaneOverlayPoint = OverlayPoint<ResourcePoint>;
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

	import type { FetchFn, ImagePane } from '@ballastella/core';
	import { MapLibreMap, NavigationControl, type GeoJSONSource } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount } from 'svelte';

	import { createOverlayPointLayer, type OverlayPointLayer } from '$lib/overlay/overlay-points';

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
		/** Identifies this pane's pyramid to the tile protocol. */
		paneId: string;
		/** Accessible name for the map region. */
		label: string;
		/**
		 * Where this pyramid's tiles are read from (ADR-0011). `createStoreImageFetch(...)` for a
		 * Historical Map in the user's Project; left out only for one really served over HTTP.
		 */
		fetchTile?: FetchFn;
		overlayPoints?: PaneOverlayPoint[];
		/**
		 * The Resource Mask to draw over the image, as a ring of image pixels, or `[]` for none.
		 *
		 * Drawn as the *inverse* — the part of the sheet the mask leaves out is dimmed, and what it
		 * keeps stays as it is. That is the direction that answers the user's question: the mask is
		 * "which part of this is the map", so what has to be legible is the margins and the cartouche
		 * falling away, not a rectangle drawn on top of the map.
		 */
		maskRing?: readonly ResourcePoint[];
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
	let overlayLayer: OverlayPointLayer<ResourcePoint> | undefined = $state.raw();
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
		const unregisterTiles = registerImagePaneTiles(paneId, pane, fetchTile);

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

		// Zoom sits at the bottom-left in every map pane in this application, and there is no compass
		// here for the same reason `dragRotate` is off.
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

	// Overlay points live in a keyed layer shared with the Base Map pane, so a Control Point is
	// drawn the same way on both panes by the same code. Reconciled rather than rebuilt, because a
	// Control Point is draggable and focusable and rebuilding drops the gesture — see
	// `overlay-points.ts`.
	$effect(() => {
		const current = map;
		if (!current) return;

		const layer = createOverlayPointLayer<ResourcePoint>({
			map: current,
			// The synthetic geography stays inside this component: the layer only ever sees the image
			// pixels this pane speaks, and converts through these two (ADR-0005).
			toLngLat: (point) => pane.resourceToSynthetic(point),
			fromLngLat: (lngLat) => pane.syntheticToResource(lngLat),
			// The image pixel each point claims to be at, for the browser tests. A reference point
			// states its pixel, the test clicks it, and the pane has to report the same pixel back —
			// which goes out through `resourceToSynthetic` and comes back through `syntheticToResource`,
			// two different directions rather than one function inverted by its own inverse.
			datasetFor: (point) => ({ resourceX: String(point.x), resourceY: String(point.y) })
		});
		overlayLayer = layer;

		return () => {
			overlayLayer = undefined;
			layer.destroy();
		};
	});

	// A second effect, on purpose: the layer above is built once per map, and this one runs on every
	// change to the points. Folding them together would tear down and rebuild every element — and
	// therefore every drag and every focus — whenever a single coordinate moved.
	$effect(() => {
		overlayLayer?.update(overlayPoints);
	});

	/**
	 * The Resource Mask, as a dimmed hole in the sheet.
	 *
	 * One polygon with two rings: the whole image, then the mask as a hole in it. So the paint covers
	 * exactly the part the mask leaves out, and there is no second layer whose extent has to agree
	 * with the first's. A ring of fewer than three vertices is not an area and is drawn as nothing —
	 * which cannot arise from the app (`MINIMUM_MASK_VERTICES`) but can arise from a pane that has
	 * been handed `[]` because no Alignment has loaded yet.
	 */
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
		// GeoJSON rings are closed, and the model's is not — the closing vertex is redundant data that
		// upstream's own parser strips (SPEC story 91), so it is added here rather than stored.
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
								// The outline itself, so the mask is visible as a line and not only as the edge of
								// the dimming — on a dark scan the dimming alone is nearly invisible.
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

		const install = () => {
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
				// Black at 45%, with the white dashed outline below carrying the meaning. An earlier
				// comment here claimed the colour was "deliberately not black" for a dark theme, sitting
				// directly above `#000000` — the reasoning was right and the code never followed it, which
				// is worse than either alone. What actually makes the exclusion read on a dark scan is the
				// **outline**, not the scrim: a dashed white line is visible over any scan, where a scrim of
				// any colour is only visible against its opposite. So the scrim is a plain dim and the
				// outline is the signal.
				paint: { 'fill-color': '#000000', 'fill-opacity': 0.45 }
			});
			current.addLayer({
				id: 'resource-mask-outline',
				type: 'line',
				source: MASK_SOURCE,
				filter: ['==', ['geometry-type'], 'LineString'],
				paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [3, 2] }
			});
		};

		if (current.isStyleLoaded()) install();
		else current.once('load', install);
	});
</script>

<div
	bind:this={container}
	class="h-full w-full bg-base-300"
	role="region"
	aria-label={label}
	data-testid="image-pane"
></div>

<!--
	The overlay points' styles are in `routes/layout.css`, not here. Their elements are created
	imperatively for MapLibre so nothing scoped can reach them, and the Base Map pane draws the same
	points — rules shipped with this component would be missing on a route that mounts only that one.
-->
