import { describe, expect, it, vi } from 'vitest';

import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { LocalChangeIndex, checkSourceStatus, localChangeKey } from './local-change-index.js';
import { ManagedProjectStore } from '../store/managed-project-store.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { SYNCHRONIZATION_FORMAT_VERSION } from './synchronization-metadata.js';
import { baselineWith as baseline, changeIndex as index } from './remote-test-support.js';

const WORKSPACE = 'opfs:Marking 2026';
const OTHER = 'folder:Marking 2026';

describe('LocalChangeIndex', () => {
	it('survives being reconstructed for the same Workspace', async () => {
		const storage = new FakeMetadataStorage();
		const first = index(storage);
		await first.mark('atlas/project.json', 'written');
		await first.mark('images/leaf-1/tiles/0/0/0.png', 'deleted');
		expect(await first.flush()).toBe(true);

		expect(await index(storage).localChanges()).toEqual({
			written: ['atlas/project.json'],
			deleted: ['images/leaf-1/tiles/0/0/0.png']
		});
	});

	it('keeps a Workspace of the same name in another backing separate', async () => {
		const storage = new FakeMetadataStorage();
		await index(storage).mark('atlas/project.json', 'written');
		await index(storage).flush();

		expect(await index(storage, OTHER).localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('records one entry however many times a path changes', async () => {
		const storage = new FakeMetadataStorage();
		const changes = index(storage);
		for (let save = 0; save < 5; save += 1) await changes.mark('atlas/project.json', 'written');
		await changes.flush();

		expect(await changes.localChanges()).toEqual({
			written: ['atlas/project.json'],
			deleted: []
		});
	});

	it('takes the last thing that happened to a path', async () => {
		const storage = new FakeMetadataStorage();
		const changes = index(storage);
		await changes.mark('atlas/annotations/notes.json', 'written');
		await changes.mark('atlas/annotations/notes.json', 'deleted');
		await changes.flush();

		expect(await changes.localChanges()).toEqual({
			written: [],
			deleted: ['atlas/annotations/notes.json']
		});
	});

	it('clears only the paths a Baseline advance made shared', async () => {
		const storage = new FakeMetadataStorage();
		const changes = index(storage);
		await changes.mark('atlas/project.json', 'written');
		await changes.mark('atlas/annotations/notes.json', 'written');
		await changes.mark('images/leaf-1/source.jpg', 'deleted');
		expect(await changes.clearShared(['atlas/project.json', 'images/leaf-1/source.jpg'])).toBe(
			true
		);

		const expected = { written: ['atlas/annotations/notes.json'], deleted: [] };
		expect(await changes.localChanges()).toEqual(expected);
		expect(await index(storage).localChanges()).toEqual(expected);
	});

	it('forgets everything when the whole namespace becomes shared', async () => {
		const storage = new FakeMetadataStorage();
		const changes = index(storage);
		await changes.mark('atlas/project.json', 'written');
		await changes.clear();

		expect(await index(storage).localChanges()).toEqual({ written: [], deleted: [] });
	});

	it.each([
		[
			'from another build',
			SYNCHRONIZATION_FORMAT_VERSION + 1,
			new Map([['atlas/project.json', 'written']])
		],
		[
			'truncated',
			SYNCHRONIZATION_FORMAT_VERSION,
			new Map([
				['atlas/project.json', 'written'],
				['atlas/annotations/notes.json', 'moved']
			])
		]
	])('reads a record %s as no marks at all', async (_, formatVersion, changes) => {
		const storage = new FakeMetadataStorage();
		await storage.put(localChangeKey(WORKSPACE), { formatVersion, at: 'then', changes });

		expect(await index(storage).localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('reports a mark it could not keep, and keeps the ones it had', async () => {
		const storage = new FakeMetadataStorage();
		const refused: unknown[] = [];
		const changes = new LocalChangeIndex(storage, WORKSPACE, {
			flushInterval: 0,
			onChangeNotRecorded: (problem) => refused.push(problem)
		});
		await changes.mark('atlas/project.json', 'written');
		expect(await changes.flush()).toBe(true);

		storage.refuseWrites.add(localChangeKey(WORKSPACE));
		await changes.mark('atlas/annotations/notes.json', 'written');
		expect(await changes.flush()).toBe(false);
		expect(refused.length).toBeGreaterThan(0);

		expect((await changes.localChanges()).written).toEqual([
			'atlas/annotations/notes.json',
			'atlas/project.json'
		]);
		expect((await index(storage).localChanges()).written).toEqual(['atlas/project.json']);
	});

	it('answers no marks when the store will not be read', async () => {
		const storage = new FakeMetadataStorage();
		storage.refuseReads.add(localChangeKey(WORKSPACE));

		expect(await index(storage).localChanges()).toEqual({ written: [], deleted: [] });
	});
});

describe('checkSourceStatus', () => {
	const source = (written: string[] = [], deleted: string[] = []) => ({
		localChanges: async () => ({ written, deleted })
	});

	const PROJECT = 'atlas/project.json';
	const NOTES = 'atlas/annotations/notes.json';
	const statusOf = (
		written: string[],
		deleted: string[],
		remote: Record<string, string>,
		shared: Record<string, string> | null
	) =>
		checkSourceStatus({
			changes: source(written, deleted),
			remote: Object.entries(remote).map(([path, sha]) => ({ path, sha })),
			baseline: shared === null ? null : baseline(Object.entries(shared))
		});

	it('is Cannot tell without a Baseline, and still reports what changed', async () => {
		const status = await statusOf([PROJECT], [], { [PROJECT]: 'r1' }, null);
		expect(status.status).toBe('cannot-tell');
		expect(status.written).toEqual(['atlas/project.json']);
	});

	it.each([
		['In sync when nothing has been written or deleted', [], 'b1', 'in-sync'],
		[
			'Changes to send for a written path the Remote still agrees with',
			[PROJECT],
			'b1',
			'changes-to-send'
		],
		[
			'Changes to get for a Remote change the index knows nothing about',
			[],
			'r2',
			'changes-to-get'
		],
		['Changes both ways when one path changed on both sides', [PROJECT], 'r2', 'changes-both-ways']
	])('is %s', async (_, written, remote, expected) => {
		const status = await statusOf(written, [], { [PROJECT]: remote }, { [PROJECT]: 'b1' });
		expect(status.status).toBe(expected);
	});

	it('is Changes to send for a deleted path the Remote still holds at the Baseline', async () => {
		const shared = { [PROJECT]: 'b1', [NOTES]: 'b2' };
		const status = await statusOf([], [NOTES], shared, shared);
		expect(status.status).toBe('changes-to-send');
		expect(status.deleted).toEqual([NOTES]);
	});

	it('is Changes both ways when the two changed different paths', async () => {
		const status = await statusOf(
			[NOTES],
			[],
			{ [PROJECT]: 'r2', [NOTES]: 'b2' },
			{ [PROJECT]: 'b1', [NOTES]: 'b2' }
		);

		expect(status.status).toBe('changes-both-ways');
	});

	it('reads no byte of the Workspace', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const managed = new ManagedProjectStore(workspace, index(storage));
		await managed.write('atlas/project.json', new TextEncoder().encode('{}'));
		await managed.delete('atlas/annotations/notes.json');
		await managed.flushChanges();

		const spies = (['read', 'list', 'size'] as const).map((name) =>
			vi.spyOn(workspace, name).mockImplementation(() => {
				throw new Error(`an automatic check must not call ${name}`);
			})
		);

		const status = await checkSourceStatus({
			changes: managed,
			remote: [{ path: 'atlas/project.json', sha: 'b1' }],
			baseline: baseline([
				['atlas/project.json', 'b1'],
				['atlas/annotations/notes.json', 'b2']
			])
		});

		expect(status.status).toBe('changes-to-send');
		expect(status.written).toEqual(['atlas/project.json']);
		expect(status.deleted).toEqual(['atlas/annotations/notes.json']);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});
});
