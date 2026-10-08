import { describe, expect, it } from 'vitest';

import type { LocalChanges } from './local-change-index.js';
import { projectRemoteReach } from './project-reach.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';

const SHARED: SynchronizationBaseline = {
	remote: { owner: 'ada', repository: 'atlas', branch: 'main' },
	commit: 'c0ffee',
	files: new Map([['amsterdam-1625/project.json', 'a'.repeat(40)]])
};

const reach = (
	directory: string,
	changes: LocalChanges | null,
	baseline: SynchronizationBaseline | null = SHARED
) => projectRemoteReach({ directory, baseline, changes });

describe('how far a Project’s work has reached the Remote', () => {
	it('has neither reached nor sent anything where the two sides have never agreed', () => {
		expect(reach('amsterdam-1625', null, null)).toEqual({ synced: false, unsent: true });
	});

	it('is on the Remote and up to date where the agreement holds its files and nothing changed since', () => {
		expect(reach('amsterdam-1625', { written: [], deleted: [] })).toEqual({
			synced: true,
			unsent: false
		});
	});

	it('has work to send where anything inside it has been written since', () => {
		expect(
			reach('amsterdam-1625', { written: ['amsterdam-1625/annotations/one.geojson'], deleted: [] })
		).toEqual({ synced: true, unsent: true });
	});

	it('has work to send where anything inside it has been removed since', () => {
		expect(
			reach('amsterdam-1625', { written: [], deleted: ['amsterdam-1625/annotations/one.geojson'] })
		).toEqual({ synced: true, unsent: true });
	});

	it('reads only its own directory, never one whose name it is a prefix of', () => {
		expect(reach('amsterdam', { written: ['amsterdam-1625/project.json'], deleted: [] })).toEqual({
			synced: false,
			unsent: true
		});
	});

	it('has work to send where the agreement knows nothing of it', () => {
		expect(reach('delft', { written: [], deleted: [] })).toEqual({ synced: false, unsent: true });
	});

	it('assumes there is something to send where nothing tracked the local writes', () => {
		expect(reach('amsterdam-1625', null)).toEqual({ synced: true, unsent: true });
	});
});
