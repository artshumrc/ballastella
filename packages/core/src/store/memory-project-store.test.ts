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
