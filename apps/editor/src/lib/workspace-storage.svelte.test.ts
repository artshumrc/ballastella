import { describe, expect, it } from 'vitest';

import { WORKSPACE_BACKINGS, type WorkspaceBacking } from './workspace-storage.svelte.js';

// ⚠ **"`WorkspaceBacking` still has exactly two members" is an acceptance criterion, and a type
// alias cannot assert it about itself** — a test naming `'browser' | 'folder'` is a test of what the
// test says. So the union is derived from {@link WORKSPACE_BACKINGS} and the *list* is what is
// counted here. ADR-0032: a Remote is orthogonal to the backing and is not a third member; a third
// one means a new case in `#adopt`, the journal keys, the roster, `canChooseFolder` and `discard`,
// five sites where a mistake in the journal key is silent.

describe('where a Workspace can be kept', () => {
	it('is browser storage or a folder, and nothing else (ADR-0032)', () => {
		expect([...WORKSPACE_BACKINGS]).toEqual(['browser', 'folder']);
	});

	// The other direction, and the reason the const is worth having: the union is *this list*, so a
	// member added here without the six cases being written fails to compile at each of them rather
	// than only here.
	it('is the union every backing-shaped value narrows against', () => {
		const backings: WorkspaceBacking[] = [...WORKSPACE_BACKINGS];

		expect(backings).toHaveLength(WORKSPACE_BACKINGS.length);
	});
});
