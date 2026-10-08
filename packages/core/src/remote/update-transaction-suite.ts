import { describe, expect, it } from 'vitest';

import { newAnnotationLayer, newMapLayer } from '../project/layer.js';
import { listWorkspaceMapImages } from '../project/map-images.js';
import { Workspace } from '../project/workspace.js';
import type { ProjectStore, StorePath } from '../store/project-store.js';
import { encode, snapshot } from '../test-support.js';
import { createFakeGitHub } from './fake-github.js';
import { ATLAS, baselineOf, projectFile } from './remote-test-support.js';
import { getFromRemote } from './get-from-remote.js';
import {
	UPDATE_BEFORE_DIRECTORY,
	UPDATE_TRANSACTION_FORMAT_VERSION,
	UPDATE_TRANSACTION_PATH,
	readUpdateTransaction,
	recoverWorkspaceUpdate,
	serialiseUpdateTransaction
} from './update-transaction.js';

export const BEFORE: Record<string, string> = {
	'amsterdam-1625/project.json': projectFile('Amsterdam 1625', [
		newMapLayer({ id: 'l1', name: 'The sheet', imageId: 'map-1' }),
		newAnnotationLayer({ id: 'l2', name: 'Warehouses' })
	]),
	'amsterdam-1625/annotations/l2.geojson': '{"type":"FeatureCollection","features":[]}',
	'delft/project.json': projectFile('Delft 1650', [
		newAnnotationLayer({ id: 'l3', name: 'Canals' })
	]),
	'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/map-1/info.json': '{"width":1024,"height":768}',
	'images/map-1/0/0/0.jpg': 'tile-zero'
};

export const REMOTE_CHANGES: Record<string, string | null> = {
	'amsterdam-1625/project.json': null,
	'amsterdam-1625/annotations/l2.geojson': null,
	'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":["their canal"]}',
	'images/map-1/0/0/1.jpg': 'a tile they added'
};

export const AFTER: Record<string, string> = {
	'delft/project.json': BEFORE['delft/project.json'] as string,
	'delft/annotations/l3.geojson': REMOTE_CHANGES['delft/annotations/l3.geojson'] as string,
	'images/map-1/info.json': BEFORE['images/map-1/info.json'] as string,
	'images/map-1/0/0/0.jpg': BEFORE['images/map-1/0/0/0.jpg'] as string,
	'images/map-1/0/0/1.jpg': REMOTE_CHANGES['images/map-1/0/0/1.jpg'] as string
};

export async function remoteWithChanges(
	before: Record<string, string> = BEFORE,
	changes: Record<string, string | null> = REMOTE_CHANGES
) {
	const fake = await createFakeGitHub({ ...ATLAS, tree: before });
	await fake.commitFiles(changes);
	return fake;
}

async function seed(
	open: () => Promise<ProjectStore>,
	files: Record<string, string> = BEFORE
): Promise<ProjectStore> {
	const store = await open();
	for (const [path, text] of Object.entries(files)) {
		await store.write(path as StorePath, encode(text));
	}
	return store;
}

const projectRemoval = {
	path: 'amsterdam-1625/project.json' as StorePath,
	image: `${UPDATE_BEFORE_DIRECTORY}d0` as StorePath
};

const marker = (
	workspace: string,
	state: 'writing' | 'committed',
	transaction: string,
	replaced: { path: StorePath; image: StorePath }[]
) =>
	serialiseUpdateTransaction({
		formatVersion: UPDATE_TRANSACTION_FORMAT_VERSION,
		transaction,
		workspace,
		state,
		commit: 'deadbee',
		added: ['images/map-1/0/0/1.jpg' as StorePath],
		replaced,
		deleted: [projectRemoval],
		startedAt: '2026-08-01T09:00:00.000Z'
	});

async function visible(store: ProjectStore): Promise<{ projects: string[]; mapImages: string[] }> {
	const projects = await new Workspace(store).listProjects();
	const mapImages = await listWorkspaceMapImages(store);
	return {
		projects: projects.map((project) => project.name).sort(),
		mapImages: mapImages.map((image) => image.imageId).sort()
	};
}

export function describeUpdateTransaction(name: string, open: () => Promise<ProjectStore>): void {
	describe(`getting a Remote's changes over ${name}`, () => {
		it('commits additions, replacements and deletions as one visible result', async () => {
			const store = await seed(open);
			const fake = await remoteWithChanges();

			const result = await getFromRemote(store, {
				remote: ATLAS,
				token: null,
				baseline: await baselineOf(BEFORE),
				fetch: fake.fetch
			});

			expect(await snapshot(store)).toEqual(AFTER);
			expect(result.removed).toEqual([
				'amsterdam-1625/annotations/l2.geojson',
				'amsterdam-1625/project.json'
			]);
			expect(await visible(store)).toEqual({ projects: ['Delft 1650'], mapImages: ['map-1'] });
			expect([...result.baseline.keys()].sort()).toEqual(Object.keys(AFTER).sort());
			expect(await store.list(UPDATE_BEFORE_DIRECTORY)).toEqual([]);
			expect(await readUpdateTransaction(store)).toBeNull();
		});

		it('rolls a `writing` record back to the complete Workspace it started from', async () => {
			const store = await seed(open, {
				...BEFORE,
				'delft/annotations/l3.geojson': REMOTE_CHANGES['delft/annotations/l3.geojson'] as string,
				'images/map-1/0/0/1.jpg': 'half arrived',
				[`${UPDATE_BEFORE_DIRECTORY}0`]: BEFORE['delft/annotations/l3.geojson'] as string,
				[projectRemoval.image]: BEFORE['amsterdam-1625/project.json'] as string
			});
			await store.delete(projectRemoval.path);
			await store.write(
				UPDATE_TRANSACTION_PATH,
				marker(name, 'writing', 'interrupted', [
					{
						path: 'delft/annotations/l3.geojson' as StorePath,
						image: `${UPDATE_BEFORE_DIRECTORY}0` as StorePath
					}
				])
			);

			const recovery = await recoverWorkspaceUpdate(store);
			expect(recovery).toEqual({ outcome: 'rolled-back', transaction: 'interrupted' });
			expect(await snapshot(store)).toEqual(BEFORE);
			expect(await visible(store)).toEqual({
				projects: ['Amsterdam 1625', 'Delft 1650'],
				mapImages: ['map-1']
			});
		});

		it('finishes a `committed` record forward, keeping every byte of it', async () => {
			const store = await seed(open, AFTER);
			await store.write(projectRemoval.image, encode('the Project that went'));
			await store.write(
				UPDATE_TRANSACTION_PATH,
				marker(name, 'committed', 'committed-already', [])
			);

			const recovery = await recoverWorkspaceUpdate(store);
			expect(recovery).toEqual({ outcome: 'completed', transaction: 'committed-already' });
			expect(await snapshot(store)).toEqual(AFTER);
			expect(await visible(store)).toEqual({ projects: ['Delft 1650'], mapImages: ['map-1'] });
		});
	});
}
