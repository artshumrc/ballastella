import { describe, expect, it } from 'vitest';

import { seeded } from '../test-support.js';
import { createFakeGitHub } from './fake-github.js';
import { ATLAS as REMOTE, baselineOf } from './remote-test-support.js';
import { planRemoteSend } from './send-to-remote.js';
import { describeChanges, describeSyncPlan } from './sync-plan.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';

const TOKEN = 'ghp_a-token';

const pyramid = (imageId: string, tiles: number): Record<string, string> => {
	const files: Record<string, string> = {
		[`images/${imageId}/info.json`]: '{"width":8192,"height":8192}',
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
		const plan = await planRemoteSend(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch,
			baseline
		});
		return describeSyncPlan(plan, NAMES);
	};

	const WITH_DELFT = {
		...WORKSPACE,
		'delft/project.json': '{"formatVersion":1,"name":"Delft 1650"}'
	};

	it('puts what only the Workspace has under To send, with the request budget it would cost', async () => {
		const plan = await forecast(WORKSPACE, { 'README.md': '# Atlas\n' }, null);

		expect(plan.toSend.added).toEqual([
			{ kind: 'project', id: 'amsterdam-1625', name: 'Amsterdam 1625', files: 2 }
		]);
		expect(plan.toGet.added).toEqual([]);
		expect(plan.size.files).toBe(2);
		expect(plan.size.bytes).toBeGreaterThan(0);
		expect(plan.budget.requests).toBe(5);
		expect(plan.budget.remaining).toBeGreaterThan(0);
	});

	it('puts what only the Remote has under To get, removes nothing, and names what an overwrite would remove', async () => {
		const plan = await forecast(WORKSPACE, WITH_DELFT, null);
		const delft = [{ kind: 'project', id: 'delft', name: 'Delft 1650', files: 1 }];

		expect(plan.toGet.added).toEqual(delft);
		expect(plan.overwrites).toEqual(delft);
		expect(plan.toGet.removed).toEqual([]);
		expect(plan.toSend.removed).toEqual([]);
		expect(plan.toSend.added).toEqual([]);
		expect(plan.toSend.changed).toEqual([]);
	});

	it('names what a send would remove, once the Baseline licenses it', async () => {
		const shared = { ...WORKSPACE, ...pyramid('map-1', 3) };
		const plan = await forecast(WORKSPACE, shared, await baselineOf(shared));

		expect(plan.toSend.removed).toEqual([
			{ kind: 'map-image', id: 'map-1', name: 'map-1', files: 5 }
		]);
	});

	it('reports a path changed on both sides as a Conflict rather than in either column', async () => {
		const baseline = await baselineOf(WORKSPACE);
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
});
