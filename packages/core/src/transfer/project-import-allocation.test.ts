import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { PROJECT_FILE_NAME, parseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { encode, rejection } from '../test-support.js';
import { allocateProjectImport } from './project-import-allocation.js';
import { remapProjectImport } from './project-import-remapping.js';
import type { ClosurePath, ProjectImportSource } from './project-import-source.js';
import {
	IMPORT_TRANSACTION_PATH,
	ImportRefusedError,
	commitProjectImport
} from './project-import-transaction.js';
import {
	PLAN_LAYER,
	REVIEW_ORIGIN,
	WAREHOUSES_LAYER,
	closureSource,
	contents,
	georeferenceDocument,
	json
} from './test-fixtures.js';

const SOURCE_IMAGE = 'amsterdam-1625';
const INCOMING_NAME = 'Amsterdam 1625';

const PROJECT = {
	formatVersion: 1,
	name: INCOMING_NAME,
	updatedAt: '2025-03-04T11:22:33.000Z',
	layers: [{ ...PLAN_LAYER, opacity: 1 }, WAREHOUSES_LAYER],
	baseMap: 'protomaps-light',
	onFrontPage: false
};

const CLOSURE: Record<ClosurePath, string> = {
	[PROJECT_FILE_NAME]: json(PROJECT),
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	[`images/${SOURCE_IMAGE}/info.json`]: json({ width: 1200, height: 851 }),
	[`images/${SOURCE_IMAGE}/0/0/0.jpg`]: 'not really a jpeg, but bytes',
	[`alignments/${SOURCE_IMAGE}.json`]: json(
		georeferenceDocument(`https://unset.invalid/${SOURCE_IMAGE}`)
	)
};

const sourceOf = (name = INCOMING_NAME): ProjectImportSource =>
	closureSource(
		{ ...CLOSURE, [PROJECT_FILE_NAME]: json({ ...PROJECT, name }) },
		{ origin: { ...REVIEW_ORIGIN, projectName: name } }
	);

function identities(prefix = 'fresh'): () => string {
	let next = 0;
	return () => `${prefix}-${(next += 1)}`;
}

const remapped = (source = sourceOf(), prefix?: string): Promise<ProjectImportSource> =>
	remapProjectImport(source, { imageId: identities(prefix) }).then((it) => it.closure);

interface Destination {
	readonly names?: readonly string[];
	readonly local?: readonly string[];
	readonly remote?: readonly string[];
	readonly baseline?: readonly string[];
}

async function allocate(destination: Destination, incoming = INCOMING_NAME) {
	const { name, directory } = allocateProjectImport(
		await remapped(sourceOf(incoming)),
		destination
	);
	return { name, directory };
}

const AMSTERDAM = 'amsterdam-1625/project.json';
const imported = (n = '') => ({
	name: `${INCOMING_NAME} (imported${n && ` ${n}`})`,
	directory: `amsterdam-1625-imported${n && `-${n}`}`
});
const kept = (directory = 'amsterdam-1625') => ({ name: INCOMING_NAME, directory });

describe('allocating an imported Project’s name', () => {
	it.each([
		{
			when: 'keeps the incoming name when no local Project shows it',
			destination: { names: ['The Canal Ring'], local: ['the-canal-ring/project.json'] },
			expected: kept()
		},
		{ when: 'keeps the incoming name in an empty Workspace', destination: {}, expected: kept() },
		{
			when: 'suffixes “(imported)” when a local Project already shows the name',
			destination: { names: [INCOMING_NAME], local: [AMSTERDAM] },
			expected: imported()
		},
		{
			when: 'suffixes “(imported 2)” when the first variant is also shown',
			destination: {
				names: [INCOMING_NAME, imported().name],
				local: [AMSTERDAM, 'amsterdam-1625-imported/project.json']
			},
			expected: imported('2')
		},
		{
			when: 'counts up to the first free variant',
			destination: {
				names: [INCOMING_NAME, imported().name, imported('2').name, imported('3').name]
			},
			expected: imported('4')
		},
		{
			when: 'takes the first available variant rather than the next number',
			destination: { names: [INCOMING_NAME, imported('2').name] },
			expected: imported()
		},
		{
			when: 'treats a differently-cased local display name as the same name',
			destination: { names: ['amsterdam 1625'] },
			expected: imported()
		},
		{
			when: 'allocates the directory independently of the display name’s suffix',
			destination: { names: [INCOMING_NAME], local: ['somewhere-else/project.json'] },
			expected: imported()
		}
	])('$when', async ({ destination, expected }) => {
		expect(await allocate(destination)).toEqual(expected);
	});

	it('treats a decomposed local display name as the same name', async () => {
		expect(await allocate({ names: ['Zürich 1850'.normalize('NFD')] }, 'Zürich 1850')).toEqual({
			name: 'Zürich 1850 (imported)',
			directory: 'zurich-1850-imported'
		});
	});
});

describe('allocating an imported Project’s directory', () => {
	it.each([
		{
			when: 'suffixes the slug when a Project holds it under another display name',
			destination: { names: ['Somebody Else’s Work'], local: [AMSTERDAM] },
			directory: 'amsterdam-1625-2'
		},
		{
			when: 'suffixes past every taken slug',
			destination: {
				local: [AMSTERDAM, 'amsterdam-1625-2/project.json', 'amsterdam-1625-3/project.json']
			},
			directory: 'amsterdam-1625-4'
		},
		{
			when: 'reserves a top-level name that holds no Project at all',
			destination: { local: ['amsterdam-1625/notes.txt'] },
			directory: 'amsterdam-1625-2'
		},
		{
			when: 'reserves a top-level file of the same name',
			destination: { local: ['amsterdam-1625'] },
			directory: 'amsterdam-1625-2'
		},
		{
			when: 'reserves a Project directory only the Remote has',
			destination: { remote: [AMSTERDAM] },
			directory: 'amsterdam-1625-2'
		},
		{
			when: 'reserves a Project directory only the Baseline records',
			destination: { baseline: [AMSTERDAM] },
			directory: 'amsterdam-1625-2'
		},
		{
			when: 'does not reserve a Remote or Baseline directory that holds no Project',
			destination: {
				remote: ['amsterdam-1625/README.md', 'amsterdam-1625/deeper/project.json'],
				baseline: ['amsterdam-1625/LICENSE']
			},
			directory: 'amsterdam-1625'
		},
		{
			when: 'takes the union of all three inventories',
			destination: {
				local: [AMSTERDAM],
				remote: ['amsterdam-1625-2/project.json'],
				baseline: ['amsterdam-1625-3/project.json']
			},
			directory: 'amsterdam-1625-4'
		},
		{
			when: 'treats a differently-cased directory on any side as taken',
			destination: {
				local: ['Amsterdam-1625/notes.txt'],
				remote: ['AMSTERDAM-1625-2/project.json'],
				baseline: ['Amsterdam-1625-3/project.json']
			},
			directory: 'amsterdam-1625-4'
		}
	])('$when', async ({ destination, directory }) => {
		expect(await allocate(destination)).toEqual(kept(directory));
	});

	it.each([
		['Images', 'images-2'],
		['Alignments', 'alignments-2'],
		['Base Map', 'base-map-2']
	])('reserves the Workspace’s own shared directory for “%s”', async (name, directory) => {
		expect(await allocate({}, name)).toEqual({ name, directory });
	});

	it('does not treat a folder whose name only transliterates to the slug as taken', async () => {
		const local = [`${'zürich-1850'.normalize('NFD')}/project.json`];
		expect(await allocate({ local }, 'Zürich 1850')).toEqual({
			name: 'Zürich 1850',
			directory: 'zurich-1850'
		});
	});
});

describe('allocating an imported Project’s destinations', () => {
	it('names one for every closure path: the Project’s own under the directory, shared at the top', async () => {
		const closure = await remapped();
		const { destinations } = allocateProjectImport(closure, {});

		expect([...destinations.keys()].sort()).toEqual([...closure.paths].sort());
		expect(Object.fromEntries(destinations)).toEqual({
			[PROJECT_FILE_NAME]: `amsterdam-1625/${PROJECT_FILE_NAME}`,
			'annotations/warehouses.geojson': 'amsterdam-1625/annotations/warehouses.geojson',
			'images/fresh-1/info.json': 'images/fresh-1/info.json',
			'images/fresh-1/0/0/0.jpg': 'images/fresh-1/0/0/0.jpg',
			[alignmentPath('fresh-1')]: alignmentPath('fresh-1')
		});
	});

	it.each([
		['the allocated Map Image path', 'images/fresh-1/info.json'],
		['the allocated Alignment path', alignmentPath('fresh-1')],
		['a folded alias of an allocated path', 'Images/FRESH-1/info.json']
	])('refuses when %s is already in the Workspace', async (_what, taken) => {
		const closure = await remapped();
		const refusal = await rejection(ImportRefusedError, () =>
			allocateProjectImport(closure, { local: [taken] })
		);
		expect(refusal.refusal).toBe('destination-exists');
		expect(refusal.message).toContain(taken);
	});
});

describe('importing one source twice', () => {
	it('allocates another directory and another set of Map Image identities', async () => {
		const store = new MemoryProjectStore();
		const first = await install(store, 'first');
		const second = await install(store, 'second');
		expect(second.directory).not.toBe(first.directory);
		expect(second.name).toBe('Amsterdam 1625 (imported)');
		expect(destinationsOf(second)).not.toEqual(destinationsOf(first));
		expect(destinationsOf(second).filter((path) => destinationsOf(first).includes(path))).toEqual(
			[]
		);
	});
});

describe('refusing rather than overwriting', () => {
	it.each([
		['a Project file', 'amsterdam-1625/project.json'],
		['an Annotation', 'amsterdam-1625/annotations/warehouses.geojson'],
		['a Map Image', 'images/fresh-1/0/0/0.jpg'],
		['an Alignment', alignmentPath('fresh-1')]
	])(
		'refuses an Import that would overwrite %s, leaving every byte as it was',
		async (_kind, path) => {
			const store = new MemoryProjectStore();
			store.plant('the-canal-ring/project.json', encode('{"name":"The Canal Ring"}'));
			const closure = await remapped();
			const allocated = allocateProjectImport(closure, { local: [...store.snapshot().keys()] });
			store.plant(path, encode('the author’s own work'));
			const before = contents(store);

			const refusal = await rejection(
				ImportRefusedError,
				commitProjectImport(store, closure, allocated.destinations)
			);

			expect(refusal.refusal).toBe('destination-exists');
			expect(contents(store)).toEqual(before);
			expect(store.snapshot().has(IMPORT_TRANSACTION_PATH)).toBe(false);
		}
	);
});

type Allocated = ReturnType<typeof allocateProjectImport>;

const destinationsOf = (allocated: Allocated): readonly string[] =>
	[...allocated.destinations.values()].sort();

async function install(store: MemoryProjectStore, prefix: string): Promise<Allocated> {
	const closure = await remapped(sourceOf(), prefix);
	const allocated = allocateProjectImport(closure, {
		names: await displayNames(store),
		local: [...store.snapshot().keys()]
	});
	await commitProjectImport(store, closure, allocated.destinations);
	return allocated;
}

async function displayNames(store: MemoryProjectStore): Promise<readonly string[]> {
	const names: string[] = [];
	for (const path of store.snapshot().keys()) {
		const [directory, name, ...deeper] = path.split('/');
		if (directory === undefined || name !== PROJECT_FILE_NAME || deeper.length > 0) continue;
		names.push(parseProjectFile(await store.read(path)).name);
	}
	return names;
}
