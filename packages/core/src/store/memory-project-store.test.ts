import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from './memory-project-store.js';
import { describeProjectStore } from './project-store-suite.js';
import { encode } from '../test-support.js';

describeProjectStore('MemoryProjectStore', () => {
	const store = new MemoryProjectStore();
	return {
		store,
		everyStoredPath: async () => [...store.snapshot().keys()],
		failNextWrite: (step) => store.failNextWrite(step),
		plantAbandonedWrite: async (path) => store.plant(path, encode('half a document'))
	};
});

describe('MemoryProjectStore.unreachable', () => {
	it('fails every operation, so the unreachable workspace of ADR-0008 is reachable in a test', async () => {
		const store = MemoryProjectStore.unreachable();

		await expect(store.list('')).rejects.toThrow('Workspace not reachable');
		await expect(store.read('p/project.json')).rejects.toThrow('Workspace not reachable');
	});
});

describe('the write fault switch', () => {
	it('fails the nth write from now on and no other', async () => {
		const store = new MemoryProjectStore();
		store.failWriteAt(3, 'bytes');

		await store.write('p/one', encode('one'));
		await store.write('p/two', encode('two'));
		await expect(store.write('p/three', encode('three'))).rejects.toThrow('storage went away');
		await store.write('p/four', encode('four'));

		expect([...store.snapshot().keys()]).toEqual(['p/four', 'p/one', 'p/two']);
	});

	it('fails the nth write at the rename step, leaving no temporary file behind', async () => {
		const store = new MemoryProjectStore();
		store.failWriteAt(2, 'rename');

		await store.write('p/one', encode('one'));
		await expect(store.write('p/two', encode('two'))).rejects.toThrow('storage went away');

		expect([...store.snapshot().keys()]).toEqual(['p/one']);
	});

	it('fails the next delete and no other', async () => {
		const store = new MemoryProjectStore();
		await store.write('p/one', encode('one'));
		await store.write('p/two', encode('two'));
		store.failNextDelete();

		await expect(store.delete('p/one')).rejects.toThrow('storage went away');
		await store.delete('p/two');

		expect([...store.snapshot().keys()]).toEqual(['p/one']);
	});

	it('can lose the backing part way through, cleanup included', async () => {
		const store = new MemoryProjectStore();
		await store.write('p/one', encode('one'));

		store.becomeUnreachable();

		await expect(store.write('p/two', encode('two'))).rejects.toThrow('Workspace not reachable');
		await expect(store.delete('p/one')).rejects.toThrow('Workspace not reachable');
		expect([...store.snapshot().keys()]).toEqual(['p/one']);
	});
});
