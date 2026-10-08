import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { parseAlignment } from '../alignment/georeference-annotation.js';
import { PROJECT_FILE_NAME, parseProjectFile } from '../project/project-file.js';
import { parseReferencedImage } from '../remote-iiif/referenced-image.js';
import { decode, encode, imageService3 } from '../test-support.js';
import type { ClosurePath } from './project-import-source.js';
import { remapProjectImport } from './project-import-remapping.js';
import { closureSource, delivered, georeferenceDocument, json } from './test-fixtures.js';

const LOCAL = 'amsterdam-1625';
const LIBRARY = 'leiden-plan';
const LIBRARY_SERVICE = 'https://iiif.leidenuniv.nl/iiif/3/item%3A1234567';

const PROJECT = {
	formatVersion: 1,
	name: 'Amsterdam 1625',
	updatedAt: '2025-03-04T11:22:33.000Z',
	layers: [
		{
			kind: 'map',
			id: 'l1',
			name: 'The 1625 plan',
			visible: true,
			order: 0,
			opacity: 0.8,
			imageId: LOCAL
		},
		{
			kind: 'annotation',
			id: 'l2',
			name: 'Warehouses',
			visible: true,
			order: 1,
			geojsonRef: 'annotations/l2.geojson',
			marginNote: 'a field a later build added to a Layer'
		},
		{
			kind: 'map',
			id: 'l3',
			name: 'The same plan, faded',
			visible: false,
			order: 2,
			opacity: 0.25,
			imageId: LOCAL
		},
		{ kind: 'map', id: 'l4', name: 'Leiden', visible: true, order: 3, opacity: 1, imageId: LIBRARY }
	],
	baseMap: 'protomaps-light',
	canonicalUrl: 'https://ada.github.io/atlas',
	onFrontPage: false,
	provenanceOfSomeLaterBuild: { kept: true }
};

const ANNOTATION = '{"type":"FeatureCollection","features":[{"note":"the author\'s own words"}]}';

const alignmentDocument = (service: string) => ({
	...georeferenceDocument(service, 1200, 851, 2),
	_allmaps: { note: 'something only the tool that wrote this understands' }
});

const CONTROL_POINTS = [
	[263, 200, 4.88969, 52.37403],
	[612, 168, 4.9, 52.38],
	[700, 545, 4.91, 52.36]
].map(([x, y, lng, lat]) => ({ resource: { x, y }, geo: { lng, lat } }));

const RESOURCE_MASK = [10, 20, 1190, 20, 1190, 830, 10, 830].flatMap((x, index, all) =>
	index % 2 ? [] : [{ x, y: all[index + 1] }]
);

const REMOTE_JSON = {
	service: LIBRARY_SERVICE,
	label: 'Kaart van Amsterdam, 1625',
	partOf: 'https://iiif.leidenuniv.nl/iiif/3/manifest/1234567',
	canvas: 'https://iiif.leidenuniv.nl/iiif/3/manifest/1234567/canvas/1',
	rights: 'http://rightsstatements.org/vocab/InC/1.0/',
	attribution: 'Leiden University Libraries',
	width: 1200,
	height: 851,
	tileSize: 512
};

const PYRAMID = imageService3({
	width: 1200,
	height: 851,
	tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }],
	somethingLaterBuildsWrote: 'kept'
});

const CLOSURE: Record<ClosurePath, string> = {
	[PROJECT_FILE_NAME]: json(PROJECT),
	'annotations/l2.geojson': ANNOTATION,
	[`images/${LOCAL}/info.json`]: json({
		...PYRAMID,
		id: `https://ada.github.io/atlas/images/${LOCAL}`
	}),
	[`images/${LOCAL}/0/0/0.jpg`]: 'not really a jpeg, but bytes',
	[`images/${LOCAL}/manifest.json`]: json({ id: 'https://unset.invalid/x/manifest.json' }),
	[`alignments/${LOCAL}.json`]: json(
		alignmentDocument(`https://ada.github.io/atlas/images/${LOCAL}`)
	),
	[`images/${LIBRARY}/remote.json`]: json(REMOTE_JSON),
	[`alignments/${LIBRARY}.json`]: json(alignmentDocument(LIBRARY_SERVICE))
};

function identities(): () => string {
	let next = 0;
	return () => `fresh-${(next += 1)}`;
}

const remapped = async (overrides: Record<ClosurePath, string> = {}) => {
	const { closure, images } = await remapProjectImport(
		closureSource({ ...CLOSURE, ...overrides }),
		{
			imageId: identities()
		}
	);
	const files = await delivered(closure);
	const read = (path: string) => files[path] ?? '';
	return { closure, images, files, read, parsed: (path: string) => JSON.parse(read(path)) };
};

describe('remapProjectImport', () => {
	it('gives each distinct Map Image one fresh identity, and every path and Layer follows it', async () => {
		const { closure, images, files } = await remapped();
		expect([...images]).toEqual([
			[LOCAL, 'fresh-1'],
			[LIBRARY, 'fresh-2']
		]);
		expect([...closure.paths].sort()).toEqual(
			[
				PROJECT_FILE_NAME,
				'annotations/l2.geojson',
				'images/fresh-1/info.json',
				'images/fresh-1/0/0/0.jpg',
				'images/fresh-1/manifest.json',
				alignmentPath('fresh-1'),
				'images/fresh-2/remote.json',
				alignmentPath('fresh-2')
			].sort()
		);
		expect(Object.keys(files).sort()).toEqual([...closure.paths].sort());
		const project = parseProjectFile(closure.projectFileBytes);
		expect(
			project.layers.map((layer) => [layer.id, layer.kind === 'map' ? layer.imageId : layer.kind])
		).toEqual([
			['l1', 'fresh-1'],
			['l2', 'annotation'],
			['l3', 'fresh-1'],
			['l4', 'fresh-2']
		]);
		expect(decode(closure.projectFileBytes)).not.toContain(LOCAL);
		expect(decode(closure.projectFileBytes)).not.toContain(LIBRARY);
	});

	it('resets the pyramid’s identifier, and carries every other byte and field over untouched', async () => {
		const { closure, read, parsed } = await remapped();
		expect(parsed('images/fresh-1/info.json')).toEqual({
			...PYRAMID,
			id: 'https://unset.invalid/fresh-1'
		});
		expect(read('annotations/l2.geojson')).toBe(ANNOTATION);
		expect(read('images/fresh-1/0/0/0.jpg')).toBe('not really a jpeg, but bytes');
		expect(read('images/fresh-1/manifest.json')).toBe(CLOSURE[`images/${LOCAL}/manifest.json`]);

		const project = parseProjectFile(closure.projectFileBytes);
		expect(project).toMatchObject({
			name: 'Amsterdam 1625',
			updatedAt: '2025-03-04T11:22:33.000Z',
			baseMap: 'protomaps-light',
			unknownFields: { provenanceOfSomeLaterBuild: { kept: true } },
			canonicalUrl: 'https://ada.github.io/atlas',
			onFrontPage: false
		});
		const [first, annotation, faded] = project.layers;
		expect(first).toMatchObject({
			kind: 'map',
			name: 'The 1625 plan',
			visible: true,
			opacity: 0.8
		});
		expect(faded).toMatchObject({ kind: 'map', visible: false, opacity: 0.25 });
		expect(annotation).toMatchObject({
			kind: 'annotation',
			geojsonRef: 'annotations/l2.geojson',
			unknownFields: { marginNote: 'a field a later build added to a Layer' }
		});
	});

	it('rewrites a local Alignment through the model, and addresses a referenced one at its Library', async () => {
		const { read, parsed } = await remapped();
		const local = read(alignmentPath('fresh-1'));
		const alignment = parseAlignment(encode(local), { imageId: 'fresh-1' });
		expect(alignment.controlPoints.map(({ resource, geo }) => ({ resource, geo }))).toEqual(
			CONTROL_POINTS
		);
		expect(alignment.resourceMask).toEqual(RESOURCE_MASK);
		expect(alignment.transformationType).toBe('polynomial2');
		expect(alignment.image).toEqual({ width: 1200, height: 851 });
		expect(alignment.unmodelled).toEqual({
			_allmaps: { note: 'something only the tool that wrote this understands' }
		});
		expect(JSON.parse(local).target.source.id).toBe('https://unset.invalid/fresh-1');
		expect(local).not.toContain(LOCAL);
		expect(local).not.toContain('ada.github.io');

		const record = parseReferencedImage(encode(read('images/fresh-2/remote.json')), {
			imageId: 'fresh-2'
		});
		expect(record).toEqual({ ...REMOTE_JSON, imageId: 'fresh-2', source: REMOTE_JSON.partOf });
		const referenced = read(alignmentPath('fresh-2'));
		expect(parsed(alignmentPath('fresh-2')).target.source.id).toBe(LIBRARY_SERVICE);
		expect(parseAlignment(encode(referenced), { imageId: 'fresh-2' }).controlPoints).toHaveLength(
			3
		);
		expect(referenced).not.toContain(LIBRARY);
	});

	it('gives an Offline Copy the local placeholder in both its pyramid and its Alignment, and keeps its record', async () => {
		const { parsed } = await remapped({
			[`images/${LIBRARY}/info.json`]: json({
				id: `https://ada.github.io/atlas/images/${LIBRARY}`
			}),
			[`images/${LIBRARY}/0/0/0.jpg`]: 'a copied tile'
		});
		expect(parsed('images/fresh-2/info.json').id).toBe('https://unset.invalid/fresh-2');
		expect(parsed('images/fresh-2/remote.json').service).toBe(LIBRARY_SERVICE);
		expect(parsed(alignmentPath('fresh-2')).target.source.id).toBe('https://unset.invalid/fresh-2');
	});

	it('canonicalises a referenced Map Image’s service, so its record and its Alignment agree', async () => {
		const { parsed } = await remapped({
			[`images/${LIBRARY}/remote.json`]: json({ ...REMOTE_JSON, service: `${LIBRARY_SERVICE}/` })
		});
		expect(parsed('images/fresh-2/remote.json').service).toBe(LIBRARY_SERVICE);
		expect(parsed(alignmentPath('fresh-2')).target.source.id).toBe(LIBRARY_SERVICE);
	});

	it.each([
		[
			'one destination identity to two incoming Map Images',
			() => 'the-same-one',
			/would merge them/
		],
		['an identity a Workspace could not hold', () => '', /not usable as a Map Image identity/]
	])('refuses to allocate %s', async (_what, imageId, message) => {
		await expect(remapProjectImport(closureSource(CLOSURE), { imageId })).rejects.toThrow(message);
	});

	it('allocates an identity per distinct Map Image by default, without consulting the image', async () => {
		const first = await remapProjectImport(closureSource(CLOSURE));
		const second = await remapProjectImport(closureSource(CLOSURE));
		const allocated = [...first.images.values(), ...second.images.values()];
		expect(new Set(allocated).size).toBe(4);
		for (const fresh of allocated) expect(fresh).toMatch(/^[0-9a-f]{16}$/);
	});
});
