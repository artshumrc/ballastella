import { describe, expect, it, vi } from 'vitest';

import { FakeMetadataStorage } from '../remote/fake-metadata-storage.js';
import { LocalChangeIndex, localChangeKey } from '../remote/local-change-index.js';
import { ManagedProjectStore, manageProjectStore } from './managed-project-store.js';
import { MemoryProjectStore } from './memory-project-store.js';
import type { LocalChanges } from '../remote/local-change-index.js';
import { encode, seeded } from '../test-support.js';

const WORKSPACE = 'opfs:Marking 2026';
const FOLDER = 'folder:maps';

const manage = (
	workspace = new MemoryProjectStore(),
	storage = new FakeMetadataStorage(),
	key = WORKSPACE
) => ({
	workspace,
	storage,
	store: new ManagedProjectStore(
		workspace,
		new LocalChangeIndex(storage, key, { flushInterval: 0 })
	)
});

const reopened = async (storage: FakeMetadataStorage, key = WORKSPACE): Promise<LocalChanges> =>
	new LocalChangeIndex(storage, key, { flushInterval: 0 }).localChanges();

describe('ManagedProjectStore', () => {
	it('marks a successful write and a successful deletion, durably', async () => {
		const { storage, store } = manage();
		await store.write('atlas/project.json', encode('{}'));
		await store.write('images/leaf-1/source.jpg', encode('jpeg'));
		await store.delete('alignments/leaf-1.json');
		expect(await store.flushChanges()).toBe(true);

		expect(await reopened(storage)).toEqual({
			written: ['atlas/project.json', 'images/leaf-1/source.jpg'],
			deleted: ['alignments/leaf-1.json']
		});
	});

	it('marks a path inside a Project it has to recognise from the Workspace', async () => {
		const { storage, store } = manage(await seeded({ 'atlas/project.json': '{}' }));
		await store.write('atlas/annotations/notes.json', encode('[]'));
		await store.flushChanges();

		expect((await reopened(storage)).written).toEqual(['atlas/annotations/notes.json']);
	});

	it('recognises a Project from the write that creates it', async () => {
		const { storage, store } = manage();
		await store.write('atlas/project.json', encode('{}'));
		await store.write('atlas/annotations/notes.json', encode('[]'));
		await store.flushChanges();

		expect((await reopened(storage)).written).toEqual([
			'atlas/annotations/notes.json',
			'atlas/project.json'
		]);
	});

	it('recognises a Project a previous session established, without walking the Workspace again', async () => {
		const { workspace, storage, store: first } = manage();
		await first.write('atlas/project.json', encode('{}'));
		await first.flushChanges();

		const listing = vi.spyOn(workspace, 'list');
		const { store: second } = manage(workspace, storage);
		await second.write('atlas/annotations/notes.json', encode('[]'));
		await second.flushChanges();

		expect((await second.localChanges()).written).toContain('atlas/annotations/notes.json');
		expect(listing).not.toHaveBeenCalled();
	});

	it('marks nothing for a write or a deletion that failed', async () => {
		const { workspace, storage, store } = manage();
		workspace.failNextWrite('bytes');
		await expect(store.write('atlas/project.json', encode('{}'))).rejects.toThrow();
		workspace.failNextWrite('rename');
		await expect(store.write('atlas/project.json', encode('{}'))).rejects.toThrow();
		workspace.failNextDelete();
		await expect(store.delete('atlas/project.json')).rejects.toThrow();
		await store.flushChanges();

		expect(await store.localChanges()).toEqual({ written: [], deleted: [] });
		expect(await reopened(storage)).toEqual({ written: [], deleted: [] });
	});

	it('marks nothing for reading, listing, sizing or reclaiming', async () => {
		const { store } = manage(await seeded({ 'atlas/project.json': '{}' }));
		expect(await store.read('atlas/project.json')).toEqual(encode('{}'));
		expect(await store.list('')).toEqual(['atlas/project.json']);
		expect(await store.size('atlas/project.json')).toBe(2);
		await store.reclaimAbandonedWrites('');
		await store.flushChanges();

		expect(await store.localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('marks nothing for the output a site write generates, nor for somebody else’s files in the same repository', async () => {
		const { store } = manage();
		for (const path of [
			'_app/immutable/chunks/atlas.js',
			'index.html',
			'robots.txt',
			'.nojekyll',
			'ballastella-site.json',
			'base-map/glyphs/0-255.pbf',
			'README.md',
			'LICENSE',
			'CNAME',
			'docs/notes.md'
		]) {
			await store.write(path, encode('generated'));
		}
		await store.delete('docs/notes.md');
		await store.flushChanges();

		expect(await store.localChanges()).toEqual({ written: [], deleted: [] });
	});

	it('marks the offline tile cache, which lives inside a site-owned directory', async () => {
		const { storage, store } = manage();
		await store.write('base-map/tiles/7/64/42.pbf', encode('tile'));
		await store.flushChanges();

		expect((await reopened(storage)).written).toEqual(['base-map/tiles/7/64/42.pbf']);
	});

	it('records one path however many times it is saved', async () => {
		const { storage, store } = manage();
		for (let save = 0; save < 20; save += 1) {
			await store.write('atlas/project.json', encode(`{"n":${save}}`));
		}
		await store.flushChanges();

		expect(await reopened(storage)).toEqual({ written: ['atlas/project.json'], deleted: [] });
	});

	it('keeps a chosen folder’s marks apart from a browser Workspace of the same name', async () => {
		const storage = new FakeMetadataStorage();
		const { store: browser } = manage(undefined, storage);
		const { store: folder } = manage(undefined, storage, FOLDER);
		await browser.write('atlas/project.json', encode('{}'));
		await folder.write('leaves/project.json', encode('{}'));
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
		expect(manageProjectStore(browser, index)).toBe(browser);
	});

	it('does not fail an author’s write when the index cannot be kept', async () => {
		const { workspace, storage, store } = manage();
		storage.refuseWrites.add(localChangeKey(WORKSPACE));

		await expect(store.write('atlas/project.json', encode('{}'))).resolves.toBeUndefined();
		expect(workspace.snapshot().has('atlas/project.json')).toBe(true);
		expect(await store.flushChanges()).toBe(false);
	});
});
