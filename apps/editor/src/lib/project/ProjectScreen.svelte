<script lang="ts">
	// The Project.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// ONE SCREEN, AND WHY THIS ONE
	//
	// Entering a Project used to land on a page of fields with a link to a *different* page holding
	// the map. Noticing that a Map Image sat crooked meant seeing it on the stack page and
	// navigating to the Project page to do anything about it. So `/layers/` and `ProjectView` are one
	// screen now, and this is it: a Base Map with the Layer stack beside it.
	//
	// **This file is `/layers/`'s script, moved, not rewritten.** The document-loading chain — the
	// `documentKey` guard, `drawn` and `outcomes` — is the state layer for the whole screen and it is
	// load-bearing in ways no test names: `documentKey` exists because a rename once re-read every
	// Alignment and one drag of an opacity slider cost twenty reads per Layer. What `ProjectView`
	// contributed is added around it: the Project name (now in a dialog), the way a Map Image
	// gets in, and the remote-origin affordances.
	//
	// **What lives here, and what does not.** Four subjects would otherwise share this `<script>`.
	// The annotation editing layer — `openLayerId`, the selection, the drawing gesture, and every
	// function that writes an Annotation — is `annotations/annotation-editing.svelte.ts`, where it
	// has a unit test rather than only the browser suite. What remains is the document-loading
	// chain, the opening view (ADR-0026), offline availability (ADR-0025) and the way a Map Image
	// gets in. **If this file is growing again, the next thing to leave is one of those four.**
	//
	// **A component rather than a route.** A Project is `/?p=<dir>` (ADR-0008) — the same prerendered
	// page as the hub, choosing its subject client-side — so the thing that renders it has to be
	// mountable from `routes/+page.svelte`, which is where the `?p=` branch already is.
	//
	// **The navigation bar is not here.** The Workspace and Project hierarchy, theme toggle, save
	// indicator and undo control live in the root layout. What is here is what can be done to *this
	// Project*: choosing its Base Map and opening its settings.

	import { resolve } from '$app/paths';
	import {
		BASE_MAP_CATALOG,
		baseMapArchiveHost,
		automaticBorderStyle,
		DEFAULT_BASE_MAP_APPEARANCE,
		bordersIllegibleThemes,
		DEFAULT_BASE_MAP_BORDER_STYLE,
		DEFAULT_BASE_MAP_BORDERS,
		baseMapFallbackNotice,
		baseMapUnavailableNotice,
		canSolve,
		mapImageTilesUnavailableNotice,
		resolveBaseMap,
		type Alignment,
		type Annotation,
		type AnnotationCollection,
		type AnnotationLayer,
		type Layer,
		type MapLayer,
		type BaseMapCacheSize,
		type BaseMapEntry,
		type OpeningViewFit,
		type OpeningViewOutcome,
		type Place,
		type TileSourceFailure
	} from '@ballastella/core';
	import {
		canCaptureSnapshot,
		initialSnapshotReadiness,
		mapSnapshotFileName,
		snapshotAvailability,
		snapshotReadinessAfter,
		type DrawnLayer,
		type DrawnOutcome,
		type ReadCachedTile,
		type SnapshotReadinessEvent
	} from '@ballastella/core/render';
	import {
		AnnotationInspector,
		ANNOTATION_INSPECTOR_ID,
		BaseMapOptions,
		KIND_STYLE,
		LayerList,
		LeaderLine,
		MapCommentary,
		MapNotice,
		MapSnapshotButton,
		pageChrome,
		type Box
	} from '@ballastella/ui';
	import Plus from '@lucide/svelte/icons/plus';
	import Scan from '@lucide/svelte/icons/scan';
	import { tick, untrack } from 'svelte';

	import AnnotationLayerContents from '$lib/annotations/AnnotationLayerContents.svelte';
	import AnnotationStyleFace from '$lib/annotations/AnnotationStyleFace.svelte';
	import AnnotationTextFace from '$lib/annotations/AnnotationTextFace.svelte';
	import { AnnotationEditing } from '$lib/annotations/annotation-editing.svelte.js';
	import BaseMapPane from '$lib/base-map/BaseMapPane.svelte';
	import BorderStyleFields from '$lib/base-map/BorderStyleFields.svelte';
	import MakeOfflineDialog from '$lib/base-map/MakeOfflineDialog.svelte';
	import { MakeProjectOffline, readOfflineCoverage } from '$lib/base-map/make-offline.svelte.js';
	import { fitToProjectContent } from '$lib/base-map/opening-view';
	import ModalDialog from '$lib/components/ModalDialog.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import AddMapImage from '$lib/map-images/AddMapImage.svelte';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';
	import OfflineCopyDialog from '$lib/remote-iiif/OfflineCopyDialog.svelte';
	import { OfflineCopyJob } from '$lib/remote-iiif/offline-copy-job.svelte.js';
	import { saveFile } from '$lib/save-file';

	import { theme } from '$lib/theme.svelte';
	import { editHistorySlot } from '$lib/undo/edit-history-slot.svelte.js';

	import { describeImportEvidence, describeImportProvenance } from './import-provenance-text.js';
	import ProjectSharing from './ProjectSharing.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let {
		session,
		storage,
		openDirectory,
		offerAbove = false
	}: {
		session: EditorSession;
		storage: WorkspaceStorage;
		/** The Project's folder, from `?p=` (ADR-0008). Never `null` where this is mounted. */
		openDirectory: string;
		/**
		 * Whether the route is rendering something above this screen that speaks for itself.
		 *
		 * Only the announcement order depends on it; see the `projectProblem` branch below.
		 */
		offerAbove?: boolean;
	} = $props();

	/**
	 * Nothing to show, and a reason worth naming, rather than a screen that says "Opening…" for ever.
	 *
	 * ⚠ **The Workspace that is open, and no other** (ADR-0042). This once also drew the notice for a
	 * folder merely *remembered* from a previous visit, which made every Project in every Workspace
	 * unopenable for anybody who had ever chosen one. A folder that is not open is a row in the
	 * roster, not a state this screen is in.
	 */
	const recovering = $derived(session.status === 'unreachable');

	$effect(() => {
		pageChrome.showBreadcrumbs('editor-project', [
			{ label: 'Projects', destination: {}, testid: 'all-projects' },
			{
				label: session.openProject?.name || openDirectory,
				testid: 'project-name',
				action: {
					label: 'Edit Project name',
					testid: 'edit-project-name',
					onClick: () => void openSettings()
				}
			}
		]);
		return () => pageChrome.clear('editor-project');
	});

	/**
	 * This screen's Edit History, declared for the navigation bar (ADR-0039).
	 *
	 * The Project's own, keyed by its directory, so walking to `/align` and back finds the same one —
	 * and so a screen that declares nothing, Workspace Home among them, draws no controls at all.
	 */
	$effect(() => {
		editHistorySlot.show('editor-project', session.historyFor(openDirectory));
		return () => editHistorySlot.clear('editor-project');
	});

	const resolution = $derived(
		session.openProject ? resolveBaseMap(session.openProject.baseMap) : null
	);
	const notice = $derived(resolution === null ? null : baseMapFallbackNotice(resolution));
	const appearance = $derived(
		session.openProject?.baseMapAppearance ?? DEFAULT_BASE_MAP_APPEARANCE
	);
	const borders = $derived(session.openProject?.borders ?? DEFAULT_BASE_MAP_BORDERS);
	const borderStyle = $derived(session.openProject?.borderStyle ?? DEFAULT_BASE_MAP_BORDER_STYLE);

	/**
	 * Whether the map on screen can be handed over as a Map Snapshot, and which frame that is about.
	 *
	 * **The rules are `core`'s reducer**, not this component's: what invalidates a frame, which late
	 * answers count, and that a capture is a busy overlay rather than a state of its own are all
	 * decided in one place both applications will use. This screen only feeds it what it can see —
	 * the pane's map events, the two asset outcomes below, and the press.
	 *
	 * `$state.raw` because the reducer replaces the whole value and returns the same object for an
	 * event that changes nothing, which is most of them during a pan.
	 */
	let snapshot = $state.raw(initialSnapshotReadiness);

	/**
	 * Feed the readiness machine one event.
	 *
	 * ⚠ **`untrack` around the read.** Some of these are sent from inside an effect, and a tracked
	 * read of `snapshot` there would make that effect a dependent of the state it is writing — the
	 * Base Map reset below would then re-run, and clear `baseMapStatus`, every time the map settled.
	 */
	const onSnapshotEvent = (event: SnapshotReadinessEvent): void => {
		snapshot = snapshotReadinessAfter(
			untrack(() => snapshot),
			event
		);
	};

	/**
	 * Whether the Base Map's own source is drawing, as the pane reports it.
	 *
	 * `null` until the pane has said anything, so the notice below appears when the archive has
	 * actually failed and not in the moment before it has been asked for. It is reset when the Base
	 * Map changes — the tiles, or how they are drawn — because either rebuilds the style and asks
	 * the archive again, and a stale "could not be loaded" left over that answer is a worse lie than
	 * saying nothing.
	 */
	let baseMapStatus = $state<'drawing' | 'unavailable' | null>(null);
	$effect(() => {
		void resolution?.entry.id;
		void appearance;
		baseMapStatus = null;
		// The archive is about to be asked again, so whatever it said last time is no longer a fact
		// about the frame being drawn.
		onSnapshotEvent({ kind: 'base-map-assets', failed: false });
	});

	const layers = $derived<readonly Layer[]>(session.openProject?.layers ?? []);

	let deletingLayerId = $state<string | null>(null);
	const deletingLayer = $derived(layers.find((layer) => layer.id === deletingLayerId));

	const confirmDeleteLayer = async (): Promise<void> => {
		const id = deletingLayerId;
		deletingLayerId = null;
		if (id) await session.deleteLayer(id);
	};

	/**
	 * The Layers that could be on the map: visible, and of a kind this build can draw.
	 *
	 * A hidden Layer is *absent* from what the map is given rather than flagged inside it, so there is
	 * no second place where a Layer can be in the stack and not drawn. A `foreign` Layer is absent for
	 * the same reason and says so in the list (ADR-0014).
	 */
	const shown = $derived(
		layers.filter(
			(layer): layer is MapLayer | AnnotationLayer => layer.visible && layer.kind !== 'foreign'
		)
	);

	/**
	 * The Layers whose own document this screen opens: **every** map Layer, and the Annotation Layers
	 * being drawn. A superset of {@link shown} — `shown ⊆ withDocuments` — and the name says which
	 * files get read rather than which files *could* be read, because every Layer in the stack has a
	 * document and only these are opened.
	 *
	 * Wider than {@link shown} on purpose, and the difference is one word of ADR-0023: "not aligned
	 * yet" is derived from the Alignment's Control Points rather than stored, so a map Layer that is
	 * hidden has to have its Alignment read too or the sidebar cannot say anything true about it. The
	 * cost is named in the ADR and accepted.
	 *
	 * An Annotation Layer that is hidden is *not* read, because nothing asks a question of its file
	 * that the stack does not: its row says "no Annotations in this Layer yet" from the document the
	 * map needed anyway, and reading a hidden one would be a store read with nothing behind it.
	 */
	const withDocuments = $derived(
		layers.filter(
			(layer): layer is MapLayer | AnnotationLayer =>
				layer.kind === 'map' || (layer.visible && layer.kind === 'annotation')
		)
	);

	/**
	 * What requires the referenced documents to be read again: which Layers are read, and out of which
	 * files. **Not** the name and not the opacity, which are display state and must not cost a read of
	 * the store — a rename that re-read every Alignment would make the cheapest edit in the application
	 * one of the most expensive.
	 *
	 * **A string, and the effect below reads nothing else that is tracked.** Deriveds compare by
	 * reference and `withDocuments` is a fresh array from `.filter()` on every change to `layers`, so an
	 * effect that reads `withDocuments` has `layers` as its real dependency however carefully it computes a
	 * key first. That is what this guard used to be: the key was computed, discarded with `void`, and
	 * the list read on the next line — so a rename cost a re-read of every Alignment, and one drag of
	 * the opacity slider at `step="0.05"` cost twenty of them per Layer.
	 *
	 * **A map Layer's visibility is deliberately not in the key.** Its Alignment is read whether it is
	 * shown or not, so showing and hiding one changes nothing about which files to open; putting it in
	 * would make the visibility checkbox cost a re-read of every document on the screen.
	 */
	const documentKey = $derived(
		JSON.stringify(
			withDocuments.map((layer) => [
				layer.id,
				layer.kind === 'map' ? layer.imageId : layer.geojsonRef
			])
		)
	);

	/**
	 * Each read Layer's document, by Layer id: an `Alignment`, or a parsed `FeatureCollection`.
	 *
	 * Plain records rather than `Map`s, and `$state.raw` rather than `$state`: nothing here is mutated
	 * in place — a load replaces the whole record — which is what makes a mutable reactive collection
	 * the wrong primitive for it.
	 */
	let documents = $state.raw<Readonly<Record<string, unknown>>>({});
	/** Why a Layer's own file could not be read, by Layer id. */
	let unreadable = $state.raw<Readonly<Record<string, string>>>({});
	/** Bumped by every load, so a read that resolves late knows it has been superseded. */
	let generation = 0;

	$effect(() => {
		// The two tracked dependencies: which files to read, and the session to read them from.
		// `withDocuments` is read *untracked*, so a rename or a dragged slider — neither of which changes
		// which Layers are read or out of which files — cannot reach the store at all. See
		// {@link documentKey}.
		void documentKey;
		// Editing an Annotation replaces the collection in `documents` without changing `documentKey`,
		// so this must not also re-read on every edit — it would race the write and snap the map back to
		// the bytes on disk. `reloadAt` is bumped only where a fresh read is genuinely wanted.
		void reloadAt;
		// An Edit History writes bytes rather than calling the mutators that keep `documents`
		// (ADR-0039), so a Step walked back or forward is one of those genuine wants: without this the
		// Annotation would be in the file and absent from the map until something else re-read it.
		void session?.annotationsWrittenBack;
		const current = session;
		const wanted = untrack(() => withDocuments);
		if (!current) return;
		const mine = ++generation;
		void (async () => {
			const read: Record<string, unknown> = {};
			const failures: Record<string, string> = {};
			for (const layer of wanted) {
				try {
					const document =
						layer.kind === 'map'
							? await current.readLayerAlignment(layer)
							: await current.readAnnotations(layer);
					if (document !== null) read[layer.id] = document;
				} catch (cause) {
					// Said, never swallowed. A Layer whose file is there and unreadable means work the user
					// made is not on screen, and drawing nothing quietly is how they find out too late.
					failures[layer.id] = cause instanceof Error ? cause.message : String(cause);
				}
			}
			if (mine !== generation) return;
			documents = read;
			unreadable = failures;
			// The collection on screen is now the one on disk, so an Annotation that is no longer in it
			// takes the Inspector and the row's highlight with it.
			annotations.releaseMissingSelection();
		})();
	});

	/** Bumped to ask for a fresh read of every Layer's document. */
	let reloadAt = $state(0);

	/** The stack as the map takes it: top first, each Layer with its document in hand. */
	const drawn = $derived<readonly DrawnLayer[]>(
		shown.flatMap((layer): DrawnLayer[] => {
			const document = documents[layer.id];
			if (layer.kind === 'map') {
				// A map Layer that is not aligned yet is not handed to the map at all: there is nothing to
				// place it by, and `showAlignment` would only refuse it a second time, in words that
				// disagree with what its hidden twin would say. Its Alignment exists from the moment the
				// Map Image was added (ADR-0023), so the test is the Control Points and not the file.
				if (document === undefined || notAligned.has(layer.id)) return [];
				return [
					{
						layer,
						alignment: document as Alignment,
						referenced: referencedImageIds.has(layer.imageId),
						service: remoteServiceFor(layer)
					}
				];
			}
			return [{ layer, annotations: (document as AnnotationCollection | undefined) ?? null }];
		})
	);

	/**
	 * The Workspace Map Images whose tiles are on somebody else's server, by image id.
	 *
	 * **An observation of the folder, which is the only place the answer lives** (ADR-0023): an image
	 * directory with an `info.json` of ours has its tiles here, one with only a `remote.json` does not.
	 * `MapLayer` used to carry an `imageMode` saying it, and a claim in `project.json` outlived the
	 * offline copy that made it false — so this screen kept handing the renderer a library's address
	 * for tiles already in the folder.
	 *
	 * **Taken from the session rather than derived here**, which is where this used to be built by hand.
	 * It is the same question core's `tileLocation` answers for publishing, for the hub's reclaim list,
	 * and for the viewer's 404 probe; a set assembled in a page is how one rule ends up with five
	 * readings that can disagree.
	 */
	const referencedImageIds = $derived(session.referencedImageIds);

	/**
	 * Where a referenced Layer's tiles are served from, or `''` for a local copy.
	 *
	 * Keyed off {@link referencedImageIds} rather than off "is there a record for this image", so this
	 * answers `''` for a local copy and only for a local copy — a copied map keeps its `remote.json`
	 * for the citation (ADR-0007), and handing its address to the renderer would send it back to the
	 * library for tiles that are right here.
	 *
	 * **`''` on a referenced Layer renders blank, and `showAlignment` refuses it** rather than drawing
	 * nothing and reporting it drawn — see the `referenced` field passed beside this one. Reaching that
	 * refusal needs a Layer whose `remote.json` really is missing or unreadable, which is a hand-edited or
	 * half-written Workspace.
	 */
	const remoteServiceFor = (layer: MapLayer): string => {
		if (!referencedImageIds.has(layer.imageId)) return '';
		return session.referencedImages.find((image) => image.imageId === layer.imageId)?.service ?? '';
	};

	/** What the map made of each Layer it was given. */
	let rendered = $state.raw<Readonly<Record<string, DrawnOutcome>>>({});

	/**
	 * What a map Layer with too few Control Points says about itself.
	 *
	 * One sentence for every unaligned map Layer, whichever way it got here, because the state is one
	 * state: adding a Map Image now puts a Layer in the stack straight away with a starter
	 * Alignment beside it (ADR-0023), so "not aligned yet" is the ordinary first thing a Layer says
	 * rather than a fault.
	 */
	const NOT_ALIGNED = 'Not aligned yet, so there is nothing to draw.';

	/**
	 * The map Layers that cannot be placed on the earth yet, by Layer id.
	 *
	 * **Derived, never stored** (ADR-0023): the test is `canSolve`, which is `controlPoints.length >=
	 * MINIMUM_CONTROL_POINTS[transformationType]` and is the same number the transformation picker
	 * gates on. A boolean written when the map was added would be wrong for a *partly* aligned map —
	 * one or two points, below the solvable minimum — which is exactly the state a scholar interrupted
	 * half way leaves behind.
	 *
	 * Computed over {@link withDocuments} rather than {@link shown}, so a hidden Layer's answer is the same
	 * answer. It has to be: the sentence is about the Map Image's placement, and a Layer does not
	 * become aligned by being ticked.
	 *
	 * A Layer with no Alignment at all counts as not aligned rather than as missing. That is a
	 * hand-edited or half-written Workspace now — every add writes the file — and "not aligned yet" is
	 * both true of it and the thing the user can act on.
	 */
	const notAligned = $derived(
		new Set(
			withDocuments
				.filter((layer) => layer.kind === 'map')
				.filter((layer) => {
					const document = documents[layer.id];
					return document === undefined || !canSolve(document as Alignment);
				})
				.map((layer) => layer.id)
		)
	);

	/**
	 * What the list says about each Layer: what the map reported, and what the map was never asked.
	 *
	 * **An unaligned map Layer's sentence wins over the renderer's**, which is why that loop comes
	 * first. A Layer with one Control Point of two is handed to the map — it has an Alignment now — and
	 * the warped renderer refuses it with a count of its own; taking that answer would mean a hidden
	 * Layer and a visible one saying different things about the same unplaced map.
	 *
	 * A file that is there and cannot be read wins over both, because it is the only one of the three
	 * that means work the user made is not on screen.
	 */
	const outcomes = $derived.by((): Readonly<Record<string, DrawnOutcome>> => {
		const merged: Record<string, DrawnOutcome> = { ...rendered };
		for (const layer of withDocuments) {
			if (notAligned.has(layer.id)) {
				merged[layer.id] = { status: 'refused', reason: NOT_ALIGNED };
				continue;
			}
			if (merged[layer.id] || documents[layer.id] !== undefined) continue;
			if (layer.kind === 'annotation') {
				merged[layer.id] = { status: 'refused', reason: 'No Annotations in this Layer yet.' };
			}
		}
		for (const [id, reason] of Object.entries(unreadable)) {
			merged[id] = { status: 'refused', reason };
		}
		return merged;
	});

	/**
	 * The Project map's own Map Image failure, or `null`.
	 *
	 * ⚠ **Only this shim reports.** `EditorSession#imageServiceFetch` hands out a fresh one per
	 * caller for exactly this reason: `add-remote-map` probes a library with a request it *expects*
	 * to be refused, and a listener wired to that one would leave a permanent "a Map Image stopped
	 * drawing" over a Workspace where nothing is wrong. This is the Project map, where a refusal
	 * really does mean a Layer has a hole in it.
	 *
	 * `ok` is "every URL that had been refused has come back", not "some bytes arrived", so the
	 * notice comes down when the map is whole rather than when it is merely busy.
	 */
	let tileFailure = $state.raw<{
		failure: TileSourceFailure;
		imageId: string | null;
	} | null>(null);

	const fetchTile = $derived(
		session.imageServiceFetch((outcome) => {
			tileFailure = outcome.ok ? null : { failure: outcome.failure, imageId: outcome.imageId };
			// A Map Image that is not drawing outranks a frame that has fallen quiet: quiet is not
			// complete, and a Map Snapshot of a holed map is the one thing this feature must not hand over.
			onSnapshotEvent({ kind: 'map-image-assets', failed: !outcome.ok });
		})
	);

	/**
	 * What to say when a Map Image's tiles stopped arriving, or `null`.
	 *
	 * ⚠ **The sentence is `mapImageTilesUnavailableNotice`'s, not this template's**, and the
	 * published viewer renders the same function's output for the same failure — so the two
	 * deployments cannot drift into describing one outage two ways at the same person.
	 *
	 * The Layer's name is resolved here rather than in core, because which Layer an `imageId` belongs
	 * to is a fact about *this* Project. `null` when the failure named no image, or named one no
	 * Layer of this Project draws: a sentence naming the wrong map sends a scholar to an Alignment
	 * that is fine.
	 */
	const tilesUnavailable = $derived.by((): string | null => {
		const failed = tileFailure;
		if (!failed) return null;
		const named = layers.find(
			(layer): layer is MapLayer => layer.kind === 'map' && layer.imageId === failed.imageId
		);
		return mapImageTilesUnavailableNotice(failed.failure, named?.name ?? null);
	});

	/** How many Layers are actually on the map. Said, because "nothing is drawn" has many reasons. */
	const drawnCount = $derived(
		Object.values(outcomes).filter((outcome) => outcome.status === 'drawn').length
	);

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// The opening view (ADR-0026)
	//
	// **Not a `$derived`, and that is the whole design.** Bounds computed reactively would recompute
	// when a Layer is toggled, an Annotation is drawn, a Control Point is moved, or a Layer is
	// renamed — and every one of those would snatch the map away from wherever the user had put it,
	// mid-edit. The effect below runs its body once per Project opened, guarded by a plain `let` that
	// nothing tracks, and hands the pane a single fit object. Every later fit is a user pressing a
	// button.
	// ─────────────────────────────────────────────────────────────────────────────────────────

	let openingFit = $state.raw<OpeningViewFit | null>(null);
	let openingOutcome = $state<OpeningViewOutcome>('pending');

	/**
	 * The Project the opening view has already been settled for.
	 *
	 * A plain `let` rather than `$state`: it is written from inside the effect that reads it, and a
	 * reactive one would make that effect its own dependency — which is the loop, and then the refit.
	 */
	let framedProject = '';

	/** Whether the last framing was asked for rather than automatic, so the sentence can say so. */
	let refitted = $state(false);

	$effect(() => {
		const directory = openDirectory;
		const current = session;
		const file = current.openProject ?? null;
		// `session.openDirectory` as well as the URL's: `open()` clears `openProject` and sets its own
		// directory, so between a navigation and that call the URL names the new Project while the
		// document in hand is still the old one. Framing the new Project on the old one's Layers is a
		// plausible wrong answer that only appears when moving between Projects.
		if (file === null) return;
		if (current.openDirectory !== directory || framedProject === directory) return;
		framedProject = directory;
		openingOutcome = 'pending';
		openingFit = null;
		refitted = false;
		const projectLayers = file.layers;
		void (async () => {
			const fit = await fitToProjectContent(current, projectLayers);
			// A read that resolved after the user moved on must not move their map.
			if (framedProject !== directory) return;
			openingFit = fit;
			openingOutcome = fit === null ? 'default' : 'content';
		})();
	});

	/**
	 * "Fit to this Project", on demand (ADR-0026).
	 *
	 * The affordance that covers everything the automatic fit deliberately does not: it is what a user
	 * reaches for after panning away, after hiding a Layer, and after drawing an Annotation somewhere
	 * new. Re-read rather than recomputed from what is in hand, because what is in hand is the
	 * *visible* Layers' documents — this has to answer for the whole Project, hidden Layers included,
	 * exactly as the automatic fit does.
	 *
	 * A fresh fit object every time, even for the same box: identity is what the pane applies on, and a
	 * user pressing this twice has panned away in between and means it twice.
	 */
	async function fitToProject(): Promise<void> {
		const file = session.openProject ?? null;
		if (file === null) return;
		const fit = await fitToProjectContent(session, file.layers);
		openingFit = fit;
		openingOutcome = fit === null ? 'default' : 'content';
		refitted = true;
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Annotations
	//
	// **Kept out of this file**, in `annotations/annotation-editing.svelte.ts`: one subject with
	// exactly three edges to the rest of the screen — the session, the `documents` record, and
	// `layers` — which is what those three arguments are. Everything about *why* each member is
	// shaped as it is lives there with it.
	// ─────────────────────────────────────────────────────────────────────────────────────────

	const annotations = new AnnotationEditing({
		session: () => session,
		layers: () => layers,
		documents: () => documents,
		// The one write back through the middle of the edge: `documents` holds the map Layers'
		// Alignments too, so the screen keeps the record and this replaces one entry in it.
		replaceDocument: (layerId, collection) => {
			documents = { ...documents, [layerId]: collection };
		}
	});

	/** The gesture in progress, read by the window's Escape handler and by the pane. */
	const drawing = annotations.drawing;

	/** The Base Map pane, for the one thing this screen asks of its camera. */
	let baseMapPane = $state<BaseMapPane | undefined>();

	/**
	 * The Annotation Inspector's docked box, while it is in the document.
	 *
	 * **The element rather than `annotations.selectedAnnotation`**, because the pane's control row
	 * has to stop short of this column for as long as the column is *drawn* — and the panel has a
	 * 220 ms out transition, so the selection is already null while it is still on screen and still
	 * taking the pointer. A `bind:this` is cleared when the element is destroyed, which is after the
	 * transition rather than at the top of it.
	 */
	let inspectorDock = $state<HTMLDivElement | undefined>();

	/**
	 * Download the map on screen as a Map Snapshot.
	 *
	 * The pane owns the picture and this owns the file: the Blob reaches `saveFile` as a stream
	 * because that is the shape it takes, and nothing is written into the Workspace on the way — a
	 * Map Snapshot is an illustration the scholar keeps, not part of the Project.
	 *
	 * **Every way this can fail is one announcement**, because they are one thing to the scholar: a
	 * refused framebuffer read, a `toBlob` that answered `null`, a download the browser would not
	 * start. What none of them is is an asset failure — the frame is as complete as it was — so the
	 * control comes back ready and the sentence offers the retry.
	 */
	async function downloadMapSnapshot(): Promise<void> {
		const pane = baseMapPane;
		if (!pane || !canCaptureSnapshot(snapshot)) return;
		onSnapshotEvent({ kind: 'capture-started' });
		try {
			const captured = await pane.captureSnapshot();
			await saveFile(mapSnapshotFileName(openDirectory), captured.stream());
			onSnapshotEvent({ kind: 'capture-finished' });
		} catch {
			onSnapshotEvent({ kind: 'capture-failed' });
		}
	}

	/**
	 * The Base Map Options panel, held so the Escape handler below can ask whether it was open.
	 *
	 * Escape dismisses a popover natively **and keeps propagating**, so without this an Escape meant
	 * for the panel would also abandon a part-drawn shape the user cannot see behind it.
	 */
	let baseMapOptionsMenu = $state<ReturnType<typeof BaseMapOptions> | undefined>();

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// The leader
	//
	// **It points at the Annotation itself**, at the middle of whatever is drawn for it. There is no
	// mark in between to aim at: the pane projects the selected Annotation's own coordinate on demand,
	// and the map draws that Annotation more strongly so both ends of the line say which one it is.
	//
	// So this screen contributes the two columns, the row — found by querying, since only its
	// `data-annotation-id` identifies it — and the map end's box; `LeaderLine` owns everything about
	// when a line is drawn at all.
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The two columns the leader is drawn between.
	 *
	 * `$state` rather than plain `let`s, unlike a `bind:this` kept only to move focus: the accessors
	 * below are read inside `LeaderLine`'s effects, and a non-reactive binding assigned during mount
	 * would leave the first of those effects observing nothing at all.
	 */
	let layerSidebar = $state<HTMLElement | undefined>();
	let mapColumn = $state<HTMLElement | undefined>();

	/**
	 * The scrolling part of the rail, which is the box the leader's own rule is about.
	 *
	 * ⚠ **Not `layerSidebar`.** `leaderPath` draws nothing when the row's near edge has left the
	 * column it was given, and what clips a row out of sight is this box rather than the rail around
	 * it — the rail also holds the pinned add-Layer pair, so a row scrolled behind that pair is
	 * invisible while still inside the rail's own rectangle, and a line drawn to it would start on a
	 * row nobody can see.
	 */
	let layerScroller = $state<HTMLElement | undefined>();

	/**
	 * Where the selected Annotation is on the map, or `null` when there is nothing to point at.
	 *
	 * Projected at draw time rather than measured off an element, because an Annotation is painted
	 * into the map's canvas and has no element of its own. An Annotation whose geometry this build
	 * cannot draw has no box, and so no line — which is the same answer as before, arrived at without
	 * a mark having to be missing to say so.
	 */
	const selectedMark = (): Box | null => {
		const annotation = annotations.selectedAnnotation;
		return annotation ? (baseMapPane?.annotationBox(annotation) ?? null) : null;
	};

	/** That Annotation's row, which is on screen only while its Layer's card is open. */
	const selectedRow = (): Element | null => {
		const id = annotations.selectedAnnotationId;
		if (id === null || !layerSidebar) return null;
		return layerSidebar.querySelector(
			`[data-testid="annotation-row"][data-annotation-id="${CSS.escape(id)}"]`
		);
	};

	/**
	 * The Annotation the camera has already been asked to keep clear of the Inspector.
	 *
	 * A plain `let`, deliberately: in runes mode it is not reactive, so recording an answer cannot
	 * re-run the effect that arrived at it — the same reason `BaseMapPane`'s `fitted` is one.
	 */
	let cleared: string | null = null;

	/**
	 * Ask the camera to keep the mark clear of the Inspector when a *different* Annotation is selected,
	 * so the mark a scholar chose is never behind the panel describing it (ADR-0035).
	 *
	 * **What holds the line against a camera move per keystroke is this effect's dependency set, which is
	 * `selectedAnnotationId` and nothing else.** `selectedAnnotation` is a fresh object after every save,
	 * and a save is every keystroke, so an effect that read the Annotation instead would re-run on each
	 * one. Reading only the id also makes "a different Annotation was chosen" the trigger, which is what
	 * makes this the same gesture that opens the panel — from a row, from the canvas, from a Place or from
	 * finishing a shape — rather than four call sites that can disagree.
	 *
	 * **`cleared` is a second guard covering the same case, and either one alone would be enough.** It is
	 * kept because it is the guard that survives someone reading more of the Annotation here later; what
	 * it costs is the note you are reading. If *both* go, the fault is not a crash: a scholar who has
	 * panned the mark back under the panel — which is allowed, the camera does not fight the user — gets
	 * the map yanked out from under the sentence they are typing, and pays a forced layout per keystroke
	 * for `keepAnnotationClear`'s two `getBoundingClientRect` calls in the bargain. Neither shows up as an
	 * error, which is why `editor-annotations.e2e.ts` types into a panel over a mark it has deliberately
	 * put back underneath, and asserts the camera stays where it was.
	 *
	 * Whether the camera actually moves is `keepAnnotationClear`'s, and for a mark already comfortably in
	 * view the answer is no.
	 */
	$effect(() => {
		const id = annotations.selectedAnnotationId;
		if (id === null) {
			cleared = null;
			return;
		}
		if (id === cleared) return;
		cleared = id;
		void keepSelectedMarkClear();
	});

	/**
	 * Hand the pane the panel's own footprint, once the panel is on the screen to be measured.
	 *
	 * The `tick` is what makes the measurement possible at all: the Inspector is inserted by the same
	 * flush that changed the selection, so a measurement taken before it has none of the panel to
	 * measure. It also puts everything below it outside the effect's dependencies, which is why the
	 * Annotation is read here rather than passed in.
	 */
	async function keepSelectedMarkClear(): Promise<void> {
		await tick();
		const annotation = annotations.selectedAnnotation;
		if (!annotation) return;
		const panel = document.getElementById(ANNOTATION_INSPECTOR_ID);
		baseMapPane?.keepAnnotationClear(annotation, panel?.getBoundingClientRect() ?? null);
	}

	/**
	 * Put the keyboard back in the Annotation list once the Inspector has been asked to go.
	 *
	 * The control that was pressed — *Dismiss*, or *Delete* — is inside the panel that is leaving, so
	 * without this the keyboard ends up nowhere and the way back is Tab from the top of the document,
	 * past MapLibre's own controls.
	 *
	 * ⚠ **"Focus is on `document.body`" is not the test here, and that is the trap.** The Inspector
	 * leaves over 220 ms, so one microtask after the selection is cleared the pressed button is still in
	 * the document and still `document.activeElement` — a guard reading `body` alone did nothing at all,
	 * and left the keyboard on a control that vanished a fifth of a second later.
	 * `LayerList.deleteByButton` can read `body` because the card it deletes goes at once.
	 *
	 * Focus is still only ever *restored*: anything outside the outgoing panel that has taken the
	 * keyboard in the meantime keeps it.
	 */
	async function returnKeyboardToList(row: Element | null | undefined): Promise<void> {
		await tick();
		const active = document.activeElement;
		const leaving = document.getElementById(ANNOTATION_INSPECTOR_ID);
		const stranded = active === document.body || (active !== null && leaving?.contains(active));
		if (!stranded) return;
		if (row instanceof HTMLElement) row.focus();
	}

	/**
	 * Dismiss the Inspector, leaving the keyboard on the row the scholar chose it from.
	 *
	 * **Dismissing is deselecting**, because the selected row *is* the Annotation the Inspector
	 * describes: one fact, one value, and a row that stayed selected with the panel gone would have no
	 * way back — pressing it again would deselect it. What dismissing does not touch is the list: the
	 * Layer's card stays open and the row stays where it was, so the scholar's place in it survives the
	 * panel going.
	 */
	async function dismissInspector(): Promise<void> {
		const row = selectedRow();
		annotations.selectAnnotation(null);
		await returnKeyboardToList(row);
	}

	/**
	 * Delete the selected Annotation, and leave the keyboard in the list rather than nowhere.
	 *
	 * The row that had the selection goes with the Annotation, so the keyboard is handed the row that
	 * takes its place — or the last one, when what was deleted was last. The deletion itself, and the
	 * Step it opens, are `AnnotationEditing.deleteSelected`'s.
	 *
	 * ⚠ **When there is no Annotation left, the keyboard goes to *New Annotation* in the same card.**
	 * Deleting the only Annotation in a Layer is the commonest delete of all — it undoes a shape drawn by
	 * mistake in a Layer just made — and it is the one case where "a row in the list" does not exist to
	 * be focused. `LayerList.deleteByButton` has a fallback for the same reason one level up. The button
	 * is in the open Layer's own card, beside where the row was, and pressing it is what somebody who has
	 * just emptied a Layer is most likely to want next.
	 *
	 * ⚠ **Which Annotation takes the place is asked of the collection and only the *row* of the DOM.**
	 * Counting the rows that are on the screen looks equivalent and is not: `deleteSelected` awaits a
	 * write, so one `tick` after it the list has sometimes not been re-rendered, and the row at the
	 * deleted Annotation's index is then the doomed row itself. Focusing it succeeded and the removal
	 * a moment later put the keyboard on `document.body` — the very outcome this function exists to
	 * prevent, failing about half the time.
	 */
	async function deleteSelectedAnnotation(): Promise<void> {
		const at = annotations.selectedIndex;
		await annotations.deleteSelected();
		await tick();
		const remaining = annotations.activeCollection?.annotations ?? [];
		const next = remaining[Math.min(at, remaining.length - 1)];
		await returnKeyboardToList(
			next
				? (layerSidebar?.querySelector<HTMLElement>(
						`[data-testid="annotation-row"][data-annotation-id="${CSS.escape(next.id)}"]`
					) ?? null)
				: layerSidebar?.querySelector<HTMLElement>('[data-testid="annotation-new"]')
		);
	}

	/**
	 * A Place was chosen on the open Annotation Layer: **frame the map on it, and drop a Pin there.**
	 *
	 * **Placing always frames** (ADR-0029). A scholar looking at Amsterdam who picks a Boston address
	 * would otherwise get a Pin off screen — invisible, unverifiable, and uncorrectable, when
	 * correcting it is the entire point of the feature.
	 *
	 * The framing uses the Place's bounding box and the Pin uses its point, which is the whole of the
	 * rule that **the box reaches the camera and never the file**: a rectangle labelled *Paris* takes
	 * in Boulogne, and a polygon in a document where Annotations are the scholarly claim would be
	 * confidently wrong. Which box becomes which camera is the pane's — this screen hands it the
	 * Place, exactly as the pane's own search does, so the fit is written once.
	 *
	 * The title is `query` — what they typed — and not `place.name`, which is the service's postal
	 * address for the thing.
	 */
	async function placeAtPlace(place: Place, query: string): Promise<void> {
		baseMapPane?.frameOnPlace(place);
		await annotations.placePin(place.point, query);
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Making this Project available offline (ADR-0025)
	//
	// **Nothing here is stored and nothing is a flag.** Whether this Project is available offline is
	// `offlineCoverage`'s answer to "are the tiles this extent needs on disk?", re-asked whenever the
	// Project's content changes and after every fetch. That is what makes a second Project in the same
	// city offline for free, a Project whose work has spread not offline any more, and the hub's clear
	// action able to unmake every claim at once — none of which is code here.
	// ─────────────────────────────────────────────────────────────────────────────────────────

	const offline = new MakeProjectOffline(() => session!);

	/** What the Workspace's cache holds. `null` until it has been looked at. */
	let cache = $state.raw<BaseMapCacheSize | null>(null);
	/**
	 * Whether this Project is available offline, or `null` when it could not be decided.
	 *
	 * Three states rather than two, and the third is the one that matters: deciding needs the source
	 * archive's maximum zoom, which needs the network. With no connection the honest answer is "not
	 * known", and the map is drawn from whatever the cache holds regardless — see {@link cachedBaseMap}.
	 */
	let offlineReady = $state<boolean | null>(null);
	/** What to say about it, beside the map. */
	let offlineSummary = $state('');
	/** Bumped to re-ask after a fetch, so the sentence and the source both follow the disk. */
	let offlineGeneration = $state(0);

	/**
	 * Which Base Map is shown, as a plain string.
	 *
	 * **A `$derived` over a primitive, and that is the whole of it.** `resolution` is a fresh object on
	 * every change to `project.json`, so an effect reading `resolution?.entry.id` depends on
	 * `resolution` and re-runs on a rename and on every step of a dragged opacity slider — which is the
	 * same trap `documentKey` was written for, one signal along. Svelte does not propagate a derived
	 * whose value is unchanged, so this reduces the dependency to "did the author pick another Base
	 * Map?", which is the question the effect below actually asks.
	 */
	const baseMapEntryId = $derived(resolution?.entry.id ?? '');

	/**
	 * Re-read the cache and the coverage.
	 *
	 * Cheap and store-only in its first half — one `list` of `base-map/tiles/` — so the map can be
	 * drawn from the cache before anything has been asked of the network. The coverage half opens the
	 * archive and is allowed to fail: with no connection there is no way to know how deep the source
	 * goes, and claiming completeness against a number read off our own cache is exactly the vacuous
	 * claim ADR-0025 refuses.
	 */
	async function readOfflineState(
		current: EditorSession,
		entry: BaseMapEntry,
		forLayers: readonly Layer[]
	): Promise<void> {
		// This entry's own cache, not the Workspace's total: `maxZoom` below becomes the MapLibre
		// source's `maxzoom`, and another archive's depth there is a map that goes blank above the zoom
		// this one actually covers.
		cache = await current.baseMapCacheSizeFor(entry.archive);
		try {
			const read = await readOfflineCoverage(current, entry, forLayers);
			offlineReady = read.coverage?.complete ?? false;
			// Answered from the record the last fetch left rather than from the archive, because the
			// archive could not be reached. Said aloud rather than passed off as a live answer: the depth
			// is a snapshot, and an archive rebuilt a zoom deeper would make it quietly wrong.
			const asOf = read.fromRecord
				? ' Checked against what this Workspace recorded when the tiles were fetched, because there is no connection.'
				: '';
			offlineSummary =
				read.bounds === null
					? 'This Project has nothing placed on the earth yet, so there is no area to make available offline.'
					: read.coverage?.complete
						? `Available offline: all ${read.coverage.budget.count} Base Map tiles this Project’s work covers are in this Workspace.${asOf}`
						: `Not available offline: ${read.coverage?.present ?? 0} of ${read.coverage?.budget.count ?? 0} Base Map tiles this Project’s work covers are in this Workspace.${asOf}`;
		} catch {
			offlineReady = null;
			offlineSummary =
				(cache?.tiles ?? 0) > 0
					? `The Base Map is being drawn from the ${cache?.tiles} tiles in this Workspace. Whether that covers everything this Project needs cannot be checked without a connection.`
					: 'The Base Map needs a network connection, and there is none. Your Map Images, Alignments, and Annotations are all still here.';
		}
	}

	/**
	 * Which Base Map the pane draws: the Workspace's tiles, or the deployment's archive.
	 *
	 * The cache wins when it is **known to be complete for this Project**, and also when the archive
	 * could not be reached at all. It deliberately loses to the network when the cache is known to be
	 * partial: one MapLibre source cannot mix the two, and a half-filled cache preferred while online
	 * would draw holes in a map that could have drawn properly. The line beside the map says which of
	 * the three it is, so none of it is silent.
	 */
	/**
	 * The last value {@link cachedBaseMap} produced, so an unchanged answer stays the same object.
	 *
	 * ⚠ Not `$state`: it is written from inside the derived, and reading it there is deliberate. The
	 * consumer is a `$effect` that registers a MapLibre protocol handler, and Svelte propagates a
	 * derived by *identity* — a fresh `{ maxZoom, readTile }` on every recompute made every Layer
	 * rename and every dragged opacity slider tear the protocol down and register it again, with the
	 * map's source pointing at a handler that is briefly `null` in between. Nothing about which tiles
	 * are served has changed unless `maxZoom` has.
	 */
	let servedCache: { maxZoom: number; readTile: ReadCachedTile } | null = null;

	const cachedBaseMap = $derived.by(() => {
		const held = cache;
		const archive = resolution?.entry.archive;
		const readTile = archive === undefined ? undefined : session?.readCachedBaseMapTile(archive);
		if (!held || held.maxZoom === null || !readTile || offlineReady === false) {
			servedCache = null;
			return null;
		}
		if (servedCache?.maxZoom !== held.maxZoom || servedCache.readTile !== readTile) {
			servedCache = { maxZoom: held.maxZoom, readTile };
		}
		return servedCache;
	});

	/**
	 * Re-read when the Project opens, when its Layers' documents change, and when the Base Map does —
	 * each of those changes the extent or the pyramid the question is about.
	 *
	 * **Everything the body reads is read untracked, and that is the same trap `documentKey` exists
	 * for.** `readOfflineCoverage` walks every Layer's Alignment, and `layers` is a `$derived` that is
	 * a fresh array on any change to `project.json` — so reading it inside the effect made a *rename*
	 * and a dragged *opacity slider* each re-read every Alignment in the Project. `editor-layers.e2e.ts`
	 * counts those reads and caught it. The dependencies are exactly the four lines below.
	 */
	$effect(() => {
		void openDirectory;
		void documentKey;
		void baseMapEntryId;
		void offlineGeneration;
		const current = untrack(() => session);
		const entry = untrack(() => resolution?.entry);
		const forLayers = untrack(() => layers);
		if (!current || !entry) return;
		void readOfflineState(current, entry, forLayers);
	});

	// A finished run changes the files, so the sentence and the source both have to be re-read from
	// them. Keyed off the job's completion message rather than off a callback, because the job also
	// finishes by being cancelled and by finding nothing to do, and all three change the disk.
	$effect(() => {
		if (offline.completed === '') return;
		untrack(() => (offlineGeneration += 1));
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Project settings
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The Project's own settings, in a `<dialog>`.
	 *
	 * ADR-0016 mandates `<dialog>` + `showModal()` — Escape, the focus trap and focus restoration come
	 * with it — and {@link ModalDialog} is where that decision was made once. The name and secondary
	 * offline action do not need a screen of their own.
	 */
	let settingsOpen = $state(false);

	const projectDateFormat = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
		hour12: true
	});
	function formatProjectUpdatedAt(iso: string): string {
		const when = new Date(iso);
		return Number.isNaN(when.valueOf()) ? iso : projectDateFormat.format(when);
	}

	/** The Project's transfer history, oldest first, or nothing for a Project nobody imported. */
	const provenance = $derived(session.openProject?.importProvenance ?? []);

	/**
	 * Whether the Workspace carries a site, or `null` while nothing has read the files yet.
	 *
	 * ⚠ **Observed on opening rather than derived.** Having Share Links *is* carrying the viewer file
	 * set (ADR-0045), so the answer is a read of the store — not a signal, and not something to
	 * repeat on every render of a screen that also draws a map.
	 */
	let shareLinks = $state<boolean | null>(null);

	/**
	 * Whether this Project holds work the Remote has not got.
	 *
	 * Starts `true`, which is what absent evidence means: the state that offers the Sync first is the
	 * one that cannot hand a colleague a link to last week.
	 */
	let unsentWork = $state(true);

	/** The address *Share Project* hands over, or `''` where there is no repository to serve one. */
	const shareLink = $derived(storage.projectShareLink(openDirectory));

	const messageOf = (cause: unknown): string =>
		cause instanceof Error ? cause.message : String(cause);

	async function openSettings(): Promise<void> {
		settingsOpen = true;
		shareLinks = await storage.hasShareLinks();
		unsentWork = (await storage.projectReach(openDirectory)).unsent;
	}

	/** Re-read what the two Share Project controls depend on, after an act that could have moved it. */
	async function reReadSharing(): Promise<void> {
		shareLinks = await storage.hasShareLinks();
		unsentWork = (await storage.projectReach(openDirectory)).unsent;
	}

	/**
	 * Turn Share Links on from here, and report the refusal rather than throwing it.
	 *
	 * ⚠ **A guided step is a refusal here, and deliberately so.** GitHub needs
	 * `Administration: write` to switch Pages on and ADR-0040 refuses to ask for it, so the ordinary
	 * outcome is one setting the author changes on github.com — and the screen that hands over the
	 * deep link and polls until the site answers is the Workspace's own dialog (ADR-0042). What
	 * happens here is that the viewer reaches the Workspace, the instruction is said, and the link is
	 * not handed over as though it worked.
	 */
	async function enableShareLinksHere(): Promise<string> {
		try {
			const outcome = await storage.enableShareLinks();
			await reReadSharing();
			return outcome.enabled ? '' : outcome.instruction;
		} catch (cause) {
			return messageOf(cause);
		}
	}

	/** *Sync and copy the link*'s first half: the send, with its refusal as a sentence. */
	async function sendForShareLink(): Promise<string> {
		try {
			await storage.sendToRemote();
			await reReadSharing();
			return '';
		} catch (cause) {
			return messageOf(cause);
		}
	}

	/** Close settings before the offline dialog opens, leaving one modal focus trap at a time. */
	async function makeProjectOffline(): Promise<void> {
		settingsOpen = false;
		await tick();
		await offline.ask(resolution!.entry, layers);
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Bringing a Map Image in, and the ones that live on somebody else's server
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * One offline-copy job for the whole screen, not one per Layer.
	 *
	 * An offline copy is deliberately made one image at a time, so a second job would be a second way
	 * to start a copy that the first one's `busy` guard cannot see.
	 */
	const offlineCopy = new OfflineCopyJob(() => session);

	/**
	 * The app's one online signal, so a referenced Map Image can say why it is not there.
	 *
	 * ADR-0012's offline claim has one honest exception: a referenced Map Image's tiles are on
	 * somebody else's server, so with no connection there is nothing to draw and no amount of caching
	 * would change that — a partially cached remote pyramid renders *with holes*, which reads as
	 * corruption. Say so, name the host, and leave the rest of the Project working.
	 */
	const installedApp = useInstalledApp();

	/**
	 * What to say when the Base Map did not load and the connection is fine.
	 *
	 * ⚠ **Only while online**, and the ordering with the offline notice is the whole point. With no
	 * connection the archive also fails, and two alerts — one saying the connection is out and one
	 * saying the server is — would leave the scholar to work out which is true. `base-map-offline`
	 * already owns that case and says something actionable about it.
	 */
	const unavailableNotice = $derived(
		resolution !== null && baseMapStatus === 'unavailable' && installedApp.online
			? baseMapUnavailableNotice(resolution.entry, baseMapArchiveHost(resolution.entry))
			: null
	);

	/**
	 * The remote-origin record for a map Layer's Map Image, or `undefined`.
	 *
	 * **Keyed by Layer, which is what replaced the two sections `ProjectView` had.** "Referenced
	 * Map Images" and "Offline copies" were two lists of image ids sitting under a Project that
	 * had no way to say which of its Layers each one belonged to; the same two facts — the tiles are on
	 * a library's server, and this copy came from one — are properties of a Layer and belong on it
	 * (ADR-0023), and they are shown on an opened Layer card.
	 */
	const originFor = (layer: MapLayer) =>
		session.referencedImages.find((image) => image.imageId === layer.imageId);

	/** The Map Images this Project draws, which is one Layer each (ADR-0023). */
	const mapLayers = $derived(layers.filter((layer): layer is MapLayer => layer.kind === 'map'));

	/** The map Layers of this Project whose tiles are fetched from a library. */
	const referencedLayers = $derived(
		layers.filter(
			(layer): layer is MapLayer => layer.kind === 'map' && referencedImageIds.has(layer.imageId)
		)
	);

	/** The hosts a Reader — or the author, right now — cannot reach. Named, never counted. */
	const unreachableHosts = $derived([
		...new Set(
			referencedLayers
				.map((layer) => originFor(layer)?.service)
				.filter((service): service is string => Boolean(service))
				.map((service) => new URL(service).hostname)
		)
	]);

	/** Whether the "Add a Map Image" dialog is up. A working choice, stored nowhere. */
	let addingMap = $state(false);

	/**
	 * What the last add had to say beyond having happened, or `''`.
	 *
	 * **Held here rather than in the dialog because the dialog closes on success.** The one thing that
	 * says this today is the community Alignment a user asked to import and did not get: the Layer is
	 * there, the import did not happen, and *why* is not guessable from anything on screen — one
	 * Alignment per Map Image, shared by every Project that draws it, is a property of this
	 * application's storage (ADR-0023). A message rendered inside the dialog would be inserted and
	 * removed in the same frame, which announces nothing at all.
	 */
	let addNotice = $state('');

	/**
	 * What the preparation of a Map Image is doing, in one sentence.
	 *
	 * **One string, rendered twice**: visibly on the Layer's card, and in the always-present live
	 * region below the stack. The announcement has to carry the same numbers as the bar, and the only
	 * way to be sure of that is for there to be one sentence rather than two that have to be kept
	 * agreeing.
	 */
	const ingestSentence = $derived.by((): string => {
		const ingest = session.ingest;
		if (!ingest) return '';
		const label = session.ingestLabel;
		switch (ingest.phase) {
			case 'inspecting':
				return `Reading ${label}…`;
			case 'opening':
				return `Opening ${label}…`;
			case 'tiling':
				return `Preparing ${label}: tile ${ingest.tilesWritten} of ${ingest.tileCount}`;
			case 'finishing':
				return `Finishing ${label}…`;
			case 'done':
				return `Added ${label}`;
		}
	});
</script>

<!--
	Escape abandons a part-drawn shape from anywhere on the screen, and then clears the Annotation
	selection — which takes the Inspector off the map with it. **In that order**, because a gesture in
	progress is what somebody pressing Escape almost always means, and the selection is what is left when
	there is no gesture to abandon.

	On the window rather than on the pane, for the reason ADR-0022 gives for the pending Control Point
	half: the user may have tabbed away to the toolbar or the Annotation list, and "Escape only works if
	you have not moved the focus" is not a cancel affordance. It abandons rather than commits, because a
	half-drawn shape somebody walked away from is not something they asked to keep.

	**Not while a dialog or the Inspector's own fields have the keypress.** Each consumes Escape itself —
	a `<dialog>` closes and the Inspector's title field leaves itself — and each keeps the keypress
	propagating afterwards, so acting on it here as well would abandon a drawing gesture the user cannot
	even see, or take away the panel they were typing in.
-->
<svelte:window
	onkeydown={(event) => {
		if (event.key !== 'Escape' || settingsOpen || addingMap) return;
		// An open dialog is asked of the document rather than mirrored in flags.
		// An open `<dialog>` is asked of the document because this screen mounts dialogs it holds no
		// flag for — `MakeOfflineDialog` and `OfflineCopyDialog` — and a list of flags is a list that
		// the next dialog silently fails to join. Escape's close request is the keypress's *default
		// action*, so the element is still open while this handler runs.
		//
		// And an Escape from **anywhere inside the Annotation Inspector** belongs to the Inspector — the
		// whole region, not only the fields in it. The title input treats it as "leave this field"; the
		// description, the tab strip, the swatches, the sliders and *Delete* treat it as nothing at all,
		// which is the right answer for a control whose own Escape means nothing: taking the panel off the
		// map is far more than the keypress asked for, and the way out of the panel is *Dismiss* or an
		// Escape from the row. That reach is the one the in-row contents region had while an Annotation was
		// read inside its row, so it is unchanged rather than widened. The panel is found by its own id
		// rather than by asking it to stop propagating — the ordering of Escape's jobs on this screen is
		// this handler's to know — and the row in the sidebar is deliberately outside it, so Escape with
		// the row itself focused still deselects.
		if (document.querySelector('dialog[open]') !== null) return;
		// And an Escape that only closed the Base Map Options panel is not an Escape for the drawing
		// behind it. Asked of the element rather than of a flag, for the reason `MenuPopover.isOpen`
		// documents: the `toggle` event lands and Svelte flushes on its own schedule, so a flag would
		// still say "open" for the *next* Escape and decline the cancel the user actually asked for.
		if (baseMapOptionsMenu?.isOpen() === true) return;
		const inspector = document.getElementById(ANNOTATION_INSPECTOR_ID);
		if (inspector !== null && event.target instanceof Node && inspector.contains(event.target))
			return;
		if (drawing.cancel()) return;
		if (annotations.selectedAnnotationId !== null) annotations.selectAnnotation(null);
	}}
/>

{#if recovering}
	<div class="m-4">
		<WorkspaceRecovery {storage} />
		<p class="mt-6"><a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a></p>
	</div>
{:else if session.projectProblem}
	<!--
		⚠ **Assertive, unless the route is already saying something above it.** A `?p=` naming a Project
		this Workspace has not got is ordinarily a dead end and an alert is right for it. But a Reader
		following "Review this Project in Ballastella" lands on exactly that screen *with the offer to
		fetch it rendered above* — and an assertive region interrupts a polite one whatever the DOM
		order, so a screen-reader user heard the error before the invitation that answers it. Polite
		here puts the two announcements in the order they are read in.
	-->
	<div
		role={offerAbove ? undefined : 'alert'}
		aria-live={offerAbove ? 'polite' : undefined}
		data-testid="project-problem"
		class="m-4 alert flex-col items-start alert-warning"
	>
		<h2 class="font-semibold">
			{session.projectProblem.kind === 'missing'
				? 'Project not found'
				: 'This Project cannot be opened'}
		</h2>
		<p>{session.projectProblem.message}</p>
		<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
	</div>
{:else if session.openProject && resolution}
	<!--
		`lg:h-full`, and the root layout is what gives it a full screen to be `h-full` of. The map is the
		thing the scholar is studying, so it gets the height the bar does not take —
		computed by the layout rather than by arithmetic on a `calc()` that goes wrong the moment the
		bar wraps to two lines.

		⚠ **Only from `lg`.** Below it the two columns stack (see the container further down), and a
		screen pinned to the viewport's height would then have to squeeze both of them into it. The
		stacked screen is as tall as its own content and the route's own scroller — the `min-h-0 grow
		overflow-y-auto` box in `routes/+layout.svelte` — is what scrolls it, which is what "an ordinary
		block in a page that scrolls as a whole" means here.
	-->
	<div class="flex min-h-0 flex-col lg:h-full" data-testid="project-screen">
		<!--
			`relative` establishes the containing block the leader's own layer is `inset-0` of — it spans
			the sidebar and the map together, which is the whole reason it is a child of this element
			rather than of either column. Nothing else here positions itself against it.
		-->
		<!--
			┌───────────────────────────────────────────────────────────────────────────────────────────┐
			│ TWO COLUMNS FROM `lg`, A STACK BELOW IT — AND `lg` IS NOT THIS SCREEN'S OWN NUMBER.        │
			└───────────────────────────────────────────────────────────────────────────────────────────┘
			It is the one the viewer's Project grid and the alignment route's panes already use, adopted
			rather than chosen so that both applications stack at the same width: one width to learn, and
			`leaderPath`'s refusal on a stacked layout then begins in both at the same place.

			**The map column is first in the DOM, so stacked the map sits above the Layer stack**, which
			becomes an ordinary block in a page that scrolls as a whole. The map is first because the
			Inspector is a sheet *over the map*: with the stack first, a 390 px phone puts the pane — and so
			the sheet a tap on a mark opens — about 428 px down a 739 px scroller, which leaves the panel
			describing the selection to be scrolled to. Measured at 390 × 844.

			⚠ **`lg:order-first` on the sidebar, so above this width visual order and DOM order differ.**
			That is the cost, and it is real: a keyboard user at the wide width tabs the map column before
			the sidebar that sits to its left. The alignment route avoided `order` by putting its sidebar on
			the right of its panes instead — see the note above its own container — and that route is worth
			reading before changing this one. Moving *this* sidebar across the screen on a desktop was
			judged the larger harm, so `order` is the accepted cost here.
		-->
		<div class="relative flex min-h-0 grow flex-col lg:flex-row">
			<!--
				No `relative` here: nothing in this subtree positions itself against a containing block of
				its own, and MapLibre's own container carries `position: relative` from `maplibre-gl.css`.
			-->
			<div class="flex min-h-0 grow flex-col">
				{#if !installedApp.online}
					<!--
						Both notices in this block come and go with the connection, so both are `alert`s —
						`MapNotice` makes that choice from `shape`, and its header records why an `aria-live`
						region inside an `{#if}` is a notice a screen-reader user never hears.

						`variant="info"` because nothing is broken: everything in the Workspace still works.
					-->
					<MapNotice
						shape="comes-and-goes"
						variant="info"
						class="m-2"
						heading="The Base Map needs a connection"
						testid="base-map-offline"
					>
						<p>
							There is no network connection, so the Base Map cannot load yet. Everything in your
							Workspace still works: you can add a Map Image now and place it when the connection is
							back.
						</p>
					</MapNotice>

					{#if referencedLayers.length > 0}
						<!--
							The one honest exception to the offline claim, said rather than left as a blank pane.
							Naming the host is the whole point: "this Map Image is not here" is unactionable,
							and "nothing can be fetched from gallica.bnf.fr while you are offline" tells an author
							both why and what to do about it before their next trip to the archive.
						-->
						<MapNotice shape="comes-and-goes" class="m-2" testid="referenced-offline">
							<p>
								There is no connection, so nothing can be fetched from {unreachableHosts.join(
									', '
								)}. These Map Images stay blank until there is one. Everything else in this Project
								— its own Map Images, its Alignments, and its Annotations — is unaffected and still
								saves.
							</p>
						</MapNotice>
					{/if}
				{/if}

				<!--
					The archive answered nothing while the connection is fine. It comes and goes with the
					outage, so it is an `alert` and it is not on the page at all while the archive is
					answering; `MapNotice` decides both from `shape` and renders nothing for an empty sentence.

					It is the same alert whether the Base Map is remote or this site's own; what differs is
					the remedy, and that is `baseMapUnavailableNotice`'s to decide rather than the template's,
					so the two deployments cannot drift into saying different things.
				-->
				<MapNotice
					shape="comes-and-goes"
					class="m-2"
					heading="The Base Map did not load"
					testid="base-map-unavailable"
					text={unavailableNotice}
				/>

				<!--
					A Map Image in this Project stopped drawing. The same alert, the same heading and the
					same sentence the Published Site shows a Reader, because it is the same outage: the
					shim that met the refusal is `core`'s, and so is the wording.

					**Deliberately not gated on being online**, unlike the Base Map's notice above, and the
					difference is in the sentence rather than an oversight: that one claims the failing
					server is at fault, which is a falsehood to hand somebody whose wifi is off, while the
					`no-answer` row here says explicitly that it cannot tell the two apart.

					This is also the whole account of an unavailable Map Snapshot for this cause. The
					snapshot control stays disabled while it is up and says nothing of its own — one clear
					account of the underlying problem rather than two.
				-->
				<MapNotice
					shape="comes-and-goes"
					class="m-2"
					heading="A Map Image stopped drawing"
					testid="map-image-tiles-unavailable"
					text={tilesUnavailable}
				/>

				<!--
					⚠ **A height of its own below `lg`, because there is no longer a screen's worth to take
					a share of.** Stacked, this box's parent is as tall as its content, so `grow` alone
					resolves against nothing and the pane collapses to zero — which is the same failure as
					the fixed 24 rem sidebar taking the window, one column over.

					`26rem` rather than a viewport fraction: a fraction of a phone in landscape is a pane
					too short to hold the Inspector's sheet and its identity header and tab strip together,
					and the answer to a display too short for that is the page scrolling rather than the
					pane squeezing further — the floor the alignment route's panes already argue for.
				-->
				<div
					bind:this={mapColumn}
					class="h-[26rem] shrink-0 overflow-hidden lg:h-auto lg:min-h-0 lg:grow"
					data-testid="project-map"
				>
					<BaseMapPane
						bind:this={baseMapPane}
						selectedAnnotationId={annotations.selectedAnnotationId}
						entryId={resolution.entry.id}
						{appearance}
						{borders}
						{borderStyle}
						{cachedBaseMap}
						layers={drawn}
						annotationDragPreview={annotations.dragPreview}
						{openingFit}
						overlayPoints={annotations.annotationPoints}
						{fetchTile}
						onbasemapstatus={(status) => {
							baseMapStatus = status;
							// Without the Base Map there is no frame to capture at all, and the notice above
							// is the account of it — there is no second one about the snapshot.
							onSnapshotEvent({ kind: 'base-map-assets', failed: status === 'unavailable' });
						}}
						snapshotGeneration={snapshot.generation}
						oninvalidateframe={(by) => onSnapshotEvent({ kind: 'frame-invalidated', by })}
						onframesettled={(generation) => onSnapshotEvent({ kind: 'frame-settled', generation })}
						overlayDocked={inspectorDock !== undefined}
						onclickpoint={(point) => void annotations.placePoint(point)}
						onclickannotation={(hit) => {
							// Only when nothing is being drawn: with a tool in hand the click places a vertex,
							// and the Annotation underneath is not what the user is pointing at.
							if (drawing.tool !== 'select') return;
							// **Opens that Layer's card and the Annotation's own row**, which is where an
							// Annotation is read — so a click on the canvas is answered in the sidebar
							// rather than by a bubble over the shape it is describing.
							// `openFromMap` rather than `openLayer`, which clears the selection — and a
							// selection is precisely what this is making. Nothing is part-drawn here: the
							// guard above is that guarantee.
							annotations.openFromMap(hit.layerId, hit.annotationId);
						}}
						onfinishshape={() => void annotations.finishShape()}
						onstack={(reported) => (rendered = reported)}
						controls={mapControls}
						overlay={mapOverlay}
					/>
				</div>

				<!--
					The map's running commentary, announced but not drawn, from the component both apps
					render. Sighted authors read the same facts off the map itself and off the "Make
					available offline" button above, which is only offered while something in this Project
					still is not offline — so on screen this was four lines of restatement eating the Base
					Map's vertical space.

					The two lines below are the editor's own: they are the ones a Reader is not given,
					because making an offline copy is one button away here and nowhere at all there.
				-->
				<MapCommentary
					layerCount={layers.length}
					{drawnCount}
					{openingOutcome}
					{refitted}
					{emptyStackNote}
				>
					<!--
						Whether this Project works with no network, in words. Visible text rather than a badge,
						and announced, because it is the fact a scholar checks before they travel — and because
						"available offline" is computed from the files each time this is read, so it can never
						be a label that outlived the tiles behind it.

						`data-offline` carries the three states the sentence distinguishes: `yes`, `no`, and
						`unknown` for a Base Map that could not be reached to be asked about.
					-->
					<p
						class="min-h-6 text-sm text-base-content/70"
						aria-live="polite"
						aria-atomic="true"
						data-testid="offline-availability"
						data-offline={offlineReady === null ? 'unknown' : offlineReady ? 'yes' : 'no'}
						data-cache-serving={cachedBaseMap === null ? 'no' : 'yes'}
					>
						{offlineSummary}
					</p>
					<!--
						Held outside the dialog's own tree so its completion announcement survives the dialog
						closing — the same reason `OfflineCopyJob.completed` lives on the job.
					-->
					<p
						class="min-h-6 text-sm"
						aria-live="polite"
						aria-atomic="true"
						data-testid="offline-done"
					>
						{offline.completed}
					</p>
				</MapCommentary>
			</div>

			<!--
				From `lg` the sidebar is a **fixed column** and the map takes what is left, which is the
				whole of "the map gets the larger share of the screen": a proportional sidebar grows with
				the display, and on a large one that is a wall of controls beside a map that gained
				nothing. Below `lg` there is no column to be fixed: it is a block the width of the screen,
				scrolling with the page rather than inside itself, and the border that separated it from
				the map moves to the edge that now faces the map.

				**`base-300`, so that the Layer cards on it are objects.** A card is `base-100`, and
				daisyUI's scale runs in opposite directions in the two themes — 100% → 98% → 95% in light,
				25% → 23% → 21% in dark — so a `base-100` card on a deeper base is the lighter surface in
				both. This column and the cards used to be the same `base-100` with a `base-300` hairline
				between them, which is invisible in the light theme and, in the dark one, a border darker
				than either surface: the boundary read as a smudge rather than an edge, and the cards were
				reported as hard to tell apart in both themes.

				`base-300` rather than `base-200`, measured rather than chosen: `base-200` puts a
				1.06:1 luminance step between column and card in both themes and `base-300` puts 1.16:1 in
				light and 1.12:1 in dark. Neither is text contrast — a surface boundary is carried by the
				card's own border as well — but the stock light theme has 100% and 98% to work
				with, and half of what little there is was not worth keeping. The divider is an ink wash
				rather than `base-300`, which is now the column's own colour.

				See the note at the top of `LayerList.svelte`, which owns the other half of this.
			-->
			<div
				bind:this={layerSidebar}
				class="flex shrink-0 flex-col border-t border-base-content/10 bg-base-300 p-4 lg:order-first lg:w-96 lg:border-t-0 lg:border-r"
				data-testid="layer-sidebar"
			>
				<!--
					The scroller, so that the stack is the only thing that scrolls. From `lg` the rail is as
					tall as the screen and this box takes what the add-Layer pair below it does not, which is
					what keeps that pair on screen under a Project with a dozen Layers. `min-h-0` because a
					flex item will not shrink below its content without it, and an unshrunk box overflows the
					rail instead of scrolling inside it.

					⚠ **`lg:` on the overflow, and nothing below it.** Below `lg` the rail is an ordinary block
					in the route layout's own scroller (`routes/+layout.svelte`), and a second scroller here
					would trap the stack in a box inside a page that already scrolls.
				-->
				<div
					bind:this={layerScroller}
					class="min-h-0 grow lg:overflow-y-auto"
					data-testid="layer-scroller"
				>
					<LayerList
						{layers}
						{outcomes}
						openLayerId={annotations.openLayerId}
						onopen={(id) => annotations.openLayer(id)}
						ontypename={(id, name) => session.typeLayerName(id, name)}
						oncommit={() => session.commitLayerEdit()}
						onshow={(id, visible) => session.showLayer(id, visible)}
						ondragopacity={(id, opacity) => session.dragLayerOpacity(id, opacity)}
						onmove={(id, toIndex) => session.moveLayerTo(id, toIndex)}
						ondropannotation={(annotationId, layerId) =>
							void annotations.moveAnnotationToLayer(annotationId, layerId)}
						ondelete={(id) => (deletingLayerId = id)}
						{noLayersGuidance}
						{foreignLayerNote}
						preparing={session.ingest ? preparingLayer : undefined}
						{mapContents}
						problemAction={layerProblemAction}
						{annotationContents}
					/>

					{#if annotations.annotationLayerCount === 0}
						<!--
							What to do when there is nothing to draw into yet, beside the button that fixes it.

							**The guidance sits beside the affordance that answers it, not in the toolbar.** The
							toolbar lives inside an open Annotation Layer's row, so with no Annotation Layer there
							is no toolbar to carry it — and an announcement that disappears with the state it
							described is fine, while guidance that disappears with it is an accessibility
							regression.
						-->
						<p class="mt-2 max-w-prose text-sm" data-testid="no-annotation-layers">
							No Annotation Layers yet. Add one, then open it to draw: its pins, lines, and shapes
							are kept in one GeoJSON file that opens in other mapping tools.
						</p>
					{/if}

					<!--
						Why an Annotation did not move into the Layer it was dropped on. `aria-live="polite"` is
						ADR-0016's mandated method for a status, and it is here rather than on the navigation bar
						because the refusal is this screen's knowledge: only the thing holding the stack can say
						that a target Layer's file would not read.
					-->
					<p
						class="mt-2 max-w-prose text-sm text-warning"
						aria-live="polite"
						aria-atomic="true"
						data-testid="annotation-move-refused"
					>
						{annotations.moveRefusal}
					</p>

					<!--
						And where one that did move went. Announced rather than drawn, because the screen already
						shows it: the target Layer opens with the Annotation selected in it. What a screen-reader
						user gets from that is a stack that has silently rearranged itself, which is the same
						problem the Layer stack's own move announcement solves.
					-->
					<p class="sr-only" aria-live="polite" aria-atomic="true" data-testid="annotation-moved">
						{annotations.moveNotice}
					</p>

					<!--
						What the preparation in the stack is doing, announced.

						─────────────────────────────────────────────────────────────────────────────────────────
						WHY THE ANNOUNCEMENT IS HERE AND THE PROGRESS IS ON THE CARD

						`aria-live="polite"` with `aria-atomic="true"` rather than `role="status"`, and the reason
						is unchanged from where this used to live: the save indicator already owns `status` for the
						whole app, so a second one makes `getByRole('status')` ambiguous — which is a hint that a
						screen-reader user would have to disambiguate too. `aria-atomic` so each update is read as
						a whole sentence rather than as the digits that changed.

						**Always rendered, which is what makes it work.** A live region is announced when its text
						*changes*, not when the element carrying it is inserted — the same rule this file states at
						length for `base-map-offline`, which is an `alert` for exactly that reason. The Layer's
						card is inserted with its text already in it, so a live region inside the card would be an
						announcement a screen-reader user never hears. So the card carries the visible sentence and
						this carries the announced one, they are the same string ({@link ingestSentence}), and this
						one is `sr-only` because the card is already showing it.
					-->
					<p
						class="sr-only"
						aria-live="polite"
						aria-atomic="true"
						data-testid="ingest-announcement"
					>
						{ingestSentence}
					</p>

					<!--
						Why an add did not happen, from either of the two sources that fail in the sidebar rather
						than in the dialog: a file that could not be tiled, and a second file picked while one was
						still running. `role="alert"` because this element is *inserted* when its text first exists,
						and an `aria-live` region is announced on a text change rather than on insertion.

						Here and not in the dialog because the dialog is closed by then: picking a file closes it, so
						the refusal has to land where the user is left. The "already in this Workspace" source fails
						with the dialog still open and says so there, beside the list that was clicked.
					-->
					{#if session.ingestError}
						<div role="alert" class="mt-4 alert max-w-prose alert-warning">
							<p>{session.ingestError}</p>
						</div>
					{/if}

					{#if mapLayers.length === 0 && session.ingest === null}
						<!--
							The Map Image empty state, beside the button that answers it. Derived from the Layers
							rather than from the Workspace's pyramids, which is the change ADR-0023 makes to what
							this sentence *means*: the Workspace may hold a dozen Map Images and this Project draw
							none of them, and "you have no maps" would be false while "this Project has none" stays
							true. It is also what says a cancelled or refused preparation left the Project exactly
							as it was.

							**And it names the third source, which would otherwise go unsaid.** A Map Image whose
							starter Alignment could not be written arrives with its pyramid and without its Layer
							(ADR-0023 writes the Alignment first on purpose); `session.ingestError` says so while it
							is on screen and `open()` clears it, so after a reload this sentence is the only thing
							left — and naming two sources would describe a Workspace that is not empty as if it
							were. The pyramid is offered by the "already in this Workspace" source, and adding it
							from there is what writes the Alignment that failed — so the useful next action is
							available rather than merely described.
						-->
						<p class="mt-4 max-w-prose text-sm" data-testid="no-map-images">
							This Project has no Map Images yet. Press Add a Map Image to add one.
						</p>
					{/if}

					<!--
						The outcome of a copy, announced from out here rather than from inside the dialog: the
						dialog closes on success, and an announcement added to a subtree that is removed in the
						same frame is indistinguishable from one that never happened.
					-->
					<p
						class="mt-4 min-h-6 text-sm"
						aria-live="polite"
						aria-atomic="true"
						data-testid="offline-copy-done"
					>
						{offlineCopy.completed}
					</p>

					<!--
						What an add had to say for itself after its dialog closed, out here for exactly the reason
						stated above it. Always rendered so that its text *changing* is what a screen reader
						hears; `alert-info` when there is something, because the add succeeded and nothing is
						broken — what did not happen is one thing the user asked for, and it is said in the
						words `add-remote-map.svelte.ts` chose for it.
					-->
					<p
						class="mt-2 min-h-6 max-w-prose text-sm"
						aria-live="polite"
						aria-atomic="true"
						data-testid="remote-notice"
					>
						{addNotice}
					</p>

					{#if session.referencedImageErrors.length > 0}
						<div role="alert" class="mt-4 alert max-w-prose flex-col items-start alert-warning">
							{#each session.referencedImageErrors as failure (failure.imageId)}
								<p>{failure.reason}</p>
							{/each}
						</div>
					{/if}
				</div>

				<!--
					The one way a Map Image gets into this Project, beside the one way an Annotation Layer
					gets in. What the first opens offers all three sources at once — a file, a library, and a
					map this Workspace already holds — which is why it is one affordance rather than three
					sections competing for a 24rem column.

					**The plus carries the verb; the words carry the noun**, never an icon alone. `aria-label`
					restores the whole sentence for anyone who hears the button rather than seeing it, and each
					one *contains* the visible words — "Add a **Map Image**" — so a voice user who says what
					they read still hits the button (WCAG 2.5.3).

					**Pinned: the rail's last child, `shrink-0`, outside the scroller above.** Everything else
					in this column belongs to the stack or reports on it, so it scrolls with the stack; these
					two are the only way to add to it, and inside the scroller a Project with a dozen Layers
					put them off the bottom. `shrink-0` because the pair is what the scroller yields height to,
					not the other way round.
				-->
				<div class="mt-4 flex shrink-0 gap-2">
					<button
						class="btn flex-1 gap-1 btn-sm {KIND_STYLE.map.btn}"
						type="button"
						data-testid="add-map-image"
						aria-label="Add a Map Image"
						onclick={() => (addingMap = true)}
					>
						<Plus class="size-4" aria-hidden="true" />
						Map Image
					</button>

					<button
						class="btn flex-1 gap-1 btn-sm {KIND_STYLE.annotation.btn}"
						type="button"
						data-testid="add-annotation-layer"
						aria-label="Add an Annotation Layer"
						onclick={() =>
							session.addAnnotationLayer(`Annotations ${annotations.annotationLayerCount + 1}`)}
					>
						<Plus class="size-4" aria-hidden="true" />
						Annotation Layer
					</button>
				</div>
			</div>

			<!--
				The leader, last so that it paints over both columns.

				⚠ **Nothing about which Annotation is active depends on it.** The row's `aria-expanded` says
				which one is open and the map draws it more strongly, so this adds no fact —
				which is why it is `aria-hidden`, takes no pointer events, and is simply not drawn when
				either end has left its own column.
			-->
			<LeaderLine
				mark={selectedMark}
				row={selectedRow}
				canvas={() => mapColumn}
				sidebar={() => layerScroller}
				watch={(redraw) => baseMapPane?.onCameraMove(redraw) ?? (() => {})}
			/>
		</div>
	</div>

	<!--
		ADR-0025's dialog, **outside `project-screen` on purpose**, for the reason every dialog this
		screen raises is. daisyUI's `.modal` keeps a closed `<dialog>` laid out — it has a box, it is
		merely transparent — so its buttons answer a `querySelectorAll` of visible controls while being
		unreachable by keyboard. Inside the subtree it made `editor-project-screen.e2e.ts`'s tab walk
		fail on "Not now" and "Count again"; a modal's whole point is that one tab order cannot cover
		both it and the page behind it.
	-->
	<MakeOfflineDialog job={offline} entry={resolution.entry} {layers} />

	<!--
		The three sources a Map Image comes from. **Outside `project-screen` for the reason stated
		above** — a closed daisyUI modal is laid out, so every control in it would answer the tab
		walk's `querySelectorAll` while being unreachable by keyboard.
	-->
	<AddMapImage {session} bind:open={addingMap} onnotice={(notice) => (addNotice = notice)} />

	<!--
		Project settings: the Project's name, last-saved time, and the secondary Base Map
		offline action. A dialog rather than a page keeps those occasional tasks out of the map
		workspace.
	-->
	<ModalDialog bind:open={settingsOpen} title="Project settings" wide>
		<div class="flex flex-col divide-y divide-rule">
			<section class="flex flex-col items-start gap-3 pb-6">
				<h3 class="font-serif text-lg">Project details</h3>

				<!--
					`onchange` and `onblur` both mean "the edit is over" (ADR-0017 rule 1). Neither writes on
					its own: `commitProjectName` is a no-op unless there is a pending write, because tabbing
					into and out of this field must not rewrite `project.json` — the write stamps a fresh
					`updatedAt`, and ADR-0010 is explicit that merely looking at an old Project must not modify
					files.
				-->
				<label class="flex w-full flex-col gap-1">
					<span class="text-sm font-medium">Project name</span>
					<input
						class="input w-full"
						data-testid="project-name-input"
						value={session.openProject?.name ?? ''}
						oninput={(event) => session.typeProjectName(event.currentTarget.value)}
						onchange={() => session.commitProjectName()}
						onblur={() => session.commitProjectName()}
					/>
				</label>

				<dl class="flex w-full flex-col gap-3 text-sm">
					<div class="flex flex-col gap-1">
						<dt class="text-sm font-semibold opacity-70">Last saved</dt>
						<dd>
							<time
								class="tabular-nums"
								data-testid="project-updated-at"
								datetime={session.openProject.updatedAt}
								>{formatProjectUpdatedAt(session.openProject.updatedAt)}</time
							>
						</dd>
					</div>
				</dl>
			</section>

			<!--
				How the Project got here, when it got here from somewhere (ADR-0037).

				⚠ **Read-only, and it says why.** This is a record of transfers, not metadata an author
				maintains: there is no control in it, and the description separates it from attribution in
				words, because a list of accounts and filenames beside somebody's maps invites exactly that
				reading. Each entry carries whether Ballastella saw the transfer or was handed a record of
				one, so a claim nobody checked cannot pass for one this application witnessed.
			-->
			{#if provenance.length > 0}
				<section class="flex flex-col items-start gap-3 pt-6" data-testid="import-provenance">
					<h3 class="font-serif text-lg">How this Project got here</h3>
					<p class="max-w-prose text-sm opacity-70">
						A read-only record of the transfers that brought this Project into this Workspace. It
						does not say who made the work or who holds rights in it.
					</p>
					<ol class="flex w-full flex-col gap-3 text-sm">
						{#each provenance as entry, at (at)}
							<li
								class="flex flex-col gap-1 border-l-2 border-rule pl-3"
								data-testid="provenance-entry"
								data-provenance-kind={entry.kind}
								data-provenance-evidence={entry.evidence}
							>
								<p>{describeImportProvenance(entry)}</p>
								<p class="text-xs opacity-70">
									<span data-testid="provenance-evidence">{describeImportEvidence(entry)}</span>
									<time class="tabular-nums" datetime={entry.observedAt}
										>{formatProjectUpdatedAt(entry.observedAt)}</time
									>
								</p>
							</li>
						{/each}
					</ol>
				</section>
			{/if}

			<!--
				How this Project draws its borders (`BorderStyleFields`).

				**Here rather than beside the level switcher in the map controls.** The level is a claim
				an author toggles while looking at the map — is a modern national line part of this
				argument — and it belongs where the map is. How the line is *drawn* is settled once and
				then left alone, which is what this dialog is for, and three pickers in the pane's control
				row would cost a band of the map's height for a decision made twice.
			-->
			<section class="flex flex-col items-start gap-3 pt-6" data-testid="border-settings">
				<h3 class="font-serif text-lg">Borders</h3>
				<p class="max-w-prose text-sm opacity-70">
					How this Project draws administrative boundaries. Which boundaries it draws — none,
					national, or every division inside them — is chosen on the map itself.
				</p>
				<BorderStyleFields
					{borders}
					style={borderStyle}
					automatic={automaticBorderStyle(appearance, theme.current)}
					illegibleIn={borderStyle.color === null
						? []
						: bordersIllegibleThemes(appearance, borderStyle.color)}
					onchange={(patch, options) => void session.chooseBorderStyle(patch, options ?? {})}
					oncommit={() => void session.commitBorderStyle()}
				/>
			</section>

			<!--
				⚠ **The one place front-page membership is set, and the one place a Project's link is
				handed over** (ADR-0045). It was also offered as a list of every Project at the moment a
				site was created; two places to set one flag is how an author ends up unsure which one
				won, so that list is gone rather than hidden.
			-->
			<ProjectSharing
				name={session.openProject.name}
				directory={openDirectory}
				onFrontPage={session.openProject.onFrontPage}
				{shareLinks}
				link={shareLink}
				unsent={unsentWork}
				setOnFrontPage={(on) => session.setProjectOnFrontPage(openDirectory, on)}
				enableShareLinks={enableShareLinksHere}
				send={sendForShareLink}
			/>

			<section class="flex flex-col items-start gap-3 pt-6">
				<h3 class="font-serif text-lg">Base Map offline</h3>
				<p class="max-w-prose text-sm opacity-70">
					Store the Base Map tiles for this Project in this Workspace for use without a network
					connection.
				</p>
				<button
					type="button"
					class="btn btn-sm"
					data-testid="make-offline"
					onclick={() => void makeProjectOffline()}
				>
					Make this Project available offline
				</button>
			</section>
		</div>

		{#snippet actions()}
			<button type="button" class="btn btn-sm" onclick={() => (settingsOpen = false)}>Close</button>
		{/snippet}
	</ModalDialog>

	<!--
		A Layer delete takes an Annotation Layer's file with it, so it is asked before it is done rather
		than offered back afterwards. Undo can put both back, but only for as long as this Project stays
		open — the question is the durable protection, the undo is the convenience.
	-->
	<ModalDialog
		bind:open={() => deletingLayerId !== null, (open) => !open && (deletingLayerId = null)}
		title="Delete Layer"
	>
		<p>
			Delete <strong>{deletingLayer?.name || 'Untitled Layer'}</strong>? Its Annotations go with it.
			A Map Image stays in the Workspace and can be added again.
		</p>
		{#snippet actions()}
			<button type="button" class="btn" onclick={() => (deletingLayerId = null)}>Cancel</button>
			<button
				type="button"
				class="btn btn-error"
				data-testid="confirm-delete-layer"
				onclick={() => void confirmDeleteLayer()}>Delete Layer</button
			>
		{/snippet}
	</ModalDialog>
{:else}
	<p class="p-4">Opening Project “{openDirectory}”…</p>
{/if}

<!--
	What is inside a Map Image Layer, rendered by `LayerList` inside that Layer's open row: whether
	it is placed on the earth yet, the button that places it, and where its tiles are fetched from.

	**A snippet passed down rather than markup inside `LayerList`**, for one concrete reason: the Align
	link has to be spelled `{resolve('/align')}?p=…&layer=…` at the point it is written, because
	`svelte/no-navigation-without-resolve` reads the first part of an `href` literally and a string
	computed elsewhere and passed in is not the shape it recognises. Keeping it here also keeps
	`LayerList` about the stack rather than about routes and about somebody else's IIIF server.

	**A link, not a button.** The route is keyed by Layer id and a Map Image in a Project has had
	its Layer since it was added (ADR-0023), so there is nothing to resolve on the way — an earlier
	shape pressed a button that created the Layer and then navigated, which meant a disabled control
	across a store read and a Workspace-shared `alignments/<id>.json` written to do it.

	**"Not aligned yet" is said here *and* on the closed row**, which is not a duplication that could
	drift: one sentence, `NOT_ALIGNED`, and one predicate, `notAligned`. The closed row has to carry it
	because "this map needs aligning" is the state a scholar has to be able to notice without opening
	anything; the open row carries it because it is the sentence the Align button beside it answers. On
	the closed row it now answers itself too — see `layerProblemAction`, which puts an "Align now"
	beside that sentence so noticing and acting are the same gesture.
	Nothing here says the opposite when a map *is* aligned — the Align button is that affordance either
	way, and an unrequested "Aligned" line was the first cut's other mistake.
-->
{#snippet noLayersGuidance()}
	<!--
		What an empty stack tells a scholar, and **it names the two buttons that are actually there**.
		"Add a Map Image" and "Add an Annotation Layer" are the words on the controls below the stack,
		not a description of them: guidance that names something the user then has to translate into
		what is on screen is guidance they have to solve first.

		**Here rather than in `LayerList`, because it is instructions for this screen's own controls.**
		The published viewer renders the same stack and has neither button and no Workspace, so a Reader
		who opened a Project with nothing on it was being sent to look for a control that does not exist.
		`LayerList` keeps the half that is true in both apps — that there are no Layers — and this is the
		half that is only true here.
	-->
	No Layers yet. Press <strong>Add a Map Image</strong> to bring one in — from a file, from a
	library, or from one this Workspace already holds — and it appears here straight away, aligned or
	not. <strong>Add an Annotation Layer</strong> is for whenever you have something to say over it.
{/snippet}

{#snippet emptyStackNote()}
	<!--
		What the commentary says when the Project has no Layers at all, **in this app**. The "yet" is
		the whole of why this is the editor's own sentence and not the shared component's: it invites
		the one thing an author can do about it, and a Reader has nothing to add.
	-->
	Nothing is on the map yet.
{/snippet}

{#snippet foreignLayerNote()}
	<!--
		What becomes of a Layer this build cannot draw, **in this app** (ADR-0014). The card says there is
		nothing to show and nothing drawn, which is true anywhere; this is the half that is only true
		where there is a Workspace to write back to and a pencil, a toggle and two arrows to do it with.
		A published site promises none of it, so a Reader is told none of it.
	-->
	It is kept exactly as it was found and written back untouched, and you can still rename it, hide it,
	and move it in the stack.
{/snippet}

{#snippet preparingLayer()}
	<!--
		The Map Image being prepared, as its own card at the top of the stack.

		─────────────────────────────────────────────────────────────────────────────────────────
		WHY THIS LAYER IS NOT IN `project.json` YET, AND WHY THAT IS THE POINT

		A Layer has to appear first and report its own preparation, and cancelling has to remove it. The
		obvious way to build that is to write the Layer into `project.json` at the start and delete it
		at the end if the user cancels — and that reintroduces a dangling reference by another door: for
		the minutes a gigapixel scan takes, the Project on disk holds a map Layer whose pyramid and
		whose `alignments/<id>.json` do not exist, which is a Project `assertReferencesPresent` refuses
		and this build would export and then decline to import. Close the tab in that window and the
		Layer is permanent, because the code that would have removed it is gone with the page. ADR-0023's write order — Alignment first, `project.json`
		last — exists precisely to keep that state off the disk.

		So the card is the Layer *before it is a Layer*: it is in the stack, at the position the row
		will take, carrying the name of the file and the way to stop it. Cancelling removes it because
		nothing was written; the requirement is met by construction rather than by a cleanup path that
		has to run. What is given up is a rename or a reorder during the preparation, which are edits
		to a document the map is not in yet.
	-->
	{#if session.ingest}
		{@const ingest = session.ingest}
		<div class="flex flex-col gap-2">
			<div class="flex flex-wrap items-baseline gap-2">
				<span class="font-medium" data-testid="preparing-layer-name">{session.ingestLabel}</span>
				<span class="text-sm opacity-70">Map Image</span>
			</div>

			<!--
				The same sentence the live region announces, drawn where the eye is: visible text, never a
				tooltip. `ingestSentence` is the one source of it — see the region below the stack for why
				the announcement cannot live inside this card.
			-->
			<p class="text-sm" data-testid="preparing-layer-status">{ingestSentence}</p>

			<progress
				class="progress w-full"
				value={ingest.fraction}
				max="1"
				aria-label="Preparing {session.ingestLabel}"
			></progress>

			<!--
				A real button, beside the bar and reachable by tab. A gigapixel scan is thousands of tiles
				and several minutes; picking the wrong file and having no way out of it is the failure this
				button exists to prevent, and `ingest.ts` is what supports the cancel it calls. Named for
				what it cancels rather than "Cancel", which tells a screen-reader user nothing when it is
				one of several buttons on the page (ADR-0016).
			-->
			<div>
				<button
					type="button"
					class="btn btn-sm"
					aria-label="Cancel preparing {session.ingestLabel}"
					onclick={() => session.cancelIngest()}
					disabled={ingest.phase === 'done'}
				>
					Cancel
				</button>
			</div>
		</div>
	{/if}
{/snippet}

<!--
	The link that opens the align route for one Map Image Layer, written **once** and rendered
	from both places that offer it: inside the open row, and beside "not aligned yet" on the closed one.

	One snippet rather than two `<a>` elements, because the href is the part that can be wrong in a way
	nobody notices — it carries a Project directory and a Layer id that have to be true *together*, for
	the reason below — and two copies of it are two chances to fix only one of them.

	**`session.openDirectory`, not the `?p=` prop**, and the difference is a real window rather than a
	style preference. `open()` clears `openProject` and sets its own directory, so between a navigation
	to another Project and that call the URL names the new folder while the Layers on screen are still
	the old Project's — which is exactly why the opening-fit effect above compares the two. Built from
	the prop, this link would spend that window naming the *new* directory with the *old* Project's
	Layer id: a pair that has never been true together. The align route refuses an unknown `?layer=`
	and says so, so the cost is a wrong explanation rather than a wrong map, but the pair the link
	carries has to come from one source.

	The label and the test id are given by the caller because the two are not the same affordance: one
	is the row's own action, the other is the answer to a sentence a few characters to its left, and a
	single id on both would make every `getByTestId('align-map-image')` in the suite ambiguous.

	**The Map Image's own colour, not `primary`.** Both places this is rendered are inside a map
	Layer's card — the open card and the problem band on the closed one — and a card's buttons are the
	card's colour, so that a control in a card belongs to the Layer above it rather than to the app
	(`layer-kind-style.ts` argues the whole arrangement). It is `KIND_STYLE.map` unconditionally rather
	than keyed off `layer.kind` because both call sites are already inside a `kind === 'map'` guard.
-->
{#snippet alignLink(layer: Layer, testid: string, label: string)}
	<a
		class="btn btn-xs {KIND_STYLE.map.btn}"
		data-testid={testid}
		href="{resolve('/align')}?p={encodeURIComponent(
			session.openDirectory ?? ''
		)}&layer={encodeURIComponent(layer.id)}"
	>
		{label}
	</a>
{/snippet}

<!--
	What can be done about what a **closed** row is warning about — which, of the refusals a Layer can
	report, is this one: a Map Image that has not been aligned yet is answered by aligning it.

	The closed row carries "not aligned yet" so that a scholar can notice it without opening anything,
	and the sentence names its own next action rather than leaving the control it describes one
	disclosure away — the rule the empty sidebar's guidance follows, applied to a Layer.

	**Only the not-aligned refusal, tested the same way the open row tests it** — on the *reported*
	outcome rather than on `notAligned`, because that is where the precedence between the three
	refusals lives and an Alignment that is there and unreadable is a different failure that would
	otherwise be offered this one's cure. See `mapContents` below for the whole of that argument. The
	other refusals get no button here: an Annotation Layer with nothing in it is answered by drawing,
	which is what opening the row is for.
-->
{#snippet layerProblemAction(layer: Layer)}
	{@const reported = outcomes[layer.id]}
	{#if layer.kind === 'map' && reported?.status === 'refused' && reported.reason === NOT_ALIGNED}
		{@render alignLink(layer, 'align-map-image-now', 'Align now')}
	{/if}
{/snippet}

{#snippet mapContents(layer: MapLayer)}
	{@const origin = originFor(layer)}
	{@const referenced = referencedImageIds.has(layer.imageId)}
	{@const reported = outcomes[layer.id]}
	<div class="flex flex-col gap-2">
		{#if reported?.status === 'refused' && reported.reason === NOT_ALIGNED}
			<!--
				A colour **and** a sentence, because a class reaches nobody: a screen reader is told nothing
				by `text-warning`, so the state has to be in the accessibility tree as text or it is not
				information at all. Every other state that warns follows the same rule, with an element and
				an id of its own.

				─────────────────────────────────────────────────────────────────────────────────────────
				AN ELEMENT MAY ONLY EVER SAY THE THING ITS ID NAMES

				The first cut rendered `outcome.reason` for *any* `refused` outcome under an id reading
				"alignment state", so an Alignment file that was there and unreadable was announced as a map
				that merely needed aligning — a different failure wearing this one's label.

				Narrowing to {@link notAligned} was not enough, and the reason is worth keeping: a Layer
				whose Alignment could not be read has **no document**, and `notAligned` counts a missing
				document as not aligned. So the honest test is the *reported* outcome, which is where the
				precedence between the three already lives — `outcomes` puts an unreadable file above both
				the renderer's refusal and this one, "because it is the only one of the three that means
				work the user made is not on screen". Asking it here reuses that one rule rather than
				deriving a second answer beside it.

				No refusal is lost by the narrowing: the row above shows every one of them out of the same
				`outcomes`, under `layer-problem`, whose name claims nothing in particular.
			-->
			<p class="text-sm text-warning" data-testid="layer-not-aligned">{NOT_ALIGNED}</p>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<!-- The Layer's own Align, offered whatever its Alignment says — see `alignLink` above. -->
			{@render alignLink(layer, 'align-map-image', 'Align to base map')}
			<span
				class="text-xs"
				class:text-warning={referenced}
				class:text-success={!referenced}
				data-testid="layer-image-mode"
				data-image-mode={referenced ? 'referenced' : 'offline-copy'}
			>
				{referenced ? 'Source: External IIIF' : 'Source: Local'}
			</span>

			{#if referenced && origin}
				<!-- Where the tiles come from, on the Layer that fetches them. -->
				<span class="text-xs" data-testid="referenced-image-label"
					>{origin.label || origin.imageId}</span
				>
				<code class="text-xs opacity-70" data-testid="referenced-image-host"
					>{new URL(origin.service).hostname}</code
				>
				<OfflineCopyDialog image={origin} job={offlineCopy} />
			{:else if origin}
				<!--
					An offline copy, and the address it came from. Kept visible because making an offline copy
					keeps `remote.json` precisely so a copy can still be cited and traced back to the library
					it came from (ADR-0007), and a copy nobody can cite is a copy that has been orphaned.
				-->
				<span class="text-xs" data-testid="offline-copy-label"
					>{origin.label || origin.imageId}</span
				>
				<code class="text-xs break-all opacity-70" data-testid="offline-copy-source"
					>{origin.service}</code
				>
			{/if}
		</div>
	</div>
{/snippet}

<!--
	What is inside an Annotation Layer, rendered by `LayerList` inside that Layer's open row: the
	drawing tools and its Annotations. **Not the selected Annotation itself** — that is read in the
	Annotation Inspector over the map (ADR-0035), which is docked from this file because this file is
	where the pane is.

	**A snippet passed down rather than markup inside `LayerList`**, because everything it needs is
	reachable from here and from nowhere in the stack: the collection, the selection, the
	`AnnotationDrawing` instance and every function that writes are `annotations`' — this screen holds
	that one object. `LayerList` would otherwise take thirteen props it only forwards.

	**The Layer itself is no longer passed in.** It was handed over for its `defaultStyle`, and a Layer
	no longer has one (ADR-0009, as amended); the snippet still takes it because `LayerList` invokes it
	with the Layer whose row is open, and it is `annotations.activeLayer` — both come from
	`openLayerId`, which is where that identity is explained, in `annotation-editing.svelte.ts`.
-->
{#snippet annotationContents()}
	<AnnotationLayerContents
		collection={annotations.activeCollection}
		selectedId={annotations.selectedAnnotationId}
		tool={drawing.tool}
		picking={drawing.picking}
		status={drawing.status}
		drawing={drawing.drawing}
		canFinish={drawing.canFinish}
		onnew={() => drawing.offerShapes()}
		onchoosetool={(tool) => drawing.choose(tool)}
		onplace={(place, query) => void placeAtPlace(place, query)}
		onfinish={() => void annotations.finishShape()}
		oncancel={() => drawing.cancel()}
		onundovertex={() => drawing.undoVertex()}
		onselect={(id) => annotations.selectAnnotation(id)}
		onmove={(id, toIndex) => void annotations.moveAnnotationTo(id, toIndex)}
	/>
{/snippet}

<!--
	The Annotation Inspector's two faces, and the dock it sits in (ADR-0035).

	**Both faces are the editor's snippets, and the Style one is withheld rather than emptied.** An
	Annotation whose geometry this build cannot draw is passed no `style` at all, so it has no Style tab
	rather than a tab that opens on an explanation of its own emptiness — and the viewer withholds the
	same prop for the same effect, which is the whole of why a Reader has no tab strip.
-->
{#snippet inspectorText(annotation: Annotation)}
	<AnnotationTextFace
		{annotation}
		titling={annotation.id === annotations.titlingId}
		ontext={(text) => void annotations.typeText(text)}
		ontitled={() => (annotations.titlingId = null)}
		oncommit={() => void annotations.commitAnnotationEdit()}
		ondelete={() => void deleteSelectedAnnotation()}
		index={annotations.selectedIndex}
		count={annotations.activeCollection?.annotations.length ?? 0}
		moveTargets={annotations.moveTargets}
		onmove={(toIndex) => void annotations.moveAnnotationTo(annotation.id, toIndex)}
		onmovetolayer={(layerId) => void annotations.moveAnnotationToLayer(annotation.id, layerId)}
	/>
{/snippet}

{#snippet inspectorStyle(annotation: Annotation)}
	<AnnotationStyleFace
		{annotation}
		onstyle={(style, options) => void annotations.styleSelected(style, options)}
		onlinestyle={(line) => void annotations.lineStyleSelected(line)}
		oncommit={() => void annotations.commitAnnotationEdit()}
		onapplytoall={() => void annotations.applySelectedStyleToLayer()}
	/>
{/snippet}

<!--
	The Project's map controls are in the pane rather than in page chrome, so what works on the map is
	reachable without spending a row of its height. Two buttons beside the place search, which is what
	fits one line at every pane width — everything about the Base Map is behind the first of them.
-->
{#snippet mapControls()}
	<div class="flex flex-wrap items-center gap-2">
		<!--
			Everything about the Base Map behind one button (ADR-0020): which tiles, where the deployment
			offers a choice; how they are drawn; and which borders this Project asserts. All three write
			`project.json`, because all three are the author's and travel to the Published Site — and the
			row they used to sit in abreast was wider than the pane at most widths.
		-->
		<BaseMapOptions
			bind:this={baseMapOptionsMenu}
			entryId={resolution!.entry.id}
			catalog={BASE_MAP_CATALOG}
			showChevron={true}
			{appearance}
			{borders}
			onAppearance={(chosen) => void session.chooseBaseMapAppearance(chosen)}
			onSelectEntry={(id) => session.chooseBaseMap(id)}
			onBorders={(choice) => void session.chooseBorders(choice)}
		/>

		<!--
			ADR-0026's explicit control covers the reframing automatic fit deliberately does not do: after
			panning away, or after putting more of this Project on the earth.
		-->
		<button
			type="button"
			class="btn btn-sm"
			data-testid="fit-to-project"
			onclick={() => void fitToProject()}
		>
			<Scan size={16} aria-hidden="true" />
			Frame project
		</button>

		<!--
			The composed view, as an image the scholar can put in a figure. In the row rather than in
			page chrome for the reason everything else here is: it acts on the map, and a bar above the
			map would cost the map a line of its height at every width.
		-->
		<MapSnapshotButton
			ready={snapshotAvailability(snapshot).state === 'ready'}
			capturing={snapshot.capturing}
			captureFailed={snapshot.captureFailed}
			onclick={() => void downloadMapSnapshot()}
		/>
	</div>

	<!--
		Why the Base Map on screen is not the one the Project asked for (ADR-0020). Always present with
		an empty string when there is nothing to say, which makes it a live region a screen-reader user
		hears.
	-->
	<MapNotice
		shape="always-present"
		variant="plain"
		class="basis-full text-sm text-base-content/70"
		testid="base-map-notice"
		text={notice}
	/>
{/snippet}

<!--
	**Docked inside the Base Map pane's own positioned container**, which is what the pane's `overlay`
	snippet is for: top-right inset, a comfortable measure wide with a `max-width` so it cannot exceed a
	narrow pane, and the map still visible below it and beside it.

	⚠ **Below `lg` it is a sheet across the bottom of the pane instead**, because a panel docked to a
	corner has no corner to dock to on a phone. It is the same `AnnotationInspector` with the same
	props: where it sits is the consumer's, which is why the component takes no `variant` and sets no
	`position` of its own.

	⚠ **`bottom-[6.25rem]`, and the number is the pane's bottom furniture rather than a taste.** A sheet
	spanning the width crosses the whole of the pane's bottom edge, and two things live there: the
	attribution at the bottom-right, which is an ODbL condition, and **MapLibre's zoom control at the
	bottom-left, which is where the dock decision moved it precisely so that it could never be under the
	Inspector**. `z-index: 7` puts the sheet *over* both, so on a phone neither is reachable unless the
	sheet's own inset leaves them alone — measured at 390 × 844
	before this inset existed: the zoom-in button 100% covered, and `elementFromPoint` at its centre
	answering with a paragraph of the description. The bottom-left control block measures 97 px — three 29 px buttons plus
	MapLibre's own 10 px margin — so 6.25 rem clears it, and clears the 20 px attribution with it. One
	inset, both conditions; the desktop's `max-height` is the same rule read on the other axis.

	⚠ **`max-h-[60%]` rather than the desktop's near-full cap, because the sheet has to leave map above
	it that the camera can put the mark in.** `keepAnnotationClear` answers a sheet with a reservation on
	the y axis, and a reservation can only move a mark into pane the sheet is not on. Measured on the
	26 rem pane at 390 × 844: at 60% the sheet leaves 66 px above it and the mark lands 41 px clear; at
	the desktop's 70% it leaves 25 px, and the mark lands 8.8 px clear — inside the 16 px comfort margin
	that same function calls "behind the panel", so a mark it had just moved is one it would move again.
	A Pin, whose mark box is 30 px tall where a shape's anchor is a point, cannot be got clear at 70% at
	all. `BaseMapPane`'s `keepAnnotationClear` has the arithmetic. The cap is also what keeps the map
	visible above the sheet and what gives the face something to scroll inside.

	⚠ **The `max-height` is what keeps the Base Map's attribution clear.** The attribution is an ODbL
	condition rather than decoration, and it sits at the pane's
	bottom-right — under this panel's own column. 3 rem leaves room for it and for the panel's own 0.5 rem
	inset, so a long description scrolls inside the panel rather than the panel growing over the licence.

	⚠ **KNOWN LIMIT, above `lg` only: a short window clips the Style face out of the panel, and the tab
	strip stays pressable while it does.** The identity header and the tab strip are `shrink-0`, so once
	this cap falls below their combined height the face is what gives, and it gives all the way to
	nothing. Below `lg` the pane is a fixed `h-[26rem]`, so no phone reaches it; above `lg` the pane still
	tracks the window, and measured with the Style face open: 1024 × 340 leaves 19 px of face, 1024 × 300
	leaves −20 px clipped to zero with the Style tab still pressing, and 1024 × 260 clips the tab strip
	itself. Recorded rather than fixed because the repair is an open decision — a floor on the pane's
	height, or a face that scrolls the header with it — and a laptop that short is not a display this
	application is for. **Recorded rather than asserted**, deliberately: an assertion that
	held the face to 19 px would be a test of the defect, and would go red on the repair rather than on a
	regression.

	⚠ **`flex` is what passes that cap on to the panel, and the direction is not the load-bearing half.** A
	`max-height` on this box constrains nothing inside it on its own: the panel has to be made *sizable
	against this box's resolved height* rather than against its own content, and `display: flex` is what
	does that. Both halves are measured rather than reasoned: with `flex-col` removed and `flex` kept the
	panel still stays above the attribution — Chromium resolves a stretched item against the clamped
	height just as it does a column's — while with `flex` removed and the `max-height` left in place the
	panel's bottom edge lands at 1253 px against an attribution at 700. `flex-col` is kept because a
	one-item column is what this is, and calling it a row would misdescribe the layout; nothing breaks
	without it. What decides that the *face* is the part that gives, rather than the header or the tab
	strip, is inside `AnnotationInspector`, and the note above its `<section>` says so.

	⚠ **`z-index: 7` is load-bearing.** The leader is 5 and `layout.css` forces MapLibre's four control
	corners to 6 so the leader cannot be drawn across them; all three are compared in one stacking
	context, because `.maplibregl-map` opens none. 7 is one clear of the controls, which is what keeps
	the leader and the zoom control under this rather than through it.

	⚠ **The `{#if}` is unkeyed and must not dip false while the selection moves.** `AnnotationInspector`
	owns a fixed element id and a 220 ms out transition, so an outgoing panel that overlapped an incoming
	one would put two elements on `id="annotation-inspector"` — merging their tab strips into one radio
	group and leaving the row's `aria-controls` naming two targets.

	What holds the invariant is that **every transition writes `selectedAnnotationId` and replaces the
	collection in one synchronous task**, so `selectedAnnotation` never resolves to `null` on a flush in
	between: `#addDrawn` selects the shape it drew and then commits it. An `await` slipped between those
	two writes would leave one flush with the id naming an Annotation the collection has not got, this
	block would go false for that frame, and the fault would be a duplicated element id rather than
	anything visible — so the ordering is load-bearing and silent if broken.

	**Going false because the Annotation is genuinely gone is the other thing entirely**, and it is what
	`releaseMissingSelection` is for: an Edit History writes bytes, so undo can remove the Annotation
	this panel describes. There is no incoming panel in that case — the selection is cleared by the same
	read that took the Annotation away — so the outgoing one has the id to itself.
-->
{#snippet mapOverlay()}
	{#if annotations.selectedAnnotation}
		<div
			bind:this={inspectorDock}
			class="absolute top-auto right-2 bottom-[6.25rem] left-2 z-[7] flex max-h-[60%] flex-col lg:top-2 lg:bottom-auto lg:left-auto lg:max-h-[calc(100%-3rem)] lg:w-80 lg:max-w-[calc(100%-1rem)]"
		>
			<AnnotationInspector
				annotation={annotations.selectedAnnotation}
				index={annotations.selectedIndex}
				onclose={() => void dismissInspector()}
				text={inspectorText}
				style={annotations.selectedIsDrawable ? inspectorStyle : undefined}
			/>
		</div>
	{/if}
{/snippet}
