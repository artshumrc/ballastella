import { describe, expect, it, vi } from 'vitest';

import { FakeMetadataStorage } from '../remote/fake-metadata-storage.js';
import { LocalChangeIndex, localChangeKey } from '../remote/local-change-index.js';
import { ManagedProjectStore, manageProjectStore } from './managed-project-store.js';
import { MemoryProjectStore } from './memory-project-store.js';
import type { LocalChanges } from '../remote/local-change-index.js';

// What this seam is for is the question "has anything in this Workspace changed since GitHub last saw
// it?", answered without reading a Workspace that may be several gigabytes. So the tests are about
// what does and does not earn a mark: only what succeeded, and only scholarship. A mark on a
// published `_app/` chunk would make every Workspace read `Changes to send` the moment it
// published, and a *missing* mark is worse — it reports changed work as `In sync`.

const WORKSPACE = 'opfs:Marking 2026';
const FOLDER = 'folder:maps';

const bytes = (text: string) => new TextEncoder().encode(text);

/** A managed store over `workspace`, sharing `storage` so a second one is a second session. */
const manage = (
	workspace: MemoryProjectStore,
	storage: FakeMetadataStorage,
	key = WORKSPACE
): ManagedProjectStore =>
	new ManagedProjectStore(workspace, new LocalChangeIndex(storage, key, { flushInterval: 0 }));

/** What a fresh session — a new index over the same durable record — reads back. */
const reopened = async (storage: FakeMetadataStorage, key = WORKSPACE): Promise<LocalChanges> =>
	new LocalChangeIndex(storage, key, { flushInterval: 0 }).localChanges();

describe('ManagedProjectStore', () => {
	it('marks a successful write and a successful deletion, durably', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		await store.write('atlas/project.json', bytes('{}'));
		await store.write('images/leaf-1/source.jpg', bytes('jpeg'));
		await store.delete('alignments/leaf-1.json');
		expect(await store.flushChanges()).toBe(true);

		expect(await reopened(storage)).toEqual({
			written: ['atlas/project.json', 'images/leaf-1/source.jpg'],
			deleted: ['alignments/leaf-1.json']
		});
	});

	it('marks a path inside a Project it has to recognise from the Workspace', async () => {
		const workspace = new MemoryProjectStore();
		await workspace.write('atlas/project.json', bytes('{}'));
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		// `atlas` is a Project only because it holds a `project.json`, and this write happened without
		// the one that created it — an Annotation edited in a Workspace opened yesterday.
		await store.write('atlas/annotations/notes.json', bytes('[]'));
		await store.flushChanges();

		expect((await reopened(storage)).written).toEqual(['atlas/annotations/notes.json']);
	});

	it('recognises a Project from the write that creates it', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		await store.write('atlas/project.json', bytes('{}'));
		await store.write('atlas/annotations/notes.json', bytes('[]'));
		await store.flushChanges();

		expect((await reopened(storage)).written).toEqual([
			'atlas/annotations/notes.json',
			'atlas/project.json'
		]);
	});

	it('recognises a Project a previous session established, without walking the Workspace again', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const first = manage(workspace, storage);
		await first.write('atlas/project.json', bytes('{}'));
		await first.flushChanges();

		const listing = vi.spyOn(workspace, 'list');
		const second = manage(workspace, storage);
		await second.write('atlas/annotations/notes.json', bytes('[]'));
		await second.flushChanges();

		expect((await second.localChanges()).written).toContain('atlas/annotations/notes.json');
		// The whole reason the directories are in the record: a walk of a multi-gigabyte Workspace on
		// the first write of every session is a cost this feature must not add.
		expect(listing).not.toHaveBeenCalled();
	});

	it('marks nothing for a write that failed', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		workspace.failNextWrite('bytes');
		await expect(store.write('atlas/project.json', bytes('{}'))).rejects.toThrow();
		workspace.failNextWrite('rename');
		await expect(store.write('atlas/project.json', bytes('{}'))).rejects.toThrow();
		await store.flushChanges();

		// The destination holds what it held before, so there is nothing for the Remote to differ from.
		expect(await store.localChanges()).toEqual({ written: [], deleted: [] });
		expect(await reopened(storage)).toEqual({ written: [], deleted: [] });
	});

	it('marks nothing for a deletion that failed', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		workspace.failNextDelete();
		await expect(store.delete('atlas/project.json')).rejects.toThrow();
		await store.flushChanges();

		expect(await store.localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('marks nothing for reading, listing, sizing or reclaiming', async () => {
		const workspace = new MemoryProjectStore();
		await workspace.write('atlas/project.json', bytes('{}'));
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		expect(await store.read('atlas/project.json')).toEqual(bytes('{}'));
		expect(await store.list('')).toEqual(['atlas/project.json']);
		expect(await store.size('atlas/project.json')).toBe(2);
		await store.reclaimAbandonedWrites('');
		await store.flushChanges();

		expect(await store.localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('marks nothing for the output a Publish generates', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		for (const path of [
			'_app/immutable/chunks/atlas.js',
			'index.html',
			'robots.txt',
			'.nojekyll',
			'ballastella-site.json',
			'base-map/glyphs/0-255.pbf'
		]) {
			await store.write(path, bytes('generated'));
		}
		await store.flushChanges();

		expect(await store.localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('marks the offline tile cache, which lives inside a Publish-owned directory', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		// The author's own decision to make a Project work without a network, and the one exception to
		// `base-map/` being generated output.
		await store.write('base-map/tiles/7/64/42.pbf', bytes('tile'));
		await store.flushChanges();

		expect((await reopened(storage)).written).toEqual(['base-map/tiles/7/64/42.pbf']);
	});

	it('marks nothing for somebody else’s files in the same repository', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		for (const path of ['README.md', 'LICENSE', 'CNAME', 'docs/notes.md']) {
			await store.write(path, bytes('theirs'));
		}
		await store.delete('docs/notes.md');
		await store.flushChanges();

		expect(await store.localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('records one path however many times it is saved', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		for (let save = 0; save < 20; save += 1) {
			await store.write('atlas/project.json', bytes(`{"n":${save}}`));
		}
		await store.flushChanges();

		expect(await reopened(storage)).toEqual({ written: ['atlas/project.json'], deleted: [] });
	});

	it('keeps a chosen folder’s marks apart from a browser Workspace of the same name', async () => {
		const storage = new FakeMetadataStorage();
		const browser = manage(new MemoryProjectStore(), storage);
		const folder = manage(new MemoryProjectStore(), storage, FOLDER);
		await browser.write('atlas/project.json', bytes('{}'));
		await folder.write('leaves/project.json', bytes('{}'));
		await browser.flushChanges();
		await folder.flushChanges();

		expect((await reopened(storage)).written).toEqual(['atlas/project.json']);
		expect((await reopened(storage, FOLDER)).written).toEqual(['leaves/project.json']);
	});

	it('installs one tracker whichever backing is adopted, and never a second', async () => {
		const storage = new FakeMetadataStorage();
		const index = new LocalChangeIndex(storage, WORKSPACE, { flushInterval: 0 });
		const browser = manageProjectStore(new MemoryProjectStore(), index);
		const folder = manageProjectStore(new MemoryProjectStore(), index);
		expect(browser).toBeInstanceOf(ManagedProjectStore);
		expect(folder).toBeInstanceOf(ManagedProjectStore);

		// Adopting a Workspace that is already managed — a folder reopened, a Workspace switched back
		// to — must not stack a second wrapper marking everything twice.
		expect(manageProjectStore(browser, index)).toBe(browser);
	});

	it('does not fail an author’s write when the index cannot be kept', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const store = manage(workspace, storage);
		storage.refuseWrites.add(localChangeKey(WORKSPACE));

		await expect(store.write('atlas/project.json', bytes('{}'))).resolves.toBeUndefined();
		expect(workspace.snapshot().has('atlas/project.json')).toBe(true);
		expect(await store.flushChanges()).toBe(false);
	});
});
