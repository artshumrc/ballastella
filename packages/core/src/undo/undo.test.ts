import { describe, expect, it } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { emptyCollection, newAnnotation, removeAnnotation } from '../annotation/annotation.js';
import { parseAnnotations, serialiseAnnotations } from '../annotation/geojson.js';
import {
	newAnnotationLayer,
	newMapLayer,
	parseLayers,
	removeLayer,
	serialiseLayers,
	setLayerVisible,
	type Layer
} from '../project/layer.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import {
	UndoSlot,
	describeUndo,
	isControlPointUndo,
	layerFileRef,
	restoreAnnotation,
	restoreControlPoint,
	restoreLayer,
	type AnnotationDeletedUndo,
	type ControlPointDeletedUndo,
	type ControlPointMovedUndo,
	type LayerDeletedUndo,
	type UndoRecord
} from './undo.js';

const mapLayer = newMapLayer({
	id: 'l-map',
	name: 'La Floride',
	alignmentRef: 'alignments/floride-1657.json'
});
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
			path: mapLayer.alignmentRef,
			bytes: new TextEncoder().encode('{}')
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

	it('is recognised as belonging to one Historical Map', () => {
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

		const back = restoreAnnotation(after, record);
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
		const back = restoreAnnotation(emptied, record);

		expect(serialiseAnnotations(back)).toEqual(before);
		// And through a parse, which is what the app actually holds after a reload.
		expect(
			serialiseAnnotations(
				restoreAnnotation(
					parseAnnotations(serialiseAnnotations(emptied), { path: 'annotations/l-notes.geojson' }),
					record
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

		expect(restoreAnnotation(collection, record)).toBe(collection);
	});

	it('puts one back into a collection that has since been emptied', () => {
		const record: AnnotationDeletedUndo = {
			kind: 'annotation-deleted',
			layerId: 'l-notes',
			at: 4,
			annotation: dashed
		};

		expect(restoreAnnotation(emptyCollection(), record).annotations).toEqual([dashed]);
	});
});

describe('a deleted Layer', () => {
	const stack: readonly Layer[] = [notes, mapLayer];

	it('comes back at its own position, so undo does not discard the ordering', () => {
		const record: LayerDeletedUndo = {
			kind: 'layer-deleted',
			at: 1,
			layer: mapLayer,
			path: mapLayer.alignmentRef,
			bytes: null
		};

		const after = removeLayer(stack, 'l-map');
		expect(after.map((layer) => layer.id)).toEqual(['l-notes']);

		const back = restoreLayer(after, record);
		expect(back.map((layer) => layer.id)).toEqual(['l-notes', 'l-map']);
		// `order` follows the position, so the restored Layer's stored number agrees with the array.
		expect(back.map((layer) => layer.order)).toEqual([0, 1]);
		// Everything else about it, unchanged: its name, its opacity, its visibility, and the Alignment
		// it draws. `order` is the one field the stack owns rather than the record.
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
			path: mapLayer.alignmentRef,
			bytes: null
		};

		// The identity return is the no-op signal, so the caller writes nothing at all.
		expect(restoreLayer(stack, record)).toBe(stack);
		// And the document that would have been written holds one Layer per id, which is the property
		// `parseLayers` would otherwise enforce by throwing one away.
		const written = parseLayers(serialiseLayers(restoreLayer(stack, record)));
		expect(written.filter((layer) => layer.id === 'l-map')).toHaveLength(1);
	});

	it('names the file each kind of Layer draws, and claims none for a kind it cannot read', () => {
		expect(layerFileRef(mapLayer)).toBe('alignments/floride-1657.json');
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
 * The crux of the ticket, at the level a unit test can reach it: the record holds the bytes, so what
 * goes back is what was there — not a re-serialisation of a parsed model, and not whatever the store
 * happens to hold at the moment undo is pressed.
 */
describe('the record holds file bytes, independent of write state (ADR-0017)', () => {
	const path = 'amsterdam-1625/alignments/floride-1657.json';
	// Deliberately *not* what `serialiseAlignment` would produce: a colleague's file, with fields this
	// build carries rather than understands. A record that held a parsed Alignment would restore
	// something merely equivalent, and the byte-identity criterion would fail on exactly this file.
	const original = new TextEncoder().encode(
		'{\n\t"@context": "http://iiif.io/api/extension/georeference/1/context.json",\n' +
			'\t"type": "Annotation",\n\t"http://example.org/vocab#note": "kept"\n}\n'
	);

	it('puts the exact bytes back after autosave has already written the deletion', async () => {
		const store = new MemoryProjectStore();
		const autosave = new Autosave(store);
		await store.write(path, original);

		// The destructive action, all the way to storage: the record is taken first, and then the file
		// is gone from the store — which is the state a naive "revert to last saved state" cannot leave.
		const record: LayerDeletedUndo = {
			kind: 'layer-deleted',
			at: 0,
			layer: mapLayer,
			path: 'alignments/floride-1657.json',
			bytes: await store.read(path)
		};
		await store.delete(path);
		await expect(store.read(path)).rejects.toThrow(/Nothing is stored/);

		// The undo, through the same Autosave as every other edit — no bespoke save path.
		await autosave.commit(path, record.bytes as Uint8Array<ArrayBuffer>);
		await autosave.flush();

		expect(await store.read(path)).toEqual(original);
		expect(autosave.state).toBe('saved');
	});

	// The other half of "independent of write state": the record is a copy taken at the moment of
	// deletion, so nothing that happens to the store afterwards can change what undo restores.
	it('is not a view of the store, so a later write cannot change what it holds', async () => {
		const store = new MemoryProjectStore();
		await store.write(path, original);
		const held = await store.read(path);

		await store.write(path, new TextEncoder().encode('{"type":"Annotation","overwritten":true}\n'));

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

	// A non-destructive action cannot consume the slot, and that is structural rather than careful:
	// nothing on the paths that rename, reorder, toggle, or restyle reaches this class at all. What is
	// asserted here is the half a unit test can see — the slot is untouched by anything but `offer`.
	it('survives an edit that is not destructive', () => {
		const slot = new UndoSlot();
		slot.offer(record(3), async () => undefined);

		const toggled = setLayerVisible([notes, mapLayer], 'l-map', false);

		expect(toggled[1]?.visible).toBe(false);
		expect(describeUndo(slot.record as UndoRecord)).toBe('Undo delete of Control Point 3');
	});

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

	// A Control Point undo belongs to the Historical Map it was made on: once the user is aligning a
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
