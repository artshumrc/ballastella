<script lang="ts">
	// The Published Site: a Front Page listing the Projects offered to a Reader, and one Project when
	// `?p=` names it.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHY THE PROJECT LIST IS FETCHED RATHER THAN WALKED
	//
	// A static host has no directory listing, so nothing here can discover which folders hold a
	// Project the way the editor's Workspace does. Publishing therefore writes the list into
	// `ballastella-site.json` (ADR-0006's HTTP reader, ADR-0008's Front Page), and this page reads it.
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
	// over HTTP anyway.
	//
	// The one thing that *is* remembered is the Base Map choice, in `localStorage`, keyed per site
	// (ADR-0020) — never in Project data.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE STACK IS THE EDITOR'S `LayerList`, AND SUBTRACTION IS WHAT MAKES IT A READER'S
	//
	// A Reader reads the same card a scholar authored on — kind tint, kind line, disclosure, the drained
	// header of a hidden Layer, the problem band — because a published Project that looks like a
	// different application is the thing this was for. The viewer's own `ReaderLayerControls` was a
	// second implementation of that idea, written when every write `LayerList` emitted was a required
	// prop; **that is no longer true**, so reuse no longer implies a write. Every editing callback is
	// optional there, and the controls a Reader must never see are the callbacks this page does not
	// pass: no `ontypename`/`oncommit`, no `onmove`, no `ondelete`, no `problemAction`.
	//
	// `referencedImageIds` is withheld for a different reason, and it is not a safety one: where a
	// Map Image's tiles are held is the author's publishing decision, and a Reader cannot copy a
	// pyramid or repoint a service. The badge stays in the editor, where the fact is actionable (SPEC
	// stories 20 and 21). {@link needsNetwork} below is not that badge and stays: it names what will not
	// draw without a connection, which is a thing a Reader meets.
	//
	// ⚠ **There is no `readOnly`, `mode` or `editable` prop to pass, and adding one would be wrong.** A
	// flag beside the callbacks is a second description of the same thing and the two can disagree; the
	// argument is at the head of `LayerList.svelte`.

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		BASE_MAP_CATALOG,
		PUBLISHED_SITE_RECORD_NAME,
		PathNotFoundError,
		ProjectFormatTooNewError,
		SiteFileUnreachableError,
		baseMapArchiveHost,
		baseMapFallbackNotice,
		baseMapNotPublishedNotice,
		baseMapUnavailableNotice,
		cachedTilePath,
		legacyCachedTilePath,
		createStoreImageFetch,
		mapImageTilesUnavailableNotice,
		imageInfoPath,
		parseProjectFile,
		parsePublishedSite,
		projectFilePath,
		readBaseMapPreference,
		readRemoteBinding,
		resolveBaseMap,
		returnLinkUrl,
		projectOpeningFit,
		setLayerVisible,
		setMapLayerOpacity,
		writeBaseMapPreference,
		type Annotation,
		type AnnotationCollection,
		type AnnotationLayer,
		type Layer,
		type MapLayer,
		type OpeningViewFit,
		type OpeningViewOutcome,
		type ProjectFile,
		type PublishedRepository,
		type PublishedSite,
		type TileSourceFailure
	} from '@ballastella/core';
	import { type DrawnLayer, type DrawnOutcome } from '@ballastella/core/render';
	import {
		ANNOTATION_INSPECTOR_ID,
		AnnotationDescription,
		AnnotationInspector,
		AnnotationList,
		BaseMapSwitcher,
		LayerList,
		LeaderLine,
		MapCommentary,
		MapNotice,
		ProjectCardList,
		pageChrome,
		type Box
	} from '@ballastella/ui';
	import Scan from '@lucide/svelte/icons/scan';
	import { onMount, tick, untrack } from 'svelte';

	import { online } from '$lib/online.svelte';
	import { readLayerDocuments, toContentLayers, type ReadDocuments } from '$lib/project-documents';
	import ReaderMapPane from '$lib/ReaderMapPane.svelte';
	import { returnLink } from '$lib/return-link.svelte.js';
	import { readSiteFile, siteStore, sitePrefix } from '$lib/site-files';
	import { startTheme } from '$lib/theme.svelte';
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
	 * about the file. So the prerendered HTML is the Front Page's own skeleton and nothing more.
	 */
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
		// ADR-0016: the theme ships with the viewer, and one signal drives the interface and the Base Map
		// flavor. Here rather than at module scope, because a module body runs during prerendering too.
		startTheme();
		// Only ever used to *withhold* a claim — see `online.svelte.ts` and {@link archiveUnavailable}.
		return online.start();
	});

	/**
	 * The Project asked for, or `null` for the Front Page.
	 *
	 * Gated on `hydrated` because **`page.url.searchParams` throws during prerendering**: SvelteKit
	 * refuses it outright, since a prerendered page is one file serving every query string and a build
	 * that read one would bake a single Project's answer into it. That refusal is the mechanism
	 * ADR-0008 is relying on when it says `?p=` needs no per-Project artefact — the selection is
	 * client-side by construction. So this is `null` while the static file is being written, and the
	 * prerendered HTML is the Front Page's own skeleton.
	 */
	const openDirectory = $derived(hydrated ? page.url.searchParams.get('p') : null);

	/** Which Map Image is being read as a document, or `null` for the map (SPEC story 85). */
	const unwarpedLayerId = $derived(hydrated ? page.url.searchParams.get('unwarped') : null);

	let site = $state<PublishedSite | null>(null);
	/** Why the site record could not be read. A site with no record is not a site at all. */
	let siteError = $state('');

	/**
	 * The repository this site was published to, for the return links below — or `null`.
	 *
	 * A static host cannot be asked what repository serves it, so this has to be *in* the site. A
	 * publish records it on `ballastella-site.json`; a site published before that field existed
	 * carries it in `remote.json` inside the published tree instead (ADR-0032), which is why the
	 * fallback is a second request rather than an absence.
	 *
	 * Never a failure. A site published into a folder rather than to a Remote has neither, and a
	 * Front Page with one fewer link is the whole of what that costs a Reader.
	 */
	let remote = $state<PublishedRepository | null>(null);

	let openProject = $state<{ directory: string; file: ProjectFile } | null>(null);
	let projectError = $state('');

	$effect(() => {
		// Only in the browser: prerendering has no site to read, and the record is written by
		// publishing rather than by the build.
		if (!hydrated) return;
		void (async () => {
			try {
				const record = parsePublishedSite(await readSiteFile(PUBLISHED_SITE_RECORD_NAME));
				site = record;
				siteError = '';
				// Asked for only when there is an instance to link back to, so a site that records no
				// editor — every site published before ticket 09 — costs its Readers no request at all;
				// and only when the record itself does not say, so a current site costs none either.
				remote =
					record.editorUrl === ''
						? null
						: (record.repository ?? (await readRemoteBinding(siteStore())));
			} catch (cause) {
				siteError = describeSiteRecordFailure(cause);
			}
		})();
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE WAY BACK TO THE EDITOR (SPEC stories 49–51)
	//
	// The only **absolute** addresses this app renders. Everything else goes through `resolve` because
	// the site's own base path is unknown at build time (ADR-0006); these are different in kind — they
	// leave for another origin entirely, which is the ordinary topology under ADR-0032 — and they are
	// still built from two files read *relative* to this document.
	//
	// Plain links, and deliberately nothing more: no `postMessage`, no iframe, no attempt to hand
	// state across. The editor is offered a repository name and asks the Reader before it acts on it.
	//
	// Both are `null` unless the site records an instance **and** a repository, which is the
	// degradation the record's reader is written for: no link rather than a broken one, and never a
	// guess at a canonical deployment.

	const cloneLink = $derived(
		site === null || remote === null
			? null
			: returnLinkUrl(site.editorUrl, {
					kind: 'clone',
					owner: remote.owner,
					repository: remote.repository
				})
	);

	/**
	 * The link on a Project's own page, offering that Project alone.
	 *
	 * Gated on the Project having opened rather than on `?p=`: a screen already saying a Project
	 * cannot be shown should not also offer to review it somewhere else.
	 */
	const reviewLink = $derived(
		site === null || remote === null || openProject === null
			? null
			: returnLinkUrl(site.editorUrl, {
					kind: 'review',
					owner: remote.owner,
					repository: remote.repository,
					project: openProject.directory
				})
	);

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHAT THE NAVIGATION BAR SAYS ABOUT THIS SCREEN (SPEC stories 3, 5 and 9)
	//
	// The bar is mounted in the layout, above this page and outside it, so what it says arrives
	// through two slots rather than through props: the shared page-chrome slot for where you are and
	// the way off it, and this app's own return-link slot for the way back to Ballastella. Before
	// this, all three screens rendered their own heading, their own theme button and their own way
	// back, each in a different place — which is the whole of what a Reader could not rely on.

	/** Where the Reader is, in the bar's `<h1>`. Empty while a Project is still opening or refused. */
	const barHeading = $derived(
		openDirectory === null ? 'Front Page' : (openProject?.file.name ?? '')
	);

	/**
	 * The way off this screen, or `null` when the only way off it is the bar's own links.
	 *
	 * Only the unwarped view has one: it is the one screen inside a Project, and "back to the map" is
	 * a different destination from All Projects.
	 */
	const barBack = $derived(
		unwarpedLayerId !== null && openDirectory !== null && openProject !== null
			? {
					label: 'Back to this Project’s map',
					project: openDirectory,
					testid: 'back-to-project'
				}
			: null
	);

	$effect(() => {
		const said = barHeading;
		pageChrome.show(said, barBack);
		return () => pageChrome.clear(said);
	});

	$effect(() => {
		// The whole-Workspace invitation belongs to the Front Page and the Project's to a Project: a
		// Reader looking at one piece of work is offered that piece of work.
		if (openDirectory === null) {
			returnLink.current =
				cloneLink === null ? null : { href: cloneLink, label: 'Open in Ballastella' };
			return;
		}
		returnLink.current =
			reviewLink === null
				? null
				: { href: reviewLink, label: 'Review this Project in Ballastella' };
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

	/**
	 * Which Layer card is open, or `null` for none. At most one, which is what makes it one value.
	 *
	 * Held here rather than inside the card for the reason `LayerList` gives: the screen owns it, so
	 * nothing downstream can hold a second copy that disagrees.
	 */
	let openLayerId = $state<string | null>(null);

	/** Reset to the author's own stack whenever a different Project is opened. */
	$effect(() => {
		const file = openProject?.file ?? null;
		layers = file?.layers ?? [];
		// A card opened in the Project being left names a Layer the incoming one does not have.
		openLayerId = null;
	});

	/**
	 * What the last view change did, announced.
	 *
	 * Hiding a Layer changes the map and nothing near the control that changed it, so without this a
	 * screen-reader user toggles a Layer and is told only that a checkbox is unchecked — not that a
	 * Map Image has left the map (SPEC story 22).
	 *
	 * **On the page rather than inside the card**, which is the choice this ticket was given between:
	 * the card announces the one change it makes on its own — a reorder — and every other announcement
	 * belongs to whichever consumer performed the change. This page is what applies a Reader's
	 * visibility and opacity, so it is what can say what happened.
	 */
	let announced = $state('');

	/** How a Layer reads in the announcement, matching the accessible names on its own controls. */
	const layerName = (id: string): string =>
		layers.find((layer) => layer.id === id)?.name || 'Untitled Layer';

	function showLayer(id: string, visible: boolean): void {
		announced = `${layerName(id)} ${visible ? 'shown' : 'hidden'}`;
		layers = setLayerVisible(layers, id, visible);
	}

	function dragLayerOpacity(id: string, opacity: number): void {
		announced = `${layerName(id)} at ${Math.round(opacity * 100)}%`;
		layers = setMapLayerOpacity(layers, id, opacity);
	}

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
		// Back at the Front Page. Cleared rather than left standing, so that opening the same Project
		// again is a fresh open and frames again — which is what a Reader who has navigated away and
		// back means.
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
	 * The most recent refusal of a Map Image's tiles, or `null` while they are arriving.
	 *
	 * ⚠ **Not a one-way flag**, and that shape is the failure this ticket was told to avoid: the
	 * previous epic left an alert sitting over a working map because nothing ever took it down.
	 *
	 * **When it goes back to `null` is not this component's decision.** `createStoreImageFetch` reports
	 * an arrival only when the last URL that was *refused* has come back — never on the strength of
	 * some other URL succeeding — so a partial outage keeps its notice however many cells are arriving
	 * beside the missing ones. Its header sets that rule out at length, and ADR-0028 records why it
	 * replaced one that counted concurrent requests. Here it is one assignment, which is the point of
	 * having put it there.
	 *
	 * ⚠ **The consequence a reader of this component should know:** what recovers unattended and what
	 * does not is *not uniform*, and it is measured rather than reasoned. A refused `info.json` heals
	 * with no gesture at all; a refused tile cell is never re-asked for, not even after a zoom. That is
	 * why the sentence names hiding and showing the Layer — and why this notice can legitimately stay
	 * up over a map whose server is answering again.
	 *
	 * Which half of that is true is not the map's to discover unprompted: while this is set, the pane
	 * is asked to paint on `keepAskingForMissingTiles`' schedule, because the renderer re-asks for a
	 * refused record only on a painted frame and a settled map paints none. It is handed **whether**
	 * this is `null`, never each refusal — see `ReaderMapPane`'s `tilesMissing`.
	 */
	let tileFailure = $state.raw<{
		failure: TileSourceFailure;
		imageId: string | null;
	} | null>(null);

	/**
	 * Where an aligned Map Image's tiles are read from (ADR-0011).
	 *
	 * The same shim the editor gives MapLibre, over the HTTP store rather than over OPFS — which is
	 * ADR-0001's abstraction paying out and the reason there is no second tile path here. A local copy's
	 * `info.json` carries the `unset.invalid` placeholder, this resolves it against `images/<image-id>/`
	 * at the **site root** (ADR-0023), and a referenced image's real address passes straight through to
	 * the library that holds it.
	 *
	 * No longer per-Project, because the pyramids are not: one shim serves every Project of the site, and
	 * two Projects drawing the same Map Image draw the same bytes.
	 */
	const fetchTile = $derived(
		createStoreImageFetch({
			store: siteStore(),
			// Ticket 04: a refusal is caught at this boundary and becomes something a Reader reads,
			// rather than escaping into `@allmaps/render` as an uncaught page error nobody sees.
			onOutcome: (outcome) => {
				tileFailure = outcome.ok ? null : { failure: outcome.failure, imageId: outcome.imageId };
			}
		})
	);

	/**
	 * What to say when a Map Image's tiles stopped arriving, or `null`.
	 *
	 * ⚠ **The sentence is `mapImageTilesUnavailableNotice`'s, not this template's**, and that is
	 * the contract rather than a convenience: the editor renders the same function's output for the
	 * same failure (ticket 05), so the two deployments cannot drift into describing one outage two
	 * ways at the same person. The same arrangement as {@link archiveUnavailable} above, for the same
	 * reason.
	 *
	 * The Layer's name is resolved here rather than in core, because which Layer an `imageId` belongs
	 * to is a fact about *this* Project and core has no Project in hand. `null` when the failure named
	 * no image, or named one no visible Layer draws — a sentence naming the wrong map would send a
	 * Reader looking at an Alignment that is fine.
	 *
	 * ⚠ **Deliberately not gated on `online.current`**, unlike the Base Map's notice, and the
	 * difference is the sentence rather than an oversight: `baseMapUnavailableNotice` claims the
	 * failing server is at fault, which is a falsehood to hand somebody whose wifi is off, while the
	 * `no-answer` row here says explicitly that it cannot tell the two apart. There is nothing to
	 * withhold.
	 */
	const tilesUnavailable = $derived.by((): string | null => {
		if (!tileFailure) return null;
		const named = layers.find(
			(layer): layer is MapLayer => layer.kind === 'map' && layer.imageId === tileFailure?.imageId
		);
		return mapImageTilesUnavailableNotice(tileFailure.failure, named?.name ?? null);
	});

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
							reason: 'This Map Image has not been aligned, so it is not drawn.'
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
	 * Which Layers still fetch their Map Image from the library that holds it (SPEC story 29).
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
	 * The Map Images this site does not hold its own tiles for, by image id.
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
	 * Read out of the site record so legacy sites published without them still degrade honestly. New
	 * publishes always carry the assets, despite their roughly 4.9 MB cost against the same hosting
	 * budget as the scholar's Map Images.
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
	 * **Matched to the entry the Reader is looking at** (ticket 12). The cache directory is keyed by
	 * archive, and ADR-0020 lets a Reader switch entries — so a site carrying tiles for one archive must
	 * draw the *other* entry from the network rather than from a pile of tiles that are not its. The
	 * match is on the entry's own `archive` string, which is what the key is derived from.
	 *
	 * `baseMapCaches` comes off the site record because a static host cannot list a directory, so the
	 * viewer has no way to read either which archives are here or how deep each goes the way the editor
	 * does. Reading a tile goes through the same read-only HTTP store every other byte of this site
	 * does: `null` for a 404, which the protocol handler answers with an empty tile rather than a
	 * console full of errors.
	 */
	const cachedBaseMap = $derived.by(() => {
		const archive = baseMap.entry.archive;
		// An exact match first, so a site carrying tiles for two archives serves the right one. A
		// `null` archive is the pre-ticket-12 layout — one unkeyed directory that belonged to no
		// entry in particular — and it answers for any entry, which is what it did when it was written.
		const held =
			site?.baseMapCaches.find((cache) => cache.archive === archive) ??
			site?.baseMapCaches.find((cache) => cache.archive === null);
		if (!held) return null;
		const pathOf = (tile: { z: number; x: number; y: number }) =>
			held.archive === null ? legacyCachedTilePath(tile) : cachedTilePath(archive, tile);
		return {
			maxZoom: held.maxZoom,
			readTile: async (tile: { z: number; x: number; y: number }) => {
				try {
					return await siteStore().read(pathOf(tile));
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
	 * Whether the Base Map's own source failed, as `ReaderMapPane` reports it (ticket 22).
	 *
	 * `false` until the pane has said otherwise, so the notice below appears when the archive has
	 * actually failed and not in the moment before it has been asked for. The pane sends `'drawing'`
	 * as well, so a Base Map that comes back — a bucket whose rate limit lifts, since tile ranges are
	 * not cached the way the header is — takes its own accusation down.
	 *
	 * **Also cleared when the shown Base Map changes**, which is a different question rather than an
	 * answer to the same one: a stale "could not be loaded" carrying the label of an entry the Reader
	 * has just switched *to* accuses a Base Map that has not failed. That case is exactly where the
	 * pane cannot help, because a refusing archive header is cached page-wide by `pmtiles` and every
	 * entry in this catalog shares one archive.
	 *
	 * The dependency is `baseMap`, not only its entry's id: reading `entry.id` subscribes to the whole
	 * derived, so this also runs when `resolveBaseMap` recomputes to an equal entry. Clearing a flag
	 * that the pane restates within the same load is harmless, and pretending otherwise in a comment
	 * would be the more expensive kind of wrong.
	 */
	let baseMapUnavailable = $state(false);
	$effect(() => {
		void baseMap.entry.id;
		baseMapUnavailable = false;
	});

	/**
	 * What to say when the Base Map's archive answered nothing and the connection is fine — the failure
	 * that is, right now, the behaviour of every published site (ADR-0025, open lead 3).
	 *
	 * ⚠ **The sentence is `baseMapUnavailableNotice`'s, not this template's**, and that is the contract
	 * rather than a convenience: the editor renders the same function's output for the same failure, so
	 * the two deployments cannot drift into describing one outage two ways at the same scholar. If a
	 * second sentence is ever wanted here, it belongs in core.
	 *
	 * ⚠ **Only while online.** With no connection the archive also fails, and `needsNetwork`'s remedy
	 * reads "this is usually that server rather than your connection" — a plain falsehood to hand
	 * somebody whose wifi is off. Saying nothing is the better of the two answers available, and it is
	 * the same gate the editor's `unavailableNotice` carries.
	 *
	 * Distinct from {@link baseMapNotPublished}, which is about files this **site** does not carry: that
	 * is a publishing choice, with a different remedy, knowable without waiting for a request. It is
	 * **not** mutually exclusive with this one, and the code used to claim it was: only the bare
	 * background style declares no source, and it is built solely for a site-relative archive. Every
	 * entry in this deployment's catalog is absolute, so a site published without those files draws the
	 * remote style — which declares the source, and fails with it. Both notices are up in that state
	 * today, and neither now says anything the other denies.
	 */
	const archiveUnavailable = $derived(
		baseMapUnavailable && online.current
			? baseMapUnavailableNotice(baseMap.entry, baseMapArchiveHost(baseMap.entry))
			: null
	);

	/**
	 * What the Reader is missing from the modern reference map, or `''`.
	 *
	 * ⚠ **The sentence is core's, and the branch is core's**, for the reason the function's own header
	 * gives at length: two of its four rows cannot be reached from a published site in this deployment,
	 * and the shipped ternary was false in both of them. Choosing between two sentences using two
	 * booleans is exactly the work that belongs one seam down, where `resolve.test.ts` drives every row
	 * in milliseconds instead of in a browser that cannot produce two of them at all.
	 *
	 * `cachedBaseMap !== null` rather than any flag on the site record: it is the same value the pane
	 * is handed, so the notice and the style cannot disagree about whether this site has tiles.
	 *
	 * ⚠ **This argument is unobservable in this deployment, and no test can close it.** The two
	 * sentences differ only when the entry's archive is site-relative, and every entry in this
	 * catalog is absolute — so passing a constant `true` or `false` here produces identical text in
	 * every row a Published Site can reach, and a browser test asserting on rendered text cannot tell
	 * the difference by construction. It is not that the wiring is untested for want of effort: there
	 * is nothing here to observe until a fork repoints the catalog at its own tiles, which is the case
	 * the function's own tests cover. Said rather than left as a gap someone else has to rediscover.
	 */
	const baseMapNotPublished = $derived(
		baseMapNotPublishedNotice(baseMap.entry, {
			bundledAssets: bundledBaseMapAvailable,
			cachedTiles: cachedBaseMap !== null
		})
	);

	/**
	 * Whether a Project's map is what is on screen — the only state the two Base Map notices speak in.
	 *
	 * ⚠ **The notices are rendered outside every branch and this is what keeps them silent.** They sit
	 * at the top of `<main>`, above the Front-Page/Project split, because a live region has to be on
	 * the page *before* its sentence arrives for the arrival to be a change a screen reader announces
	 * — and everything below that split is built client-side once the Project file resolves, so a
	 * region rendered inside it is inserted with its text already in it and announced to nobody. This
	 * moves the element and not the moment: they say something on a Project's map, and nothing on the
	 * Front Page, on a Project that would not open, or on a sheet being read as a document.
	 *
	 * `baseMapNotPublished` in particular is true from the first frame — `bundledBaseMapAvailable` is
	 * `false` until the site record is read — so without this gate the sentence would be in the
	 * prerendered HTML, which is the same defect one step earlier.
	 */
	const showingTheMap = $derived(openProject !== null && unwarpedLayerId === null);

	/** Remember the Reader's choice for this site, and for no other (ADR-0020). Never Project data. */
	function chooseBaseMap(id: string): void {
		chosen = id;
		writeBaseMapPreference(readerStorage(), sitePrefix(), id);
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// The selected Annotation (one-shell-two-apps stories 32–34) — the highest-stakes surface in
	// the epic
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The Annotation a Reader is looking at, or `null`.
	 *
	 * **One value, because "which Annotation is active" has one answer.** It is the selected row in the
	 * Layer card, it is what the Annotation Inspector over the map describes, and it is what a pin on
	 * the map chooses: clicking a pin names the Annotation to read and its Layer's card opens with it,
	 * so the answer to "what is this pin?" is one panel rather than a bubble over the pin (ticket 07,
	 * ADR-0035).
	 *
	 * Its `title` and `description` are **untrusted text**: a Published Site runs on the author's own
	 * domain, and the Project may have arrived from a stranger by zip import (ticket 13) or from a
	 * remote library (ticket 14). Neither is turned into HTML here, and neither may be. The title is a
	 * Svelte interpolation in `AnnotationRow` and in `AnnotationInspector`'s identity header, and the
	 * description is `AnnotationDescription`'s — `@ballastella/ui`'s one `{@html}`, fed nothing but
	 * `renderDescription`'s output, which is core's `marked`-then-DOMPurify pipeline. This app composes
	 * no markup of its own: there is no `{@html}` in its source at all.
	 */
	let selected = $state.raw<{ layerId: string; annotationId: string } | null>(null);

	/**
	 * The Annotations inside the open Layer's card, or `null` where its collection has not been read.
	 *
	 * **No fetch of its own**: `documents` already holds every visible Layer's parsed collection,
	 * because the map is drawing from it.
	 *
	 * ⚠ **`null` rather than an empty array for the three states that are not `ready`.** They are not
	 * the same fact: an empty array is a collection somebody read and found nothing in, and the list
	 * says so in as many words. Collapsing `loading` and `unreadable` into it told a Reader "This Layer
	 * has no Annotations in it" about a Layer whose GeoJSON had not arrived or would not parse — beside
	 * a problem band saying the file could not be read, and with nothing at all beside it when the
	 * Reader had hidden the Layer, since `outcomes` is built from the Layers that are shown.
	 */
	const openAnnotations = $derived.by((): readonly Annotation[] | null => {
		if (openLayerId === null) return null;
		const read = documents[openLayerId];
		if (read?.status !== 'ready') return null;
		const collection = read.annotations as AnnotationCollection | null | undefined;
		return collection?.annotations ?? [];
	});

	/**
	 * Which row in the open card is selected.
	 *
	 * Derived rather than held, so that opening a *different* Annotation Layer cannot leave a row
	 * marked selected in a card that does not contain it. The selection itself survives the card being
	 * closed, which is what lets a pin clicked on the map still be the selected row when its Layer is
	 * opened again.
	 */
	const openAnnotationId = $derived(
		selected !== null && selected.layerId === openLayerId ? selected.annotationId : null
	);

	/**
	 * Where the selected Annotation sits in its Layer's collection, for the Inspector's ordinal and the
	 * untitled fallback's number.
	 *
	 * The collection's position rather than the row's place among the rows on screen, which is what
	 * makes the panel's "Untitled shape 3" and the row's the same words (ADR-0035).
	 */
	const openAnnotationIndex = $derived(
		openAnnotations?.findIndex((candidate) => candidate.id === openAnnotationId) ?? -1
	);

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// The leader (ticket 12, SPEC stories 39–42, 46)
	//
	// The same line the editor draws, from the same component, between the same two ends: the
	// Annotation's own drawing on the map, and its row. A Reader gets it because it is the answer to
	// "which pin is this row about" — the question the retired map popup used to answer — and gets it
	// drawn from the same code, so the two apps cannot disagree about where it goes.
	//
	// Below `lg` the stack sits below the map: `LeaderLine` measures that and draws nothing, which is
	// story 46 without a breakpoint being written down twice.
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/** The map pane, for the one thing this page asks of its camera. */
	let readerMapPane = $state<ReaderMapPane | undefined>();
	/** The two columns the leader is drawn between. `$state` for the reason `ProjectScreen` records. */
	let layerColumn = $state<HTMLElement | undefined>();
	let mapColumn = $state<HTMLElement | undefined>();

	/** The open Annotation itself, which is the thing the leader points at. */
	const openAnnotation = $derived(
		openAnnotations?.find((annotation) => annotation.id === openAnnotationId) ?? null
	);

	/**
	 * Where that Annotation is on the map, or `null` when there is nothing to point at.
	 *
	 * Projected at draw time, for the reason `ProjectScreen`'s twin records: an Annotation is painted
	 * into the map's canvas and has no element to measure.
	 */
	const selectedMark = (): Box | null =>
		openAnnotation ? (readerMapPane?.annotationBox(openAnnotation) ?? null) : null;

	/** That Annotation's row, which is on screen only while its Layer's card is open. */
	const selectedRow = (): Element | null => {
		const id = openAnnotationId;
		if (id === null || !layerColumn) return null;
		return layerColumn.querySelector(
			`[data-testid="annotation-row"][data-annotation-id="${CSS.escape(id)}"]`
		);
	};

	/**
	 * Dismiss the Inspector, leaving the keyboard on the row the Reader chose it from.
	 *
	 * **Dismissing is deselecting**, because the selected row *is* the Annotation the Inspector
	 * describes: one fact, one value. What it does not touch is the list — the Layer's card stays open
	 * and the row stays where it was, so a Reader's place in it survives the panel going.
	 *
	 * ⚠ **"Focus is on `document.body`" is not the test here.** The Inspector leaves over 220 ms, so one
	 * microtask after the selection is cleared the pressed button is still in the document and still
	 * `document.activeElement`; a guard reading `body` alone would do nothing at all and leave the
	 * keyboard on a control that vanishes a fifth of a second later. The editor's `ProjectScreen`
	 * carries the same guard against the same panel, and its note records the measurement.
	 */
	async function dismissInspector(): Promise<void> {
		const row = selectedRow();
		selected = null;
		await tick();
		const active = document.activeElement;
		const leaving = document.getElementById(ANNOTATION_INSPECTOR_ID);
		const stranded = active === document.body || (active !== null && leaving?.contains(active));
		if (!stranded) return;
		if (row instanceof HTMLElement) row.focus();
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Reading a Map Image as a document (SPEC story 85)
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
				unwarpedError = 'This site does not record where this Map Image’s image is.';
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
						'This Map Image cannot be opened on its own from this site yet. Its image was ' +
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
						? 'The image behind this Map Image is not on this site, so it cannot be read as a document.'
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
	 * Open a Map Image as a document, and come back (SPEC story 85).
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

	/**
	 * The Projects the Front Page offers a Reader (ADR-0032).
	 *
	 * The record names every Project the site carries, listed or not, so the filter is here rather than
	 * at publish time — and it is the *only* thing the choice does. `?p=<directory>` reads a Project's
	 * files straight off the host without consulting this list, so one left out still opens and still
	 * renders, which is what stops "not on the Front Page" from being mistaken for a privacy setting.
	 */
	const frontPage = $derived(site?.projects.filter((project) => project.onFrontPage) ?? []);

	/**
	 * The Front Page's Projects as the shared card list takes them: the name, the folder, and the link.
	 *
	 * `resolve` stays in the app — the site's own base path is unknown at build time (ADR-0006) and
	 * `packages/ui` has no SvelteKit to resolve against — and the query parameter is built from the
	 * **folder**, encoded, never from the display name.
	 */
	const frontPageCards = $derived(
		frontPage.map((project) => ({
			name: project.name,
			directory: project.directory,
			href: resolve(`/?p=${encodeURIComponent(project.directory)}`)
		}))
	);

	/** What this site calls itself in the tab. The Front Page has no name of its own beyond the tool's. */
	const title = $derived(
		openProject ? `${openProject.file.name} — Ballastella` : 'Ballastella — published Projects'
	);
</script>

<svelte:head><title>{title}</title></svelte:head>

<!--
	Escape deselects the Annotation, and so dismisses the Inspector, from anywhere on the page rather
	than only over the map: a Reader who chose an Annotation from a pin has their pointer on the
	canvas, and a Reader who chose one from the sidebar has the keyboard on its row.
-->
<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && selected !== null) selected = null;
	}}
/>

<main class="flex min-h-0 flex-col lg:h-full">
	<!--
		Why the Base Map on screen is not the one the Project asked for (ADR-0020), and what this site
		was published without.

		⚠ **Above the Front-Page/Project split rather than beside the switcher, and that placement is
		the mechanism.** Both are `aria-live` regions, which are announced when their text *changes*
		and not when the element carrying them is inserted — so each has to be on the page before its
		sentence exists. Everything below this point is built client-side once the site record and the
		Project file have been read, and both sentences are settled before that happens: `baseMapNotice`
		falls out of `resolveBaseMap` with the Project file, and `baseMapNotPublished` is true from the
		first frame. A region rendered down there arrives *with* its text however few `{#if}` blocks
		are left around it, which is what made these two inaudible when they sat in the controls column.
		Here they are in the prerendered HTML, empty, and the sentence arriving is a change.

		{@link showingTheMap} keeps *when* they speak unchanged: a Project's map, and nowhere else.
		`max-w-prose` keeps the sentence readable without constraining the map workspace below.
	-->
	<MapNotice
		shape="always-present"
		variant="plain"
		class="max-w-prose text-sm text-warning"
		testid="base-map-notice"
		text={showingTheMap ? baseMapNotice : ''}
	/>

	<MapNotice
		shape="always-present"
		variant="plain"
		class="max-w-prose text-sm text-warning"
		testid="base-map-not-published"
		text={showingTheMap ? baseMapNotPublished : ''}
	/>

	{#if openDirectory === null}
		<div class="mx-auto w-full max-w-6xl p-4 sm:p-8">
			<!--
			The site's own sentence about itself, as ordinary markup.

			It was Markdown put through `renderAnnotationPopup` and `{@html}`-ed, which made this page's
			marketing copy into a pseudo-Annotation: an Annotation is a scholar's content (CONTEXT.md), and
			the shared renderer's job is a stranger's untrusted text rather than a string in this file. The
			shared path is live in this bundle where it belongs — an Annotation's row renders its
			description through `AnnotationDescription`, which is `renderDescription` and the package's one
			`{@html}` — and `e2e/viewer-reader.e2e.ts` asserts a payload is inert there, on the surface a
			stranger's Project actually writes. There is now no `{@html}` anywhere in this app.
		-->
			<p class="max-w-prose">
				These are the Projects published from one Ballastella Workspace. A Reader can look at the
				work — the aligned Map Images and the Annotations written over them — and cannot change it.
				Published with
				<a class="link" href="https://github.com/artshumrc/ballastella#readme">Ballastella</a>.
			</p>

			<!--
			⚠ **The reassurance, and it is load-bearing.** It belonged to the paragraph that carried the
			way back to the editor, and it survived that paragraph's move into the navigation bar: a
			student with no GitHub account is exactly the Reader who will not follow a link that looks
			like it wants one, and the copy a Clone takes changes nothing on this site.

			**Gated on `cloneLink`, which is the bar's own condition** — `returnLink.current` above is
			this expression and nothing else — because the sentence is *about* the invitation. A site
			published into a folder, and every site published before this epic, records no instance or
			no repository, so the bar carries no "Open in Ballastella" and this would be telling a
			Reader how a control behaves that is nowhere on the screen. One test, so the two cannot
			drift into a page that offers the link without the sentence or the sentence without the link.
		-->
			{#if cloneLink !== null}
				<p class="mt-4 max-w-prose" data-testid="no-account-needed">
					Opening this Workspace in Ballastella takes a copy of all of it onto your own computer.
					You do not need an account, and nothing published here is changed.
				</p>
			{/if}

			{#if siteError}
				<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
					<h2 class="font-semibold">This site has no list of Projects</h2>
					<p data-testid="site-problem">{siteError}</p>
				</div>
			{:else if site === null}
				<p class="mt-8">Looking for the Projects on this site…</p>
			{:else if frontPage.length === 0}
				<!--
				Two different facts, and they must not share a sentence (ADR-0032). "No Projects on it yet"
				is true of a site nothing has been published to, and reads as *the files are missing* — which
				would send the author of a site whose Projects are all off the Front Page looking for work
				that is exactly where they left it. The second sentence says what that author did, and
				repeats the one thing the editor's control promised them: the Projects are still here, and a
				link still opens one.
			-->
				{#if site.projects.length === 0}
					<p class="mt-8" data-testid="no-projects-yet">This site has no Projects on it yet.</p>
				{:else}
					<p class="mt-8 max-w-prose" data-testid="none-on-front-page">
						None of this site’s Projects are on the front page. They are still published — anyone
						with a link to one can open it.
					</p>
				{/if}
			{:else}
				<!--
				The same list of cards the editor's Hub renders, from the one component (SPEC stories 8 and
				53) — so publishing does not reformat a scholar's Projects into something else.

				**A Reader gets it with nothing else passed to it**, and that is the whole of how the
				authoring controls are absent: no New Project, no per-Project actions, no Front Page
				choice, because none of them is a snippet this call hands over (SPEC story 54). The name is
				interpolated as text by the card itself and never as markup, which
				`packages/ui/src/project-card-list.dom.test.ts` asserts against the component
				and `e2e/viewer-reader.e2e.ts` and `e2e/editor-publish.e2e.ts` assert against a real
				published site (ADR-0009).
			-->
				<!--
				`workspace-home-column` is the measure, and it is the editor's too: it is declared once in
				`packages/ui/src/layout.css`, so a Project's row is the same width here as in the editor
				rather than the two apps each stating a `max-w-*` of their own (SPEC story 35).
			-->
				<ProjectCardList
					class="mt-8 workspace-home-column"
					testid="published-projects"
					projects={frontPageCards}
				/>
			{/if}
		</div>
	{:else}
		{#if projectError}
			<div role="alert" class="alert flex-col items-start alert-warning">
				<!-- `<h2>`: the bar carries the page's one `<h1>`, and this alert is a section of the page
				     rather than the page's own name. -->
				<h2 class="text-xl font-semibold">This Project cannot be shown</h2>
				<p data-testid="project-problem">{projectError}</p>
			</div>
		{:else if openProject === null}
			<p>Opening…</p>
		{:else}
			{#if unwarpedLayerId !== null}
				<!--
					Reading one Map Image on its own. A separate branch rather than a panel beside the
					map, deliberately: two tile viewers over one WebGL-bearing page is a phone running out of
					memory, and a Reader who asked to read the sheet is not looking at the geography.

					**This is a navigation between two map-bearing panes**, which is the shape that once made a
					destination page render nothing at all — an exception in the outgoing pane's teardown
					abandons the rest of Svelte's destroy flush *and* the incoming mount. `e2e/viewer.e2e.ts`
					puts a `pageerror` assertion on it in both directions and on both ways in (by link, and by
					loading the URL directly).
				-->
				{#if unwarpedError}
					<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
						<p data-testid="unwarped-problem">{unwarpedError}</p>
					</div>
				{:else if unwarpedLayer === null}
					<p class="mt-4" data-testid="unwarped-problem">
						This Project has no Map Image with that name.
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
				<div class="flex min-h-0 grow flex-col" data-testid="project-screen">
					<div class="relative flex min-h-0 grow flex-col lg:flex-row">
						<div class="flex min-h-0 grow flex-col">
							<MapNotice
								shape="comes-and-goes"
								heading="The Base Map did not load"
								testid="base-map-unavailable"
								text={archiveUnavailable}
							/>

							<MapNotice
								shape="comes-and-goes"
								heading="A Map Image stopped drawing"
								testid="map-image-tiles-unavailable"
								text={tilesUnavailable}
							/>

							<div
								bind:this={mapColumn}
								class="h-[26rem] shrink-0 overflow-hidden lg:h-auto lg:min-h-0 lg:grow"
							>
								{#if siteRecordKnown}
									<ReaderMapPane
										bind:this={readerMapPane}
										selectedAnnotationId={openAnnotationId}
										entryId={baseMap.entry.id}
										{catalog}
										{bundledBaseMapAvailable}
										{cachedBaseMap}
										layers={drawn}
										{openingFit}
										{fetchTile}
										tilesMissing={tileFailure !== null}
										onclickannotation={(hit) => {
											openLayerId = hit.layerId;
											selected = hit;
										}}
										onstack={(reported) => (rendered = reported)}
										onbasemapstatus={(status) => {
											baseMapUnavailable = status === 'unavailable';
										}}
										controls={mapControls}
										overlay={mapOverlay}
									/>
								{/if}
							</div>

							<MapCommentary
								layerCount={layers.length}
								{drawnCount}
								{openingOutcome}
								{refitted}
								{emptyStackNote}
							/>
						</div>

						<div
							bind:this={layerColumn}
							class="shrink-0 border-t border-base-content/10 bg-base-300 p-4 lg:order-first lg:w-96 lg:overflow-y-auto lg:border-t-0 lg:border-r"
							data-testid="layer-sidebar"
						>
							<!--
								What the Reader's last change did, in words. Above the stack rather than under it,
								because a live region a Reader may have to scroll to find is one they will not read
								— and this is the only feedback that the map has changed at all.
							-->
							<div
								aria-live="polite"
								aria-atomic="true"
								class="min-h-6 text-sm"
								data-testid="layer-view-status"
							>
								{announced}
							</div>

							<!--
								**The props not passed are the point**; see the note at the head of this file. The
								two snippets offered are `mapContents` and `annotationContents`, and what goes in
								each is a Reader's own reading of the work rather than anything that changes it.
							-->
							<LayerList
								{layers}
								{outcomes}
								{openLayerId}
								onopen={(id) => (openLayerId = id)}
								onshow={showLayer}
								ondragopacity={dragLayerOpacity}
								{mapContents}
								{annotationContents}
							/>
							{#if needsNetwork.length > 0}
								<MapNotice
									shape="comes-and-goes"
									variant="plain"
									class="mt-4 text-sm text-warning"
									testid="project-needs-network"
								>
									{needsNetwork.length === 1
										? 'One Map Image'
										: `${needsNetwork.length} Map Images`}
									here {needsNetwork.length === 1 ? 'is' : 'are'} held on the library's own server rather
									than in this site: {needsNetwork.map((layer) => layer.name).join(', ')}. Without a
									network connection {needsNetwork.length === 1 ? 'it' : 'they'} cannot be shown.
								</MapNotice>
							{/if}

							{#if unreachable.length > 0}
								<MapNotice
									shape="comes-and-goes"
									heading="Some of this Project could not be reached"
									class="mt-4"
								>
									{#each unreachable as failure (failure.name)}
										<p data-testid="layer-unreachable">{failure.reason}</p>
									{/each}
								</MapNotice>
							{/if}
						</div>

						<LeaderLine
							mark={selectedMark}
							row={selectedRow}
							canvas={() => mapColumn}
							sidebar={() => layerColumn}
							watch={(redraw) => readerMapPane?.onCameraMove(redraw) ?? (() => {})}
						/>
					</div>
				</div>
			{/if}
		{/if}
	{/if}
</main>

{#snippet emptyStackNote()}
	<!--
		What the commentary says when the Project has no Layers at all, **in this app**. It is a
		statement about the Project rather than an invitation: the editor's sentence ends in "yet",
		because an author can add something and a Reader cannot.
	-->
	This Project has nothing on the map.
{/snippet}

{#snippet mapControls()}
	<BaseMapSwitcher
		entryId={baseMap.entry.id}
		{catalog}
		labelSrOnly={true}
		fullWidth={false}
		class="select-sm"
		onSelect={(id) => chooseBaseMap(id)}
	/>
	<button
		type="button"
		class="btn btn-sm"
		data-testid="fit-to-project"
		onclick={() => fitToProject()}
	>
		<Scan size={16} aria-hidden="true" />
		Fit project
	</button>
{/snippet}

<!--
	The Annotation Inspector's one face, and the dock it sits in (ADR-0035).

	⚠ **`AnnotationDescription` alone, and no title.** The Inspector's identity header directly above
	this already names the Annotation from the rule its row draws from, so a face that titled it too
	would put one title twice a few pixels apart in the same weight — the epic's central fault
	(the-annotation-inspector story 4). The editor's Text face is the same component plus the controls
	that change the words.

	⚠ **It is `@ballastella/ui`'s rather than markup composed here**, and that is the security boundary
	rather than tidiness. A `description` is a stranger's Markdown, and the only thing that may render
	it is core's `renderDescription` — `marked` then DOMPurify, in that order and not separately
	reachable (ADR-0009) — which is this component's, the one `{@html}` in that package. Keeping it in
	shared code is what keeps this app's own source free of one, so there is no expression here for a
	later edit to feed something unsanitised into, and it is what makes
	`e2e/viewer-reader.e2e.ts`'s inertness claim a claim about the thing that ships
	(the-annotation-inspector story 52).
-->
{#snippet inspectorText(annotation: Annotation)}
	<AnnotationDescription {annotation} />
{/snippet}

<!--
	⚠ **No `style` snippet, and that absence is the whole of why a Reader has no tab strip** — not a
	disabled Style tab and not a lone Text tab, because one face is not a choice
	(the-annotation-inspector stories 45, 46, 66). No `ontext`, no `oncommit` and no `ondelete` either,
	so there is no *Edit text* and no *Delete*: every difference from the author's panel is a prop this
	app does not pass rather than a flag it sets, which is the rule the whole shared package follows.

	**Docked inside the reader pane's own positioned container**, which is what the pane's `overlay`
	snippet is for: top-right inset, a comfortable measure wide with a `max-width` so it cannot exceed a
	narrow pane, and the map still visible below it and beside it. The same class list the editor's
	dock carries, including the `max-height` that keeps the Base Map's attribution clear and the `flex`
	that passes that cap on to the panel — `ProjectScreen`'s own note has the measurements behind both.

	⚠ **Below `lg` — the width at which this page's workspace stacks — it is a sheet
	across the bottom of the pane instead**, because a panel docked to a corner has no corner to dock to
	on a phone (the-annotation-inspector story 61). The same component with the same props: where it
	sits is this page's, which is why nothing about the sheet is a flag passed into it.

	⚠ **The bottom inset carries the zoom control as well as the attribution.** A sheet spanning the
	pane's width crosses the whole of its bottom edge, and `z-index: 7` puts the sheet over MapLibre's
	control corners — so on a phone the zoom control the dock decision moved to the bottom-left, so that
	it could never be under the Inspector, is under it after all unless this inset leaves it alone.
	Measured on a 375 px published site before the inset existed: the zoom-in button 100% covered, and
	`elementFromPoint` at its centre answering with a paragraph of the description. The same 6.25 rem
	inset and the same 60% cap as the editor's sheet, and `ProjectScreen`'s note has the arithmetic
	behind both numbers.

	⚠ **KNOWN LIMIT: this pane reserves nothing in the camera, so a mark under the sheet stays under it.**
	`keepAnnotationClear` is the editor's `BaseMapPane` — it has never existed here, on a desktop either —
	and a Reader's way out is the sheet's own dismiss control, which is the same way out a Reader has had
	since the panel docked. Giving the Reader the same reservation means one of two costs, neither of them
	this ticket's: duplicating the function in `ReaderMapPane`, which is a second place for the geometry to
	drift, or lifting it into `@ballastella/core/render` beside `annotationMarkBox`, which puts a camera
	move into a package that today only computes.

	⚠ **`z-index: 7` is load-bearing.** The leader is 5 and `layout.css` forces MapLibre's four control
	corners to 6 so the leader cannot be drawn across them; all three are compared in one stacking
	context, because `.maplibregl-map` opens none. 7 is one clear of the controls, which keeps the
	leader and the zoom control under this rather than through it.
-->
{#snippet mapOverlay()}
	{#if openAnnotation}
		<div
			class="absolute top-auto right-2 bottom-[6.25rem] left-2 z-[7] flex max-h-[60%] flex-col lg:top-2 lg:bottom-auto lg:left-auto lg:max-h-[calc(100%-3rem)] lg:w-80 lg:max-w-[calc(100%-1rem)]"
		>
			<AnnotationInspector
				annotation={openAnnotation}
				index={openAnnotationIndex}
				onclose={() => void dismissInspector()}
				text={inspectorText}
			/>
		</div>
	{/if}
{/snippet}

<!--
	What is inside an Annotation Layer for a Reader: its Annotations, each in a row that selects it
	(one-shell-two-apps stories 32–34).

	**The same list and the same row a scholar authors on**, and nothing opens inside either: an
	Annotation's content is read in the Annotation Inspector over the map, in both apps (ADR-0035). So
	a Reader can read an Annotation without first hunting for its pin, and the list stays the same
	length however much any one Annotation has to say.

	⚠ **No `tools` snippet, and that absence is the point.** The editor's holds the drawing surface and
	the place search, and a place search issues a lookup to a third-party service — a Published Site
	quietly doing that for a Reader who asked for nothing is what ADR-0029 is written against. It is
	not withheld by a flag: it is a prop this app does not pass, so neither component is reachable from
	this bundle at all.
-->
{#snippet annotationContents()}
	<AnnotationList
		annotations={openAnnotations}
		openId={openAnnotationId}
		onopen={(id) =>
			(selected =
				id === null || openLayerId === null ? null : { layerId: openLayerId, annotationId: id })}
	/>
{/snippet}

<!--
	What is inside a Map Image Layer for a Reader: the sheet on its own, unwarped (SPEC story 85).

	**A snippet rather than a callback prop on the card**, for the reason `ProjectScreen`'s own
	`mapContents` gives: what this button does is a navigation on this app's one route, and the shared
	card knows nothing about routes. It is also the whole of the difference between the two apps'
	Map Image cards — the editor's slot holds Align and the library the tiles came from, and this
	one holds the only thing a Reader can do to a sheet.

	The editor has no unwarped view; its own was removed in an earlier epic, and this is offered here
	because a Reader who wants to read the sheet as a document has nowhere else to go.
-->
{#snippet mapContents(layer: MapLayer)}
	<div>
		<button
			class="btn btn-xs"
			type="button"
			data-testid="read-as-document"
			onclick={() => readAsDocument(layer.id)}
		>
			<!-- Four buttons called "Read as a document" are four identical controls to a screen reader. -->
			Read as a document<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
		</button>
	</div>
{/snippet}
