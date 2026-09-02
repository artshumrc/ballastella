// Recovering a Project Import that was interrupted (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE FAULTS ARE CRASHES AND NOT FAILED WRITES
//
// `project-import-transaction.test.ts`'s fault matrix arms a write to fail and then asserts what the
// *engine's own rollback* leaves. Everything here is the other case: the tab died, the laptop
// closed, the folder was unmounted — so no rollback ran, no temporary file was tidied, and the only
// thing left is what had reached the disk. {@link CrashingStore} models that by taking the backing
// away *after* a step succeeds, and {@link restart} models the next visit by planting exactly those
// durable bytes into a fresh store. A crash is therefore reproduced as a state rather than described
// in a comment.
//
// **The assertions are whole store snapshots**, for the reason the fault matrix gives: the claim is
// that after a restart the Workspace is the complete pre-Import state or the complete post-Import
// one, which is a claim about the files. Temporary files are included in every snapshot, because a
// sweep that did not happen is invisible through `list` by construction.
//
// **One engine, at the memory seam, for both real backings.** Recovery reads and deletes through
// `ProjectStore` and sweeps through `reclaimAbandonedWrites`, all of which OPFS and the chosen folder
// are already held to by the shared adapter suite (`project-store-suite.ts`) — including the
// half-finished write a crashed tab leaves and Chromium's `.crswap` beside it. A per-backing copy of
// this matrix would prove each backing self-consistent rather than proving the two agree, and that
// they agree once the applications are wired to them is `editor-transfer.e2e.ts` and
// `editor-folder-workspace.e2e.ts`'s subject.

import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { PROJECT_FILE_NAME, parseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX, type Bytes, type StorePath } from '../store/project-store.js';
import {
	createProjectImportSource,
	type ClosureFile,
	type ClosurePath
} from './project-import-source.js';
import {
	ImportRecoveryFailedError,
	recoverProjectImport,
	type ImportRecovery
} from './project-import-recovery.js';
import {
	IMPORT_TRANSACTION_FORMAT_VERSION,
	IMPORT_TRANSACTION_PATH,
	commitProjectImport,
	readImportTransaction,
	serialiseImportTransaction,
	type ImportTransaction
} from './project-import-transaction.js';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const decode = (bytes: Bytes): string => new TextDecoder().decode(bytes);

const TRANSACTION = 'tx-1';
const STARTED_AT = '2026-08-22T10:00:00.000Z';

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

/** Every closure path the source holds, Project-relative, with the bytes it hands over. */
const CLOSURE: Record<ClosurePath, string> = {
	[PROJECT_FILE_NAME]: PROJECT_JSON,
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0/0/0.jpg': 'not really a jpeg, but bytes',
	// alignment-write-is-the-fixture: the Alignment as the source Workspace holds it, carried over verbatim
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

/** The Workspace the user already has, which a swept transaction has to leave exactly as it is. */
const BEFORE: Record<string, string> = {
	'the-canal-ring/project.json': '{"formatVersion":1,"name":"The Canal Ring","layers":[]}',
	'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
	// alignment-write-is-the-fixture: the user's own Alignment, seeded so a sweep that touched it would be visible
	'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
};

/** The Workspace once the whole closure has arrived at its planned paths. */
const AFTER: Record<string, string> = {
	...BEFORE,
	...Object.fromEntries(
		[...DESTINATIONS].map(([closure, destination]) => [destination, CLOSURE[closure] as string])
	)
};

const COMMITTED: ImportTransaction = {
	formatVersion: IMPORT_TRANSACTION_FORMAT_VERSION,
	transaction: TRANSACTION,
	state: 'committed',
	project: MANIFEST_DESTINATION,
	paths: [...DESTINATIONS.values()].sort(),
	startedAt: STARTED_AT
};

const WRITING: ImportTransaction = { ...COMMITTED, state: 'writing' };

const OPTIONS = { transaction: () => TRANSACTION, now: () => new Date(STARTED_AT) };

/**
 * The order the source hands its files over in, **with the manifest first**.
 *
 * A tar's order is the order its author packed it, so this is a legitimate source and the one that
 * matters: it is the only arrangement under which "the manifest is written last" is a fact about the
 * engine rather than an accident of the closure's sorted paths.
 */
const STREAM_ORDER: readonly ClosurePath[] = [
	PROJECT_FILE_NAME,
	...Object.keys(CLOSURE)
		.filter((path) => path !== PROJECT_FILE_NAME)
		.sort()
];

const source = () => {
	const offered = Object.entries(CLOSURE).map(([path, content]) => ({
		path,
		bytes: encode(content).byteLength
	}));
	return createProjectImportSource({
		origin: {
			kind: 'project-bundle' as const,
			fileName: 'amsterdam-1625.project.tar',
			projectName: 'Amsterdam 1625'
		},
		project: parseProjectFile(encode(PROJECT_JSON)),
		projectFileBytes: encode(PROJECT_JSON),
		offered,
		files: async function* (paths): AsyncIterable<ClosureFile> {
			for (const path of STREAM_ORDER.filter((one) => paths.includes(one))) {
				yield { path, bytes: encode(CLOSURE[path] as string) };
			}
		}
	});
};

/**
 * A store whose backing goes away the moment one step of one write has landed.
 *
 * **Not {@link MemoryProjectStore.failWriteAt}**, which fails a write and lets everything after it
 * run — so the engine's rollback tidies up and there is nothing left to recover. A crash is the
 * opposite: the step succeeded, and then nothing else ever happened. Counting steps rather than
 * paths keeps the fault a position in the sequence the store sees, which is what makes the matrix
 * exhaustive without knowing how the engine is built.
 */
class CrashingStore extends MemoryProjectStore {
	#landed = { bytes: 0, rename: 0 };
	#crash: { readonly after: number; readonly step: 'bytes' | 'rename' } | undefined;

	/** Take the backing away once `after` writes have completed `step`. */
	crashAfter(after: number, step: 'bytes' | 'rename'): void {
		this.#crash = { after, step };
	}

	protected override async writeBytes(path: StorePath, bytes: Bytes): Promise<void> {
		await super.writeBytes(path, bytes);
		this.#count('bytes');
	}

	protected override async renameTempFile(from: StorePath, to: StorePath): Promise<void> {
		await super.renameTempFile(from, to);
		this.#count('rename');
	}

	#count(step: 'bytes' | 'rename'): void {
		this.#landed[step] += 1;
		const crash = this.#crash;
		if (crash !== undefined && crash.step === step && this.#landed[step] === crash.after) {
			this.becomeUnreachable(new Error('the tab was closed'));
		}
	}
}

/**
 * A store whose backing goes away once `after` deletions have landed.
 *
 * The sweep's own crash, which no public API can produce: {@link MemoryProjectStore.failNextDelete}
 * fails a deletion, and what has to be observed here is a deletion that *succeeded* and then nothing
 * further ever happening.
 */
class StoppingStore extends MemoryProjectStore {
	#deletions = 0;
	#stopAfter = Number.POSITIVE_INFINITY;

	stopAfterDeletions(after: number): void {
		this.#stopAfter = after;
	}

	protected override async deletePath(path: StorePath): Promise<void> {
		await super.deletePath(path);
		this.#deletions += 1;
		if (this.#deletions === this.#stopAfter)
			this.becomeUnreachable(new Error('the tab was closed'));
	}
}

/** A store that will not say how big anything is — a folder unmounted mid-verification. */
class UnmeasurableStore extends MemoryProjectStore {
	protected override async byteLength(): Promise<number> {
		throw new Error('the folder was unmounted');
	}
}

const seed = <T extends MemoryProjectStore>(store: T, files: Record<string, string>): T => {
	for (const [path, content] of Object.entries(files))
		store.plant(path as StorePath, encode(content));
	return store;
};

/** Every path the store holds with its contents, temporary files included. */
const snapshot = (store: MemoryProjectStore): Record<string, string> =>
	Object.fromEntries([...store.snapshot()].map(([path, bytes]) => [path, decode(bytes)]));

/**
 * The next visit to a Workspace a crash left behind: the same durable bytes, a live backing.
 *
 * Planting rather than making the crashed store reachable again, because that is what a restart is —
 * nothing survives a dead tab except what reached the disk, temporary files included.
 */
const restart = (crashed: MemoryProjectStore): MemoryProjectStore => {
	const restarted = new MemoryProjectStore();
	for (const [path, bytes] of crashed.snapshot()) restarted.plant(path, bytes);
	return restarted;
};

/** Every logical write the protocol makes: the marker, the closure, and the marker again. */
const WRITES = Object.keys(CLOSURE).length + 2;

const failureOf = async (run: () => Promise<unknown>): Promise<ImportRecoveryFailedError> => {
	try {
		await run();
	} catch (cause) {
		if (cause instanceof ImportRecoveryFailedError) return cause;
		throw cause;
	}
	throw new Error('the recovery did not fail');
};

/** Crash an Import mid-flight and hand back the Workspace the next visit finds. */
const crashedAfter = async (
	landed: number,
	step: 'bytes' | 'rename'
): Promise<MemoryProjectStore> => {
	const store = seed(new CrashingStore(), BEFORE);
	store.crashAfter(landed, step);
	await expect(commitProjectImport(store, source(), DESTINATIONS, OPTIONS)).rejects.toThrow();
	return restart(store);
};

describe('recovering an interrupted Project Import', () => {
	describe('a Workspace with nothing outstanding', () => {
		it('leaves it exactly as it is', async () => {
			const store = seed(new MemoryProjectStore(), BEFORE);

			expect(await recoverProjectImport(store)).toEqual<ImportRecovery>({ outcome: 'nothing' });
			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('reports nothing outstanding after an Import that finished', async () => {
			const store = seed(new MemoryProjectStore(), BEFORE);
			await commitProjectImport(store, source(), DESTINATIONS, OPTIONS);

			expect(await recoverProjectImport(store)).toEqual<ImportRecovery>({ outcome: 'nothing' });
			expect(snapshot(store)).toEqual(AFTER);
		});
	});

	describe('restart at every durable boundary', () => {
		// A crash after write `landed` renamed into place, and a crash after write `landed + 1`'s
		// temporary file landed but before it was renamed — which is the boundary *inside* an atomic
		// write, and the only one that leaves litter a restart has to reclaim.
		for (let landed = 1; landed <= WRITES; landed += 1) {
			const expected = landed === WRITES ? AFTER : BEFORE;
			const settles = landed === WRITES ? 'the complete Import' : 'the Workspace as it was';

			it(`settles to ${settles} when the tab dies with ${landed} writes durable`, async () => {
				const restarted = await crashedAfter(landed, 'rename');

				// The crash left a marker, so the next visit really is gated. Asserted rather than
				// assumed: a fixture that refused in preflight would leave the Workspace as it was and
				// pass every assertion below without the protocol having run at all.
				expect(await readImportTransaction(restarted)).not.toBeNull();

				await recoverProjectImport(restarted);

				expect(snapshot(restarted)).toEqual(expected);
				expect(await readImportTransaction(restarted)).toBeNull();
			});

			if (landed === WRITES) continue;
			it(`settles to ${settles} when the tab dies inside write ${landed + 1}`, async () => {
				const restarted = await crashedAfter(landed + 1, 'bytes');

				expect(await readImportTransaction(restarted)).not.toBeNull();

				await recoverProjectImport(restarted);

				expect(snapshot(restarted)).toEqual(expected);
				expect(await readImportTransaction(restarted)).toBeNull();
			});
		}

		it('reports which transaction it swept, and which it finished', async () => {
			const swept = await crashedAfter(2, 'rename');
			const finished = await crashedAfter(WRITES, 'rename');

			expect(await recoverProjectImport(swept)).toEqual<ImportRecovery>({
				outcome: 'discarded',
				transaction: TRANSACTION
			});
			expect(await recoverProjectImport(finished)).toEqual<ImportRecovery>({
				outcome: 'completed',
				transaction: TRANSACTION
			});
		});

		it('leaves a marker that never landed alone, having no transaction to recover', async () => {
			// The crash is inside the marker's own write, so the only durable trace is a temporary file
			// no reader can see: `list` hides the reserved suffix and `delete` refuses it. There is no
			// inventory, so there is nothing this may act on — the Workspace is the user's own and
			// whole, and the litter belongs to the sweep every adoption already does.
			const restarted = await crashedAfter(1, 'bytes');

			expect(await recoverProjectImport(restarted)).toEqual<ImportRecovery>({ outcome: 'nothing' });
			expect(await restarted.list('')).toEqual(Object.keys(BEFORE).sort());
		});
	});

	describe('an uncommitted transaction', () => {
		const provisional = {
			...BEFORE,
			[MANIFEST_DESTINATION]: PROJECT_JSON,
			[`images/${FRESH_IMAGE}/info.json`]: CLOSURE['images/amsterdam-1625/info.json'] as string,
			[IMPORT_TRANSACTION_PATH]: decode(serialiseImportTransaction(WRITING))
		};

		it('removes only the paths its marker names', async () => {
			// A Map Image of the user's own sits in the same shared pool the Import wrote into
			// (ADR-0023), one directory along, and nothing in a path says which transaction put it
			// there. A sweep by prefix would take it.
			const store = seed(new MemoryProjectStore(), {
				...provisional,
				'images/blaeu-1649/0/0/0.jpg': 'the user’s own tile'
			});

			await recoverProjectImport(store);

			expect(snapshot(store)).toEqual({
				...BEFORE,
				'images/blaeu-1649/0/0/0.jpg': 'the user’s own tile'
			});
		});

		it('reclaims the abandoned write a crash left beside a provisional path', async () => {
			const litter = `images/${FRESH_IMAGE}/.info.json.abandoned${TEMP_PATH_SUFFIX}` as StorePath;
			const store = seed(new MemoryProjectStore(), provisional);
			store.plant(litter, encode('half a file'));

			await recoverProjectImport(store);

			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('recovers the same way however many times it runs', async () => {
			const store = seed(new MemoryProjectStore(), provisional);

			await recoverProjectImport(store);
			await recoverProjectImport(store);

			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('never leaves the imported manifest behind a path it could not clean', async () => {
			// `project.json` is what makes a directory a Project on the hub (ADR-0008), so it goes
			// first: a sweep that stopped half way must not leave a listable Project whose Layers name
			// files that are gone. Stopped after exactly one deletion, whichever it was.
			const store = seed(new StoppingStore(), provisional);
			store.stopAfterDeletions(1);

			await failureOf(() => recoverProjectImport(store));

			expect(snapshot(store)).toEqual({
				...BEFORE,
				[`images/${FRESH_IMAGE}/info.json`]: CLOSURE['images/amsterdam-1625/info.json'] as string,
				[IMPORT_TRANSACTION_PATH]: decode(serialiseImportTransaction(WRITING))
			});
		});

		it('keeps the Workspace unavailable when a listed path will not go, and retries next time', async () => {
			const store = seed(new MemoryProjectStore(), provisional);
			store.failNextDelete();

			const failure = await failureOf(() => recoverProjectImport(store));

			expect(failure.failure).toBe('residue');
			// The marker is the durable evidence, and it is still there — so the Workspace stays shut
			// and the next startup has the same inventory to work from.
			expect(await readImportTransaction(store)).toEqual(WRITING);

			await recoverProjectImport(store);

			expect(snapshot(store)).toEqual(BEFORE);
		});
	});

	describe('a committed transaction', () => {
		const committed = {
			...AFTER,
			[IMPORT_TRANSACTION_PATH]: decode(serialiseImportTransaction(COMMITTED))
		};

		it('finishes the bookkeeping and keeps every imported file', async () => {
			const store = seed(new MemoryProjectStore(), committed);

			expect(await recoverProjectImport(store)).toEqual<ImportRecovery>({
				outcome: 'completed',
				transaction: TRANSACTION
			});
			expect(snapshot(store)).toEqual(AFTER);
		});

		it('finishes the same way however many times it runs', async () => {
			const store = seed(new MemoryProjectStore(), committed);

			await recoverProjectImport(store);
			await recoverProjectImport(store);

			expect(snapshot(store)).toEqual(AFTER);
		});

		it('refuses to open a Workspace whose committed closure is not all there', async () => {
			// Nothing may be rolled back past the commit boundary — the Project is the user's now — so
			// a closure with a hole in it is neither swept nor opened. It is said, and the marker stays.
			const incomplete = { ...committed };
			delete incomplete[`images/${FRESH_IMAGE}/0/0/0.jpg`];
			const store = seed(new MemoryProjectStore(), incomplete);

			const failure = await failureOf(() => recoverProjectImport(store));

			expect(failure.failure).toBe('incomplete');
			expect(await readImportTransaction(store)).toEqual(COMMITTED);
			expect(snapshot(store)).toEqual(incomplete);
		});

		it('keeps the Workspace unavailable when the marker will not clear, and retries next time', async () => {
			const store = seed(new MemoryProjectStore(), committed);
			store.failNextDelete();

			const failure = await failureOf(() => recoverProjectImport(store));

			expect(failure.failure).toBe('residue');
			expect(await readImportTransaction(store)).toEqual(COMMITTED);

			await recoverProjectImport(store);

			expect(snapshot(store)).toEqual(AFTER);
		});
	});

	describe('a Workspace it cannot make a decision about', () => {
		it('refuses a marker it cannot read rather than guessing the Workspace is safe', async () => {
			const store = seed(new MemoryProjectStore(), BEFORE);
			store.plant(IMPORT_TRANSACTION_PATH, encode('half a jso'));

			const failure = await failureOf(() => recoverProjectImport(store));

			expect(failure.failure).toBe('unreadable');
			expect(snapshot(store)).toEqual({ ...BEFORE, [IMPORT_TRANSACTION_PATH]: 'half a jso' });
		});

		it('refuses a marker from a build it has never heard of, keeping its inventory', async () => {
			// Tolerated as a marker, because a version this build cannot interpret is still a
			// transaction: its state and its inventory are what decide what happens to the files.
			const store = seed(new MemoryProjectStore(), {
				...BEFORE,
				[MANIFEST_DESTINATION]: PROJECT_JSON,
				[IMPORT_TRANSACTION_PATH]: decode(
					serialiseImportTransaction({ ...WRITING, formatVersion: 99 })
				)
			});

			await recoverProjectImport(store);

			expect(snapshot(store)).toEqual(BEFORE);
		});

		it('refuses when the backing will not answer at all', async () => {
			const store = MemoryProjectStore.unreachable();

			const failure = await failureOf(() => recoverProjectImport(store));

			expect(failure.failure).toBe('unreadable');
		});

		it('refuses when a committed closure cannot be verified', async () => {
			const store = seed(new UnmeasurableStore(), {
				...AFTER,
				[IMPORT_TRANSACTION_PATH]: decode(serialiseImportTransaction(COMMITTED))
			});

			const failure = await failureOf(() => recoverProjectImport(store));

			expect(failure.failure).toBe('unverifiable');
			// Nothing has been swept and the marker is still there: past the commit boundary there is
			// nothing to roll back, so the next visit asks the same question again.
			expect(await readImportTransaction(store)).toEqual(COMMITTED);
		});

		it('says what happened in the words the person who asked for the Import would use', async () => {
			const store = seed(new MemoryProjectStore(), BEFORE);
			store.plant(IMPORT_TRANSACTION_PATH, encode('half a jso'));

			const failure = await failureOf(() => recoverProjectImport(store));

			// No path, no marker, no transaction id: the sentence is about the Workspace and what to do
			// about it, and staging internals are not the user's to see.
			expect(failure.message).not.toMatch(/import\.json|amsterdam-1625-2|tx-1/);
			expect(failure.message).toMatch(/Import/);
		});
	});

	describe('nothing infers a provisional path from a name', () => {
		it('leaves alone a Project directory the marker does not name', async () => {
			const store = seed(new MemoryProjectStore(), {
				...BEFORE,
				// The same fresh directory the Import was aiming at, but this marker's inventory is
				// empty — so there is nothing here that may be removed, whatever it is called.
				[MANIFEST_DESTINATION]: PROJECT_JSON,
				[IMPORT_TRANSACTION_PATH]: decode(
					serialiseImportTransaction({
						...WRITING,
						project: 'nowhere/project.json' as StorePath,
						paths: []
					})
				)
			});

			await recoverProjectImport(store);

			expect(snapshot(store)).toEqual({ ...BEFORE, [MANIFEST_DESTINATION]: PROJECT_JSON });
		});
	});
});
