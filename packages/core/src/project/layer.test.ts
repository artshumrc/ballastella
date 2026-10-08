import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { decode, encode } from '../test-support.js';
import { imageDirectory, imageInfoPath } from './image-files.js';
import { parseProjectFile, serialiseProjectFile, newProjectFile } from './project-file.js';
import {
	addLayer,
	annotationPath,
	drawingOrder,
	emptyAnnotationCollection,
	layerFileRef,
	moveLayer,
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
	// An unused `@ts-expect-error` is itself an error, so this asserts both ways.
	it('rejects opacity on an annotation Layer', () => {
		const layer: AnnotationLayer = {
			...newAnnotationLayer({ id: 'l-notes', name: 'Trade routes' }),
			// @ts-expect-error opacity exists on a map Layer alone (ADR-0002)
			opacity: 0.5
		};

		expect(Object.keys(newAnnotationLayer({ id: 'l', name: 'n' }))).not.toContain('opacity');
		expect(layer.kind).toBe('annotation');
	});

	it('reaches opacity only after narrowing on kind', () => {
		const layers: Layer[] = [mapLayer({ opacity: 0.25 }), annotationLayer()];
		const opacities = layers.map((layer) => (layer.kind === 'map' ? layer.opacity : null));
		expect(opacities).toEqual([0.25, null]);
	});

	it('names one Workspace Map Image, whose files derive from its id, and claims nothing else', () => {
		const layer = newMapLayer({ id: 'a', name: 'n', imageId: 'floride-1657' });
		expect(layer.imageId).toBe('floride-1657');
		expect(Object.keys(layer).sort()).toEqual(
			'id imageId kind name opacity order visible'.split(' ')
		);
		expect(alignmentPath(layer.imageId)).toBe('alignments/floride-1657.json');
		expect(imageInfoPath(layer.imageId)).toBe('images/floride-1657/info.json');
		expect(imageDirectory(layer.imageId)).toBe('images/floride-1657');
		// @ts-expect-error ADR-0023 deleted the stored Alignment reference; the path is derived from imageId
		expect(layer.alignmentRef).toBeUndefined();
		// @ts-expect-error ADR-0023 deleted the stored image mode; it is observed from the files instead
		expect(layer.imageMode).toBeUndefined();
	});

	it('derives an Annotation Layer’s file from its id, and starts it as an empty FeatureCollection', () => {
		const layer = newAnnotationLayer({ id: 'l-notes', name: 'Trade routes' });
		expect(layer.geojsonRef).toBe(annotationPath('l-notes'));
		expect(layer.geojsonRef).toBe('annotations/l-notes.geojson');
		const text = decode(emptyAnnotationCollection());
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

	it('renames, shows and hides both kinds', () => {
		expect(renameLayer(stack, 'middle', 'Boston 1775')[1]?.name).toBe('Boston 1775');
		expect(setLayerVisible(stack, 'top', false)[0]?.visible).toBe(false);
		expect(setLayerVisible(stack, 'middle', false)[1]?.visible).toBe(false);
	});

	it('sets and clamps opacity on a map Layer, and cannot put it on an annotation Layer', () => {
		const set = setMapLayerOpacity(stack, 'middle', 0.4)[1];
		expect(set?.kind === 'map' && set.opacity).toBe(0.4);
		expect(setMapLayerOpacity(stack, 'middle', 4)[1]).toMatchObject({ opacity: 1 });
		expect(setMapLayerOpacity(stack, 'middle', -1)[1]).toMatchObject({ opacity: 0 });
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

	it('moves a Layer to a position, across kinds, clamping rather than refusing at the ends', () => {
		expect(ids(moveLayer(stack, 'c', 0))).toEqual(['c', 'a', 'b']);
		expect(ids(moveLayer(stack, 'a', 2))).toEqual(['b', 'c', 'a']);
		expect(ids(moveLayer(stack, 'b', 99))).toEqual(['a', 'c', 'b']);
		expect(ids(moveLayer(stack, 'nobody', 0))).toEqual(['a', 'b', 'c']);
	});

	it('keeps order equal to the position after every move, so the two cannot drift', () => {
		expect(orders(moveLayer(stack, 'c', 0))).toEqual([0, 1, 2]);
		expect(orders(addLayer(stack, mapLayer({ id: 'new' })))).toEqual([0, 1, 2, 3]);
		expect(orders(removeLayer(stack, 'a'))).toEqual([0, 1]);
	});

	it('draws bottom-to-top, so the top of the list ends up over everything', () => {
		expect(ids(drawingOrder(stack))).toEqual(['c', 'b', 'a']);
	});
});

describe('reading the layers array', () => {
	it('reads both kinds', () => {
		const map = mapLayer({ visible: false, opacity: 0.6 });
		const defaultStyle = { stroke: '#aa0000', 'stroke-dasharray': [8, 4] };
		const layers = parseLayers([map, { ...annotationLayer({ order: 1 }), defaultStyle }]);
		expect(layers[0]).toEqual(map);
		expect(layers[1]).toMatchObject({ kind: 'annotation', unknownFields: { defaultStyle } });
		expect(layers[1]).not.toHaveProperty('defaultStyle');
	});

	it('sorts by order and renumbers from it, keeping the file’s order where order does not decide', () => {
		const layers = parseLayers([
			{ id: 'later', kind: 'map', order: 7 },
			{ id: 'earlier', kind: 'map', order: 2 }
		]);
		expect(layers.map((layer) => [layer.id, layer.order])).toEqual([
			['earlier', 0],
			['later', 1]
		]);
		const unordered = parseLayers([{ id: 'first' }, { id: 'second' }, { id: 'third' }]);
		expect(unordered.map((layer) => layer.id)).toEqual(['first', 'second', 'third']);
	});

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
		[
			'a defaultStyle from an earlier build',
			{ id: 'x', kind: 'annotation', defaultStyle: 3 },
			{ unknownFields: { defaultStyle: 3 } }
		]
	])('survives %s', (_description, raw, expected) => {
		expect(parseLayers([raw])[0]).toMatchObject(expected);
	});

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

	it('keeps the first Layer with an id by the file’s order, not by the order field it claims', () => {
		const named = (raw: unknown[]) => parseLayers(raw).map((layer) => [layer.id, layer.name]);
		expect(
			named([
				{ id: 'twice', kind: 'map', name: 'The original', order: 0 },
				{ id: 'other', kind: 'annotation', name: 'Beside it', order: 1 },
				{ id: 'twice', kind: 'map', name: 'The impostor', order: 2 }
			])
		).toEqual([
			['twice', 'The original'],
			['other', 'Beside it']
		]);
		expect(
			named([
				{ id: 'twice', kind: 'map', name: 'The original', order: 9 },
				{ id: 'twice', kind: 'map', name: 'The impostor', order: 0 }
			])
		).toEqual([['twice', 'The original']]);
	});
});

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

	it('reads it as a Layer, and writes it back with its own kind and every field it arrived with', () => {
		const layers = parseLayers([{ id: 'l-map', kind: 'map', order: 0 }, foreign]);
		expect(layers).toHaveLength(2);
		expect(layers[1]).toMatchObject({ kind: 'foreign', declaredKind: 'image-annotation' });
		expect(serialiseLayers(parseLayers([foreign]))[0]).toEqual({ ...foreign, order: 0 });
	});

	it('can be renamed, hidden, and reordered like any other Layer, but takes no opacity', () => {
		const stack = parseLayers([{ id: 'l-map', kind: 'map', order: 0 }, foreign]);
		expect(setMapLayerOpacity(stack, 'l-cartouche', 0.2)).toEqual(stack);

		const changed = setLayerVisible(
			renameLayer(moveLayer(stack, 'l-cartouche', 0), 'l-cartouche', 'The cartouche'),
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

	it('claims no file, nor does a map Layer, because only an annotation Layer owns one', () => {
		expect(parseLayers([foreign]).map(layerFileRef)).toEqual(['']);
		expect(layerFileRef(mapLayer())).toBe('');
		expect(layerFileRef(annotationLayer())).toBe('annotations/l-notes.geojson');
	});
});

describe('writing the layers array', () => {
	it('round-trips both kinds idempotently, so a saved Project stops changing', () => {
		const layers = [
			mapLayer({ opacity: 0.3, visible: false }),
			annotationLayer({ order: 1, unknownFields: { defaultStyle: { fill: '#123456' } } })
		];
		expect(parseLayers(serialiseLayers(layers))).toEqual(layers);
		const once = serialiseLayers(parseLayers(serialiseLayers(layers)));
		expect(serialiseLayers(parseLayers(once))).toEqual(once);
	});

	it('keeps a field a newer build added to a Layer it does know', () => {
		const raw = { ...mapLayer(), blendMode: 'multiply' };
		expect(serialiseLayers(parseLayers([raw]))[0]).toEqual(raw);
	});

	it('never carries a field it writes itself, so unknownFields cannot shadow one', () => {
		const written = serialiseLayers([
			mapLayer(),
			annotationLayer({ order: 1 }),
			...parseLayers([{ id: 'l-cartouche', kind: 'image-annotation', order: 2 }])
		]);

		for (const record of written) {
			expect(parseLayers([record])[0]?.unknownFields ?? {}).toEqual({});
		}
	});
});

describe('the Layer stack inside project.json', () => {
	it('round-trips through the document, byte-identically once unchanged', () => {
		const file = {
			...newProjectFile('Amsterdam 1625', new Date(0)),
			layers: [annotationLayer(), mapLayer({ opacity: 0.5, order: 1 })]
		};
		const bytes = serialiseProjectFile(file);
		expect(parseProjectFile(bytes)).toEqual(file);
		expect(serialiseProjectFile(parseProjectFile(bytes))).toEqual(bytes);
	});

	it('does not read the Layer stack of a Project from the future', () => {
		const bytes = encode(JSON.stringify({ formatVersion: 2, layers: [{ id: 'x', kind: 'map' }] }));
		expect(() => parseProjectFile(bytes)).toThrow(/newer version/);
	});

	it('keeps the document’s own unknown fields when the stack changes', () => {
		const original = encode(
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
