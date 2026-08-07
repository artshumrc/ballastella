<script lang="ts">
	// The Project (ticket 04, SPEC stories 1, 2, 3, 10–13).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// ONE SCREEN, AND WHY THIS ONE
	//
	// Entering a Project used to land on a page of fields with a link to a *different* page holding
	// the map. Noticing that a Historical Map sat crooked meant seeing it on the stack page and
	// navigating to the Project page to do anything about it. So `/layers/` and `ProjectView` are one
	// screen now, and this is it: a Base Map with the Layer stack beside it.
	//
	// **This file is `/layers/`'s script, moved, not rewritten.** The document-loading chain — the
	// `documentKey` guard, `drawn`, `outcomes`, `annotationPoints` and the annotation editing
	// functions — is the state layer for the whole screen and it is load-bearing in ways no test
	// names: `documentKey` exists because a rename once re-read every Alignment and one drag of an
	// opacity slider cost twenty reads per Layer. What `ProjectView` contributed is added around it:
	// the Project name (now in a dialog), the way a Historical Map gets in, and the remote-origin
	// affordances.
	//
	// **A component rather than a route.** A Project is `/?p=<dir>` (ADR-0008) — the same prerendered
	// page as the hub, choosing its subject client-side — so the thing that renders it has to be
	// mountable from `routes/+page.svelte`, which is where the `?p=` branch already is.
	//
	// **The navigation bar is not here.** The theme toggle, the save indicator, the undo control and
	// the Workspace's name are true on every screen and live in the root layout. What is here is what
	// is true of *this Project*: its name, its Base Map, and its settings.

	import { resolve } from '$app/paths';
	import {
		addAnnotation,
		baseMapFallbackNotice,
		canSolve,
		findAnnotation,
		insertAnnotationAt,
		newAnnotation,
		openingViewSentence,
		removeAnnotation,
		resolveBaseMap,
		setGeometry,
		setLineStyle,
		setStyle,
		setText,
		type Alignment,
		type AnnotationCollection,
		type AnnotationDeletedUndo,
		type AnnotationGeometry,
		type AnnotationLayer,
		type GeoPoint,
		type Layer,
		type LineStyle,
		type MapLayer,
		type OpeningViewFit,
		type OpeningViewOutcome
	} from '@ballastella/core';
	import type { DrawnLayer, DrawnOutcome } from '@ballastella/core/render';
	import { untrack } from 'svelte';

	import AnnotationPanel from '$lib/annotations/AnnotationPanel.svelte';
	import { AnnotationDrawing } from '$lib/annotations/drawing.svelte';
	import BaseMapPane, { type BaseMapOverlayPoint } from '$lib/base-map/BaseMapPane.svelte';
	import BaseMapSwitcher from '$lib/base-map/BaseMapSwitcher.svelte';
	import { fitToProjectContent } from '$lib/base-map/opening-view';
	import ModalDialog from '$lib/components/ModalDialog.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import LayerList from '$lib/layers/LayerList.svelte';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';
	import AddRemoteMap from '$lib/remote-iiif/AddRemoteMap.svelte';
	import MirrorMap from '$lib/remote-iiif/MirrorMap.svelte';
	import { MirrorMap as MirrorMapJob } from '$lib/remote-iiif/mirror-map.svelte.js';
	import UnwarpedView from '$lib/remote-iiif/UnwarpedView.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let {
		session,
		storage,
		openDirectory
	}: {
		session: EditorSession;
		storage: WorkspaceStorage;
		/** The Project's folder, from `?p=` (ADR-0008). Never `null` where this is mounted. */
		openDirectory: string;
	} = $props();

	/** Nothing to show, and a reason worth naming, rather than a screen that says "Opening…" for ever. */
	const recovering = $derived(session.status === 'unreachable' || storage.awaitingFolder);

	const resolution = $derived(
		session.openProject ? resolveBaseMap(session.openProject.baseMap) : null
	);
	const notice = $derived(resolution === null ? null : baseMapFallbackNotice(resolution));

	const layers = $derived<readonly Layer[]>(session.openProject?.layers ?? []);

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
				// Historical Map was added (ADR-0023), so the test is the Control Points and not the file.
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
	 * The Workspace Historical Maps whose tiles are on somebody else's server, by image id.
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
	 * answers `''` for a local copy and only for a local copy — a mirrored map keeps its `remote.json`
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
	 * What a map Layer with too few Control Points says about itself (SPEC stories 18, 34, 35).
	 *
	 * One sentence for every unaligned map Layer, whichever way it got here, because the state is one
	 * state: adding a Historical Map now puts a Layer in the stack straight away with a starter
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
	 * answer. It has to be: the sentence is about the Historical Map's placement, and a Layer does not
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

	const fetchTile = $derived(session.imageServiceFetch());

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
	// ─────────────────────────────────────────────────────────────────────────────────────────

	const annotationLayers = $derived(
		layers.filter((layer): layer is AnnotationLayer => layer.kind === 'annotation')
	);

	const annotationLayerCount = $derived(annotationLayers.length);

	/**
	 * Which Annotation Layer is being drawn into.
	 *
	 * A **working choice, not a property of the Project**, so it is component state and is not written
	 * anywhere: which Layer somebody happened to have selected is not part of their work, and persisting
	 * it would mean a write on a click that changed nothing (ADR-0010, ADR-0002).
	 */
	let chosenLayerId = $state<string | null>(null);

	/** The chosen Layer, or the topmost Annotation Layer when nothing has been chosen yet. */
	const activeLayer = $derived<AnnotationLayer | null>(
		annotationLayers.find((layer) => layer.id === chosenLayerId) ?? annotationLayers[0] ?? null
	);

	/**
	 * The active Layer's Annotations.
	 *
	 * Read out of `documents`, which is the **one** in-memory copy: an edit replaces the entry there and
	 * the map re-renders from it, so there is no second copy of a Layer's contents that could disagree
	 * with what was written. That is the same rule `EditorSession` follows for `project.json`.
	 */
	const activeCollection = $derived<AnnotationCollection | null>(
		activeLayer === null
			? null
			: ((documents[activeLayer.id] as AnnotationCollection | undefined) ?? null)
	);

	let selectedAnnotationId = $state<string | null>(null);
	const drawing = new AnnotationDrawing();

	/**
	 * Why an undo did not happen, or `''`.
	 *
	 * The affordance disappears when it is pressed, so an undo that quietly declined to do anything
	 * would look exactly like an undo that worked — and the one thing this feature has to convey is
	 * whether the user's work is back. `UndoControl` announces the success; a refusal has to be said
	 * from here, because it is this screen that knows which Layer the record named.
	 */
	let undoRefusal = $state('');

	/**
	 * Where the open popup is anchored, or `null` for none.
	 *
	 * The *place* rather than the popup, because MapLibre's `Popup` belongs inside the pane that owns
	 * the map — the screen says which Annotation is open and where, and the pane puts it on the map. A
	 * page holding a `Popup` would be a second thing reaching into MapLibre from outside it.
	 */
	let popupAt = $state.raw<GeoPoint | null>(null);

	/** Replace the active Layer's collection in memory and write it. */
	async function commitAnnotations(
		next: AnnotationCollection,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const layer = activeLayer;
		if (!layer) return;
		await commitAnnotationsIn(layer, next, options);
	}

	/**
	 * The same, into a Layer named outright rather than whichever one is chosen.
	 *
	 * **Undo is why this exists**, and it is the only caller that needs it: an `AnnotationDeletedUndo`
	 * carries the Layer the Annotation was in precisely so it cannot be restored into another one, and
	 * the picker may well have moved between the deletion and the undo. Everything else edits what the
	 * user is looking at, which is what {@link commitAnnotations} is for.
	 */
	async function commitAnnotationsIn(
		layer: AnnotationLayer,
		next: AnnotationCollection,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		if (next === documents[layer.id]) return;
		documents = { ...documents, [layer.id]: next };
		await session.writeAnnotations(layer, next, options);
	}

	/**
	 * A place on the earth the user asked for — a click, or Enter over the pane.
	 *
	 * With a drawing tool active this places a vertex; with the select tool it does nothing, and the
	 * Annotation hit (if any) is what {@link selectAnnotation} handles. One write happens here and only
	 * for a pin, whose gesture is complete at one point; a line and a shape are written by
	 * {@link finishShape}, which is ADR-0017 rule 1's "the gesture is over".
	 */
	async function placePoint(point: GeoPoint): Promise<void> {
		if (drawing.tool === 'select') return;
		const finished = drawing.place(point);
		if (finished !== null) await addDrawn(finished);
	}

	/** End a line or a shape, and keep it. */
	async function finishShape(): Promise<void> {
		const finished = drawing.finish();
		if (finished !== null) await addDrawn(finished);
	}

	/** Put a finished geometry in the Layer as a new Annotation, and select it so it can be titled. */
	async function addDrawn(geometry: AnnotationGeometry): Promise<void> {
		const collection = activeCollection ?? { annotations: [] };
		const annotation = newAnnotation({ id: crypto.randomUUID(), geometry });
		selectedAnnotationId = annotation.id;
		popupAt = null;
		await commitAnnotations(addAnnotation(collection, annotation));
	}

	/**
	 * Select an Annotation, and where asked, show what it says.
	 *
	 * The popup is the reader-facing surface and is shown to the author too, because an author needs to
	 * see what a reader will — it is the only place the rendered Markdown appears over the map rather
	 * than beside it. Selecting from the list opens no popup: there is no place on the map the user
	 * pointed at, and one appearing at an arbitrary coordinate would be worse than none.
	 */
	function selectAnnotation(id: string | null, at: GeoPoint | null = null): void {
		selectedAnnotationId = id;
		popupAt = id === null ? null : at;
	}

	const selectedAnnotation = $derived(
		activeCollection && selectedAnnotationId
			? (findAnnotation(activeCollection, selectedAnnotationId) ?? null)
			: null
	);

	/**
	 * The overlay points on the Base Map: the shape being drawn, and the selected Annotation's vertices.
	 *
	 * On the same seam as a Control Point and a Resource Mask corner, which is what gives every vertex a
	 * named `<button>`, arrow-key movement, Delete, and one store write per gesture without any of it
	 * being written here — see `drawing.svelte.ts` for why this rather than a WebGL drawing library.
	 */
	const annotationPoints = $derived.by((): BaseMapOverlayPoint[] => {
		const points: BaseMapOverlayPoint[] = [];

		// The vertices placed so far in the gesture in progress. Not operable: the next click on one of
		// them is the click that places the next vertex.
		drawing.vertices.forEach((vertex, index) => {
			points.push({
				key: `annotation-draft-${index}`,
				point: vertex,
				kind: 'annotation-draft',
				ordinal: index + 1,
				label: `Point ${index + 1} of the shape being drawn`
			});
		});

		const annotation = selectedAnnotation;
		const geometry = annotation?.geometry;
		if (!annotation || !geometry || geometry.type === 'foreign') return points;
		// A polygon's ring is closed (RFC 7946), so its last position repeats its first: it is drawn as
		// one fewer handle than the ring has positions, and `reshape` closes it again. Two handles on the
		// same spot, one of which silently had to follow the other, is the alternative.
		const positions: readonly (readonly [number, number])[] =
			geometry.type === 'Point'
				? [geometry.coordinates]
				: geometry.type === 'Polygon'
					? (geometry.coordinates[0] ?? []).slice(0, -1)
					: geometry.coordinates;

		positions.forEach((position, index) => {
			points.push({
				key: `annotation-vertex-${annotation.id}-${index}`,
				point: { lng: position[0] ?? 0, lat: position[1] ?? 0 },
				kind: 'annotation-vertex',
				ordinal: index + 1,
				label:
					`Point ${index + 1} of ${positions.length} of ${annotationName(annotation.id)}. ` +
					'Arrow keys move it.',
				// **Once, on gesture end.** Pointer-up, or the release of a held arrow key — never per
				// pointer-move, which is what makes "one edit is one store write" a number the suite counts.
				onmoveend: (to) => void reshape(index, to)
			});
		});

		return points;
	});

	/** What an Annotation is called, for a handle's accessible name. */
	const annotationName = (id: string): string => {
		const collection = activeCollection;
		const annotation = collection ? findAnnotation(collection, id) : undefined;
		return annotation?.properties.title || 'this Annotation';
	};

	/** Move one vertex of the selected Annotation, writing once. */
	async function reshape(index: number, to: GeoPoint): Promise<void> {
		const collection = activeCollection;
		const annotation = selectedAnnotation;
		const geometry = annotation?.geometry;
		if (!collection || !annotation || !geometry || geometry.type === 'foreign') return;

		const moved: [number, number] = [to.lng, to.lat];
		let next: AnnotationGeometry;
		if (geometry.type === 'Point') {
			next = { type: 'Point', coordinates: moved };
		} else if (geometry.type === 'LineString') {
			const positions = geometry.coordinates.map((position, at) =>
				at === index ? moved : position
			);
			next = { type: 'LineString', coordinates: positions };
		} else {
			const ring = (geometry.coordinates[0] ?? []).slice(0, -1);
			const positions = ring.map((position, at) => (at === index ? moved : position));
			// Closed again, because a LinearRing whose ends differ is what other tools reject.
			next = {
				type: 'Polygon',
				coordinates: [[...positions, positions[0] ?? moved], ...geometry.coordinates.slice(1)]
			};
		}
		await commitAnnotations(setGeometry(collection, annotation.id, next));
	}

	/**
	 * Delete the selected Annotation, recording what it takes away.
	 *
	 * The record holds the Annotation itself, so every one of its `properties` comes back — including
	 * `stroke-dasharray`, where "solid" is the property being *absent* (ADR-0009): an undo that rebuilt
	 * the Annotation from the controls' current values would silently turn a dotted conjectural route
	 * into a solid certain one.
	 */
	async function deleteSelected(): Promise<void> {
		const collection = activeCollection;
		const layer = activeLayer;
		const id = selectedAnnotationId;
		if (!collection || !layer || !id) return;
		const at = collection.annotations.findIndex((one) => one.id === id);
		const annotation = collection.annotations[at];
		// A refusal is about the record that is being replaced, so it goes with it.
		undoRefusal = '';
		selectedAnnotationId = null;
		popupAt = null;
		await commitAnnotations(removeAnnotation(collection, id));
		if (!annotation) return;
		const record: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: layer.id,
			at,
			annotation
		};
		// Recorded *after* the write, so a deletion the store refused is not offered as something to undo
		// — the same discipline `writeAlignment` follows when it counts a write.
		session.record(record, () => restoreDeleted(record));
	}

	/**
	 * Put a deleted Annotation back **into the Layer it was deleted from**.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THE RECORD NAMES THE LAYER AND THIS READS IT
	 *
	 * `chosenLayerId` is a working choice the user is free to change, and nothing stops them changing
	 * it between the deletion and the undo — the picker is a few pixels from the affordance. An undo
	 * that wrote into whichever Layer happened to be chosen would take an Annotation out of one
	 * `.geojson` and put it into another, which is not an undo of anything: it is a move the user did
	 * not ask for, into a file they were not looking at. `AnnotationDeletedUndo.layerId` exists for
	 * exactly this, and this is where it is spent.
	 *
	 * The picker follows the record rather than the other way round, so the user *watches* the
	 * Annotation come back instead of being told it did — the same reason `AlignmentPairing.restore`
	 * selects the pair it put back.
	 *
	 * Restored into that Layer's collection **as it is now** rather than into a snapshot: whatever else
	 * has been drawn or edited in it since must survive an undo of one deletion.
	 */
	async function restoreDeleted(record: AnnotationDeletedUndo): Promise<void> {
		undoRefusal = '';
		const layer = annotationLayers.find((one) => one.id === record.layerId);
		if (!layer) {
			// Not reachable through the interface — deleting a Layer is itself one of the four recorded
			// actions, so it replaces this record rather than orphaning it. Said rather than silently
			// redirected all the same, because the alternative to saying so is writing the Annotation into
			// a Layer the user never deleted it from.
			undoRefusal =
				`The Annotation could not be put back: the Annotation Layer it was in is no longer in ` +
				'this Project.';
			return;
		}
		let collection = documents[layer.id] as AnnotationCollection | undefined;
		if (collection === undefined) {
			// Only a Layer that has since been hidden gets here: `documents` holds the Layers the map is
			// given, and a hidden one is absent from it. Read rather than assumed empty — assuming would
			// write a file holding one Annotation over a file holding twenty.
			try {
				collection = await session.readAnnotations(layer);
			} catch (cause) {
				undoRefusal =
					`The Annotation could not be put back: ${layer.name || 'its Annotation Layer'} could ` +
					`not be read. ${cause instanceof Error ? cause.message : String(cause)}`;
				return;
			}
		}
		chosenLayerId = layer.id;
		selectedAnnotationId = record.annotation.id;
		popupAt = null;
		await commitAnnotationsIn(layer, insertAnnotationAt(collection, record.annotation, record.at));
	}

	/** Type into the title or the description. Coalesced per file (ADR-0017 rule 2). */
	async function typeText(text: { title?: string; description?: string }): Promise<void> {
		const collection = activeCollection;
		const id = selectedAnnotationId;
		if (!collection || !id) return;
		await commitAnnotations(setText(collection, id, text), { debounce: true });
	}

	/**
	 * The edit is over — a field blurred, Enter was pressed, or a slider was released.
	 *
	 * A no-op unless something is waiting to be written, which is the same guard `commitLayerEdit` and
	 * `commitProjectName` both carry: tabbing through a title field is *looking*, and ADR-0010 is
	 * explicit that merely looking at an old Project must not modify a single byte of it.
	 */
	async function commitAnnotationEdit(): Promise<void> {
		const layer = activeLayer;
		const collection = activeCollection;
		if (!layer || !collection) return;
		if (!session.hasPendingAnnotationWrite(layer)) return;
		await session.writeAnnotations(layer, collection);
	}

	/** Set style properties on the selected Annotation, by their exact simplestyle names. */
	async function styleSelected(
		style: Record<string, unknown>,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const collection = activeCollection;
		const id = selectedAnnotationId;
		if (!collection || !id) return;
		await commitAnnotations(setStyle(collection, id, style), options);
	}

	/** Set the selected Annotation's line style. Stores the tuple; solid is its absence (ADR-0009). */
	async function lineStyleSelected(line: LineStyle): Promise<void> {
		const collection = activeCollection;
		const id = selectedAnnotationId;
		if (!collection || !id) return;
		await commitAnnotations(setLineStyle(collection, id, line));
	}

	/** Choosing another Layer abandons a part-drawn shape and clears the selection with it. */
	function chooseLayer(id: string): void {
		chosenLayerId = id;
		selectedAnnotationId = null;
		popupAt = null;
		drawing.cancel();
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Project settings, and the menu it opens from (SPEC stories 10, 11)
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The Project's own settings, in a `<dialog>`.
	 *
	 * ADR-0016 mandates `<dialog>` + `showModal()` — Escape, the focus trap and focus restoration come
	 * with it — and {@link ModalDialog} is where that decision was made once. A whole page for one
	 * editable field and two read-only ones was the thing this ticket removes.
	 */
	let settingsOpen = $state(false);

	/** The menu the dialog opens from, and the element focus comes back to. */
	let menuButton = $state<HTMLButtonElement | undefined>();
	let menu = $state<HTMLElement | undefined>();

	/**
	 * Open Project settings from the menu.
	 *
	 * The popover is dismissed and focus is put **back on the menu button** before the dialog opens,
	 * rather than left on the menu item. `ModalDialog` records `document.activeElement` at the moment
	 * it calls `showModal()` and restores it on close, so whatever has focus then is where the user
	 * lands afterwards — and the menu item is inside a popover that no longer exists by then, which
	 * would drop focus to `<body>`. The menu button is the control the user reached for, it is still
	 * on screen, and it is where they can open the menu again.
	 */
	function openSettings(): void {
		menu?.hidePopover();
		menuButton?.focus();
		settingsOpen = true;
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Bringing a Historical Map in, and the ones that live on somebody else's server
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * One mirroring job for the whole screen, not one per Layer.
	 *
	 * Mirroring is deliberately one image at a time, so a second job would be a second way to start a
	 * copy that the first one's `busy` guard cannot see.
	 */
	const mirror = new MirrorMapJob(() => session);

	/**
	 * The app's one online signal, so a referenced Historical Map can say why it is not there.
	 *
	 * ADR-0012's offline claim has one honest exception: a referenced Historical Map's tiles are on
	 * somebody else's server, so with no connection there is nothing to draw and no amount of caching
	 * would change that — a partially cached remote pyramid renders *with holes*, which reads as
	 * corruption. Say so, name the host, and leave the rest of the Project working.
	 */
	const installedApp = useInstalledApp();

	/**
	 * The remote-origin record for a map Layer's Historical Map, or `undefined`.
	 *
	 * **Keyed by Layer, which is what replaced the two sections `ProjectView` had.** "Referenced
	 * Historical Maps" and "Offline copies" were two lists of image ids sitting under a Project that
	 * had no way to say which of its Layers each one belonged to; the same two facts — the tiles are on
	 * a library's server, and this copy came from one — are properties of a Layer and belong on it
	 * (ADR-0023). Tickets 05 and 07 give them their final form on an opened Layer card.
	 */
	const originFor = (layer: MapLayer) =>
		session.referencedImages.find((image) => image.imageId === layer.imageId);

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

	/**
	 * Which referenced Historical Map is being read unwarped, by image id. `''` for none.
	 *
	 * Only one at a time: each `TriiiceratopsViewer` is an OpenSeadragon instance with its own WebGL
	 * or canvas drawer, and this screen already carries a MapLibre context.
	 */
	let unwarpedImageId = $state('');
	const unwarped = $derived(
		session.referencedImages.find((image) => image.imageId === unwarpedImageId) ?? null
	);
</script>

<!--
	Escape abandons a part-drawn shape from anywhere on the screen, and closes an open popup.

	On the window rather than on the pane, for the reason ADR-0022 gives for the pending Control Point
	half: the user may have tabbed away to the toolbar or the Annotation list, and "Escape only works if
	you have not moved the focus" is not a cancel affordance. It abandons rather than commits, because a
	half-drawn shape somebody walked away from is not something they asked to keep.

	**Not while the settings dialog is open.** `<dialog>`'s own Escape closes it, and swallowing the
	keypress here as well would cancel a drawing gesture the user cannot even see.
-->
<svelte:window
	onkeydown={(event) => {
		if (event.key !== 'Escape' || settingsOpen) return;
		if (drawing.cancel()) return;
		if (popupAt !== null) popupAt = null;
	}}
/>

{#if recovering}
	<div class="m-4">
		<WorkspaceRecovery {storage} />
		<p class="mt-6"><a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a></p>
	</div>
{:else if session.projectProblem}
	<div role="alert" class="m-4 alert flex-col items-start alert-warning">
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
		`h-full`, and the root layout is what gives it a full screen to be `h-full` of. The map is the
		thing the scholar is studying, so it gets the height the bar and this header do not take —
		computed by the layout rather than by arithmetic on a `calc()` that goes wrong the moment the
		bar wraps to two lines.
	-->
	<div class="flex h-full min-h-0 flex-col" data-testid="project-screen">
		<div class="flex flex-wrap items-center gap-3 border-b border-base-300 px-4 py-2">
			<!-- The Project's name, read-only here: renaming it is what the settings dialog is for.
			     `<h1>` because on this screen the Project is the page. -->
			<h1 class="text-lg font-semibold" data-testid="project-name">{session.openProject.name}</h1>

			<!-- The one Base Map switcher in the app that writes this Project's author default
			     (ADR-0020). On the Project screen, because that is whose choice it is. -->
			<BaseMapSwitcher entryId={resolution.entry.id} onSelect={(id) => session.chooseBaseMap(id)} />

			<!--
				The Project menu (ADR-0016: the Popover API, never `<details>` and never a CSS-focus
				dropdown). One item today; ticket 12 and the transfer tickets add theirs beside it, which
				is the reason it is a menu rather than a button that goes straight to the dialog.
			-->
			<button
				type="button"
				class="btn btn-sm"
				popovertarget="project-menu"
				bind:this={menuButton}
				data-testid="project-menu-button"
			>
				Project…
			</button>
			<div
				popover="auto"
				id="project-menu"
				bind:this={menu}
				class="project-menu rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
			>
				<ul class="menu w-56 p-0">
					<li>
						<button type="button" data-testid="open-project-settings" onclick={openSettings}>
							Project settings…
						</button>
					</li>
				</ul>
			</div>

			<!--
				ADR-0026's explicit control, and it is a button with words on it rather than an icon with a
				tooltip (SPEC story 111). It exists because the automatic fit deliberately happens once:
				everything the once-only rule gives up — coming back after panning away, reframing after
				drawing somewhere new — is this.
			-->
			<button
				type="button"
				class="btn btn-sm"
				data-testid="fit-to-project"
				onclick={() => void fitToProject()}
			>
				Fit to this Project
			</button>

			<!--
				Why the Base Map on screen is not the one the Project asked for (ADR-0020). An
				`aria-live="polite"` region and not a second `role="status"`: the save indicator owns that
				role for the whole app, and a second one makes `getByRole('status')` ambiguous — which is a
				hint that a screen-reader user would have to disambiguate too.
			-->
			<p class="grow text-sm text-base-content/70" aria-live="polite" data-testid="base-map-notice">
				{notice ?? ''}
			</p>

			<a class="link text-sm" href={resolve('/')}>Back to all Projects</a>
		</div>

		<div class="flex min-h-0 grow">
			<!--
				The sidebar is a **fixed column** and the map takes what is left, which is the whole of
				"the map gets the larger share of the screen": a proportional sidebar grows with the
				display, and on a large one that is a wall of controls beside a map that gained nothing.
			-->
			<div
				class="w-96 shrink-0 overflow-y-auto border-r border-base-300 p-4"
				data-testid="layer-sidebar"
			>
				<LayerList
					{layers}
					{outcomes}
					{referencedImageIds}
					ontypename={(id, name) => session.typeLayerName(id, name)}
					oncommit={() => session.commitLayerEdit()}
					onshow={(id, visible) => session.showLayer(id, visible)}
					ondragopacity={(id, opacity) => session.dragLayerOpacity(id, opacity)}
					onmove={(id, toIndex) => session.moveLayerTo(id, toIndex)}
					ondelete={(id) => void session.deleteLayer(id)}
					{mapActions}
				/>

				<button
					class="btn mt-4 btn-sm"
					data-testid="add-annotation-layer"
					onclick={() => session.addAnnotationLayer(`Annotations ${annotationLayerCount + 1}`)}
				>
					Add an Annotation Layer
				</button>

				<!--
					Why an undo did not happen. `aria-live="polite"` is ADR-0016's mandated method for a
					status, and it is here rather than inside `UndoControl` — which is on the navigation bar —
					because the refusal is this screen's knowledge: the record names an Annotation Layer, and
					only the thing holding the stack can say that Layer is not there any more.
				-->
				<p
					class="mt-2 max-w-prose text-sm text-warning"
					aria-live="polite"
					aria-atomic="true"
					data-testid="undo-refused"
				>
					{undoRefusal}
				</p>

				<hr class="my-6 border-base-300" />

				<AnnotationPanel
					layers={annotationLayers}
					layer={activeLayer}
					collection={activeCollection}
					selectedId={selectedAnnotationId}
					tool={drawing.tool}
					status={drawing.status}
					drawing={drawing.drawing}
					canFinish={drawing.canFinish}
					onchooselayer={chooseLayer}
					onchoosetool={(tool) => drawing.choose(tool)}
					onfinish={() => void finishShape()}
					oncancel={() => drawing.cancel()}
					onundovertex={() => drawing.undoVertex()}
					onselect={(id) => selectAnnotation(id)}
					ontext={(text) => void typeText(text)}
					oncommit={() => void commitAnnotationEdit()}
					onstyle={(style, options) => void styleSelected(style, options)}
					onlinestyle={(line) => void lineStyleSelected(line)}
					ondelete={() => void deleteSelected()}
					onlayerstyle={(style, options) =>
						void (activeLayer && session.setLayerDefaultStyle(activeLayer.id, style, options))}
				/>

				<hr class="my-6 border-base-300" />

				<!--
					Adding a Historical Map from a file on this computer (SPEC stories 21, 22, 25, 26).

					Every image becomes a IIIF pyramid, including a small one, because an untiled level-0
					image cannot be parsed at all (ADR-0003). So this is a job with progress rather than a
					file input that finishes instantly, and the progress region below is what a scholar
					watching a large scan has to go on.

					In the sidebar because that is where Layers come from. Ticket 06 makes it one "Add a
					Layer" flow offering all three sources; what is here is the two that already work, kept
					working.
				-->
				<section aria-labelledby="historical-maps-heading">
					<h2 id="historical-maps-heading" class="text-sm font-semibold">Historical Maps</h2>

					<label class="mt-3 block">
						<span class="mb-1 block text-sm">Add a Historical Map from a file</span>
						<input
							class="file-input w-full"
							type="file"
							accept="image/*"
							disabled={session.ingest !== null}
							onchange={(event) => {
								const input = event.currentTarget;
								const file = input.files?.[0];
								// Cleared straight away, so picking the same file twice runs twice: `change` does
								// not fire for an unchanged value, and "nothing happened" is indistinguishable
								// from a silent failure.
								input.value = '';
								if (file) session.ingestImage(file);
							}}
						/>
					</label>

					<!--
						`aria-live="polite"` rather than `role="status"`, which would be the idiomatic choice
						but for the save indicator already being the app's one `status` role — two of them make
						`getByRole('status')` ambiguous, and a test that has to disambiguate is a hint that a
						screen-reader user would have to as well. `aria-atomic` so each update is read as a
						whole sentence rather than as the digits that changed.
					-->
					<div aria-live="polite" aria-atomic="true" class="mt-4 min-h-6">
						{#if session.ingest}
							{@const ingest = session.ingest}
							<p class="text-sm">
								{#if ingest.phase === 'inspecting'}
									Reading {session.ingestLabel}…
								{:else if ingest.phase === 'opening'}
									Opening {session.ingestLabel}…
								{:else if ingest.phase === 'tiling'}
									Preparing {session.ingestLabel}: tile {ingest.tilesWritten} of {ingest.tileCount}
								{:else if ingest.phase === 'finishing'}
									Finishing {session.ingestLabel}…
								{:else}
									Added {session.ingestLabel}
								{/if}
							</p>
							<progress
								class="progress mt-1 w-full"
								value={ingest.fraction}
								max="1"
								aria-label="Preparing {session.ingestLabel}"
							></progress>
							<!--
								A real button, beside the bar and reachable by tab. A gigapixel scan is thousands
								of tiles and several minutes; picking the wrong file and having no way out of it
								is the thing `ingest.ts` claimed to support and the app never wired up. The job
								cleans up after itself, so cancelling leaves the Project as it was.
							-->
							<button
								type="button"
								class="btn mt-2 btn-sm"
								aria-label="Cancel preparing {session.ingestLabel}"
								onclick={() => session.cancelIngest()}
								disabled={ingest.phase === 'done'}>Cancel</button
							>
						{/if}
					</div>

					{#if session.ingestError}
						<div role="alert" class="mt-4 alert max-w-prose alert-warning">
							<p>{session.ingestError}</p>
						</div>
					{/if}

					<!--
						Adding a Historical Map from a library's IIIF endpoint. Beside the file input, because
						the two are the same act — bringing a map in — reached from two different kinds of
						source, and what differs afterwards is only whether the tiles are ours.
					-->
					<AddRemoteMap {session} />
				</section>

				<!--
					The outcome of a copy, announced from out here rather than from inside the dialog: the
					dialog closes on success, and an announcement added to a subtree that is removed in the
					same frame is indistinguishable from one that never happened.
				-->
				<p
					class="mt-4 min-h-6 text-sm"
					aria-live="polite"
					aria-atomic="true"
					data-testid="mirror-done"
				>
					{mirror.completed}
				</p>

				{#if session.referencedImageErrors.length > 0}
					<div role="alert" class="mt-4 alert max-w-prose flex-col items-start alert-warning">
						{#each session.referencedImageErrors as failure (failure.imageId)}
							<p>{failure.reason}</p>
						{/each}
					</div>
				{/if}
			</div>

			<div class="relative flex min-h-0 grow flex-col">
				{#if !installedApp.online}
					<div
						role="status"
						class="m-2 alert flex-col items-start alert-info"
						data-testid="base-map-offline"
					>
						<h2 class="font-semibold">The Base Map needs a connection</h2>
						<p>
							There is no network connection, so the Base Map cannot load yet. Everything in your
							Workspace still works: you can add a Historical Map now and place it when the
							connection is back.
						</p>
					</div>

					{#if referencedLayers.length > 0}
						<!--
							The one honest exception to the offline claim, said rather than left as a blank pane.
							Naming the host is the whole point: "this Historical Map is not here" is unactionable,
							and "nothing can be fetched from gallica.bnf.fr while you are offline" tells an author
							both why and what to do about it before their next trip to the archive.
						-->
						<div
							role="alert"
							class="m-2 alert flex-col items-start alert-warning"
							data-testid="referenced-offline"
						>
							<p>
								There is no connection, so nothing can be fetched from {unreachableHosts.join(
									', '
								)}. These Historical Maps stay blank until there is one. Everything else in this
								Project — its own Historical Maps, its Alignments, and its Annotations — is
								unaffected and still saves.
							</p>
						</div>
					{/if}
				{/if}

				<div class="min-h-0 grow overflow-hidden" data-testid="project-map">
					<BaseMapPane
						entryId={resolution.entry.id}
						layers={drawn}
						{openingFit}
						overlayPoints={annotationPoints}
						popupAnnotation={selectedAnnotation}
						{popupAt}
						{fetchTile}
						onclickpoint={(point) => void placePoint(point)}
						onclickannotation={(hit) => {
							// Only when nothing is being drawn: with a tool in hand the click places a vertex,
							// and the Annotation underneath is not what the user is pointing at.
							if (drawing.tool !== 'select') return;
							chosenLayerId = hit.layerId;
							selectAnnotation(hit.annotationId, hit.at);
						}}
						onfinishshape={() => void finishShape()}
						onpopupclose={() => (popupAt = null)}
						onstack={(reported) => (rendered = reported)}
					/>
				</div>

				<div class="shrink-0 px-4 py-1">
					<!--
						What is on the map, in words. `aria-live` rather than `role="status"`, because the save
						indicator already owns that role in the app.
					-->
					<p
						class="min-h-6 text-sm"
						aria-live="polite"
						aria-atomic="true"
						data-testid="stack-status"
						data-drawn={drawnCount}
					>
						{#if layers.length === 0}
							Nothing is on the map yet.
						{:else}
							{drawnCount} of {layers.length}
							{layers.length === 1 ? 'Layer is' : 'Layers are'} drawn over the Base Map.
						{/if}
					</p>
					<!--
						Where the map is looking and why (SPEC story 112). A WebGL canvas announces nothing
						about what it is showing, so "the map has jumped to Boston" is otherwise available only
						to someone who can see it — and "it did not jump, because this Project has nothing on
						the earth yet" is the more useful of the two sentences and the one nobody would guess.
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

				<!--
					Reading a referenced Historical Map as a document. Over the map rather than beside it,
					because it is a whole viewer and the sidebar is a column: it covers the map while it is
					open and gives it back when it is closed. Ticket 15 removes this from the editor
					altogether; until then it stays reachable from the Layer it belongs to.
				-->
				{#if unwarped}
					<div class="absolute inset-0 z-10 overflow-y-auto bg-base-100 p-4">
						<UnwarpedView image={unwarped} onclose={() => (unwarpedImageId = '')} />
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!--
		Project settings (SPEC stories 10, 11): the one editable field and the two facts a scholar needs
		to find their files and trust that they are current. A dialog rather than a page, because a page
		for three values is the navigation this ticket exists to remove.
	-->
	<ModalDialog bind:open={settingsOpen} title="Project settings">
		<!--
			`onchange` and `onblur` both mean "the edit is over" (ADR-0017 rule 1). Neither writes on its
			own: `commitProjectName` is a no-op unless there is a pending write, because tabbing into and
			out of this field must not rewrite `project.json` — the write stamps a fresh `updatedAt`, and
			ADR-0010 is explicit that merely looking at an old Project must not modify files.
		-->
		<label class="floating-label block">
			<span>Project name</span>
			<input
				class="input w-full"
				data-testid="project-name-input"
				value={session.openProject?.name ?? ''}
				oninput={(event) => session.typeProjectName(event.currentTarget.value)}
				onchange={() => session.commitProjectName()}
				onblur={() => session.commitProjectName()}
			/>
		</label>

		<dl class="mt-6 text-sm">
			<dt class="font-medium">Folder</dt>
			<dd><code data-testid="project-folder">{session.openDirectory}</code></dd>
			<dt class="mt-2 font-medium">Last saved</dt>
			<dd>
				<time data-testid="project-updated-at" datetime={session.openProject.updatedAt}
					>{session.openProject.updatedAt}</time
				>
			</dd>
		</dl>

		{#snippet actions()}
			<button type="button" class="btn btn-sm" onclick={() => (settingsOpen = false)}>Close</button>
		{/snippet}
	</ModalDialog>
{:else}
	<p class="p-4">Opening Project “{openDirectory}”…</p>
{/if}

<!--
	The per-Layer actions on a Historical Map Layer, rendered by `LayerList` inside the Layer's own row.

	**A snippet passed down rather than markup inside `LayerList`**, for one concrete reason: the Align
	link has to be spelled `{resolve('/align')}?p=…&layer=…` at the point it is written, because
	`svelte/no-navigation-without-resolve` reads the first part of an `href` literally and a string
	computed elsewhere and passed in is not the shape it recognises. Keeping it here also keeps
	`LayerList` about the stack rather than about routes and about somebody else's IIIF server.

	**A link, not a button.** The route is keyed by Layer id and a Historical Map in a Project has had
	its Layer since it was added (ADR-0023), so there is nothing to resolve on the way — an earlier
	shape pressed a button that created the Layer and then navigated, which meant a disabled control
	across a store read and a Workspace-shared `alignments/<id>.json` written to do it.
-->
{#snippet mapActions(layer: MapLayer)}
	{@const origin = originFor(layer)}
	{@const referenced = referencedImageIds.has(layer.imageId)}
	<div class="mt-2 flex flex-wrap items-center gap-2">
		<a
			class="btn btn-primary btn-xs"
			data-testid="align-historical-map"
			href="{resolve('/align')}?p={encodeURIComponent(openDirectory)}&layer={encodeURIComponent(
				layer.id
			)}"
		>
			Align
		</a>

		{#if referenced && origin}
			<!-- Where the tiles come from, on the Layer that fetches them (SPEC story 80). -->
			<span class="text-xs" data-testid="referenced-image-label"
				>{origin.label || origin.imageId}</span
			>
			<code class="text-xs opacity-70" data-testid="referenced-image-host"
				>{new URL(origin.service).hostname}</code
			>
			<button
				class="btn btn-xs"
				type="button"
				data-testid="view-unwarped"
				aria-pressed={unwarpedImageId === layer.imageId}
				onclick={() => (unwarpedImageId = unwarpedImageId === layer.imageId ? '' : layer.imageId)}
			>
				View unwarped
			</button>
			<MirrorMap image={origin} job={mirror} />
		{:else if origin}
			<!--
				An offline copy, and the address it came from (SPEC story 76). Kept visible because
				mirroring keeps `remote.json` precisely so a copy can still be cited and traced back to the
				library it came from (ADR-0007), and a copy nobody can cite is a copy that has been orphaned.
			-->
			<span class="text-xs" data-testid="mirrored-image-label"
				>{origin.label || origin.imageId}</span
			>
			<code class="text-xs break-all opacity-70" data-testid="mirrored-image-source"
				>{origin.service}</code
			>
		{/if}
	</div>
{/snippet}

<style>
	/*
		A popover is in the top layer, so it has no containing block to be positioned against and an
		`absolute` offset would resolve against the viewport. Anchor positioning is what puts it under
		the button that opened it; the plain declarations before it are what a browser without anchor
		positioning falls back to, which is a menu below the bar rather than one in the middle of the
		screen.
	*/
	.project-menu {
		position: fixed;
		top: 5rem;
		left: 1rem;
		margin: 0;
		position-anchor: --project-menu;
		position-area: bottom span-right;
		margin-top: 0.25rem;
	}

	:global([data-testid='project-menu-button']) {
		anchor-name: --project-menu;
	}
</style>
