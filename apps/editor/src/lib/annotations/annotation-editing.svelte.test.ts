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
	newAnnotation,
	newAnnotationLayer,
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
 */
function screen(initialLayers: Layer[]) {
	const session = new FakeWriter();
	const layers = $state(initialLayers);
	let documents: Record<string, unknown> = {};
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
		it_.annotations.popupAt = { lng: 0, lat: 0 };

		it_.annotations.openLayer('two');

		expect(it_.annotations.drawing.drawing).toBe(false);
		expect(it_.annotations.selectedAnnotationId).toBeNull();
		expect(it_.annotations.popupAt).toBeNull();
	});

	it('keeps the selection when an Annotation is opened from the map', () => {
		// The one path that deliberately does not go through `openLayer`: a click on the map is
		// *making* a selection, and clearing it would be clearing the thing the user just pointed at.
		const it_ = screen([layerNamed('one'), layerNamed('two')]);

		it_.annotations.openFromMap('two', 'a1', { lng: 4, lat: 52 });

		expect(it_.annotations.openLayerId).toBe('two');
		expect(it_.annotations.selectedAnnotationId).toBe('a1');
		expect(it_.annotations.popupAt).toEqual({ lng: 4, lat: 52 });
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
