// Where an imported Project lands: its visible name, its directory, and every destination path
// (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE IS A TABLE AND THEN AN INTEGRATION
//
// Two different claims are being made and they need different evidence.
//
// The first is arithmetic: given these Projects, this Remote and this Baseline, the chosen name is
// exactly that name and the chosen directory is exactly that directory. That is a table, and it is
// written as one — every row states the evidence and both answers, so a change of rule shows up as a
// changed row rather than as a re-derived expectation.
//
// The second is that nothing an Import writes can be something the author already has, and *that*
// cannot be shown by inspecting the allocation: it is a claim about bytes. So the last group allocates
// for real, commits through {@link commitProjectImport}, and compares the whole store against a
// snapshot taken before — for a colliding Project file, Map Image, Alignment and Annotation in turn.
// A refusal that left the marker or a single destination byte behind would be visible there and
// nowhere else.

import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { PROJECT_FILE_NAME, parseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { allocateProjectImport } from './project-import-allocation.js';
import { remapProjectImport } from './project-import-remapping.js';
import {
	createProjectImportSource,
	type ClosureFile,
	type ClosurePath,
	type ProjectImportSource
} from './project-import-source.js';
import {
	IMPORT_TRANSACTION_PATH,
	ImportRefusedError,
	commitProjectImport
} from './project-import-transaction.js';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const json = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`;

/** The Map Image the incoming Project draws, at the identity its **source** Workspace gave it. */
const SOURCE_IMAGE = 'amsterdam-1625';

const INCOMING_NAME = 'Amsterdam 1625';

const PROJECT = {
	formatVersion: 1,
	name: INCOMING_NAME,
	updatedAt: '2025-03-04T11:22:33.000Z',
	layers: [
		{
			kind: 'map',
			id: 'l1',
			name: 'The 1625 plan',
			visible: true,
			order: 0,
			opacity: 1,
			imageId: SOURCE_IMAGE
		},
		{
			kind: 'annotation',
			id: 'l2',
			name: 'Warehouses',
			visible: true,
			order: 1,
			geojsonRef: 'annotations/warehouses.geojson'
		}
	],
	baseMap: 'protomaps-light',
	onFrontPage: false
};

/** A Georeference Annotation as the source Workspace holds it, minimal but genuinely parseable. */
const ALIGNMENT = {
	type: 'Annotation',
	'@context': [
		'http://iiif.io/api/extension/georef/1/context.json',
		'http://iiif.io/api/presentation/3/context.json'
	],
	motivation: 'georeferencing',
	target: {
		type: 'SpecificResource',
		source: {
			id: `https://unset.invalid/${SOURCE_IMAGE}`,
			type: 'ImageService3',
			width: 1200,
			height: 851
		},
		selector: {
			type: 'SvgSelector',
			value:
				'<svg width="1200" height="851"><polygon points="10,20 1190,20 1190,830 10,830" /></svg>'
		}
	},
	body: {
		type: 'FeatureCollection',
		transformation: { type: 'polynomial', options: { order: 1 } },
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
	}
};

/** The closure the source offers, Project-relative (ADR-0023). */
const CLOSURE: Record<ClosurePath, string> = {
	[PROJECT_FILE_NAME]: json(PROJECT),
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	[`images/${SOURCE_IMAGE}/info.json`]: json({ width: 1200, height: 851 }),
	[`images/${SOURCE_IMAGE}/0/0/0.jpg`]: 'not really a jpeg, but bytes',
	// alignment-write-is-the-fixture: the incoming Alignment, whose destination path is one of the four this suite proves is never overwritten
	[`alignments/${SOURCE_IMAGE}.json`]: json(ALIGNMENT)
};

/** A validated source over {@link CLOSURE}, named so a row can state a different display name. */
function sourceOf(name = INCOMING_NAME): ProjectImportSource {
	const projectFileBytes = encode(json({ ...PROJECT, name }));
	return createProjectImportSource({
		origin: { kind: 'project-bundle', fileName: 'amsterdam-1625.project.tar', projectName: name },
		project: parseProjectFile(projectFileBytes),
		projectFileBytes,
		offered: Object.entries(CLOSURE).map(([path, content]) => ({
			path,
			bytes: encode(content).byteLength
		})),
		files: async function* (wanted): AsyncIterable<ClosureFile> {
			for (const path of Object.keys(CLOSURE).sort()) {
				if (wanted.includes(path)) yield { path, bytes: encode(CLOSURE[path] as string) };
			}
		}
	});
}

/** Identities in the order they were asked for, so every expectation names one this suite chose. */
function identities(prefix = 'fresh'): () => string {
	let next = 0;
	return () => `${prefix}-${(next += 1)}`;
}

/** The closure on identities the destination has never used — the remapping's half, done for real. */
const remapped = (source = sourceOf(), prefix?: string): Promise<ProjectImportSource> =>
	remapProjectImport(source, { imageId: identities(prefix) }).then((it) => it.closure);

/** What one row of the table states about the Workspace the Project is arriving in. */
interface Destination {
	/** The display names of the Projects the Workspace shows now. */
	readonly names?: readonly string[];
	readonly local?: readonly string[];
	readonly remote?: readonly string[];
	readonly baseline?: readonly string[];
}

async function allocate(
	destination: Destination,
	source?: ProjectImportSource
): Promise<{ readonly name: string; readonly directory: string }> {
	const { name, directory } = allocateProjectImport(source ?? (await remapped()), destination);
	return { name, directory };
}

/** A Workspace holding one Project: its directory's files and its display name. */
const workspaceWith = (directory: string, name: string): Destination => ({
	names: [name],
	local: [`${directory}/${PROJECT_FILE_NAME}`]
});

describe('allocating an imported Project’s name', () => {
	it('keeps the incoming name when no local Project shows it', async () => {
		expect(await allocate(workspaceWith('the-canal-ring', 'The Canal Ring'))).toEqual({
			name: 'Amsterdam 1625',
			directory: 'amsterdam-1625'
		});
	});

	it('keeps the incoming name in an empty Workspace', async () => {
		expect(await allocate({})).toEqual({ name: 'Amsterdam 1625', directory: 'amsterdam-1625' });
	});

	it('suffixes “(imported)” when a local Project already shows the name', async () => {
		expect(await allocate(workspaceWith('amsterdam-1625', INCOMING_NAME))).toEqual({
			name: 'Amsterdam 1625 (imported)',
			directory: 'amsterdam-1625-imported'
		});
	});

	it('suffixes “(imported 2)” when the first variant is also shown', async () => {
		expect(
			await allocate({
				names: [INCOMING_NAME, 'Amsterdam 1625 (imported)'],
				local: ['amsterdam-1625/project.json', 'amsterdam-1625-imported/project.json']
			})
		).toEqual({ name: 'Amsterdam 1625 (imported 2)', directory: 'amsterdam-1625-imported-2' });
	});

	it('counts up to the first free variant', async () => {
		expect(
			await allocate({
				names: [
					INCOMING_NAME,
					'Amsterdam 1625 (imported)',
					'Amsterdam 1625 (imported 2)',
					'Amsterdam 1625 (imported 3)'
				]
			})
		).toEqual({ name: 'Amsterdam 1625 (imported 4)', directory: 'amsterdam-1625-imported-4' });
	});

	it('takes the first available variant rather than the next number', async () => {
		expect(await allocate({ names: [INCOMING_NAME, 'Amsterdam 1625 (imported 2)'] })).toEqual({
			name: 'Amsterdam 1625 (imported)',
			directory: 'amsterdam-1625-imported'
		});
	});

	it('treats a differently-cased local display name as the same name', async () => {
		expect(await allocate({ names: ['amsterdam 1625'] })).toEqual({
			name: 'Amsterdam 1625 (imported)',
			directory: 'amsterdam-1625-imported'
		});
	});

	it('treats a decomposed local display name as the same name', async () => {
		const composed = 'Zürich 1850';
		expect(
			await allocate({ names: [composed.normalize('NFD')] }, await remapped(sourceOf(composed)))
		).toEqual({ name: 'Zürich 1850 (imported)', directory: 'zurich-1850-imported' });
	});
});

describe('allocating an imported Project’s directory', () => {
	it('suffixes the slug when a Project holds it under another display name', async () => {
		expect(await allocate(workspaceWith('amsterdam-1625', 'Somebody Else’s Work'))).toEqual({
			name: 'Amsterdam 1625',
			directory: 'amsterdam-1625-2'
		});
	});

	it('suffixes past every taken slug', async () => {
		expect(
			await allocate({
				local: [
					'amsterdam-1625/project.json',
					'amsterdam-1625-2/project.json',
					'amsterdam-1625-3/project.json'
				]
			})
		).toEqual({ name: 'Amsterdam 1625', directory: 'amsterdam-1625-4' });
	});

	it('reserves a top-level name that holds no Project at all', async () => {
		expect(await allocate({ local: ['amsterdam-1625/notes.txt'] })).toEqual({
			name: 'Amsterdam 1625',
			directory: 'amsterdam-1625-2'
		});
	});

	it('reserves a top-level file of the same name', async () => {
		expect(await allocate({ local: ['amsterdam-1625'] })).toEqual({
			name: 'Amsterdam 1625',
			directory: 'amsterdam-1625-2'
		});
	});

	it('reserves the Workspace’s own shared directories', async () => {
		const reserved: readonly [string, string][] = [
			['Images', 'images-2'],
			['Alignments', 'alignments-2'],
			['Base Map', 'base-map-2']
		];

		for (const [name, directory] of reserved) {
			expect(await allocate({}, await remapped(sourceOf(name)))).toEqual({ name, directory });
		}
	});

	it('reserves a Project directory only the Remote has', async () => {
		expect(await allocate({ remote: ['amsterdam-1625/project.json'] })).toEqual({
			name: 'Amsterdam 1625',
			directory: 'amsterdam-1625-2'
		});
	});

	it('reserves a Project directory only the Baseline records', async () => {
		expect(await allocate({ baseline: ['amsterdam-1625/project.json'] })).toEqual({
			name: 'Amsterdam 1625',
			directory: 'amsterdam-1625-2'
		});
	});

	it('does not reserve a Remote or Baseline directory that holds no Project', async () => {
		expect(
			await allocate({
				remote: ['amsterdam-1625/README.md', 'amsterdam-1625/deeper/project.json'],
				baseline: ['amsterdam-1625/LICENSE']
			})
		).toEqual({ name: 'Amsterdam 1625', directory: 'amsterdam-1625' });
	});

	it('takes the union of all three inventories', async () => {
		expect(
			await allocate({
				local: ['amsterdam-1625/project.json'],
				remote: ['amsterdam-1625-2/project.json'],
				baseline: ['amsterdam-1625-3/project.json']
			})
		).toEqual({ name: 'Amsterdam 1625', directory: 'amsterdam-1625-4' });
	});

	it('treats a differently-cased directory on any side as taken', async () => {
		expect(
			await allocate({
				local: ['Amsterdam-1625/notes.txt'],
				remote: ['AMSTERDAM-1625-2/project.json'],
				baseline: ['Amsterdam-1625-3/project.json']
			})
		).toEqual({ name: 'Amsterdam 1625', directory: 'amsterdam-1625-4' });
	});

	it('does not treat a folder whose name only transliterates to the slug as taken', async () => {
		// The row that keeps the two rules apart. `toDirectoryName` strips marks to reach ASCII, and
		// `foldName` deliberately does not: a Workspace holding `zürich-1850/` and one holding
		// `zurich-1850/` are two folders on every filesystem, so folding the slug rule into the
		// collision rule would manufacture a suffix nobody needs.
		const source = await remapped(sourceOf('Zürich 1850'));

		expect(
			await allocate({ local: [`${'zürich-1850'.normalize('NFD')}/project.json`] }, source)
		).toEqual({ name: 'Zürich 1850', directory: 'zurich-1850' });
	});

	it('allocates the directory independently of the display name’s suffix', async () => {
		// The name collides and the slug does not, so the two namespaces disagree — which is the point.
		expect(
			await allocate({ names: [INCOMING_NAME], local: ['somewhere-else/project.json'] })
		).toEqual({ name: 'Amsterdam 1625 (imported)', directory: 'amsterdam-1625-imported' });
	});
});

describe('allocating an imported Project’s destinations', () => {
	it('puts the Project’s own files under the directory and the shared material at the top level', async () => {
		const closure = await remapped();
		const { destinations } = allocateProjectImport(closure, {});

		expect(Object.fromEntries(destinations)).toEqual({
			[PROJECT_FILE_NAME]: `amsterdam-1625/${PROJECT_FILE_NAME}`,
			'annotations/warehouses.geojson': 'amsterdam-1625/annotations/warehouses.geojson',
			'images/fresh-1/info.json': 'images/fresh-1/info.json',
			'images/fresh-1/0/0/0.jpg': 'images/fresh-1/0/0/0.jpg',
			[alignmentPath('fresh-1')]: alignmentPath('fresh-1')
		});
	});

	it('names a destination for every closure path and nothing else', async () => {
		const closure = await remapped();
		const { destinations } = allocateProjectImport(closure, {});

		expect([...destinations.keys()].sort()).toEqual([...closure.paths].sort());
	});

	it('refuses when the allocated Map Image path is already in the Workspace', async () => {
		const closure = await remapped();

		expect(() => allocateProjectImport(closure, { local: ['images/fresh-1/info.json'] })).toThrow(
			ImportRefusedError
		);
	});

	it('refuses when the allocated Alignment path is already in the Workspace', async () => {
		const closure = await remapped();

		const refusal = refusalOf(() =>
			allocateProjectImport(closure, { local: [alignmentPath('fresh-1')] })
		);
		expect(refusal.refusal).toBe('destination-exists');
		expect(refusal.message).toContain(alignmentPath('fresh-1'));
	});

	it('refuses when a folded alias of an allocated path is already in the Workspace', async () => {
		const closure = await remapped();

		expect(
			refusalOf(() => allocateProjectImport(closure, { local: ['Images/FRESH-1/info.json'] }))
				.refusal
		).toBe('destination-exists');
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
	// One conflicting path per kind, and each one is the author's own work at a destination the
	// allocation was made without knowing about — which is the only way a fresh allocation can be
	// found taken, and exactly why `commitProjectImport` re-asks before it writes the marker.
	const conflicts: readonly [string, (allocated: Allocated) => StorePath][] = [
		['a Project file', (allocated) => allocated.destinations.get(PROJECT_FILE_NAME) as StorePath],
		[
			'an Annotation',
			(allocated) => allocated.destinations.get('annotations/warehouses.geojson') as StorePath
		],
		['a Map Image', () => 'images/fresh-1/0/0/0.jpg' as StorePath],
		['an Alignment', () => alignmentPath('fresh-1') as StorePath]
	];

	for (const [kind, pathOf] of conflicts) {
		it(`refuses an Import that would overwrite ${kind}, leaving every byte as it was`, async () => {
			const store = new MemoryProjectStore();
			store.plant('the-canal-ring/project.json' as StorePath, encode('{"name":"The Canal Ring"}'));
			const closure = await remapped();
			const allocated = allocateProjectImport(closure, { local: [...store.snapshot().keys()] });
			store.plant(pathOf(allocated), encode('the author’s own work'));
			const before = snapshot(store);

			const refusal = await refusedCommit(store, closure, allocated);

			expect(refusal.refusal).toBe('destination-exists');
			expect(snapshot(store)).toEqual(before);
			expect(store.snapshot().has(IMPORT_TRANSACTION_PATH)).toBe(false);
		});
	}
});

type Allocated = ReturnType<typeof allocateProjectImport>;

/** Every path the store holds with its contents, for comparison against a complete expectation. */
const snapshot = (store: MemoryProjectStore): Record<string, string> =>
	Object.fromEntries([...store.snapshot()].map(([path, bytes]) => [path, decode(bytes)]));

const destinationsOf = (allocated: Allocated): readonly string[] =>
	[...allocated.destinations.values()].sort();

/** Allocate against the store as it stands and commit, so the next Import sees the last one. */
async function install(store: MemoryProjectStore, prefix: string): Promise<Allocated> {
	const closure = await remapped(sourceOf(), prefix);
	const allocated = allocateProjectImport(closure, {
		names: await displayNames(store),
		local: [...store.snapshot().keys()]
	});
	await commitProjectImport(store, closure, allocated.destinations);
	return allocated;
}

/** The display names the Workspace shows, read back out of the Projects it holds. */
async function displayNames(store: MemoryProjectStore): Promise<readonly string[]> {
	const names: string[] = [];
	for (const path of store.snapshot().keys()) {
		const [directory, name, ...deeper] = path.split('/');
		if (directory === undefined || name !== PROJECT_FILE_NAME || deeper.length > 0) continue;
		names.push(parseProjectFile(await store.read(path)).name);
	}
	return names;
}

function refusalOf(run: () => unknown): ImportRefusedError {
	try {
		run();
	} catch (cause) {
		if (cause instanceof ImportRefusedError) return cause;
		throw cause;
	}
	throw new Error('the Import was not refused');
}

async function refusedCommit(
	store: MemoryProjectStore,
	closure: ProjectImportSource,
	allocated: Allocated
): Promise<ImportRefusedError> {
	try {
		await commitProjectImport(store, closure, allocated.destinations);
	} catch (cause) {
		if (cause instanceof ImportRefusedError) return cause;
		throw cause;
	}
	throw new Error('the Import was not refused');
}
