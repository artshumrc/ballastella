import { describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX, type Bytes } from '../store/project-store.js';
import { seeded } from '../test-support.js';
import {
	STATIC_HOSTING_LIMIT_BYTES,
	crossesHostingLimit,
	describeBytes,
	hostingLimitWarning,
	workspaceSize
} from './workspace-size.js';

const filled = (files: Record<string, number>): Promise<MemoryProjectStore> =>
	seeded(
		Object.fromEntries(
			Object.entries(files).map(([path, bytes]) => [path, new Uint8Array(bytes) as Bytes])
		)
	);

describe('workspaceSize', () => {
	it('totals every file in the Workspace, or one Project given its prefix', async () => {
		const store = await filled({
			'amsterdam-1625/project.json': 100,
			'images/a/info.json': 20,
			'images/a/0,0,256,256/256,256/0/default.jpg': 3000,
			'florida-1657/project.json': 80
		});

		expect(await workspaceSize(store)).toEqual({ bytes: 3200, files: 4 });
		expect(await workspaceSize(store, 'amsterdam-1625/')).toEqual({ bytes: 100, files: 1 });
	});

	it('is zero for an empty Workspace rather than a failure', async () => {
		expect(await workspaceSize(new MemoryProjectStore())).toEqual({ bytes: 0, files: 0 });
	});

	it('never reads a file', async () => {
		const store = await filled({
			'p/project.json': 100,
			'images/a/0,0,256,256/256,256/0/default.jpg': 4096,
			'images/a/256,0,256,256/256,256/0/default.jpg': 4096
		});
		const read = vi.spyOn(store, 'read');
		expect(await workspaceSize(store)).toEqual({ bytes: 8292, files: 3 });
		expect(read).not.toHaveBeenCalled();
	});

	it('deletes nothing, not even the litter or in-flight writes it cannot count', async () => {
		const store = await filled({ 'p/project.json': 100 });
		const litter = [
			`images/a/tile.jpg${TEMP_PATH_SUFFIX}`,
			`images/a/tile.jpg${TEMP_PATH_SUFFIX}.crswap`,
			`p/.project.json.abc${TEMP_PATH_SUFFIX}`
		];
		for (const path of litter) store.plant(path, new Uint8Array(5000));
		expect(await workspaceSize(store)).toEqual({ bytes: 100, files: 1 });
		expect([...store.snapshot().keys()].sort()).toEqual([...litter, 'p/project.json'].sort());
	});
});

describe('the ADR-0008 hosting limit', () => {
	it('is the ~1 GB GitHub Pages budget', () => {
		expect(STATIC_HOSTING_LIMIT_BYTES).toBe(1_000_000_000);
	});

	it('is crossed only by a copy that takes the total past it', () => {
		expect(crossesHostingLimit(400_000_000, 500_000_000)).toBe(false);
		expect(hostingLimitWarning(400_000_000, 500_000_000)).toBe('');
		expect(crossesHostingLimit(200_000_000, 900_000_000)).toBe(true);
		expect(crossesHostingLimit(1_200_000_000, 1_000)).toBe(true);
	});

	it('warns in bytes a person can read, naming the limit and both numbers', () => {
		const warning = hostingLimitWarning(900_000_000, 300_000_000);
		expect(warning).toContain('900 MB');
		expect(warning).toContain('300 MB');
		expect(warning).toContain('1.0 GB');
		expect(warning).toMatch(/can still|may still|proceed/i);
		expect(hostingLimitWarning(1_400_000_000, 10_000_000)).toContain('already');
	});
});

describe('describeBytes', () => {
	it.each([
		[0, '0 bytes'],
		[1, '1 byte'],
		[940, '940 bytes'],
		[1024, '1.0 kB'],
		[12_800, '13 kB'],
		[4_600_000, '4.6 MB'],
		[310_000_000, '310 MB'],
		[2_400_000_000, '2.4 GB']
	])('reads %d as %s', (bytes, text) => {
		expect(describeBytes(bytes)).toBe(text);
	});
});
