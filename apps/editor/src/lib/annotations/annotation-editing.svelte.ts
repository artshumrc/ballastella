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
	styleForNewLabel,
	removeAnnotation,
	moveAnnotation,
	setGeometry,
	setLineStyle,
	setStyle,
	setText,
	type Annotation,
	type AnnotationCollection,
	type AnnotationGeometry,
	type AnnotationLayer,
	type GeoPoint,
	type Layer,
	type LineStyle
} from '@ballastella/core';

import type { AnnotationDragPreview, BaseMapOverlayPoint } from '$lib/base-map/BaseMapPane.svelte';

import { AnnotationDrawing } from './drawing.svelte.js';

/**
 * What this layer needs of `EditorSession`, and nothing more.
 *
 * **Three methods rather than the session**, which is what makes this class testable without one:
 * `EditorSession` is ~2500 lines reaching OPFS, the autosave timer, the Edit Histories and the Base
 * Map cache, and none of that is a dependency of "put a vertex in a collection and write it".
 * `EditorSession` satisfies this structurally, so nothing is adapted at the call site.
 *
 * **A `label` is how a gesture becomes a Step**, and it is the whole of what this class knows about
 * an Edit History (ADR-0039): the sentence the bar will say is built where the gesture is, and the
 * session turns it into a Step over the one file it writes. No label, no Step — which is what keeps
 * a typed title out of the history without this class naming what it is not.
 */
export interface AnnotationWriter {
	readAnnotations(layer: AnnotationLayer): Promise<AnnotationCollection>;
	writeAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		options?: { debounce?: boolean; label?: string }
	): Promise<void>;
	hasPendingAnnotationWrite(layer: AnnotationLayer): boolean;
}

/** The three edges ticket 05 named, and the one write back through the middle of them. */
export interface AnnotationEdges {
	session: () => AnnotationWriter;
	layers: () => readonly Layer[];
	documents: () => Readonly<Record<string, unknown>>;
	/** Replace one Layer's collection in the screen's `documents` record. */
	replaceDocument: (layerId: string, collection: AnnotationCollection) => void;
}

/**
 * The sentence an Edit History's controls say about a gesture on one Annotation (SPEC story 42).
 *
 * Verb, then subject, in the scholar's own words where they typed them — the convention every Step
 * in this application follows, and `quotedName`'s rule for a Layer beside it: quotation marks around
 * a title somebody typed, and a phrase naming the thing where they typed none. An untitled shape
 * reads in the bar the way it already reads in the prose this class writes for its vertices.
 */
const undoLabel = (verb: string, annotation: Annotation): string => {
	const title = annotation.properties.title;
	const subject = title === undefined || title === '' ? 'this Annotation' : `“${title}”`;
	return `Undo ${verb} ${subject}`;
};

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

	/** Geometry used only to repaint an Annotation while one of its vertices is being dragged. */
	dragPreview = $state<AnnotationDragPreview | null>(null);

	/**
	 * The Annotation drawn a moment ago, whose title is where the keyboard belongs.
	 *
	 * Titling a shape straight after drawing it is one gesture (the-annotation-inspector story 40), and
	 * an id rather than a flag because the surface that opens has to be able to tell "this is the shape
	 * that was just drawn" from "this is an Annotation somebody selected to read". `null` again the
	 * moment anything else is selected, so a read gesture never produces a form.
	 *
	 * ⚠ **Spent when the title field takes the keyboard, and not only when the selection moves.** The
	 * Inspector's Text face is unmounted while the Style face shows and mounted again on the way back, so
	 * an offer that outlived being taken up dragged the keyboard into a title field on a press of *Text*
	 * — with the same shape still selected, minutes after it was drawn. `AnnotationTextFace`'s `ontitled`
	 * reports that it has been taken up, and the screen clears this. One gesture, one offer.
	 */
	titlingId = $state<string | null>(null);

	/**
	 * Why an Annotation could not be moved into another Layer, or `''`.
	 *
	 * The one thing that can refuse a move is a target Layer whose file will not read — see
	 * {@link moveAnnotationToLayer}, which will not write a Layer holding one Annotation over a Layer
	 * holding twenty.
	 */
	moveRefusal = $state('');

	/**
	 * Where the last Annotation to change Layers went, or `''`.
	 *
	 * Announced rather than drawn: the screen already shows the move by opening the target Layer with
	 * the Annotation selected in it, and what a screen-reader user gets from that alone is a sidebar
	 * that has silently rearranged itself.
	 */
	moveNotice = $state('');

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
	 * Where the selected Annotation sits in the open Layer's collection, or `-1` when none is.
	 *
	 * The *collection's* position rather than a number of its own, because it is what the row's ordinal,
	 * the mark on the map and the Inspector's header are all drawn from: one Annotation, one number
	 * (the-annotation-inspector story 2).
	 */
	readonly #selectedIndex = $derived(
		this.#activeCollection && this.selectedAnnotationId
			? this.#activeCollection.annotations.findIndex((one) => one.id === this.selectedAnnotationId)
			: -1
	);

	get selectedIndex(): number {
		return this.#selectedIndex;
	}

	/**
	 * Whether this build can draw the selected Annotation's shape.
	 *
	 * Read for one thing: an Annotation this build cannot draw is offered no Style face at all, rather
	 * than a Style face that explains its own emptiness (the-annotation-inspector story 28). A foreign
	 * document may carry a `GeometryCollection`, and its shape is written back untouched either way.
	 */
	get selectedIsDrawable(): boolean {
		const type = this.#selectedAnnotation?.geometry?.type;
		return type === 'Point' || type === 'LineString' || type === 'Polygon';
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
		this.dragPreview = null;
		this.selectAnnotation(null);
		// **Rest, not `cancel()`.** Cancelling is a no-op when nothing is part-drawn, which leaves the
		// shapes on offer in a Layer where "New Annotation" was never pressed — and no way out of them
		// but a "Done" the scholar never asked for.
		this.drawing.returnToRest();
	}

	/**
	 * Select an Annotation, which is the same act as opening its row (ticket 07).
	 *
	 * One value rather than two: the selected Annotation is the open row, wherever the selection was
	 * made. Nothing is drawn over the map for it — a click on a shape is answered in the sidebar,
	 * which is where an Annotation is read in both apps.
	 */
	selectAnnotation(id: string | null): void {
		this.selectedAnnotationId = id;
		this.dragPreview = null;
		// Whatever this is, it is not the shape that was just drawn: only {@link #addDrawn} says that,
		// and it says it after calling this.
		this.titlingId = null;
		// The drawing's "… added, and selected so it can be titled" announcement claims a shape *is* the
		// selection, so it stops being true here — a deselection, a deletion, and the next Annotation
		// somebody opens to read all pass through. {@link #addDrawn} restates it after selecting what it
		// drew, which is the one selection the sentence survives.
		this.drawing.added = null;
	}

	/**
	 * Let go of a selection the Layer's document no longer holds (SPEC stories 52, 53).
	 *
	 * Called where a Layer's collection has just been read again, which is how an Edit History's
	 * write-back reaches this screen: a Step holds file images and writes one back, so the Annotation
	 * a scholar had open can simply cease to exist — undone into a state it was never in, or redone
	 * out of one it was.
	 *
	 * **One test for both ends of the selection.** The Inspector is drawn from `selectedAnnotation`
	 * and the Annotation list's highlight from `selectedAnnotationId`, so a panel describing something
	 * that is not there and a row still marked as chosen are the same fault; clearing the one value
	 * both are read from is what makes them unable to disagree. The leader line follows the selection
	 * and needs no rule of its own.
	 *
	 * **Silent.** The toast already says what was undone, and a second message about a panel closing
	 * is noise.
	 */
	releaseMissingSelection(): void {
		const id = this.selectedAnnotationId;
		if (id === null) return;
		const collection = this.#activeCollection;
		// A Layer whose document is not in hand — hidden, or still being read — says nothing about
		// whether the selection is still there, and letting go on it would drop a selection over a read.
		if (!collection) return;
		if (findAnnotation(collection, id)) return;
		this.selectAnnotation(null);
	}

	/**
	 * An Annotation was clicked on the map: open the Layer it lives in and select it.
	 *
	 * **Not routed through {@link openLayer}**, which clears the selection — and a selection is
	 * precisely what this is making. Nothing is part-drawn here: the caller's guard is that the select
	 * tool is in hand.
	 */
	openFromMap(layerId: string, annotationId: string): void {
		this.openLayerId = layerId;
		this.selectAnnotation(annotationId);
	}

	/**
	 * Replace the active Layer's collection in memory and write it.
	 *
	 * `options.label` makes the write one Step of the Project's Edit History, over the Layer's own
	 * `.geojson` and nothing else. **The memory half happens outside it**, in
	 * {@link commitAnnotationsIn}: a Step's `before` image is read from the store, so the gesture's
	 * bytes must not reach the store until that read has happened — but the map must repaint with the
	 * gesture rather than after a store read, which is the same split `#applyLayerChange` makes for
	 * the Layer stack.
	 */
	async commitAnnotations(
		next: AnnotationCollection,
		options: { debounce?: boolean; label?: string } = {}
	): Promise<void> {
		const layer = this.#activeLayer;
		if (!layer) return;
		await this.commitAnnotationsIn(layer, next, options);
	}

	/**
	 * The same, into a Layer named outright rather than whichever one is chosen.
	 *
	 * **Moving an Annotation between Layers is why this exists**, and it is the only caller that needs
	 * it: the gesture writes two named Layers' collections, neither of them necessarily the one chosen.
	 * Everything else edits what the user is looking at, which is what {@link commitAnnotations} is
	 * for.
	 */
	async commitAnnotationsIn(
		layer: AnnotationLayer,
		next: AnnotationCollection,
		options: { debounce?: boolean; label?: string } = {}
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
		// Read before the placement, because completing a gesture disarms the tool: one press of "New
		// Annotation" makes one Annotation, so by the time `place` returns the tool in hand is `select`.
		const label = this.drawing.tool === 'text';
		const finished = this.drawing.place(point);
		if (finished !== null) await this.#addDrawn(finished, { label });
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
		// No gesture ended here — this Pin came from a lookup, not from a tool — so there is nothing for
		// the announcement to report, and a sentence left over from the last shape drawn would name that
		// shape while pointing at this Pin.
		this.drawing.added = null;
		await this.#addDrawn({ type: 'Point', coordinates: [point.lng, point.lat] }, { title });
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
	 * **The `marker-symbol` that makes a Point a Label is written here and nowhere else** (SPEC, "
	 * `marker-symbol` stops being inherited by a newly drawn Annotation"): it says what kind of thing
	 * this is, so it belongs to the tool in hand rather than to whatever was drawn last.
	 * `styleForNewAnnotation` no longer copies it, which is what makes drawing a Pin straight after a
	 * Label give a Pin.
	 *
	 * @param options.title what it is called, for a caller that already knows — without one no `title`
	 *   property is written at all, which is what a shape drawn on the map is. **One write either
	 *   way**: a creation followed by a retitle is two, and {@link placePin} exists in the shape it
	 *   does because of it.
	 * @param options.label whether the Label tool drew this. The other three tools write no
	 *   `marker-symbol` at all.
	 */
	async #addDrawn(
		geometry: AnnotationGeometry,
		options: { title?: string; label?: boolean } = {}
	): Promise<void> {
		const { title, label = false } = options;
		const collection = this.#activeCollection ?? { annotations: [] };
		const annotation = newAnnotation({
			id: crypto.randomUUID(),
			geometry,
			title,
			style: label ? styleForNewLabel(collection) : styleForNewAnnotation(collection)
		});
		// Captured across the selection below, which retires the announcement for every other caller.
		// This one selection is what the sentence claims, so it is the one the sentence survives.
		const added = this.drawing.added;
		this.selectAnnotation(annotation.id);
		this.drawing.added = added;
		// **Straight into its title, unless it arrived with one.** A shape drawn on the map is untitled
		// and titling it is the next gesture; a Pin dropped on a Place already carries the words the
		// scholar typed, so opening a field on them would be an edit nobody asked for.
		if (title === undefined) this.titlingId = annotation.id;
		await this.commitAnnotations(addAnnotation(collection, annotation), {
			label: undoLabel('drawing', annotation)
		});
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
				onmove: (to) => this.previewReshape(index, to),
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
		const layer = this.#activeLayer;
		const annotation = this.#selectedAnnotation;
		const geometry = annotation?.geometry;
		if (!collection || !layer || !annotation || !geometry || geometry.type === 'foreign') {
			this.dragPreview = null;
			return;
		}

		const next = this.#geometryWithVertex(geometry, index, to);
		const write = this.commitAnnotations(setGeometry(collection, annotation.id, next), {
			label: undoLabel('moving', annotation)
		});
		this.dragPreview = null;
		await write;
	}

	/** Repaint the selected Annotation at a vertex's current drag position without writing it. */
	previewReshape(index: number, to: GeoPoint): void {
		const layer = this.#activeLayer;
		const annotation = this.#selectedAnnotation;
		const geometry = annotation?.geometry;
		if (!layer || !annotation || !geometry || geometry.type === 'foreign') return;
		this.dragPreview = {
			layerId: layer.id,
			annotationId: annotation.id,
			geometry: this.#geometryWithVertex(geometry, index, to)
		};
	}

	#geometryWithVertex(
		geometry: Exclude<AnnotationGeometry, { type: 'foreign' } | null>,
		index: number,
		to: GeoPoint
	): AnnotationGeometry {
		const moved: [number, number] = [to.lng, to.lat];
		if (geometry.type === 'Point') {
			return { type: 'Point', coordinates: moved };
		} else if (geometry.type === 'LineString') {
			const positions = geometry.coordinates.map((position, at) =>
				at === index ? moved : position
			);
			return { type: 'LineString', coordinates: positions };
		} else {
			const ring = (geometry.coordinates[0] ?? []).slice(0, -1);
			const positions = ring.map((position, at) => (at === index ? moved : position));
			// Closed again, because a LinearRing whose ends differ is what other tools reject.
			return {
				type: 'Polygon',
				coordinates: [[...positions, positions[0] ?? moved], ...geometry.coordinates.slice(1)]
			};
		}
	}

	/**
	 * The Annotation Layers an Annotation in the open one could be moved into.
	 *
	 * Every Annotation Layer but the open one, which is the Layer the Annotation is already in — a
	 * picker offering it would be offering a move to where the Annotation already is.
	 */
	get moveTargets(): readonly { id: string; name: string }[] {
		return this.#annotationLayers
			.filter((layer) => layer.id !== this.openLayerId)
			.map((layer) => ({ id: layer.id, name: layer.name }));
	}

	/**
	 * Move an Annotation to a position in the open Layer's collection.
	 *
	 * The order of a `FeatureCollection` is the order its shapes draw in, so this is the gesture that
	 * decides which of two overlapping Annotations is on top — the same thing the Layer stack decides
	 * one level up (ADR-0002). One write, at the end of the gesture, which is ADR-0017 rule 1: a drag
	 * reports where it was dropped and not where it passed over.
	 */
	async moveAnnotationTo(id: string, toIndex: number): Promise<void> {
		const collection = this.#activeCollection;
		if (!collection) return;
		await this.commitAnnotations(moveAnnotation(collection, id, toIndex));
	}

	/**
	 * Move an Annotation out of the open Layer and into another one.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * TWO FILES, AND THE ORDER THEY ARE WRITTEN IN
	 *
	 * This is the one Annotation gesture that touches two documents, so there is a moment between the
	 * two writes and the question is what a failure in that moment leaves behind. The Annotation is
	 * put into its new Layer **first** and taken out of the old one second: a failure between them
	 * leaves the Annotation in both Layers, which a scholar can see and delete, where the other order
	 * leaves it in neither and the work is simply gone. It is the discipline `addAnnotationLayer` and
	 * the ingest chain both follow — the document whose loss is not recoverable goes last.
	 *
	 * The target's collection is **read** when it is not already in memory rather than assumed empty.
	 * `documents` holds the Layers the map is given, so a hidden Layer is absent from it, and assuming
	 * would write a file holding one Annotation over a file holding twenty.
	 *
	 * The sidebar follows the Annotation: the target Layer is opened and the Annotation selected in
	 * it, so the user watches where their work went instead of being told — the row simply vanishing
	 * from the list it was in is exactly what a move nobody meant to make would look like.
	 */
	async moveAnnotationToLayer(id: string, toLayerId: string): Promise<void> {
		this.moveRefusal = '';
		this.moveNotice = '';
		const from = this.#activeLayer;
		const collection = this.#activeCollection;
		const to = this.#annotationLayers.find((layer) => layer.id === toLayerId);
		if (!from || !collection || !to || to.id === from.id) return;
		const annotation = findAnnotation(collection, id);
		if (!annotation) return;

		let target = this.#edges.documents()[to.id] as AnnotationCollection | undefined;
		if (target === undefined) {
			try {
				target = await this.#edges.session().readAnnotations(to);
			} catch (cause) {
				this.moveRefusal =
					`The Annotation was not moved: ${to.name || 'the Annotation Layer'} could not be read. ` +
					`${cause instanceof Error ? cause.message : String(cause)}`;
				return;
			}
		}

		await this.commitAnnotationsIn(to, addAnnotation(target, annotation));
		await this.commitAnnotationsIn(from, removeAnnotation(collection, id));
		this.openLayerId = to.id;
		this.selectAnnotation(id);
		this.moveNotice =
			`${annotation.properties.title || 'The Annotation'} moved to ` +
			`${to.name || 'an untitled Annotation Layer'}.`;
	}

	/**
	 * Delete the selected Annotation, as one Step of the Project's Edit History.
	 *
	 * The Step holds the file either side of the deletion, so every one of the Annotation's
	 * `properties` comes back — including `stroke-dasharray`, where "solid" is the property being
	 * *absent* (ADR-0009): an undo that rebuilt the Annotation from the controls' current values would
	 * silently turn a dotted conjectural route into a solid certain one.
	 *
	 * **Nothing is recorded after the write, because nothing has to be.** A deletion the store refuses
	 * leaves the file as `step()` found it, and `step()` pushes no Step for that — so a refused
	 * deletion cannot reach the bar as something to take back.
	 */
	async deleteSelected(): Promise<void> {
		const collection = this.#activeCollection;
		const id = this.selectedAnnotationId;
		if (!collection || !id) return;
		const annotation = findAnnotation(collection, id);
		if (!annotation) return;
		this.selectAnnotation(null);
		await this.commitAnnotations(removeAnnotation(collection, id), {
			label: undoLabel('delete of', annotation)
		});
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

	/**
	 * Set style properties on the selected Annotation, by their exact simplestyle names.
	 *
	 * **A discrete choice is one Step; a slider still under the pointer is not.** `debounce` is the
	 * caller saying the gesture is not over (ADR-0017 rule 2), and a Step per position a range
	 * reported would spend a five-deep history on one drag. So a colour, a marker size and a line
	 * style each open a Step, and what a released slider leaves behind is the `before` image of
	 * whichever gesture comes next.
	 */
	async styleSelected(
		style: Record<string, unknown>,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const collection = this.#activeCollection;
		const id = this.selectedAnnotationId;
		if (!collection || !id) return;
		const annotation = findAnnotation(collection, id);
		if (!annotation) return;
		await this.commitAnnotations(setStyle(collection, id, style), {
			...options,
			...(options.debounce ? {} : { label: undoLabel('restyling', annotation) })
		});
	}

	/** Set the selected Annotation's line style. Stores the tuple; solid is its absence (ADR-0009). */
	async lineStyleSelected(line: LineStyle): Promise<void> {
		const collection = this.#activeCollection;
		const id = this.selectedAnnotationId;
		if (!collection || !id) return;
		const annotation = findAnnotation(collection, id);
		if (!annotation) return;
		await this.commitAnnotations(setLineStyle(collection, id, line), {
			label: undoLabel('restyling', annotation)
		});
	}
}
