<script lang="ts">
	// The Published Site: a hub page listing the Projects, and one Project when `?p=` names it.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHY THE PROJECT LIST IS FETCHED RATHER THAN WALKED
	//
	// A static host has no directory listing, so nothing here can discover which folders hold a
	// Project the way the editor's Workspace does. Publishing therefore writes the list into
	// `ballastella-site.json` (ADR-0006's HTTP reader, ADR-0008's hub page), and this page reads it.
	// That record also carries the Base Map catalog the authoring deployment resolved, so a
	// Published Site keeps working when that deployment later changes its own catalog (ADR-0020).
	//
	// Everything is read **relative** to this document, never from `/` (ADR-0006), and everything is read
	// through **one** {@link ReadOnlyProjectStore}: ADR-0006's HTTP adapter, whose only method is `read`.
	// There is no second data path in this app and nothing in it can write. See `$lib/site-files`.
	//
	// ADR-0008 chose `?p=<folder>` over per-Project URLs so that the static adapter prerenders one
	// page: no SPA fallback, no post-build path rewriting, and nothing per-Project to keep in sync
	// when a Project is renamed or deleted. `?unwarped=<layer-id>` is on the same page and for the same
	// reason — a second *route* would be a second prerendered directory, which `VIEWER_FILE_PATHS` would
	// have to claim before publishing would write it.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// NOTHING A READER DOES IS AN EDIT
	//
	// Layer visibility and opacity are **view** controls over an in-memory copy of the stack. They call
	// core's own `setLayerVisible` and `setMapLayerOpacity` — the same pure functions the editor calls —
	// and then stop: there is no store `write` in this app to call next, and `project.json` is read-only
	// over HTTP anyway. Ticket 17 names the failure being avoided: a naive reuse of the editor's controls
	// would try to persist, fail, and surface a confusing error at a Reader.
	//
	// The one thing that *is* remembered is the Base Map choice, in `localStorage`, keyed per site
	// (ADR-0020) — never in Project data.

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		BASE_MAP_CATALOG,
		PUBLISHED_SITE_RECORD_NAME,
		PathNotFoundError,
		ProjectFormatTooNewError,
		SiteFileUnreachableError,
		baseMapFallbackNotice,
		cachedTilePath,
		createStoreImageFetch,
		imageInfoPath,
		isAbsoluteUrl,
		otherTheme,
		parseProjectFile,
		parsePublishedSite,
		projectFilePath,
		readBaseMapPreference,
		resolveBaseMap,
		openingViewSentence,
		projectOpeningFit,
		setLayerVisible,
		setMapLayerOpacity,
		writeBaseMapPreference,
		type Annotation,
		type AnnotationCollection,
		type AnnotationLayer,
		type GeoPoint,
		type Layer,
		type MapLayer,
		type OpeningViewFit,
		type OpeningViewOutcome,
		type ProjectFile,
		type PublishedSite
	} from '@ballastella/core';
	import type { DrawnLayer, DrawnOutcome } from '@ballastella/core/render';
	import { onMount, untrack } from 'svelte';

	import BaseMapSwitcher from '$lib/BaseMapSwitcher.svelte';
	import { readLayerDocuments, toContentLayers, type ReadDocuments } from '$lib/project-documents';
	import ReaderLayerControls from '$lib/ReaderLayerControls.svelte';
	import ReaderMapPane from '$lib/ReaderMapPane.svelte';
	import { readSiteFile, siteStore, sitePrefix } from '$lib/site-files';
	import { startTheme, theme } from '$lib/theme.svelte';
	import UnwarpedView from '$lib/UnwarpedView.svelte';
	import {
		parseServedImageInfo,
		servedImageManifest,
		servedImageServiceId,
		type ServedImageInfo
	} from '$lib/unwarped-manifest';

	/**
	 * Whether the page has hydrated — the line between the file a static host serves and a browser
	 * reading it.
	 *
	 * Everything gated on it needs something prerendering has not got. `page.url.searchParams` **throws**
	 * during prerendering, because a prerendered page is one file serving every query string (see
	 * {@link openDirectory}); there is no site record to read at build time, since publishing writes it
	 * and the build does not; and a Base Map preference is one Reader's `localStorage` rather than a fact
	 * about the file. So the prerendered HTML is the hub's own skeleton and nothing more.
	 */
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
		// ADR-0016: the theme ships with the viewer, and one signal drives the interface and the Base Map
		// flavor. Here rather than at module scope, because a module body runs during prerendering too.
		startTheme();
	});

	/**
	 * The Project asked for, or `null` for the hub.
	 *
	 * Gated on `hydrated` because **`page.url.searchParams` throws during prerendering**: SvelteKit
	 * refuses it outright, since a prerendered page is one file serving every query string and a build
	 * that read one would bake a single Project's answer into it. That refusal is the mechanism
	 * ADR-0008 is relying on when it says `?p=` needs no per-Project artefact — the selection is
	 * client-side by construction. So this is `null` while the static file is being written, and the
	 * prerendered HTML is the hub's own skeleton.
	 */
	const openDirectory = $derived(hydrated ? page.url.searchParams.get('p') : null);

	/** Which Historical Map is being read as a document, or `null` for the map (SPEC story 85). */
	const unwarpedLayerId = $derived(hydrated ? page.url.searchParams.get('unwarped') : null);

	let site = $state<PublishedSite | null>(null);
	/** Why the site record could not be read. A site with no record is not a site at all. */
	let siteError = $state('');

	let openProject = $state<{ directory: string; file: ProjectFile } | null>(null);
	let projectError = $state('');

	$effect(() => {
		// Only in the browser: prerendering has no site to read, and the record is written by
		// publishing rather than by the build.
		if (!hydrated) return;
		void (async () => {
			try {
				site = parsePublishedSite(await readSiteFile(PUBLISHED_SITE_RECORD_NAME));
				siteError = '';
			} catch (cause) {
				siteError = describeSiteRecordFailure(cause);
			}
		})();
	});

	/**
	 * Why the site record could not be read, in a Reader's terms.
	 *
	 * The three cases are genuinely different and reading them as one is how a Reader is misinformed: the
	 * bundle sitting in a half-set-up repository with nothing published into it yet, a host that is not
	 * answering, and a record that is there and corrupt. The adapter tells them apart (`PathNotFoundError`
	 * versus `SiteFileUnreachableError`), which is the whole reason it distinguishes them.
	 */
	function describeSiteRecordFailure(cause: unknown): string {
		if (cause instanceof PathNotFoundError) {
			return (
				'This site has no list of Projects yet. The viewer’s own files are here, but nothing has ' +
				'been published into this folder — publish again from Ballastella to add it.'
			);
		}
		if (cause instanceof SiteFileUnreachableError) return cause.message;
		return cause instanceof Error ? cause.message : String(cause);
	}

	$effect(() => {
		const directory = openDirectory;
		if (!hydrated || directory === null) {
			openProject = null;
			projectError = '';
			return;
		}
		void (async () => {
			try {
				const file = parseProjectFile(await readSiteFile(projectFilePath(directory)));
				// A read that arrives after the Reader has moved on must not overwrite what is showing.
				if (openDirectory !== directory) return;
				openProject = { directory, file };
				projectError = '';
			} catch (cause) {
				if (openDirectory !== directory) return;
				openProject = null;
				// `formatVersion` newer than this bundle understands is said plainly rather than misrendered
				// (ADR-0010), and a host that is not answering is said as such — a Published Site is a
				// snapshot that may outlive the app that wrote it, and both of those are ordinary.
				projectError =
					cause instanceof ProjectFormatTooNewError || cause instanceof SiteFileUnreachableError
						? cause.message
						: cause instanceof PathNotFoundError
							? `There is no Project called “${directory}” on this site.`
							: cause instanceof Error
								? cause.message
								: String(cause);
			}
		})();
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// The Reader's view of the stack
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The Layer stack as this Reader currently has it: the author's order, with their own visibility and
	 * opacity applied.
	 *
	 * **A copy in memory, and the copy is the point.** It starts as whatever `project.json` said, and a
	 * Reader's toggles and sliders replace it through core's own `setLayerVisible` and
	 * `setMapLayerOpacity` — the same functions the editor uses, so the semantics (0 is the top, opacity
	 * is clamped, opacity on an annotation Layer is a no-op) cannot drift between what an author sets and
	 * what a Reader sees. What does not follow is a write: there is none to call.
	 *
	 * `$state.raw`, because nothing here is mutated in place — every change replaces the array.
	 */
	let layers = $state.raw<readonly Layer[]>([]);

	/** Reset to the author's own stack whenever a different Project is opened. */
	$effect(() => {
		const file = openProject?.file ?? null;
		layers = file?.layers ?? [];
	});

	/**
	 * The Layers a Reader has left visible, and of a kind this build can draw.
	 *
	 * A hidden Layer is *absent* from what the map is given rather than flagged inside it, so there is no
	 * second place where a Layer can be in the stack and not drawn. A `foreign` Layer is absent for the
	 * same reason and says so in the list — this build cannot draw a kind it has never heard of, and
	 * ADR-0014 expects there to be one eventually.
	 */
	const shown = $derived(
		layers.filter(
			(layer): layer is MapLayer | AnnotationLayer => layer.visible && layer.kind !== 'foreign'
		)
	);

	let documents = $state.raw<ReadDocuments>({});
	/** Bumped by every load, so a read that resolves late knows it has been superseded. */
	let generation = 0;

	/**
	 * What requires the referenced documents to be read again: which Project, and which files.
	 *
	 * **Not** visibility and not opacity, which are view state and must not cost a fetch — a Reader
	 * dragging a slider on a phone would otherwise re-request every Alignment twenty times. A string,
	 * because deriveds compare by reference and any array recomputed from `layers` would make `layers`
	 * the real dependency however carefully a key was computed first.
	 */
	const documentKey = $derived(
		JSON.stringify([
			openProject?.directory ?? '',
			layers.map((layer) =>
				layer.kind === 'map'
					? [layer.id, layer.imageId]
					: layer.kind === 'annotation'
						? [layer.id, layer.geojsonRef]
						: [layer.id]
			)
		])
	);

	$effect(() => {
		void documentKey;
		const open = untrack(() => openProject);
		const wanted = untrack(() => layers);
		if (!open || wanted.length === 0) {
			documents = {};
			settleOpeningView(open, []);
			return;
		}
		const mine = ++generation;
		void (async () => {
			const read = await readLayerDocuments(siteStore(), open.directory, wanted);
			if (mine !== generation) return;
			documents = read;
			settleOpeningView(open, toContentLayers(wanted, read));
		})();
	});

	// ──────────────────────────────────────────────────────────────────────────────────────
	// The opening view (ADR-0026)
	//
	// **The same core function, cap and padding the editor uses.** ADR-0026 names this as the half
	// most likely to be forgotten: a Published Site that opened on the deployment's default while the
	// editor opened on the author's work would be two answers to one question, and the Reader is the
	// one person who cannot tell which is right.
	//
	// Settled off the back of the read the page was doing anyway, rather than by a read of its own — a
	// Reader on a phone should not fetch every Alignment twice — and settled **once per Project**.
	// Bounds in a `$derived` would refit whenever the Reader hid a Layer or dragged an opacity slider,
	// which is the map moving under someone who was reading it.
	// ──────────────────────────────────────────────────────────────────────────────────────

	let openingFit = $state.raw<OpeningViewFit | null>(null);
	/** `content` when the map was framed on the Project, `default` when there was nothing to frame on. */
	let openingOutcome = $state<OpeningViewOutcome>('pending');
	/** Whether the last framing was the Reader asking, so the sentence can say which. */
	let refitted = $state(false);

	/**
	 * The Project the opening view has already been settled for.
	 *
	 * A plain `let`: it is written by the code that reads it, and a reactive one would make the
	 * settling its own dependency.
	 */
	let framedProject = '';

	function settleOpeningView(
		open: { directory: string } | null,
		content: ReturnType<typeof toContentLayers>
	): void {
		// Back at the hub. Cleared rather than left standing, so that opening the same Project again is
		// a fresh open and frames again — which is what a Reader who has navigated away and back means.
		if (open === null) {
			framedProject = '';
			openingFit = null;
			openingOutcome = 'pending';
			return;
		}
		if (framedProject === open.directory) return;
		framedProject = open.directory;
		const fit = projectOpeningFit(content);
		openingFit = fit;
		openingOutcome = fit === null ? 'default' : 'content';
		refitted = false;
	}

	/**
	 * "Fit to this Project", on demand (ADR-0026).
	 *
	 * From the documents already in hand and from the stack **as the Reader currently has it**, so a
	 * Reader who has hidden two of five Layers gets framed on the three they are looking at. No fetch:
	 * everything this needs was read when the Project opened.
	 *
	 * A fresh fit object each press, even for the same box — identity is what the pane applies on, and
	 * a Reader pressing this twice has panned away in between.
	 */
	function fitToProject(): void {
		const fit = projectOpeningFit(toContentLayers(layers, documents));
		openingFit = fit;
		openingOutcome = fit === null ? 'default' : 'content';
		refitted = true;
	}

	/**
	 * Where an aligned Historical Map's tiles are read from (ADR-0011).
	 *
	 * The same shim the editor gives MapLibre, over the HTTP store rather than over OPFS — which is
	 * ADR-0001's abstraction paying out and the reason there is no second tile path here. A local copy's
	 * `info.json` carries the `unset.invalid` placeholder, this resolves it against `images/<image-id>/`
	 * at the **site root** (ADR-0023), and a referenced image's real address passes straight through to
	 * the library that holds it.
	 *
	 * No longer per-Project, because the pyramids are not: one shim serves every Project of the site, and
	 * two Projects drawing the same Historical Map draw the same bytes.
	 */
	const fetchTile = $derived(createStoreImageFetch({ store: siteStore() }));

	/** The stack as the map takes it: top first, each Layer with its documents in hand. */
	const drawn = $derived<readonly DrawnLayer[]>(
		shown.flatMap((layer): DrawnLayer[] => {
			const read = documents[layer.id];
			// **Nothing is handed to the map until its documents have arrived.** A map Layer given
			// `service: ''` while its `remote.json` is still in flight draws blank and reports itself drawn
			// — the defect recorded on ticket 09, which this avoids by having a third state rather than two
			// (see `$lib/project-documents`).
			if (read?.status !== 'ready') return [];
			if (layer.kind === 'map') {
				if (!read.alignment) return [];
				return [
					{
						layer,
						alignment: read.alignment,
						referenced: read.referenced ?? false,
						service: read.service ?? ''
					}
				];
			}
			return [{ layer, annotations: read.annotations ?? null }];
		})
	);

	/** What the map made of each Layer it was given. */
	let rendered = $state.raw<Readonly<Record<string, DrawnOutcome>>>({});

	/**
	 * What the list says about each Layer: what the map reported, plus what the map never got.
	 *
	 * **Keyed off the Layers that are currently shown, and nothing else.** That is not incidental
	 * tidiness: the editor's equivalent merges over `{ ...rendered }`, which is never pruned, so a Layer
	 * the Reader has just hidden goes on being counted as drawn — the `data-drawn` defect recorded
	 * against the editor's Layer stack, which ticket 04 moved into
	 * `apps/editor/src/lib/project/ProjectScreen.svelte`. Building the record from `shown` means a
	 * Layer that has left the stack cannot survive in it, so the count below is a fact about the map
	 * rather than a high-water mark.
	 */
	const outcomes = $derived.by((): Readonly<Record<string, DrawnOutcome>> => {
		const merged: Record<string, DrawnOutcome> = {};
		for (const layer of shown) {
			const read = documents[layer.id];
			if (read?.status === 'unreadable') {
				merged[layer.id] = { status: 'refused', reason: read.reason };
				continue;
			}
			if (read === undefined || read.status === 'loading') {
				merged[layer.id] = { status: 'refused', reason: 'Still loading…' };
				continue;
			}
			const reportedByMap = rendered[layer.id];
			if (reportedByMap) {
				merged[layer.id] = reportedByMap;
				continue;
			}
			merged[layer.id] =
				layer.kind === 'map'
					? {
							status: 'refused',
							reason: 'This Historical Map has not been aligned, so it is not drawn.'
						}
					: { status: 'refused', reason: 'This Layer has no Annotations in it.' };
		}
		return merged;
	});

	/** How many Layers are actually on the map. Said, because "nothing is drawn" has many reasons. */
	const drawnCount = $derived(
		Object.values(outcomes).filter((outcome) => outcome.status === 'drawn').length
	);

	/**
	 * Which Layers still fetch their Historical Map from the library that holds it (SPEC story 29).
	 *
	 * Said out loud on the page rather than only warned about at publish time, because the Reader is the
	 * person who meets the consequence: on a train, or after the library reorganises, those Layers draw
	 * nothing (ADR-0007).
	 *
	 * Read from what the site's own files say rather than from a field of `project.json` (ADR-0023), which
	 * is why it comes out of `documents`: a Layer whose documents have not arrived yet is not counted, and
	 * so this says "needs the network" only once something has actually been observed to.
	 */
	const needsNetwork = $derived(
		layers.filter((layer) => layer.kind === 'map' && referencedImageIds.has(layer.imageId))
	);

	/**
	 * The Historical Maps this site does not hold its own tiles for, by image id.
	 *
	 * Out of `documents`, which is where the observation was made — see `readMapLayer`. A Layer whose
	 * documents have not arrived yet is in neither state and is absent, so nothing claims a map needs the
	 * network before anything has looked for it.
	 *
	 * **A projection of that observation and not a second reading of the rule.** `readMapLayer` hands its
	 * two 404 probes to core's `tileLocation`, the same function the editor and publishing answer this
	 * with; what is local to this page is only the three-state handling `documents` needs and the store
	 * behind it does not have.
	 */
	const referencedImageIds = $derived(
		new Set(
			layers.flatMap((layer) => {
				if (layer.kind !== 'map') return [];
				const read = documents[layer.id];
				// Both statuses, because the two questions are independent (see `readMapLayer`): a Layer
				// whose Alignment will not parse is still one whose tiles need the network, and the Reader is
				// owed that either way.
				return read?.status === 'loading' || read === undefined || read.referenced !== true
					? []
					: [layer.imageId];
			})
		)
	);

	/** Every referenced host that failed to answer, so the message can name it (ticket 17's table). */
	const unreachable = $derived(
		layers.flatMap((layer) => {
			const read = documents[layer.id];
			return read?.status === 'unreadable' && read.hostUnreachable
				? [{ name: layer.name || layer.id, reason: read.reason }]
				: [];
		})
	);

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// The Base Map (ADR-0020)
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The catalog to draw from: the one that **travelled with this site**, falling back to this bundle's.
	 *
	 * ADR-0020's point is that a Published Site keeps working when the authoring deployment later changes
	 * its own catalog, so the record wins. The fallback is for a site whose record could not be read at
	 * all, where offering this build's Base Maps is a working map rather than a blank pane.
	 */
	const catalog = $derived(site?.baseMap ?? BASE_MAP_CATALOG);

	/**
	 * This Reader's own choice, or `null` — read once per site rather than watched.
	 *
	 * `null` until the Reader chooses, so the **author's default governs first contact** (SPEC story 69),
	 * which is the moment that carries the argument.
	 */
	let chosen = $state<string | null>(null);
	$effect(() => {
		if (!hydrated) return;
		chosen = readBaseMapPreference(readerStorage(), sitePrefix());
	});

	/**
	 * `localStorage`, or `null` where there is none.
	 *
	 * A function rather than a captured reference: merely *touching* `window.localStorage` throws in
	 * Safari's private browsing and wherever site data is blocked, so the access has to be inside the
	 * `try` — and a Reader who has switched storage off must still get the author's default rather than a
	 * page that will not render.
	 */
	function readerStorage(): Storage | null {
		try {
			return typeof window === 'undefined' ? null : window.localStorage;
		} catch {
			return null;
		}
	}

	/**
	 * The Base Map actually shown: this Reader's choice if they have one, else the author's default, and
	 * in both cases resolved against the catalog so an id this site cannot serve falls back **visibly**.
	 */
	const baseMap = $derived(resolveBaseMap(chosen ?? openProject?.file.baseMap ?? null, catalog));
	const baseMapNotice = $derived(baseMapFallbackNotice(baseMap));

	/**
	 * Whether this site carries the Base Map's own files (ADR-0020, SPEC stories 88 and 89).
	 *
	 * Read out of the site record, because including them is opt-in at publish time: they are about 4.9 MB
	 * against the same hosting budget as the scholar's Historical Maps, and a scholar publishing to a
	 * network-connected audience reasonably leaves them out.
	 *
	 * **Absent means absent, and the map waits rather than guessing** — see {@link siteRecordKnown}. This
	 * used to default to `true` while the record was still being read, on the reasoning that no record at
	 * all is the pre-publish bundle. But the record and the Project are read by two independent effects,
	 * so on a real site `?p=` could open a Project before the record arrived, and the pane would build the
	 * ordinary style and fire exactly the pmtiles and sprite requests at absent files that this whole path
	 * exists to prevent. It was invisible because it lost the race: it took removing an unrelated
	 * `{@html}` from this page, which had been slowing hydration just enough, for the requests to appear.
	 */
	const bundledBaseMapAvailable = $derived(site?.baseMapAssetsBundled ?? false);

	/**
	 * The site's own Base Map tiles, or `null` when it carries none (ADR-0025).
	 *
	 * `baseMapMaxZoom` comes off the site record because a static host cannot list a directory, so the
	 * viewer has no way to read the pyramid's depth off the files the way the editor does. Reading a
	 * tile goes through the same read-only HTTP store every other byte of this site does: `null` for a
	 * 404, which the protocol handler answers with an empty tile rather than a console full of errors.
	 */
	const cachedBaseMap = $derived.by(() => {
		const maxZoom = site?.baseMapMaxZoom;
		if (site?.baseMapBundled !== true || typeof maxZoom !== 'number') return null;
		return {
			maxZoom,
			readTile: async (tile: { z: number; x: number; y: number }) => {
				try {
					return await siteStore().read(cachedTilePath(tile));
				} catch {
					return null;
				}
			}
		};
	});

	/**
	 * Whether the site record question has been settled — read, or failed to read.
	 *
	 * The map pane waits for this, because the style it builds on its first frame depends on the answer
	 * and MapLibre requests a style's files as soon as it is given one. Waiting rather than restyling: a
	 * corrected style still leaves the first style's 404s in the network log, which is the thing being
	 * promised against.
	 */
	const siteRecordKnown = $derived(site !== null || siteError !== '');

	/**
	 * What the Reader is missing from the modern reference map, or `''`.
	 *
	 * Said rather than left unexplained, and there are **two** ways a site can be short of the Base Map's
	 * files — they differ in what the Reader sees, so they cannot share one sentence:
	 *
	 *   - **No files and a site-relative archive**: nothing draws. An empty rectangle under the work.
	 *   - **No files and a `needsNetwork` archive**: since ticket 10 every catalog entry reads a remote
	 *     archive, so the geography draws over the network — and `ReaderMapPane` drops `glyphs`, `sprite`,
	 *     and every `symbol` layer rather than firing 404s at files the site does not carry. The result is
	 *     a map with roads, coastlines, and **no place names at all**. That is a startling thing to be
	 *     handed with no account of itself, and it is the case a Reader now actually meets: silently
	 *     losing every label is exactly the failure ADR-0025 says those 820 KB exist to prevent.
	 *
	 * The entries that *would* be complete are already marked in the switcher, so each sentence points at
	 * the way out rather than merely apologising.
	 */
	const baseMapUnavailable = $derived(
		bundledBaseMapAvailable
			? ''
			: !isAbsoluteUrl(baseMap.entry.archive)
				? 'This site was published without its own copy of the modern reference map, so only the ' +
					'Historical Maps and Annotations are drawn. The Base Maps marked “needs network” still work.'
				: 'This site was published without the Base Map’s labels and symbols, so the modern reference ' +
					'map is drawn from the network without any place names on it. The geography, the ' +
					'Historical Maps, and the Annotations are all here.'
	);

	/** Remember the Reader's choice for this site, and for no other (ADR-0020). Never Project data. */
	function chooseBaseMap(id: string): void {
		chosen = id;
		writeBaseMapPreference(readerStorage(), sitePrefix(), id);
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Annotation popups (SPEC story 67) — the highest-stakes surface in the epic
	// ─────────────────────────────────────────────────────────────────────────────────────────

	let selected = $state.raw<{ layerId: string; annotationId: string; at: GeoPoint } | null>(null);

	/**
	 * The open Annotation, out of the collection the map is drawing.
	 *
	 * Its `title` and `description` are **untrusted text**: a Published Site runs on the author's own
	 * domain, and the Project may have arrived from a stranger by zip import (ticket 13) or from a remote
	 * library (ticket 14). Neither is turned into HTML here. `showAnnotationPopup` in
	 * `@ballastella/core/render` builds the popup from `renderAnnotationPopup`, which escapes the title
	 * and runs the description through `marked` then DOMPurify in that order, and holds this repository's
	 * one `setHTML` (ADR-0009).
	 */
	const selectedAnnotation = $derived.by((): Annotation | null => {
		if (!selected) return null;
		const read = documents[selected.layerId];
		if (read?.status !== 'ready') return null;
		const collection = read.annotations as AnnotationCollection | null | undefined;
		return collection?.annotations.find((one) => one.id === selected?.annotationId) ?? null;
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Reading a Historical Map as a document (SPEC story 85)
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/** The map Layer being read unwarped, or `null`. */
	const unwarpedLayer = $derived<MapLayer | null>(
		(layers.find((layer) => layer.kind === 'map' && layer.id === unwarpedLayerId) as
			MapLayer | undefined) ?? null
	);

	let unwarped = $state.raw<{ layerId: string; info: ServedImageInfo } | null>(null);
	let unwarpedError = $state('');

	$effect(() => {
		const layer = unwarpedLayer;
		const open = openProject;
		if (!layer || !open) {
			unwarped = null;
			unwarpedError = '';
			return;
		}
		const { imageId } = layer;
		void (async () => {
			if (imageId === '') {
				unwarpedError = 'This site does not record where this Historical Map’s image is.';
				return;
			}
			try {
				// The published `info.json`, which is the document that describes the pyramid — and, in its
				// own `id`, the document that decides where a tiling viewer will fetch from. See
				// `$lib/unwarped-manifest` for why nothing here can override that.
				const bytes = await siteStore().read(imageInfoPath(imageId));
				if (unwarpedLayerId !== layer.id) return;
				const info = parseServedImageInfo(bytes);
				if (servedImageServiceId(info) === null) {
					// **Refused rather than shown empty.** The pyramid's `info.json` still carries the ADR-0004
					// placeholder, so every tile OpenSeadragon asked for would fail at DNS and the Reader would
					// be looking at a blank rectangle with nothing to explain it. Ticket 17's degradation rule
					// is to say so plainly rather than misrender, and this is that case.
					unwarped = null;
					unwarpedError =
						'This Historical Map cannot be opened on its own from this site yet. Its image was ' +
						'tiled without a web address, so nothing here can fetch the sheet. The scholar who ' +
						'published this site can fix it by publishing again and giving Ballastella the address ' +
						'the site is at, which turns the map into a citable IIIF endpoint. It is still shown ' +
						'aligned on the map.';
					return;
				}
				unwarped = { layerId: layer.id, info };
				unwarpedError = '';
			} catch (cause) {
				if (unwarpedLayerId !== layer.id) return;
				unwarped = null;
				unwarpedError =
					cause instanceof PathNotFoundError
						? 'The image behind this Historical Map is not on this site, so it cannot be read as a document.'
						: cause instanceof Error
							? cause.message
							: String(cause);
			}
		})();
	});

	/**
	 * The Manifest triiiceratops is given.
	 *
	 * The service id is the pyramid's **own** declared `id` and never a URL this page composed, because a
	 * composed one would produce a Manifest that looks right over a viewer fetching from somewhere else
	 * entirely — see `$lib/unwarped-manifest` for the measurement. By the time this runs, `unwarped` is
	 * only non-null when that id is fetchable.
	 */
	const unwarpedSource = $derived.by(() => {
		const layer = unwarpedLayer;
		if (!layer || !unwarped || unwarped.layerId !== layer.id) return null;
		const serviceId = servedImageServiceId(unwarped.info);
		if (serviceId === null) return null;
		return {
			manifestId: `${serviceId}/manifest.json`,
			manifest: servedImageManifest({ serviceId, label: layer.name, info: unwarped.info })
		};
	});

	/**
	 * Open a Historical Map as a document, and come back (SPEC story 85).
	 *
	 * Query only, on the one route ADR-0008 chose: a second route would be a second prerendered
	 * directory, which `VIEWER_FILE_PATHS` would have to claim before publishing would write it.
	 *
	 * `goto` rather than `location.href`, so this is a **client-side** navigation. That is the harder
	 * case and the one worth having: it destroys the map-bearing pane and mounts the unwarped one inside
	 * a single Svelte flush, which is exactly where an exception in a teardown abandons the incoming
	 * mount and a page renders nothing at all. Coming back is `history.back()`, so the Reader's place in
	 * the site is where they left it.
	 */
	function readAsDocument(layerId: string): void {
		if (openDirectory === null) return;
		void goto(
			resolve(`/?p=${encodeURIComponent(openDirectory)}&unwarped=${encodeURIComponent(layerId)}`)
		);
	}

	/** What this site calls itself in the tab. The hub has no name of its own beyond the tool's. */
	const title = $derived(
		openProject ? `${openProject.file.name} — Ballastella` : 'Ballastella — published Projects'
	);
</script>

<svelte:head><title>{title}</title></svelte:head>

<!-- Escape closes an open Annotation popup from anywhere on the page, not only over the map. -->
<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && selected !== null) selected = null;
	}}
/>

<!--
	`max-w-*` with `mx-auto`, and horizontal padding that shrinks: at 375 px the `p-8` this page used to
	carry spent 43% of the viewport on margins. Nothing here has a fixed width, so the page never scrolls
	sideways (ticket 17's criterion, and SPEC story 84 — a phone is where most Readers arrive).
-->
<main class="mx-auto max-w-6xl p-4 sm:p-8">
	{#if openDirectory === null}
		<div class="flex flex-wrap items-baseline justify-between gap-4">
			<h1 class="text-3xl font-bold">Published Projects</h1>
			<button type="button" class="btn btn-sm" onclick={() => theme.toggle()}>
				Switch to {otherTheme(theme.current)} theme
			</button>
		</div>

		<!--
			The site's own sentence about itself, as ordinary markup.

			It was Markdown put through `renderAnnotationPopup` and `{@html}`-ed, which made this page's
			marketing copy into a pseudo-Annotation: an Annotation is a scholar's content (CONTEXT.md), and
			the shared renderer's job is a stranger's untrusted text rather than a string in this file. The
			shared path is live in this bundle where it belongs — `ReaderMapPane` builds every Annotation
			popup through `showAnnotationPopup`, which is `renderAnnotationPopup` and this repository's one
			`setHTML` — and `e2e/viewer-reader.e2e.ts` asserts a payload is inert there, on the surface a
			stranger's Project actually writes. There is now no `{@html}` anywhere in this app.
		-->
		<p class="mt-4 max-w-prose">
			These are the Projects published from one Ballastella Workspace. A Reader can look at the work
			— the aligned Historical Maps and the Annotations written over them — and cannot change it.
			Published with
			<a class="link" href="https://github.com/artshumrc/ballastella#readme">Ballastella</a>.
		</p>

		{#if siteError}
			<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
				<h2 class="font-semibold">This site has no list of Projects</h2>
				<p data-testid="site-problem">{siteError}</p>
			</div>
		{:else if site === null}
			<p class="mt-8">Looking for the Projects on this site…</p>
		{:else if site.projects.length === 0}
			<p class="mt-8">This site has no Projects on it yet.</p>
		{:else}
			<ul class="mt-8 flex flex-col gap-3" data-testid="published-projects">
				{#each site.projects as project (project.directory)}
					<li class="card bg-base-100 card-border">
						<div class="card-body">
							<h2 class="text-lg font-medium">
								<!--
									Interpolated as text, never as markup. A display name comes out of a `project.json`
									and is untrusted content: this site runs on the author's own domain, so a name
									carrying `<img src=x onerror=…>` rendered as HTML would be stored XSS there
									(ADR-0009). Svelte escapes it, and both `e2e/editor-publish.e2e.ts` and
									`e2e/viewer.e2e.ts` assert both halves — that the real name is on the page, and
									that no element came with it.
								-->
								<a class="link" href={resolve(`/?p=${encodeURIComponent(project.directory)}`)}
									>{project.name}</a
								>
							</h2>
							<p class="text-sm break-words opacity-70">
								folder <code>{project.directory}</code>
							</p>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<!--
			Through `resolve`, which under `paths.relative: true` emits a relative URL — so the link works
			at a domain root and in a subdirectory alike (ADR-0006), and the prerendered HTML carries no
			absolute path for the CI fence to find.
		-->
		<p><a class="link" data-testid="all-projects" href={resolve('/')}>All Projects</a></p>

		{#if projectError}
			<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
				<h1 class="text-xl font-semibold">This Project cannot be shown</h1>
				<p data-testid="project-problem">{projectError}</p>
			</div>
		{:else if openProject === null}
			<p class="mt-4">Opening…</p>
		{:else}
			<div class="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
				<h1 class="text-3xl font-bold" data-testid="project-name">{openProject.file.name}</h1>
				<button type="button" class="btn btn-sm" onclick={() => theme.toggle()}>
					Switch to {otherTheme(theme.current)} theme
				</button>
			</div>

			{#if unwarpedLayerId !== null}
				<!--
					Reading one Historical Map on its own. A separate branch rather than a panel beside the
					map, deliberately: two tile viewers over one WebGL-bearing page is a phone running out of
					memory, and a Reader who asked to read the sheet is not looking at the geography.

					**This is a navigation between two map-bearing panes**, which is the shape that once made a
					destination page render nothing at all — an exception in the outgoing pane's teardown
					abandons the rest of Svelte's destroy flush *and* the incoming mount. `e2e/viewer.e2e.ts`
					puts a `pageerror` assertion on it in both directions and on both ways in (by link, and by
					loading the URL directly).
				-->
				<p class="mt-4">
					<a
						class="link"
						data-testid="back-to-project"
						href="{resolve('/')}?p={encodeURIComponent(openDirectory)}"
					>
						Back to this Project’s map
					</a>
				</p>
				{#if unwarpedError}
					<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
						<p data-testid="unwarped-problem">{unwarpedError}</p>
					</div>
				{:else if unwarpedLayer === null}
					<p class="mt-4" data-testid="unwarped-problem">
						This Project has no Historical Map with that name.
					</p>
				{:else if unwarpedSource === null}
					<p class="mt-4">Opening the sheet…</p>
				{:else}
					<UnwarpedView
						label={unwarpedLayer.name}
						manifestId={unwarpedSource.manifestId}
						manifest={unwarpedSource.manifest}
						onclose={() => history.back()}
					/>
				{/if}
			{:else}
				<!--
					One column on a phone and two from `lg` up. The controls come **first** in the DOM so that
					tabbing reaches them before MapLibre's canvas and its zoom buttons, and on a narrow screen
					they are what a Reader sees under the heading rather than below a full-height map.
				-->
				<div class="mt-4 grid items-start gap-6 lg:grid-cols-[22rem_1fr]">
					<div class="flex flex-col gap-4">
						<BaseMapSwitcher
							entryId={baseMap.entry.id}
							{catalog}
							onSelect={(id) => chooseBaseMap(id)}
						/>

						{#if baseMapNotice}
							<p class="text-sm text-warning" aria-live="polite" data-testid="base-map-notice">
								{baseMapNotice}
							</p>
						{/if}

						{#if baseMapUnavailable}
							<p class="text-sm text-warning" aria-live="polite" data-testid="base-map-unavailable">
								{baseMapUnavailable}
							</p>
						{/if}

						<ReaderLayerControls
							{layers}
							{outcomes}
							{referencedImageIds}
							onshow={(id, visible) => (layers = setLayerVisible(layers, id, visible))}
							onopacity={(id, opacity) => (layers = setMapLayerOpacity(layers, id, opacity))}
							onunwarped={readAsDocument}
						/>

						{#if needsNetwork.length > 0}
							<p class="text-sm text-warning" data-testid="project-needs-network">
								{needsNetwork.length === 1
									? 'One Historical Map'
									: `${needsNetwork.length} Historical Maps`}
								here {needsNetwork.length === 1 ? 'is' : 'are'} held on the library's own server rather
								than in this site: {needsNetwork.map((layer) => layer.name).join(', ')}. Without a
								network connection {needsNetwork.length === 1 ? 'it' : 'they'} cannot be shown.
							</p>
						{/if}

						{#if unreachable.length > 0}
							<div role="alert" class="alert flex-col items-start alert-warning">
								<h2 class="font-semibold">Some of this Project could not be reached</h2>
								{#each unreachable as failure (failure.name)}
									<p data-testid="layer-unreachable">{failure.reason}</p>
								{/each}
							</div>
						{/if}
					</div>

					<div>
						<!--
							ADR-0026's explicit control, with words on it rather than an icon and a tooltip (SPEC
							story 111). It is what the once-only automatic fit gives up: a Reader who has panned
							away, or hidden half the stack, comes back with this.
						-->
						<div class="mb-2 flex flex-wrap items-center justify-end gap-2">
							<button
								type="button"
								class="btn btn-sm"
								data-testid="fit-to-project"
								onclick={() => fitToProject()}
							>
								Fit to this Project
							</button>
						</div>
						<!--
							A viewport-relative height on a phone and a fixed one from `sm` up. `36rem` of map on
							a 667 px-tall phone leaves the controls below the fold and nothing above it.
						-->
						<div
							class="h-[60vh] overflow-hidden rounded border border-base-300 sm:h-[32rem] lg:h-[36rem]"
						>
							{#if siteRecordKnown}
								<ReaderMapPane
									entryId={baseMap.entry.id}
									{catalog}
									{bundledBaseMapAvailable}
									{cachedBaseMap}
									layers={drawn}
									{openingFit}
									{fetchTile}
									popupAnnotation={selectedAnnotation}
									popupAt={selected?.at ?? null}
									onclickannotation={(hit) => (selected = hit)}
									onpopupclose={() => (selected = null)}
									onstack={(reported) => (rendered = reported)}
								/>
							{/if}
						</div>
						<!--
							What is on the map, in words. `aria-live` rather than `role="status"`, because a Reader
							who has just hidden a Layer needs to be told what the map now holds — and "nothing is
							drawn" has many reasons, each of which is beside its own Layer in the list.
						-->
						<p
							class="mt-2 min-h-6 text-sm"
							aria-live="polite"
							aria-atomic="true"
							data-testid="stack-status"
							data-drawn={drawnCount}
						>
							{#if layers.length === 0}
								This Project has nothing on the map.
							{:else}
								{drawnCount} of {layers.length}
								{layers.length === 1 ? 'Layer is' : 'Layers are'} drawn over the Base Map.
							{/if}
						</p>
						<!--
							Where the map is looking and why (SPEC story 112). A WebGL canvas announces nothing
							about what it is showing, so a Reader who cannot see it is otherwise never told that
							the map opened on the author's own work rather than on a default somewhere else.
						-->
						<p
							class="min-h-6 text-sm text-base-content/70"
							aria-live="polite"
							aria-atomic="true"
							data-testid="opening-view"
							data-opening-view={openingOutcome}
						>
							{openingViewSentence(openingOutcome, refitted)}
						</p>
					</div>
				</div>
			{/if}
		{/if}
	{/if}
</main>
