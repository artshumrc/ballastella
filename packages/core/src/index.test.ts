import { expect, it } from 'vitest';

import * as core from './index.js';
import { Autosave, Workspace } from './index.js';
import { MemoryProjectStore } from './testing.js';

it('exposes a working workspace through the package entry point', async () => {
	const store = new MemoryProjectStore();
	const workspace = new Workspace(store, { autosave: new Autosave(store) });
	const created = await workspace.createProject('Amsterdam 1625');
	expect((await workspace.listProjects()).map((p) => p.directory)).toEqual([created.directory]);
});

it('resolves the Base Map surface from the package entry point', () => {
	expect(typeof core.resolveBaseMap).toBe('function');
	expect(typeof core.baseMapStyle).toBe('function');
	expect(core.BASE_MAP_CATALOG.entries.length).toBeGreaterThan(0);
});
