import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from './memory-project-store.js';
import { describeProjectStore } from './project-store-suite.js';

describeProjectStore('MemoryProjectStore', () => new MemoryProjectStore());

describe('MemoryProjectStore.unreachable', () => {
	it('fails every operation, so the unreachable workspace of ADR-0008 is reachable in a test', async () => {
		const store = MemoryProjectStore.unreachable();

		await expect(store.list('')).rejects.toThrow('Workspace not reachable');
		await expect(store.read('p/project.json')).rejects.toThrow('Workspace not reachable');
	});
});
