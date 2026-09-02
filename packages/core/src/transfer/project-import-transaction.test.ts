// The destination half of Project Import: one closure, written once, under one recoverable marker
// (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE ASSERTIONS ARE WHOLE STORE SNAPSHOTS AND NOT CALL ORDER
//
// The claim under test is that a Workspace shows either its old complete state or its new complete
// imported Project and never a mixture. That is a claim about the *files*, so every fault case
// compares the entire store against a complete expected snapshot rather than asserting which methods
// were called in which order — CONTRIBUTING.md's rule for a good test at this seam, and the only form
// of the assertion that a different implementation of the same protocol would still have to satisfy.
//
// **`project.json` last is proved the same way.** No spy: the fault matrix walks every durable
// boundary, and at each one the snapshot is compared whole. A snapshot holding the imported manifest
// while missing one of its Layers' files would fail its own comparison, so the discipline is asserted
// by the matrix rather than claimed beside it.
//
// **One engine, exercised at the memory seam, for both real backings.** OPFS and the chosen folder
// share `TempFileWriteStore`'s temp-file-then-rename `write` and are held to it by the shared adapter
// suite, and every decision this protocol makes — the folded path comparison included — is made in
// the engine from `list` and `size`. A per-backing copy of this matrix would prove each backing
// self-consistent rather than proving they agree, and the thing that could differ between them is
// already the adapter suite's subject.

import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { PROJECT_FILE_NAME, parseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { type Bytes, type StorePath } from '../store/project-store.js';
import {
	IMPORT_TRANSACTION_FORMAT_VERSION,
	IMPORT_TRANSACTION_PATH,
	ImportRefusedError,
	clearImportTransaction,
	commitProjectImport,
	discardImportTransaction,
	readImportTransaction,
	serialiseImportTransaction,
	type ImportTransaction,
	type ImportTransactionMark
} from './project-import-transaction.js';
import {
	createProjectImportSource,
	type ClosureFile,
	type ClosurePath,
	type ProjectImportSource
} from './project-import-source.js';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const decode = (bytes: Bytes): string => new TextDecoder().decode(bytes);

const TRANSACTION = 'tx-1';
const STARTED_AT = '2026-08-22T10:00:00.000Z';

/** The Project the source is offering, as its own `project.json` spells it. */
const PROJECT_JSON = `${JSON.stringify(
	{
		formatVersion: 1,
		name: 'Amsterdam 1625',
		updatedAt: '2025-03-04T11:22:33.000Z',
		layers: [
			{
				id: 'l1',
				name: 'The 1625 plan',
				visible: true,
				order: 0,
				kind: 'map',
				opacity: 0.8,
				imageId: 'amsterdam-1625'
			},
			{
				id: 'l2',
				name: 'Warehouses',
				visible: true,
				order: 1,
				kind: 'annotation',
				geojsonRef: 'annotations/warehouses.geojson'
			}
		],
		baseMap: 'protomaps-light'
	},
	null,
	'\t'
)}\n`;

/** Every closure path the source holds, Project-relative, with the bytes it will hand over. */
const CLOSURE: Record<ClosurePath, string> = {
	[PROJECT_FILE_NAME]: PROJECT_JSON,
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0/0/0.jpg': 'not really a jpeg, but bytes',
	// alignment-write-is-the-fixture: the Alignment as the source Workspace already holds it, which the transaction carries over verbatim
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}'
};

/** Where the closure lands: a fresh Project directory and a fresh Map Image identity. */
const DIRECTORY = 'amsterdam-1625-2';
const FRESH_IMAGE = 'img-fresh';

const DESTINATIONS: ReadonlyMap<ClosurePath, StorePath> = new Map([
	[PROJECT_FILE_NAME, `${DIRECTORY}/${PROJECT_FILE_NAME}` as StorePath],
	['annotations/warehouses.geojson', `${DIRECTORY}/annotations/warehouses.geojson` as StorePath],
	['images/amsterdam-1625/info.json', `images/${FRESH_IMAGE}/info.json` as StorePath],
	['images/amsterdam-1625/0/0/0.jpg', `images/${FRESH_IMAGE}/0/0/0.jpg` as StorePath],
	['alignments/amsterdam-1625.json', alignmentPath(FRESH_IMAGE) as StorePath]
]);

const MANIFEST_DESTINATION = DESTINATIONS.get(PROJECT_FILE_NAME) as StorePath;

/** The Workspace the user already has, which every refusal and every rollback has to leave alone. */
const BEFORE: Record<string, string> = {
	'the-canal-ring/project.json': '{"formatVersion":1,"name":"The Canal Ring","layers":[]}',
	'the-canal-ring/annotations/canals.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
	// alignment-write-is-the-fixture: the user's own Alignment, seeded so a rollback that touched it would be visible
	'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
};

/** The Workspace once the whole closure has arrived at its planned paths. */
const AFTER: Record<string, string> = {
	...BEFORE,
	...Object.fromEntries(
		[...DESTINATIONS].map(([closure, destination]) => [destination, CLOSURE[closure] as string])
	)
};

function seed(files: Record<string, string> = BEFORE): MemoryProjectStore {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(files))
		store.plant(path as StorePath, encode(content));
	return store;
}

/** Every path the store holds with its contents, for comparison against a complete expectation. */
const snapshot = (store: MemoryProjectStore): Record<string, string> =>
	Object.fromEntries([...store.snapshot()].map(([path, bytes]) => [path, decode(bytes)]));

/**
 * The order the source hands its files over in, **with the manifest first**.
 *
 * A source delivers in whatever order it is cheapest in, and a tar's is the order its author packed
 * it. `project.json` first is therefore a legitimate source and the one that matters: it is the only
 * arrangement under which "the manifest is written last" is a claim about the engine rather than an
 * accident of the closure's sorted paths, where `project.json` comes last anyway.
 */
const STREAM_ORDER: readonly ClosurePath[] = [
	PROJECT_FILE_NAME,
	...Object.keys(CLOSURE)
		.filter((path) => path !== PROJECT_FILE_NAME)
		.sort()
];

/** The last file the source hands over, after which only the manifest and the marker are left. */
const LAST_DELIVERED = STREAM_ORDER[STREAM_ORDER.length - 1] as ClosurePath;

/**
 * A source over {@link CLOSURE}, validated exactly as a real one is.
 *
 * `between` runs after each file is handed over, which is where a mid-transaction observation of the
 * Workspace goes: the engine is between two durable writes at that moment and nothing else can see
 * it there.
 */
function source(between?: (path: ClosurePath) => void | Promise<void>): ProjectImportSource {
	const offered = Object.entries(CLOSURE).map(([path, content]) => ({
		path,
		bytes: encode(content).byteLength
	}));
	return createProjectImportSource({
		origin: {
			kind: 'project-bundle',
			fileName: 'amsterdam-1625.project.tar',
			projectName: 'Amsterdam 1625'
		},
		project: parseProjectFile(encode(PROJECT_JSON)),
		projectFileBytes: encode(PROJECT_JSON),
		offered,
		files: async function* (paths): AsyncIterable<ClosureFile> {
			for (const path of STREAM_ORDER.filter((one) => paths.includes(one))) {
				yield { path, bytes: encode(CLOSURE[path] as string) };
				await between?.(path);
			}
		}
	});
}

const CLOSURE_BYTES = Object.values(CLOSURE).reduce(
	(sum, content) => sum + encode(content).byteLength,
	0
);

/** The marker as the engine writes it at its widest, which is what the quota check has to allow for. */
const COMMITTED: ImportTransaction = {
	formatVersion: IMPORT_TRANSACTION_FORMAT_VERSION,
	transaction: TRANSACTION,
	state: 'committed',
	project: MANIFEST_DESTINATION,
	paths: [...DESTINATIONS.values()].sort(),
	startedAt: STARTED_AT
};

const MARKER_BYTES = serialiseImportTransaction(COMMITTED).byteLength;

const OPTIONS = {
	transaction: () => TRANSACTION,
	now: () => new Date(STARTED_AT)
};

/** A plan with one entry changed, for the refusals that are about the plan itself. */
const planWith = (changes: ReadonlyMap<ClosurePath, StorePath>): Map<ClosurePath, StorePath> =>
	new Map([...DESTINATIONS, ...changes]);

const importInto = (
	store: MemoryProjectStore,
	plan: ReadonlyMap<ClosurePath, StorePath> = DESTINATIONS,
	options: Parameters<typeof commitProjectImport>[3] = OPTIONS
) => commitProjectImport(store, source(), plan, options);

const refusalOf = async (run: () => Promise<unknown>): Promise<ImportRefusedError> => {
	try {
		await run();
	} catch (cause) {
		if (cause instanceof ImportRefusedError) return cause;
		throw cause;
	}
	throw new Error('the Import was not refused');
};

describe('committing a Project Import', () => {
	describe('preflight, before any byte of the closure is written', () => {
		it('refuses a plan that does not name every closure path, and writes nothing', async () => {
			const store = seed();
			const partial = new Map(DESTINATIONS);
			partial.delete('images/amsterdam-1625/info.json');

			const refusal = await refusalOf(() => importInto(store, partial));

			expect(refusal.refusal).toBe('plan-mismatch');
			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('refuses a plan naming a path the closure does not hold', async () => {
			const store = seed();
			const extra = planWith(
				new Map([['images/somebody-else/info.json', 'images/x/info.json' as StorePath]])
			);

			const refusal = await refusalOf(() => importInto(store, extra));

			expect(refusal.refusal).toBe('plan-mismatch');
			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('refuses two closure paths planned onto one destination', async () => {
			const store = seed();
			const collided = planWith(
				new Map([
					['images/amsterdam-1625/info.json', `images/${FRESH_IMAGE}/0/0/0.jpg` as StorePath]
				])
			);

			const refusal = await refusalOf(() => importInto(store, collided));

			expect(refusal.refusal).toBe('plan-mismatch');
			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('refuses two destinations that a case-folding filesystem would treat as one', async () => {
			const store = seed();
			const folded = planWith(
				new Map([
					['images/amsterdam-1625/info.json', `images/${FRESH_IMAGE}/Info.json` as StorePath]
				])
			);
			folded.set('images/amsterdam-1625/0/0/0.jpg', `images/${FRESH_IMAGE}/INFO.json` as StorePath);

			const refusal = await refusalOf(() => importInto(store, folded));

			expect(refusal.refusal).toBe('plan-mismatch');
			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('refuses the reserved transaction marker as a destination', async () => {
			const store = seed();
			const reserved = planWith(
				new Map([['annotations/warehouses.geojson', IMPORT_TRANSACTION_PATH]])
			);

			const refusal = await refusalOf(() => importInto(store, reserved));

			expect(refusal.refusal).toBe('plan-mismatch');
			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('refuses a destination that is not a usable store path', async () => {
			const store = seed();
			const unusable = planWith(
				new Map([['annotations/warehouses.geojson', '../escape' as StorePath]])
			);

			const refusal = await refusalOf(() => importInto(store, unusable));

			expect(refusal.refusal).toBe('plan-mismatch');
			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('refuses a destination that already exists', async () => {
			const store = seed({ ...BEFORE, [`images/${FRESH_IMAGE}/info.json`]: 'the user’s own map' });

			const refusal = await refusalOf(() => importInto(store));

			expect(refusal.refusal).toBe('destination-exists');
			expect(snapshot(store)[`images/${FRESH_IMAGE}/info.json`]).toBe('the user’s own map');
		});

		it('refuses a destination that a case-insensitive filesystem would overwrite', async () => {
			const store = seed({
				...BEFORE,
				[`images/${FRESH_IMAGE.toUpperCase()}/info.json`]: 'theirs'
			});

			const refusal = await refusalOf(() => importInto(store));

			expect(refusal.refusal).toBe('destination-exists');
			expect(snapshot(store)).toEqual({
				...BEFORE,
				[`images/${FRESH_IMAGE.toUpperCase()}/info.json`]: 'theirs'
			});
		});

		it('refuses a destination that a composition-folding filesystem would overwrite', async () => {
			// The plan asks for the composed spelling; the Workspace holds the decomposed one, which is
			// what APFS hands back for either. Two distinct strings, one file.
			const composed = `${DIRECTORY}/annotations/wärehouses.geojson`.normalize('NFC');
			const stored = composed.normalize('NFD');
			expect(stored).not.toBe(composed);
			const store = seed({ ...BEFORE, [stored]: 'the user’s own Annotations' });

			const refusal = await refusalOf(() =>
				importInto(
					store,
					planWith(new Map([['annotations/warehouses.geojson', composed as StorePath]]))
				)
			);

			expect(refusal.refusal).toBe('destination-exists');
			expect(snapshot(store)).toEqual({ ...BEFORE, [stored]: 'the user’s own Annotations' });
		});

		it('refuses while another transaction is unresolved, and keeps its path inventory', async () => {
			const planted: ImportTransaction = { ...COMMITTED, state: 'writing', transaction: 'tx-0' };
			const store = seed();
			store.plant(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(planted));

			const refusal = await refusalOf(() => importInto(store));

			expect(refusal.refusal).toBe('import-in-progress');
			expect(await readImportTransaction(store)).toEqual(planted);
		});

		it('refuses on quota, needing one closure and the marker rather than a second copy', async () => {
			const store = seed();
			const required = CLOSURE_BYTES + 2 * MARKER_BYTES;

			const refusal = await refusalOf(() =>
				importInto(store, DESTINATIONS, {
					...OPTIONS,
					estimateStorage: async () => ({ quota: 1_000_000, usage: 1_000_000 - required + 1 })
				})
			);

			expect(refusal.refusal).toBe('insufficient-quota');
			expect(refusal.requiredBytes).toBe(required);
			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('proceeds on exactly one closure plus the marker twice over', async () => {
			const store = seed();
			const required = CLOSURE_BYTES + 2 * MARKER_BYTES;

			await importInto(store, DESTINATIONS, {
				...OPTIONS,
				estimateStorage: async () => ({ quota: 1_000_000, usage: 1_000_000 - required })
			});

			expect(snapshot(store)).toEqual(AFTER);
		});

		it('goes ahead when the browser will not say how much room there is', async () => {
			const store = seed();

			await importInto(store, DESTINATIONS, {
				...OPTIONS,
				estimateStorage: async () => null
			});

			expect(snapshot(store)).toEqual(AFTER);
		});
	});

	describe('while the transaction is unresolved', () => {
		it('names the transaction, its state, its manifest, and every provisional path', async () => {
			const store = seed();
			const seen: (ImportTransactionMark | null)[] = [];

			await commitProjectImport(
				store,
				source(async () => {
					seen.push(await readImportTransaction(store));
				}),
				DESTINATIONS,
				OPTIONS
			);

			expect(seen).toHaveLength(Object.keys(CLOSURE).length);
			for (const mark of seen) {
				expect(mark).toEqual({ ...COMMITTED, state: 'writing' });
			}
		});

		it('has not written the imported project.json while any of its files are still to come', async () => {
			const store = seed();
			const held: boolean[] = [];

			await commitProjectImport(
				store,
				source(async () => {
					held.push(store.snapshot().has(MANIFEST_DESTINATION));
				}),
				DESTINATIONS,
				OPTIONS
			);

			// A Workspace's list of Projects *is* whichever directories hold a `project.json`
			// (ADR-0008), and this source hands the manifest over first — so an engine writing files
			// as they arrive would have one on disk from the first observation onwards.
			expect(held).toEqual(held.map(() => false));
			expect(store.snapshot().has(MANIFEST_DESTINATION)).toBe(true);
		});

		it('leaves nothing for a reader to find once it has committed', async () => {
			const store = seed();

			await importInto(store);

			expect(await readImportTransaction(store)).toBeNull();
		});
	});

	describe('a successful Import', () => {
		it('adds the complete closure and nothing else', async () => {
			const store = seed();

			const imported = await importInto(store);

			expect(snapshot(store)).toEqual(AFTER);
			expect(imported).toEqual({
				transaction: TRANSACTION,
				files: Object.keys(CLOSURE).length,
				bytes: CLOSURE_BYTES
			});
		});

		it('carries the incoming Alignment over verbatim, at its fresh identity', async () => {
			const store = seed();

			await importInto(store);

			expect(decode(await store.read(alignmentPath(FRESH_IMAGE)))).toBe(
				CLOSURE['alignments/amsterdam-1625.json']
			);
		});
	});

	describe('fault injection at every durable boundary', () => {
		// Every logical write the protocol makes: the marker, the closure's non-manifest files, the
		// manifest, and the marker again as committed.
		//
		// **The matrix is also where "every path is written once" is proved.** A fault armed at write
		// *n* that never fires would let the Import succeed and fail its own `rejects`, so the cases
		// below establish that all `WRITES` writes happen; the case after them arms write `WRITES + 1`
		// and succeeds, establishing that none does. One write per closure path and two for the
		// marker — no second copy of anything, which is what the one-copy protocol claims.
		const WRITES = Object.keys(CLOSURE).length + 2;

		for (let nth = 1; nth <= WRITES; nth += 1) {
			for (const step of ['bytes', 'rename'] as const) {
				it(`leaves the Workspace exactly as it was when write ${nth} fails at ${step}`, async () => {
					const store = seed();
					store.failWriteAt(nth, step);

					await expect(importInto(store)).rejects.toThrow();

					expect(snapshot(store)).toEqual(BEFORE);
					expect(await readImportTransaction(store)).toBeNull();
				});
			}
		}

		it('is the complete after state once the last write has landed', async () => {
			const store = seed();
			store.failWriteAt(WRITES + 1, 'rename');

			await importInto(store);

			expect(snapshot(store)).toEqual(AFTER);
		});

		it('refuses a source that stops short, and takes back what it had written', async () => {
			const store = seed();
			const truncated = createProjectImportSource({
				origin: { kind: 'project-bundle', fileName: '', projectName: 'Amsterdam 1625' },
				project: parseProjectFile(encode(PROJECT_JSON)),
				projectFileBytes: encode(PROJECT_JSON),
				offered: Object.entries(CLOSURE).map(([path, content]) => ({
					path,
					bytes: encode(content).byteLength
				})),
				files: async function* (): AsyncIterable<ClosureFile> {
					yield {
						path: 'annotations/warehouses.geojson',
						bytes: encode(CLOSURE['annotations/warehouses.geojson'] as string)
					};
				}
			});

			await expect(commitProjectImport(store, truncated, DESTINATIONS, OPTIONS)).rejects.toThrow(
				/Nothing has been added to your Workspace/
			);

			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('never rolls back a committed closure, even when the marker will not clear', async () => {
			const store = seed();
			store.failNextDelete();

			const refusal = await refusalOf(() => importInto(store));

			expect(refusal.refusal).toBe('unresolved-commit');
			// The Project is complete and the Workspace is shut, which is what recovery finishes.
			expect(snapshot(store)).toEqual({
				...AFTER,
				[IMPORT_TRANSACTION_PATH]: decode(serialiseImportTransaction(COMMITTED))
			});
			expect(await readImportTransaction(store)).toEqual(COMMITTED);
		});

		it('keeps the Workspace unavailable when the residue cannot be removed', async () => {
			const store = seed();
			const failing = source((path) => {
				if (path === LAST_DELIVERED) store.becomeUnreachable();
			});

			const refusal = await refusalOf(() =>
				commitProjectImport(store, failing, DESTINATIONS, OPTIONS)
			);

			expect(refusal.refusal).toBe('unresolved-residue');
			// The bytes that did land are still named by a marker, so the Workspace does not open and
			// nothing enumerates them. That is what makes the residue recoverable rather than orphaned.
			expect(await readImportTransaction(store)).toEqual({ state: 'unreadable' });
			expect(Object.keys(snapshot(store))).toContain(IMPORT_TRANSACTION_PATH);
		});
	});

	describe('the operations a rerun after a reload depends on', () => {
		it('discards only the paths the marker names, and leaves the rest of the Workspace', async () => {
			const partial = seed({
				...BEFORE,
				[MANIFEST_DESTINATION]: PROJECT_JSON,
				[`images/${FRESH_IMAGE}/info.json`]: CLOSURE['images/amsterdam-1625/info.json'] as string
			});
			partial.plant(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(COMMITTED));

			await discardImportTransaction(partial, COMMITTED);

			expect(snapshot(partial)).toEqual(BEFORE);
		});

		it('discards the same way however many times it is run', async () => {
			const partial = seed({ ...BEFORE, [MANIFEST_DESTINATION]: PROJECT_JSON });
			partial.plant(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(COMMITTED));

			await discardImportTransaction(partial, COMMITTED);
			await discardImportTransaction(partial, COMMITTED);

			expect(snapshot(partial)).toEqual(BEFORE);
		});

		it('clears a resolved marker idempotently', async () => {
			const store = seed();
			store.plant(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(COMMITTED));

			await clearImportTransaction(store);
			await clearImportTransaction(store);

			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('reports a marker it cannot read as present rather than as absent', async () => {
			const store = seed();
			store.plant(IMPORT_TRANSACTION_PATH, encode('half a jso'));

			expect(await readImportTransaction(store)).toEqual({ state: 'unreadable' });
		});
	});
});
