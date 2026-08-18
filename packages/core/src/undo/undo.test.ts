import { describe, expect, it } from 'vitest';

import { seedAlignmentFixture } from '../alignment/alignment-fixture.js';
import { Autosave } from '../autosave/autosave.js';
import {
	emptyCollection,
	insertAnnotationAt,
	newAnnotation,
	removeAnnotation
} from '../annotation/annotation.js';
import { parseAnnotations, serialiseAnnotations } from '../annotation/geojson.js';
import {
	insertLayerAt,
	newAnnotationLayer,
	newMapLayer,
	parseLayers,
	removeLayer,
	serialiseLayers,
	type Layer
} from '../project/layer.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import {
	UndoSlot,
	describeUndo,
	isControlPointUndo,
	layerFileRef,
	restoreControlPoint,
	type AnnotationDeletedUndo,
	type ControlPointDeletedUndo,
	type ControlPointMovedUndo,
	type LayerDeletedUndo,
	type UndoRecord
} from './undo.js';

const mapLayer = newMapLayer({ id: 'l-map', name: 'La Floride', imageId: 'floride-1657' });
const notes = newAnnotationLayer({ id: 'l-notes', name: 'Trade routes' });

const drafts = [
	{ id: 'p0', resource: { x: 10, y: 20 }, geo: { lng: 4.9, lat: 52.3 } },
	{ id: 'p1', resource: { x: 30, y: 40 }, geo: { lng: 5.1, lat: 52.4 } },
	{ id: 'p2', resource: { x: 50, y: 60 }, geo: { lng: 5.3, lat: 52.5 } }
];

describe('what the undo affordance says (SPEC story 38)', () => {
	// A bare "Undo" button after an accidental delete is not reassuring: the user's question is
	// whether they lost the thing they think they lost, so the answer has to be on the control.
	it('names the action it will reverse, for each of the four kinds', () => {
		const moved: ControlPointMovedUndo = {
			kind: 'control-point-moved',
			imageId: 'floride-1657',
			pointId: 'p6',
			ordinal: 7,
			resource: { x: 1, y: 2 },
			geo: { lng: 3, lat: 4 }
		};
		const deleted: ControlPointDeletedUndo = {
			kind: 'control-point-deleted',
			imageId: 'floride-1657',
			ordinal: 7,
			at: 6,
			point: { id: 'p6', resource: { x: 1, y: 2 }, geo: { lng: 3, lat: 4 } }
		};
		const annotation: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: 'l-notes',
			at: 2,
			annotation: newAnnotation({
				id: 'a1',
				geometry: { type: 'Point', coordinates: [4.9, 52.3] },
				title: 'Fort Amsterdam'
			})
		};
		const layer: LayerDeletedUndo = {
			kind: 'layer-deleted',
			at: 1,
			layer: mapLayer,
			path: layerFileRef(mapLayer),
			bytes: null
		};

		expect(describeUndo(moved)).toBe('Undo move of Control Point 7');
		expect(describeUndo(deleted)).toBe('Undo delete of Control Point 7');
		expect(describeUndo(annotation)).toBe('Undo delete of “Fort Amsterdam”');
		expect(describeUndo(layer)).toBe('Undo delete of the Layer “La Floride”');
	});

	// The affordance is the *only* place the user finds out what they are about to get back, so a
	// thing they never titled still has to read as a sentence rather than as empty quotation marks.
	it('says something readable about a thing the user never named', () => {
		expect(
			describeUndo({
				kind: 'annotation-deleted',
				layerId: 'l-notes',
				at: 0,
				annotation: newAnnotation({ id: 'a1', geometry: null })
			})
		).toBe('Undo delete of this Annotation');
		expect(
			describeUndo({
				kind: 'layer-deleted',
				at: 0,
				layer: { ...mapLayer, name: '' },
				path: '',
				bytes: null
			})
		).toBe('Undo delete of the Layer with no name');
	});
});

describe('a moved Control Point (ADR-0022)', () => {
	it('goes back to exactly where it was, both halves', () => {
		const record: ControlPointMovedUndo = {
			kind: 'control-point-moved',
			imageId: 'floride-1657',
			pointId: 'p1',
			ordinal: 2,
			resource: { x: 30, y: 40 },
			geo: { lng: 5.1, lat: 52.4 }
		};
		// The drag: one half moved, and the pair is written that way.
		const moved = drafts.map((draft) =>
			draft.id === 'p1' ? { ...draft, resource: { x: 333, y: 444 } } : draft
		);

		expect(restoreControlPoint(moved, record)).toEqual(drafts);
	});

	// Reference equality is how every operation in `alignment.ts` and `layer.ts` reports "nothing
	// changed", and it is what keeps a no-op from costing a write of an unchanged document.
	it('returns the drafts it was given when the pair has since gone', () => {
		const without = drafts.filter((draft) => draft.id !== 'p1');
		const record: ControlPointMovedUndo = {
			kind: 'control-point-moved',
			imageId: 'floride-1657',
			pointId: 'p1',
			ordinal: 2,
			resource: { x: 30, y: 40 },
			geo: { lng: 5.1, lat: 52.4 }
		};

		expect(restoreControlPoint(without, record)).toBe(without);
	});
});

describe('a deleted Control Point pair', () => {
	// The ordinal is derived from position (ADR-0022), so putting the pair back at its own index is
	// the *only* thing that restores its number. Restoring it at the end would renumber it silently.
	it('comes back at its own index, which is what restores its ordinal', () => {
		const record: ControlPointDeletedUndo = {
			kind: 'control-point-deleted',
			imageId: 'floride-1657',
			ordinal: 2,
			at: 1,
			point: drafts[1] as (typeof drafts)[number]
		};
		const without = drafts.filter((draft) => draft.id !== 'p1');

		const back = restoreControlPoint(without, record);

		expect(back).toEqual(drafts);
		expect(back.findIndex((draft) => draft.id === 'p1')).toBe(1);
	});

	it('refuses to put the same pair back twice', () => {
		const record: ControlPointDeletedUndo = {
			kind: 'control-point-deleted',
			imageId: 'floride-1657',
			ordinal: 2,
			at: 1,
			point: drafts[1] as (typeof drafts)[number]
		};

		expect(restoreControlPoint(drafts, record)).toBe(drafts);
	});

	it('is recognised as belonging to one Map Image', () => {
		const record: ControlPointDeletedUndo = {
			kind: 'control-point-deleted',
			imageId: 'floride-1657',
			ordinal: 1,
			at: 0,
			point: drafts[0] as (typeof drafts)[number]
		};

		expect(isControlPointUndo(record)).toBe(true);
		expect(
			isControlPointUndo({ kind: 'layer-deleted', at: 0, layer: mapLayer, path: '', bytes: null })
		).toBe(false);
	});
});

/**
 * A deleted Annotation goes back through `insertAnnotationAt` — the ordinary insert, called with the
 * record's `annotation` and its `at`, exactly as `routes/layers/+page.svelte` calls it. Driven here
 * rather than through a pass-through of undo's own, because a second name for one insert is a second
 * thing to keep true; what is undo's about these is *which* arguments the record supplies.
 */
describe('a deleted Annotation', () => {
	const dashed = {
		...newAnnotation({
			id: 'a2',
			geometry: {
				type: 'LineString',
				coordinates: [
					[4.9, 52.3],
					[5.1, 52.4]
				]
			},
			title: 'Conjectural route'
		}),
		properties: {
			title: 'Conjectural route',
			description: 'Reconstructed from the 1625 survey.',
			stroke: '#aa0000',
			'stroke-dasharray': [1, 3] as readonly [number, number],
			unknownProperties: { 'qgis:label': 'kept' }
		}
	};

	it('comes back at its own position with every property, including stroke-dasharray', () => {
		const pin = newAnnotation({ id: 'a1', geometry: { type: 'Point', coordinates: [4.8, 52.2] } });
		const last = newAnnotation({ id: 'a3', geometry: { type: 'Point', coordinates: [5, 52] } });
		const collection = { annotations: [pin, dashed, last] };
		const record: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: 'l-notes',
			at: 1,
			annotation: dashed
		};

		const after = removeAnnotation(collection, 'a2');
		expect(after.annotations).toHaveLength(2);

		const back = insertAnnotationAt(after, record.annotation, record.at);
		expect(back.annotations.map((one) => one.id)).toEqual(['a1', 'a2', 'a3']);
		expect(back.annotations[1]).toEqual(dashed);
	});

	// The record has to hold what the *file* holds, not a model that happens to look similar: ticket
	// 10 asserts that an unchanged Annotation serialises byte-identically, and a restored one has to
	// clear the same bar or the undo has quietly rewritten the user's document.
	it('restores a GeoJSON document byte-identically', () => {
		const collection = { annotations: [dashed] };
		const before = serialiseAnnotations(collection);
		const record: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: 'l-notes',
			at: 0,
			annotation: dashed
		};

		const emptied = removeAnnotation(collection, 'a2');
		const back = insertAnnotationAt(emptied, record.annotation, record.at);

		expect(serialiseAnnotations(back)).toEqual(before);
		// And through a parse, which is what the app actually holds after a reload.
		expect(
			serialiseAnnotations(
				insertAnnotationAt(
					parseAnnotations(serialiseAnnotations(emptied), { path: 'annotations/l-notes.geojson' }),
					record.annotation,
					record.at
				)
			)
		) //
			.toEqual(before);
	});

	it('refuses to put the same Annotation back twice', () => {
		const collection = { annotations: [dashed] };
		const record: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: 'l-notes',
			at: 0,
			annotation: dashed
		};

		expect(insertAnnotationAt(collection, record.annotation, record.at)).toBe(collection);
	});

	it('puts one back into a collection that has since been emptied', () => {
		const record: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: 'l-notes',
			at: 4,
			annotation: dashed
		};

		expect(insertAnnotationAt(emptyCollection(), record.annotation, record.at).annotations).toEqual(
			[dashed]
		);
	});
});

/**
 * And a deleted Layer goes back through `insertLayerAt`, which is what `EditorSession.#restoreLayer`
 * calls. Its *file* is not that function's business — the bytes are in the record and go back through
 * the store, which is the block below.
 */
describe('a deleted Layer', () => {
	const stack: readonly Layer[] = [notes, mapLayer];

	it('comes back at its own position, so undo does not discard the ordering', () => {
		const record: LayerDeletedUndo = {
			kind: 'layer-deleted',
			at: 1,
			layer: mapLayer,
			path: layerFileRef(mapLayer),
			bytes: null
		};

		const after = removeLayer(stack, 'l-map');
		expect(after.map((layer) => layer.id)).toEqual(['l-notes']);

		const back = insertLayerAt(after, record.layer, record.at);
		expect(back.map((layer) => layer.id)).toEqual(['l-notes', 'l-map']);
		// `order` follows the position, so the restored Layer's stored number agrees with the array.
		expect(back.map((layer) => layer.order)).toEqual([0, 1]);
		// Everything else about it, unchanged: its name, its opacity, its visibility, and the Map
		// Image it draws. `order` is the one field the stack owns rather than the record.
		expect(back[1]).toEqual({ ...mapLayer, order: 1 });
	});

	/**
	 * `parseLayers` drops a duplicate id (ticket 09's remediation), so an undo that inserted a second
	 * Layer with an id already in the stack would write a document whose next read silently loses one
	 * of the two — and would hand a keyed `{#each}` the same key twice in the meantime, which is a hard
	 * error in dev and list corruption in a production build.
	 */
	it('refuses to restore an id that is already back, and never writes a duplicate', () => {
		const record: LayerDeletedUndo = {
			kind: 'layer-deleted',
			at: 1,
			layer: { ...mapLayer, name: 'The name it had when it was deleted' },
			path: layerFileRef(mapLayer),
			bytes: null
		};

		// The identity return is the no-op signal, so the caller writes nothing at all — `#restoreLayer`
		// checks for exactly this and returns before it touches `project.json`.
		expect(insertLayerAt(stack, record.layer, record.at)).toBe(stack);
		// And the document that would have been written holds one Layer per id, which is the property
		// `parseLayers` would otherwise enforce by throwing one away.
		const written = parseLayers(serialiseLayers(insertLayerAt(stack, record.layer, record.at)));
		expect(written.filter((layer) => layer.id === 'l-map')).toHaveLength(1);
	});

	// ADR-0023 and SPEC story 67: removing a Layer leaves the Map Image available. A map Layer's
	// Alignment and pyramid are the Workspace's and may be drawn by other Projects, so a delete must take
	// **nothing** with it — which is why `layerFileRef` answers `''` for one. Returning the Alignment path
	// here would make one Project's delete button destroy another Project's map.
	it('claims no file for a map Layer, because its Map Image is the Workspace’s', () => {
		expect(layerFileRef(mapLayer)).toBe('');
		expect(layerFileRef(notes)).toBe('annotations/l-notes.geojson');
		expect(
			layerFileRef({
				kind: 'foreign',
				declaredKind: 'image-annotation',
				id: 'l-cartouche',
				name: 'Cartouche',
				visible: true,
				order: 0,
				unknownFields: { webAnnotationRef: 'image-annotations/l-cartouche.json' }
			})
		).toBe('');
	});
});

/**
 * The crux of the ticket at the level a unit test can reach it: a deletion driven all the way to
 * storage, offered to the slot, and then reversed **by taking the slot and running what it hands
 * back** — so what is exercised is the record, the slot, and the bytes going back through `Autosave`,
 * rather than a rehearsal of those steps by hand.
 *
 * What is *not* here is `EditorSession.deleteLayer` and its `#restoreLayer`, which assemble the record
 * and supply the closure below in the running app; those need a browser and are the first two tests of
 * `e2e/editor-undo.e2e.ts`, which assert the restored file byte-for-byte against the deleted one.
 */
describe('a deletion reversed through the slot, after it reached storage (ADR-0017)', () => {
	// At the Workspace root: an Alignment is shared by every Project (ADR-0023), so undoing its
	// deletion puts the bytes back where every Project reads them from.
	const IMAGE_ID = 'floride-1657';
	// A plain `StorePath`, matching `LayerDeletedUndo.path`, which is what the record really carries.
	// Not `alignmentPath(IMAGE_ID)`: that is an `AlignmentPath`, and the undo closure below commits it
	// through `Autosave` exactly as `deleteLayer` does — which ticket 18's brand refuses, correctly.
	// Production never records an Alignment delete for precisely the reason `undo.ts` gives: one
	// Project's delete button must not destroy a Map Image every Project shares.
	const path: StorePath = `alignments/${IMAGE_ID}.json`;
	// Deliberately *not* what `serialiseAlignment` would produce: a colleague's file, with fields this
	// build carries rather than understands. A record that held a parsed Alignment would restore
	// something merely equivalent, and the byte-identity criterion would fail on exactly this file.
	const original = new TextEncoder().encode(
		'{\n\t"@context": "http://iiif.io/api/extension/georeference/1/context.json",\n' +
			'\t"type": "Annotation",\n\t"http://example.org/vocab#note": "kept"\n}\n'
	);

	it('puts the exact bytes and the stack entry back when the slot is taken', async () => {
		const store = new MemoryProjectStore();
		const autosave = new Autosave(store);
		const slot = new UndoSlot();
		await seedAlignmentFixture(store, IMAGE_ID, original);
		let stack: readonly Layer[] = [notes, mapLayer];

		// The destructive action, all the way to storage: the bytes are read into the record first, and
		// then the entry and the file are both gone — the state a naive "revert to the last saved state"
		// cannot come back from, because the deletion *is* the last saved state.
		const record: LayerDeletedUndo = {
			kind: 'layer-deleted',
			at: 1,
			layer: mapLayer,
			path: 'alignments/floride-1657.json',
			bytes: await store.read(path)
		};
		stack = removeLayer(stack, 'l-map');
		await store.delete(path);
		// Offered exactly as `deleteLayer` offers it: the record, and a closure that puts the file back
		// through the same Autosave as every other edit — there is no bespoke save path here.
		slot.offer(record, async () => {
			// alignment-write-is-the-fixture: the undo closure exactly as deleteLayer offers it, restoring the bytes it captured before the delete
			await autosave.commit(path, record.bytes as Uint8Array<ArrayBuffer>);
			stack = insertLayerAt(stack, record.layer, record.at);
		});
		await expect(store.read(path)).rejects.toThrow(/Nothing is stored/);
		expect(stack.map((layer) => layer.id)).toEqual(['l-notes']);

		// Undo pressed. `take` empties the slot and hands back the work, so a second press finds nothing.
		await slot.take()?.();
		await autosave.flush();

		expect(await store.read(path)).toEqual(original);
		expect(stack.map((layer) => layer.id)).toEqual(['l-notes', 'l-map']);
		expect(autosave.state).toBe('saved');
		expect(slot.record).toBeNull();
		expect(slot.take()).toBeNull();
	});

	// The other half of "independent of write state": the record is a copy taken at the moment of
	// deletion, so nothing that happens to the store afterwards can change what undo restores.
	it('is not a view of the store, so a later write cannot change what it holds', async () => {
		const store = new MemoryProjectStore();
		await seedAlignmentFixture(store, IMAGE_ID, original);
		const held = await store.read(path);

		await seedAlignmentFixture(
			store,
			IMAGE_ID,
			new TextEncoder().encode('{"type":"Annotation","overwritten":true}\n') as Bytes
		);

		expect(held).toEqual(original);
	});
});

describe('the one undo slot (ADR-0014)', () => {
	const record = (ordinal: number): UndoRecord => ({
		kind: 'control-point-deleted',
		imageId: 'floride-1657',
		ordinal,
		at: ordinal - 1,
		point: { id: `p${ordinal}`, resource: { x: 1, y: 2 }, geo: { lng: 3, lat: 4 } }
	});

	it('starts empty, so nothing is offered before anything destructive has happened', () => {
		expect(new UndoSlot().record).toBeNull();
	});

	// One level, not a stack: the second destructive action is what undo reverses, and the first is
	// gone. This is the fence ADR-0014 draws, made structural.
	it('holds the last destructive action and only that one', () => {
		const slot = new UndoSlot();
		slot.offer(record(1), async () => undefined);
		slot.offer(record(2), async () => undefined);

		expect(describeUndo(slot.record as UndoRecord)).toBe('Undo delete of Control Point 2');
	});

	it('is emptied by taking it, so a second undo does nothing and is not offered', async () => {
		const slot = new UndoSlot();
		let applied = 0;
		slot.offer(record(1), async () => {
			applied += 1;
		});

		await slot.take()?.();
		expect(applied).toBe(1);
		expect(slot.take()).toBeNull();
		expect(slot.record).toBeNull();
	});

	// **"A non-destructive edit leaves the delete still undoable" is not asserted here, deliberately.**
	// Nothing on the paths that rename, reorder, toggle, or restyle reaches this class at all, so any
	// unit test of it would call `setLayerVisible` on an array this slot has never heard of and then
	// find the slot unchanged — true by construction, and green against an app that had wired a
	// visibility toggle straight into `offer`. The claim is about the app's wiring, so it is asserted
	// where the wiring is: `e2e/editor-undo.e2e.ts`, "a visibility toggle and a rename leave the delete
	// still undoable".

	it('tells a subscriber what is in it, now and on every change', () => {
		const slot = new UndoSlot();
		const seen: (string | null)[] = [];
		const stop = slot.subscribe((held) => seen.push(held === null ? null : describeUndo(held)));

		slot.offer(record(1), async () => undefined);
		slot.clear();
		stop();
		slot.offer(record(2), async () => undefined);

		expect(seen).toEqual([null, 'Undo delete of Control Point 1', null]);
	});

	// The Project has been closed. The record is in memory for the life of one open Project and is
	// deliberately not persisted (ADR-0014).
	it('is cleared outright, and clearing an empty slot tells nobody', () => {
		const slot = new UndoSlot();
		let changes = 0;
		slot.subscribe(() => (changes += 1));

		slot.clear();
		expect(changes).toBe(1);

		slot.offer(record(1), async () => undefined);
		slot.clear();
		expect(changes).toBe(3);
		expect(slot.record).toBeNull();
	});

	// A Control Point undo belongs to the Map Image it was made on: once the user is aligning a
	// different one, an affordance offering to move a point they cannot see is worse than none.
	it('forgets a record that no longer applies, and keeps one that does', () => {
		const slot = new UndoSlot();
		slot.offer(record(1), async () => undefined);
		slot.clearIf((held) => isControlPointUndo(held) && held.imageId !== 'floride-1657');
		expect(slot.record).not.toBeNull();

		slot.clearIf((held) => isControlPointUndo(held) && held.imageId !== 'amsterdam-1625');
		expect(slot.record).toBeNull();
	});
});
