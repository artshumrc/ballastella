import {
	DEFAULT_ANNOTATION_COLOR,
	annotationPath,
	circleGeometry,
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
import { MemoryProjectStore } from '@ballastella/core/testing';
import { describe, expect, it } from 'vitest';

import { EditorSession } from '../editor-session.svelte.js';

import { AnnotationEditing, type AnnotationWriter } from './annotation-editing.svelte.js';

interface Write {
	layerId: string;
	collection: AnnotationCollection;
	debounce: boolean;
	label: string | undefined;
	drag?: { key: string; label: string };
}

class FakeWriter implements AnnotationWriter {
	readonly writes: Write[] = [];
	readonly onDisk = new Map<string, AnnotationCollection>();
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

	async dragAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		drag: { key: string; label: string }
	): Promise<void> {
		this.writes.push({ layerId: layer.id, collection, debounce: true, label: undefined, drag });
	}

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

type Screen = ReturnType<typeof screen>;

const layerNamed = (id: string, name = id): AnnotationLayer =>
	newAnnotationLayer({ id, name }) as AnnotationLayer;

const pin = (id: string, lng = 0, lat = 0): Annotation =>
	newAnnotation({ id, geometry: { type: 'Point', coordinates: [lng, lat] } });

const titled = (id: string, title: string): Annotation =>
	newAnnotation({ id, geometry: { type: 'Point', coordinates: [0, 0] }, title });

function opened(annotations?: Annotation[], ...others: AnnotationLayer[]): Screen {
	const layer = layerNamed('one');
	const it_ = screen([layer, ...others]);
	if (annotations) it_.put(layer, { annotations });
	it_.annotations.openLayer('one');
	return it_;
}

const written = (it_: Screen): AnnotationCollection => {
	const last = it_.session.writes.at(-1);
	if (last === undefined) throw new Error('nothing was written');
	return last.collection;
};

const ids = (collection: AnnotationCollection | undefined) =>
	collection?.annotations.map((one) => one.id);

const labels = (it_: Screen) => it_.session.writes.map((write) => write.label);

const propertiesOf = (it_: Screen, index = 0): Record<string, unknown> =>
	written(it_).annotations[index]!.properties as Record<string, unknown>;

const SIMPLESTYLE_NAMES = (
	'title description marker-size marker-symbol marker-color stroke stroke-opacity stroke-width ' +
	'fill fill-opacity stroke-dasharray'
).split(' ');

const expectSimplestyleNames = (properties: Record<string, unknown>) => {
	for (const name of Object.keys(properties)) expect(SIMPLESTYLE_NAMES).toContain(name);
};

const utf8 = (encoded: Uint8Array): string => new TextDecoder().decode(encoded);

const LINE: [number, number][] = [
	[4.8, 52.3],
	[5, 52.3]
];
const TRIANGLE: [number, number][] = [...LINE, [4.9, 52.4]];
const RING: [number, number][] = [
	[0, 0],
	[2, 0],
	[2, 2],
	[0, 0]
];

function drawing(tool: 'point' | 'line' | 'polygon' | 'circle' | 'text') {
	const it_ = opened();
	it_.annotations.drawing.choose(tool);
	return it_;
}

async function draw(it_: Screen, points: [number, number][]): Promise<void> {
	for (const [lng, lat] of points) await it_.annotations.placePoint({ lng, lat });
	if (points.length > 1) await it_.annotations.finishShape();
	it_.annotations.selectAnnotation(written(it_).annotations.at(-1)!.id);
}

describe('which Layer is drawn into', () => {
	it('draws into nothing at all when no Layer is open', async () => {
		const it_ = screen([layerNamed('one'), layerNamed('two')]);
		it_.annotations.drawing.choose('point');

		await it_.annotations.placePoint({ lng: 4, lat: 52 });

		expect(it_.annotations.activeLayer).toBeNull();
		expect(it_.session.writes).toEqual([]);
	});

	it('abandons a part-drawn shape and the selection when another Layer is opened', () => {
		const it_ = opened(undefined, layerNamed('two'));
		it_.annotations.drawing.choose('polygon');
		it_.annotations.drawing.place({ lng: 0, lat: 0 });
		it_.annotations.selectedAnnotationId = 'kept';

		it_.annotations.openLayer('two');

		expect(it_.annotations.drawing.drawing).toBe(false);
		expect(it_.annotations.selectedAnnotationId).toBeNull();
	});

	it.each([
		['another Layer is opened with nothing drawn yet', 'two'],
		['the open Layer is closed', null]
	])('puts the shapes away when %s', (_when, next) => {
		const it_ = opened(undefined, layerNamed('two'));
		it_.annotations.drawing.offerShapes();

		it_.annotations.openLayer(next);

		expect(it_.annotations.drawing.picking).toBe(false);
		expect(it_.annotations.drawing.tool).toBe('select');
	});

	it('keeps the selection when an Annotation is opened from the map', () => {
		const it_ = screen([layerNamed('one'), layerNamed('two')]);

		it_.annotations.openFromMap('two', 'a1');

		expect(it_.annotations.openLayerId).toBe('two');
		expect(it_.annotations.selectedAnnotationId).toBe('a1');
	});

	it('follows the open Layer being deleted rather than pointing at a Layer that is gone', () => {
		const it_ = screen([layerNamed('one'), layerNamed('two')]);
		it_.annotations.openLayer('two');
		expect(it_.annotations.activeLayer?.id).toBe('two');

		it_.layers.splice(1, 1);

		expect(it_.annotations.activeLayer).toBeNull();
	});
});

describe('a drawn Annotation arrives selected and ready to be titled', () => {
	it('selects the shape just drawn and names it to type into, until anything else is selected', async () => {
		const it_ = drawing('point');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		const drawn = written(it_).annotations[0]!.id;
		expect(it_.annotations.selectedAnnotationId).toBe(drawn);
		expect(it_.annotations.titlingId).toBe(drawn);

		it_.annotations.selectAnnotation(null);
		it_.annotations.selectAnnotation(drawn);

		expect(it_.annotations.titlingId).toBeNull();
	});

	it('leaves a Pin dropped on a Place alone, because it arrived with its title', async () => {
		const it_ = opened();

		await it_.annotations.placePin({ lng: 4.9, lat: 52.37 }, 'Hampden');

		expect(it_.annotations.selectedAnnotationId).toBe(written(it_).annotations[0]!.id);
		expect(it_.annotations.titlingId).toBeNull();
	});
});

describe('the “shape added” announcement is withdrawn when it stops being true', () => {
	it.each<[string, (it_: Screen) => unknown]>([
		['the selection moves off the shape it names', (it_) => it_.annotations.selectAnnotation(null)],
		[
			'the Annotation it announces is deleted',
			async (it_) => {
				await it_.annotations.deleteSelected();
				expect(written(it_).annotations).toHaveLength(0);
			}
		],
		['another Layer is opened', (it_) => it_.annotations.openLayer('two')],
		[
			'a Pin is dropped on a Place, which came from no gesture',
			(it_) => it_.annotations.placePin({ lng: 5, lat: 52 }, 'Hampden')
		]
	])('survives the drawn shape’s own selection, and goes when %s', async (_when, then) => {
		const it_ = opened(undefined, layerNamed('two'));
		it_.annotations.drawing.offerShapes();
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });
		expect(it_.annotations.drawing.status).toContain('Pin added');

		await then(it_);

		expect(it_.annotations.drawing.status).toBe('');
	});
});

describe('whether the selected Annotation’s shape can be drawn', () => {
	const selecting = (geometry: AnnotationGeometry) => {
		const it_ = opened([newAnnotation({ id: 'a-1', geometry })]);
		it_.annotations.selectAnnotation('a-1');
		return it_;
	};

	it.each<[string, AnnotationGeometry, boolean]>([
		['a Point', { type: 'Point', coordinates: [4.9, 52.37] }, true],
		['a LineString', { type: 'LineString', coordinates: [[4.9, 52.37]] }, true],
		['a Polygon', { type: 'Polygon', coordinates: [[[4.9, 52.37]]] }, true],
		[
			'a geometry from a foreign document',
			{
				type: 'foreign',
				declaredType: 'GeometryCollection',
				raw: { type: 'GeometryCollection', geometries: [] }
			},
			false
		],
		['no geometry at all, which RFC 7946 permits', null, false]
	])('answers for %s', (_shape, geometry, drawable) => {
		expect(selecting(geometry).annotations.selectedIsDrawable).toBe(drawable);
	});

	it('says no when nothing is selected, so no Style face is offered to nobody', () => {
		const it_ = selecting({ type: 'Point', coordinates: [4.9, 52.37] });

		it_.annotations.selectAnnotation(null);

		expect(it_.annotations.selectedIsDrawable).toBe(false);
	});
});

describe('editing a shape', () => {
	it('offers only center and radius handles for a Circle and preserves the circle while resizing', async () => {
		const it_ = opened([
			{
				id: 'a1',
				geometry: circleGeometry([4.9, 52.37], 1_000),
				properties: { title: 'Market district' }
			}
		]);
		it_.annotations.selectAnnotation('a1');

		expect(it_.annotations.annotationPoints.map((point) => point.label)).toEqual([
			'Center of Market district. Arrow keys move it.',
			'Radius of Market district. Arrow keys move it.'
		]);

		await it_.annotations.reshape(1, { lng: 4.93, lat: 52.37 });

		expect(it_.session.writes).toHaveLength(1);
		const geometry = it_.session.writes[0]!.collection.annotations[0]!.geometry;
		if (geometry?.type !== 'Circle') throw new Error('expected a circle');
		expect(geometry.center).toEqual([4.9, 52.37]);
		expect(geometry.radiusMeters).toBeGreaterThan(1_000);
		expect(geometry.coordinates[0]).toHaveLength(65);
	});

	it('offers one handle per position of the ring and writes a moved vertex with the ring closed, once', async () => {
		const it_ = opened([
			{
				id: 'a1',
				geometry: { type: 'Polygon', coordinates: [RING] },
				properties: { title: 'The old quay' }
			}
		]);
		it_.annotations.selectAnnotation('a1');

		const points = it_.annotations.annotationPoints;
		expect(points).toHaveLength(3);
		expect(points[0]!.label).toBe('Point 1 of 3 of The old quay. Arrow keys move it.');

		await it_.annotations.reshape(1, { lng: 9, lat: 9 });

		expect(it_.session.writes).toHaveLength(1);
		expect(it_.session.writes[0]!.collection.annotations[0]!.geometry).toEqual({
			type: 'Polygon',
			coordinates: [RING.map((position, index) => (index === 1 ? [9, 9] : position))]
		});
	});
});

describe('the gestures that become Steps, and the ones that do not', () => {
	it('names the shape just drawn, by the title it arrived with', async () => {
		const it_ = opened([]);

		await it_.annotations.placePin({ lng: 4.9, lat: 52.4 }, 'Fort Amsterdam');

		expect(labels(it_)).toEqual(['Undo drawing “Fort Amsterdam”']);
	});

	it('names an untitled shape the way the undo control has always named one', async () => {
		const it_ = drawing('point');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.4 });

		expect(labels(it_)).toEqual(['Undo drawing this Annotation']);
	});

	it('names the deletion of the Annotation that was selected', async () => {
		const it_ = opened([pin('a1'), titled('a2', 'The old quay')]);
		it_.annotations.selectAnnotation('a2');

		await it_.annotations.deleteSelected();

		expect(it_.session.writes).toHaveLength(1);
		expect(ids(it_.session.writes[0]!.collection)).toEqual(['a1']);
		expect(it_.session.writes[0]!.label).toBe('Undo delete of “The old quay”');
	});

	it.each<[string, (it_: Screen) => Promise<void>, (string | undefined)[]]>([
		[
			'names a vertex being moved as moving the Annotation it belongs to',
			(it_) => it_.annotations.reshape(0, { lng: 9, lat: 9 }),
			['Undo moving “Trade route”']
		],
		[
			'names a colour and a line style as restyling, one Step each',
			async (it_) => {
				await it_.annotations.styleSelected({ 'marker-color': '#d32f2f' });
				await it_.annotations.lineStyleSelected('dotted');
			},
			['Undo restyling “Trade route”', 'Undo restyling “Trade route”']
		],
		[
			'opens no Step for a style still inside its debounce window',
			(it_) => it_.annotations.styleSelected({ 'stroke-width': 4 }, { debounce: true }),
			[undefined]
		],
		[
			'opens no Step for a title or a description being typed',
			(it_) => it_.annotations.typeText({ title: 'Fort Amsterdam' }),
			[undefined]
		]
	])('%s', async (_name, gesture, expected) => {
		const it_ = opened([titled('a1', 'Trade route')]);
		it_.annotations.selectAnnotation('a1');

		await gesture(it_);

		expect(labels(it_)).toEqual(expected);
	});

	it('gathers a slider’s positions into one drag, and a second slider into another', async () => {
		const it_ = opened([titled('a1', 'Trade route')]);
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.styleSelected({ 'stroke-width': 4 }, { debounce: true });
		await it_.annotations.styleSelected({ 'stroke-width': 6 }, { debounce: true });
		await it_.annotations.styleSelected({ 'stroke-opacity': 0.4 }, { debounce: true });

		const drags = it_.session.writes.map((write) => write.drag);
		expect(drags.every((drag) => drag?.label === 'Undo restyling “Trade route”')).toBe(true);
		expect(drags[0]!.key).toBe(drags[1]!.key);
		expect(drags[2]!.key).not.toBe(drags[0]!.key);
	});

	it('makes a reorder one Step, and a move between Layers one Step over both documents', async () => {
		const it_ = opened([pin('a1'), pin('a2')], layerNamed('two', 'Trade routes'));

		await it_.annotations.moveAnnotationTo('a1', 1);
		await it_.annotations.moveAnnotationToLayer('a2', 'two');

		expect(labels(it_)).toEqual([
			'Undo reordering this Annotation',
			'Undo moving this Annotation to “Trade routes”',
			'Undo moving this Annotation to “Trade routes”'
		]);
	});
});

describe('letting go of a selection an Edit History wrote away', () => {
	it.each([
		['clears the selection when the collection just read no longer holds it', ['a1'], null],
		[
			'keeps a selection the collection still holds, so an unrelated undo closes nothing',
			['a2'],
			'a2'
		]
	])('%s', (_name, remaining, selected) => {
		const it_ = opened([pin('a1'), pin('a2')]);
		it_.annotations.selectAnnotation('a2');

		it_.put(layerNamed('one'), { annotations: remaining.map((id) => pin(id)) });
		it_.annotations.releaseMissingSelection();

		expect(it_.annotations.selectedAnnotationId).toBe(selected);
		if (selected === null) expect(it_.annotations.selectedAnnotation).toBeNull();
	});

	it('keeps the selection when the open Layer’s document is not in hand', () => {
		const it_ = opened();
		it_.annotations.selectAnnotation('a2');

		it_.annotations.releaseMissingSelection();

		expect(it_.annotations.selectedAnnotationId).toBe('a2');
	});
});

describe('merely looking at a Project modifies nothing (ADR-0010)', () => {
	it.each([
		['nothing on a commit when no edit is waiting', false, []],
		['once on a commit when an edit is waiting inside its debounce window', true, [false]]
	])('writes %s', async (_name, pending, debounces) => {
		const it_ = opened([pin('a1')]);
		it_.session.pending = pending;

		await it_.annotations.commitAnnotationEdit();

		expect(it_.session.writes.map((write) => write.debounce)).toEqual(debounces);
	});

	it('coalesces typing and writes a discrete style change now (ADR-0017 rules 1 and 2)', async () => {
		const it_ = opened([pin('a1')]);
		it_.annotations.selectAnnotation('a1');

		await it_.annotations.typeText({ title: 'The old quay' });
		await it_.annotations.lineStyleSelected('dotted');

		expect(it_.session.writes.map((write) => write.debounce)).toEqual([true, false]);
	});
});

describe('the style controls write simplestyle names exactly', () => {
	it.each([
		[
			'a colour, a width, and an opacity for a line',
			'line',
			LINE,
			{ stroke: '#d32f2f', 'stroke-width': 4, 'stroke-opacity': 0.5 }
		],
		[
			'a fill colour and opacity for a shape',
			'polygon',
			TRIANGLE,
			{ fill: '#1976d2', 'fill-opacity': 0.25 }
		]
	] as const)('writes %s under the spec’s own names', async (_name, tool, points, style) => {
		const it_ = drawing(tool);
		await draw(it_, [...points]);

		await it_.annotations.styleSelected(style);

		expect(propertiesOf(it_)).toMatchObject(style);
		expectSimplestyleNames(propertiesOf(it_));
	});

	it('applies each effective style property to every compatible geometry in the Layer', async () => {
		const source = {
			id: 'source',
			geometry: { type: 'Polygon', coordinates: [RING] },
			properties: {
				'marker-color': '#d32f2f',
				fill: '#1976d2',
				'fill-opacity': 0.25,
				stroke: '#388e3c',
				'stroke-opacity': 0.5,
				'stroke-width': 4,
				'stroke-dasharray': [8, 4]
			}
		} as unknown as Annotation;
		const label = newAnnotation({
			id: 'label',
			geometry: { type: 'Point', coordinates: [2, 2] },
			style: { 'marker-symbol': 'label' }
		});
		const line = newAnnotation({ id: 'line', geometry: { type: 'LineString', coordinates: LINE } });
		const it_ = opened([source, pin('point'), label, line]);
		it_.annotations.selectAnnotation(source.id);

		await it_.annotations.applySelectedStyleToLayer();

		const [first, point, labelled, lined] = written(it_).annotations.map((one) => one.properties);
		expect(first).toMatchObject(source.properties);
		expect(point).toMatchObject({ 'marker-color': '#d32f2f', 'marker-size': 'medium' });
		expect(point).not.toHaveProperty('fill');
		expect(labelled).toMatchObject({
			'marker-color': '#d32f2f',
			'marker-size': 'medium',
			fill: '#1976d2',
			'fill-opacity': 0.25,
			'marker-symbol': 'label'
		});
		expect(lined).toMatchObject({
			stroke: '#388e3c',
			'stroke-opacity': 0.5,
			'stroke-width': 4,
			'stroke-dasharray': [8, 4]
		});
		expect(lined).not.toHaveProperty('fill');
		expect(it_.session.writes).toHaveLength(1);
	});

	it('gives an Annotation drawn with default styling the palette’s grey and nothing more', async () => {
		const it_ = drawing('point');
		await draw(it_, [[4.9, 52.37]]);
		it_.annotations.drawing.choose('line');
		await draw(it_, LINE);

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
		await draw(it_, LINE);
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
		expect(simpleStyleViolations(properties)).toEqual([]);
	});

	it('stores dash tuples and writes solid as the absence of stroke-dasharray', async () => {
		const it_ = drawing('line');
		await draw(it_, LINE);

		expect(propertiesOf(it_)).not.toHaveProperty('stroke-dasharray');

		await it_.annotations.lineStyleSelected('dashed');
		expect(propertiesOf(it_)['stroke-dasharray']).toEqual([8, 4]);

		await it_.annotations.lineStyleSelected('dotted');
		expect(propertiesOf(it_)['stroke-dasharray']).toEqual([1, 3]);
		const file = utf8(serialiseAnnotations(written(it_)));
		for (const keyword of ['"dashed"', '"dotted"', '"solid"']) expect(file).not.toContain(keyword);

		await it_.annotations.lineStyleSelected('solid');
		expect(propertiesOf(it_)).not.toHaveProperty('stroke-dasharray');
	});
});

describe('placing a Label writes what makes it one', () => {
	it('writes an untitled Point carrying the discriminator, words contrasting their background, for one write', async () => {
		const it_ = drawing('text');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		expect(written(it_).annotations[0]!.geometry).toEqual({
			type: 'Point',
			coordinates: [4.9, 52.37]
		});
		const properties = propertiesOf(it_);
		expect(properties['marker-symbol']).toBe('label');
		expect(properties).not.toHaveProperty('title');
		expect(properties['marker-color']).toBe('#000000');
		expect(properties['fill']).toBe('#ffffff');
		expect(it_.session.writes).toHaveLength(1);
		expect(it_.annotations.titlingId).toBe(written(it_).annotations[0]!.id);
		expectSimplestyleNames(properties);
		expect(simpleStyleViolations(properties)).toEqual([]);
	});

	it.each([
		['a null text colour', { 'marker-color': null, fill: DEFAULT_ANNOTATION_COLOR }],
		['a numeric background', { fill: 4 }],
		['a boolean background', { fill: true }],
		['an array background', { fill: ['#fff'] }],
		['a numeric text colour', { 'marker-color': 5, fill: '#fff' }]
	])('places a Label after an Annotation carrying %s', async (_name, properties) => {
		const it_ = opened([{ id: 'foreign', geometry: null, properties } as unknown as Annotation]);
		it_.annotations.drawing.choose('text');

		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		expect(written(it_).annotations).toHaveLength(2);
		expect(propertiesOf(it_, 1)).toEqual({ ...properties, 'marker-symbol': 'label' });
	});

	it('coalesces the words into one further write, and draws what was typed', async () => {
		const it_ = drawing('text');
		await draw(it_, [[4.9, 52.37]]);

		await it_.annotations.typeText({ title: 'Zuiderzee' });

		expect(propertiesOf(it_)['title']).toBe('Zuiderzee');
		expect(it_.session.writes.map((write) => write.debounce)).toEqual([false, true]);
	});

	it('draws a Pin after a Label, because the discriminator is never inherited', async () => {
		const it_ = drawing('text');
		await it_.annotations.placePoint({ lng: 4.9, lat: 52.37 });

		it_.annotations.drawing.offerShapes();
		it_.annotations.drawing.choose('point');
		await it_.annotations.placePoint({ lng: 5, lat: 52.4 });

		const pinProperties = propertiesOf(it_, 1);
		expect(pinProperties).not.toHaveProperty('marker-symbol');
		expect(pinProperties['marker-color']).toBe(propertiesOf(it_, 0)['marker-color']);
		expect(pinProperties['fill']).toBe(propertiesOf(it_, 0)['fill']);
	});

	it('carries a Label’s size and colours onto the next Label drawn', async () => {
		const it_ = drawing('text');
		await draw(it_, [[4.9, 52.37]]);
		const style = { 'marker-color': '#ffffff', fill: '#1976d2', 'marker-size': 'large' } as const;
		await it_.annotations.styleSelected(style);

		it_.annotations.drawing.offerShapes();
		it_.annotations.drawing.choose('text');
		await it_.annotations.placePoint({ lng: 5, lat: 52.4 });

		expect(propertiesOf(it_, 1)).toMatchObject({ 'marker-symbol': 'label', ...style });
	});
});

describe('display state never reaches the GeoJSON (ADR-0002, ADR-0010)', () => {
	it('writes back byte-identical bytes after a title is typed and cleared', async () => {
		const it_ = drawing('point');
		await draw(it_, [[4.9, 52.37]]);
		it_.annotations.drawing.choose('line');
		await draw(it_, LINE);
		const original = utf8(serialiseAnnotations(written(it_)));

		it_.put(layerNamed('one'), parseAnnotations(serialiseAnnotations(written(it_))));
		it_.annotations.selectAnnotation(written(it_).annotations[0]!.id);
		await it_.annotations.typeText({ title: 'A' });
		await it_.annotations.typeText({ title: '' });

		expect(utf8(serialiseAnnotations(written(it_)))).toBe(original);
	});
});

describe('moving an Annotation', () => {
	it.each([
		[
			'reorders it inside its own Layer in one write',
			['a1', 'a2', 'a3'],
			'a3',
			[['a3', 'a1', 'a2']]
		],
		['writes nothing when the move changes nothing', ['a1', 'a2'], 'a1', []]
	])('%s', (_name, held, moved, writes) => {
		const it_ = opened(held.map((id) => pin(id)));

		void it_.annotations.moveAnnotationTo(moved, 0);

		expect(it_.session.writes.map((write) => ids(write.collection))).toEqual(writes);
	});

	it('writes the target Layer before the one it leaves, then opens the target and selects it there', async () => {
		const to = layerNamed('to', 'The routes');
		const it_ = opened([pin('a1'), pin('a2')], to);
		it_.put(to, { annotations: [pin('b1')] });

		await it_.annotations.moveAnnotationToLayer('a2', 'to');

		expect(it_.session.writes.map((write) => [write.layerId, ids(write.collection)])).toEqual([
			['to', ['b1', 'a2']],
			['one', ['a1']]
		]);
		expect(it_.annotations.openLayerId).toBe('to');
		expect(it_.annotations.selectedAnnotationId).toBe('a2');
		expect(it_.annotations.moveNotice).toContain('The routes');
	});

	it('reads a hidden target Layer rather than assuming it is empty', async () => {
		const it_ = opened([pin('a1')], layerNamed('to'));
		it_.session.onDisk.set('to', { annotations: [pin('b1'), pin('b2')] });

		await it_.annotations.moveAnnotationToLayer('a1', 'to');

		expect(ids(it_.session.writes[0]?.collection)).toEqual(['b1', 'b2', 'a1']);
	});

	it('refuses, and writes nothing at all, when the target Layer cannot be read', async () => {
		const it_ = opened([pin('a1')], layerNamed('to', 'The routes'));
		it_.session.unreadable.add('to');

		await it_.annotations.moveAnnotationToLayer('a1', 'to');

		expect(it_.session.writes).toEqual([]);
		expect(it_.annotations.moveRefusal).toContain('The routes');
		expect(it_.annotations.openLayerId).toBe('one');
	});

	it('offers every Annotation Layer but the one on screen as somewhere to move to', () => {
		const it_ = screen([layerNamed('one'), layerNamed('two'), layerNamed('three')]);
		it_.annotations.openLayer('two');

		expect(it_.annotations.moveTargets.map((target) => target.id)).toEqual(['one', 'three']);
	});
});

const DIRECTORY = 'amsterdam-1625';

async function realSession(): Promise<{
	store: MemoryProjectStore;
	session: EditorSession;
	annotations: AnnotationEditing;
	layer: AnnotationLayer;
	path: StorePath;
	bytes(): Promise<Bytes>;
	settle(): Promise<void>;
	drawPoint(lng: number, lat: number): Promise<string>;
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
	const settle = async () => {
		await session.flush();
		documents = { ...documents, [layer.id]: await session.readAnnotations(layer) };
	};
	return {
		store,
		session,
		annotations,
		layer,
		path,
		bytes: () => store.read(path),
		settle,
		drawPoint: async (lng, lat) => {
			annotations.drawing.choose('point');
			await annotations.placePoint({ lng, lat });
			await settle();
			return annotations.selectedAnnotationId as string;
		}
	};
}

type RealSession = Awaited<ReturnType<typeof realSession>>;

async function drawn(): Promise<RealSession> {
	const it_ = await realSession();
	await it_.drawPoint(4.78, 52.4);
	return it_;
}

const readBack = async (it_: RealSession) =>
	parseAnnotations(await it_.bytes(), { path: 'annotations' }).annotations;

describe('an Annotation gesture undone and redone against the store', () => {
	it.each<[string, (it_: RealSession) => Promise<unknown>]>([
		['drawing', (it_) => it_.drawPoint(4.9, 52.4)],
		['deleting', (it_) => it_.annotations.deleteSelected()],
		['moving a vertex', (it_) => it_.annotations.reshape(0, { lng: 5.1, lat: 52.1 })],
		['restyling', (it_) => it_.annotations.styleSelected({ 'marker-color': '#d32f2f' })]
	])(
		'puts the file back byte-identically after %s, and forward again on redo',
		async (_what, gesture) => {
			const it_ = await drawn();

			const before = await it_.bytes();
			await gesture(it_);
			await it_.settle();
			const after = await it_.bytes();
			expect(after).not.toEqual(before);
			const history = it_.session.historyFor(DIRECTORY);
			expect(await history.undo()).toBe(true);
			await it_.settle();
			expect(await it_.bytes()).toEqual(before);
			expect(await history.redo()).toBe(true);
			await it_.settle();
			expect(await it_.bytes()).toEqual(after);
		}
	);

	it('carries a description typed after a Step across the undo of that Step', async () => {
		const it_ = await realSession();
		const kept = await it_.drawPoint(4.78, 52.4);
		await it_.drawPoint(5.02, 52.34);

		it_.annotations.selectAnnotation(kept);
		await it_.annotations.typeText({ description: 'Attested in the 1625 toll register.' });
		await it_.annotations.commitAnnotationEdit();
		await it_.settle();

		expect(await it_.session.historyFor(DIRECTORY).undo()).toBe(true);
		await it_.settle();

		const back = await readBack(it_);
		expect(back).toHaveLength(1);
		expect(back[0]!.properties.description).toBe('Attested in the 1625 toll register.');
	});

	it('takes an Annotation’s typed words with it when its creation is undone', async () => {
		const it_ = await realSession();
		const empty = await it_.bytes();

		await it_.drawPoint(4.9, 52.4);
		await it_.annotations.typeText({
			title: 'Fort Amsterdam',
			description: 'The fort at the mouth of the river.'
		});
		await it_.annotations.commitAnnotationEdit();
		await it_.settle();
		expect(await it_.bytes()).not.toEqual(empty);
		expect(await it_.session.historyFor(DIRECTORY).undo()).toBe(true);
		await it_.settle();

		expect(await it_.bytes()).toEqual(empty);
	});
});

describe('one style drag is one Step', () => {
	const dragTo = async (
		it_: RealSession,
		property: keyof AnnotationProperties & string,
		values: number[]
	): Promise<void> => {
		for (const value of values) {
			await it_.annotations.styleSelected({ [property]: value }, { debounce: true });
		}
	};

	it.each<[keyof AnnotationProperties & string, number[]]>([
		['fill-opacity', [0.8, 0.5, 0.25]],
		['stroke-width', [3, 5, 8]],
		['stroke-opacity', [0.9, 0.6, 0.35]]
	])(
		'undoes a %s drag to the value it began at, and redoes to the released one',
		async (property, values) => {
			const it_ = await drawn();
			const before = await it_.bytes();

			await dragTo(it_, property, values);
			await it_.annotations.commitAnnotationEdit();
			await it_.settle();
			const after = await it_.bytes();
			expect(after).not.toEqual(before);
			expect((await readBack(it_))[0]!.properties[property]).toBe(values.at(-1));

			const history = it_.session.historyFor(DIRECTORY);
			expect(await history.undo()).toBe(true);
			await it_.settle();
			expect(await it_.bytes()).toEqual(before);
			expect(history.undoable?.label).toBe('Undo drawing this Annotation');

			expect(await history.redo()).toBe(true);
			await it_.settle();
			expect(await it_.bytes()).toEqual(after);
		}
	);

	it('keeps a drag out of the undo of the Step before it', async () => {
		const it_ = await realSession();
		const kept = await it_.drawPoint(4.78, 52.4);
		await it_.drawPoint(5.02, 52.34);

		await it_.annotations.deleteSelected();
		await it_.settle();

		it_.annotations.selectAnnotation(kept);
		await dragTo(it_, 'stroke-width', [3, 5, 8]);
		await it_.annotations.commitAnnotationEdit();
		await it_.settle();

		const history = it_.session.historyFor(DIRECTORY);
		expect(await history.undo()).toBe(true);
		await it_.settle();
		const reverted = await readBack(it_);
		expect(reverted.map((one) => one.id)).toEqual([kept]);
		expect(reverted[0]!.properties['stroke-width']).toBeUndefined();
		expect(await history.redo()).toBe(true);
		await it_.settle();
		const back = await readBack(it_);
		expect(back.map((one) => one.id)).toEqual([kept]);
		expect(back[0]!.properties['stroke-width']).toBe(8);
	});

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
		const [half] = await readBack(it_);
		expect(half!.properties['stroke-width']).toBe(6);
		expect(half!.properties['stroke-opacity']).toBeUndefined();
		expect(await history.undo()).toBe(true);
		await it_.settle();
		expect(await it_.bytes()).toEqual(before);
	});

	it('writes nothing when a slider is released without having moved', async () => {
		const it_ = await drawn();
		const before = await it_.bytes();

		await it_.annotations.commitAnnotationEdit();
		await it_.settle();

		expect(await it_.bytes()).toEqual(before);
		expect(it_.session.historyFor(DIRECTORY).undoable?.label).toBe('Undo drawing this Annotation');
	});
});
