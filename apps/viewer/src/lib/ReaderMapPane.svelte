<script lang="ts">
	// A Project's Layer stack over its Base Map, for a Reader.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHAT THIS IS AND IS NOT A COPY OF
	//
	// The editor's `BaseMapPane.svelte` is the same picture with authoring attached: overlay points for
	// Control Points and Annotation vertices, click-to-place, Enter-to-draw, the distortion overlay, and
	// the Alignment being edited. **None of that is here**, and its absence is the point: no drawing
	// tools, no Control Point manipulation, no writes of any kind.
	//
	// What the two panes genuinely share is in `@ballastella/core/render` rather than duplicated between
	// them — `drawLayerStack`, `createWarpedMapLayer`, `showAlignment`,
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
	// navigating between the Project view and a Map Image read unwarped crosses exactly that
	// boundary, and a Published Site has no console anyone is watching. {@link removed} is the answer, and
	// `e2e/viewer-reader.e2e.ts` puts a `pageerror` assertion on every navigation.

	import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
	import {
		ANNOTATION_ID_PROPERTY,
		BASE_MAP_SOURCE_ID,
		DEFAULT_BASE_MAP_BORDERS,
		applyOpeningFit,
		baseMapStyle,
		defaultEntry,
		isAbsoluteUrl,
		keepAskingForMissingTiles,
		type Annotation,
		type BaseMapBorders,
		type BaseMapCatalog,
		type FetchFn,
		type OpeningViewFit
	} from '@ballastella/core';
	import {
		annotationDrawKey,
		annotationLayerIds,
		annotationMarkBox,
		cachedBaseMapTileTemplate,
		drawLayerStack,
		isDrawnMap,
		registerCachedBaseMapTiles,
		registerPmtilesProtocol,
		registerTerrainProtocols,
		themeColour,
		type DrawnLayer,
		type DrawnOutcome,
		type ReadCachedTile,
		type ScreenBox,
		type StackRender
	} from '@ballastella/core/render';
	import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, untrack, type Snippet } from 'svelte';

	import {
		exposeReaderMapToBrowserTests,
		recordCachedBaseMapTiles
	} from '$lib/browser-test-handle';
	import { resolveSiteAsset } from '$lib/site-files';
	import { theme } from '$lib/theme.svelte';

	let {
		entryId,
		borders = DEFAULT_BASE_MAP_BORDERS,
		catalog,
		bundledBaseMapAvailable,
		cachedBaseMap = null,
		layers = [],
		openingFit = null,
		fetchTile,
		tilesMissing = false,
		onclickannotation,
		onstack,
		onbasemapstatus,
		selectedAnnotationId = null,
		controls,
		overlay
	}: {
		/** The catalog id currently shown. The page owns which one that is, and its persistence. */
		entryId: string;
		/**
		 * Which administrative boundaries the geography draws.
		 *
		 * **The author's, out of the published `project.json`, and not the Reader's.** A Base Map is a
		 * Reader's preference on this site (`reader-preference.ts`); which borders are drawn over a work
		 * is the author's argument about it, so this site offers no control for it and this prop has no
		 * second source.
		 */
		borders?: BaseMapBorders;
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
		 * Whether this site carries the Base Map's display assets — its glyphs and sprites (ADR-0020).
		 * Tile availability is reported separately by {@link cachedBaseMap}.
		 *
		 * `false` remains an ordinary, supported state for legacy sites that were published without the
		 * display assets. What must not happen is the site asking for them anyway — a bundled entry's
		 * `archive` is a **site-relative path**, so on such a site every tile, glyph, and sprite request is a
		 * 404 and the Reader gets a blank map with nothing to explain it. See {@link styleFor}.
		 */
		bundledBaseMapAvailable: boolean;
		/**
		 * Draw the geography from the site's own `base-map/tiles/…` rather than from the entry's archive
		 * (ADR-0025), or `null` to read the archive as usual.
		 *
		 * Independent of {@link bundledBaseMapAvailable}, which is about glyphs and sprites: a site can
		 * carry tiles and no labels, or labels and no tiles, and the two failures read differently to a
		 * Reader. `maxZoom` comes off the site record because a static host cannot be asked to list a
		 * directory — see `PublishedSite.baseMapCaches`, which also says *which archive* each cache is
		 * for, because the directory is keyed by one and a key cannot be read backwards.
		 */
		cachedBaseMap?: { maxZoom: number; readTile: ReadCachedTile } | null;
		/**
		 * The Layers to draw, top of the stack first, with each Layer's documents already read.
		 *
		 * Only Layers the Reader has left visible belong here: hiding one is its **absence** from this
		 * list, so there is no second place where a Layer can be in the stack and not drawn. The stack
		 * decides what draws over what, including across kinds (ADR-0002) — an Annotation Layer above a
		 * map Layer draws above it.
		 */
		layers?: readonly DrawnLayer[];
		/**
		 * Frame the map on a box, once (ADR-0026).
		 *
		 * **The same prop, the same core function, and the same cap and padding as the editor's pane**,
		 * which is the half ADR-0026 says is most likely to be forgotten: a Published Site that opened
		 * on the deployment's default while the editor opened on the author's work would be two answers
		 * to one question, and the Reader is the one who cannot tell.
		 *
		 * Applied once per object identity — the page owns how many identities there are, and so owns
		 * "once, on open, never again". `null` leaves the map on the site catalog's own initial view,
		 * which is what a Project with nothing on the earth opens on.
		 */
		openingFit?: OpeningViewFit | null;
		/** Where an aligned Map Image's tiles are read from (ADR-0011). */
		fetchTile: FetchFn;
		/**
		 * Whether some of a Map Image's bytes were refused and have not come back.
		 *
		 * ⚠ **Whether, not which, and not each refusal** — the page's own notice state, passed down
		 * because the map is here and the outcomes are there. While it is `true` this pane paints
		 * frames on {@link keepAskingForMissingTiles}' schedule so the renderer re-asks for the refused
		 * record; a signal that changed on every refusal would re-arm that schedule with the very
		 * requests it makes, which is an unbounded loop rather than a bounded retry.
		 */
		tilesMissing?: boolean;
		/**
		 * An Annotation the Reader clicked, by its Layer and its own id.
		 *
		 * **Where on the earth the click landed is not reported with it**, and no longer needs to be:
		 * nothing is drawn over the map for an Annotation. The click opens that Annotation's row in the
		 * Layer list, which is where a Reader reads one, and a row has no anchor.
		 */
		onclickannotation?: (hit: { layerId: string; annotationId: string }) => void;
		/**
		 * What became of each Layer the map was given, keyed by Layer id.
		 *
		 * Reported rather than inferred, because the page cannot see the map's lifecycle: an Alignment
		 * with too few Control Points to solve, or a Base Map style that never finished loading, are both
		 * normal states a Reader has to be able to be told about.
		 */
		onstack?: (outcomes: Readonly<Record<string, DrawnOutcome>>) => void;
		/**
		 * Whether the Base Map's own source is drawing, and that it is not when it is not.
		 *
		 * ─────────────────────────────────────────────────────────────────────────────────────
		 * A PUBLISHED SITE HAS NO CONSOLE ANYONE IS WATCHING
		 *
		 * The editor's `BaseMapPane` reports the same status, for the same incident:
		 * `demo-bucket.protomaps.com` began refusing the archive every entry in this deployment's catalog
		 * reads, and the application's whole response was a pane with nothing in it. The viewer is the
		 * side with no developer looking: a Reader cannot tell an outage from a broken tool, and cannot
		 * rule out the third possibility either — that the scholar's own work failed to draw.
		 *
		 * **Reported, not rendered here**, for the same reason it is in the editor: what to say is the
		 * page's question, and the page already owns the fallback notice and the published-without-files
		 * notice that this has to sit beside without contradicting.
		 *
		 * `'drawing'` is sent when the source loads, so this is a state rather than a one-way alarm. The
		 * failure it is for is the archive that answers its header and then refuses tile **data** ranges
		 * — a bucket rate-limiting mid-session — because those go through an uncached read and do come
		 * back. The note on the `error` handler below has which failures recover and which cannot.
		 */
		onbasemapstatus?: (status: 'drawing' | 'unavailable') => void;
		/**
		 * Which Annotation is open, so the map draws that one more strongly.
		 *
		 * The same prop `BaseMapPane` takes, for the same reason: selection is the page's state, and
		 * the row, the map and the leader all read the one value.
		 */
		selectedAnnotationId?: string | null;
		/** Page-owned controls positioned over this pane. */
		controls?: Snippet;
		/**
		 * What the page draws *over* this pane, inside the pane's own positioned container.
		 *
		 * The Annotation Inspector is what this is for (ADR-0035), and it is the same prop the editor's
		 * `BaseMapPane` takes for the same panel: the Inspector is docked over the map, so it has to be
		 * positioned against the box the map fills rather than against the column the map is in — and the
		 * page owns what is in it, because a Reader's Annotations are no business of a map pane. The
		 * snippet's own element carries the position and the `z-index`; nothing here places it.
		 */
		overlay?: Snippet;
	} = $props();

	let container: HTMLDivElement;
	let map = $state<MapLibreMap | undefined>(undefined);

	/**
	 * Whoever wants to be told the camera has moved. The leader line, and nothing else.
	 *
	 * A set held here rather than the map handed out, because "the camera moved" is the whole of what
	 * the caller needs. It is also the only shape that works before the map exists: `onMount` binds
	 * the two events once, to this list, so a subscriber that arrived first is called from the first
	 * frame.
	 *
	 * An array rather than a `Set`, for the reason `BaseMapPane`'s twin records: a `SvelteSet` is what
	 * `svelte/prefer-svelte-reactivity` would have, and reactivity is the one property this must not
	 * have.
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

	/**
	 * Where `annotation` is drawn on the screen right now, for the leader to point at.
	 *
	 * Exported and imperative for the reason {@link onCameraMove} is: the leader asks this once per
	 * frame of a pan, and a value routed through a `$state` would cost a component flush per frame.
	 */
	export function annotationBox(annotation: Annotation): ScreenBox | null {
		return map ? annotationMarkBox(map, annotation) : null;
	}

	/**
	 * Whether this pane's map has been taken down, so that nothing asks a removed map anything.
	 *
	 * See the teardown note at the top of this file. A plain `let` rather than `$state`, deliberately:
	 * nothing may re-run because a map was removed. Its readers are teardowns and the recovery
	 * schedule's timer callback, and neither needs a reactive read — the schedule's own teardown clears
	 * the pending timer before this could matter, so the callback's check is a belt-and-braces guard
	 * against a frame already in flight rather than something that must observe a change.
	 */
	let removed = false;

	/** What the map is currently painted with. A plain `let`: nothing may re-run when it changes. */
	let painted = '';

	const paintKey = (
		id: string,
		currentTheme: string,
		cachedTo: number | null,
		drawnBorders: BaseMapBorders
	): string => `${id}@${currentTheme}@${cachedTo ?? 'network'}@${drawnBorders}`;

	/**
	 * The style for one catalog entry at the current theme.
	 *
	 * `resolveSiteAsset` rather than a bare path: the archive, the glyphs, and the sprites are files of
	 * this Published Site, and reaching them by `/base-map/…` would work at a domain root and 404 in a
	 * subdirectory (ADR-0006). An entry whose `archive` is an absolute URL is left alone — that is the
	 * `needsNetwork` case.
	 *
	 * **A bare style when the files are not here.** A site published without its Base Map (ADR-0020's
	 * opt-in) holds no `base-map/` directory at all, and a bundled entry's archive, glyphs, and sprites
	 * are all site-relative paths — so building the ordinary style would fire a pmtiles range request and
	 * two sprite requests at files that are not there. The Reader would get a blank map, three 404s, and
	 * no account of either. So the reference map is simply absent, the Project's own Layers still draw
	 * over the background, and the page says why (see `base-map-not-published`).
	 */
	const styleFor = (id: string): StyleSpecification => {
		const entry = catalog.entries.find((candidate) => candidate.id === id) ?? defaultEntry(catalog);
		// The site's own tiles answer first, whatever the entry's archive says: they are here, they need
		// no network, and they are the whole of ADR-0025's promise for a Published Site. The glyph and
		// sprite handling below is unchanged and independent — a site can carry tiles and no labels.
		if (cachedBaseMap) {
			const cached = baseMapStyle(entry, {
				theme: theme.current,
				catalog,
				resolveAsset: resolveSiteAsset,
				cachedTiles: { maxZoom: cachedBaseMap.maxZoom, tileTemplate: cachedBaseMapTileTemplate() },
				borders
			});
			if (bundledBaseMapAvailable) return cached;
			// The same absence as the network branch below, and with the same consequence for a Label —
			// see the note there.
			const withoutAssets = { ...cached };
			delete withoutAssets.glyphs;
			delete withoutAssets.sprite;
			return { ...withoutAssets, layers: cached.layers.filter((layer) => layer.type !== 'symbol') };
		}
		if (!bundledBaseMapAvailable && !isAbsoluteUrl(entry.archive)) {
			return {
				version: 8,
				sources: {},
				// No `glyphs` and no `sprite`: both are site-relative templates, and asking for them is the
				// other half of the same 404. Nothing the Layer stack draws needs the **sprite** — a warped
				// Map Image is custom WebGL, and a Pin is a symbol drawn from an image this app registers
				// itself. A **Label** does need glyphs, and `drawLayerStack` asks the style for them and
				// omits the Label bucket when they are absent, which is what makes this style safe to
				// build; `baseMapNotPublishedNotice` is where a Reader is told the Labels are not drawn.
				layers: [
					{
						id: 'ballastella-no-base-map',
						type: 'background',
						paint: { 'background-color': themeColour('--color-base-100') || '#ffffff' }
					}
				]
			};
		}
		const style = baseMapStyle(entry, {
			theme: theme.current,
			catalog,
			resolveAsset: resolveSiteAsset,
			// Registered lazily: the protocols spawn a worker, and a site whose catalog names no
			// elevation dataset never needs one. The cached branch above passes none at all — relief
			// is a live request, and a site's own tiles are the offline promise (ADR-0025).
			terrainTiles: catalog.terrain ? registerTerrainProtocols(catalog.terrain) : undefined,
			borders
		});
		if (bundledBaseMapAvailable) return style;
		// This site omitted its local glyphs and sprites, and this entry's archive is somebody else's,
		// so the geography can still be drawn. Keep it, and drop the symbol layers rather than firing
		// 404s at files the site does not carry — or worse, letting MapLibre silently substitute a
		// system font, which is invisible to every assertion about the map (ADR-0025).
		//
		// **A map with no place names on it is not a map that needs no explanation.** The page says so:
		// `baseMapNotPublished` in `+page.svelte` has a branch for exactly this state, and dropping it
		// would leave a Reader holding an unlabelled world with no account of why.
		//
		// ⚠ **The author's own Labels go too**, and the same notice names them. A Label's words are
		// shaped from these very typefaces, so `drawLayerStack` asks the style whether it carries
		// `glyphs` and omits the Label bucket when it does not — the Layer's Pins, Lines and Shapes are
		// untouched. Nothing else in the stack needs a font, and nothing at all needs the sprite.
		const withoutDisplayAssets = { ...style };
		delete withoutDisplayAssets.glyphs;
		delete withoutDisplayAssets.sprite;
		return {
			...withoutDisplayAssets,
			layers: style.layers.filter((layer) => layer.type !== 'symbol')
		};
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
		// Zoom sits at the bottom-left in every map pane in this application.
		created.addControl(new NavigationControl({}), 'bottom-left');

		// The camera's own events, for anything drawn over this pane in the page's coordinates rather
		// than in MapLibre's — see {@link onCameraMove}. Identical to `BaseMapPane`'s pair in the
		// editor, because the leader over a Reader's map is the same line over the same component.
		const cameraMoved = (): void => {
			for (const watcher of cameraWatchers) watcher();
		};
		created.on('move', cameraMoved);
		created.on('zoom', cameraMoved);

		// ──────────────────────────────────────────────────────────────────────────────────────
		// THE BASE MAP'S SOURCE, AND ONLY THAT SOURCE
		//
		// `error` carries everything MapLibre could not do — a warped Layer's tiles, a sprite, a glyph
		// range. Reporting the lot as "no Base Map" would be a notice that appears for reasons it does
		// not name, so this is filtered to the one source `baseMapStyle` declares. The same filter as
		// the editor's pane, and deliberately the same source id: `styleFor` builds both the archive
		// style and the cached-tiles style through `baseMapStyle`, so a site drawing from its own
		// `base-map/tiles/…` reports through this too, which is right — tiles that will not read are
		// as blank as an archive that will not answer.
		//
		// Only one of the five styles `styleFor` builds declares no source at all — the bare background,
		// which is reached for a site published without its Base Map **and** a site-relative archive.
		// Every entry in this deployment's catalog has an absolute archive, so the state a Reader
		// actually meets on a site published without those files is the remote style with its symbol
		// layers stripped, which declares this source, can fail, and reports here. Both notices can
		// therefore be on screen at once, and `+page.svelte` says nothing in either that the other
		// denies.
		//
		// ─────────────────────────────────────────────────────────────────────────────────────
		// WHY THERE IS A `'drawing'` AS WELL, AND WHICH FAILURE IT IS FOR
		//
		// The two ways an archive fails are not the same shape, and only one of them can come back:
		//
		//   - **A header that refuses is sticky for the life of the page.** `pmtiles`'
		//     `SharedPromiseCache.getHeader` caches the *promise* under the archive URL and never
		//     deletes a rejected one (`prune()` only evicts past 100 entries), `Protocol.tiles` holds
		//     one `PMTiles` per URL, and `registerPmtilesProtocol` makes one page-global `Protocol`. So
		//     a theme change, a Base Map switch, and all four of this deployment's entries — they share
		//     one archive — re-reject from cache without a request. Nothing can make a failed **header**
		//     draw again, and the Base Map switch is covered by the page's own reset anyway.
		//   - **Tile *data* ranges are not cached.** `getBytes` for tile data goes to the network
		//     afresh every time, so the bucket that rate-limits mid-session — the shape
		//     `routePartialBaseMapArchive` models — recovers the moment the limit lifts and the Reader
		//     pans: tiles arrive, geography draws, and without this handler the alert would still be
		//     sitting over a working map.
		//
		// ⚠ **A leaf directory is neither.** `getDirectory` shares the header's promise cache, so a
		// refused leaf directory is a cached rejection exactly like a refused header — which means an
		// archive big enough to have leaf directories, such as the planet-scale one this deployment
		// points at, does not necessarily recover even when its tile data would. The committed test
		// fixture is one city and has none, so what is driven is the pure tile-data case: real, and
		// not the whole of it.
		//
		// That case is the whole of what `'drawing'` is for. The one measurement worth keeping from the
		// round that deleted this: while the source is *persistently* failing, `sourcedata` fires only
		// with `isSourceLoaded: false` (`visibility`, `metadata`, `content`), so the handler cannot
		// withdraw a notice that is still true — which is asserted, and is why the partial-refusal
		// notice is also asserted to stay up.
		//
		// Identical to `BaseMapPane`'s pair in the editor, deliberately: same source id, same shared
		// sentence, and now the same recovery driven against both — `editor-base-map.e2e.ts`'s "is
		// taken down when the archive starts answering again" is this test on the authoring side, and
		// was added because deleting the editor's half left the whole repository green.
		created.on('error', (event) => {
			if ((event as { sourceId?: string }).sourceId !== BASE_MAP_SOURCE_ID) return;
			onbasemapstatus?.('unavailable');
		});
		// `sourcedata` rather than `load`: the map fires `load` once the *style* is in, which happens
		// whether or not the archive answered. What has to be observed is the source itself becoming
		// loaded, which is the event that does not fire while the archive is refusing.
		created.on('sourcedata', (event) => {
			if (event.sourceId !== BASE_MAP_SOURCE_ID || !event.isSourceLoaded) return;
			onbasemapstatus?.('drawing');
		});

		// A click reports the Annotation under it, and nothing else. There is no "place a point" here:
		// a Reader cannot draw, so a click on empty geography is a click on empty geography.
		created.on('click', (event) => {
			const hit = annotationAt(created, event.point);
			if (hit) onclickannotation?.(hit);
		});

		// Enter opens the Annotation at the centre of the map, which is what makes an Annotation
		// reachable without a pointer. MapLibre already pans the canvas with the arrow keys and zooms with
		// `+` and `-`, so "move the map to it, then press Enter" is a whole route with nothing new to
		// learn. Bound to MapLibre's own canvas rather than to the container, because the canvas already
		// carries `tabindex="0"`, a role, and an accessible name.
		created.getCanvas().addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			const centre = created.getCenter();
			const hit = annotationAt(created, created.project([centre.lng, centre.lat]));
			if (hit) onclickannotation?.(hit);
		});

		painted = paintKey(entryId, theme.current, cachedBaseMap?.maxZoom ?? null, borders);
		map = created;

		return () => {
			// Said *before* the map goes, because everything that reads it runs afterwards.
			removed = true;
			created.remove();
			map = undefined;
		};
	});

	/**
	 * Serve the site's own Base Map tiles, for as long as this pane is asking for them (ADR-0011).
	 *
	 * Registered in its own effect rather than inside `onMount`, so it survives a theme change's
	 * `setStyle` — and so it is in place before the style that reads the template is applied, since
	 * MapLibre requests a source's tiles the moment it is given one.
	 */
	$effect(() => {
		const cache = cachedBaseMap;
		if (!cache) return;
		return registerCachedBaseMapTiles(cache.readTile, recordCachedBaseMapTiles());
	});

	$effect(() => {
		const wanted = paintKey(entryId, theme.current, cachedBaseMap?.maxZoom ?? null, borders);
		const current = map;
		if (current === undefined || painted === wanted) return;
		painted = wanted;
		// One call, driven by one signal: the Base Map flavor changes in the same action that changes the
		// interface, which is the whole of ADR-0016's "not two independent toggles that agree".
		current.setStyle(styleFor(entryId));
	});

	/**
	 * Give the renderer frames to notice with while a Map Image's bytes are missing.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHAT A READER SITTING PERFECTLY STILL USED TO GET
	 *
	 * `WebGL2Renderer.render` re-asks for a refused `info.json` on every painted frame, which is the
	 * whole of the sentence's promise that the map "picks up what it can by itself". **MapLibre paints
	 * no frames when nothing changes.** So on a map that had fully settled — the commonest case for a
	 * Reader who is looking rather than navigating — the record was never re-requested and the notice
	 * stayed up for ever, however healthy the server became. Recovery worked only when an unrelated
	 * straggler repaint happened to land after the bytes came back, which is why the end-to-end test
	 * for it took anywhere from 6 to 42 seconds against a 45-second budget, and failed outright often
	 * enough to be reported as the suite's worst flake. See ADR-0028 for the measurements.
	 *
	 * The schedule and the reason it ends are core's — see `keepAskingForMissingTiles`. This effect is
	 * only the wiring, and it runs on **whether** something is missing, so the refusals these frames
	 * themselves provoke cannot re-arm it.
	 *
	 * ⚠ **The step is reported spent by `render`, not by `triggerRepaint` returning.** `triggerRepaint`
	 * only arms a `requestAnimationFrame`, and does nothing at all while one is already armed; a
	 * background tab runs no animation frames. Advancing on the call would let a Reader who looked at
	 * another tab burn all eleven waits on the single frame that paints when they come back. Waiting
	 * for `render` parks the schedule instead, so the budget is eleven frames the renderer really got.
	 */
	$effect(() => {
		if (!tilesMissing) return;
		const current = map;
		if (current === undefined) return;
		// At most one step is ever outstanding, so one listener is ever waiting.
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
			// A step left parked in a hidden tab holds a listener on a map that outlives this effect.
			if (waiting !== undefined) current.off('render', waiting);
		};
	});

	/** The last fit carried out. A plain `let`: recording one must not re-run the effect below. */
	let fitted: OpeningViewFit | null = null;

	/**
	 * Frame the map on {@link openingFit}, once per request (ADR-0026).
	 *
	 * Core's {@link applyOpeningFit}, the same function the editor's `BaseMapPane` calls — not the same
	 * few lines written twice, which is what it was, and which is the shape ADR-0026 warns about: a
	 * Published Site that frames a Project differently from the editor that made it.
	 */
	$effect(() => {
		fitted = applyOpeningFit(map, openingFit, fitted);
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
					: [stacked.layer.id, 'annotation', annotationDrawKey(stacked.annotations)]
			)
		])
	);

	let stack = $state.raw<StackRender | undefined>(undefined);

	/**
	 * How long the stack waits for the Base Map's style before saying it cannot be drawn on.
	 *
	 * Long enough that a slow-but-working load is never called a failure, short enough that the wait is
	 * accounted for rather than endured in silence — a Reader on a reading-room's wifi is exactly who
	 * meets this.
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
	 * **`isStyleLoaded()` is the gate, not the event.** `styledata` fires repeatedly while a style loads
	 * — the first arrives long before the sprites and the PMTiles header are in — so attaching on it is
	 * attaching to a map that will refuse to take a layer, and there is no second chance. `idle` as well
	 * as `styledata`, because a style already complete when the last `styledata` fires leaves nothing else
	 * to listen for. And a style that never completes is **reported** rather than waited on for ever:
	 * without `giveUp` the page would say "0 of 2 Layers are drawn" and give no reason, which tells a
	 * Reader their scholar's work is missing and not why.
	 *
	 * ⚠ **`giveUp` is an account of the wait, not the end of it.** The budget is a guess about how long
	 * a working load takes, and a loaded machine or a slow reading-room connection beats that guess
	 * routinely — so the listeners stay on afterwards, and a style that completes late is still drawn
	 * on. Stopping there left the Layers permanently undrawn on a map that had in fact arrived, which
	 * is the worse of the two failures and the one a Reader cannot recover from without reloading.
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
		target.on('idle', retry);
		poll = setInterval(retry, STYLE_POLL_MS);
		timer = setTimeout(() => {
			timer = undefined;
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
		for (const stacked of layers) {
			if (!isDrawnMap(stacked)) {
				built.setAnnotations(stacked.layer.id, stacked.annotations ?? { annotations: [] });
			}
		}
	});

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
</script>

<!--
	MapLibre gives the canvas `tabindex="0"`, a `role`, and an accessible name, and handles arrow-key
	panning and +/- zooming itself, so the pane is keyboard operable with nothing added here. The one
	addition is Enter to open the Annotation at the centre of the map, bound to the canvas in `onMount`
	rather than to this element — see there for why.

	The wrapper is positioned so that {@link overlay} has a containing block that is the map's own box,
	which is what lets the Annotation Inspector be docked over the map rather than beside it
	(ADR-0035). The same arrangement as the editor's `BaseMapPane`, deliberately: one panel, one dock.

	⚠ **`z-[6]` on the control block, the same number the editor's pane uses, and it is load-bearing.**
	`.maplibregl-map` opens no stacking context, so one context holds the leader at 5, MapLibre's four
	control corners at 6 (`packages/ui`'s `layout.css` has the rule and the reason) and the Annotation
	Inspector at 7. This block is pane furniture like the zoom control, so it sits with the corners at
	6. Above 7 it is *over* the Inspector, and below `lg` — where the Inspector is a sheet spanning the
	pane's width — the box then lies across the sheet and swallows the pointer events meant for it.
-->
<div class="relative h-full w-full">
	<div bind:this={container} class="h-full w-full" data-testid="reader-map-pane"></div>
	<div class="absolute top-2 left-2 z-[6] flex max-w-[calc(100%-1rem)] flex-wrap items-start gap-2">
		{@render controls?.()}
	</div>
	{@render overlay?.()}
</div>
