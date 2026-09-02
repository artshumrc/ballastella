// How far one Project's work has got, from the two records that can answer it without a request.

import { describe, expect, it } from 'vitest';

import { projectRemoteReach } from './project-reach.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';

const lastShared = (...paths: string[]): SynchronizationBaseline => ({
	remote: { owner: 'ada', repository: 'atlas', branch: 'main' },
	commit: 'c0ffee',
	files: new Map(paths.map((path) => [path, 'a'.repeat(40)]))
});

describe('how far a Project’s work has reached the Remote', () => {
	it('has neither reached nor sent anything where the two sides have never agreed', () => {
		expect(
			projectRemoteReach({ directory: 'amsterdam-1625', baseline: null, changes: null })
		).toEqual({ synced: false, unsent: true });
	});

	it('is on the Remote and up to date where the agreement holds its files and nothing changed since', () => {
		expect(
			projectRemoteReach({
				directory: 'amsterdam-1625',
				baseline: lastShared('amsterdam-1625/project.json'),
				changes: { written: [], deleted: [] }
			})
		).toEqual({ synced: true, unsent: false });
	});

	it('has work to send where anything inside it has been written since', () => {
		expect(
			projectRemoteReach({
				directory: 'amsterdam-1625',
				baseline: lastShared('amsterdam-1625/project.json'),
				changes: { written: ['amsterdam-1625/annotations/one.geojson'], deleted: [] }
			})
		).toEqual({ synced: true, unsent: true });
	});

	it('has work to send where anything inside it has been removed since', () => {
		expect(
			projectRemoteReach({
				directory: 'amsterdam-1625',
				baseline: lastShared('amsterdam-1625/project.json'),
				changes: { written: [], deleted: ['amsterdam-1625/annotations/one.geojson'] }
			})
		).toEqual({ synced: true, unsent: true });
	});

	// The name is a prefix of another Project's, which is the case a `startsWith` without the
	// separator gets wrong: `amsterdam` would claim every change in `amsterdam-1625`.
	it('reads only its own directory, never one whose name it is a prefix of', () => {
		expect(
			projectRemoteReach({
				directory: 'amsterdam',
				baseline: lastShared('amsterdam-1625/project.json'),
				changes: { written: ['amsterdam-1625/project.json'], deleted: [] }
			})
		).toEqual({ synced: false, unsent: true });
	});

	// A Project the Workspace made since the last agreement: nothing of it is on the Remote, whatever
	// the change index does or does not still remember about the files it is made of.
	it('has work to send where the agreement knows nothing of it', () => {
		expect(
			projectRemoteReach({
				directory: 'delft',
				baseline: lastShared('amsterdam-1625/project.json'),
				changes: { written: [], deleted: [] }
			})
		).toEqual({ synced: false, unsent: true });
	});

	// ⚠ **No index is "something to send", never "nothing to send".** A Workspace with nowhere to keep
	// the record of local writes cannot show that its work has got anywhere, and the wrong way round
	// is a link handed to a colleague that serves last week.
	it('assumes there is something to send where nothing tracked the local writes', () => {
		expect(
			projectRemoteReach({
				directory: 'amsterdam-1625',
				baseline: lastShared('amsterdam-1625/project.json'),
				changes: null
			})
		).toEqual({ synced: true, unsent: true });
	});
});
