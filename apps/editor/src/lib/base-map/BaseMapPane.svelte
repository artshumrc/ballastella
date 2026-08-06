<script module lang="ts">
	import type { GeoPoint } from '@ballastella/core';

	import type { OverlayPoint } from '$lib/overlay/overlay-points';

	/**
	 * A labelled point drawn over the Base Map at a place on the earth.
	 *
	 * The same interface the image pane takes, differing only in the coordinate space — which is
	 * the whole reason a Control Point can be drawn on both panes by one piece of code. A Control
	 * Point's earth half arrives here as `kind: 'control-point'`.
	 */
	export type BaseMapOverlayPoint = OverlayPoint<GeoPoint>;
</script>

<script lang="ts">
	import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
	import {
		BASE_MAP_CATALOG,
		DEFAULT_DISTORTION_VIEW,
		baseMapStyle,
		resolveBaseMap,
		type Alignment,
		type DistortionView,
		type FetchFn
	} from '@ballastella/core';
	import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, untrack } from 'svelte';

	import {
		drawLayerStack,
		isDrawnMap,
		type DrawnLayer,
		type DrawnOutcome,
		type StackRender
	} from '$lib/layers/stack-layers';
	import { createOverlayPointLayer, type OverlayPointLayer } from '$lib/overlay/overlay-points';
	import { theme } from '$lib/theme.svelte';
	import { exposeWarpedLayerToBrowserTests } from '$lib/warped/browser-test-handle';
	import {
		createWarpedMapLayer,
		showAlignment,
		updateAlignment,
		type WarpedRender
	} from '$lib/warped/warped-map-layer';

	import { exposeBaseMapToBrowserTests } from './browser-test-handle';
	import { resolveDeploymentAsset } from './deployment-assets';
	import { registerPmtilesProtocol } from './pmtiles-protocol';

	let {
		entryId,
		overlayPoints = [],
		alignment = null,
		layers = [],
		distortion = DEFAULT_DISTORTION_VIEW,
		fetchTile,
		onclickpoint,
		onwarped,
		onstack
	}: {
		/** The catalog id currently shown. The page owns which one that is, and its persistence. */
		entryId: string;
		overlayPoints?: BaseMapOverlayPoint[];
		/**
		 * The Alignment to draw warped over the geography, or `null` for none.
		 *
		 * Ticket 06 exercised `@allmaps/maplibre` on a bare dev route because no Alignment existed
		 * yet; this is where a warped Historical Map actually belongs — over the earth it has been
		 * aligned onto — and that route is gone.
		 */
		alignment?: Alignment | null;
		/**
		 * The Project's Layer stack, top first, with each Layer's documents already read (ticket 09).
		 *
		 * Only visible Layers belong here: hiding one is its absence from this list, so there is no
		 * second place where a Layer can be on the map but not drawn. The stack decides what draws over
		 * what, including across kinds (ADR-0002) — see `drawLayerStack`.
		 */
		layers?: readonly DrawnLayer[];
		/**
		 * What the warped Historical Map is colourised with, and whether the graticule is drawn.
		 *
		 * A working view rather than a property of the work, so it is a prop and **not** persisted
		 * (ADR-0013): a Published Site could otherwise load colourised, and a Reader would have no way
		 * to interpret it. Changing it updates the drawn map in place rather than rebuilding it — see
		 * `updateAlignment`.
		 */
		distortion?: DistortionView;
		/**
		 * Where the aligned Historical Map's tiles are read from (ADR-0011). Required for anything to
		 * be drawn warped, since a locally stored pyramid has no URL.
		 */
		fetchTile?: FetchFn;
		/** A place on the earth the user clicked. */
		onclickpoint?: (point: GeoPoint) => void;
		/**
		 * What the warped renderer did with the current Alignment, for the page to surface.
		 *
		 * `null` means nothing is being drawn — no Alignment, or the layer has just been taken off.
		 * Reported rather than left to the page to infer, because the page cannot see the layer's
		 * lifecycle: an Alignment that drops back below the minimum Control Point count removes the
		 * layer here, and without this the page would go on claiming the Historical Map was drawn from
		 * points the user had just deleted.
		 */
		onwarped?: (render: WarpedRender | null) => void;
		/**
		 * What became of each Layer of {@link layers}, keyed by Layer id, for the Layer list to
		 * surface. Reported for the same reason {@link onwarped} is: the list cannot see the map's
		 * lifecycle, and a Layer that is in the stack but has too few Control Points to draw is a normal
		 * state that has to be sayable.
		 */
		onstack?: (outcomes: Readonly<Record<string, DrawnOutcome>>) => void;
	} = $props();

	let container: HTMLDivElement;
	let map = $state<MapLibreMap | undefined>(undefined);
	let overlayLayer = $state.raw<OverlayPointLayer<GeoPoint> | undefined>(undefined);

	/**
	 * What the map is currently painted with. A plain `let`, deliberately: in runes mode it is not
	 * reactive, so the effect below can read and write it without becoming its own dependency.
	 */
	let painted = '';

	const paintKey = (id: string, currentTheme: string): string => `${id}@${currentTheme}`;

	const styleFor = (id: string): StyleSpecification =>
		baseMapStyle(resolveBaseMap(id).entry, {
			theme: theme.current,
			resolveAsset: resolveDeploymentAsset
		});

	onMount(() => {
		registerPmtilesProtocol();

		const created = new MapLibreMap({
			container,
			style: styleFor(entryId),
			center: [...BASE_MAP_CATALOG.initialView.center],
			zoom: BASE_MAP_CATALOG.initialView.zoom,
			// ODbL makes the attribution a licence condition, so it is not folded behind an "i".
			attributionControl: { compact: false },
			// MapLibre puts this on the canvas as its accessible name. A WebGL canvas announces
			// nothing on its own, and there will be a second pane (ticket 03) to tell apart.
			locale: { 'Map.Title': 'Base Map' }
		});
		created.addControl(new NavigationControl({}), 'top-right');

		created.on('click', (event) =>
			onclickpoint?.({ lng: event.lngLat.lng, lat: event.lngLat.lat })
		);

		painted = paintKey(entryId, theme.current);
		map = created;
		const unexpose = exposeBaseMapToBrowserTests(created);

		return () => {
			unexpose();
			created.remove();
			map = undefined;
		};
	});

	$effect(() => {
		const wanted = paintKey(entryId, theme.current);
		const current = map;
		if (current === undefined || painted === wanted) return;
		painted = wanted;
		// One call, driven by one signal: the flavor changes in the same action that changes the
		// interface, which is the whole of ADR-0016's "not two independent toggles that agree".
		current.setStyle(styleFor(entryId));
	});

	// Built once per map. The points themselves are updated by the effect below, so that moving one
	// Control Point does not tear down and rebuild every element — and with them every drag in
	// progress and the keyboard focus.
	$effect(() => {
		const current = map;
		if (!current) return;

		const layer = createOverlayPointLayer<GeoPoint>({
			map: current,
			toLngLat: (point) => point,
			fromLngLat: (lngLat) => ({ lng: lngLat.lng, lat: lngLat.lat }),
			// The place on the earth each point claims to be at, for the browser tests — the Base Map's
			// counterpart to the image pane's pixel coordinates.
			datasetFor: (point) => ({ lng: String(point.lng), lat: String(point.lat) })
		});
		overlayLayer = layer;

		return () => {
			overlayLayer = undefined;
			layer.destroy();
		};
	});

	$effect(() => {
		overlayLayer?.update(overlayPoints);
	});

	/**
	 * The drawn warped Historical Map, for the in-place updates below.
	 *
	 * `$state.raw` and set from inside the effect that owns the layer, so that anything short of
	 * "there is no Alignment at all" can reach the same map rather than provoking a rebuild.
	 */
	let drawnAlignment = $state.raw<{
		layer: ReturnType<typeof createWarpedMapLayer>;
		mapId: string;
	} | null>(null);

	/**
	 * Whether there is an Alignment to draw at all — the **only** thing about it that requires the
	 * layer to be built or taken off.
	 *
	 * A separate signal rather than the Alignment itself, and this is the load-bearing part.
	 * `AlignmentWorkspace` passes a `$derived` over `AlignmentPairing.alignment`, which is a getter
	 * returning a fresh object on every read — so an effect that depended on the prop was rebuilding
	 * the whole layer on every moved Control Point, every dragged or inserted mask vertex, every mask
	 * reset and every transformation change.
	 *
	 * Two things were wrong with that. It threw away every renderer and refetched every warped tile
	 * per gesture — the exact cost this file already refuses to pay for a checkbox — on a false
	 * premise: `gcps`, `resourceMask` and `transformationType` are map options upstream applies in
	 * place. And it silently stopped the distortion overlay colourising, because a map *built* with a
	 * `distortionMeasure` is never coloured by it (see `reassertDistortionMeasure`). So a student who
	 * switched on "Colour the Historical Map by how much it is stretched" and then changed the
	 * transformation type watched the map redraw uncoloured, with the checkbox still checked and
	 * nothing thrown.
	 */
	const hasAlignment = $derived(alignment !== null);

	/**
	 * The warped Historical Map (ADR-0011's `fetchFn` injection point).
	 *
	 * Added once the style has loaded, because `WarpedMapLayer.onAdd` needs the map's own WebGL2
	 * context. Built and taken off with {@link hasAlignment} and nothing else; what the map is drawn
	 * *from* is applied in place by the effect at the bottom of this file.
	 */
	$effect(() => {
		const current = map;
		const drawing = hasAlignment;
		const readTiles = fetchTile;
		// Read untracked: the Alignment's *content* is applied in place below, so making it a
		// dependency here is the rebuild this effect exists not to do.
		const shown = untrack(() => alignment);
		if (!current || !drawing || !shown || !readTiles) {
			// Nothing to draw. Said rather than left implicit, so the page's account of what is on the
			// Base Map cannot outlive the layer that was on it.
			drawnAlignment = null;
			onwarped?.(null);
			return;
		}

		const layer = createWarpedMapLayer(readTiles);
		let unexpose = () => undefined as void;
		let added = false;

		const attach = () => {
			if (!current.isStyleLoaded()) return;
			current.addLayer(layer);
			added = true;
			unexpose = exposeWarpedLayerToBrowserTests(current, layer);
			// The distortion view is read untracked for the same reason the Alignment is: it is a display
			// setting, and making it a dependency is exactly the rebuild this avoids.
			const render = showAlignment(layer, shown, distortionNow());
			drawnAlignment = render.status === 'drawn' ? { layer, mapId: render.mapId } : null;
			onwarped?.(render);
		};

		if (current.isStyleLoaded()) attach();
		else current.once('load', attach);

		return () => {
			unexpose();
			drawnAlignment = null;
			// `setStyle` on a theme change removes our layer along with everything else, so removing
			// one that has already gone has to be survivable rather than an exception in a teardown.
			if (added && current.getLayer(layer.id)) current.removeLayer(layer.id);
			onwarped?.(null);
		};
	});

	/**
	 * What about the Layer stack requires it to be rebuilt: which Layers draw, in what order, and from
	 * which documents.
	 *
	 * **Opacity is deliberately absent.** A rebuild throws away every renderer and refetches every
	 * tile, and opacity is dragged — so including it would make a continuous gesture the most
	 * expensive thing in the application, which is the shape ADR-0017 rule 1 exists to prevent. The
	 * theme is present because `setStyle` takes our layers off the map with everything else.
	 */
	const stackStructure = $derived(
		JSON.stringify([
			theme.current,
			layers.map((stacked) =>
				isDrawnMap(stacked)
					? [stacked.layer.id, 'map', stacked.alignment]
					: [stacked.layer.id, 'annotation', stacked.layer.defaultStyle, stacked.features]
			)
		])
	);

	let stack = $state.raw<StackRender | undefined>(undefined);

	/**
	 * Run `attach` once the map's style is complete, and hand back the way to stop waiting.
	 *
	 * **`isStyleLoaded()` is the gate, not the event.** `styledata` fires repeatedly while a style
	 * loads — the first one arrives long before the sprites and the PMTiles header are in — so
	 * attaching on it is attaching to a map that will refuse to take a layer. The symptom was a Layer
	 * stack that never appeared at all, with nothing logged: the one `once('styledata')` fired early,
	 * found the style unloaded, and there was no second chance. Waiting on `load` instead is no better,
	 * because a theme change repaints a map that loaded minutes ago.
	 */
	const whenStyleLoaded = (target: MapLibreMap, attach: () => void): (() => void) => {
		if (target.isStyleLoaded()) {
			attach();
			return () => undefined;
		}
		const stop = () => {
			target.off('styledata', retry);
			target.off('idle', retry);
		};
		const retry = () => {
			if (!target.isStyleLoaded()) return;
			stop();
			attach();
		};
		target.on('styledata', retry);
		// `idle` as well, because a style that is already complete when the last `styledata` fires
		// leaves nothing else to listen for.
		target.on('idle', retry);
		return stop;
	};

	/** The Project's Layer stack (ticket 09), on the same `fetchFn` injection point (ADR-0011). */
	$effect(() => {
		// The only tracked dependencies, so that an opacity change cannot reach this effect.
		void stackStructure;
		const current = map;
		const readTiles = fetchTile;
		const stackLayers = untrack(() => layers);
		if (!current || !readTiles || stackLayers.length === 0) {
			onstack?.({});
			return;
		}

		let built: StackRender | undefined;
		const attach = () => {
			built = drawLayerStack({ map: current, layers: stackLayers, fetchTile: readTiles });
			stack = built;
			onstack?.(built.outcomes);
		};

		const stopWaiting = whenStyleLoaded(current, attach);

		return () => {
			stopWaiting();
			built?.destroy();
			stack = undefined;
			onstack?.({});
		};
	});

	/** Opacity, applied in place — see {@link stackStructure} for why this is not a rebuild. */
	$effect(() => {
		const built = stack;
		if (!built) return;
		for (const stacked of layers) {
			if (isDrawnMap(stacked)) built.setOpacity(stacked.layer.id, stacked.layer.opacity);
		}
	});

	/**
	 * Read the distortion view without registering it as a dependency of the effect that owns the
	 * layer.
	 *
	 * A plain function over the prop, called from inside `attach`. Svelte tracks reads inside an
	 * effect, so reading `distortion` there directly would make every toggle rebuild the layer —
	 * which is the one thing the separate effect below exists to prevent. Untracked because the
	 * function is invoked, not because of anything about the function.
	 */
	const distortionNow = (): DistortionView => untrack(() => distortion);

	/**
	 * The same map, redrawn from the Alignment as it now stands and coloured as the view now asks.
	 *
	 * **Everything that is not "is there an Alignment at all" happens here**, in place: a moved Control
	 * Point, a dragged or inserted mask vertex, a reset mask, a changed transformation type, the
	 * distortion overlay, and the graticule. The theme is a dependency because the ramp is read out of
	 * the live document — a flavour change has to repaint the overlay in the same action that repaints
	 * the interface (ADR-0016).
	 */
	$effect(() => {
		const shown = drawnAlignment;
		const view = distortion;
		const currentTheme = theme.current;
		const forAlignment = alignment;
		if (!shown || !forAlignment) return;
		void currentTheme;
		updateAlignment(shown.layer, shown.mapId, forAlignment, view);
	});
</script>

<!--
	MapLibre gives the canvas `tabindex="0"`, a `role`, and an accessible name, and handles arrow-key
	panning and +/- zooming itself, so the pane is keyboard operable without anything added here.

	The testid names this container specifically because MapLibre appends overlay points *into* it,
	and both panes' points use identical markup — so telling one pane's Control Points from the
	other's is a question about which container they are in. Distinguishing them by anything else
	(canvas order, negation against the image pane's testid) is the kind of selector that passes until
	the layout moves.
-->
<div bind:this={container} class="h-full w-full" data-testid="base-map-pane"></div>
