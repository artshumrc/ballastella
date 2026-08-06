<script lang="ts">
	// A Project's Layer stack over its Base Map, for a Reader (SPEC story 83).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHAT THIS IS AND IS NOT A COPY OF
	//
	// The editor's `BaseMapPane.svelte` is the same picture with authoring attached: overlay points for
	// Control Points and Annotation vertices, click-to-place, Enter-to-draw, the distortion overlay, and
	// the Alignment being edited. **None of that is here**, and its absence is the ticket: no drawing
	// tools, no Control Point manipulation, no writes of any kind.
	//
	// What the two panes genuinely share is in `@ballastella/core/render` rather than duplicated between
	// them — `drawLayerStack`, `createWarpedMapLayer`, `showAlignment`, `showAnnotationPopup`,
	// `registerPmtilesProtocol`. That is where ADR-0002's cross-kind drawing order lives, and where the
	// three upstream `@allmaps/*` defects are documented and worked around. Every one of those fails
	// *silently*, so a second copy of them would agree with the first right up to the day one was edited
	// and a Reader's map went blank.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE TEARDOWN HAZARD, INHERITED DELIBERATELY
	//
	// An exception thrown in any Svelte teardown abandons the rest of that destroy flush **and the mount
	// of the page being navigated to**. Svelte destroys effects in creation order and `onMount` is
	// registered above the effects here, so `Map#remove()` runs first; maplibre-gl 5's `remove()` does
	// `setStyle(null)` → `delete this.style`, and `Map#getLayer(id)` is `return this.style.getLayer(id)`.
	// The teardowns below call `getLayer` precisely because a theme change's `setStyle` may already have
	// removed their layer — so the guard written for one hazard is the throw for another.
	//
	// In the editor that produced a page containing no map at all, with nothing logged beyond one
	// `TypeError` from a page the user had already left. This pane matters more, not less: a Reader
	// navigating between the Project view and a Historical Map read unwarped crosses exactly that
	// boundary, and a Published Site has no console anyone is watching. {@link removed} is the answer, and
	// `e2e/viewer.e2e.ts` puts a `pageerror` assertion on every navigation.

	import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
	import {
		ANNOTATION_ID_PROPERTY,
		baseMapStyle,
		defaultEntry,
		isAbsoluteUrl,
		type Annotation,
		type BaseMapCatalog,
		type FetchFn,
		type GeoPoint
	} from '@ballastella/core';
	import {
		annotationLayerIds,
		drawLayerStack,
		isDrawnMap,
		registerPmtilesProtocol,
		showAnnotationPopup,
		type DrawnLayer,
		type DrawnOutcome,
		type StackRender
	} from '@ballastella/core/render';
	import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, untrack } from 'svelte';

	import { exposeReaderMapToBrowserTests } from '$lib/browser-test-handle';
	import { resolveSiteAsset } from '$lib/site-files';
	import { theme } from '$lib/theme.svelte';

	let {
		entryId,
		catalog,
		bundledBaseMapAvailable,
		layers = [],
		fetchTile,
		popupAnnotation = null,
		popupAt = null,
		onclickannotation,
		onpopupclose,
		onstack
	}: {
		/** The catalog id currently shown. The page owns which one that is, and its persistence. */
		entryId: string;
		/**
		 * The catalog that travelled with this Published Site, **not this build's** (ADR-0020).
		 *
		 * Required rather than defaulted, and that is the point: a Published Site keeps working when the
		 * authoring deployment later changes its own catalog, and it can only do that if the style is
		 * built from the record in `ballastella-site.json`. Defaulting to `BASE_MAP_CATALOG` here would
		 * make the correct behaviour the one a caller had to remember.
		 */
		catalog: BaseMapCatalog;
		/**
		 * Whether this site carries the Base Map's own files — the pmtiles archive, its glyphs, and its
		 * sprites (ADR-0020, SPEC story 88).
		 *
		 * `false` is an ordinary, supported state: including them is opt-in at publish time because they are
		 * about 4.9 MB against the same hosting budget as the scholar's Historical Maps. What must not happen
		 * is the site asking for them anyway — a bundled entry's `archive` is a **site-relative path**, so on
		 * a site published without them every tile, glyph, and sprite request is a 404 and the Reader gets a
		 * blank map with nothing to explain it. See {@link styleFor}.
		 */
		bundledBaseMapAvailable: boolean;
		/**
		 * The Layers to draw, top of the stack first, with each Layer's documents already read.
		 *
		 * Only Layers the Reader has left visible belong here: hiding one is its **absence** from this
		 * list, so there is no second place where a Layer can be in the stack and not drawn. The stack
		 * decides what draws over what, including across kinds (ADR-0002) — an Annotation Layer above a
		 * map Layer draws above it.
		 */
		layers?: readonly DrawnLayer[];
		/** Where an aligned Historical Map's tiles are read from (ADR-0011). */
		fetchTile: FetchFn;
		/** The Annotation whose popup is open, and where, or `null` for none (SPEC story 67). */
		popupAnnotation?: Annotation | null;
		popupAt?: GeoPoint | null;
		/** An Annotation the Reader clicked, by its Layer and its own id. */
		onclickannotation?: (hit: { layerId: string; annotationId: string; at: GeoPoint }) => void;
		/** The Reader dismissed the popup with its own close button or with Escape. */
		onpopupclose?: () => void;
		/**
		 * What became of each Layer the map was given, keyed by Layer id.
		 *
		 * Reported rather than inferred, because the page cannot see the map's lifecycle: an Alignment
		 * with too few Control Points to solve, or a Base Map style that never finished loading, are both
		 * normal states a Reader has to be able to be told about.
		 */
		onstack?: (outcomes: Readonly<Record<string, DrawnOutcome>>) => void;
	} = $props();

	let container: HTMLDivElement;
	let map = $state<MapLibreMap | undefined>(undefined);

	/**
	 * Whether this pane's map has been taken down, so that nothing asks a removed map anything.
	 *
	 * See the teardown note at the top of this file. A plain `let` rather than `$state`, deliberately: it
	 * is read only inside teardowns, and nothing may re-run because a map was removed.
	 */
	let removed = false;

	/** What the map is currently painted with. A plain `let`: nothing may re-run when it changes. */
	let painted = '';

	const paintKey = (id: string, currentTheme: string): string => `${id}@${currentTheme}`;

	/**
	 * The style for one catalog entry at the current theme.
	 *
	 * `resolveSiteAsset` rather than a bare path: the archive, the glyphs, and the sprites are files of
	 * this Published Site, and reaching them by `/base-map/…` would work at a domain root and 404 in a
	 * subdirectory (ADR-0006). An entry whose `archive` is an absolute URL is left alone — that is the
	 * `needsNetwork` case.
	 *
	 * **A bare style when the files are not here.** A site published without its Base Map (ADR-0020's
	 * opt-in, SPEC stories 88 and 89) holds no `base-map/` directory at all, and a bundled entry's archive,
	 * glyphs, and sprites are all site-relative paths — so building the ordinary style would fire a
	 * pmtiles range request and two sprite requests at files that are not there. The Reader would get a
	 * blank map, three 404s, and no account of either. So the reference map is simply absent, the Project's
	 * own Layers still draw over the background, and the page says why (see `base-map-unavailable`).
	 */
	const styleFor = (id: string): StyleSpecification => {
		const entry = catalog.entries.find((candidate) => candidate.id === id) ?? defaultEntry(catalog);
		if (!bundledBaseMapAvailable && !isAbsoluteUrl(entry.archive)) {
			return {
				version: 8,
				sources: {},
				// No `glyphs` and no `sprite`: both are site-relative templates, and asking for them is the
				// other half of the same 404. Nothing the Layer stack draws needs either — a warped Historical
				// Map is custom WebGL, and Annotations are circles, lines, and fills.
				layers: [
					{
						id: 'ballastella-no-base-map',
						type: 'background',
						paint: { 'background-color': theme.current === 'dark' ? '#1d232a' : '#f2f2f2' }
					}
				]
			};
		}
		return baseMapStyle(entry, { theme: theme.current, catalog, resolveAsset: resolveSiteAsset });
	};

	/**
	 * The Annotation drawn at a screen point, or `null`.
	 *
	 * Restricted to this stack's own Annotation layers, so the Base Map style's roads and labels — which
	 * are also rendered features — can never read as a hit. The id comes out of the render copy's
	 * `properties` rather than the GeoJSON `Feature`'s `id`, because MapLibre requires a feature id to be
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
			// A few pixels of slack, because a line one pixel wide is not something a pointer can hit, and
			// a touch on a phone is coarser still — this is the surface most Readers arrive on.
			const box: [[number, number], [number, number]] = [
				[at.x - 8, at.y - 8],
				[at.x + 8, at.y + 8]
			];
			for (const feature of target.queryRenderedFeatures(box, { layers: ids })) {
				const annotationId = feature.properties?.[ANNOTATION_ID_PROPERTY];
				if (typeof annotationId === 'string' && annotationId !== '') {
					return { layerId: drawn.layer.id, annotationId };
				}
			}
		}
		return null;
	};

	onMount(() => {
		registerPmtilesProtocol();

		const created = new MapLibreMap({
			container,
			style: styleFor(entryId),
			center: [...catalog.initialView.center],
			zoom: catalog.initialView.zoom,
			// ODbL makes the attribution a licence condition, so it is not folded behind an "i". On a
			// Published Site it is also the Reader's only account of whose modern map they are looking at.
			attributionControl: { compact: false },
			// MapLibre puts this on the canvas as its accessible name. A WebGL canvas announces nothing on
			// its own.
			locale: { 'Map.Title': 'Base Map' }
		});
		created.addControl(new NavigationControl({}), 'top-right');

		// A click reports the Annotation under it, and nothing else. There is no "place a point" here:
		// a Reader cannot draw, so a click on empty geography is a click on empty geography.
		created.on('click', (event) => {
			const hit = annotationAt(created, event.point);
			if (hit)
				onclickannotation?.({ ...hit, at: { lng: event.lngLat.lng, lat: event.lngLat.lat } });
		});

		// Enter opens the Annotation at the centre of the map, which is what makes an Annotation popup
		// reachable without a pointer (SPEC story 95). MapLibre already pans the canvas with the arrow
		// keys and zooms with `+` and `-`, so "move the map to it, then press Enter" is a whole route with
		// nothing new to learn. Bound to MapLibre's own canvas rather than to the container, because the
		// canvas already carries `tabindex="0"`, a role, and an accessible name.
		created.getCanvas().addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			const centre = created.getCenter();
			const at = { lng: centre.lng, lat: centre.lat };
			const hit = annotationAt(created, created.project([at.lng, at.lat]));
			if (hit) onclickannotation?.({ ...hit, at });
		});

		painted = paintKey(entryId, theme.current);
		map = created;

		return () => {
			// Said *before* the map goes, because everything that reads it runs afterwards.
			removed = true;
			created.remove();
			map = undefined;
		};
	});

	$effect(() => {
		const wanted = paintKey(entryId, theme.current);
		const current = map;
		if (current === undefined || painted === wanted) return;
		painted = wanted;
		// One call, driven by one signal: the Base Map flavor changes in the same action that changes the
		// interface, which is the whole of ADR-0016's "not two independent toggles that agree".
		current.setStyle(styleFor(entryId));
	});

	/**
	 * What about the stack requires it to be rebuilt: which Layers draw, in what order, out of which
	 * documents, and from which image services.
	 *
	 * **Opacity is deliberately absent.** A rebuild throws away every renderer and refetches every tile,
	 * and opacity is dragged — so including it would make a continuous gesture the most expensive thing
	 * on the page, which on a phone is the difference between a usable site and an unusable one. The
	 * theme is present because `setStyle` takes our layers off the map with everything else.
	 *
	 * `service` is present because where a `'referenced'` Layer's tiles come from is not a display
	 * setting: `@allmaps/maplibre` builds every tile URL from the document it was handed, so the remote
	 * address versus ADR-0004's placeholder is a different document and therefore a different drawn map.
	 */
	const stackStructure = $derived(
		JSON.stringify([
			theme.current,
			layers.map((stacked) =>
				isDrawnMap(stacked)
					? [stacked.layer.id, 'map', stacked.alignment, stacked.service ?? '']
					: [stacked.layer.id, 'annotation', stacked.layer.defaultStyle, stacked.annotations]
			)
		])
	);

	let stack = $state.raw<StackRender | undefined>(undefined);

	/**
	 * How long the stack waits for the Base Map's style before saying it cannot be drawn on.
	 *
	 * Long enough that a slow-but-working load is never called a failure, short enough that the wait is
	 * accounted for rather than endured in silence — a Reader on a reading-room's wifi (SPEC story 8) is
	 * exactly who meets this.
	 */
	const STYLE_WAIT_MS = 15_000;

	/**
	 * Run `attach` once the map's style is complete, and hand back the way to stop waiting.
	 *
	 * **`isStyleLoaded()` is the gate, not the event.** `styledata` fires repeatedly while a style loads
	 * — the first arrives long before the sprites and the PMTiles header are in — so attaching on it is
	 * attaching to a map that will refuse to take a layer, and there is no second chance. `idle` as well
	 * as `styledata`, because a style already complete when the last `styledata` fires leaves nothing else
	 * to listen for. And a style that never completes is **reported** rather than waited on for ever:
	 * without `giveUp` the page would say "0 of 2 Layers are drawn" and give no reason, which tells a
	 * Reader their scholar's work is missing and not why.
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
		target.on('idle', retry);
		timer = setTimeout(() => {
			stop();
			giveUp();
		}, STYLE_WAIT_MS);
		return stop;
	};

	$effect(() => {
		// The only tracked dependency, so that an opacity change cannot reach this effect.
		void stackStructure;
		const current = map;
		const stackLayers = untrack(() => layers);
		const readTiles = untrack(() => fetchTile);
		if (!current || stackLayers.length === 0) {
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
					// The Playwright handle stays in this app rather than in `core`, which is why
					// `drawLayerStack` takes it as a seam: a `declare global` on `Window` inside core would put
					// the editor's test scaffolding into a Reader's bundle and vice versa.
					onBuilt: exposeReaderMapToBrowserTests
				});
				stack = built;
				onstack?.(built.outcomes);
			},
			() => {
				// Every Layer, because none of them can be drawn: what is missing is the map they would be
				// drawn on. Said per Layer rather than once, because the list is where a Reader looks for the
				// Layer they cannot see.
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
			// `mapIsGone` because a removed map has no style to answer `getLayer`, and the throw would
			// abandon the rest of Svelte's destroy — see the teardown note at the top of this file.
			built?.destroy({ mapIsGone: removed });
			stack = undefined;
			onstack?.({});
		};
	});

	/**
	 * The open Annotation's popup (SPEC story 67).
	 *
	 * **This is the untrusted-text surface that matters most in the epic.** The HTML is
	 * `renderAnnotationPopup`'s — core's one function that escapes the title and runs the description
	 * through `marked` then DOMPurify, in that order — and it is built inside `showAnnotationPopup`,
	 * which holds this repository's single `setHTML` call. Nothing here assembles markup, and nothing
	 * here may start to: a Published Site runs on the author's own domain, and the Project it renders may
	 * have arrived from a stranger (ADR-0009).
	 */
	$effect(() => {
		const annotation = popupAnnotation;
		const at = popupAt;
		const current = map;
		if (!current || !annotation || !at) return;
		const shown = showAnnotationPopup({ map: current, annotation, at, onclose: onpopupclose });
		return () => shown?.destroy();
	});

	/** Opacity, applied in place — see {@link stackStructure} for why this is not a rebuild. */
	$effect(() => {
		const built = stack;
		if (!built) return;
		for (const stacked of layers) {
			if (isDrawnMap(stacked)) built.setOpacity(stacked.layer.id, stacked.layer.opacity);
		}
	});
</script>

<!--
	MapLibre gives the canvas `tabindex="0"`, a `role`, and an accessible name, and handles arrow-key
	panning and +/- zooming itself, so the pane is keyboard operable with nothing added here. The one
	addition is Enter to open the Annotation at the centre of the map, bound to the canvas in `onMount`
	rather than to this element — see there for why.
-->
<div bind:this={container} class="h-full w-full" data-testid="reader-map-pane"></div>
