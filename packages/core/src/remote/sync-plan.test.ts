import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { createFakeGitHub } from './fake-github.js';
import { planRemoteSend, type RemoteRepository } from './send-to-remote.js';
import { describeChanges, describeSyncPlan } from './sync-plan.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import { gitBlobSha } from './blob-sha.js';

// The claim this file exists for: **a Sync of one map is one line of text.** So the assertions are on
// what a reader would see — which Projects and Map Images are named, and with what counts — and on
// the negative that no test elsewhere can make: that nothing a column carries is a path.

const REMOTE: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };
const TOKEN = 'ghp_a-token';

const encode = (text: string): Bytes => new TextEncoder().encode(text);

const seeded = async (files: Record<string, string>): Promise<MemoryProjectStore> => {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(files)) await store.write(path, encode(content));
	return store;
};

/** A Map Image's pyramid, at the scale that makes a path list unreadable. */
const pyramid = (imageId: string, tiles: number): Record<string, string> => {
	const files: Record<string, string> = {
		[`images/${imageId}/info.json`]: '{"width":8192,"height":8192}',
		// alignment-write-is-the-fixture: a path in a list of paths, which is the whole input the grouping under test takes
		[`alignments/${imageId}.json`]: '{"formatVersion":1,"controlPoints":[]}'
	};
	for (let index = 0; index < tiles; index += 1) {
		files[`images/${imageId}/0/0/${index}.jpg`] = `tile-${index}`;
	}
	return files;
};

const NAMES = new Map([
	['amsterdam-1625', 'Amsterdam 1625'],
	['delft', 'Delft 1650']
]);

describe('naming what a Sync would move', () => {
	it('names one Map Image for its whole pyramid and its Alignment', () => {
		expect(describeChanges(Object.keys(pyramid('map-1', 4000)))).toEqual([
			{ kind: 'map-image', id: 'map-1', name: 'map-1', files: 4002 }
		]);
	});

	it('names a Project by the name its author gave it, and its directory otherwise', () => {
		const changes = describeChanges(
			[
				'amsterdam-1625/project.json',
				'amsterdam-1625/annotations/l2.geojson',
				'florida-1657/project.json'
			],
			NAMES
		);

		expect(changes).toEqual([
			{ kind: 'project', id: 'amsterdam-1625', name: 'Amsterdam 1625', files: 2 },
			// A Project only the Remote holds has no `project.json` here to read a name out of, and the
			// directory is what its tree calls it (ADR-0008).
			{ kind: 'project', id: 'florida-1657', name: 'florida-1657', files: 1 }
		]);
	});

	it('names the Base Map’s offline tiles as one thing', () => {
		expect(
			describeChanges(['base-map/tiles/physical/1/2/3.png', 'base-map/tiles/physical/1/2/4.png'])
		).toEqual([
			{ kind: 'base-map', id: 'base-map', name: 'The Base Map’s offline tiles', files: 2 }
		]);
	});

	// ⚠ **The negative that keeps a path off the screen.** Every source path belongs to a Map Image,
	// to the Base Map's tiles, or to a Project, so a grouping that fell through would put a raw path
	// in a column. Asserted over the whole source namespace at once.
	it('leaves no path ungrouped anywhere in the source namespace', () => {
		const changes = describeChanges([
			...Object.keys(pyramid('map-1', 2)),
			'base-map/tiles/physical/1/2/3.png',
			'amsterdam-1625/project.json',
			'amsterdam-1625/annotations/l2.geojson'
		]);

		expect(changes.map((change) => change.name)).toEqual([
			'map-1',
			'The Base Map’s offline tiles',
			'amsterdam-1625'
		]);
		for (const change of changes) expect(change.name).not.toContain('/');
	});
});

describe('the two columns one plan answers for', () => {
	const WORKSPACE = {
		'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam 1625"}',
		'amsterdam-1625/annotations/notes.json': '{"type":"FeatureCollection","features":[]}'
	};

	const forecast = async (
		files: Record<string, string>,
		tree: Record<string, string>,
		baseline: SynchronizationBaseline | null
	) => {
		const store = await seeded(files);
		const github = await createFakeGitHub({ ...REMOTE, tree });
		return describeSyncPlan(
			await planRemoteSend(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				baseline
			}),
			NAMES
		);
	};

	/** What the two sides agreed on last, as a Baseline over exactly the given files. */
	const agreed = async (files: Record<string, string>): Promise<SynchronizationBaseline> => {
		const entries = await Promise.all(
			Object.entries(files).map(
				async ([path, content]) => [path, await gitBlobSha(encode(content))] as const
			)
		);
		return { remote: REMOTE, commit: 'c0ffee', files: new Map(entries) };
	};

	it('puts what only the Workspace has under To send', async () => {
		const plan = await forecast(WORKSPACE, { 'README.md': '# Atlas\n' }, null);

		expect(plan.toSend.added).toEqual([
			{ kind: 'project', id: 'amsterdam-1625', name: 'Amsterdam 1625', files: 2 }
		]);
		expect(plan.toGet.added).toEqual([]);
	});

	it('puts what only the Remote has under To get, and removes nothing either way', async () => {
		const plan = await forecast(
			WORKSPACE,
			{ ...WORKSPACE, 'delft/project.json': '{"formatVersion":1,"name":"Delft 1650"}' },
			null
		);

		expect(plan.toGet.added).toEqual([
			{ kind: 'project', id: 'delft', name: 'Delft 1650', files: 1 }
		]);
		expect(plan.toGet.removed).toEqual([]);
		expect(plan.toSend.removed).toEqual([]);
		// Both sides hold the Workspace's own Project at the same bytes, so it is in neither column.
		expect(plan.toSend.added).toEqual([]);
		expect(plan.toSend.changed).toEqual([]);
	});

	it('names what a send would remove, once the Baseline licenses it', async () => {
		const shared = { ...WORKSPACE, ...pyramid('map-1', 3) };
		const plan = await forecast(WORKSPACE, shared, await agreed(shared));

		expect(plan.toSend.removed).toEqual([
			{ kind: 'map-image', id: 'map-1', name: 'map-1', files: 5 }
		]);
	});

	it('names what an overwrite would remove, from the Workspace alone', async () => {
		const plan = await forecast(
			WORKSPACE,
			{ ...WORKSPACE, 'delft/project.json': '{"formatVersion":1,"name":"Delft 1650"}' },
			null
		);

		expect(plan.overwrites).toEqual([
			{ kind: 'project', id: 'delft', name: 'Delft 1650', files: 1 }
		]);
	});

	it('reports a path changed on both sides as a Conflict rather than in either column', async () => {
		const shared = { ...WORKSPACE };
		const baseline = await agreed(shared);
		const plan = await forecast(
			{ ...WORKSPACE, 'amsterdam-1625/annotations/notes.json': '{"features":["mine"]}' },
			{ ...WORKSPACE, 'amsterdam-1625/annotations/notes.json': '{"features":["theirs"]}' },
			baseline
		);

		expect(plan.conflicts.map((row) => row.path)).toEqual([
			'amsterdam-1625/annotations/notes.json'
		]);
		expect(plan.toGet.changed).toEqual([]);
		expect(plan.toSend.changed).toEqual([]);
	});

	it('carries the request budget and what a send would move', async () => {
		const plan = await forecast(WORKSPACE, { 'README.md': '# Atlas\n' }, null);

		expect(plan.size.files).toBe(2);
		expect(plan.size.bytes).toBeGreaterThan(0);
		expect(plan.budget.requests).toBe(2);
		expect(plan.budget.remaining).toBeGreaterThan(0);
	});
});
