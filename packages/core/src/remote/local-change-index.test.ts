import { describe, expect, it, vi } from 'vitest';

import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { LocalChangeIndex, checkSourceStatus, localChangeKey } from './local-change-index.js';
import { ManagedProjectStore } from '../store/managed-project-store.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { SYNCHRONIZATION_FORMAT_VERSION } from './synchronization-metadata.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';

// Two things are being held to account here. The index has to survive being reconstructed — it is the
// only record that a file the user changed yesterday has not been sent — and it has to be read
// *cautiously*: it says which paths changed and never what they now hold, so a status derived from it
// must not turn "I cannot compare these two changes" into "they agree".

const WORKSPACE = 'opfs:Marking 2026';
const OTHER = 'folder:Marking 2026';

const ATLAS = { owner: 'ada', repository: 'atlas', branch: 'main' };

const index = (storage: FakeMetadataStorage, workspace = WORKSPACE) =>
	new LocalChangeIndex(storage, workspace, { flushInterval: 0 });

const baseline = (files: Iterable<[string, string]>): SynchronizationBaseline => ({
	remote: ATLAS,
	commit: 'c0ffee',
	files: new Map(files)
});

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

		// The local-only path an Update retained is still Changes to send, and a reconstruction has
		// to say so — this is the record that says the Remote has never seen it.
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

	it('reads a record from another build as no marks at all', async () => {
		const storage = new FakeMetadataStorage();
		await storage.put(localChangeKey(WORKSPACE), {
			formatVersion: SYNCHRONIZATION_FORMAT_VERSION + 1,
			at: 'then',
			changes: new Map([['atlas/project.json', 'written']])
		});

		expect(await index(storage).localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('reads a truncated record as no marks at all', async () => {
		const storage = new FakeMetadataStorage();
		await storage.put(localChangeKey(WORKSPACE), {
			formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
			at: 'then',
			// One entry nothing here has rules for. A record missing a path is worse than no record:
			// the missing path silently stops being reported as changed.
			changes: new Map([
				['atlas/project.json', 'written'],
				['atlas/annotations/notes.json', 'moved']
			])
		});

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

		// In memory it is the truth; on disk it is the previous record, which is still every mark it
		// held. Nothing that was known has been thrown away.
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

	it('is Cannot tell without a Baseline, and still reports what changed', async () => {
		const status = await checkSourceStatus({
			changes: source(['atlas/project.json']),
			remote: [{ path: 'atlas/project.json', sha: 'r1' }],
			baseline: null
		});

		expect(status.status).toBe('cannot-tell');
		expect(status.written).toEqual(['atlas/project.json']);
	});

	it('is In sync when nothing has been written or deleted', async () => {
		const status = await checkSourceStatus({
			changes: source(),
			remote: [{ path: 'atlas/project.json', sha: 'b1' }],
			baseline: baseline([['atlas/project.json', 'b1']])
		});

		expect(status.status).toBe('in-sync');
	});

	it('is Changes to send for a written path the Remote still agrees with', async () => {
		const status = await checkSourceStatus({
			changes: source(['atlas/project.json']),
			remote: [{ path: 'atlas/project.json', sha: 'b1' }],
			baseline: baseline([['atlas/project.json', 'b1']])
		});

		expect(status.status).toBe('changes-to-send');
	});

	it('is Changes to send for a deleted path the Remote still holds at the Baseline', async () => {
		const status = await checkSourceStatus({
			changes: source([], ['atlas/annotations/notes.json']),
			remote: [
				{ path: 'atlas/project.json', sha: 'b1' },
				{ path: 'atlas/annotations/notes.json', sha: 'b2' }
			],
			baseline: baseline([
				['atlas/project.json', 'b1'],
				['atlas/annotations/notes.json', 'b2']
			])
		});

		expect(status.status).toBe('changes-to-send');
		expect(status.deleted).toEqual(['atlas/annotations/notes.json']);
	});

	it('is Changes to get for a Remote change the index knows nothing about', async () => {
		const status = await checkSourceStatus({
			changes: source(),
			remote: [{ path: 'atlas/project.json', sha: 'r2' }],
			baseline: baseline([['atlas/project.json', 'b1']])
		});

		expect(status.status).toBe('changes-to-get');
	});

	it('is Changes both ways when the two changed different paths', async () => {
		const status = await checkSourceStatus({
			changes: source(['atlas/annotations/notes.json']),
			remote: [
				{ path: 'atlas/project.json', sha: 'r2' },
				{ path: 'atlas/annotations/notes.json', sha: 'b2' }
			],
			baseline: baseline([
				['atlas/project.json', 'b1'],
				['atlas/annotations/notes.json', 'b2']
			])
		});

		expect(status.status).toBe('changes-both-ways');
	});

	it('is Changes both ways when one path changed on both sides', async () => {
		const status = await checkSourceStatus({
			changes: source(['atlas/project.json']),
			remote: [{ path: 'atlas/project.json', sha: 'r2' }],
			baseline: baseline([['atlas/project.json', 'b1']])
		});

		// The two changes may well be identical. A passive check has no way to find out, and the
		// deliberate pass hashes and may downgrade this — reporting `In sync` over an unexamined
		// Conflict is the one direction there is no recovering from. A Conflict is *not* a status of
		// its own (ADR-0046): it is something to send and something to get at once.
		expect(status.status).toBe('changes-both-ways');
	});

	it('reads no byte of the Workspace', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const managed = new ManagedProjectStore(workspace, index(storage));
		await managed.write('atlas/project.json', new TextEncoder().encode('{}'));
		await managed.delete('atlas/annotations/notes.json');
		await managed.flushChanges();

		// Not merely counted: any access at all fails the test where it happens, which is a clearer
		// report than a count asserted at the end. Hashing is covered by `read` — there is no way to
		// hash a file this store holds without asking it for the bytes.
		const refuse = (name: 'read' | 'list' | 'size') =>
			vi.spyOn(workspace, name).mockImplementation(() => {
				throw new Error(`an automatic check must not call ${name}`);
			});
		const spies = [refuse('read'), refuse('list'), refuse('size')];

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
