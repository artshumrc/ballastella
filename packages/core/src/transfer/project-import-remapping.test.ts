// The planning half of Project Import: one incoming closure remapped onto identities the destination
// Workspace has never used (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE FIXTURE IS A WORKSPACE AND THE ASSERTIONS ARE PARSED MODELS
//
// The claim under test is that the remapped closure is *detached*: nothing in it names a Map Image
// identity the source used, and nothing of the author's scholarship is different. Both halves have to
// be asserted against the closure's own documents rather than against the planner's return value, so
// every case here reads the remapped bytes back through the domain parser that owns them —
// `parseProjectFile`, `parseAlignment`, `parseReferencedImage` — and compares against literals the
// fixture states independently.
//
// The fixture is a `MemoryProjectStore` holding the Project-relative closure, offered exactly as
// `review-workspace-source.ts` offers a Review Workspace's: `project.json` and `annotations/…` for the
// Project's own files, `images/<id>/…` and `alignments/<id>.json` for the shared material (ADR-0023).
// A source built any other way would be one whose paths this suite had chosen, and the path shape is
// half of what the remap has to get right.

import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { parseAlignment } from '../alignment/georeference-annotation.js';
import { PROJECT_FILE_NAME, parseProjectFile } from '../project/project-file.js';
import { parseReferencedImage } from '../remote-iiif/referenced-image.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import {
	createProjectImportSource,
	type ClosureFile,
	type ClosurePath,
	type ProjectImportSource
} from './project-import-source.js';
import { remapProjectImport } from './project-import-remapping.js';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const json = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`;

/** The Map Image whose pyramid the source Workspace holds. */
const LOCAL = 'amsterdam-1625';
/** The Map Image the source Workspace only references, on a Library's server. */
const LIBRARY = 'leiden-plan';
const LIBRARY_SERVICE = 'https://iiif.leidenuniv.nl/iiif/3/item%3A1234567';

/**
 * The Project as its own `project.json` spells it, with the two things a remap has to reconcile: one
 * Map Image drawn by **two** Layers, and a field this build has never heard of on the Project and on
 * a Layer.
 */
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

/** A Georeference Annotation as a colleague's build wrote it, `service` naming where its image is. */
const alignmentDocument = (service: string, width: number, height: number): unknown => ({
	type: 'Annotation',
	'@context': [
		'http://iiif.io/api/extension/georef/1/context.json',
		'http://iiif.io/api/presentation/3/context.json'
	],
	motivation: 'georeferencing',
	target: {
		type: 'SpecificResource',
		source: { id: service, type: 'ImageService3', width, height },
		selector: {
			type: 'SvgSelector',
			value: `<svg width="${width}" height="${height}"><polygon points="10,20 1190,20 1190,830 10,830" /></svg>`
		}
	},
	body: {
		type: 'FeatureCollection',
		transformation: { type: 'polynomial', options: { order: 2 } },
		features: [
			{
				type: 'Feature',
				properties: { resourceCoords: [263, 200] },
				geometry: { type: 'Point', coordinates: [4.88969, 52.37403] }
			},
			{
				type: 'Feature',
				properties: { resourceCoords: [612, 168] },
				geometry: { type: 'Point', coordinates: [4.9, 52.38] }
			},
			{
				type: 'Feature',
				properties: { resourceCoords: [700, 545] },
				geometry: { type: 'Point', coordinates: [4.91, 52.36] }
			}
		]
	},
	_allmaps: { note: 'something only the tool that wrote this understands' }
});

/** The Control Points the fixture states, in the shape the model holds them. */
const CONTROL_POINTS = [
	{ resource: { x: 263, y: 200 }, geo: { lng: 4.88969, lat: 52.37403 } },
	{ resource: { x: 612, y: 168 }, geo: { lng: 4.9, lat: 52.38 } },
	{ resource: { x: 700, y: 545 }, geo: { lng: 4.91, lat: 52.36 } }
];

const RESOURCE_MASK = [
	{ x: 10, y: 20 },
	{ x: 1190, y: 20 },
	{ x: 1190, y: 830 },
	{ x: 10, y: 830 }
];

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

/**
 * The closure the source offers, Project-relative.
 *
 * `images/<LOCAL>/info.json` carries the **source Workspace's stamped address** rather than the
 * ADR-0004 placeholder, because that is the stamp the remap has to reset: a Project imported from
 * somebody's Published Site arrives claiming their IIIF endpoint.
 */
const CLOSURE: Record<ClosurePath, string> = {
	[PROJECT_FILE_NAME]: json(PROJECT),
	'annotations/l2.geojson': ANNOTATION,
	[`images/${LOCAL}/info.json`]: json({
		'@context': 'http://iiif.io/api/image/3/context.json',
		id: `https://ada.github.io/atlas/images/${LOCAL}`,
		type: 'ImageService3',
		protocol: 'http://iiif.io/api/image',
		profile: 'level0',
		width: 1200,
		height: 851,
		tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }],
		somethingLaterBuildsWrote: 'kept'
	}),
	[`images/${LOCAL}/0/0/0.jpg`]: 'not really a jpeg, but bytes',
	[`images/${LOCAL}/manifest.json`]: json({ id: 'https://unset.invalid/x/manifest.json' }),
	// alignment-write-is-the-fixture: the Alignment as the source Workspace already holds it, which is the document the remap has to read and readdress
	[`alignments/${LOCAL}.json`]: json(
		alignmentDocument(`https://ada.github.io/atlas/images/${LOCAL}`, 1200, 851)
	),
	[`images/${LIBRARY}/remote.json`]: json(REMOTE_JSON),
	// alignment-write-is-the-fixture: a referenced Map Image's Alignment, addressed at the Library, as the specimen the remap must re-address
	[`alignments/${LIBRARY}.json`]: json(alignmentDocument(LIBRARY_SERVICE, 1200, 851))
};

function seed(closure: Record<ClosurePath, string> = CLOSURE): MemoryProjectStore {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(closure))
		store.plant(path as StorePath, encode(content));
	return store;
}

/**
 * The closure as a validated source, delivered in **sorted** order.
 *
 * Sorted puts `alignments/<id>.json` ahead of the `images/<id>/remote.json` that says where a
 * referenced Map Image is served from, which is the order that matters: an Alignment cannot be
 * addressed until its Map Image's record has arrived, and a source delivers in whatever order it is
 * cheapest in.
 */
async function sourceOf(store: MemoryProjectStore): Promise<ProjectImportSource> {
	const paths = [...store.snapshot().keys()].sort();
	const projectFileBytes = await store.read(PROJECT_FILE_NAME as StorePath);
	return createProjectImportSource({
		origin: { kind: 'review', projectName: 'Amsterdam 1625', directory: 'amsterdam-1625' },
		project: parseProjectFile(projectFileBytes),
		projectFileBytes,
		offered: await Promise.all(
			paths.map(async (path) => ({ path, bytes: await store.size(path) }))
		),
		files: async function* (wanted): AsyncIterable<ClosureFile> {
			for (const path of paths.filter((one) => wanted.includes(one))) {
				yield { path, bytes: await store.read(path as StorePath) };
			}
		}
	});
}

/** Identities in the order they were asked for, so every expectation names one the fixture chose. */
function identities(): () => string {
	let next = 0;
	return () => `fresh-${(next += 1)}`;
}

/** Every file of a remapped closure, by its remapped path. */
async function collect(closure: ProjectImportSource): Promise<Map<ClosurePath, Bytes>> {
	const files = new Map<ClosurePath, Bytes>();
	for await (const file of closure.files()) files.set(file.path, file.bytes);
	return files;
}

describe('remapProjectImport', () => {
	it('gives every distinct incoming Map Image one fresh identity, and repeated references the same one', async () => {
		const { images } = await remapProjectImport(await sourceOf(seed()), {
			imageId: identities()
		});

		expect([...images]).toEqual([
			[LOCAL, 'fresh-1'],
			[LIBRARY, 'fresh-2']
		]);
	});

	it('rewrites every image path, Alignment path and Layer imageId onto the fresh identity', async () => {
		const { closure } = await remapProjectImport(await sourceOf(seed()), {
			imageId: identities()
		});

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
		expect([...(await collect(closure)).keys()].sort()).toEqual([...closure.paths].sort());

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

	it('resets a stored pyramid’s stamped publication identifier to the placeholder for its fresh identity', async () => {
		const { closure } = await remapProjectImport(await sourceOf(seed()), {
			imageId: identities()
		});
		const files = await collect(closure);

		const info = JSON.parse(decode(files.get('images/fresh-1/info.json') as Bytes));
		expect(info.id).toBe('https://unset.invalid/fresh-1');
		// Every other member of the document, including one this build has never heard of.
		expect(info).toMatchObject({
			'@context': 'http://iiif.io/api/image/3/context.json',
			type: 'ImageService3',
			profile: 'level0',
			width: 1200,
			height: 851,
			tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }],
			somethingLaterBuildsWrote: 'kept'
		});
	});

	it('carries a Project’s Annotation bytes and its pyramid’s tiles over untouched', async () => {
		const { closure } = await remapProjectImport(await sourceOf(seed()), {
			imageId: identities()
		});
		const files = await collect(closure);

		expect(decode(files.get('annotations/l2.geojson') as Bytes)).toBe(ANNOTATION);
		expect(decode(files.get('images/fresh-1/0/0/0.jpg') as Bytes)).toBe(
			'not really a jpeg, but bytes'
		);
		expect(decode(files.get('images/fresh-1/manifest.json') as Bytes)).toBe(
			CLOSURE[`images/${LOCAL}/manifest.json`]
		);
	});

	it('keeps every Project and Layer field, including ones this build does not understand', async () => {
		const { closure } = await remapProjectImport(await sourceOf(seed()), {
			imageId: identities()
		});

		const project = parseProjectFile(closure.projectFileBytes);
		expect(project.name).toBe('Amsterdam 1625');
		expect(project.updatedAt).toBe('2025-03-04T11:22:33.000Z');
		expect(project.baseMap).toBe('protomaps-light');
		expect(project.unknownFields).toEqual({ provenanceOfSomeLaterBuild: { kept: true } });
		// `project-import-provenance.ts` owns the publication reset and the Front Page, in one place.
		// Nothing here.
		expect(project.canonicalUrl).toBe('https://ada.github.io/atlas');
		expect(project.onFrontPage).toBe(false);

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

	it('rewrites a local Alignment through the Alignment model, keeping its scholarly content', async () => {
		const { closure } = await remapProjectImport(await sourceOf(seed()), {
			imageId: identities()
		});
		const files = await collect(closure);

		const bytes = files.get(alignmentPath('fresh-1')) as Bytes;
		const alignment = parseAlignment(bytes, { imageId: 'fresh-1' });
		expect(alignment.controlPoints.map(({ resource, geo }) => ({ resource, geo }))).toEqual(
			CONTROL_POINTS
		);
		expect(alignment.resourceMask).toEqual(RESOURCE_MASK);
		expect(alignment.transformationType).toBe('polynomial2');
		expect(alignment.image).toEqual({ width: 1200, height: 851 });
		expect(alignment.unmodelled).toEqual({
			_allmaps: { note: 'something only the tool that wrote this understands' }
		});

		// The document's own address, which for a Workspace-held pyramid is the ADR-0004 placeholder
		// for the fresh identity — the same string that pyramid's `info.json` now declares.
		const document = JSON.parse(decode(bytes));
		expect(document.target.source.id).toBe('https://unset.invalid/fresh-1');
		expect(decode(bytes)).not.toContain(LOCAL);
		expect(decode(bytes)).not.toContain('ada.github.io');
	});

	it('keeps a referenced Map Image’s Library service and citation, and addresses its Alignment at it', async () => {
		const { closure } = await remapProjectImport(await sourceOf(seed()), {
			imageId: identities()
		});
		const files = await collect(closure);

		const record = parseReferencedImage(files.get('images/fresh-2/remote.json') as Bytes, {
			imageId: 'fresh-2'
		});
		expect(record).toEqual({
			...REMOTE_JSON,
			imageId: 'fresh-2',
			source: REMOTE_JSON.partOf
		});

		const bytes = files.get(alignmentPath('fresh-2')) as Bytes;
		expect(JSON.parse(decode(bytes)).target.source.id).toBe(LIBRARY_SERVICE);
		expect(parseAlignment(bytes, { imageId: 'fresh-2' }).controlPoints).toHaveLength(3);
		expect(decode(bytes)).not.toContain(LIBRARY);
	});

	it('gives an Offline Copy the local placeholder in both its pyramid and its Alignment, and keeps its record', async () => {
		// The same Map Image as a Library reference *and* a pyramid of ours beside it, which is what
		// making an offline copy leaves behind (ADR-0007): the citation stays, the tiles are here.
		const store = seed({
			...CLOSURE,
			[`images/${LIBRARY}/info.json`]: json({
				id: `https://ada.github.io/atlas/images/${LIBRARY}`
			}),
			[`images/${LIBRARY}/0/0/0.jpg`]: 'a copied tile'
		});
		const { closure } = await remapProjectImport(await sourceOf(store), { imageId: identities() });
		const files = await collect(closure);

		expect(JSON.parse(decode(files.get('images/fresh-2/info.json') as Bytes)).id).toBe(
			'https://unset.invalid/fresh-2'
		);
		expect(
			parseReferencedImage(files.get('images/fresh-2/remote.json') as Bytes, { imageId: 'fresh-2' })
				.service
		).toBe(LIBRARY_SERVICE);
		expect(JSON.parse(decode(files.get(alignmentPath('fresh-2')) as Bytes)).target.source.id).toBe(
			'https://unset.invalid/fresh-2'
		);
	});

	it('refuses to allocate one destination identity to two incoming Map Images', async () => {
		await expect(
			remapProjectImport(await sourceOf(seed()), { imageId: () => 'the-same-one' })
		).rejects.toThrow(/would merge them/);
	});

	it('refuses an identity a Workspace could not hold', async () => {
		await expect(remapProjectImport(await sourceOf(seed()), { imageId: () => '' })).rejects.toThrow(
			/not usable as a Map Image identity/
		);
	});

	it('allocates an identity per distinct Map Image by default, without consulting the image', async () => {
		// Two Imports of one Project are two Map Images, and an identical incoming image is never
		// matched against one the Workspace already has.
		const first = await remapProjectImport(await sourceOf(seed()));
		const second = await remapProjectImport(await sourceOf(seed()));

		const allocated = [...first.images.values(), ...second.images.values()];
		expect(new Set(allocated).size).toBe(4);
		for (const fresh of allocated) expect(fresh).toMatch(/^[0-9a-f]{16}$/);
	});

	it('canonicalises a referenced Map Image’s service, so its record and its Alignment agree', async () => {
		// A `remote.json` spelled with a trailing slash is the one that used to produce a tile base and
		// an `info.json` URL that were different strings for the same service. Read through
		// `parseReferencedImage` there is one spelling, and the Alignment is addressed at it.
		const store = seed({
			...CLOSURE,
			[`images/${LIBRARY}/remote.json`]: json({ ...REMOTE_JSON, service: `${LIBRARY_SERVICE}/` })
		});
		const { closure } = await remapProjectImport(await sourceOf(store), { imageId: identities() });
		const files = await collect(closure);

		// The record's own bytes, not what a tolerant reader makes of them: the canonical spelling has
		// to be what the file says, or the next build to read it without canonicalising disagrees.
		expect(JSON.parse(decode(files.get('images/fresh-2/remote.json') as Bytes)).service).toBe(
			LIBRARY_SERVICE
		);
		expect(JSON.parse(decode(files.get(alignmentPath('fresh-2')) as Bytes)).target.source.id).toBe(
			LIBRARY_SERVICE
		);
	});
});
