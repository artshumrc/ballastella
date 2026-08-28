// One Update from GitHub, run against a real backing, and asserted the same way for every backing
// there is.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SUITE RATHER THAN A TEST IN EACH FILE
//
// Browser storage and a chosen folder are two `DirectoryHandleStore`s, and the whole claim of
// ADR-0001 is that the operation above them cannot tell which it has. A transaction is where that
// claim is least obvious and most expensive to get wrong: a rollback puts bytes back through the same
// two-step write a real folder does, a deletion removes a file a synchronizing folder client may be
// watching, and the before-images live at paths a folder shows to whoever opens it. Written twice,
// one of the two copies drifts; written here, both backings answer the *same* questions — the
// committed file set, the recovery a durable phase chooses, the Project and Map Image lists a reader
// would see, and the Baseline.
//
// The engine itself is exhausted at Seam 1 in `update-transaction.test.ts` against the memory store,
// including the fault matrix. What this adds is the real filesystem underneath it.
//
// Not a `*.test.ts` file, so Vitest does not collect it: the browser test files that own a backing
// call {@link describeUpdateTransaction} with it.

import { describe, expect, it } from 'vitest';

import { newAnnotationLayer, newMapLayer } from '../project/layer.js';
import { newProjectFile, serialiseProjectFile } from '../project/project-file.js';
import { listWorkspaceMapImages } from '../project/map-images.js';
import { Workspace } from '../project/workspace.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub } from './fake-github.js';
import type { RemoteRelationship, SynchronizationBaseline } from './synchronization-metadata.js';
import {
	UPDATE_BEFORE_DIRECTORY,
	UPDATE_TRANSACTION_FORMAT_VERSION,
	UPDATE_TRANSACTION_PATH,
	readUpdateTransaction,
	recoverWorkspaceUpdate,
	serialiseUpdateTransaction,
	updateFromGitHub
} from './update-from-github.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE: RemoteRelationship = { owner: OWNER, repository: REPOSITORY, branch: 'main' };

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const projectFile = (
	name: string,
	layers: Parameters<typeof serialiseProjectFile>[0]['layers'] = []
): string =>
	decode(serialiseProjectFile({ ...newProjectFile(name, new Date('2026-01-01')), layers }));

/** Two Projects and a Map Image, as both sides hold them before anything changes. */
const BEFORE: Record<string, string> = {
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

/** A Project deleted on the Remote, a file replaced, a file added: the three kinds at once. */
const REMOTE_CHANGES: Record<string, string | null> = {
	'amsterdam-1625/project.json': null,
	'amsterdam-1625/annotations/l2.geojson': null,
	'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":["their canal"]}',
	'images/map-1/0/0/1.jpg': 'a tile they added'
};

/** The complete Workspace the Update leaves. */
const AFTER: Record<string, string> = {
	'delft/project.json': BEFORE['delft/project.json'] as string,
	'delft/annotations/l3.geojson': REMOTE_CHANGES['delft/annotations/l3.geojson'] as string,
	'images/map-1/info.json': BEFORE['images/map-1/info.json'] as string,
	'images/map-1/0/0/0.jpg': BEFORE['images/map-1/0/0/0.jpg'] as string,
	'images/map-1/0/0/1.jpg': REMOTE_CHANGES['images/map-1/0/0/1.jpg'] as string
};

const REMOVED = ['amsterdam-1625/annotations/l2.geojson', 'amsterdam-1625/project.json'] as const;

/**
 * The backing a run of this suite is given.
 *
 * A fresh, empty Workspace each time — the same contract `describeProjectStore` asks for, and for the
 * same reason: a transaction that left something behind must be visible as *this* run's residue.
 */
export type UpdateBacking = () => Promise<ProjectStore>;

/** Every path in a store with its bytes as text. Temporary files and markers included. */
async function snapshot(store: ProjectStore): Promise<Record<string, string>> {
	const held: Record<string, string> = {};
	for (const path of await store.list('')) held[path] = decode(await store.read(path));
	return held;
}

async function seed(open: UpdateBacking): Promise<ProjectStore> {
	const store = await open();
	for (const [path, text] of Object.entries(BEFORE)) {
		// alignment-write-is-the-fixture: seeding the Workspace the Update runs over, not a write under test
		await store.write(path as StorePath, encode(text));
	}
	return store;
}

const shas = async (files: Record<string, string>): Promise<Map<string, string>> => {
	const map = new Map<string, string>();
	for (const [path, text] of Object.entries(files)) map.set(path, await gitBlobSha(encode(text)));
	return map;
};

const baseline = async (): Promise<SynchronizationBaseline> => ({
	remote: REMOTE,
	commit: 'c0ffee',
	files: await shas(BEFORE)
});

/** Which Projects and Map Images a reader of this Workspace would see, in the app's own words. */
async function visible(store: ProjectStore): Promise<{ projects: string[]; mapImages: string[] }> {
	const projects = await new Workspace(store).listProjects();
	const mapImages = await listWorkspaceMapImages(store);
	return {
		projects: projects.map((project) => project.name).sort(),
		mapImages: mapImages.map((image) => image.imageId).sort()
	};
}

/**
 * The whole of Update from GitHub over one real backing, asserted identically for each of them.
 *
 * @param name what the backing is called, for the test names
 * @param open a fresh, empty Workspace on that backing
 */
export function describeUpdateTransaction(name: string, open: UpdateBacking): void {
	describe(`Update from GitHub over ${name}`, () => {
		const remoteWithChanges = async () => {
			const fake = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: BEFORE });
			await fake.commitFiles(REMOTE_CHANGES);
			return fake;
		};

		it('commits additions, replacements and confirmed deletions as one visible result', async () => {
			const store = await seed(open);
			const fake = await remoteWithChanges();

			const result = await updateFromGitHub(store, {
				remote: REMOTE,
				baseline: await baseline(),
				fetch: fake.fetch,
				confirmDeletion: () => true
			});

			expect(await snapshot(store)).toEqual(AFTER);
			expect(result.removed).toEqual([...REMOVED]);
			// The lists a reader sees, from the enumerators the application enumerates with.
			expect(await visible(store)).toEqual({ projects: ['Delft 1650'], mapImages: ['map-1'] });
			// The Baseline is exactly the committed Workspace: nothing about the Project that went.
			expect([...result.baseline.keys()].sort()).toEqual(Object.keys(AFTER).sort());
			// And no transaction artifact survives a success, on a backing where one would be a file in
			// somebody's folder.
			expect(await store.list(UPDATE_BEFORE_DIRECTORY)).toEqual([]);
			expect(await readUpdateTransaction(store)).toBeNull();
		});

		it('refuses without a confirmation and leaves the Workspace byte for byte', async () => {
			const store = await seed(open);
			const fake = await remoteWithChanges();
			const before = await snapshot(store);

			await expect(
				updateFromGitHub(store, {
					remote: REMOTE,
					baseline: await baseline(),
					fetch: fake.fetch,
					confirmDeletion: () => false
				})
			).rejects.toThrow();

			expect(await snapshot(store)).toEqual(before);
			expect(await visible(store)).toEqual({
				projects: ['Amsterdam 1625', 'Delft 1650'],
				mapImages: ['map-1']
			});
			expect(await readUpdateTransaction(store)).toBeNull();
		});

		it('rolls a `writing` record back to the complete Workspace it started from', async () => {
			// The state a tab that died mid-transfer leaves: one path replaced, one added, one removed,
			// and a before-image of each of the two it displaced.
			const store = await seed(open);
			await store.write(
				'delft/annotations/l3.geojson' as StorePath,
				encode(REMOTE_CHANGES['delft/annotations/l3.geojson'] as string)
			);
			await store.write('images/map-1/0/0/1.jpg' as StorePath, encode('half arrived'));
			await store.write(
				`${UPDATE_BEFORE_DIRECTORY}0` as StorePath,
				encode(BEFORE['delft/annotations/l3.geojson'] as string)
			);
			await store.write(
				`${UPDATE_BEFORE_DIRECTORY}d0` as StorePath,
				encode(BEFORE['amsterdam-1625/project.json'] as string)
			);
			await store.delete('amsterdam-1625/project.json' as StorePath);
			// alignment-write-is-the-fixture: seeding the interrupted Update's own marker, not a write under test
			await store.write(
				UPDATE_TRANSACTION_PATH,
				serialiseUpdateTransaction({
					formatVersion: UPDATE_TRANSACTION_FORMAT_VERSION,
					transaction: 'interrupted',
					workspace: name,
					state: 'writing',
					commit: 'deadbee',
					added: ['images/map-1/0/0/1.jpg' as StorePath],
					replaced: [
						{
							path: 'delft/annotations/l3.geojson' as StorePath,
							image: `${UPDATE_BEFORE_DIRECTORY}0` as StorePath
						}
					],
					deleted: [
						{
							path: 'amsterdam-1625/project.json' as StorePath,
							image: `${UPDATE_BEFORE_DIRECTORY}d0` as StorePath
						}
					],
					startedAt: '2026-08-01T09:00:00.000Z'
				})
			);

			const recovery = await recoverWorkspaceUpdate(store);

			expect(recovery).toEqual({ outcome: 'rolled-back', transaction: 'interrupted' });
			expect(await snapshot(store)).toEqual(BEFORE);
			// ⚠ **The Project is back in the list**, which is the claim a path-level assertion cannot
			// make: a rollback that restored the bytes and not the manifest is a Workspace whose files are
			// all present and whose Project list is short by one.
			expect(await visible(store)).toEqual({
				projects: ['Amsterdam 1625', 'Delft 1650'],
				mapImages: ['map-1']
			});
		});

		it('finishes a `committed` record forward, keeping every byte of it', async () => {
			const store = await open();
			for (const [path, text] of Object.entries(AFTER)) {
				// alignment-write-is-the-fixture: seeding the state a committed Update had already reached
				await store.write(path as StorePath, encode(text));
			}
			await store.write(
				`${UPDATE_BEFORE_DIRECTORY}d0` as StorePath,
				encode('the Project that went')
			);
			// alignment-write-is-the-fixture: seeding a committed marker, not a write under test
			await store.write(
				UPDATE_TRANSACTION_PATH,
				serialiseUpdateTransaction({
					formatVersion: UPDATE_TRANSACTION_FORMAT_VERSION,
					transaction: 'committed-already',
					workspace: name,
					state: 'committed',
					commit: 'deadbee',
					added: ['images/map-1/0/0/1.jpg' as StorePath],
					replaced: [],
					deleted: [
						{
							path: 'amsterdam-1625/project.json' as StorePath,
							image: `${UPDATE_BEFORE_DIRECTORY}d0` as StorePath
						}
					],
					startedAt: '2026-08-01T09:00:00.000Z'
				})
			);

			const recovery = await recoverWorkspaceUpdate(store);

			expect(recovery).toEqual({ outcome: 'completed', transaction: 'committed-already' });
			// ⚠ **Forward, not back.** The before-image is still on disk and the deleted Project could be
			// put back from it — and must not be: every inbound path is durable, so the Update succeeded.
			expect(await snapshot(store)).toEqual(AFTER);
			expect(await visible(store)).toEqual({ projects: ['Delft 1650'], mapImages: ['map-1'] });
		});
	});
}
