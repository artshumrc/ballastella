// The Project screen's annotation state layer: which Layer is open, what is selected, and every
// function that writes an Annotation (ticket 06, carving out what ticket 05 measured).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A CLASS BESIDE `AnnotationDrawing` RATHER THAN 369 LINES OF `ProjectScreen`
//
// `ProjectScreen.svelte` is four separate subjects sharing one `<script>`: the document-loading
// chain, the opening view, offline availability, and this. Ticket 05 read the file, named this
// block as the one with the fewest edges to the rest — `session`, the `documents` record, and
// `layers` — and left the extraction to 06 rather than trimming prose to hit a line count. This is
// that extraction, with the three edges made explicit as constructor arguments and nothing else
// reachable from here.
//
// **The three edges are functions, not values.** Every one of them is a `$derived` or a `$state`
// owned by the screen, and a value copied in at construction would be the value the screen had at
// mount. Reading through a thunk keeps this class's own deriveds tracking the screen's, which is
// what makes `activeLayer` follow a Layer being deleted and `activeCollection` follow a document
// being read.
//
// **`documents` is read here and replaced through {@link AnnotationEdges.replaceDocument}.** It is
// the one in-memory copy of a Layer's contents — an edit replaces the entry there and the map
// re-renders from it — so there is no second copy that could disagree with what was written. The
// screen owns the record because the map Layers' Alignments live in it too; this class owns only
// the Annotation half of it, and says so by being able to replace one entry rather than the whole
// thing.

import {
	addAnnotation,
	findAnnotation,
	newAnnotation,
	styleForNewAnnotation,
	removeAnnotation,
	insertAnnotationAt,
	setGeometry,
	setLineStyle,
	setStyle,
	setText,
	type AnnotationCollection,
	type AnnotationDeletedUndo,
	type AnnotationGeometry,
	type AnnotationLayer,
	type GeoPoint,
	type Layer,
	type LineStyle,
	type UndoRecord
} from '@ballastella/core';

import type { BaseMapOverlayPoint } from '$lib/base-map/BaseMapPane.svelte';

import { AnnotationDrawing } from './drawing.svelte.js';

/**
 * What this layer needs of `EditorSession`, and nothing more.
 *
 * **Four methods rather than the session**, which is what makes this class testable without one:
 * `EditorSession` is ~2500 lines reaching OPFS, the autosave timer, the undo slot and the Base Map
 * cache, and none of that is a dependency of "put a vertex in a collection and write it".
 * `EditorSession` satisfies this structurally, so nothing is adapted at the call site.
 */
export interface AnnotationWriter {
	readAnnotations(layer: AnnotationLayer): Promise<AnnotationCollection>;
	writeAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		options?: { debounce?: boolean }
	): Promise<void>;
	hasPendingAnnotationWrite(layer: AnnotationLayer): boolean;
	record(record: UndoRecord, apply: () => Promise<void>): void;
}

/** The three edges ticket 05 named, and the one write back through the middle of them. */
export interface AnnotationEdges {
	session: () => AnnotationWriter;
	layers: () => readonly Layer[];
	documents: () => Readonly<Record<string, unknown>>;
	/** Replace one Layer's collection in the screen's `documents` record. */
	replaceDocument: (layerId: string, collection: AnnotationCollection) => void;
}

export class AnnotationEditing {
	/**
	 * ⚠ **Assigned in the constructor and read from field initializers below**, which is what the
	 * `!` is for. A `$derived(…)` initializer is a *thunk* — Svelte evaluates it on first read, long
	 * after the constructor has run — so the ordering TypeScript is warning about is not one that can
	 * happen. Nothing in this class reads a derived during construction.
	 */
	readonly #edges!: AnnotationEdges;

	/** The gesture in progress. Public because the tools and the pane both drive it directly. */
	readonly drawing = new AnnotationDrawing();

	constructor(edges: AnnotationEdges) {
		this.#edges = edges;
	}

	readonly #annotationLayers = $derived(
		this.#edges.layers().filter((layer): layer is AnnotationLayer => layer.kind === 'annotation')
	);

	get annotationLayerCount(): number {
		return this.#annotationLayers.length;
	}

	/**
	 * Which Layer is open in the sidebar — and, for an Annotation Layer, the one being drawn into.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ONE VALUE, NOT TWO
	 *
	 * This used to be `chosenLayerId`, and beside it the sidebar had no notion of a Layer being open at
	 * all: the drawing surface was a panel below the stack with a `<select>` of its own. So "which
	 * Layer am I looking at" and "which Layer am I drawing into" were two facts that could disagree,
	 * and nothing in the interface said which one a click on the map would write to. Ticket 05 makes
	 * opening a Layer *be* choosing it, so there is one value and no way to make it disagree with
	 * itself.
	 *
	 * A **working choice, not a property of the Project**, so it is component state and is not written
	 * anywhere — not to `project.json` and not to `localStorage`. Which Layer somebody happened to have
	 * open is not part of their work, and persisting it would mean a write on a click that changed
	 * nothing (ADR-0010, ADR-0002).
	 */
	openLayerId = $state<string | null>(null);

	selectedAnnotationId = $state<string | null>(null);

	/**
	 * Why an undo did not happen, or `''`.
	 *
	 * The affordance disappears when it is pressed, so an undo that quietly declined to do anything
	 * would look exactly like an undo that worked — and the one thing this feature has to convey is
	 * whether the user's work is back. `UndoControl` announces the success; a refusal has to be said
	 * from here, because it is this screen that knows which Layer the record named.
	 */
	undoRefusal = $state('');

	/**
	 * Where the open popup is anchored, or `null` for none.
	 *
	 * The *place* rather than the popup, because MapLibre's `Popup` belongs inside the pane that owns
	 * the map — the screen says which Annotation is open and where, and the pane puts it on the map. A
	 * page holding a `Popup` would be a second thing reaching into MapLibre from outside it.
	 */
	popupAt = $state.raw<GeoPoint | null>(null);

	/**
	 * The open Layer, when it is an Annotation Layer. `null` when nothing is open, when a map or a
	 * `foreign` Layer is open, and when the open Layer has since been deleted.
	 *
	 * **No fallback to the topmost Annotation Layer**, which is what this had before and is exactly the
	 * disagreement above: a Layer that is "chosen" while its row is closed is a Layer the user is not
	 * looking at, and the drawing tools now live inside the row, so there is nothing to draw with until
	 * one is open.
	 */
	readonly #activeLayer = $derived<AnnotationLayer | null>(
		this.#annotationLayers.find((layer) => layer.id === this.openLayerId) ?? null
	);

	get activeLayer(): AnnotationLayer | null {
		return this.#activeLayer;
	}

	/**
	 * The active Layer's Annotations.
	 *
	 * Read out of `documents`, which is the **one** in-memory copy: an edit replaces the entry there and
	 * the map re-renders from it, so there is no second copy of a Layer's contents that could disagree
	 * with what was written. That is the same rule `EditorSession` follows for `project.json`.
	 */
	readonly #activeCollection = $derived<AnnotationCollection | null>(
		this.#activeLayer === null
			? null
			: ((this.#edges.documents()[this.#activeLayer.id] as AnnotationCollection | undefined) ??
					null)
	);

	get activeCollection(): AnnotationCollection | null {
		return this.#activeCollection;
	}

	readonly #selectedAnnotation = $derived(
		this.#activeCollection && this.selectedAnnotationId
			? (findAnnotation(this.#activeCollection, this.selectedAnnotationId) ?? null)
			: null
	);

	get selectedAnnotation() {
		return this.#selectedAnnotation;
	}

	/**
	 * Open a Layer, or close whatever is open.
	 *
	 * Opening a different Layer abandons a part-drawn shape and clears the selection with it, which is
	 * what choosing another Layer to draw into has always done — the gesture in progress belongs to the
	 * Layer that is being left, and carrying it across would drop it into a file the user was not
	 * drawing in. Closing does the same for the same reason: the tools go off the screen with the row.
	 *
	 * **Every Layer kind, not only an Annotation Layer.** The sidebar opens one row at a time whatever
	 * is in it (ticket 05), and `openLayerId` is that one value — so this lives here, with the value,
	 * rather than beside the stack.
	 */
	openLayer(id: string | null): void {
		this.openLayerId = id;
		this.selectedAnnotationId = null;
		this.popupAt = null;
		this.drawing.cancel();
	}

	/**
	 * Select an Annotation, and where asked, show what it says.
	 *
	 * The popup is the reader-facing surface and is shown to the author too, because an author needs to
	 * see what a reader will — it is the only place the rendered Markdown appears over the map rather
	 * than beside it. Selecting from the list opens no popup: there is no place on the map the user
	 * pointed at, and one appearing at an arbitrary coordinate would be worse than none.
	 */
	selectAnnotation(id: string | null, at: GeoPoint | null = null): void {
		this.selectedAnnotationId = id;
		this.popupAt = id === null ? null : at;
	}

	/**
	 * An Annotation was clicked on the map: open the Layer it lives in and select it.
	 *
	 * **Not routed through {@link openLayer}**, which clears the selection — and a selection is
	 * precisely what this is making. Nothing is part-drawn here: the caller's guard is that the select
	 * tool is in hand.
	 */
	openFromMap(layerId: string, annotationId: string, at: GeoPoint | null): void {
		this.openLayerId = layerId;
		this.selectAnnotation(annotationId, at);
	}

	/** Replace the active Layer's collection in memory and write it. */
	async commitAnnotations(
		next: AnnotationCollection,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const layer = this.#activeLayer;
		if (!layer) return;
		await this.commitAnnotationsIn(layer, next, options);
	}

	/**
	 * The same, into a Layer named outright rather than whichever one is chosen.
	 *
	 * **Undo is why this exists**, and it is the only caller that needs it: an `AnnotationDeletedUndo`
	 * carries the Layer the Annotation was in precisely so it cannot be restored into another one, and
	 * the picker may well have moved between the deletion and the undo. Everything else edits what the
	 * user is looking at, which is what {@link commitAnnotations} is for.
	 */
	async commitAnnotationsIn(
		layer: AnnotationLayer,
		next: AnnotationCollection,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		if (next === this.#edges.documents()[layer.id]) return;
		this.#edges.replaceDocument(layer.id, next);
		await this.#edges.session().writeAnnotations(layer, next, options);
	}

	/**
	 * A place on the earth the user asked for — a click, or Enter over the pane.
	 *
	 * With a drawing tool active this places a vertex; with the select tool it does nothing, and the
	 * Annotation hit (if any) is what {@link selectAnnotation} handles. One write happens here and only
	 * for a pin, whose gesture is complete at one point; a line and a shape are written by
	 * {@link finishShape}, which is ADR-0017 rule 1's "the gesture is over".
	 */
	async placePoint(point: GeoPoint): Promise<void> {
		if (this.drawing.tool === 'select') return;
		const finished = this.drawing.place(point);
		if (finished !== null) await this.#addDrawn(finished);
	}

	/** End a line or a shape, and keep it. */
	async finishShape(): Promise<void> {
		const finished = this.drawing.finish();
		if (finished !== null) await this.#addDrawn(finished);
	}

	/**
	 * Drop a Pin at a Place the scholar looked up, titled with what they typed (ADR-0029).
	 *
	 * **Through {@link #addDrawn}, not around it**, so style inheritance, the selection, and the write
	 * path are the ones the suite already asserts rather than a second implementation of each. The
	 * result is an ordinary Annotation: nothing here records that a lookup was involved, and a Pin
	 * placed this way is byte-identical to one drawn by hand and given the same title.
	 *
	 * **The title travels with the creation**, which is why {@link #addDrawn} takes one. Adding the
	 * Annotation and then setting its title would be two commits for one gesture — ADR-0017 rule 1,
	 * which this repository asserts by counting writes.
	 *
	 * The camera is the page's: placing always frames, and it frames through the same opening-view fit
	 * everything else uses.
	 */
	async placePin(point: GeoPoint, title: string): Promise<void> {
		await this.#addDrawn({ type: 'Point', coordinates: [point.lng, point.lat] }, title);
	}

	/**
	 * Put a finished geometry in the Layer as a new Annotation, and select it so it can be titled.
	 *
	 * **It is drawn with the last one's style** (ADR-0009, as amended). That is the whole of what
	 * replaced a Layer's `defaultStyle`: pick a colour once and everything drawn after it is that
	 * colour, without a control named "default" and without anything being inherited at read time.
	 * `styleForNewAnnotation` is in `core` so the rule is stated once, beside the resolution it
	 * replaced.
	 *
	 * @param title what it is called, for a caller that already knows — without one no `title`
	 *   property is written at all, which is what a shape drawn on the map is. **One write either
	 *   way**: a creation followed by a retitle is two, and {@link placePin} exists in the shape it
	 *   does because of it.
	 */
	async #addDrawn(geometry: AnnotationGeometry, title?: string): Promise<void> {
		const collection = this.#activeCollection ?? { annotations: [] };
		const annotation = newAnnotation({
			id: crypto.randomUUID(),
			geometry,
			title,
			style: styleForNewAnnotation(collection)
		});
		this.selectedAnnotationId = annotation.id;
		this.popupAt = null;
		await this.commitAnnotations(addAnnotation(collection, annotation));
	}

	/**
	 * The overlay points on the Base Map: the shape being drawn, and the selected Annotation's vertices.
	 *
	 * On the same seam as a Control Point and a Resource Mask corner, which is what gives every vertex a
	 * named `<button>`, arrow-key movement, Delete, and one store write per gesture without any of it
	 * being written here — see `drawing.svelte.ts` for why this rather than a WebGL drawing library.
	 */
	readonly #points = $derived.by((): BaseMapOverlayPoint[] => {
		const points: BaseMapOverlayPoint[] = [];

		// The vertices placed so far in the gesture in progress. Not operable: the next click on one of
		// them is the click that places the next vertex.
		this.drawing.vertices.forEach((vertex, index) => {
			points.push({
				key: `annotation-draft-${index}`,
				point: vertex,
				kind: 'annotation-draft',
				ordinal: index + 1,
				label: `Point ${index + 1} of the shape being drawn`
			});
		});

		const annotation = this.#selectedAnnotation;
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
					`Point ${index + 1} of ${positions.length} of ${this.annotationName(annotation.id)}. ` +
					'Arrow keys move it.',
				// **Once, on gesture end.** Pointer-up, or the release of a held arrow key — never per
				// pointer-move, which is what makes "one edit is one store write" a number the suite counts.
				onmoveend: (to) => void this.reshape(index, to)
			});
		});

		return points;
	});

	get annotationPoints(): BaseMapOverlayPoint[] {
		return this.#points;
	}

	/** What an Annotation is called, for a handle's accessible name. */
	annotationName(id: string): string {
		const collection = this.#activeCollection;
		const annotation = collection ? findAnnotation(collection, id) : undefined;
		return annotation?.properties.title || 'this Annotation';
	}

	/** Move one vertex of the selected Annotation, writing once. */
	async reshape(index: number, to: GeoPoint): Promise<void> {
		const collection = this.#activeCollection;
		const annotation = this.#selectedAnnotation;
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
		await this.commitAnnotations(setGeometry(collection, annotation.id, next));
	}

	/**
	 * Delete the selected Annotation, recording what it takes away.
	 *
	 * The record holds the Annotation itself, so every one of its `properties` comes back — including
	 * `stroke-dasharray`, where "solid" is the property being *absent* (ADR-0009): an undo that rebuilt
	 * the Annotation from the controls' current values would silently turn a dotted conjectural route
	 * into a solid certain one.
	 */
	async deleteSelected(): Promise<void> {
		const collection = this.#activeCollection;
		const layer = this.#activeLayer;
		const id = this.selectedAnnotationId;
		if (!collection || !layer || !id) return;
		const at = collection.annotations.findIndex((one) => one.id === id);
		const annotation = collection.annotations[at];
		// A refusal is about the record that is being replaced, so it goes with it.
		this.undoRefusal = '';
		this.selectedAnnotationId = null;
		this.popupAt = null;
		await this.commitAnnotations(removeAnnotation(collection, id));
		if (!annotation) return;
		const record: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: layer.id,
			at,
			annotation
		};
		// Recorded *after* the write, so a deletion the store refused is not offered as something to undo
		// — the same discipline `writeAlignment` follows when it counts a write.
		this.#edges.session().record(record, () => this.restoreDeleted(record));
	}

	/**
	 * Put a deleted Annotation back **into the Layer it was deleted from**.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THE RECORD NAMES THE LAYER AND THIS READS IT
	 *
	 * {@link openLayerId} is a working choice the user is free to change, and nothing stops them
	 * changing it between the deletion and the undo — another Layer's row is a few pixels from the
	 * affordance. An undo that wrote into whichever Layer happened to be open would take an Annotation
	 * out of one `.geojson` and put it into another, which is not an undo of anything: it is a move the
	 * user did not ask for, into a file they were not looking at. `AnnotationDeletedUndo.layerId` exists
	 * for exactly this, and this is where it is spent.
	 *
	 * The sidebar follows the record rather than the other way round — the Layer the Annotation came
	 * from is *opened* — so the user watches the Annotation come back instead of being told it did, the
	 * same reason `AlignmentPairing.restore` selects the pair it put back.
	 *
	 * Restored into that Layer's collection **as it is now** rather than into a snapshot: whatever else
	 * has been drawn or edited in it since must survive an undo of one deletion.
	 */
	async restoreDeleted(record: AnnotationDeletedUndo): Promise<void> {
		this.undoRefusal = '';
		const layer = this.#annotationLayers.find((one) => one.id === record.layerId);
		if (!layer) {
			// Not reachable through the interface — deleting a Layer is itself one of the four recorded
			// actions, so it replaces this record rather than orphaning it. Said rather than silently
			// redirected all the same, because the alternative to saying so is writing the Annotation into
			// a Layer the user never deleted it from.
			this.undoRefusal =
				`The Annotation could not be put back: the Annotation Layer it was in is no longer in ` +
				'this Project.';
			return;
		}
		let collection = this.#edges.documents()[layer.id] as AnnotationCollection | undefined;
		if (collection === undefined) {
			// Only a Layer that has since been hidden gets here: `documents` holds the Layers the map is
			// given, and a hidden one is absent from it. Read rather than assumed empty — assuming would
			// write a file holding one Annotation over a file holding twenty.
			try {
				collection = await this.#edges.session().readAnnotations(layer);
			} catch (cause) {
				this.undoRefusal =
					`The Annotation could not be put back: ${layer.name || 'its Annotation Layer'} could ` +
					`not be read. ${cause instanceof Error ? cause.message : String(cause)}`;
				return;
			}
		}
		this.openLayerId = layer.id;
		this.selectedAnnotationId = record.annotation.id;
		this.popupAt = null;
		await this.commitAnnotationsIn(
			layer,
			insertAnnotationAt(collection, record.annotation, record.at)
		);
	}

	/** Type into the title or the description. Coalesced per file (ADR-0017 rule 2). */
	async typeText(text: { title?: string; description?: string }): Promise<void> {
		const collection = this.#activeCollection;
		const id = this.selectedAnnotationId;
		if (!collection || !id) return;
		await this.commitAnnotations(setText(collection, id, text), { debounce: true });
	}

	/**
	 * The edit is over — a field blurred, Enter was pressed, or a slider was released.
	 *
	 * A no-op unless something is waiting to be written, which is the same guard `commitLayerEdit` and
	 * `commitProjectName` both carry: tabbing through a title field is *looking*, and ADR-0010 is
	 * explicit that merely looking at an old Project must not modify a single byte of it.
	 */
	async commitAnnotationEdit(): Promise<void> {
		const layer = this.#activeLayer;
		const collection = this.#activeCollection;
		if (!layer || !collection) return;
		if (!this.#edges.session().hasPendingAnnotationWrite(layer)) return;
		await this.#edges.session().writeAnnotations(layer, collection);
	}

	/** Set style properties on the selected Annotation, by their exact simplestyle names. */
	async styleSelected(
		style: Record<string, unknown>,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const collection = this.#activeCollection;
		const id = this.selectedAnnotationId;
		if (!collection || !id) return;
		await this.commitAnnotations(setStyle(collection, id, style), options);
	}

	/** Set the selected Annotation's line style. Stores the tuple; solid is its absence (ADR-0009). */
	async lineStyleSelected(line: LineStyle): Promise<void> {
		const collection = this.#activeCollection;
		const id = this.selectedAnnotationId;
		if (!collection || !id) return;
		await this.commitAnnotations(setLineStyle(collection, id, line));
	}
}
