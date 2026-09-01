<script module lang="ts">
	import type { AnnotationGeometry, GeoPoint } from '@ballastella/core';

	import type { OverlayPoint } from '$lib/overlay/overlay-points';

	/**
	 * A labelled point drawn over the Base Map at a place on the earth.
	 *
	 * The same interface the image pane takes, differing only in the coordinate space — which is
	 * the whole reason a Control Point can be drawn on both panes by one piece of code. A Control
	 * Point's earth half arrives here as `kind: 'control-point'`.
	 */
	export type BaseMapOverlayPoint = OverlayPoint<GeoPoint>;

	export type AnnotationDragPreview = {
		layerId: string;
		annotationId: string;
		geometry: AnnotationGeometry;
	};
</script>

<script lang="ts">
	import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
	import {
		ANNOTATION_ID_PROPERTY,
		BASE_MAP_CATALOG,
		DEFAULT_DISTORTION_VIEW,
		applyOpeningFit,
		BASE_MAP_SOURCE_ID,
		baseMapStyle,
		openingViewFit,
		DEFAULT_BASE_MAP_APPEARANCE,
		resolveBaseMap,
		setGeometry,
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
	// The browser-only render layer, on a subpath of its own because this barrel's own is Node-safe
	// and this is not — see the note at the bottom of `packages/core/src/index.ts`.
	import {
		annotationDrawKey,
		annotationLayerIds,
		annotationMarkBox,
		cachedBaseMapTileTemplate,
		captureMapFrame,
		createWarpedMapLayer,
		drawLayerStack,
		isDrawnMap,
		registerCachedBaseMapTiles,
		registerPmtilesProtocol,
		registerTerrainProtocols,
		showAlignment,
		updateAlignment,
		type DrawnLayer,
		type DrawnOutcome,
		type ReadCachedTile,
		type ScreenBox,
		type StackRender,
		type WarpedRender
	} from '@ballastella/core/render';
	import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, untrack, type Snippet } from 'svelte';

	import { warpedAddressOf } from '$lib/alignment/map-source.svelte.js';
	import { exposeLayerStackToBrowserTests } from '$lib/layers/browser-test-handle';
	import { createOverlayPointLayer, type OverlayPointLayer } from '$lib/overlay/overlay-points';
	import PlaceSearch from '$lib/places/PlaceSearch.svelte';
	import { theme } from '$lib/theme.svelte';
	import { exposeWarpedLayerToBrowserTests } from '$lib/warped/browser-test-handle';

	import { exposeBaseMapToBrowserTests, recordCachedBaseMapTiles } from './browser-test-handle';
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
		onsnapshotready,
		overlayDocked = false,
		selectedAnnotationId = null,
		annotationDragPreview = null,
		controls,
		overlay
	}: {
		/** The catalog id currently shown. The page owns which one that is, and its persistence. */
		entryId: string;
		/**
		 * How the geography is drawn: streets, relief, muted colours. The Project's, owned and
		 * persisted by the page exactly as {@link entryId} is.
		 */
		appearance?: BaseMapAppearance;
		/**
		 * Which administrative boundaries the geography draws. The Project's, owned and persisted by
		 * the page exactly as {@link entryId} is — this pane only paints what it is handed.
		 */
		borders?: BaseMapBorders;
		/** How those boundaries are drawn. The Project's, handed over with the level beside it. */
		borderStyle?: BaseMapBorderStyle;
		/**
		 * Draw the Base Map from the Workspace's own tile cache instead of from the entry's archive
		 * (ADR-0025), or `null` to read the archive as usual.
		 *
		 * `maxZoom` is the depth the cache was filled to — the source archive's own maximum — and it is
		 * load-bearing: without it MapLibre asks for tiles past the pyramid, every one comes back empty,
		 * and the map goes blank at exactly the zoom the user was told works offline.
		 *
		 * The pane decides nothing about *whether* the cache is complete. That is the page's question and
		 * `offlineCoverage`'s answer, because a partial cache draws holes and reports no error — which is
		 * precisely why the Project-level claim is computed from the files rather than from the renderer.
		 */
		cachedBaseMap?: { maxZoom: number; readTile: ReadCachedTile } | null;
		overlayPoints?: BaseMapOverlayPoint[];
		/**
		 * The Alignment to draw warped over the geography, or `null` for none.
		 *
		 * A warped Map Image belongs over the earth it has been aligned onto, which is what this pane
		 * draws. No route in this app puts `@allmaps/maplibre` on screen outside an Alignment.
		 */
		alignment?: Alignment | null;
		/**
		 * Where {@link alignment}'s Map Image is served from, or `null` when the caller cannot say.
		 *
		 * ─────────────────────────────────────────────────────────────────────────────────────────
		 * ⚠ **WITHOUT THIS, A REFERENCED MAP DRAWS NOTHING AND NOTHING SAYS SO.**
		 *
		 * `showAlignment` builds the renderer's document from either the ADR-0004 placeholder or the
		 * Library's own service, and `@allmaps/maplibre` fetches every warped tile from whichever id it
		 * finds there. This pane passed neither, so the alignment route drew a referenced map from the
		 * placeholder — through the ADR-0011 shim, into a Workspace that by definition holds no pyramid
		 * for it. Zero tiles, no request on the wire to notice, and `data-warped-status="drawn"`.
		 *
		 * The stack path (`drawLayerStack`) has always carried the service; only the single-Alignment
		 * path did not, because at the time nothing that used it could observe the answer. The
		 * alignment route can — `EditorSession.mapImageSource` — and it is the same value that
		 * decides the pane's tile base and the Alignment's `resource.id`, so the three cannot disagree.
		 *
		 * `null` means `referenced: false`, which is right for any caller that genuinely cannot observe
		 * it, since refusing on a guess would refuse every local copy.
		 */
		alignmentSource?: MapImageSource | null;
		/**
		 * How opaque the warped {@link alignment} is drawn, `0` to `1`.
		 *
		 * A display setting, applied in place and never persisted (ADR-0002/ADR-0013), for the reason
		 * the alignment route needs it: a solved Alignment covers the geography it was solved against,
		 * so at full opacity the author can no longer see the feature they were about to place the next
		 * Control Point on. `0` leaves the layer built and drawing nothing, which keeps the distortion
		 * measure and the renderer's own account of itself alive while the earth is uncovered.
		 */
		alignmentOpacity?: number;
		/**
		 * The Project's Layer stack, top first, with each Layer's documents already read.
		 *
		 * Only visible Layers belong here: hiding one is its absence from this list, so there is no
		 * second place where a Layer can be on the map but not drawn. The stack decides what draws over
		 * what, including across kinds (ADR-0002) — see `drawLayerStack`.
		 */
		layers?: readonly DrawnLayer[];
		/**
		 * Frame the map on a box, once (ADR-0026).
		 *
		 * **Applied once per object identity, and the page owns how many identities there are.** That
		 * split is the whole of ADR-0026's "fit once, on open, never again": this pane cannot know
		 * whether new bounds mean "the Project has just opened" or "a Layer was toggled", so it does not
		 * guess — it applies exactly what it is handed, once each, and the page hands it one for the
		 * open and one more for each press of "Fit to this Project". A page that put the bounds in a
		 * `$derived` would produce a new object per keystroke and pull the map out from under the user;
		 * that is a defect in the page, and it is where the once-only contract can be read.
		 *
		 * `null` leaves the map wherever it was constructed — `BASE_MAP_CATALOG.initialView`, the
		 * deployment default, which is what a Project with nothing on the earth opens on.
		 */
		openingFit?: OpeningViewFit | null;
		/**
		 * What the warped Map Image is colourised with, and whether the graticule is drawn.
		 *
		 * A working view rather than a property of the work, so it is a prop and **not** persisted
		 * (ADR-0013): a Published Site could otherwise load colourised, and a Reader would have no way
		 * to interpret it. Changing it updates the drawn map in place rather than rebuilding it — see
		 * `updateAlignment`.
		 */
		distortion?: DistortionView;
		/**
		 * Where the aligned Map Image's tiles are read from (ADR-0011). Required for anything to
		 * be drawn warped, since a locally stored pyramid has no URL.
		 */
		fetchTile?: FetchFn;
		/**
		 * A place on the earth the user asked for — a click on the pane, or Enter while it has focus.
		 *
		 * Enter reports the **centre of the map**, which is what makes drawing an Annotation reachable
		 * without a pointer: MapLibre already pans the canvas with the arrow keys and zooms with `+` and
		 * `-`, so "move the map to the place, then press Enter" is a complete path with nothing new to
		 * learn. Every drawing tool must be operable by keyboard, and a tool that can be *selected* but
		 * not *used* by keyboard would satisfy the letter of that only.
		 */
		onclickpoint?: (point: GeoPoint) => void;
		/**
		 * An Annotation the user clicked, by its Layer and its own id.
		 *
		 * Reported **in addition to** {@link onclickpoint} rather than instead of it, because which one
		 * matters depends on the tool the page is holding: with a drawing tool active the click places a
		 * vertex and the Annotation underneath is irrelevant, and with the select tool it is the other
		 * way round. The page knows which; the pane does not, and guessing here would make the pane hold
		 * a copy of the toolbar's state.
		 *
		 * **Where on the earth the click landed is not reported with it**, and no longer needs to be:
		 * nothing is drawn over the map for an Annotation. The click opens that Annotation's row in the
		 * sidebar, which is where an Annotation is read, and a row has no anchor.
		 */
		onclickannotation?: (hit: { layerId: string; annotationId: string }) => void;
		/**
		 * The gesture is over: a double-click, or Shift+Enter while the pane has focus.
		 *
		 * The pointer and keyboard routes to the same act, on the pane rather than only on the Finish
		 * button, because a user drawing a nine-vertex shape is looking at the map and not at the
		 * toolbar.
		 *
		 * A double-click reaches this **only while a shape is part-drawn**, because suppressing
		 * MapLibre's own double-click zoom is the price of it — see {@link drawingInProgress}.
		 */
		onfinishshape?: () => void;
		/**
		 * What the warped renderer did with the current Alignment, for the page to surface.
		 *
		 * `null` means nothing is being drawn — no Alignment, or the layer has just been taken off.
		 * Reported rather than left to the page to infer, because the page cannot see the layer's
		 * lifecycle: an Alignment that drops back below the minimum Control Point count removes the
		 * layer here, and without this the page would go on claiming the Map Image was drawn from
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
		/**
		 * Whether the Base Map's own source is drawing, and why not when it is not.
		 *
		 * ─────────────────────────────────────────────────────────────────────────────────────
		 * NOBODY LISTENED TO `map.on('error')`, AND THAT IS HOW AN OUTAGE READS AS A BROKEN TOOL
		 *
		 * MapLibre's response to a source it cannot load is an `error` event and an empty pane. With
		 * nothing listening, the application had exactly one rendering of "the archive answered 404",
		 * "the archive is not there at all" and "your Project failed to draw" — a grey rectangle. On
		 * 2026-08-07 the first of those happened for real (ADR-0025 having predicted it), and there
		 * was no way for a scholar to tell which they were looking at.
		 *
		 * Reported rather than rendered here, because *what to say* is the page's question: this pane
		 * is used by the alignment route as well as the Project screen, and the screen already owns
		 * the offline and fallback notices this has to sit beside without contradicting.
		 *
		 * `'drawing'` is sent when the source loads, so this is a state and not a one-way alarm — an
		 * archive that recovers, or a switch to a Base Map that works, has to clear the notice rather
		 * than leave a stale accusation on the screen.
		 */
		onbasemapstatus?: (status: 'drawing' | 'unavailable') => void;
		/**
		 * Which Annotation is selected, so the map draws that one more strongly.
		 *
		 * A prop rather than something the pane works out, because selection is the page's state: the
		 * sidebar, the map and the leader all read the same one value. Applied in place like opacity —
		 * see {@link stackStructure} for why a selection must not rebuild the stack.
		 */
		selectedAnnotationId?: string | null;
		annotationDragPreview?: AnnotationDragPreview | null;
		/**
		 * Whether the frame on screen is complete enough to be captured — see {@link captureSnapshot}.
		 *
		 * A callback rather than a bound value because the answer arrives from two asynchronous
		 * sources at once, and the page's only use for it is to enable a control.
		 */
		onsnapshotready?: (ready: boolean) => void;
		/**
		 * Page-owned controls placed beside the place search over the map.
		 *
		 * The Project screen uses this for its Base Map choice and its explicit framing action. They
		 * belong to the Project, not to every consumer of this pane.
		 */
		controls?: Snippet;
		/**
		 * Whether {@link overlay} is docked into the pane's top-right corner above `lg`.
		 *
		 * The pane cannot see it: the overlay is the page's snippet, positioned by the page's own
		 * element, and it is drawn *above* this pane's control row. So the page says, and the row stops
		 * short of that column while it is there — see the row's own note for the measurement.
		 */
		overlayDocked?: boolean;
		/**
		 * What the page draws *over* this pane, inside the pane's own positioned container.
		 *
		 * The Annotation Inspector is what this is for (ADR-0035): it is docked over the map, so it has
		 * to be positioned against the box the map fills rather than against the column the map is in —
		 * and the page owns what is in it, because a panel of the scholar's Annotations is no business of
		 * a map pane. The snippet's own element carries the position and the `z-index`; nothing here
		 * places it.
		 */
		overlay?: Snippet;
	} = $props();

	let container: HTMLDivElement;
	let map = $state<MapLibreMap | undefined>(undefined);
	let overlayLayer = $state.raw<OverlayPointLayer<GeoPoint> | undefined>(undefined);

	/**
	 * What the map is currently painted with. A plain `let`, deliberately: in runes mode it is not
	 * reactive, so the effect below can read and write it without becoming its own dependency.
	 */
	let painted = '';

	/**
	 * What the map is painted from, as one string. The cache is in it because switching between the
	 * archive and the Workspace's tiles is a different *source*, which only `setStyle` can change.
	 */
	const paintKey = (
		id: string,
		currentTheme: string,
		cachedTo: number | null,
		drawn: BaseMapAppearance,
		drawnBorders: BaseMapBorders,
		drawnStyle: BaseMapBorderStyle
	): string =>
		// The appearance and the styling are in the key as their own values rather than as objects,
		// because this is compared as a string: a repaint that missed a colour change would leave the
		// map asserting a border the settings dialog says has been changed.
		`${id}@${currentTheme}@${cachedTo ?? 'network'}@${drawn.streets}${drawn.relief}${drawn.muted}@${drawnBorders}@${drawnStyle.color ?? 'auto'}@${drawnStyle.lineStyle ?? 'auto'}@${drawnStyle.width ?? 'auto'}`;

	const styleFor = (id: string): StyleSpecification =>
		baseMapStyle(resolveBaseMap(id).entry, {
			theme: theme.current,
			appearance,
			resolveAsset: resolveDeploymentAsset,
			cachedTiles: cachedBaseMap
				? { maxZoom: cachedBaseMap.maxZoom, tileTemplate: cachedBaseMapTileTemplate() }
				: undefined,
			// Registered lazily: the protocols spawn a worker, and a deployment with no elevation
			// dataset — or a Project the author reads from the offline cache, or one drawing no
			// relief — never needs one.
			terrainTiles:
				BASE_MAP_CATALOG.terrain && appearance.relief && !cachedBaseMap
					? registerTerrainProtocols(BASE_MAP_CATALOG.terrain)
					: undefined,
			borders,
			borderStyle
		});

	/**
	 * The Annotation drawn at a screen point, or `null`.
	 *
	 * Restricted to this stack's own Annotation layers, so the Base Map style's roads and labels — which
	 * are also rendered features — can never read as a hit. The id comes out of the render copy's
	 * `properties` rather than the GeoJSON `Feature`'s `id`, because MapLibre needs a feature id to be
	 * an integer and mangles a UUID (see `ANNOTATION_ID_PROPERTY`).
	 */
	const annotationAt = (
		target: MapLibreMap,
		at: { x: number; y: number }
	): { layerId: string; annotationId: string } | null => {
		for (const drawn of layers) {
			if (isDrawnMap(drawn)) continue;
			const ids = annotationLayerIds(drawn.layer.id).filter((id) => target.getLayer(id));
			if (ids.length === 0) continue;
			// A few pixels of slack, because a line one pixel wide is not something a pointer can hit and
			// a pin is drawn larger than the point it marks.
			const box: [[number, number], [number, number]] = [
				[at.x - 6, at.y - 6],
				[at.x + 6, at.y + 6]
			];
			const found = target.queryRenderedFeatures(box, { layers: ids });
			for (const feature of found) {
				const annotationId = feature.properties?.[ANNOTATION_ID_PROPERTY];
				if (typeof annotationId === 'string' && annotationId !== '') {
					return { layerId: drawn.layer.id, annotationId };
				}
			}
		}
		return null;
	};

	/**
	 * Whether a line or a shape is part-drawn on this pane at this moment.
	 *
	 * Read off {@link overlayPoints}, which already carries one `annotation-draft` handle per vertex
	 * placed so far — a vertex of a shape still being placed, and drawn nowhere else. So the pane can
	 * tell a gesture in progress from a resting one without holding a copy of the toolbar's state,
	 * which is the same line {@link onclickannotation} draws: the page knows which tool is in hand, and
	 * a second copy here is a second thing that can be wrong.
	 */
	const drawingInProgress = (): boolean =>
		overlayPoints.some((point) => point.kind === 'annotation-draft');

	onMount(() => {
		registerPmtilesProtocol();

		const created = new MapLibreMap({
			container,
			style: styleFor(entryId),
			center: [...BASE_MAP_CATALOG.initialView.center],
			zoom: BASE_MAP_CATALOG.initialView.zoom,
			maxPitch: 0,
			// ODbL makes the attribution a licence condition, so it is not folded behind an "i".
			attributionControl: { compact: false },
			// MapLibre puts this on the canvas as its accessible name. A WebGL canvas announces
			// nothing on its own, and there is a second map pane to tell apart from this one.
			locale: { 'Map.Title': 'Base Map' }
		});
		// Zoom sits at the bottom-left in every map pane in this application. Bottom-left is the corner
		// left free here: the top-left holds the place lookup and the bottom-right the attribution.
		created.addControl(new NavigationControl({}), 'bottom-left');

		// The camera's own events, for anything drawn over this pane in the page's coordinates rather
		// than in MapLibre's — see {@link onCameraMove}. `move` covers a pan and the frames of a zoom;
		// `zoom` is bound as well because a `setZoom` with no pan is the case a reader of this would
		// check for, and the work behind it is idempotent.
		const cameraMoved = (): void => {
			for (const watcher of cameraWatchers) watcher();
		};
		created.on('move', cameraMoved);
		created.on('zoom', cameraMoved);

		// ──────────────────────────────────────────────────────────────────────────────────────
		// THE BASE MAP'S SOURCE, AND ONLY THAT SOURCE
		//
		// `error` carries everything MapLibre could not do — a warped Layer's tiles, a sprite, a
		// glyph range. Reporting the lot as "no Base Map" would be a notice that appears for reasons
		// it does not name, so this is filtered to the one source `baseMapStyle` declares. A missing
		// glyph range is deliberately *not* included: it is a `warn`, the map still draws, and
		// ADR-0025 keeps glyphs shipped precisely so that case cannot arise here.
		created.on('error', (event) => {
			if ((event as { sourceId?: string }).sourceId !== BASE_MAP_SOURCE_ID) return;
			onbasemapstatus?.('unavailable');
		});
		// `sourcedata` rather than `load`: the map fires `load` once the *style* is in, which happens
		// whether or not the archive answered. What has to be observed is the source itself becoming
		// loaded, which is the event that does not fire when the archive refuses.
		created.on('sourcedata', (event) => {
			if (event.sourceId !== BASE_MAP_SOURCE_ID || !event.isSourceLoaded) return;
			onbasemapstatus?.('drawing');
		});

		created.on('click', (event) => {
			const at = { lng: event.lngLat.lng, lat: event.lngLat.lat };
			// The Annotation underneath first, so the page has both facts before it decides which one the
			// current tool cares about. `queryRenderedFeatures` is asked with the click's own screen point
			// and restricted to this stack's Annotation layers, so a click on the Base Map's own label or
			// road never reads as a hit.
			const hit = annotationAt(created, event.point);
			if (hit) onclickannotation?.(hit);
			onclickpoint?.(at);
		});

		// Double-click ends a line or a shape. MapLibre's own default for `dblclick` is to zoom in, which
		// would otherwise fire in the same gesture and leave the user somewhere else on the earth.
		//
		// **Only while something is actually part-drawn**, which is the whole of the guard: the Layers
		// pane always supplies `onfinishshape`, so preventing the default whenever it exists killed
		// double-click zoom on that pane outright — with the select tool in hand, with no Annotation
		// Layer, and on a pane the user was only reading. A gesture in progress is asked of
		// {@link drawingInProgress} rather than held here, so the pane keeps no copy of the toolbar's
		// state.
		created.on('dblclick', (event) => {
			if (onfinishshape === undefined || !drawingInProgress()) return;
			event.preventDefault();
			onfinishshape();
		});

		// Enter places a point at the centre of the map; Shift+Enter ends a line or a shape. That
		// completes the keyboard path for drawing an Annotation: MapLibre already pans the canvas with
		// the arrow keys and zooms with `+` and `-`, so "move the map to the place, then press Enter" is
		// a whole route with nothing new to learn. Without it a drawing tool could be *chosen* by
		// keyboard and never *used* by one.
		//
		// On MapLibre's own canvas rather than on the container, and that is not incidental: the canvas
		// already carries `tabindex="0"`, a role, and an accessible name, so nothing here has to invent
		// them — a wrapper `<div>` with a key handler would need a role of its own, and `role="application"`
		// would change how a screen reader treats the whole pane. It also means a focused overlay-point
		// button, which is a sibling of the canvas rather than a child, never reaches this at all: Enter
		// on a vertex handle is that button's activation.
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

		painted = paintKey(
			entryId,
			theme.current,
			cachedBaseMap?.maxZoom ?? null,
			appearance,
			borders,
			borderStyle
		);
		map = created;
		const unexpose = exposeBaseMapToBrowserTests(created);

		// The map itself is taken down by the last effect in this file, not here — see the note there.
		return unexpose;
	});

	/**
	 * Serve the Workspace's cached tiles, for as long as this pane is asking for them (ADR-0011).
	 *
	 * Its own effect rather than a line inside the repaint below, so the registration outlives a theme
	 * change.
	 *
	 * ⚠ **It is declared before the effect that builds the style, and that is ordering rather than a
	 * guarantee.** The map is created in `onMount`, which runs before either effect, so the style
	 * carrying the cached-tile template is handed to MapLibre before this line has run. Nothing
	 * throws only because MapLibre does not request a source's tiles synchronously — by the time it
	 * does, both effects have run. The registration is idempotent and a tile requested before it is
	 * answered as an empty tile rather than an error, so the worst case is a frame of nothing rather
	 * than a broken pane; making it a real guarantee would mean registering inside `onMount`, which
	 * would then have to be torn down somewhere other than where it was set up.
	 */
	$effect(() => {
		const cache = cachedBaseMap;
		if (!cache) return;
		return registerCachedBaseMapTiles(cache.readTile, recordCachedBaseMapTiles());
	});

	$effect(() => {
		const wanted = paintKey(
			entryId,
			theme.current,
			cachedBaseMap?.maxZoom ?? null,
			appearance,
			borders,
			borderStyle
		);
		const current = map;
		if (current === undefined || painted === wanted) return;
		painted = wanted;
		// One call, driven by one signal: the flavor changes in the same action that changes the
		// interface, which is the whole of ADR-0016's "not two independent toggles that agree".
		current.setStyle(styleFor(entryId));
	});

	/**
	 * The last fit this pane carried out. A plain `let`, deliberately: in runes mode it is not
	 * reactive, so recording a fit cannot re-run the effect that performed it.
	 */
	let fitted: OpeningViewFit | null = null;

	/**
	 * Frame the map on {@link openingFit}, once per request (ADR-0026).
	 *
	 * The rule itself — identity as the guard, so that "Fit to this Project" pressed twice frames
	 * twice — is core's {@link applyOpeningFit}, shared with the viewer's `ReaderMapPane`. This effect
	 * is only the wiring: the two panes held the same body verbatim, which is how "the editor and the
	 * Published Site frame a Project the same way" quietly becomes a claim about the past.
	 */
	$effect(() => {
		fitted = applyOpeningFit(map, openingFit, fitted);
	});

	/**
	 * Frame the pane on a Place the scholar chose (ADR-0029).
	 *
	 * **The same fit, with the same padding and the same maximum zoom** as the one a Project opens
	 * with, so a city fills the pane and a house address frames tight with no zoom heuristic anywhere
	 * in the feature. Re-deriving either constant here would be a second copy of the numbers.
	 *
	 * `fitted` is not consulted and not written: this is a fit the scholar asked for by clicking, and
	 * the identity guard exists for the *automatic* one — choosing the same candidate twice, having
	 * panned away, must frame twice.
	 *
	 * **Nothing is drawn at the point** — the framing is the answer. ADR-0029 says why, and the marker
	 * count in `editor-base-map.e2e.ts` is what holds it.
	 *
	 * **Exported, because the Annotation Layer's search is in the sidebar** and its choice both frames
	 * and writes a Pin: the page carries out the placement and asks the pane for the camera, the way
	 * `ImagePane` is asked to fit its image. A second fit prop beside {@link openingFit} would be this
	 * function again, and would put the box-to-fit translation the pane owns at the call site too.
	 */
	export function frameOnPlace(place: Place): void {
		applyOpeningFit(map, openingViewFit(place.bounds), null);
	}

	/**
	 * Where `annotation` is drawn on the screen right now, for the leader to point at.
	 *
	 * **Exported rather than given as a prop**, and imperative for the same reason
	 * {@link onCameraMove} is: the leader asks this once per frame of a pan, and a value routed
	 * through a `$state` would schedule a component flush per frame. It answers against the camera as
	 * it is at the moment of the call, so there is no ordering hazard with MapLibre's own listeners.
	 */
	export function annotationBox(annotation: Annotation): ScreenBox | null {
		return map ? annotationMarkBox(map, annotation) : null;
	}

	/**
	 * How far inside an edge — of the pane, or of whatever is docked over it — a mark has to be to count
	 * as comfortably in view.
	 *
	 * A mark exactly on the boundary is a mark half under something, and a rule with no margin also
	 * makes the answer flip on a fraction of a pixel of rounding, which would move the camera on
	 * selections that changed nothing. Eight would do for the geometry; sixteen also absorbs the 8 px
	 * the Inspector's arrival transition is still travelling through when its box is measured.
	 */
	const MARK_COMFORT = 16;

	/**
	 * The most that may be reserved along an axis for something docked over the pane: enough that the
	 * mark's own box still lands `MARK_COMFORT` inside the pane's far edge.
	 *
	 * A reservation is spent as an `offset` from the camera's centre, so an unbounded one pushes the mark
	 * off the far side of the pane — which is the phone sheet's case rather than a hypothetical: a sheet
	 * covering three-quarters of the pane asks for three-quarters of it back. When this binds, the mark
	 * lands exactly its own height plus `MARK_COMFORT` inside the near edge, which is the best the
	 * geometry allows.
	 *
	 * On a desktop pane it does not bind: the docked panel asks for 344 px of an 896 px pane, and the cap
	 * there is 834 px.
	 */
	const mostReservable = (extent: number, markExtent: number) =>
		Math.max(extent - markExtent - 2 * MARK_COMFORT, 0);

	/**
	 * How long the camera takes to bring a mark out from under the panel.
	 *
	 * A shade longer than the 220 ms the Inspector's own arrival takes (`AnnotationInspector`'s
	 * `arrival`, the duration the Layer cards and the Annotation rows also use), and deliberately: the
	 * panel and the camera set off in the same flush, and a camera that stopped first would show the
	 * mark arriving before there was a panel for it to be getting out of the way of. Not MapLibre's own
	 * `easeTo` default of 500 either, which for a move nobody asked for out loud reads as the map
	 * wandering off on its own.
	 *
	 * `e2e/editor-annotations.e2e.ts` carries a named copy rather than importing this: the suite does not
	 * import application source. Both sides say so.
	 */
	const RESERVATION_EASE_MS = 300;

	/**
	 * Bring `annotation`'s mark into the part of the pane nothing is covering, and only if it is not
	 * there already.
	 *
	 * `occluder` is the box of whatever is docked over this pane — the Annotation Inspector — in the
	 * viewport's own coordinates, or `null` when nothing is. The page measures it because the page is
	 * what renders it; the pane owns the camera and nothing else.
	 *
	 * **"The mark" is exactly the point the leader ends at, and for three of the four kinds that is
	 * a point rather than the drawing.** `annotationMarkBox` gives a Pin its pin's own extent, a line its
	 * westmost vertex, a shape its anchor and a Label its centre, the last three zero-size. So what this
	 * guarantees is that the *end of the leader* is clear of the panel: a long line running in from the
	 * west keeps its far half under the panel, a shape wider than the un-occluded region cannot be got
	 * out from under it at all, and a long Label whose centre is already clear provokes no nudge even
	 * when most of its words are still under the panel. That is the contract's choice rather than an
	 * omission — the leader is what says which mark a selection is about, so the end of it is the
	 * thing that has to be visible, and a rule that framed whole geometries would be a fit rather than
	 * a nudge and would zoom the map on every selection.
	 *
	 * **It must not fight the user**, which is the whole of the first branch: a mark already inside the
	 * pane and clear of the panel provokes no camera move at all. Moving the map under a pointer that
	 * asked for nothing of the sort is the defect this restraint is against. **This is the only
	 * mechanism that keeps a selection's subject visible** (ADR-0035): the sidebar does nothing of the
	 * sort, because a row holds no content to scroll to.
	 *
	 * **The reservation is the panel's column, and the occlusion test is the panel's box.** Those are
	 * deliberately different rectangles. A mark below the panel's bottom edge is not hidden — the map is
	 * visible there and that is the point of docking over it rather than beside it — so it must not
	 * provoke a move; but the reservation is one number on one axis and cannot describe a corner, so once
	 * a move is warranted the whole column — or, for the phone's sheet, the whole band — is what gets
	 * reserved.
	 *
	 * **Nothing is focused here.** The camera moves and whatever holds the keyboard keeps it, which is
	 * what lets this run for a selection made on the canvas without taking the pointer's place.
	 *
	 * `prefers-reduced-motion` is MapLibre's own: `easeTo` skips the animation for anything not marked
	 * `essential`, and a camera move nobody asked for out loud is exactly that.
	 */
	export function keepAnnotationClear(annotation: Annotation, occluder: ScreenBox | null): void {
		const current = map;
		if (current === undefined) return;
		const mark = annotationMarkBox(current, annotation);
		if (mark === null) return;

		// ⚠ **The canvas rather than its container.** `getCanvasContainer()` is a zero-height div — the
		// canvas inside it is absolutely positioned — so its rect gives the pane's origin and nothing about
		// its extent, and every mark reads as off the bottom of a pane 0 px tall.
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

		// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
		// │ WHICH AXIS THE RESERVATION IS ON IS READ OFF THE TWO BOXES, NOT OFF A BREAKPOINT.          │
		// └───────────────────────────────────────────────────────────────────────────────────────────┘
		//
		// The docked panel is a column inset from the pane's right edge, so the region left for the mark is
		// *beside* it and the reservation is on x. A phone's sheet spans the pane's width, so there is no
		// strip beside it to put anything in and the region left is *above* it: a sheet at the bottom is
		// a reservation on the y axis instead of the x.
		//
		// ⚠ **Reading the geometry rather than a media query is what keeps this one rule.** This component
		// is not told which layout rendered the panel — the consumer positions it, which is the whole
		// reason `AnnotationInspector` takes no `variant` — and a duplicate of the breakpoint here would be
		// a second place for the two to disagree. What is asked is whether a strip of pane wide enough for
		// the mark survives to the left of the occluder; a sheet leaves 8 px of it and the docked panel
		// leaves some 568.
		//
		// **Both branches assume the occluder is against the far edge of its axis** — the panel at the
		// right, the sheet at the bottom — which is what makes both offsets negative. That is the dock
		// decision rather than an omission: nothing in either app puts the Inspector at the left or the
		// top.
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
			// The middle of the mark's own box, so a Pin is centred on the pin rather than on the ground
			// it stands on. Container coordinates, which is what `unproject` takes and what
			// `annotationMarkBox` returned the viewport's version of.
			//
			// ⚠ **Two measured origins, and they coincide today rather than by construction.** `pane` is
			// `getCanvas()` while `annotationMarkBox` takes its origin from `getCanvasContainer()`; the
			// canvas is absolutely positioned at its container's origin, so subtracting one from the other
			// is sound. The container's zero *height* has already caused one bug in this function (see
			// above), so the difference between the two is worth knowing about before it is relied on
			// harder.
			center: current.unproject([
				(mark.left + mark.right) / 2 - pane.left,
				(mark.top + mark.bottom) / 2 - pane.top
			]),
			// ⚠ **`offset` rather than `padding`, and that is a correctness difference rather than a
			// preference.** `padding` is *viewport state*: set it on one move and it stays set, so
			// `getCenter` goes on answering with the padded centre and every later `easeTo`, double-click
			// zoom and Enter-places-a-point is anchored to a viewport the user cannot see — a Pin placed by
			// keyboard landed half a reservation left of the crosshair for the rest of the session.
			// MapLibre also stops an in-flight ease the moment a handler activates, which with `padding`
			// leaves it frozen at whatever fraction it had reached when the user grabbed the map. `offset`
			// says "put this point off-centre by this much, for this one move" and leaves nothing behind.
			// Negative on whichever axis was reserved, because the occluder is against that axis's far edge
			// and the mark belongs in the middle of what is left.
			offset: [-reserved.x / 2, -reserved.y / 2],
			duration: RESERVATION_EASE_MS
		});
	}

	/**
	 * Whoever wants to be told the camera has moved. The leader line, and nothing else.
	 *
	 * A set held here rather than the map handed out, because "the camera moved" is the whole of what
	 * the caller needs and a MapLibre instance is every gesture on this pane. It is also the only
	 * shape that works before the map exists: `onMount` binds the two events once, to this list, so a
	 * subscriber that arrived first is called from the first frame.
	 *
	 * An array rather than a `Set`, which is `workspace-storage.svelte.ts`'s reading of
	 * `svelte/prefer-svelte-reactivity`: the rule would have a `SvelteSet` here, and reactivity is the
	 * one property this must not have — nothing may re-render because something started watching.
	 */
	const cameraWatchers: (() => void)[] = [];

	/**
	 * Run `watcher` on every camera move, until the returned function is called.
	 *
	 * **Imperative on purpose.** Its one consumer redraws an SVG attribute per frame of a pan; routed
	 * through a prop or a `$state` counter it would schedule a component flush per frame instead.
	 */
	export function onCameraMove(watcher: () => void): () => void {
		cameraWatchers.push(watcher);
		return () => {
			const at = cameraWatchers.indexOf(watcher);
			if (at !== -1) cameraWatchers.splice(at, 1);
		};
	}

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

	// Framing the map is `openingFit`'s job, below: it frames on the Resource Mask rather than on the
	// Control Point pairs, caps the zoom by ADR-0026's rule rather than by this pane's own, and
	// announces where the map went. The identity-guarded "once, and never under the user's drag"
	// contract lives in `applyOpeningFit`.

	/**
	 * The drawn warped Map Image, for the in-place updates below.
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
	 * switched on "Colour the Map Image by how much it is stretched" and then changed the
	 * transformation type watched the map redraw uncoloured, with the checkbox still checked and
	 * nothing thrown.
	 */
	const hasAlignment = $derived(alignment !== null);

	/**
	 * Where the aligned map's tiles are, as `showAlignment` takes them.
	 *
	 * **Dependencies of the layer effect below, deliberately**: the address is baked into the
	 * renderer's document at `addGeoreferencedMap`, so unlike the Alignment's content it cannot be
	 * applied in place. Making an offline copy of a map that is open here changes it from the
	 * Library's service to `''`, and the layer has to be rebuilt for that to take effect.
	 *
	 * ⚠ **Two primitives rather than one object, and the difference is a rebuild storm.** A `$derived`
	 * returning `{ referenced, service }` takes a new identity every time it recomputes, and identity
	 * is what decides whether the effect re-runs — so any change upstream of `alignmentSource`, however
	 * unrelated, would tear the warped layer off the map and build another. That is the rebuild
	 * `hasAlignment` was carefully narrowed to avoid; a string and a boolean compare by value and
	 * cannot reintroduce it.
	 *
	 * The pair lives in `alignment/map-source.svelte.ts` **so that it has a test**. Written inline here
	 * the guard was a paragraph and nothing else: collapse it and the whole suite stays green, because
	 * what goes wrong is a warped layer rebuilt mid-alignment, which flaps rather than fails.
	 * `map-source.svelte.test.ts` counts the effect runs and is red for the collapsed form.
	 */
	const warpedAddress = warpedAddressOf(() => alignmentSource);
	const warpedReferenced = $derived(warpedAddress.referenced);
	const warpedService = $derived(warpedAddress.service);

	/**
	 * The warped Map Image (ADR-0011's `fetchFn` injection point).
	 *
	 * Added once the style has loaded, because `WarpedMapLayer.onAdd` needs the map's own WebGL2
	 * context. Built and taken off with {@link hasAlignment} and nothing else; what the map is drawn
	 * *from* is applied in place by the effect at the bottom of this file.
	 */
	$effect(() => {
		const current = map;
		const drawing = hasAlignment;
		const readTiles = fetchTile;
		// Tracked, unlike the Alignment: see {@link warpedService}. The address is in the document the
		// renderer was built from, so changing it is a rebuild and not an update.
		const referenced = warpedReferenced;
		const service = warpedService;
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
			const render = showAlignment(layer, shown, {
				distortion: distortionNow(),
				referenced,
				service
			});
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
			// The map is still there to be asked: its own removal is the last teardown in this file.
			if (added && current.getLayer(layer.id)) current.removeLayer(layer.id);
			onwarped?.(null);
		};
	});

	/**
	 * What about the Layer stack requires it to be rebuilt: which Layers draw, in what order, and from
	 * which documents **and which image services**.
	 *
	 * **Opacity is deliberately absent.** A rebuild throws away every renderer and refetches every
	 * tile, and opacity is dragged — so including it would make a continuous gesture the most
	 * expensive thing in the application, which is the shape ADR-0017 rule 1 exists to prevent. The
	 * theme is present because `setStyle` takes our layers off the map with everything else.
	 *
	 * **`service` is present, and its absence was a defect.** Where a `'referenced'` Layer's tiles come
	 * from is not a display setting and cannot be applied in place: `@allmaps/maplibre` builds every tile
	 * URL from the document it was handed, so the remote address versus the ADR-0004 placeholder is a
	 * different document and therefore a different drawn map (see `showAlignment`). The page resolves it
	 * from the Project's `remote.json` records, which are read *after* `project.json` — so on a fresh
	 * load of the Layers pane the stack was built from `service: ''`, asked the injection shim for a
	 * pyramid a referenced image does not have locally, and rendered blank; the record arriving a moment
	 * later changed this key not at all, so nothing was redrawn. This is the same shape as the Base Map
	 * style that has not finished loading — built before its inputs were ready — and the other half of
	 * that answer is {@link whenStyleLoaded}, which waits rather than rebuilds because a style is a
	 * precondition of attaching at all rather than something the stack is built *from*.
	 *
	 * For a local copy `service` is always `''`, so nothing about the ordinary case rebuilds more often.
	 */
	const stackStructure = $derived(
		JSON.stringify([
			theme.current,
			layers.map((stacked) =>
				isDrawnMap(stacked)
					? [stacked.layer.id, 'map', stacked.alignment, stacked.service ?? '']
					: [stacked.layer.id, 'annotation', annotationDrawKey(stacked.annotations)]
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
	 * How often the gate re-reads `isStyleLoaded()` regardless of what the map has announced.
	 *
	 * **The gate is a state, and `styledata` and `idle` are only two of the ways it can be reached.**
	 * A style whose last unfinished piece is a tile that *errored* completes without either firing
	 * again, and on a machine slow enough that the map never falls idle nothing else arrives either —
	 * so the pane sat on a Base Map that had been ready for fourteen seconds and then reported it as
	 * missing. Reproduced on one core against an archive that refuses tile ranges. The events stay for
	 * the immediacy; this is what makes the answer independent of them.
	 */
	const STYLE_POLL_MS = 250;

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
	 * deadlock, but it can wait indefinitely — an unreachable PMTiles archive on a reading room's wifi —
	 * and then `attach` never runs, `onstack` is never called, and the page's own fallback has nothing
	 * to say about a Layer whose document it read perfectly well. The region read "0 of 1 Layers are
	 * drawn" with no problem text, which tells a user their work is missing and not why. `giveUp` is
	 * that account.
	 *
	 * ⚠ **And it is an account of the wait, not the end of it.** The budget is a guess about how long a
	 * working load takes, and a loaded machine beats that guess routinely — so the listeners stay on
	 * afterwards, and a style that completes late is still drawn on. Stopping there left the Layers
	 * permanently undrawn on a map that had in fact arrived, which no reload-free action could undo.
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
		let poll: ReturnType<typeof setInterval> | undefined;
		const stop = () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			if (poll !== undefined) clearInterval(poll);
			poll = undefined;
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
		poll = setInterval(retry, STYLE_POLL_MS);
		timer = setTimeout(() => {
			timer = undefined;
			giveUp();
		}, STYLE_WAIT_MS);
		return stop;
	};

	/** The Project's Layer stack, on the same `fetchFn` injection point (ADR-0011). */
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
			built = drawLayerStack({
				map: current,
				layers: stackLayers,
				fetchTile: readTiles,
				// The Playwright handle stays in this app rather than in `core`, which is why
				// `drawLayerStack` takes it as a seam — a `declare global` on `Window` inside core would
				// put the editor's test scaffolding into a published Reader's bundle.
				onBuilt: exposeLayerStackToBrowserTests
			});
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
			// No `mapIsGone`: the map is still alive here, because taking it down is the last teardown in
			// this file. That is what lets `destroy` ask `getLayer` and take our layers off properly
			// rather than trusting `Map#remove` to have carried them away.
			built?.destroy();
			stack = undefined;
			onstack?.({});
		};
	});

	/**
	 * The Annotations themselves, pushed into the source that is already there.
	 *
	 * **Not a rebuild, for the same reason opacity is not** — and for a sharper one. An Annotation's
	 * title is typed a character at a time, every keystroke writes the file, and every write hands
	 * this component a new collection. While the collection was part of {@link stackStructure}, that
	 * tore down and re-added *every layer in the stack* per keystroke, Map Images included, so
	 * typing a title made the whole map thrash and refetch tiles. The structure key now carries only
	 * `annotationDrawKey` — which MapLibre layers the contents need — so a rename, a recolour, or a
	 * moved vertex lands here instead, and a first dashed line still rebuilds because it needs a
	 * layer that was never added.
	 */
	$effect(() => {
		const built = stack;
		if (!built) return;
		paintAnnotations(built, annotationDragPreview);
	});

	/**
	 * Push every Annotation Layer's features into the sources already on the map.
	 *
	 * A function rather than only the body of the effect above, because {@link captureSnapshot} needs
	 * the same write with `preview` set to `null`: a Map Snapshot carries the Annotation as it is
	 * saved, not the one halfway through a drag.
	 */
	const paintAnnotations = (built: StackRender, preview: AnnotationDragPreview | null): void => {
		for (const stacked of layers) {
			if (!isDrawnMap(stacked)) {
				const annotations = stacked.annotations ?? { annotations: [] };
				built.setAnnotations(
					stacked.layer.id,
					preview?.layerId === stacked.layer.id
						? setGeometry(annotations, preview.annotationId, preview.geometry)
						: annotations
				);
			}
		}
	};

	/** The selection, applied in place — see {@link stackStructure} for why this is not a rebuild. */
	$effect(() => {
		stack?.setSelectedAnnotation(selectedAnnotationId ?? null);
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
	 * Resolve once MapLibre has nothing left to draw.
	 *
	 * `loaded()` first, because `idle` is an event and an event that has already fired is one a late
	 * listener never hears — which for a map that settled before anybody asked is every time.
	 */
	const whenMapIdle = (target: MapLibreMap): Promise<void> =>
		new Promise((resolve) => {
			if (target.loaded()) {
				resolve();
				return;
			}
			target.once('idle', () => resolve());
		});

	/**
	 * Tell the page when the frame on screen is complete, so it can offer a Map Snapshot of it.
	 *
	 * **Both halves, because neither is the whole answer.** MapLibre's own idleness covers the Base
	 * Map and the Annotation layers; a warped Map Image is drawn by a custom layer with a tile cache
	 * of its own, so the stack is asked as well (`whenTilesSettled`). The second idle is what puts
	 * those tiles on screen: they arrive after the map has already fallen quiet once.
	 *
	 * Not ready again the moment anything about the stack or the map changes — that is what the
	 * teardown says — and the effect then works its way back to ready for the replacement frame.
	 */
	$effect(() => {
		const current = map;
		const built = stack;
		if (!current) return;
		let live = true;
		void (async () => {
			await whenMapIdle(current);
			await built?.whenTilesSettled();
			await whenMapIdle(current);
			if (live) onsnapshotready?.(true);
		})();
		return () => {
			live = false;
			onsnapshotready?.(false);
		};
	});

	/**
	 * The map as it is on screen, as a PNG — a Map Snapshot of this Project's current view.
	 *
	 * **Exported rather than driven by a prop**, for the reason {@link frameOnPlace} is: the control
	 * that asks for it is the page's, in the page's own control row, and what it needs back is one
	 * value once rather than a stream of state.
	 *
	 * The captured frame is the *clean* one — the Annotations as they are saved, with nothing
	 * selected — because a Map Snapshot is the composition rather than the moment of authoring it.
	 * Both are written straight onto the layers already on the map and put back in the `finally`, so
	 * no Project data is touched and the Author's selection and half-finished drag are still there
	 * afterwards. What is drawn over the pane in the DOM — the Inspector, leader lines, Control
	 * Points, the map's own controls — is outside the framebuffer and needs no undoing.
	 *
	 * The wait is what makes the clean state the one captured: `setData` is parsed off the main
	 * thread and a feature state lands on the next render, so capturing immediately would still
	 * catch the preview.
	 */
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
				built.setSelectedAnnotation(selectedAnnotationId ?? null);
			}
		}
	}

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

	/**
	 * How opaque that map is, in place and in an effect of its own.
	 *
	 * Separate from the update above for the same reason the Layer stack's opacity is separate from its
	 * rebuild (ADR-0017 rule 1): this is dragged, so it must not be a dependency of anything that
	 * rebuilds a renderer or re-reads a document.
	 */
	$effect(() => {
		const shown = drawnAlignment;
		const opacity = alignmentOpacity;
		if (!shown) return;
		shown.layer.setOpacity(opacity);
	});

	/**
	 * Take the map down — and **last, which is the whole reason this is an effect and is here**.
	 *
	 * `Map#remove` calls `setStyle(null)`, which deletes the map's `style`; every method that reads it
	 * then throws, `getLayer` included — and `getLayer` is what each teardown above asks before taking
	 * its layer off. So the order in which teardowns run is load-bearing, and Svelte fixes it: a
	 * component's effects are destroyed **in the order they were created**. This effect is created after
	 * every other one in this file, so its cleanup runs after every other one, and each of those runs
	 * against a live map.
	 *
	 * It used to be `onMount`'s cleanup, which is registered *above* every effect here and therefore ran
	 * *first*. The cost was far beyond a noisy console: an exception thrown while Svelte is destroying
	 * one page abandons the rest of that synchronous flush — including the *mount* of the page being
	 * navigated to. Clicking through from the Project page to the Layers pane, once the Project page had
	 * a local Map Image and therefore a warped layer to take off, produced a Layers pane containing
	 * no MapLibre map at all: no Base Map, no Layer stack, and nothing logged beyond one `TypeError` from
	 * a page the user had already left. A flag saying "the map has gone, do not ask it" fixed the two
	 * teardowns that existed and left every future one to remember it; putting the removal last means
	 * there is nothing to remember. `e2e/editor-layers.e2e.ts` asserts the `pageerror` itself, in both
	 * directions of that navigation, because the exception is the mechanism and the blank pane is only
	 * its most visible symptom.
	 *
	 * Nothing sets `map` back to `undefined`: the component is on its way out, and a write to state
	 * during a destroy flush is a re-render nobody asked for.
	 */
	$effect(() => {
		const created = map;
		if (!created) return;
		return () => created.remove();
	});
</script>

<!--
	MapLibre gives the canvas `tabindex="0"`, a `role`, and an accessible name, and handles arrow-key
	panning and +/- zooming itself, so the pane is keyboard operable without anything added here. The
	one addition is Enter and Shift+Enter for drawing an Annotation, bound to the canvas in `onMount`
	rather than to this element — see there for why.

	The testid names this container specifically because MapLibre appends overlay points *into* it,
	and both panes' points use identical markup — so telling one pane's Control Points from the
	other's is a question about which container they are in. Distinguishing them by anything else
	(canvas order, negation against the image pane's testid) is the kind of selector that passes until
	the layout moves.
-->
<!--
	The place search and any page-owned map controls are inside this pane rather than beside it in the
	page flow. Both editor screens therefore get the search without spending map height; only the
	Project screen supplies its own Base Map controls. This search navigates and places nothing;
	placing lives on the Annotation Layer surface, where there is always a Layer to draw into.

	⚠ **While something is docked over the pane's top-right corner, the block stops short of it — that
	is the conditional `max-width`.** The Annotation Inspector docks `right-2` at `w-80` above `lg` and
	sits a layer above this block, so a control the row puts under that column is covered: the pointer
	reaches the Inspector rather than the button. Measured on the Project screen at 1280 wide with an
	Annotation selected: the row's last control spanned 982–1168 against an Inspector starting at 952,
	and `elementFromPoint` at the button's centre answered with the Inspector's heading. So the row
	wraps before it gets there, and only while it has to — applied unconditionally it costs the row a
	second line at every ordinary desktop width, which is the single line ADR-0020's panel exists to
	buy. The `max()` floor is the place search's own width: the alignment screen renders this pane in a
	column narrower than the Inspector's, where an unfloored subtraction resolves negative and
	collapses the search to nothing.

	⚠ **`z-[6]` puts this block with the map's other controls, and the number is load-bearing.** One
	stacking context holds the leader at 5, MapLibre's four control corners at 6 (`packages/ui`'s
	`layout.css` has the rule and the reason), and the Annotation Inspector at 7. This block is pane
	furniture like the zoom control, so it belongs at 6: above the leader, which is what keeps a
	dashed line from being drawn across the search field, and below the Inspector. Above 7 it is
	*over* the Inspector, and below `lg` — where the Inspector is a sheet spanning the pane's width
	rather than a panel docked to the far corner — this box then lies across the sheet's header and
	swallows the pointer events meant for its close button.
-->
<div class="relative h-full w-full">
	<div bind:this={container} class="h-full w-full" data-testid="base-map-pane"></div>
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
</div>
