import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from './memory-project-store.js';
import { describeProjectStore } from './project-store-suite.js';

describeProjectStore('MemoryProjectStore', () => {
	const store = new MemoryProjectStore();
	return {
		store,
		// `snapshot()` and not `list()`: `list` filters the reserved temporary suffix by
		// construction, so the suite's litter assertions would pass against no cleanup at all.
		everyStoredPath: async () => [...store.snapshot().keys()],
		failNextWrite: (step) => store.failNextWrite(step),
		plantAbandonedWrite: async (path) =>
			store.plant(path, new TextEncoder().encode('half a document'))
	};
});

describe('MemoryProjectStore.unreachable', () => {
	it('fails every operation, so the unreachable workspace of ADR-0008 is reachable in a test', async () => {
		const store = MemoryProjectStore.unreachable();

		await expect(store.list('')).rejects.toThrow('Workspace not reachable');
		await expect(store.read('p/project.json')).rejects.toThrow('Workspace not reachable');
	});
});

// The fault switches a multi-file operation needs, which no public API can produce. Asserted here
// rather than only where they are used, because a switch that silently stopped firing would make
// every fault matrix built on it pass by writing nothing at all.
describe('the write fault switch', () => {
	const encode = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

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
		// What the disk holds is still assertable, which is the whole point of reaching this state.
		expect([...store.snapshot().keys()]).toEqual(['p/one']);
	});
});
