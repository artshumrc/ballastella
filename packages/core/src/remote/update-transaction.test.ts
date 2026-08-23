// Seam 1 for Update from GitHub's atomicity: the whole operation interrupted at every durable
// boundary there is, and the Workspace compared with complete snapshots afterwards (SPEC story 141).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ASSERTION IS THE WHOLE WORKSPACE, AND IT HAS TO BE
//
// An Update adds, replaces and removes files across several Projects and a Map Image in one
// operation. Every interesting way for that to go wrong leaves a Workspace that is *plausible* — a
// Project list with one Project missing, a Map Image whose Alignment went and whose pyramid stayed —
// so an assertion aimed at the path the failure names cannot see the failure. What is compared here
// is therefore the complete file set, against exactly two permitted values: the Workspace as it was
// before the Update, or the Workspace the Update meant to leave. Never a third.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A FAULT IS AN ORDINAL, NOT A PLACE
//
// {@link Interrupted} counts every write and every delete the operation performs and kills the
// backing at the *n*th of them, for every *n* the operation has. Nothing in the matrix below names a
// step of the protocol, and that is deliberate: a test that armed "the fault after the before-images"
// would be asserting against this engine's staging layout, and would go quiet the moment the layout
// changed. Counted, the matrix covers the marker, each before-image, each addition, each replacement,
// each deletion, the metadata commit and each step of the cleanup — and keeps covering them.
//
// The restart is real: the dead store's bytes are planted into a fresh one, which is what a reload
// over the same OPFS directory or the same chosen folder is, and {@link recoverWorkspaceUpdate} then
// runs the way the application runs it — before anything enumerates the Workspace.

import { describe, expect, it } from 'vitest';

import { newAnnotationLayer, newMapLayer } from '../project/layer.js';
import { newProjectFile, serialiseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, ProjectStore, StorePath, WritablePath } from '../store/project-store.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import type { RemoteRelationship, SynchronizationBaseline } from './synchronization-metadata.js';
import {
	UPDATE_TRANSACTION_PATH,
	UpdateRefusedError,
	readUpdateTransaction,
	recoverWorkspaceUpdate,
	updateFromGitHub,
	type UpdateDeletionPreview
} from './update-from-github.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE: RemoteRelationship = { owner: OWNER, repository: REPOSITORY, branch: 'main' };

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const projectFile = (
	name: string,
	layers: Parameters<typeof serialiseProjectFile>[0]['layers'] = []
): string =>
	decode(serialiseProjectFile({ ...newProjectFile(name, new Date('2026-01-01')), layers }));

/**
 * The Workspace both sides start from: two Projects, a Map Image with its Alignment.
 *
 * One Project is removed entirely by the Update below, the other is changed and added to — so a
 * Workspace assembled out of both states is distinguishable from either of them.
 */
const BEFORE: Record<string, string> = {
	'amsterdam-1625/project.json': projectFile('Amsterdam 1625', [
		newMapLayer({ id: 'l1', name: 'The sheet', imageId: 'map-1' }),
		newAnnotationLayer({ id: 'l2', name: 'Warehouses' })
	]),
	'amsterdam-1625/annotations/l2.geojson': '{"type":"FeatureCollection","features":[]}',
	'delft/project.json': projectFile('Delft 1650', [
		newAnnotationLayer({ id: 'l3', name: 'Canals' })
	]),
	'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/map-1/info.json': '{"width":1024,"height":768}',
	'images/map-1/0/0/0.jpg': 'tile-zero',
	// alignment-write-is-the-fixture: the Alignment as both sides hold it, seeded rather than written by the code under test
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[]}'
};

/** What another machine did to the Remote: a Project deleted, an Alignment deleted, one file
 * replaced and one added. One operation, four kinds of change. */
const REMOTE_CHANGES: Record<string, string | null> = {
	'amsterdam-1625/project.json': null,
	'amsterdam-1625/annotations/l2.geojson': null,
	// alignment-write-is-the-fixture: a deletion on the *Remote's* tree, which is the input this file is about — no Workspace write
	'alignments/map-1.json': null,
	'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":["their canal"]}',
	'images/map-1/0/0/1.jpg': 'a tile they added'
};

/** The complete Workspace a confirmed Update leaves. The only permitted alternative to {@link BEFORE}. */
const AFTER: Record<string, string> = {
	'delft/project.json': BEFORE['delft/project.json'] as string,
	'delft/annotations/l3.geojson': REMOTE_CHANGES['delft/annotations/l3.geojson'] as string,
	'images/map-1/info.json': BEFORE['images/map-1/info.json'] as string,
	'images/map-1/0/0/0.jpg': BEFORE['images/map-1/0/0/0.jpg'] as string,
	'images/map-1/0/0/1.jpg': REMOTE_CHANGES['images/map-1/0/0/1.jpg'] as string
};

const seed = (files: Record<string, string> = BEFORE): MemoryProjectStore => {
	const store = new MemoryProjectStore();
	for (const [path, text] of Object.entries(files)) store.plant(path as StorePath, encode(text));
	return store;
};

/** Every path in a store with its bytes as text. Temporary files and markers included. */
const snapshot = (store: MemoryProjectStore): Record<string, string> =>
	Object.fromEntries([...store.snapshot()].map(([path, bytes]) => [path, decode(bytes)]));

const shas = async (files: Record<string, string>): Promise<Map<string, string>> => {
	const map = new Map<string, string>();
	for (const [path, text] of Object.entries(files)) map.set(path, await gitBlobSha(encode(text)));
	return map;
};

/** A Baseline recording exactly the Workspace both sides started from. */
const baseline = async (): Promise<SynchronizationBaseline> => ({
	remote: REMOTE,
	commit: 'c0ffee',
	files: await shas(BEFORE)
});

/** The fake, already carrying the Remote's own changes. */
async function remoteWithChanges(): Promise<FakeGitHub> {
	const fake = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: BEFORE });
	await fake.commitFiles(REMOTE_CHANGES);
	return fake;
}

/** The Update the whole file is about: the four changes above, with the deletions confirmed. */
const updateConfirming = (
	store: ProjectStore,
	fake: FakeGitHub,
	base: SynchronizationBaseline,
	confirm: (preview: UpdateDeletionPreview) => boolean = () => true
) =>
	updateFromGitHub(store, {
		remote: REMOTE,
		baseline: base,
		fetch: fake.fetch,
		workspace: 'Atlas',
		confirmDeletion: confirm
	});

/**
 * A store that counts every write and delete and kills the backing at the `at`th of them.
 *
 * ⚠ **Counted at the `ProjectStore` seam, so one logical file is one ordinal** however many
 * temporary files the backend uses underneath. `becomeUnreachable` rather than a single failed write,
 * because the case that matters is the one where the *cleanup* cannot run either: a single failure
 * that the engine catches and rolls back is asserted separately below.
 */
class Interrupted implements ProjectStore {
	#mutations = 0;

	constructor(
		readonly inner: MemoryProjectStore,
		private readonly at: number
	) {}

	/** How many writes and deletes have been attempted. The size of the matrix, after one clean run. */
	get mutations(): number {
		return this.#mutations;
	}

	read(path: StorePath): Promise<Bytes> {
		return this.inner.read(path);
	}
	list(prefix: string): Promise<StorePath[]> {
		return this.inner.list(prefix);
	}
	size(path: StorePath): Promise<number> {
		return this.inner.size(path);
	}
	reclaimAbandonedWrites(prefix: string): Promise<void> {
		return this.inner.reclaimAbandonedWrites(prefix);
	}
	write(path: WritablePath, bytes: Bytes): Promise<void> {
		this.#count();
		return this.inner.write(path, bytes);
	}
	delete(path: StorePath): Promise<void> {
		this.#count();
		return this.inner.delete(path);
	}

	#count(): void {
		this.#mutations += 1;
		if (this.#mutations === this.at) this.inner.becomeUnreachable(new Error('the tab went away'));
	}
}

/** The same bytes in a store that works: a reload over the same OPFS directory or chosen folder. */
const restart = (dead: MemoryProjectStore): MemoryProjectStore => {
	const store = new MemoryProjectStore();
	for (const [path, bytes] of dead.snapshot()) store.plant(path, bytes);
	return store;
};

/** The refusal a run raised, having asserted it raised one at all. */
async function refusal(run: Promise<unknown>): Promise<UpdateRefusedError> {
	const caught = await run.then(
		() => null,
		(cause: unknown) => cause
	);
	if (!(caught instanceof UpdateRefusedError)) {
		throw new Error(`expected an UpdateRefusedError, got ${String(caught)}`);
	}
	return caught;
}

describe('an Update applied as one transaction', () => {
	it('adds, replaces and removes in one operation and leaves no residue', async () => {
		const store = seed();

		const result = await updateConfirming(store, await remoteWithChanges(), await baseline());

		expect(snapshot(store)).toEqual(AFTER);
		expect(result.added).toEqual(['images/map-1/0/0/1.jpg']);
		expect(result.replaced).toEqual(['delft/annotations/l3.geojson']);
		expect(result.removed).toEqual([
			'alignments/map-1.json',
			'amsterdam-1625/annotations/l2.geojson',
			'amsterdam-1625/project.json'
		]);
		expect(await readUpdateTransaction(store)).toBeNull();
	});

	it('advances the Baseline for what is now shared and retires what neither side holds', async () => {
		const store = seed();

		const result = await updateConfirming(store, await remoteWithChanges(), await baseline());

		// Exactly the Workspace the Update left, and nothing about the paths it removed.
		expect([...result.baseline.keys()].sort()).toEqual(Object.keys(AFTER).sort());
		for (const [path, sha] of await shas(AFTER)) expect(result.baseline.get(path)).toBe(sha);
		expect(result.shared).toEqual([...Object.keys(AFTER), ...result.removed].sort());
	});

	it('leaves the Remote exactly where it was', async () => {
		const store = seed();
		const fake = await remoteWithChanges();
		const head = fake.head();

		await updateConfirming(store, fake, await baseline());

		expect(fake.head()).toBe(head);
		expect(fake.files().has('amsterdam-1625/project.json')).toBe(false);
	});
});

describe('fault injection at every durable boundary', () => {
	/**
	 * Every write and delete a clean run performs.
	 *
	 * Read from a run rather than written down, because a hard-coded count is the assertion this
	 * matrix is least able to keep honest: an engine that stopped taking a before-image would still
	 * pass a matrix sized for one that did, and would fail nothing.
	 */
	const boundaries = async (): Promise<number> => {
		const counting = new Interrupted(seed(), Number.MAX_SAFE_INTEGER);
		await updateConfirming(counting, await remoteWithChanges(), await baseline());
		return counting.mutations;
	};

	it('has a boundary at the marker, every before-image, every file, every deletion and the cleanup', async () => {
		// The marker twice, four before-images, two files, three deletions, four images swept and the
		// marker removed. Stated so that a change in the protocol's shape is visible in the diff rather
		// than only in the size of the matrix below.
		expect(await boundaries()).toBe(16);
	});

	for (let nth = 1; nth <= 16; nth += 1) {
		it(`is the complete before or the complete after when the tab dies at boundary ${nth}`, async () => {
			const dead = seed();
			const store = new Interrupted(dead, nth);

			// It may refuse and it may succeed — a backing that died while the *residue* was being swept
			// has already committed everything the caller was promised. What it may never do is either of
			// those over a Workspace that is half of each.
			await updateConfirming(store, await remoteWithChanges(), await baseline()).catch(
				() => undefined
			);

			const restarted = restart(dead);
			await recoverWorkspaceUpdate(restarted);

			expect([BEFORE, AFTER]).toContainEqual(snapshot(restarted));
			expect(await readUpdateTransaction(restarted)).toBeNull();
		});
	}

	it('recovers the same way however many times it is interrupted', async () => {
		const dead = seed();
		// Killed inside the deletions, which is the state with something restored *and* something
		// removed: the one where a second, differently-interrupted recovery could disagree with the first.
		await updateConfirming(
			new Interrupted(dead, 8),
			await remoteWithChanges(),
			await baseline()
		).catch(() => undefined);

		// A recovery that is itself interrupted, then run again, then run again over nothing.
		const halfWay = restart(dead);
		const killed = new Interrupted(halfWay, 1);
		await recoverWorkspaceUpdate(killed).catch(() => undefined);
		const second = restart(halfWay);
		const first = await recoverWorkspaceUpdate(second);
		const again = await recoverWorkspaceUpdate(second);

		expect(first.outcome).toBe('rolled-back');
		expect(again).toEqual({ outcome: 'nothing' });
		expect(snapshot(second)).toEqual(BEFORE);
	});

	it('puts everything back when one write fails and the backing survives', async () => {
		const store = seed();
		// The engine's own rollback rather than a restart: a failure it can act on leaves the Workspace
		// as it was without anybody reloading anything.
		store.failWriteAt(7, 'rename');

		const refused = await refusal(
			updateConfirming(store, await remoteWithChanges(), await baseline())
		);

		expect(refused.refusal).toBe('write-failed');
		expect(snapshot(store)).toEqual(BEFORE);
		expect(await readUpdateTransaction(store)).toBeNull();
	});

	it('keeps the record when the rollback itself cannot finish', async () => {
		const dead = seed();
		const store = new Interrupted(dead, 6);

		const refused = await refusal(
			updateConfirming(store, await remoteWithChanges(), await baseline())
		);

		// The one refusal that does not promise the Workspace is as it was — and the marker is still
		// there, which is the durable evidence the restart above works from.
		expect(refused.refusal).toBe('unresolved-residue');
		expect(Object.keys(snapshot(dead))).toContain(UPDATE_TRANSACTION_PATH);
	});
});

describe('before it will start at all', () => {
	it('refuses for want of room, naming what it needs and what there is, before any mutation', async () => {
		const dead = seed();
		const store = new Interrupted(dead, Number.MAX_SAFE_INTEGER);

		const refused = await refusal(
			updateFromGitHub(store, {
				remote: REMOTE,
				baseline: await baseline(),
				fetch: (await remoteWithChanges()).fetch,
				confirmDeletion: () => true,
				estimateStorage: async () => ({ quota: 1_000_000, usage: 999_950 })
			})
		);

		expect(refused.refusal).toBe('insufficient-quota');
		// Both quantities, because "there is not enough room" is not something a scholar can act on.
		expect(refused.message).toMatch(/needs about \d/);
		expect(refused.message).toMatch(/50 bytes free/);
		expect(refused.message).toContain('each file it replaces or removes');
		// ⚠ **Not one mutation**, so the accounting cannot have been done by trying it: the before-images
		// of the paths being removed are counted in, and those are the ones an optimistic count misses.
		expect(store.mutations).toBe(0);
		expect(snapshot(dead)).toEqual(BEFORE);
	});

	it('will not plan over an unresolved record, so nothing reads a mixed Workspace', async () => {
		const dead = seed();
		await updateConfirming(
			new Interrupted(dead, 6),
			await remoteWithChanges(),
			await baseline()
		).catch(() => undefined);

		// A second Update, without a restart in between: the evidence is unresolved and the backing is
		// gone, so the answer is the refusal that keeps the Workspace shut rather than a second attempt.
		const refused = await refusal(
			updateConfirming(
				new Interrupted(dead, Number.MAX_SAFE_INTEGER),
				await remoteWithChanges(),
				await baseline()
			)
		);

		expect(refused.refusal).toBe('unresolved-transaction');
	});
});
