<script lang="ts">
	// The Project composed: its Layer stack over its Base Map (SPEC stories 49–54).
	//
	// A pane of its own rather than a panel beside the alignment workspace, because the two are about
	// different things. Aligning is one Historical Map being placed on the earth; the stack is the
	// whole Project, every Layer of it drawn together in the order the author chose — which is the
	// thing tickets 16 and 17 publish, and the thing a reader eventually sees. It also keeps one
	// WebGL context and one warped renderer on the page rather than two.
	//
	// The Project is addressed by query parameter and is **opened, never created** (ADR-0008), and
	// every write goes through the app's one `EditorSession`: there is no second in-memory copy of
	// `project.json` and no second writer of it, which matters more here than anywhere else in the app
	// because the Layer list is the field whose loss is "not one annotation but the map of everything"
	// (ADR-0017 rule 4).

	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		addAnnotation,
		baseMapFallbackNotice,
		findAnnotation,
		imageIdFromAlignmentRef,
		newAnnotation,
		otherTheme,
		removeAnnotation,
		resolveBaseMap,
		restoreAnnotation,
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
		type MapLayer
	} from '@ballastella/core';
	import type { DrawnLayer, DrawnOutcome } from '@ballastella/core/render';
	import { untrack } from 'svelte';

	import AnnotationPanel from '$lib/annotations/AnnotationPanel.svelte';
	import { AnnotationDrawing } from '$lib/annotations/drawing.svelte';
	import BaseMapPane, { type BaseMapOverlayPoint } from '$lib/base-map/BaseMapPane.svelte';
	import BaseMapSwitcher from '$lib/base-map/BaseMapSwitcher.svelte';
	import SaveIndicator from '$lib/components/SaveIndicator.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import LayerList from '$lib/layers/LayerList.svelte';
	import UndoControl from '$lib/undo/UndoControl.svelte';
	import { startTheme, theme } from '$lib/theme.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	const openDirectory = $derived(page.url.searchParams.get('p'));

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	$effect(() => {
		startTheme();
	});

	$effect(() => {
		void session?.open(openDirectory);
	});

	const resolution = $derived(
		session?.openProject ? resolveBaseMap(session.openProject.baseMap) : null
	);
	const notice = $derived(resolution === null ? null : baseMapFallbackNotice(resolution));

	const layers = $derived<readonly Layer[]>(session?.openProject?.layers ?? []);

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
	 * What requires the referenced documents to be read again: which Layers are drawn, and out of which
	 * files. **Not** the name and not the opacity, which are display state and must not cost a read of
	 * the store — a rename that re-read every Alignment would make the cheapest edit in the application
	 * one of the most expensive.
	 *
	 * **A string, and the effect below reads nothing else that is tracked.** Deriveds compare by
	 * reference and `shown` is a fresh array from `.filter()` on every change to `layers`, so an effect
	 * that reads `shown` has `layers` as its real dependency however carefully it computes a key first.
	 * That is what this guard used to be: the key was computed, discarded with `void`, and `shown` read
	 * on the next line — so a rename cost a re-read of every Alignment, and one drag of the opacity
	 * slider at `step="0.05"` cost twenty of them per Layer.
	 */
	const documentKey = $derived(
		JSON.stringify(
			shown.map((layer) => [layer.id, layer.kind === 'map' ? layer.alignmentRef : layer.geojsonRef])
		)
	);

	/**
	 * Each drawn Layer's document, by Layer id: an `Alignment`, or a parsed `FeatureCollection`.
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
		// The two tracked dependencies: which files to read, and the session to read them from. `shown`
		// is read *untracked*, so a rename or a dragged slider — neither of which changes which Layers
		// are drawn or out of which files — cannot reach the store at all. See {@link documentKey}.
		void documentKey;
		// Editing an Annotation replaces the collection in `documents` without changing `documentKey`,
		// so this must not also re-read on every edit — it would race the write and snap the map back to
		// the bytes on disk. `reloadAt` is bumped only where a fresh read is genuinely wanted.
		void reloadAt;
		const current = session;
		const wanted = untrack(() => shown);
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
				// A map Layer with no Alignment yet is not handed to the map at all: there is nothing to
				// place it by, and `showAlignment` would have to refuse it a second time.
				if (document === undefined) return [];
				return [{ layer, alignment: document as Alignment, service: remoteServiceFor(layer) }];
			}
			return [{ layer, annotations: (document as AnnotationCollection | undefined) ?? null }];
		})
	);

	/**
	 * Where a `'referenced'` Layer's tiles are served from, or `''` for a local copy (ticket 14).
	 *
	 * Keyed off `imageMode` rather than off "is there a record for this image", so this answers `''` for
	 * a local copy and only for a local copy — a referenced Layer is never accidentally handed a service
	 * because some other image happened to have a record.
	 *
	 * **`''` on a `'referenced'` Layer renders blank, and is not refused.** `showAlignment` builds the
	 * ADR-0004 placeholder document from it, the renderer accepts that and names a map, and the pane
	 * reports the Layer as drawn while the injection shim looks for a pyramid a referenced image by
	 * definition does not have locally. That used to be reachable on every fresh load of this pane,
	 * because `remote.json` is listed after `project.json` and the stack was not rebuilt when the record
	 * arrived — see `stackStructure` in `BaseMapPane.svelte`, which now depends on the service. What is
	 * left is a Layer whose `remote.json` really is missing or unreadable, which is a hand-edited or
	 * half-written Project; telling that apart from "not read yet" needs a signal `EditorSession` does
	 * not expose, and is recorded on ticket 09 rather than guessed at here.
	 */
	const remoteServiceFor = (layer: MapLayer): string => {
		if (layer.imageMode !== 'referenced') return '';
		const imageId = imageIdFromAlignmentRef(layer.alignmentRef);
		return (
			(session?.referencedImages ?? []).find((image) => image.imageId === imageId)?.service ?? ''
		);
	};

	/** What the map made of each Layer it was given. */
	let rendered = $state.raw<Readonly<Record<string, DrawnOutcome>>>({});

	/**
	 * What the list says about each Layer: what the map reported, plus the Layers the map never got.
	 *
	 * A map Layer with no Alignment file yet is the ordinary first state of a Historical Map somebody
	 * has only just brought in, so it is a sentence rather than an error.
	 */
	const outcomes = $derived.by((): Readonly<Record<string, DrawnOutcome>> => {
		const merged: Record<string, DrawnOutcome> = { ...rendered };
		for (const [id, reason] of Object.entries(unreadable)) {
			merged[id] = { status: 'refused', reason };
		}
		for (const layer of shown) {
			if (merged[layer.id] || documents[layer.id] !== undefined) continue;
			merged[layer.id] = {
				status: 'refused',
				reason:
					layer.kind === 'map'
						? 'Not aligned yet, so there is nothing to draw.'
						: 'No Annotations in this Layer yet.'
			};
		}
		return merged;
	});

	const fetchTile = $derived(session?.imageServiceFetch() ?? undefined);

	/** How many Layers are actually on the map. Said, because "nothing is drawn" has many reasons. */
	const drawnCount = $derived(
		Object.values(outcomes).filter((outcome) => outcome.status === 'drawn').length
	);

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// Annotations (ticket 10)
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
	 * with what was written. That is the same rule `EditorSession` follows for `project.json`, and the
	 * reason ticket 04's second writer destroyed a document.
	 */
	const activeCollection = $derived<AnnotationCollection | null>(
		activeLayer === null
			? null
			: ((documents[activeLayer.id] as AnnotationCollection | undefined) ?? null)
	);

	let selectedAnnotationId = $state<string | null>(null);
	const drawing = new AnnotationDrawing();

	/**
	 * Where the open popup is anchored, or `null` for none.
	 *
	 * The *place* rather than the popup, because MapLibre's `Popup` belongs inside the pane that owns
	 * the map — the page says which Annotation is open and where, and the pane puts it on the map. A
	 * page holding a `Popup` would be a second thing reaching into MapLibre from outside it.
	 */
	let popupAt = $state.raw<GeoPoint | null>(null);

	/** Replace the active Layer's collection in memory and write it. */
	async function commitAnnotations(
		next: AnnotationCollection,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const current = session;
		const layer = activeLayer;
		if (!current || !layer) return;
		if (next === activeCollection) return;
		documents = { ...documents, [layer.id]: next };
		await current.writeAnnotations(layer, next, options);
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
	 * The popup is the reader-facing surface (SPEC story 67) and is shown to the author too, because an
	 * author needs to see what a reader will — it is the only place the rendered Markdown appears over
	 * the map rather than beside it. Selecting from the list opens no popup: there is no place on the
	 * map the user pointed at, and one appearing at an arbitrary coordinate would be worse than none.
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
	 * Delete the selected Annotation (SPEC story 66), recording what it takes away (SPEC story 38).
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
		selectedAnnotationId = null;
		popupAt = null;
		await commitAnnotations(removeAnnotation(collection, id));
		if (!annotation || !session) return;
		const record: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: layer.id,
			at,
			annotation
		};
		// Recorded *after* the write, so a deletion the store refused is not offered as something to undo
		// — the same discipline `writeAlignment` follows when it counts a write.
		session.record(record, async () => {
			// Restored into the collection as it is *now* rather than into a snapshot: whatever else has
			// been drawn or edited since must survive an undo of one deletion.
			const current = activeCollection;
			if (!current) return;
			selectedAnnotationId = annotation.id;
			await commitAnnotations(restoreAnnotation(current, record));
		});
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
	 * explicit that merely looking at an old Project must not modify a single byte of it. Writing the
	 * in-memory collection here regardless would reintroduce ticket 02's `onblur`-rewrites-on-focus-and-
	 * leave shape, which had to be removed.
	 */
	async function commitAnnotationEdit(): Promise<void> {
		const layer = activeLayer;
		const collection = activeCollection;
		if (!layer || !collection) return;
		if (!session?.hasPendingAnnotationWrite(layer)) return;
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
</script>

<svelte:head><title>Layers — Ballastella Editor</title></svelte:head>

<!--
	Escape abandons a part-drawn shape from anywhere on the page, and closes an open popup.

	On the window rather than on the pane, for the reason ADR-0022 gives for the pending Control Point
	half: the user may have tabbed away to the toolbar or the Annotation list, and "Escape only works if
	you have not moved the focus" is not a cancel affordance. It abandons rather than commits, because a
	half-drawn shape somebody walked away from is not something they asked to keep.
-->
<svelte:window
	onkeydown={(event) => {
		if (event.key !== 'Escape') return;
		if (drawing.cancel()) return;
		if (popupAt !== null) popupAt = null;
	}}
/>

<div class="flex min-h-screen flex-col">
	<header class="flex flex-wrap items-end gap-4 border-b border-base-300 bg-base-200 p-4">
		<h1 class="text-xl font-bold">Layers</h1>

		{#if resolution !== null}
			<BaseMapSwitcher
				entryId={resolution.entry.id}
				onSelect={(id) => session?.chooseBaseMap(id)}
			/>
		{/if}

		<button type="button" class="btn btn-sm" onclick={() => theme.toggle()}>
			Switch to {otherTheme(theme.current)} theme
		</button>

		<p class="grow text-sm text-base-content/70" aria-live="polite">{notice ?? ''}</p>

		{#if session !== null}
			<!--
				What the last destructive action was, and the way back from it (SPEC story 38). Beside the
				save indicator because the two answer the same worry from opposite directions: one says the
				tool has the change, and this one says the change can be taken back — including after the
				other has said "Saved", which is the whole point of ADR-0014's undo.
			-->
			<UndoControl {session} />

			<!-- ADR-0017 rule 5: there is no Save button, so this is the only signal that a reorder,
			     a rename, or a visibility toggle reached storage. -->
			<div class="flex flex-col items-end">
				<SaveIndicator saveState={session.saveState} />
				{#if session.saveError}
					<p class="text-sm text-warning">{session.saveError}</p>
				{/if}
			</div>
		{/if}
	</header>

	{#if host.unsupported}
		<div role="alert" class="m-4 alert flex-col items-start alert-warning">
			<h2 class="font-semibold">No storage for a Workspace</h2>
			<p>{host.unsupported}</p>
		</div>
	{:else if storage === null || session === null}
		<p class="p-4">Starting…</p>
	{:else if openDirectory === null}
		<div role="alert" class="m-4 alert flex-col items-start alert-info">
			<h2 class="font-semibold">No Project chosen</h2>
			<p>A Layer stack belongs to one Project, so this pane needs a Project to open.</p>
			<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
		</div>
	{:else if session.status === 'unreachable' || storage.awaitingFolder}
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
	{:else if resolution === null}
		<p class="p-4">Opening Project “{openDirectory}”…</p>
	{:else}
		<div class="grid grow items-start gap-4 p-4 lg:grid-cols-[24rem_1fr]">
			<div>
				<LayerList
					{layers}
					{outcomes}
					ontypename={(id, name) => session.typeLayerName(id, name)}
					oncommit={() => session.commitLayerEdit()}
					onshow={(id, visible) => session.showLayer(id, visible)}
					ondragopacity={(id, opacity) => session.dragLayerOpacity(id, opacity)}
					onmove={(id, toIndex) => session.moveLayerTo(id, toIndex)}
					ondelete={(id) => void session.deleteLayer(id)}
				/>

				<button
					class="btn mt-4 btn-sm"
					data-testid="add-annotation-layer"
					onclick={() => session.addAnnotationLayer(`Annotations ${annotationLayerCount + 1}`)}
				>
					Add an Annotation Layer
				</button>

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

				<!--
					Back to the Project first, and to the hub second. The stack is where a user notices that
					a Control Point needs fixing — the Historical Map is visibly in the wrong place — and
					without this the only way back to the alignment workspace was out to the hub and in
					again. The Project is addressed by query parameter (ADR-0008), so this is the same link
					`ProjectView` uses to get here, in reverse.
				-->
				<p class="mt-6 flex flex-wrap gap-4">
					<a class="link" data-testid="back-to-project" href="{resolve('/')}?p={openDirectory}">
						Back to this Project
					</a>
					<a class="link" href={resolve('/')}>Back to all Projects</a>
				</p>
			</div>

			<div>
				<div class="h-[36rem] overflow-hidden rounded border border-base-300">
					<BaseMapPane
						entryId={resolution.entry.id}
						layers={drawn}
						overlayPoints={annotationPoints}
						popupAnnotation={selectedAnnotation}
						{popupAt}
						{fetchTile}
						onclickpoint={(point) => void placePoint(point)}
						onclickannotation={(hit) => {
							// Only when nothing is being drawn: with a tool in hand the click places a vertex, and
							// the Annotation underneath is not what the user is pointing at.
							if (drawing.tool !== 'select') return;
							chosenLayerId = hit.layerId;
							selectAnnotation(hit.annotationId, hit.at);
						}}
						onfinishshape={() => void finishShape()}
						onpopupclose={() => (popupAt = null)}
						onstack={(reported) => (rendered = reported)}
					/>
				</div>
				<!--
					What is on the map, in words. `aria-live` rather than `role="status"`, because the save
					indicator already owns that role on this page — the same reason the ingest progress region
					and the pairing prompt are `aria-live` too.
				-->
				<p
					class="mt-2 min-h-6 text-sm"
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
			</div>
		</div>
	{/if}
</div>
