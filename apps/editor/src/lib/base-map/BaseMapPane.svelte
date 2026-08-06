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
		showDistortion,
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
		 * `showDistortion`.
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
	 * The warped Historical Map (ADR-0011's `fetchFn` injection point).
	 *
	 * Added once the style has loaded, because `WarpedMapLayer.onAdd` needs the map's own WebGL2
	 * context. Rebuilt when the Alignment changes rather than diffed: `addGeoreferencedMap` is
	 * keyed on the document's content, so a moved Control Point is a different map to the layer
	 * and there is nothing to update in place.
	 */
	/**
	 * The drawn map, for the display-only updates below.
	 *
	 * `$state.raw` and set from inside the effect that owns the layer, so that turning the distortion
	 * overlay on can reach the same map rather than provoking a rebuild. `addGeoreferencedMap` is
	 * keyed on the document's content, so a rebuild throws away the tile cache — the user would watch
	 * their Historical Map vanish and come back for a checkbox.
	 */
	let drawn = $state.raw<{
		layer: ReturnType<typeof createWarpedMapLayer>;
		mapId: string;
	} | null>(null);

	$effect(() => {
		const current = map;
		const shown = alignment;
		const readTiles = fetchTile;
		if (!current || !shown || !readTiles) {
			// Nothing to draw. Said rather than left implicit, so the page's account of what is on the
			// Base Map cannot outlive the layer that was on it.
			drawn = null;
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
			// The distortion view is read here rather than being a dependency of this effect: it is a
			// display setting, and making it a dependency is exactly the rebuild this avoids.
			const render = showAlignment(layer, shown, distortionNow());
			drawn = render.status === 'drawn' ? { layer, mapId: render.mapId } : null;
			onwarped?.(render);
		};

		if (current.isStyleLoaded()) attach();
		else current.once('load', attach);

		return () => {
			unexpose();
			drawn = null;
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
			layers.map((drawn) =>
				isDrawnMap(drawn)
					? [drawn.layer.id, 'map', drawn.alignment]
					: [drawn.layer.id, 'annotation', drawn.layer.defaultStyle, drawn.features]
			)
		])
	);

	let stack = $state.raw<StackRender | undefined>(undefined);

	/**
	 * How long the stack waits for the Base Map's style before saying it cannot be drawn on.
	 *
	 * Long enough that a slow-but-working load is never called a failure, short enough that the wait is
	 * accounted for rather than endured in silence.
	 */
	const STYLE_WAIT_MS = 15_000;

	/**
	 * Run `attach` once the map's style is complete, and hand back the way to stop waiting.
	 *
	 * **`isStyleLoaded()` is the gate, not the event.** `styledata` fires repeatedly while a style
	 * loads — the first one arrives long before the sprites and the PMTiles header are in — so
	 * attaching on it is attaching to a map that will refuse to take a layer. The symptom was a Layer
	 * stack that never appeared at all, with nothing logged: the one `once('styledata')` fired early,
	 * found the style unloaded, and there was no second chance. Waiting on `load` instead is no better,
	 * because a theme change repaints a map that loaded minutes ago.
	 *
	 * **And a style that never completes is reported rather than waited on for ever.** The gate cannot
	 * deadlock, but it can wait indefinitely — an unreachable PMTiles archive on a reading room's wifi
	 * (SPEC story 8) — and then `attach` never runs, `onstack` is never called, and the page's own
	 * fallback has nothing to say about a Layer whose document it read perfectly well. The region read
	 * "0 of 1 Layers are drawn" with no problem text, which tells a user their work is missing and not
	 * why. `giveUp` is that account.
	 */
	const whenStyleLoaded = (
		target: MapLibreMap,
		attach: () => void,
		giveUp: () => void
	): (() => void) => {
		if (target.isStyleLoaded()) {
			attach();
			return () => undefined;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
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
		timer = setTimeout(() => {
			stop();
			giveUp();
		}, STYLE_WAIT_MS);
		return stop;
	};

	/** The Project's Layer stack (ticket 09), on the same `fetchFn` injection point (ADR-0011). */
	$effect(() => {
		// The only tracked dependencies, so that an opacity change cannot reach this effect.
		void stackStructure;
		const current = map;
		const readTiles = fetchTile;
		// Named for what it is rather than `drawn`, which is this module's warped-map state — a local
		// shadowing it meant a later edit inside this effect reaching for that state would silently get
		// an array of Layers instead.
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

		const stopWaiting = whenStyleLoaded(current, attach, () => {
			// Every Layer, because none of them can be drawn: the thing that is missing is the map they
			// would be drawn on. Said per Layer rather than once, because the list is where a user looks
			// for the Layer they cannot see.
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
		});

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
		for (const entry of layers) {
			if (isDrawnMap(entry)) built.setOpacity(entry.layer.id, entry.layer.opacity);
		}
	});

	/**
	 * Read the distortion view without registering it as a dependency of the effect above.
	 *
	 * A plain function over the prop, called from inside `attach`. Svelte tracks reads inside an
	 * effect, so reading `distortion` there directly would make every toggle rebuild the layer —
	 * which is the one thing the separate effect below exists to prevent. Untracked because the
	 * function is invoked, not because of anything about the function.
	 */
	const distortionNow = (): DistortionView => untrack(() => distortion);

	// Display only: the same map, recolourised. Runs on every change to the view *and* to the theme,
	// because the ramp is read out of the live document — a flavour change has to repaint the overlay
	// in the same action that repaints the interface (ADR-0016).
	$effect(() => {
		const shown = drawn;
		const view = distortion;
		const currentTheme = theme.current;
		const forAlignment = alignment;
		if (!shown || !forAlignment) return;
		void currentTheme;
		showDistortion(shown.layer, shown.mapId, forAlignment, view);
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
