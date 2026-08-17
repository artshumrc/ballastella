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
	newAnnotation,
	newAnnotationLayer,
	parseAnnotations,
	serialiseAnnotations,
	simpleStyleViolations,
	type Annotation,
	type AnnotationCollection,
	type AnnotationLayer,
	type Layer,
	type UndoRecord
} from '@ballastella/core';
import { describe, expect, it } from 'vitest';

import { AnnotationEditing, type AnnotationWriter } from './annotation-editing.svelte.js';

/** Every write this class made, in order, so "one gesture is one write" is a count. */
interface Write {
	layerId: string;
	collection: AnnotationCollection;
	debounce: boolean;
}

class FakeWriter implements AnnotationWriter {
	readonly writes: Write[] = [];
	/** What is on disk for a Layer this screen has not read, keyed by Layer id. */
	readonly onDisk = new Map<string, AnnotationCollection>();
	/** Layer ids whose read throws, standing in for a file that is there and unreadable. */
	readonly unreadable = new Set<string>();
	pending = false;
	recorded: { record: UndoRecord; apply: () => Promise<void> } | null = null;

	async readAnnotations(layer: AnnotationLayer): Promise<AnnotationCollection> {
		if (this.unreadable.has(layer.id)) throw new Error('the file could not be decoded');
		return this.onDisk.get(layer.id) ?? { annotations: [] };
	}

	async writeAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		this.writes.push({ layerId: layer.id, collection, debounce: options.debounce === true });
	}

	hasPendingAnnotationWrite(): boolean {
		return this.pending;
	}

	record(record: UndoRecord, apply: () => Promise<void>): void {
		this.recorded = { record, apply };
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

describe('undoing a deletion', () => {
	it('records the Layer the Annotation was in, after the write and not before', async () => {
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.put(layer, { annotations: [pin('a1'), pin('a2')] });
		it_.annotations.openLayer('one');
		it_.annotations.selectAnnotation('a2');

		await it_.annotations.deleteSelected();

		expect(it_.session.writes).toHaveLength(1);
		expect(it_.session.writes[0]!.collection.annotations.map((one) => one.id)).toEqual(['a1']);
		expect(it_.session.recorded?.record).toMatchObject({
			kind: 'annotation-deleted',
			layerId: 'one',
			at: 1
		});
	});

	it('refuses in words when the Layer it names has since been deleted, writing nothing', async () => {
		// Not reachable through the interface — deleting a Layer replaces the undo record — and that
		// is exactly why it needs a test: the alternative to saying so is writing the Annotation into
		// a Layer the user never deleted it from.
		const it_ = screen([layerNamed('two')]);

		await it_.annotations.restoreDeleted({
			kind: 'annotation-deleted',
			layerId: 'one',
			at: 0,
			annotation: pin('a1')
		});

		expect(it_.annotations.undoRefusal).toContain('no longer in this Project');
		expect(it_.session.writes).toEqual([]);
	});

	it('reads a hidden Layer’s file rather than assuming it is empty', async () => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE DATA-LOSS PATH THIS SEAM WAS ADDED FOR.                                           │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// `documents` holds only the Layers the map was given, and a hidden Annotation Layer is
		// absent from it. Restoring into an assumed-empty collection would write a file holding one
		// Annotation over a file holding twenty.
		const layer = layerNamed('one');
		const it_ = screen([layer]);
		it_.session.onDisk.set('one', {
			annotations: [pin('a1'), pin('a2'), pin('a3')]
		});

		await it_.annotations.restoreDeleted({
			kind: 'annotation-deleted',
			layerId: 'one',
			at: 1,
			annotation: pin('back')
		});

		expect(it_.annotations.undoRefusal).toBe('');
		expect(it_.session.writes).toHaveLength(1);
		expect(it_.session.writes[0]!.collection.annotations.map((one) => one.id)).toEqual([
			'a1',
			'back',
			'a2',
			'a3'
		]);
		// And the Layer is opened, so the user watches it come back rather than being told it did.
		expect(it_.annotations.openLayerId).toBe('one');
		expect(it_.annotations.selectedAnnotationId).toBe('back');
	});

	it('says why when that file cannot be read, and writes nothing over it', async () => {
		const layer = layerNamed('one', 'Harbour notes');
		const it_ = screen([layer]);
		it_.session.unreadable.add('one');

		await it_.annotations.restoreDeleted({
			kind: 'annotation-deleted',
			layerId: 'one',
			at: 0,
			annotation: pin('back')
		});

		expect(it_.annotations.undoRefusal).toContain('Harbour notes');
		expect(it_.annotations.undoRefusal).toContain('could not be decoded');
		expect(it_.session.writes).toEqual([]);
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
function drawing(tool: 'point' | 'line' | 'polygon') {
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
