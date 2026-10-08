import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX, type Bytes, type StorePath } from '../store/project-store.js';
import { decode, encode, rejection } from '../test-support.js';
import type { ClosurePath } from './project-import-source.js';
import {
	IMPORT_TRANSACTION_FORMAT_VERSION,
	IMPORT_TRANSACTION_PATH,
	ImportRecoveryFailedError,
	ImportRefusedError,
	clearImportTransaction,
	commitProjectImport,
	discardImportTransaction,
	readImportTransaction,
	recoverProjectImport,
	serialiseImportTransaction,
	type ImportRecovery,
	type ImportTransaction
} from './project-import-transaction.js';
import { closureSource, contents, planted, projectJson } from './test-fixtures.js';

const TRANSACTION = 'tx-1';
const STARTED_AT = '2026-08-22T10:00:00.000Z';
const PROJECT_JSON = projectJson();

const CLOSURE: Record<ClosurePath, string> = {
	[PROJECT_FILE_NAME]: PROJECT_JSON,
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0/0/0.jpg': 'not really a jpeg, but bytes',
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}'
};

const DIRECTORY = 'amsterdam-1625-2';
const FRESH_IMAGE = 'img-fresh';
const FRESH_INFO = `images/${FRESH_IMAGE}/info.json`;

const DESTINATIONS: ReadonlyMap<ClosurePath, StorePath> = new Map([
	[PROJECT_FILE_NAME, `${DIRECTORY}/${PROJECT_FILE_NAME}` as StorePath],
	['annotations/warehouses.geojson', `${DIRECTORY}/annotations/warehouses.geojson` as StorePath],
	['images/amsterdam-1625/info.json', FRESH_INFO as StorePath],
	['images/amsterdam-1625/0/0/0.jpg', `images/${FRESH_IMAGE}/0/0/0.jpg` as StorePath],
	['alignments/amsterdam-1625.json', alignmentPath(FRESH_IMAGE) as StorePath]
]);

const MANIFEST_DESTINATION = DESTINATIONS.get(PROJECT_FILE_NAME) as StorePath;

const BEFORE: Record<string, string> = {
	'the-canal-ring/project.json': '{"formatVersion":1,"name":"The Canal Ring","layers":[]}',
	'the-canal-ring/annotations/canals.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
	'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
};

const AFTER: Record<string, string> = {
	...BEFORE,
	...Object.fromEntries(
		[...DESTINATIONS].map(([closure, destination]) => [destination, CLOSURE[closure] as string])
	)
};

const STREAM_ORDER: readonly ClosurePath[] = [
	PROJECT_FILE_NAME,
	...Object.keys(CLOSURE)
		.filter((path) => path !== PROJECT_FILE_NAME)
		.sort()
];

const LAST_DELIVERED = STREAM_ORDER[STREAM_ORDER.length - 1] as ClosurePath;

const CLOSURE_BYTES = Object.values(CLOSURE).reduce(
	(sum, content) => sum + encode(content).byteLength,
	0
);

const COMMITTED: ImportTransaction = {
	formatVersion: IMPORT_TRANSACTION_FORMAT_VERSION,
	transaction: TRANSACTION,
	state: 'committed',
	project: MANIFEST_DESTINATION,
	paths: [...DESTINATIONS.values()].sort(),
	startedAt: STARTED_AT
};

const WRITING: ImportTransaction = { ...COMMITTED, state: 'writing' };
const MARKER_BYTES = serialiseImportTransaction(COMMITTED).byteLength;
const marker = (mark: ImportTransaction) => decode(serialiseImportTransaction(mark));

const OPTIONS = {
	transaction: () => TRANSACTION,
	now: () => new Date(STARTED_AT)
};

const at = (closure: string, destination: string): Map<ClosurePath, StorePath> =>
	new Map([...DESTINATIONS, [closure as ClosurePath, destination as StorePath]]);

const WRITES = Object.keys(CLOSURE).length + 2;
const seed = (files: Record<string, string> = BEFORE): MemoryProjectStore => planted(files);

const source = (between?: (path: ClosurePath) => void | Promise<void>) =>
	closureSource(CLOSURE, { order: STREAM_ORDER, between });

const importInto = (
	store: MemoryProjectStore,
	plan: ReadonlyMap<ClosurePath, StorePath> = DESTINATIONS,
	options: Parameters<typeof commitProjectImport>[3] = OPTIONS,
	from = source()
) => commitProjectImport(store, from, plan, options);

const refusalOf = (run: () => Promise<unknown>) => rejection(ImportRefusedError, run);

describe('committing a Project Import', () => {
	describe('preflight, before any byte of the closure is written', () => {
		const partial = new Map(DESTINATIONS);
		partial.delete('images/amsterdam-1625/info.json');
		const folded = at('images/amsterdam-1625/info.json', `images/${FRESH_IMAGE}/Info.json`);
		folded.set('images/amsterdam-1625/0/0/0.jpg', `images/${FRESH_IMAGE}/INFO.json` as StorePath);

		it.each([
			['does not name every closure path', partial],
			[
				'names a path the closure lacks',
				at('images/somebody-else/info.json', 'images/x/info.json')
			],
			[
				'plans two paths onto one destination',
				at('images/amsterdam-1625/info.json', `images/${FRESH_IMAGE}/0/0/0.jpg`)
			],
			['plans destinations a case-folding filesystem would merge', folded],
			[
				'names the reserved transaction marker',
				at('annotations/warehouses.geojson', IMPORT_TRANSACTION_PATH)
			],
			[
				'names a path that is not a usable store path',
				at('annotations/warehouses.geojson', '../escape')
			]
		])('refuses a plan that %s, and writes nothing', async (_, plan) => {
			const store = seed();
			expect((await refusalOf(() => importInto(store, plan))).refusal).toBe('plan-mismatch');
			expect(contents(store)).toEqual(BEFORE);
		});

		const composed = `${DIRECTORY}/annotations/wärehouses.geojson`.normalize('NFC');
		const decomposed = composed.normalize('NFD');
		it.each([
			['already exists', FRESH_INFO, DESTINATIONS],
			['a case-insensitive filesystem would overwrite', FRESH_INFO.toUpperCase(), DESTINATIONS],
			[
				'a composition-folding filesystem would overwrite',
				decomposed,
				at('annotations/warehouses.geojson', composed)
			]
		])('refuses a destination that %s', async (_, existing, plan) => {
			expect(decomposed).not.toBe(composed);
			const before = { ...BEFORE, [existing]: 'the user’s own' };
			const store = seed(before);
			expect((await refusalOf(() => importInto(store, plan))).refusal).toBe('destination-exists');
			expect(contents(store)).toEqual(before);
		});

		it('refuses while another transaction is unresolved, and keeps its path inventory', async () => {
			const unresolved: ImportTransaction = { ...WRITING, transaction: 'tx-0' };
			const store = seed();
			store.plant(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(unresolved));

			expect((await refusalOf(() => importInto(store))).refusal).toBe('import-in-progress');
			expect(await readImportTransaction(store)).toEqual(unresolved);
		});

		const required = CLOSURE_BYTES + 2 * MARKER_BYTES;
		const room = (spare: number) => async () => ({ quota: 1_000_000, usage: 1_000_000 - spare });

		it('refuses on quota, needing one closure and the marker rather than a second copy', async () => {
			const store = seed();
			const refusal = await refusalOf(() =>
				importInto(store, DESTINATIONS, { ...OPTIONS, estimateStorage: room(required - 1) })
			);

			expect(refusal.refusal).toBe('insufficient-quota');
			expect(refusal.requiredBytes).toBe(required);
			expect(contents(store)).toEqual(BEFORE);
		});

		it.each([
			['exactly one closure plus the marker twice over', room(required)],
			['the browser not saying how much room there is', async () => null]
		])('proceeds on %s', async (_, estimateStorage) => {
			const store = seed();
			await importInto(store, DESTINATIONS, { ...OPTIONS, estimateStorage });
			expect(contents(store)).toEqual(AFTER);
		});
	});

	it('marks the transaction while unresolved, writes the manifest last, and adds exactly the closure', async () => {
		const store = seed();
		const seen: unknown[] = [];
		const held: boolean[] = [];

		const imported = await importInto(
			store,
			DESTINATIONS,
			OPTIONS,
			source(async () => {
				seen.push(await readImportTransaction(store));
				held.push(store.snapshot().has(MANIFEST_DESTINATION));
			})
		);

		expect(seen).toEqual(Object.keys(CLOSURE).map(() => WRITING));
		expect(held).toEqual(held.map(() => false));
		expect(contents(store)).toEqual(AFTER);
		expect(await readImportTransaction(store)).toBeNull();
		expect(imported).toEqual({
			transaction: TRANSACTION,
			files: Object.keys(CLOSURE).length,
			bytes: CLOSURE_BYTES
		});
	});

	describe('fault injection at every durable boundary', () => {
		it.each(
			Array.from({ length: WRITES }, (_, i) =>
				(['bytes', 'rename'] as const).map((step) => [i + 1, step] as const)
			).flat()
		)('leaves the Workspace exactly as it was when write %i fails at %s', async (nth, step) => {
			const store = seed();
			store.failWriteAt(nth, step);

			await expect(importInto(store)).rejects.toThrow();

			expect(contents(store)).toEqual(BEFORE);
			expect(await readImportTransaction(store)).toBeNull();
		});

		it('is the complete after state once the last write has landed', async () => {
			const store = seed();
			store.failWriteAt(WRITES + 1, 'rename');
			await importInto(store);
			expect(contents(store)).toEqual(AFTER);
		});

		it('refuses a source that stops short, and takes back what it had written', async () => {
			const store = seed();
			const truncated = closureSource(CLOSURE, { order: ['annotations/warehouses.geojson'] });

			await expect(importInto(store, DESTINATIONS, OPTIONS, truncated)).rejects.toThrow(
				/Nothing has been added to your Workspace/
			);
			expect(contents(store)).toEqual(BEFORE);
		});

		it('never rolls back a committed closure, even when the marker will not clear', async () => {
			const store = seed();
			store.failNextDelete();

			expect((await refusalOf(() => importInto(store))).refusal).toBe('unresolved-commit');
			expect(contents(store)).toEqual({ ...AFTER, [IMPORT_TRANSACTION_PATH]: marker(COMMITTED) });
			expect(await readImportTransaction(store)).toEqual(COMMITTED);
		});

		it('keeps the Workspace unavailable when the residue cannot be removed', async () => {
			const store = seed();
			const failing = source((path) => {
				if (path === LAST_DELIVERED) store.becomeUnreachable();
			});

			const refusal = await refusalOf(() => importInto(store, DESTINATIONS, OPTIONS, failing));
			expect(refusal.refusal).toBe('unresolved-residue');
			expect(await readImportTransaction(store)).toEqual({ state: 'unreadable' });
			expect(Object.keys(contents(store))).toContain(IMPORT_TRANSACTION_PATH);
		});
	});

	describe('the operations a rerun after a reload depends on', () => {
		it('discards only the paths the marker names, however many times it is run', async () => {
			const partial = seed({
				...BEFORE,
				[MANIFEST_DESTINATION]: PROJECT_JSON,
				[FRESH_INFO]: CLOSURE['images/amsterdam-1625/info.json'] as string
			});
			partial.plant(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(COMMITTED));

			await discardImportTransaction(partial, COMMITTED);
			expect(contents(partial)).toEqual(BEFORE);
			await discardImportTransaction(partial, COMMITTED);
			expect(contents(partial)).toEqual(BEFORE);
		});

		it('clears a resolved marker idempotently', async () => {
			const store = seed();
			store.plant(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(COMMITTED));

			await clearImportTransaction(store);
			await clearImportTransaction(store);

			expect(contents(store)).toEqual(BEFORE);
		});

		it('reports a marker it cannot read as present rather than as absent', async () => {
			const store = seed();
			store.plant(IMPORT_TRANSACTION_PATH, encode('half a jso'));
			expect(await readImportTransaction(store)).toEqual({ state: 'unreadable' });
		});
	});
});

class CrashingStore extends MemoryProjectStore {
	#landed = { bytes: 0, rename: 0 };
	#crash: { readonly after: number; readonly step: 'bytes' | 'rename' } | undefined;

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

class UnmeasurableStore extends MemoryProjectStore {
	protected override async byteLength(): Promise<number> {
		throw new Error('the folder was unmounted');
	}
}

const restart = (crashed: MemoryProjectStore): MemoryProjectStore => {
	const restarted = new MemoryProjectStore();
	for (const [path, bytes] of crashed.snapshot()) restarted.plant(path, bytes);
	return restarted;
};

const failureOf = (run: () => Promise<unknown>) => rejection(ImportRecoveryFailedError, run);

const crashedAfter = async (
	landed: number,
	step: 'bytes' | 'rename'
): Promise<MemoryProjectStore> => {
	const store = planted(BEFORE, new CrashingStore());
	store.crashAfter(landed, step);
	await expect(importInto(store)).rejects.toThrow();
	return restart(store);
};

describe('recovering an interrupted Project Import', () => {
	it('leaves a Workspace with nothing outstanding exactly as it is, before and after an Import', async () => {
		const store = planted(BEFORE);
		expect(await recoverProjectImport(store)).toEqual<ImportRecovery>({ outcome: 'nothing' });
		expect(contents(store)).toEqual(BEFORE);

		await importInto(store);

		expect(await recoverProjectImport(store)).toEqual<ImportRecovery>({ outcome: 'nothing' });
		expect(contents(store)).toEqual(AFTER);
	});

	describe('restart at every durable boundary', () => {
		const crashes = Array.from({ length: WRITES }, (_, i) => i + 1).flatMap((landed) => {
			const settles = landed === WRITES ? 'the complete Import' : 'the Workspace as it was';
			const durable = [settles, `with ${landed} writes durable`, landed, 'rename'] as const;
			if (landed === WRITES) return [durable];
			return [durable, [settles, `inside write ${landed + 1}`, landed + 1, 'bytes'] as const];
		});

		it.each(crashes)('settles to %s when the tab dies %s', async (settles, _, landed, step) => {
			const restarted = await crashedAfter(landed, step);
			expect(await readImportTransaction(restarted)).not.toBeNull();

			await recoverProjectImport(restarted);

			expect(contents(restarted)).toEqual(settles === 'the complete Import' ? AFTER : BEFORE);
			expect(await readImportTransaction(restarted)).toBeNull();
		});

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
			const restarted = await crashedAfter(1, 'bytes');
			expect(await recoverProjectImport(restarted)).toEqual<ImportRecovery>({ outcome: 'nothing' });
			expect(await restarted.list('')).toEqual(Object.keys(BEFORE).sort());
		});
	});

	const provisional = {
		...BEFORE,
		[MANIFEST_DESTINATION]: PROJECT_JSON,
		[FRESH_INFO]: CLOSURE['images/amsterdam-1625/info.json'] as string,
		[IMPORT_TRANSACTION_PATH]: marker(WRITING)
	};
	const committed = { ...AFTER, [IMPORT_TRANSACTION_PATH]: marker(COMMITTED) };

	describe('an uncommitted transaction', () => {
		it('removes only the paths its marker names, however many times it runs', async () => {
			const tile = { 'images/blaeu-1649/0/0/0.jpg': 'the user’s own tile' };
			const store = planted({ ...provisional, ...tile });

			await recoverProjectImport(store);
			expect(contents(store)).toEqual({ ...BEFORE, ...tile });
			await recoverProjectImport(store);
			expect(contents(store)).toEqual({ ...BEFORE, ...tile });
		});

		it('reclaims the abandoned write a crash left beside a provisional path', async () => {
			const store = planted(provisional);
			store.plant(`images/${FRESH_IMAGE}/.info.json.abandoned${TEMP_PATH_SUFFIX}`, encode('half'));

			await recoverProjectImport(store);

			expect(contents(store)).toEqual(BEFORE);
		});

		it('never leaves the imported manifest behind a path it could not clean', async () => {
			const store = planted(provisional, new StoppingStore());
			store.stopAfterDeletions(1);

			await failureOf(() => recoverProjectImport(store));

			const rest = { ...provisional };
			delete rest[MANIFEST_DESTINATION];
			expect(contents(store)).toEqual(rest);
		});
	});

	describe('a committed transaction', () => {
		it('finishes the bookkeeping and keeps every imported file, however many times it runs', async () => {
			const store = planted(committed);

			expect(await recoverProjectImport(store)).toEqual<ImportRecovery>({
				outcome: 'completed',
				transaction: TRANSACTION
			});
			expect(contents(store)).toEqual(AFTER);
			await recoverProjectImport(store);
			expect(contents(store)).toEqual(AFTER);
		});

		it('refuses to open a Workspace whose committed closure is not all there', async () => {
			const incomplete = { ...committed };
			delete incomplete[`images/${FRESH_IMAGE}/0/0/0.jpg`];
			const store = planted(incomplete);

			expect((await failureOf(() => recoverProjectImport(store))).failure).toBe('incomplete');
			expect(await readImportTransaction(store)).toEqual(COMMITTED);
			expect(contents(store)).toEqual(incomplete);
		});

		it('refuses when a committed closure cannot be verified', async () => {
			const store = planted(committed, new UnmeasurableStore());

			expect((await failureOf(() => recoverProjectImport(store))).failure).toBe('unverifiable');
			expect(await readImportTransaction(store)).toEqual(COMMITTED);
		});
	});

	it.each([
		['a listed path of an uncommitted', provisional, WRITING, BEFORE],
		['the marker of a committed', committed, COMMITTED, AFTER]
	])(
		'keeps the Workspace unavailable when %s transaction will not go, and retries next time',
		async (_, files, mark, settled) => {
			const store = planted(files);
			store.failNextDelete();

			expect((await failureOf(() => recoverProjectImport(store))).failure).toBe('residue');
			expect(await readImportTransaction(store)).toEqual(mark);

			await recoverProjectImport(store);

			expect(contents(store)).toEqual(settled);
		}
	);

	describe('a Workspace it cannot make a decision about', () => {
		it('refuses a marker it cannot read rather than guessing, in the words of the person who asked', async () => {
			const store = planted(BEFORE);
			store.plant(IMPORT_TRANSACTION_PATH, encode('half a jso'));

			const failure = await failureOf(() => recoverProjectImport(store));
			expect(failure.failure).toBe('unreadable');
			expect(contents(store)).toEqual({ ...BEFORE, [IMPORT_TRANSACTION_PATH]: 'half a jso' });
			expect(failure.message).not.toMatch(/import\.json|amsterdam-1625-2|tx-1/);
			expect(failure.message).toMatch(/Import/);
		});

		it('refuses when the backing will not answer at all', async () => {
			const failure = await failureOf(() => recoverProjectImport(MemoryProjectStore.unreachable()));
			expect(failure.failure).toBe('unreadable');
		});

		it.each([
			['a marker from a build it has never heard of', { ...WRITING, formatVersion: 99 }, BEFORE],
			[
				'a Project directory the marker does not name',
				{ ...WRITING, project: 'nowhere/project.json' as StorePath, paths: [] },
				{ ...BEFORE, [MANIFEST_DESTINATION]: PROJECT_JSON }
			]
		])('settles %s by its inventory alone', async (_, mark, settled) => {
			const store = planted({
				...BEFORE,
				[MANIFEST_DESTINATION]: PROJECT_JSON,
				[IMPORT_TRANSACTION_PATH]: marker(mark)
			});

			await recoverProjectImport(store);

			expect(contents(store)).toEqual(settled);
		});
	});
});
