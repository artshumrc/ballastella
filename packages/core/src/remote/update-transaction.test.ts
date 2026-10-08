import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, ProjectStore, StorePath, WritablePath } from '../store/project-store.js';
import { decode, rejection, seeded } from '../test-support.js';
import type { FakeGitHub } from './fake-github.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import { getFromRemote } from './get-from-remote.js';
import {
	UPDATE_TRANSACTION_PATH,
	UpdateRefusedError,
	readUpdateTransaction,
	recoverWorkspaceUpdate
} from './update-transaction.js';
import { ATLAS, baselineOf, shas } from './remote-test-support.js';
import {
	AFTER,
	BEFORE as SUITE_BEFORE,
	REMOTE_CHANGES as SUITE_CHANGES,
	remoteWithChanges as suiteRemote
} from './update-transaction-suite.js';

const BEFORE: Record<string, string> = {
	...SUITE_BEFORE,
	'alignments/map-1.json': '{"formatVersion":1,"controlPoints":[]}'
};

const REMOTE_CHANGES: Record<string, string | null> = {
	...SUITE_CHANGES,
	'alignments/map-1.json': null
};

const seed = (): Promise<MemoryProjectStore> => seeded(BEFORE);

const snapshot = (store: MemoryProjectStore): Record<string, string> =>
	Object.fromEntries([...store.snapshot()].map(([path, bytes]) => [path, decode(bytes)]));

const baseline = (): Promise<SynchronizationBaseline> => baselineOf(BEFORE);
const remoteWithChanges = (): Promise<FakeGitHub> => suiteRemote(BEFORE, REMOTE_CHANGES);

const refusal = (run: Promise<unknown>): Promise<UpdateRefusedError> =>
	rejection(UpdateRefusedError, run);

const getChanges = (store: ProjectStore, fake: FakeGitHub, base: SynchronizationBaseline) =>
	getFromRemote(store, {
		remote: ATLAS,
		token: null,
		baseline: base,
		fetch: fake.fetch,
		workspace: 'Atlas'
	});

class Interrupted implements ProjectStore {
	mutations = 0;

	constructor(
		readonly inner: MemoryProjectStore,
		private readonly at: number
	) {}

	read = (path: StorePath) => this.inner.read(path);
	list = (prefix: string) => this.inner.list(prefix);
	size = (path: StorePath) => this.inner.size(path);
	reclaimAbandonedWrites = (prefix: string) => this.inner.reclaimAbandonedWrites(prefix);
	write = (path: WritablePath, bytes: Bytes) => this.#count(() => this.inner.write(path, bytes));
	delete = (path: StorePath) => this.#count(() => this.inner.delete(path));

	#count(mutate: () => Promise<void>): Promise<void> {
		this.mutations += 1;
		if (this.mutations === this.at) this.inner.becomeUnreachable(new Error('the tab went away'));
		return mutate();
	}
}

const restart = (dead: MemoryProjectStore): MemoryProjectStore => {
	const store = new MemoryProjectStore();
	for (const [path, bytes] of dead.snapshot()) store.plant(path, bytes);
	return store;
};

describe('an Update applied as one transaction', () => {
	it('adds, replaces and removes in one operation, leaves no residue, and advances the Baseline for what is shared', async () => {
		const store = await seed();
		const result = await getChanges(store, await remoteWithChanges(), await baseline());
		expect(snapshot(store)).toEqual(AFTER);
		expect(result.added).toEqual(['images/map-1/0/0/1.jpg']);
		expect(result.replaced).toEqual(['delft/annotations/l3.geojson']);
		expect(result.removed).toEqual([
			'alignments/map-1.json',
			'amsterdam-1625/annotations/l2.geojson',
			'amsterdam-1625/project.json'
		]);
		expect(await readUpdateTransaction(store)).toBeNull();

		expect([...result.baseline.keys()].sort()).toEqual(Object.keys(AFTER).sort());
		for (const [path, sha] of await shas(AFTER)) expect(result.baseline.get(path)).toBe(sha);
		expect(result.shared).toEqual([...Object.keys(AFTER), ...result.removed].sort());
	});

	it('leaves the Remote exactly where it was', async () => {
		const store = await seed();
		const fake = await remoteWithChanges();
		const head = fake.head();

		await getChanges(store, fake, await baseline());

		expect(fake.head()).toBe(head);
		expect(fake.files().has('amsterdam-1625/project.json')).toBe(false);
	});
});

describe('fault injection at every durable boundary', () => {
	const boundaries = async (): Promise<number> => {
		const counting = new Interrupted(await seed(), Number.MAX_SAFE_INTEGER);
		await getChanges(counting, await remoteWithChanges(), await baseline());
		return counting.mutations;
	};

	it('has a boundary at the marker, every before-image, every file, every deletion and the cleanup', async () => {
		expect(await boundaries()).toBe(16);
	});

	for (let nth = 1; nth <= 16; nth += 1) {
		it(`is the complete before or the complete after when the tab dies at boundary ${nth}`, async () => {
			const dead = await seed();
			const store = new Interrupted(dead, nth);

			await getChanges(store, await remoteWithChanges(), await baseline()).catch(() => undefined);

			const restarted = restart(dead);
			await recoverWorkspaceUpdate(restarted);

			expect([BEFORE, AFTER]).toContainEqual(snapshot(restarted));
			expect(await readUpdateTransaction(restarted)).toBeNull();
		});
	}

	it('recovers the same way however many times it is interrupted', async () => {
		const dead = await seed();
		await getChanges(new Interrupted(dead, 8), await remoteWithChanges(), await baseline()).catch(
			() => undefined
		);

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
		const store = await seed();
		store.failWriteAt(7, 'rename');

		const refused = await refusal(getChanges(store, await remoteWithChanges(), await baseline()));
		expect(refused.refusal).toBe('write-failed');
		expect(snapshot(store)).toEqual(BEFORE);
		expect(await readUpdateTransaction(store)).toBeNull();
	});

	it('keeps the record when the rollback itself cannot finish', async () => {
		const dead = await seed();
		const store = new Interrupted(dead, 6);
		const refused = await refusal(getChanges(store, await remoteWithChanges(), await baseline()));
		expect(refused.refusal).toBe('unresolved-residue');
		expect(Object.keys(snapshot(dead))).toContain(UPDATE_TRANSACTION_PATH);
	});
});

describe('before it will start at all', () => {
	it('refuses for want of room, naming what it needs and what there is, before any mutation', async () => {
		const dead = await seed();
		const store = new Interrupted(dead, Number.MAX_SAFE_INTEGER);

		const refused = await refusal(
			getFromRemote(store, {
				remote: ATLAS,
				token: null,
				baseline: await baseline(),
				fetch: (await remoteWithChanges()).fetch,
				estimateStorage: async () => ({ quota: 1_000_000, usage: 999_950 })
			})
		);

		expect(refused.refusal).toBe('insufficient-quota');
		expect(refused.message).toMatch(/needs about \d/);
		expect(refused.message).toMatch(/50 bytes free/);
		expect(refused.message).toContain('each file it replaces or removes');
		expect(store.mutations).toBe(0);
		expect(snapshot(dead)).toEqual(BEFORE);
	});

	it('will not plan over an unresolved record, so nothing reads a mixed Workspace', async () => {
		const dead = await seed();
		await getChanges(new Interrupted(dead, 6), await remoteWithChanges(), await baseline()).catch(
			() => undefined
		);

		const refused = await refusal(
			getChanges(
				new Interrupted(dead, Number.MAX_SAFE_INTEGER),
				await remoteWithChanges(),
				await baseline()
			)
		);

		expect(refused.refusal).toBe('unresolved-transaction');
	});
});
