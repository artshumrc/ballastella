import { describe, expect, it } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	ReviewWorkspaceError,
	serialiseReviewMark
} from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { WritablePath } from '../store/project-store.js';
import { decode, encode, seeded, snapshot } from '../test-support.js';
import { copyWorkspaceFiles } from './copy-workspace-files.js';
import type { TransferProgress } from './transfer.js';

describe('copying a Workspace into a folder', () => {
	it('puts every file in the destination, byte for byte', async () => {
		const from = await seeded({
			'amsterdam-1625/project.json': '{"name":"Amsterdam 1625"}',
			'images/abc/info.json': '{"width":1}',
			'images/abc/full/max/0/default.jpg': 'jpeg bytes',
			'base-map/extract.pmtiles': 'offline base map'
		});
		const to = new MemoryProjectStore();
		const copied = await copyWorkspaceFiles({ from, to, workspaceName: 'My Workspace' });
		expect(await snapshot(to)).toEqual(await snapshot(from));
		expect(copied).toEqual({ files: 4, bytes: 62 });
	});

	it('leaves the Workspace it came from exactly as it was', async () => {
		const from = await seeded({ 'atlas/project.json': '{"name":"Atlas"}' });
		const before = await snapshot(from);

		await copyWorkspaceFiles({ from, to: new MemoryProjectStore(), workspaceName: 'Atlas' });

		expect(await snapshot(from)).toEqual(before);
	});

	it('copies an Alignment, which only one writer may write (ADR-0023)', async () => {
		const from = new MemoryProjectStore();
		await from.write(alignmentPath('abc') as unknown as WritablePath, encode('{"gcps":[]}'));
		const to = new MemoryProjectStore();

		await copyWorkspaceFiles({ from, to, workspaceName: 'Atlas' });

		expect(decode(await to.read(alignmentPath('abc')))).toBe('{"gcps":[]}');
	});

	it('refuses a folder that already holds a file, and writes nothing at all', async () => {
		const from = await seeded({ 'atlas/project.json': '{"name":"Atlas"}' });
		const to = await seeded({ 'notes.txt': "somebody else's" });

		await expect(copyWorkspaceFiles({ from, to, workspaceName: 'Atlas' })).rejects.toThrow(
			/already holds files.*“Atlas” was not moved/s
		);

		expect(await snapshot(to)).toEqual({ 'notes.txt': "somebody else's" });
	});

	it('refuses a review copy, so somebody else’s work never lands in a folder', async () => {
		const from = await seeded({ 'amsterdam-1625/project.json': '{"name":"Amsterdam 1625"}' });
		await from.write(
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
		const from = await seeded({ 'a/project.json': 'aa', 'b/project.json': 'bbb' });
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
		expect(await to.list('')).toEqual([]);
	});
});
