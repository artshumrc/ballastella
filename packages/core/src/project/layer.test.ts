import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { imageDirectory, imageInfoPath } from './image-files.js';
import { parseProjectFile, serialiseProjectFile, newProjectFile } from './project-file.js';
import {
	addLayer,
	annotationPath,
	drawingOrder,
	emptyAnnotationCollection,
	findLayer,
	moveLayer,
	moveLayerDown,
	moveLayerUp,
	newAnnotationLayer,
	newMapLayer,
	parseLayers,
	removeLayer,
	renameLayer,
	serialiseLayers,
	setLayerVisible,
	setMapLayerOpacity,
	type AnnotationLayer,
	type Layer,
	type MapLayer
} from './layer.js';

const mapLayer = (fields: Partial<MapLayer> = {}): MapLayer => ({
	...newMapLayer({ id: 'l-map', name: 'La Floride', imageId: 'floride-1657' }),
	...fields
});

const annotationLayer = (fields: Partial<AnnotationLayer> = {}): AnnotationLayer => ({
	...newAnnotationLayer({ id: 'l-notes', name: 'Trade routes' }),
	...fields
});

describe('the Layer union (ADR-0002)', () => {
	// The whole reason ADR-0002 insists on a discriminated union rather than one type with
	// optional fields. The predictable failure of the latter is someone setting `opacity` on an
	// annotation Layer, observing nothing, and then "fixing" it by threading opacity through label
	// rendering that nobody asked for.
	//
	// `@ts-expect-error` is the assertion, and it is a *two-way* one: the line has to fail to
	// typecheck, so `pnpm --filter @ballastella/core exec tsc --noEmit` fails if `opacity` is ever
	// added to `AnnotationLayer` — an unused `@ts-expect-error` is itself an error.
	it('rejects opacity on an annotation Layer', () => {
		const layer: AnnotationLayer = {
			...newAnnotationLayer({ id: 'l-notes', name: 'Trade routes' }),
			// @ts-expect-error opacity exists on a map Layer alone (ADR-0002)
			opacity: 0.5
		};

		// The runtime half: nothing in the union's own construction path produces the field.
		expect(Object.keys(newAnnotationLayer({ id: 'l', name: 'n' }))).not.toContain('opacity');
		expect(layer.kind).toBe('annotation');
	});

	it('reaches opacity only after narrowing on kind', () => {
		const layers: Layer[] = [mapLayer({ opacity: 0.25 }), annotationLayer()];

		const opacities = layers.map((layer) => (layer.kind === 'map' ? layer.opacity : null));

		expect(opacities).toEqual([0.25, null]);
	});

	// ADR-0023: the Workspace owns where a Map Image sits on the earth, so a map Layer names the
	// image and carries nothing else about it. The two fields that are gone are named explicitly because
	// their absence *is* the contract: `alignmentRef` was a second name for a derivable path, and
	// `imageMode` was a claim that could disagree with the bytes on disk.
	it('names one Workspace Map Image and claims nothing else about it', () => {
		const layer = newMapLayer({ id: 'a', name: 'n', imageId: 'floride-1657' });

		expect(layer.imageId).toBe('floride-1657');
		expect(Object.keys(layer).sort()).toEqual([
			'id',
			'imageId',
			'kind',
			'name',
			'opacity',
			'order',
			'visible'
		]);
		// @ts-expect-error ADR-0023 deleted the stored Alignment reference; the path is derived from imageId
		expect(layer.alignmentRef).toBeUndefined();
		// @ts-expect-error ADR-0023 deleted the stored image mode; it is observed from the files instead
		expect(layer.imageMode).toBeUndefined();
	});

	it('derives an Annotation Layer’s file from its id, so the two cannot drift', () => {
		const layer = newAnnotationLayer({ id: 'l-notes', name: 'Trade routes' });

		expect(layer.geojsonRef).toBe(annotationPath('l-notes'));
		expect(layer.geojsonRef).toBe('annotations/l-notes.geojson');
	});

	it('starts an Annotation Layer from an empty FeatureCollection', () => {
		const text = new TextDecoder().decode(emptyAnnotationCollection());

		expect(JSON.parse(text)).toEqual({ type: 'FeatureCollection', features: [] });
		expect(text.endsWith('\n')).toBe(true);
	});
});

describe('display state changes', () => {
	const stack: readonly Layer[] = [
		annotationLayer({ id: 'top', order: 0 }),
		mapLayer({ id: 'middle', order: 1 }),
		mapLayer({ id: 'bottom', order: 2 })
	];

	it('renames any kind, including one this build cannot draw', () => {
		const foreign = parseLayers([{ id: 'f', kind: 'image-annotation', name: 'Cartouche' }]);

		expect(renameLayer(foreign, 'f', 'The cartouche')[0]?.name).toBe('The cartouche');
		expect(renameLayer(stack, 'middle', 'Boston 1775')[1]?.name).toBe('Boston 1775');
	});

	it('shows and hides both kinds', () => {
		expect(setLayerVisible(stack, 'top', false)[0]?.visible).toBe(false);
		expect(setLayerVisible(stack, 'middle', false)[1]?.visible).toBe(false);
	});

	it('sets opacity on a map Layer and clamps it', () => {
		const changed = setMapLayerOpacity(stack, 'middle', 0.4)[1];

		expect(changed?.kind === 'map' && changed.opacity).toBe(0.4);
		expect(setMapLayerOpacity(stack, 'middle', 4)[1]).toMatchObject({ opacity: 1 });
		expect(setMapLayerOpacity(stack, 'middle', -1)[1]).toMatchObject({ opacity: 0 });
	});

	// The union making the ADR-0002 failure impossible at runtime as well as at compile time: there
	// is no opacity on an annotation Layer to set, so this cannot quietly invent one.
	it('cannot put opacity on an annotation Layer', () => {
		const changed = setMapLayerOpacity(stack, 'top', 0.4);

		expect(changed[0]).toEqual(stack[0]);
		expect(Object.keys(changed[0] ?? {})).not.toContain('opacity');
	});

	it('leaves the Layer stack it was given alone', () => {
		const before = JSON.stringify(stack);

		renameLayer(stack, 'top', 'x');
		setLayerVisible(stack, 'top', false);
		setMapLayerOpacity(stack, 'middle', 0.1);
		moveLayer(stack, 'bottom', 0);
		removeLayer(stack, 'top');
		addLayer(stack, mapLayer({ id: 'new' }));

		expect(JSON.stringify(stack)).toBe(before);
	});

	it('finds a Layer by id', () => {
		expect(findLayer(stack, 'middle')?.id).toBe('middle');
		expect(findLayer(stack, 'nobody')).toBeUndefined();
	});
});

describe('ordering', () => {
	const ids = (layers: readonly Layer[]) => layers.map((layer) => layer.id);
	const orders = (layers: readonly Layer[]) => layers.map((layer) => layer.order);

	const stack: readonly Layer[] = parseLayers([
		{ id: 'a', kind: 'annotation', order: 0 },
		{ id: 'b', kind: 'map', order: 1 },
		{ id: 'c', kind: 'map', order: 2 }
	]);

	it('puts a new Layer at the top, where a freshly made one belongs', () => {
		expect(ids(addLayer(stack, mapLayer({ id: 'new' })))).toEqual(['new', 'a', 'b', 'c']);
	});

	it('moves a Layer to a position, across kinds', () => {
		expect(ids(moveLayer(stack, 'c', 0))).toEqual(['c', 'a', 'b']);
		expect(ids(moveLayer(stack, 'a', 2))).toEqual(['b', 'c', 'a']);
	});

	it('moves one place up and down', () => {
		expect(ids(moveLayerUp(stack, 'c'))).toEqual(['a', 'c', 'b']);
		expect(ids(moveLayerDown(stack, 'a'))).toEqual(['b', 'a', 'c']);
	});

	// The two buttons ask for a position; "the top Layer cannot go higher" is a disabled button,
	// not an exception.
	it('clamps rather than refusing at the ends', () => {
		expect(ids(moveLayerUp(stack, 'a'))).toEqual(['a', 'b', 'c']);
		expect(ids(moveLayerDown(stack, 'c'))).toEqual(['a', 'b', 'c']);
		expect(ids(moveLayer(stack, 'b', 99))).toEqual(['a', 'c', 'b']);
		expect(ids(moveLayer(stack, 'nobody', 0))).toEqual(['a', 'b', 'c']);
	});

	it('keeps order equal to the position after every move, so the two cannot drift', () => {
		expect(orders(moveLayer(stack, 'c', 0))).toEqual([0, 1, 2]);
		expect(orders(addLayer(stack, mapLayer({ id: 'new' })))).toEqual([0, 1, 2, 3]);
		expect(orders(removeLayer(stack, 'a'))).toEqual([0, 1]);
	});

	// The one place that knows drawing runs the other way from the list (ADR-0002: an annotation
	// Layer above a map Layer draws above it, so it must be added to the map *last*).
	it('draws bottom-to-top, so the top of the list ends up over everything', () => {
		expect(ids(drawingOrder(stack))).toEqual(['c', 'b', 'a']);
	});
});

describe('reading the layers array', () => {
	it('reads both kinds', () => {
		const layers = parseLayers([
			{
				kind: 'map',
				id: 'l-map',
				name: 'La Floride',
				visible: false,
				order: 0,
				opacity: 0.6,
				imageId: 'floride-1657'
			},
			{
				kind: 'annotation',
				id: 'l-notes',
				name: 'Trade routes',
				visible: true,
				order: 1,
				geojsonRef: 'annotations/l-notes.geojson',
				defaultStyle: { stroke: '#aa0000', 'stroke-dasharray': [8, 4] }
			}
		]);

		expect(layers[0]).toEqual({
			kind: 'map',
			id: 'l-map',
			name: 'La Floride',
			visible: false,
			order: 0,
			opacity: 0.6,
			imageId: 'floride-1657'
		});
		// **`defaultStyle` is carried, not interpreted.** A Layer no longer has one (ADR-0009, as
		// amended), and a Project written by an earlier build still says it — so it lands in
		// `unknownFields` like any other value this build does not understand, and is written back from
		// there. Opening such a Project preserves a user's bytes rather than deleting them (ADR-0010),
		// and its Annotations simply draw with simplestyle's own defaults where they say nothing.
		expect(layers[1]).toMatchObject({
			kind: 'annotation',
			unknownFields: { defaultStyle: { stroke: '#aa0000', 'stroke-dasharray': [8, 4] } }
		});
		expect(layers[1]).not.toHaveProperty('defaultStyle');
	});

	it('sorts by order and renumbers from it', () => {
		const layers = parseLayers([
			{ id: 'later', kind: 'map', order: 7 },
			{ id: 'earlier', kind: 'map', order: 2 }
		]);

		expect(layers.map((layer) => [layer.id, layer.order])).toEqual([
			['earlier', 0],
			['later', 1]
		]);
	});

	it('is stable on the file’s own order when order does not decide', () => {
		const layers = parseLayers([{ id: 'first' }, { id: 'second' }, { id: 'third' }]);

		expect(layers.map((layer) => layer.id)).toEqual(['first', 'second', 'third']);
	});

	// A Layer list is the map of everything (ADR-0017 rule 4), so a field of the wrong type costs
	// that field rather than the Project.
	it.each([
		['a missing name', { id: 'x', kind: 'map' }, { name: '' }],
		['a non-string name', { id: 'x', kind: 'map', name: 7 }, { name: '' }],
		['a missing visible', { id: 'x', kind: 'map' }, { visible: true }],
		['a non-boolean visible', { id: 'x', kind: 'map', visible: 'yes' }, { visible: true }],
		['a missing opacity', { id: 'x', kind: 'map' }, { opacity: 1 }],
		['an out-of-range opacity', { id: 'x', kind: 'map', opacity: 40 }, { opacity: 1 }],
		['a NaN opacity', { id: 'x', kind: 'map', opacity: Number.NaN }, { opacity: 1 }],
		['a missing imageId', { id: 'x', kind: 'map' }, { imageId: '' }],
		['a non-string imageId', { id: 'x', kind: 'map', imageId: 7 }, { imageId: '' }],
		// Not a field this build knows any more, so it is carried whatever it is rather than repaired.
		[
			'a defaultStyle from an earlier build',
			{ id: 'x', kind: 'annotation', defaultStyle: 3 },
			{ unknownFields: { defaultStyle: 3 } }
		]
	])('survives %s', (_description, raw, expected) => {
		expect(parseLayers([raw])[0]).toMatchObject(expected);
	});

	// There is nothing of the user's to keep in either: without an id a Layer cannot be shown,
	// named, reordered, or referenced by anything.
	it.each([
		['a string', 'not a layer'],
		['null', null],
		['an array', []],
		['a record with no id', { kind: 'map', name: 'nameless' }],
		['a record with an empty id', { id: '', kind: 'map' }],
		['a record with a non-string id', { id: 7, kind: 'map' }]
	])('drops %s, which cannot be a Layer under any kind', (_description, raw) => {
		expect(parseLayers([raw])).toEqual([]);
	});

	it('reads a non-array layers field as an empty stack rather than throwing', () => {
		expect(parseLayers(undefined)).toEqual([]);
		expect(parseLayers({ layers: 'nope' })).toEqual([]);
	});

	// A Layer's id is how the list addresses it: the keyed `{#each}` that draws the stack, the
	// `stackLayerId` MapLibre gets, the record the read documents are kept in, and every one of the
	// operations above. A second Layer claiming an id already taken is therefore not a Layer with a
	// damaged field but one that cannot be addressed at all — and the keyed list raises a hard error
	// on the duplicate, out of a parser whose stated contract is that it never throws.
	it('keeps the first Layer with an id and drops a later one claiming it again', () => {
		const layers = parseLayers([
			{ id: 'twice', kind: 'map', name: 'The original', order: 0 },
			{ id: 'other', kind: 'annotation', name: 'Beside it', order: 1 },
			{ id: 'twice', kind: 'map', name: 'The impostor', order: 2 }
		]);

		expect(layers.map((layer) => [layer.id, layer.name])).toEqual([
			['twice', 'The original'],
			['other', 'Beside it']
		]);
	});

	// Sorting happens after the duplicate is dropped, so which one survives is decided by the file's
	// own order rather than by whichever `order` number the impostor happened to carry.
	it('drops the duplicate by the file’s order, not by the order field it claims', () => {
		const layers = parseLayers([
			{ id: 'twice', kind: 'map', name: 'The original', order: 9 },
			{ id: 'twice', kind: 'map', name: 'The impostor', order: 0 }
		]);

		expect(layers.map((layer) => [layer.id, layer.name])).toEqual([['twice', 'The original']]);
	});
});

// ADR-0014 records image-space annotation as the expected next feature and asks that the
// discriminator tolerate a third kind. A build from before that kind existed has to be able to open
// a colleague's Project, move a label above a map, and save — without destroying the Layer it cannot
// draw.
describe('a kind this build has never heard of (ADR-0014)', () => {
	const foreign = {
		kind: 'image-annotation',
		id: 'l-cartouche',
		name: 'Cartouche',
		visible: true,
		order: 1,
		webAnnotationRef: 'image-annotations/l-cartouche.json',
		somethingNewer: { deep: ['value'] }
	};

	it('reads it as a Layer rather than throwing', () => {
		const layers = parseLayers([{ id: 'l-map', kind: 'map', order: 0 }, foreign]);

		expect(layers).toHaveLength(2);
		expect(layers[1]).toMatchObject({ kind: 'foreign', declaredKind: 'image-annotation' });
	});

	it('writes it back with its own kind and every field it arrived with', () => {
		expect(serialiseLayers(parseLayers([foreign]))[0]).toEqual({ ...foreign, order: 0 });
	});

	it('can be renamed, hidden, and reordered like any other Layer', () => {
		const stack = parseLayers([{ id: 'l-map', kind: 'map', order: 0 }, foreign]);

		const changed = setLayerVisible(
			renameLayer(moveLayerUp(stack, 'l-cartouche'), 'l-cartouche', 'The cartouche'),
			'l-cartouche',
			false
		);

		expect(changed.map((layer) => layer.id)).toEqual(['l-cartouche', 'l-map']);
		expect(serialiseLayers(changed)[0]).toEqual({
			...foreign,
			name: 'The cartouche',
			visible: false,
			order: 0
		});
	});

	it('is left alone by an opacity change aimed at it', () => {
		const stack = parseLayers([foreign]);

		expect(setMapLayerOpacity(stack, 'l-cartouche', 0.2)).toEqual(stack);
	});
});

describe('writing the layers array', () => {
	it('round-trips both kinds', () => {
		const layers = [
			mapLayer({ opacity: 0.3, visible: false }),
			annotationLayer({ order: 1, unknownFields: { defaultStyle: { fill: '#123456' } } })
		];

		expect(parseLayers(serialiseLayers(layers))).toEqual(layers);
	});

	it('round-trips idempotently, so a saved Project stops changing', () => {
		const once = serialiseLayers(parseLayers(serialiseLayers([mapLayer(), annotationLayer()])));

		expect(serialiseLayers(parseLayers(once))).toEqual(once);
	});

	// The same discipline `ProjectFile.unknownFields` applies to the document as a whole (ADR-0010).
	it('keeps a field a newer build added to a Layer it does know', () => {
		const raw = {
			kind: 'map',
			id: 'l-map',
			name: 'La Floride',
			visible: true,
			order: 0,
			opacity: 1,
			imageId: 'floride-1657',
			blendMode: 'multiply'
		};

		expect(serialiseLayers(parseLayers([raw]))[0]).toEqual(raw);
	});

	// What actually keeps `serialiseLayer`'s spread order safe: **no field this build writes can ever
	// end up in `unknownFields`**, so there is no collision for the spread order to resolve. That is
	// `COMMON_KEYS` plus each kind's own destructuring, and it is the invariant rather than the spread
	// order — reverse the spread and nothing changes; drop a key from `COMMON_KEYS`, or add a field to
	// a kind without destructuring it, and this goes red.
	it('never carries a field it writes itself, so unknownFields cannot shadow one', () => {
		const written = serialiseLayers([
			mapLayer(),
			annotationLayer({ order: 1 }),
			...parseLayers([{ id: 'l-cartouche', kind: 'image-annotation', order: 2 }])
		]);

		for (const record of written) {
			const parsed = parseLayers([record])[0];
			expect(Object.keys(parsed?.unknownFields ?? {})).toEqual([]);
		}
	});

	// The same claim from the other side, and the case that would actually bite: a field a future
	// author adds to `LayerCommon` and forgets to add to `COMMON_KEYS` is carried, and then the
	// carried copy is spread back over the one this build edits.
	it('carries nothing whose name a serialised Layer already uses', () => {
		for (const layer of [mapLayer(), annotationLayer(), ...parseLayers([{ id: 'f', kind: 'z' }])]) {
			const record = serialiseLayers([layer])[0] as Record<string, unknown>;
			const carried = Object.keys(parseLayers([record])[0]?.unknownFields ?? {});

			expect(carried.filter((key) => key in record)).toEqual([]);
		}
	});
});

describe('the Layer → Map Image link (ADR-0023)', () => {
	// Both Workspace paths come out of the one field, so there is no second name to disagree with the
	// first — and both are complete store paths, with no Project directory anywhere in them. That last
	// part is what `scripts/check-workspace-rooted-paths.mjs` enforces, and its failure mode is a pane
	// of somebody else's map rather than an error.
	it('derives the Alignment and the pyramid from the image id alone', () => {
		const layer = mapLayer();

		expect(alignmentPath(layer.imageId)).toBe('alignments/floride-1657.json');
		expect(imageInfoPath(layer.imageId)).toBe('images/floride-1657/info.json');
		expect(imageDirectory(layer.imageId)).toBe('images/floride-1657');
	});

	// Two Projects referencing the same image is the behaviour ADR-0023 exists for, and at the level of
	// the model it is this: two Layers, different ids, different display state, one image id — and
	// therefore one Alignment path and one pyramid.
	it('lets two Projects name the same Map Image with their own display state', () => {
		const mine = newMapLayer({ id: 'l-1', name: 'My reading', imageId: 'floride-1657' });
		const theirs = newMapLayer({ id: 'l-2', name: 'Course copy', imageId: 'floride-1657' });

		expect(mine.id).not.toBe(theirs.id);
		expect(mine.name).not.toBe(theirs.name);
		expect(alignmentPath(mine.imageId)).toBe(alignmentPath(theirs.imageId));
		expect(imageDirectory(mine.imageId)).toBe(imageDirectory(theirs.imageId));
	});
});

describe('the Layer stack inside project.json', () => {
	const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

	it('round-trips through the document', () => {
		const file = {
			...newProjectFile('Amsterdam 1625', new Date(0)),
			layers: [annotationLayer(), mapLayer({ opacity: 0.5, order: 1 })]
		};

		expect(parseProjectFile(serialiseProjectFile(file))).toEqual(file);
	});

	it('serialises byte-identically for an unchanged Project with Layers', () => {
		const file = {
			...newProjectFile('Amsterdam 1625', new Date(0)),
			layers: [annotationLayer(), mapLayer({ order: 1 })]
		};

		expect(serialiseProjectFile(file)).toEqual(
			serialiseProjectFile(parseProjectFile(serialiseProjectFile(file)))
		);
	});

	// The refusal is checked before anything else in the document is trusted, so a Layer list that
	// this build would read differently cannot be read at all.
	it('does not read the Layer stack of a Project from the future', () => {
		const bytes = new TextEncoder().encode(
			JSON.stringify({ formatVersion: 2, layers: [{ id: 'x', kind: 'map' }] })
		);

		expect(() => parseProjectFile(bytes)).toThrow(/newer version/);
	});

	it('keeps the document’s own unknown fields when the stack changes', () => {
		const original = new TextEncoder().encode(
			JSON.stringify({
				formatVersion: 1,
				name: 'Amsterdam 1625',
				updatedAt: '2026-01-01T00:00:00.000Z',
				layers: [{ id: 'x', kind: 'map', order: 0 }],
				baseMap: null,
				somethingNewer: { deep: ['value'] }
			})
		);

		const opened = parseProjectFile(original);
		const rewritten = JSON.parse(
			decode(serialiseProjectFile({ ...opened, layers: renameLayer(opened.layers, 'x', 'Named') }))
		);

		expect(rewritten.somethingNewer).toEqual({ deep: ['value'] });
		expect(rewritten.layers[0].name).toBe('Named');
	});
});
