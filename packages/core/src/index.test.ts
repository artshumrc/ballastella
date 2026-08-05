import { expect, it } from 'vitest';

import { Autosave, MemoryProjectStore, Workspace } from './index.js';

// The barrel is what both apps import. A missing re-export is a build error there and a
// puzzling one, so it is worth one assertion here that the whole storage path is reachable
// through the package's public entry point.
it('exposes a working workspace through the package entry point', async () => {
	const store = new MemoryProjectStore();
	const workspace = new Workspace(store, { autosave: new Autosave(store) });

	const created = await workspace.createProject('Amsterdam 1625');

	expect((await workspace.listProjects()).map((p) => p.directory)).toEqual([created.directory]);
});
