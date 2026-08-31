import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	ReviewWorkspaceError,
	serialiseReviewMark
} from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath, WritablePath } from '../store/project-store.js';
import { copyWorkspaceFiles } from './copy-workspace-files.js';
import type { TransferProgress } from './transfer.js';

// Seam 1: "after the move the folder holds these files with these contents, and the Workspace it came
// from holds exactly what it held" is not a proxy for moving a Workspace into a folder, it *is* it.

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const contents = async (store: MemoryProjectStore): Promise<Record<string, string>> =>
	Object.fromEntries(
		await Promise.all(
			(await store.list('')).map(async (path) => [path, decode(await store.read(path))] as const)
		)
	);

const workspace = async (files: Readonly<Record<string, string>>): Promise<MemoryProjectStore> => {
	const store = new MemoryProjectStore();
	for (const [path, text] of Object.entries(files)) {
		// alignment-write-is-the-fixture: a whole Workspace as the specimen to be copied, and no caller of this helper names an Alignment path
		await store.write(path as WritablePath, encode(text));
	}
	return store;
};

describe('copying a Workspace into a folder', () => {
	it('puts every file in the destination, byte for byte', async () => {
		const from = await workspace({
			'amsterdam-1625/project.json': '{"name":"Amsterdam 1625"}',
			'images/abc/info.json': '{"width":1}',
			'images/abc/full/max/0/default.jpg': 'jpeg bytes',
			'base-map/extract.pmtiles': 'offline base map'
		});
		const to = new MemoryProjectStore();

		const copied = await copyWorkspaceFiles({ from, to, workspaceName: 'My Workspace' });

		expect(await contents(to)).toEqual(await contents(from));
		expect(copied).toEqual({ files: 4, bytes: 62 });
	});

	it('leaves the Workspace it came from exactly as it was', async () => {
		const from = await workspace({ 'atlas/project.json': '{"name":"Atlas"}' });
		const before = await contents(from);

		await copyWorkspaceFiles({ from, to: new MemoryProjectStore(), workspaceName: 'Atlas' });

		expect(await contents(from)).toEqual(before);
	});

	it('copies an Alignment, which only one writer may write (ADR-0023)', async () => {
		const from = new MemoryProjectStore();
		// alignment-write-is-the-fixture: the Alignment the source Workspace holds, which is the specimen the copy has to carry over through the one writer
		await from.write(alignmentPath('abc') as unknown as WritablePath, encode('{"gcps":[]}'));
		const to = new MemoryProjectStore();

		await copyWorkspaceFiles({ from, to, workspaceName: 'Atlas' });

		expect(decode(await to.read(alignmentPath('abc')))).toBe('{"gcps":[]}');
	});

	it('refuses a folder that already holds a file, and writes nothing at all', async () => {
		const from = await workspace({ 'atlas/project.json': '{"name":"Atlas"}' });
		const to = await workspace({ 'notes.txt': "somebody else's" });

		await expect(copyWorkspaceFiles({ from, to, workspaceName: 'Atlas' })).rejects.toThrow(
			/already holds files.*“Atlas” was not moved/s
		);

		expect(await contents(to)).toEqual({ 'notes.txt': "somebody else's" });
	});

	it('refuses a review copy, so somebody else’s work never lands in a folder', async () => {
		const from = await workspace({ 'amsterdam-1625/project.json': '{"name":"Amsterdam 1625"}' });
		await from.write(
			// alignment-write-is-the-fixture: the review mark, which is `review.json` and no Alignment at all — the cast is the store's WritablePath brand and nothing else
			REVIEW_MARK_PATH as WritablePath,
			serialiseReviewMark({
				formatVersion: REVIEW_MARK_FORMAT_VERSION,
				project: 'Amsterdam 1625',
				directory: 'amsterdam-1625',
				openedAt: '2026-01-01T00:00:00.000Z',
				origin: null
			})
		);
		const to = new MemoryProjectStore();

		await expect(copyWorkspaceFiles({ from, to, workspaceName: 'assignment 7' })).rejects.toThrow(
			ReviewWorkspaceError
		);

		expect(await to.list('')).toEqual([]);
	});

	it('announces per-file progress against a real denominator', async () => {
		const from = await workspace({ 'a/project.json': 'aa', 'b/project.json': 'bbb' });
		const seen: TransferProgress[] = [];

		await copyWorkspaceFiles({
			from,
			to: new MemoryProjectStore(),
			workspaceName: 'Atlas',
			onProgress: (progress) => seen.push(progress)
		});

		expect(seen).toEqual([
			{ files: 0, totalFiles: 2, bytes: 0, totalBytes: 5, path: null },
			{ files: 1, totalFiles: 2, bytes: 2, totalBytes: 5, path: 'a/project.json' },
			{ files: 2, totalFiles: 2, bytes: 5, totalBytes: 5, path: 'b/project.json' },
			{ files: 2, totalFiles: 2, bytes: 5, totalBytes: 5, path: null }
		]);
	});

	it('copies an empty Workspace as an empty folder rather than refusing', async () => {
		const to = new MemoryProjectStore();

		const copied = await copyWorkspaceFiles({
			from: new MemoryProjectStore(),
			to,
			workspaceName: 'Atlas'
		});

		expect(copied).toEqual({ files: 0, bytes: 0 });
		expect(await to.list('')).toEqual([] as StorePath[]);
	});
});
