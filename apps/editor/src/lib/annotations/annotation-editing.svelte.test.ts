// The editor's first unit test, and the reason the seam was worth adding (ticket 06).
//
// Every one of these reaches a branch the browser suite either cannot reach or reaches only
// expensively: a Layer deleted between a deletion and its undo, a *hidden* Layer's file being read
// rather than assumed empty, a commit-on-blur that must write nothing. Each is a data-loss path —
// an Annotation written into the wrong file, or a file holding twenty Annotations overwritten with
// one — and none of them has a gesture in the interface that produces it on demand.
//
// The fake writer is four methods, which is the whole of what this class asks of `EditorSession`.
// That is the measurement of the carve: 369 lines of the Project screen now depend on four
// functions rather than on a 2500-line session, OPFS, and a map.
//
// ⚠ **`.svelte.test.ts`, not `.test.ts`, and that is load-bearing.** `screen()` below builds the
// screen's `layers` edge out of `$state`, because the class's `$derived`s track *signals* and a
// plain array carries none — a test that hands this class a plain array asserts nothing about a
// derived, whichever way the derived happens to be compiled. Runes are only compiled in a file
// whose name carries the `.svelte.` infix, which the plugin's module filter accepts anywhere
// before the extension. See `vitest.config.ts` for the other half of this: which Svelte runtime
// the project compiles to, and why the default one made the reactivity assertions vacuous.

import {
	DEFAULT_ANNOTATION_COLOR,
	MemoryProjectStore,
	annotationPath,
	newProjectFile,
	projectFilePath,
	serialiseProjectFile,
	newAnnotation,
	newAnnotationLayer,
	parseAnnotations,
	serialiseAnnotations,
	simpleStyleViolations,
	type Annotation,
	type AnnotationCollection,
	type AnnotationProperties,
	type AnnotationGeometry,
	type AnnotationLayer,
	type Bytes,
	type Layer,
	type StorePath
} from '@ballastella/core';
import { describe, expect, it } from 'vitest';

import { EditorSession } from '../editor-session.svelte.js';

import { AnnotationEditing, type AnnotationWriter } from './annotation-editing.svelte.js';

/** Every write this class made, in order, so "one gesture is one write" is a count. */
interface Write {
	layerId: string;
	collection: AnnotationCollection;
	debounce: boolean;
	/** The sentence the Edit History's controls would say, or `undefined` for a write that is no Step. */
	label: string | undefined;
	/** The drag this position belongs to, or `undefined` for a write that is not one. */
	drag?: { key: string; label: string };
}

class FakeWriter implements AnnotationWriter {
	readonly writes: Write[] = [];
	/** What is on disk for a Layer this screen has not read, keyed by Layer id. */
	readonly onDisk = new Map<string, AnnotationCollection>();
	/** Layer ids whose read throws, standing in for a file that is there and unreadable. */
	readonly unreadable = new Set<string>();
	pending = false;

	async readAnnotations(layer: AnnotationLayer): Promise<AnnotationCollection> {
		if (this.unreadable.has(layer.id)) throw new Error('the file could not be decoded');
		return this.onDisk.get(layer.id) ?? { annotations: [] };
	}

	async writeAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		options: { debounce?: boolean; label?: string } = {}
	): Promise<void> {
		this.writes.push({
			layerId: layer.id,
			collection,
			debounce: options.debounce === true,
			label: options.label
		});
	}

	/**
	 * One position of a drag. Recorded as the debounced, Step-less write it is on the wire — the Step
	 * spans the gesture and is the real session's to hold — with the drag it belongs to beside it, so
	 * a test can count gestures as well as writes.
	 */
	async dragAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		drag: { key: string; label: string }
	): Promise<void> {
		this.writes.push({ layerId: layer.id, collection, debounce: true, label: undefined, drag });
	}

	/**
	 * The two-document move. Recorded as the two writes it makes, each carrying the *same* label —
	 * which is how a test sees that the pair is one Step rather than two: the real session opens one
	 * `step()` over both paths, and two labels here would mean two entries in the history.
	 */
	async moveAnnotationBetweenLayers(
		to: AnnotationLayer,
		target: AnnotationCollection,
		from: AnnotationLayer,
		source: AnnotationCollection,
		label: string
	): Promise<void> {
		this.writes.push({ layerId: to.id, collection: target, debounce: false, label });
		this.writes.push({ layerId: from.id, collection: source, debounce: false, label });
	}

	hasPendingAnnotationWrite(): boolean {
		return this.pending;
	}
}

/**
 * The screen's three edges, as mutable state a test can drive.
 *
 * **`layers` is `$state`, not the array it was handed.** On the screen this edge is
 * `$derived(session.openProject?.layers ?? [])` — signal-backed, so a Layer being deleted
 * invalidates every derived over it. A plain array has no signals, so `#annotationLayers` would
 * acquire no dependencies on its first read and stay clean for ever after: "follows the open Layer
 * being deleted" would pass without any reactivity in the class at all. Mutate `it_.layers` (the
 * proxy this returns), not the array passed in — only writes through the proxy are writes to a
 * signal.
 *
 * `documents` is `$state` for the same reason, and it matters as soon as a test makes two edits: the
 * screen's own edge is signal-backed, so a plain object here would leave `activeCollection` reading
 * the collection as it was before the first write for ever after.
 */
function screen(initialLayers: Layer[]) {
	const session = new FakeWriter();
	const layers = $state(initialLayers);
	let documents = $state<Record<string, unknown>>({});
	const annotations = new AnnotationEditing({
		session: () => session,
		layers: () => layers,
		documents: () => documents,
		replaceDocument: (layerId, collection) => {
			documents = { ...documents, [layerId]: collection };
		}
	});
	return {
		session,
		annotations,
		layers,
		get documents() {
			return documents;
		},
		put(layer: AnnotationLayer, collection: AnnotationCollection) {
			documents = { ...documents, [layer.id]: collection };
		}
	};
}

const layerNamed = (id: string, name = id): AnnotationLayer =>
	newAnnotationLayer({ id, name }) as AnnotationLayer;

const pin = (id: string, lng = 0, lat = 0): Annotation =>
	newAnnotation({ id, geometry: { type: 'Point', coordinates: [lng, lat] } });

const titled = (id: string, title: string): Annotation =>
	newAnnotation({ id, geometry: { type: 'Point', coordinates: [0, 0] }, title });

describe('which Layer is drawn into', () => {
	it('draws into nothing at all when no Layer is open', async () => {
		// Ticket 05's defect, in one assertion rather than in a browser: `activeLayer` has **no**
		// fallback to the topmost Annotation Layer. With the fallback restored, a click on the map
		// with every row closed writes an Annotation into whichever Layer happened to be on top —
		// into a file the user was not looking at.
		const it_ = screen([layerNamed('one'), layerNamed('two')]);
		it_.annotations.drawing.choose('point');

		await it_.annotations.placePoint({ lng: 4, lat: 52 });

		expect(it_.annotations.activeLayer).toBeNull();
		expect(it_.session.writes).toEqual([]);
	});

	it('abandons a part-drawn shape and the selection when another Layer is opened', () => {
		const it_ = screen([layerNamed('one'), layerNamed('two')]);
		it_.annotations.openLayer('one');
		it_.annotations.drawing.choose('polygon');
		it_.annotations.drawing.place({ lng: 0, lat: 0 });
		it_.annotations.selectedAnnotationId = 'kept';

		it_.annotations.openLayer('two');

		expect(it_.annotations.drawing.drawing).toBe(false);
		expect(it_.annotations.selectedAnnotationId).toBeNull();
	});

	it('puts the shapes away when another Layer is opened with nothing drawn yet', () => {
		// **The state a plain `cancel()` cannot reach.** "New Annotation" has been pressed and no vertex
		// placed, so there is nothing part-drawn to abandon — and the shapes would follow into a Layer
		// where the button was never pressed, offering Pin/Line/Shape/Done and no way back to rest but a
		// "Done" nobody asked for.
		const it_ = screen([layerNamed('one'), layerNamed('two')]);
		it_.annotations.openLayer('one');
		it_.annotations.drawing.offerShapes();

		it_.annotations.openLayer('two');

		expect(it_.annotations.drawing.picking).toBe(false);
		expect(it_.annotations.drawing.tool).toBe('select');
	});

	it('puts the shapes away when the open Layer is closed, too', () => {
		// Closing is the same act: the tools go off the screen with the row, so the state behind them
		// cannot be left holding a gesture that was never begun.
		const it_ = screen([layerNamed('one')]);
		it_.annotations.openLayer('one');
		it_.annotations.drawing.offerShapes();

		it_.annotations.openLayer(null);

		expect(it_.annotations.drawing.picking).toBe(false);
	});

	it('keeps the selection when an Annotation is opened from the map', () => {
		// The one path that deliberately does not go through `openLayer`: a click on the map is
		// *making* a selection, and clearing it would be clearing the thing the user just pointed at.
		const it_ = screen([layerNamed('one'), layerNamed('two')]);

		it_.annotations.openFromMap('two', 'a1');

		expect(it_.annotations.openLayerId).toBe('two');
		expect(it_.annotations.selectedAnnotationId).toBe('a1');
	});

	it('follows the open Layer being deleted rather than pointing at a Layer that is gone', () => {
		// The assertion this file's header is about: `activeLayer` is read *before* the deletion, so a
		// derived that did not invalidate would hand back the Layer it cached — a Layer that is gone
		// from the Project, still being drawn into. Replace either `$derived` in
		// `annotation-editing.svelte.ts` with a plain getter and every other test in this file still
		// passes; this one is the one that goes red.
		const it_ = screen([layerNamed('one'), layerNamed('two')]);
		it_.annotations.openLayer('two');
		expect(it_.annotations.activeLayer?.id).toBe('two');

		it_.layers.splice(1, 1);

		expect(it_.annotations.activeLayer).toBeNull();
	});
});

describe('a drawn Annotation arrives selected and ready to be titled (the-annotation-inspector story 40)', () => {
	it('selects the shape just drawn and names it as the one to type into', async () => {
		const it_ = screen([layerNamed('one')]);
		it_.annotations.openLayer('one');
		it_.annotations.drawing.choose('point');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		const drawn = written(it_).annotations[0]!.id;
		expect(it_.annotations.selectedAnnotationId).toBe(drawn);
		// The id rather than a flag, so the panel that opens can tell the shape just drawn from an
		// Annotation somebody selected to read.
		expect(it_.annotations.titlingId).toBe(drawn);
	});

	it('stops naming it as soon as anything else is selected, so reading opens no form', async () => {
		const it_ = screen([layerNamed('one')]);
		it_.annotations.openLayer('one');
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });
		const drawn = written(it_).annotations[0]!.id;

		// The same Annotation, selected again — a row pressed rather than a shape drawn.
		it_.annotations.selectAnnotation(null);
		it_.annotations.selectAnnotation(drawn);

		expect(it_.annotations.titlingId).toBeNull();
	});

	it('leaves a Pin dropped on a Place alone, because it arrived with its title', async () => {
		// The words are the scholar's own query (ADR-0029), so a field opened on them would be an edit
		// nobody asked for.
		const it_ = screen([layerNamed('one')]);
		it_.annotations.openLayer('one');

		await it_.annotations.placePin({ lng: 4.9, lat: 52.37 }, 'Hampden');

		expect(it_.annotations.selectedAnnotationId).toBe(written(it_).annotations[0]!.id);
		expect(it_.annotations.titlingId).toBeNull();
	});
});

describe('the “shape added” announcement is withdrawn when it stops being true', () => {
	/** A pin drawn into an open Layer: the state in which the announcement is being made. */
	const drewAPin = async (it_: ReturnType<typeof screen>): Promise<void> => {
		it_.annotations.openLayer('one');
		it_.annotations.drawing.offerShapes();
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });
	};

	it('survives the selection the drawn shape itself makes', async () => {
		// The sentence is made *by* a completed gesture and `#addDrawn` selects what that gesture drew,
		// so the one selection it must outlive is the one it is about.
		const it_ = screen([layerNamed('one')]);

		await drewAPin(it_);

		expect(it_.annotations.drawing.status).toContain('Pin added');
	});

	it('goes when the selection moves off the shape it names', async () => {
		// It claims the shape is "selected so it can be titled". Two Escapes deselect, and a region still
		// saying that would be describing a screen the scholar is no longer looking at.
		const it_ = screen([layerNamed('one')]);
		await drewAPin(it_);

		it_.annotations.selectAnnotation(null);

		expect(it_.annotations.drawing.status).toBe('');
	});

	it('goes when the Annotation it announces is deleted', async () => {
		const it_ = screen([layerNamed('one')]);
		await drewAPin(it_);

		await it_.annotations.deleteSelected();

		// Announcing that something exists, in a Layer it has just been taken out of.
		expect(it_.annotations.drawing.status).toBe('');
		expect(written(it_).annotations).toHaveLength(0);
	});

	it('goes when another Layer is opened', async () => {
		const it_ = screen([layerNamed('one'), layerNamed('two')]);
		await drewAPin(it_);

		it_.annotations.openLayer('two');

		// An empty Layer announcing a Pin added to a different one.
		expect(it_.annotations.drawing.status).toBe('');
	});

	it('says nothing about a Pin dropped on a Place, which came from no gesture', async () => {
		// The words are already the scholar's own (ADR-0029): nothing was armed, nothing disarmed, and a
		// sentence left over from the last shape drawn would name that shape while pointing at this Pin.
		const it_ = screen([layerNamed('one')]);
		await drewAPin(it_);

		await it_.annotations.placePin({ lng: 5, lat: 52 }, 'Hampden');

		expect(it_.annotations.drawing.status).toBe('');
	});
});

describe('whether the selected Annotation’s shape can be drawn (the-annotation-inspector story 28)', () => {
	// **The one thing `selectedIsDrawable` is read for is an absence**, which is why it is asserted
	// here rather than left to the surface: the screen withholds the Inspector's `style` snippet when it
	// is false, and the Inspector with no snippet renders no tab strip at all
	// (`packages/ui/src/annotation-inspector.dom.test.ts`). So a value stuck at `true` would put a Style
	// tab on a `GeometryCollection` and a tab stuck at `false` would take the swatches away from every
	// pin, and neither shows up as an error anywhere.
	//
	// It also carries forward what the retired
	// `'a shape this version cannot draw says so instead of offering nothing'` asserted with
	// `expect(all('annotation-marker-color')).toHaveLength(0)` — an undrawable geometry is offered no
	// style control. The sentence's half of that test lives on in
	// `annotation-text-face.dom.test.ts`'s `'says so where the words are, and keeps them editable'`;
	// this is the refusal's half, one seam below where the controls used to be counted.

	/** One Layer open with one Annotation of `geometry` in it, selected: the state the Inspector reads. */
	const selecting = (geometry: AnnotationGeometry) => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [newAnnotation({ id: 'a-1', geometry })] });
		it_.annotations.openLayer('one');
		it_.annotations.selectAnnotation('a-1');
		return it_;
	};

	it('says yes for each of the three shapes this build draws', () => {
		const shapes: AnnotationGeometry[] = [
			{ type: 'Point', coordinates: [4.9, 52.37] },
			{ type: 'LineString', coordinates: [[4.9, 52.37]] },
			{ type: 'Polygon', coordinates: [[[4.9, 52.37]]] }
		];
		for (const geometry of shapes) {
			expect(selecting(geometry).annotations.selectedIsDrawable, geometry!.type).toBe(true);
		}
	});

	it('says no for a geometry from a foreign document', () => {
		// A `GeometryCollection` reaches this app as a `foreign` geometry carried whole. It is still
		// titled, described and deleted like anything else, and it is written back untouched — what it
		// has no controls for is its shape.
		const it_ = selecting({
			type: 'foreign',
			declaredType: 'GeometryCollection',
			raw: { type: 'GeometryCollection', geometries: [] }
		});

		expect(it_.annotations.selectedIsDrawable).toBe(false);
	});

	it('says no for an Annotation with no geometry at all, which RFC 7946 permits', () => {
		expect(selecting(null).annotations.selectedIsDrawable).toBe(false);
	});

	it('says no when nothing is selected, so no Style face is offered to nobody', () => {
		const it_ = selecting({ type: 'Point', coordinates: [4.9, 52.37] });

		it_.annotations.selectAnnotation(null);

		expect(it_.annotations.selectedIsDrawable).toBe(false);
	});
});

describe('editing a shape', () => {
	it('moves one vertex of a polygon and writes the ring closed, once', async () => {
		// RFC 7946: a LinearRing's last position repeats its first. The handles are one fewer than
		// the ring's positions, and this is the code that has to close it again — a ring whose ends
		// differ is what other tools reject, and nothing in the interface would show it.
		const layer = layerNamed('one');
		const ring: [number, number][] = [
			[0, 0],
			[2, 0],
			[2, 2],
			[0, 0]
		];
		const shape: Annotation = {
			id: 'a1',
			geometry: { type: 'Polygon', coordinates: [ring] },
			properties: {}
		};
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [shape] });
		it_.annotations.openLayer('one');
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.reshape(1, { lng: 9, lat: 9 });

		expect(it_.session.writes).toHaveLength(1);
		const written = it_.session.writes[0]!.collection.annotations[0]!.geometry;
		expect(written).toEqual({
			type: 'Polygon',
			coordinates: [
				[
					[0, 0],
					[9, 9],
					[2, 2],
					[0, 0]
				]
			]
		});
	});

	it('offers one handle per position of the ring, not one per vertex of the closed ring', () => {
		const layer = layerNamed('one');
		const shape: Annotation = {
			id: 'a1',
			geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[0, 0],
						[2, 0],
						[2, 2],
						[0, 0]
					]
				]
			},
			properties: { title: 'The old quay' }
		};
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [shape] });
		it_.annotations.openLayer('one');
		it_.annotations.selectAnnotation('a1');

		const points = it_.annotations.annotationPoints;

		// Three, not four: two handles on one spot, one of which silently had to follow the other,
		// is what the closing position would otherwise produce.
		expect(points).toHaveLength(3);
		expect(points[0]!.label).toBe('Point 1 of 3 of The old quay. Arrow keys move it.');
	});
});

/**
 * Which Annotation gestures open a Step, and what the bar says about each (ADR-0039, SPEC stories
 * 20–23).
 *
 * The label is the whole of what this class knows about an Edit History, so it is the whole of what
 * there is to assert here: a labelled write is a Step and an unlabelled one is not, and the sentence
 * is the one a scholar reads on the control before pressing it.
 */
describe('the gestures that become Steps, and the ones that do not', () => {
	const drawnInto = (annotations: Annotation[] = []) => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations });
		it_.annotations.openLayer('one');
		return it_;
	};

	it('names the shape just drawn, by the title it arrived with', async () => {
		const it_ = drawnInto();

		await it_.annotations.placePin({ lng: 4.9, lat: 52.4 }, 'Fort Amsterdam');

		expect(it_.session.writes.map((write) => write.label)).toEqual([
			'Undo drawing “Fort Amsterdam”'
		]);
	});

	it('names an untitled shape the way the undo control has always named one', async () => {
		const it_ = drawnInto();
		it_.annotations.drawing.choose('point');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.4 });

		expect(it_.session.writes.map((write) => write.label)).toEqual([
			'Undo drawing this Annotation'
		]);
	});

	it('names the deletion of the Annotation that was selected', async () => {
		const it_ = drawnInto([pin('a1'), titled('a2', 'The old quay')]);
		it_.annotations.selectAnnotation('a2');

		await it_.annotations.deleteSelected();

		expect(it_.session.writes).toHaveLength(1);
		expect(it_.session.writes[0]!.collection.annotations.map((one) => one.id)).toEqual(['a1']);
		expect(it_.session.writes[0]!.label).toBe('Undo delete of “The old quay”');
	});

	it('names a vertex being moved as moving the Annotation it belongs to', async () => {
		const it_ = drawnInto([titled('a1', 'Trade route')]);
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.reshape(0, { lng: 9, lat: 9 });

		expect(it_.session.writes.map((write) => write.label)).toEqual(['Undo moving “Trade route”']);
	});

	it('names a colour and a line style as restyling, one Step each', async () => {
		const it_ = drawnInto([titled('a1', 'Trade route')]);
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.styleSelected({ 'marker-color': '#d32f2f' });
		await it_.annotations.lineStyleSelected('dotted');

		expect(it_.session.writes.map((write) => write.label)).toEqual([
			'Undo restyling “Trade route”',
			'Undo restyling “Trade route”'
		]);
	});

	/**
	 * A slider still under the pointer is not a completed gesture (ADR-0017 rule 1), and a Step per
	 * position a range reported would spend a five-deep history on one drag.
	 */
	it('opens no Step for a style still inside its debounce window', async () => {
		const it_ = drawnInto([titled('a1', 'Trade route')]);
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.styleSelected({ 'stroke-width': 4 }, { debounce: true });

		expect(it_.session.writes.map((write) => write.label)).toEqual([undefined]);
	});

	/**
	 * Every position of one drag is the same gesture, and the sentence a scholar reads before pressing
	 * Undo is the one the discrete case already says.
	 */
	it('gathers a slider’s positions into one drag, and a second slider into another', async () => {
		const it_ = drawnInto([titled('a1', 'Trade route')]);
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.styleSelected({ 'stroke-width': 4 }, { debounce: true });
		await it_.annotations.styleSelected({ 'stroke-width': 6 }, { debounce: true });
		await it_.annotations.styleSelected({ 'stroke-opacity': 0.4 }, { debounce: true });

		const drags = it_.session.writes.map((write) => write.drag);
		expect(drags.every((drag) => drag?.label === 'Undo restyling “Trade route”')).toBe(true);
		expect(drags[0]!.key).toBe(drags[1]!.key);
		expect(drags[2]!.key).not.toBe(drags[0]!.key);
	});

	/** Typed text is never a Step and is never reverted by one (SPEC stories 30, 33). */
	it('opens no Step for a title or a description being typed', async () => {
		const it_ = drawnInto([pin('a1')]);
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.typeText({ title: 'Fort Amsterdam' });

		expect(it_.session.writes.map((write) => write.label)).toEqual([undefined]);
	});

	/**
	 * Both moves are Steps, and the between-Layers one is a *single* Step over two documents.
	 *
	 * A write outside a Step is not merely un-undoable: it is inside the `before` image of whatever
	 * Step comes next and outside the one behind it, so an undo aimed elsewhere reverts it silently
	 * (ADR-0039's discard rule). For the between-Layers move that is worse than a reversion — the
	 * Annotation is written back into the Layer it came from while the copy in the other one stays,
	 * which is one id in two Layers and a state no gesture can otherwise produce. One `step()` over
	 * both paths is what rules that out, and the label being the same on both writes is how it shows.
	 */
	it('makes a reorder one Step, and a move between Layers one Step over both documents', async () => {
		const to = layerNamed('two', 'Trade routes');
		const it_ = screen([layerNamed('one'), to]);
		it_.put(layerNamed('one'), { annotations: [pin('a1'), pin('a2')] });
		it_.annotations.openLayer('one');

		await it_.annotations.moveAnnotationTo('a1', 1);
		await it_.annotations.moveAnnotationToLayer('a2', 'two');

		const [reorder, intoTarget, outOfSource] = it_.session.writes;
		expect(reorder?.label).toBe('Undo reordering this Annotation');
		// One label across both writes, so the pair is one entry in the history and not two.
		expect(intoTarget?.label).toBe('Undo moving this Annotation to “Trade routes”');
		expect(outOfSource?.label).toBe(intoTarget?.label);
		expect(it_.session.writes).toHaveLength(3);
	});
});

/**
 * SPEC stories 52 and 53: undo writes bytes, so the Annotation the Inspector is describing can simply
 * cease to exist. One test clears the one value the Inspector and the row's highlight are both read
 * from, so the two ends of a selection cannot disagree.
 */
describe('letting go of a selection an Edit History wrote away', () => {
	it('clears the selection when the collection just read no longer holds it', () => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [pin('a1'), pin('a2')] });
		it_.annotations.openLayer('one');
		it_.annotations.selectAnnotation('a2');

		// What an undo of the Step that drew it leaves on disk, read back into the screen's record.
		it_.put(layer, { annotations: [pin('a1')] });
		it_.annotations.releaseMissingSelection();

		expect(it_.annotations.selectedAnnotationId).toBeNull();
		expect(it_.annotations.selectedAnnotation).toBeNull();
	});

	it('keeps a selection the collection still holds, so an unrelated undo closes nothing', () => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [pin('a1'), pin('a2')] });
		it_.annotations.openLayer('one');
		it_.annotations.selectAnnotation('a2');

		it_.put(layer, { annotations: [pin('a2')] });
		it_.annotations.releaseMissingSelection();

		expect(it_.annotations.selectedAnnotationId).toBe('a2');
	});

	/**
	 * A hidden Layer is absent from `documents` altogether, so there is no collection to test the
	 * selection against — and letting go on that would drop a selection over a read rather than over
	 * an undo.
	 */
	it('keeps the selection when the open Layer’s document is not in hand', () => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.annotations.openLayer('one');
		it_.annotations.selectAnnotation('a2');

		it_.annotations.releaseMissingSelection();

		expect(it_.annotations.selectedAnnotationId).toBe('a2');
	});
});

describe('merely looking at a Project modifies nothing (ADR-0010)', () => {
	it('writes nothing on a commit when no edit is waiting', async () => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [pin('a1')] });
		it_.annotations.openLayer('one');
		it_.session.pending = false;

		await it_.annotations.commitAnnotationEdit();

		expect(it_.session.writes).toEqual([]);
	});

	it('writes once on a commit when an edit is waiting inside its debounce window', async () => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [pin('a1')] });
		it_.annotations.openLayer('one');
		it_.session.pending = true;

		await it_.annotations.commitAnnotationEdit();

		expect(it_.session.writes).toHaveLength(1);
		expect(it_.session.writes[0]!.debounce).toBe(false);
	});

	it('coalesces typing and writes a discrete style change now (ADR-0017 rules 1 and 2)', async () => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [pin('a1')] });
		it_.annotations.openLayer('one');
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.typeText({ title: 'The old quay' });
		await it_.annotations.lineStyleSelected('dotted');

		expect(it_.session.writes.map((write) => write.debounce)).toEqual([true, false]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// What ends up in the GeoJSON (ticket 06)
//
// These claims were asserted through the running application, a real MapLibre and real OPFS, and
// none of them needed any of it: what a style control writes is a fact about the document this
// screen commits, and the write is right here. What stays at Seam 2 is what a browser can still
// falsify — that the controls exist, that a pin is offered no fill, that nine swatches sit on one
// line inside the sidebar, and that a session which only looked left the file byte-identical.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The property names simplestyle 1.1.0 defines, plus ADR-0009's one extension.
 *
 * Written out rather than imported from `core`'s own `SIMPLESTYLE_PROPERTIES`: the claim is that this
 * screen writes *the spec's* names, and a list copied from the spec is a better witness to that than
 * one that would agree with the code however wrong both were.
 */
const SIMPLESTYLE_NAMES = [
	'title',
	'description',
	'marker-size',
	'marker-symbol',
	'marker-color',
	'stroke',
	'stroke-opacity',
	'stroke-width',
	'fill',
	'fill-opacity',
	'stroke-dasharray'
];

const utf8 = (encoded: Uint8Array): string => new TextDecoder().decode(encoded);

/** The collection of the most recent write, which is what is on disk after a gesture. */
const written = (it_: ReturnType<typeof screen>): AnnotationCollection => {
	const last = it_.session.writes.at(-1);
	if (last === undefined) throw new Error('nothing was written');
	return last.collection;
};

const propertiesOf = (it_: ReturnType<typeof screen>, index = 0): Record<string, unknown> =>
	written(it_).annotations[index]!.properties as Record<string, unknown>;

/** A screen with one Annotation Layer open, and the tool in hand. */
function drawing(tool: 'point' | 'line' | 'polygon' | 'text') {
	const it_ = screen([layerNamed('one')]);
	it_.annotations.openLayer('one');
	it_.annotations.drawing.choose(tool);
	return it_;
}

/** Draw a shape, end the gesture, and select what it made — the ordinary path to the style controls. */
async function draw(it_: ReturnType<typeof screen>, points: [number, number][]): Promise<void> {
	for (const [lng, lat] of points) await it_.annotations.placePoint({ lng, lat });
	if (points.length > 1) await it_.annotations.finishShape();
	it_.annotations.selectAnnotation(written(it_).annotations.at(-1)!.id);
}

describe('the style controls write simplestyle names exactly (SPEC stories 63, 64, 65)', () => {
	it('writes a colour, a width, and an opacity under the spec’s own names', async () => {
		const it_ = drawing('line');
		await draw(it_, [
			[4.8, 52.3],
			[5, 52.3]
		]);

		await it_.annotations.styleSelected({
			stroke: '#d32f2f',
			'stroke-width': 4,
			'stroke-opacity': 0.5
		});

		const properties = propertiesOf(it_);
		expect(properties['stroke']).toBe('#d32f2f');
		expect(properties['stroke-width']).toBe(4);
		expect(properties['stroke-opacity']).toBe(0.5);
		// Every name written is one simplestyle defines. A camelCase name would look right in the app
		// and make the file unreadable to every other tool, which is the whole portability claim.
		for (const name of Object.keys(properties)) expect(SIMPLESTYLE_NAMES).toContain(name);
	});

	it('writes a fill colour and opacity for a shape', async () => {
		const it_ = drawing('polygon');
		await draw(it_, [
			[4.8, 52.3],
			[5, 52.3],
			[4.9, 52.4]
		]);

		await it_.annotations.styleSelected({ fill: '#1976d2', 'fill-opacity': 0.25 });

		const properties = propertiesOf(it_);
		expect(properties['fill']).toBe('#1976d2');
		expect(properties['fill-opacity']).toBe(0.25);
		for (const name of Object.keys(properties)) expect(SIMPLESTYLE_NAMES).toContain(name);
	});

	it('gives an Annotation drawn with default styling the palette’s grey and nothing more', async () => {
		// simplestyle's own defaults are two *different* greys — `#555555` for a line and a fill,
		// `#7e7e7e` for a pin — and only the first is one of the nine colours a scholar is offered, so a
		// pin drawn with defaults would report a colour the picker cannot show. The three colours and
		// **nothing else**: `stroke-width`, the opacities and `marker-size` stay absent, because
		// simplestyle has one default for each and this app does not contradict it.
		const it_ = drawing('point');
		await draw(it_, [[4.9, 52.37]]);
		it_.annotations.drawing.choose('line');
		await draw(it_, [
			[4.8, 52.3],
			[5, 52.3]
		]);

		const grey = {
			'marker-color': DEFAULT_ANNOTATION_COLOR,
			stroke: DEFAULT_ANNOTATION_COLOR,
			fill: DEFAULT_ANNOTATION_COLOR
		};
		expect(written(it_).annotations.map((one) => one.properties)).toEqual([grey, grey]);
		expect(utf8(serialiseAnnotations(written(it_)))).not.toContain('stroke-width');
	});

	it('writes valid GeoJSON with simplestyle values of the right types', async () => {
		const it_ = drawing('line');
		await draw(it_, [
			[4.8, 52.3],
			[5, 52.3]
		]);
		await it_.annotations.styleSelected({
			stroke: '#d32f2f',
			'stroke-width': 3,
			'stroke-opacity': 0.8
		});
		await it_.annotations.lineStyleSelected('dotted');

		const file = JSON.parse(utf8(serialiseAnnotations(written(it_))));

		expect(file.type).toBe('FeatureCollection');
		expect(file.features[0].type).toBe('Feature');
		expect(file.features[0].geometry.type).toBe('LineString');
		const properties = file.features[0].properties;
		expect(properties['stroke']).toMatch(/^#[0-9a-f]{6}$/i);
		expect(typeof properties['stroke-width']).toBe('number');
		expect(properties['stroke-opacity']).toBeGreaterThanOrEqual(0);
		expect(properties['stroke-opacity']).toBeLessThanOrEqual(1);
		expect(properties['stroke-dasharray']).toEqual([1, 3]);
		// The portability claim, made checkable rather than asserted property by property.
		expect(simpleStyleViolations(properties)).toEqual([]);
	});
});

describe('solid, dashed, and dotted (SPEC story 61)', () => {
	it('stores the tuples and writes solid as the absence of stroke-dasharray', async () => {
		const it_ = drawing('line');
		await draw(it_, [
			[4.8, 52.3],
			[5, 52.3]
		]);

		// Solid is the default, and it is worth stating exactly: a freshly drawn Annotation does carry
		// the palette's three colours, so asserting an empty `properties` here would be asserting the
		// palette's absence by accident.
		expect(propertiesOf(it_)).not.toHaveProperty('stroke-dasharray');

		await it_.annotations.lineStyleSelected('dashed');
		expect(propertiesOf(it_)['stroke-dasharray']).toEqual([8, 4]);

		await it_.annotations.lineStyleSelected('dotted');
		expect(propertiesOf(it_)['stroke-dasharray']).toEqual([1, 3]);

		// No keyword ever reaches the file — a keyword would be legible only to us (ADR-0009).
		const file = utf8(serialiseAnnotations(written(it_)));
		for (const keyword of ['"dashed"', '"dotted"', '"solid"']) expect(file).not.toContain(keyword);

		// And going back to solid *removes* the property rather than blanking it.
		await it_.annotations.lineStyleSelected('solid');
		expect(propertiesOf(it_)).not.toHaveProperty('stroke-dasharray');
	});
});

describe('placing a Label writes what makes it one (write-on-the-map stories 10, 26, 47)', () => {
	it('writes a Point carrying the discriminator, untitled, for one write', async () => {
		const it_ = drawing('text');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		// A Point like a Pin's, and the `marker-symbol` that says the marker shows its own words. No
		// `title` until the author types one: a placed Label has no words nobody wrote.
		expect(written(it_).annotations[0]!.geometry) //
			.toEqual({ type: 'Point', coordinates: [4.9, 52.37] });
		expect(propertiesOf(it_)['marker-symbol']).toBe('label');
		expect(propertiesOf(it_)).not.toHaveProperty('title');
		// ADR-0017 rule 1: the placement is one write, and the title arrives through the coalesced text
		// write below rather than through a second commit here.
		expect(it_.session.writes).toHaveLength(1);
		// And the keyboard is offered the field, which is what makes clicking and typing one gesture
		// (story 4). The offer is by id, so a read gesture never produces a form.
		expect(it_.annotations.titlingId).toBe(written(it_).annotations[0]!.id);
		for (const name of Object.keys(propertiesOf(it_))) expect(SIMPLESTYLE_NAMES).toContain(name);
		expect(simpleStyleViolations(propertiesOf(it_))).toEqual([]);
	});

	it('gives the first Label in a Layer words a different colour from its background', async () => {
		// ⚠ The defect this rule exists for. The first Annotation in a Layer is given
		// `DEFAULT_ANNOTATION_COLOR` as its `marker-color` *and* its `fill`, and a Label draws the first
		// as its words on the second as its chip — grey on grey, placed and unreadable. `styleForNewLabel`
		// starts that one case on a fixed legible pair from the palette instead.
		const it_ = drawing('text');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		const properties = propertiesOf(it_);
		expect(properties['marker-color']).toBe('#000000');
		expect(properties['fill']).toBe('#ffffff');
		expect(properties['marker-color']).not.toBe(properties['fill']);
	});

	// ⚠ **A Layer whose last Annotation carries colour values that are not colours.** ADR-0009
	// validates the *format* of what it recognises and `readProperties` carries everything else
	// untouched, so a document from another tool can put `4`, `true`, or an array where a `#RRGGBB`
	// belongs — and the style of the last Annotation drawn is what a new Label starts from. This screen
	// is driven from `ProjectScreen.svelte` as `void placePoint(…)`, so a throw here is an unhandled
	// rejection: no Annotation placed, and nothing said about why.
	it.each([
		['a null text colour', { 'marker-color': null, fill: DEFAULT_ANNOTATION_COLOR }],
		['a numeric background', { fill: 4 }],
		['a boolean background', { fill: true }],
		['an array background', { fill: ['#fff'] }],
		['a numeric text colour', { 'marker-color': 5, fill: '#fff' }]
	])('places a Label after an Annotation carrying %s', async (_name, properties) => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, {
			annotations: [{ id: 'foreign', geometry: null, properties } as unknown as Annotation]
		});
		it_.annotations.openLayer('one');
		it_.annotations.drawing.choose('text');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		// Placed, and the strange values are inherited exactly as they arrived — this is not the place
		// that repairs another tool's file.
		expect(written(it_).annotations).toHaveLength(2);
		expect(propertiesOf(it_, 1)).toEqual({ ...properties, 'marker-symbol': 'label' });
	});

	it('coalesces the words into one further write, and draws what was typed', async () => {
		const it_ = drawing('text');
		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });
		it_.annotations.selectAnnotation(written(it_).annotations[0]!.id);

		await it_.annotations.typeText({ title: 'Zuiderzee' });

		// The words are `title`, which is what the renderer's `text-field` reads and what the row and the
		// Inspector header already name an Annotation from — one Annotation, one name.
		expect(propertiesOf(it_)['title']).toBe('Zuiderzee');
		expect(it_.session.writes.map((write) => write.debounce)).toEqual([false, true]);
	});

	it('draws a Pin after a Label, because the discriminator is never inherited (story 26)', async () => {
		const it_ = drawing('text');
		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		// One press of "New Annotation" per Annotation: the Label tool put itself down, so the Pin is a
		// fresh choice — which is exactly the gesture whose result used to be a second Label.
		it_.annotations.drawing.offerShapes();
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 5, lat: 52.4 });

		const pinProperties = propertiesOf(it_, 1);
		expect(pinProperties).not.toHaveProperty('marker-symbol');
		// And the colours it inherited from the Label are the Label's, unchanged: only the property that
		// says *what kind of thing this is* stopped inheriting.
		expect(pinProperties['marker-color']).toBe(propertiesOf(it_, 0)['marker-color']);
		expect(pinProperties['fill']).toBe(propertiesOf(it_, 0)['fill']);
	});

	it('carries a Label’s size and colours onto the next Label drawn (story 25)', async () => {
		const it_ = drawing('text');
		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });
		it_.annotations.selectAnnotation(written(it_).annotations[0]!.id);
		await it_.annotations.styleSelected({
			'marker-color': '#ffffff',
			fill: '#1976d2',
			'marker-size': 'large'
		});

		it_.annotations.drawing.offerShapes();
		it_.annotations.drawing.choose('text');
		await it_.annotations.placePoint({ lng: 5, lat: 52.4 });

		expect(propertiesOf(it_, 1)).toMatchObject({
			'marker-symbol': 'label',
			'marker-color': '#ffffff',
			fill: '#1976d2',
			'marker-size': 'large'
		});
	});
});

describe('display state never reaches the GeoJSON (ADR-0002, ADR-0010)', () => {
	it('writes back byte-identical bytes after a title is typed and cleared', async () => {
		// The round trip through the screen that edits the file: parsing what was written and writing it
		// again must not reformat the document, and a title typed and then cleared must leave no empty
		// string behind. Byte-identity is what keeps a Workspace in git producing diffs a human can read.
		const it_ = drawing('point');
		await draw(it_, [[4.9, 52.37]]);
		it_.annotations.drawing.choose('line');
		await draw(it_, [
			[4.8, 52.3],
			[5, 52.3]
		]);
		const original = utf8(serialiseAnnotations(written(it_)));

		// Reopened from the bytes, the way a reload reaches them, then edited and unedited.
		it_.put(layerNamed('one'), parseAnnotations(serialiseAnnotations(written(it_))));
		it_.annotations.selectAnnotation(written(it_).annotations[0]!.id);
		await it_.annotations.typeText({ title: 'A' });
		await it_.annotations.typeText({ title: '' });

		expect(utf8(serialiseAnnotations(written(it_)))).toBe(original);
	});
});

describe('moving an Annotation', () => {
	it('reorders it inside its own Layer in one write', () => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [pin('a1'), pin('a2'), pin('a3')] });
		it_.annotations.openLayer('one');

		void it_.annotations.moveAnnotationTo('a3', 0);

		expect(it_.session.writes).toHaveLength(1);
		expect(it_.session.writes[0]?.collection.annotations.map((one) => one.id)).toEqual([
			'a3',
			'a1',
			'a2'
		]);
	});

	it('writes nothing when the move changes nothing', () => {
		// The identity guard in `moveAnnotation` reaching `commitAnnotationsIn`'s: a drop back where it
		// came from must not rewrite a scholar's file with a fresh `updatedAt` (ADR-0010).
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [pin('a1'), pin('a2')] });
		it_.annotations.openLayer('one');

		void it_.annotations.moveAnnotationTo('a1', 0);

		expect(it_.session.writes).toEqual([]);
	});

	it('writes the target Layer before the Layer the Annotation is leaving', async () => {
		// **The order is the whole claim.** A failure between the two writes leaves the Annotation in
		// both Layers, which a scholar can see and delete; the other order leaves it in neither and the
		// work is gone.
		const from = layerNamed('from');
		const to = layerNamed('to');
		const it_ = screen([from, to]);
		it_.put(from, { annotations: [pin('a1'), pin('a2')] });
		it_.put(to, { annotations: [pin('b1')] });
		it_.annotations.openLayer('from');

		await it_.annotations.moveAnnotationToLayer('a2', 'to');

		expect(it_.session.writes.map((write) => write.layerId)).toEqual(['to', 'from']);
		expect(it_.session.writes[0]?.collection.annotations.map((one) => one.id)).toEqual([
			'b1',
			'a2'
		]);
		expect(it_.session.writes[1]?.collection.annotations.map((one) => one.id)).toEqual(['a1']);
	});

	it('opens the Layer it went into and selects it there', async () => {
		// The sidebar follows the Annotation rather than the other way round: a row simply vanishing from
		// the list it was in is what a move nobody meant to make looks like.
		const from = layerNamed('from');
		const to = layerNamed('to', 'The routes');
		const it_ = screen([from, to]);
		it_.put(from, { annotations: [pin('a1')] });
		it_.put(to, { annotations: [] });
		it_.annotations.openLayer('from');

		await it_.annotations.moveAnnotationToLayer('a1', 'to');

		expect(it_.annotations.openLayerId).toBe('to');
		expect(it_.annotations.selectedAnnotationId).toBe('a1');
		expect(it_.annotations.moveNotice).toContain('The routes');
	});

	it('reads a hidden target Layer rather than assuming it is empty', async () => {
		// `documents` holds the Layers the map is given, so a hidden one is absent from it. Assuming
		// empty would write a file holding one Annotation over a file holding twenty.
		const from = layerNamed('from');
		const to = layerNamed('to');
		const it_ = screen([from, to]);
		it_.put(from, { annotations: [pin('a1')] });
		it_.session.onDisk.set('to', { annotations: [pin('b1'), pin('b2')] });
		it_.annotations.openLayer('from');

		await it_.annotations.moveAnnotationToLayer('a1', 'to');

		expect(it_.session.writes[0]?.collection.annotations.map((one) => one.id)).toEqual([
			'b1',
			'b2',
			'a1'
		]);
	});

	it('refuses, and writes nothing at all, when the target Layer cannot be read', async () => {
		const from = layerNamed('from');
		const to = layerNamed('to', 'The routes');
		const it_ = screen([from, to]);
		it_.put(from, { annotations: [pin('a1')] });
		it_.session.unreadable.add('to');
		it_.annotations.openLayer('from');

		await it_.annotations.moveAnnotationToLayer('a1', 'to');

		expect(it_.session.writes).toEqual([]);
		expect(it_.annotations.moveRefusal).toContain('The routes');
		expect(it_.annotations.openLayerId).toBe('from');
	});

	it('offers every Annotation Layer but the one on screen as somewhere to move to', () => {
		const it_ = screen([layerNamed('one'), layerNamed('two'), layerNamed('three')]);
		it_.annotations.openLayer('two');

		expect(it_.annotations.moveTargets.map((target) => target.id)).toEqual(['one', 'three']);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FOUR GESTURES AGAINST A REAL SESSION AND A REAL STORE (ADR-0039, SPEC stories 20–23, 34)
//
// Everything above hands this class a fake writer, because what it asserts is what the class
// *decides*. These assert what the application does: `MemoryProjectStore` under a real `Autosave`
// under a real `EditorSession`, so a gesture opens a real Step, and undo and redo write real bytes
// back through the same save path as the gesture they reverse.
//
// **The assertion is byte identity**, which is the strongest form available and the bar ADR-0039
// sets: a `.geojson` is the scholar's own writing, and undo must give back the file rather than a
// re-serialisation of a parsed model that merely happens to be equivalent. Where the carry-across
// rule applies the assertion is the pair — the reverted half from the image and the typed half from
// the file as it stands.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const DIRECTORY = 'amsterdam-1625';

/** A Project open on one empty Annotation Layer, with this class wired to the real session. */
async function realSession(): Promise<{
	store: MemoryProjectStore;
	session: EditorSession;
	annotations: AnnotationEditing;
	layer: AnnotationLayer;
	path: StorePath;
	/** The Layer's bytes as they stand. */
	bytes(): Promise<Bytes>;
	/** Everything pending, landed, so a read sees what the gesture wrote. */
	settle(): Promise<void>;
}> {
	const store = new MemoryProjectStore();
	await store.write(
		projectFilePath(DIRECTORY),
		serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')))
	);
	const session = new EditorSession(store);
	await session.open(DIRECTORY);
	const layer = await session.addAnnotationLayer('Trade routes');
	if (layer === null) throw new Error('expected an Annotation Layer');
	await session.flush();

	let documents = $state<Record<string, unknown>>({
		[layer.id]: await session.readAnnotations(layer)
	});
	const annotations = new AnnotationEditing({
		session: () => session,
		layers: () => session.openProject?.layers ?? [],
		documents: () => documents,
		replaceDocument: (layerId, collection) => {
			documents = { ...documents, [layerId]: collection };
		}
	});
	annotations.openLayer(layer.id);

	const path = `${DIRECTORY}/${annotationPath(layer.id)}`;
	return {
		store,
		session,
		annotations,
		layer,
		path,
		bytes: () => store.read(path),
		settle: async () => {
			await session.flush();
			// The screen re-reads what a history wrote, which is what `documents` is for: without it the
			// next gesture would edit the collection as it was before the undo.
			documents = { ...documents, [layer.id]: await session.readAnnotations(layer) };
		}
	};
}

describe('an Annotation gesture undone and redone against the store', () => {
	/**
	 * Draw, delete, move and restyle, each one gesture and each reversible on its own — with the
	 * `before` image put back byte for byte, because nothing here typed anything for the carry-across
	 * rule to bring along.
	 */
	const gestures: [string, (it_: Awaited<ReturnType<typeof realSession>>) => Promise<void>][] = [
		[
			'drawing',
			async (it_) => {
				it_.annotations.drawing.choose('point');
				await it_.annotations.placePoint({ lng: 4.9, lat: 52.4 });
			}
		],
		[
			'deleting',
			async (it_) => {
				await it_.annotations.deleteSelected();
			}
		],
		[
			'moving a vertex',
			async (it_) => {
				await it_.annotations.reshape(0, { lng: 5.1, lat: 52.1 });
			}
		],
		[
			'restyling',
			async (it_) => {
				await it_.annotations.styleSelected({ 'marker-color': '#d32f2f' });
			}
		]
	];

	for (const [what, gesture] of gestures) {
		it(`puts the file back byte-identically after ${what}, and forward again on redo`, async () => {
			const it_ = await realSession();
			// Something to delete, move and restyle. Its own Step, walked past by the assertions below,
			// which is also how they prove undo reaches the Step it names rather than the last write.
			it_.annotations.drawing.choose('point');
			await it_.annotations.placePoint({ lng: 4.78, lat: 52.4 });
			await it_.settle();

			const before = await it_.bytes();
			await gesture(it_);
			await it_.settle();
			const after = await it_.bytes();
			// The gesture really reached storage, so the undo below cannot be satisfied by a revert to
			// the last saved state (ADR-0017's consequence).
			expect(after).not.toEqual(before);

			const history = it_.session.historyFor(DIRECTORY);
			expect(await history.undo()).toBe(true);
			await it_.settle();
			expect(await it_.bytes()).toEqual(before);

			expect(await history.redo()).toBe(true);
			await it_.settle();
			expect(await it_.bytes()).toEqual(after);
		});
	}

	// SPEC story 33, on the other format: words typed after a Step are the scholar's and are not part
	// of the gesture that Step records, so undoing it must not take them back.
	it('carries a description typed after a Step across the undo of that Step', async () => {
		const it_ = await realSession();
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 4.78, lat: 52.4 });
		await it_.settle();
		const kept = it_.annotations.selectedAnnotationId as string;

		// The Step to be undone, and then the typing that must survive it.
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 5.02, lat: 52.34 });
		await it_.settle();
		it_.annotations.selectAnnotation(kept);
		await it_.annotations.typeText({ description: 'Attested in the 1625 toll register.' });
		await it_.annotations.commitAnnotationEdit();
		await it_.settle();

		expect(await it_.session.historyFor(DIRECTORY).undo()).toBe(true);
		await it_.settle();

		const back = parseAnnotations(await it_.bytes(), { path: 'annotations' });
		expect(back.annotations).toHaveLength(1);
		expect(back.annotations[0]!.properties.description).toBe('Attested in the 1625 toll register.');
	});

	/**
	 * SPEC story 34, and the other face of the same rule: an Annotation absent from the `before` image
	 * has nothing for its words to be carried onto, so undoing its creation takes them with it rather
	 * than putting it back as a fragment of itself.
	 */
	it('takes an Annotation’s typed words with it when its creation is undone', async () => {
		const it_ = await realSession();
		const empty = await it_.bytes();

		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 4.9, lat: 52.4 });
		await it_.settle();
		await it_.annotations.typeText({
			title: 'Fort Amsterdam',
			description: 'The fort at the mouth of the river.'
		});
		await it_.annotations.commitAnnotationEdit();
		await it_.settle();
		expect(await it_.bytes()).not.toEqual(empty);

		expect(await it_.session.historyFor(DIRECTORY).undo()).toBe(true);
		await it_.settle();

		// Byte for byte the document the Layer was added with: no fragment, and no words left behind.
		expect(await it_.bytes()).toEqual(empty);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A STYLE DRAG AGAINST A REAL SESSION AND A REAL STORE (SPEC stories 23, 33; ticket 08)
//
// The three range inputs in the style panel report a position per pixel and commit on release. What
// is asserted here is the `.geojson` either side of one gesture, because history internals cannot
// tell the difference between a Step that spans the drag and one whose images merely happen to
// straddle it — and it was exactly that difference that put a completed drag outside every Step.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Every property the drag test drives, and a plausible path through each range. */
const SLIDERS: [keyof AnnotationProperties & string, number[]][] = [
	['fill-opacity', [0.8, 0.5, 0.25]],
	['stroke-width', [3, 5, 8]],
	['stroke-opacity', [0.9, 0.6, 0.35]]
];

describe('one style drag is one Step (SPEC story 23)', () => {
	/** A Project with one Annotation drawn and flushed, ready to be restyled. */
	async function drawn(): Promise<Awaited<ReturnType<typeof realSession>>> {
		const it_ = await realSession();
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 4.78, lat: 52.4 });
		await it_.settle();
		return it_;
	}

	const dragTo = async (
		it_: Awaited<ReturnType<typeof realSession>>,
		property: keyof AnnotationProperties & string,
		values: number[]
	): Promise<void> => {
		for (const value of values) {
			await it_.annotations.styleSelected({ [property]: value }, { debounce: true });
		}
	};

	for (const [property, values] of SLIDERS) {
		it(`undoes a ${property} drag to the value it began at, and redoes to the released one`, async () => {
			const it_ = await drawn();
			const before = await it_.bytes();

			await dragTo(it_, property, values);
			await it_.annotations.commitAnnotationEdit();
			await it_.settle();
			const after = await it_.bytes();
			// The whole drag reached storage, so the undo below cannot be satisfied by a revert to the
			// last saved state.
			expect(after).not.toEqual(before);
			expect(
				parseAnnotations(after, { path: 'annotations' }).annotations[0]!.properties[property]
			).toBe(values.at(-1));

			const history = it_.session.historyFor(DIRECTORY);
			expect(await history.undo()).toBe(true);
			await it_.settle();
			// The value the drag began at, and not one of the positions it passed through.
			expect(await it_.bytes()).toEqual(before);
			// One Step for the whole gesture: what is left to undo is the drawing, not another position.
			expect(it_.session.historyFor(DIRECTORY).undoable?.label).toBe(
				'Undo drawing this Annotation'
			);

			expect(await history.redo()).toBe(true);
			await it_.settle();
			expect(await it_.bytes()).toEqual(after);
		});
	}

	/**
	 * The defect this closes, and SPEC story 33's shape on style: a completed drag that lands outside
	 * every Step is reverted by the undo of whatever Step stands above it, because that Step's `before`
	 * image predates the drag and carry-across carries only title and description.
	 *
	 * So the drag must be what one Undo reaches. The deletion below stays undone across it, and the
	 * dragged width comes back on redo with the deletion still standing.
	 */
	it('keeps a drag out of the undo of the Step before it', async () => {
		const it_ = await realSession();
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 4.78, lat: 52.4 });
		await it_.settle();
		const kept = it_.annotations.selectedAnnotationId as string;
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 5.02, lat: 52.34 });
		await it_.settle();

		await it_.annotations.deleteSelected();
		await it_.settle();

		it_.annotations.selectAnnotation(kept);
		await dragTo(it_, 'stroke-width', [3, 5, 8]);
		await it_.annotations.commitAnnotationEdit();
		await it_.settle();

		const history = it_.session.historyFor(DIRECTORY);
		expect(await history.undo()).toBe(true);
		await it_.settle();
		const reverted = parseAnnotations(await it_.bytes(), { path: 'annotations' });
		// The drag is what was undone, so the deleted Annotation has not come back with it.
		expect(reverted.annotations.map((one) => one.id)).toEqual([kept]);
		expect(reverted.annotations[0]!.properties['stroke-width']).toBeUndefined();

		expect(await history.redo()).toBe(true);
		await it_.settle();
		const back = parseAnnotations(await it_.bytes(), { path: 'annotations' });
		expect(back.annotations.map((one) => one.id)).toEqual([kept]);
		expect(back.annotations[0]!.properties['stroke-width']).toBe(8);
	});

	/** A scholar who slides from one control to the next without letting go made two gestures. */
	it('closes the standing Step when a second slider reports', async () => {
		const it_ = await drawn();
		const before = await it_.bytes();

		await dragTo(it_, 'stroke-width', [3, 6]);
		await dragTo(it_, 'stroke-opacity', [0.9, 0.4]);
		await it_.annotations.commitAnnotationEdit();
		await it_.settle();

		const history = it_.session.historyFor(DIRECTORY);
		expect(await history.undo()).toBe(true);
		await it_.settle();
		const half = parseAnnotations(await it_.bytes(), { path: 'annotations' });
		// The width the first drag ended at survives the second drag being undone.
		expect(half.annotations[0]!.properties['stroke-width']).toBe(6);
		expect(half.annotations[0]!.properties['stroke-opacity']).toBeUndefined();

		expect(await history.undo()).toBe(true);
		await it_.settle();
		expect(await it_.bytes()).toEqual(before);
	});

	/** ADR-0010: tabbing through the panel is looking, and looking modifies no byte. */
	it('writes nothing when a slider is released without having moved', async () => {
		const it_ = await drawn();
		const before = await it_.bytes();

		await it_.annotations.commitAnnotationEdit();
		await it_.settle();

		expect(await it_.bytes()).toEqual(before);
		expect(it_.session.historyFor(DIRECTORY).undoable?.label).toBe('Undo drawing this Annotation');
	});
});
