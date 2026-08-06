import { describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX } from '../store/project-store.js';
import {
	STATIC_HOSTING_LIMIT_BYTES,
	crossesHostingLimit,
	describeBytes,
	hostingLimitWarning,
	workspaceSize
} from './workspace-size.js';

const filled = async (files: Record<string, number>): Promise<MemoryProjectStore> => {
	const store = new MemoryProjectStore();
	for (const [path, bytes] of Object.entries(files)) {
		await store.write(path, new Uint8Array(bytes));
	}
	return store;
};

describe('workspaceSize', () => {
	it('totals every file in the Workspace', async () => {
		const store = await filled({
			'amsterdam-1625/project.json': 100,
			'amsterdam-1625/images/a/info.json': 20,
			'amsterdam-1625/images/a/0,0,256,256/256,256/0/default.jpg': 3000,
			'florida-1657/project.json': 80
		});

		expect(await workspaceSize(store)).toEqual({ bytes: 3200, files: 4 });
	});

	it('totals one Project when given its prefix', async () => {
		const store = await filled({
			'amsterdam-1625/project.json': 100,
			'florida-1657/project.json': 80
		});

		expect(await workspaceSize(store, 'amsterdam-1625/')).toEqual({ bytes: 100, files: 1 });
	});

	it('is zero for an empty Workspace rather than a failure', async () => {
		expect(await workspaceSize(new MemoryProjectStore())).toEqual({ bytes: 0, files: 0 });
	});

	it('never reads a file', async () => {
		// ADR-0001 put `size` in the interface for exactly this: a mirrored pyramid is thousands of
		// tiles, and summing it by reading every one of them would be the slowest possible way to
		// answer a question both real backends answer from directory metadata. A version of this
		// written with `read` would pass every other assertion in this file, so the spy is the
		// guard — the same one `project-store-suite.ts` puts on `size` itself.
		const store = await filled({
			'p/project.json': 100,
			'p/images/a/0,0,256,256/256,256/0/default.jpg': 4096,
			'p/images/a/256,0,256,256/256,256/0/default.jpg': 4096
		});
		const read = vi.spyOn(store, 'read');

		expect(await workspaceSize(store)).toEqual({ bytes: 8292, files: 3 });
		expect(read).not.toHaveBeenCalled();
	});

	it('deletes nothing, not even the litter it cannot count', async () => {
		// This used to sweep abandoned writes before totalling, so that the number was exact rather than
		// a floor. It is a **measurement**, reached from a button a user presses while an autosave or an
		// ingest may be part way through its own two-step write — and the sweep deletes every temporary
		// path unconditionally, so one firing at the wrong moment took another write's temporary file
		// with it and failed a save. The litter is swept at Workspace adoption instead, where nothing
		// else is writing.
		const store = await filled({ 'p/project.json': 100 });
		store.plant(`p/images/a/tile.jpg${TEMP_PATH_SUFFIX}`, new Uint8Array(5000));
		store.plant(`p/images/a/tile.jpg${TEMP_PATH_SUFFIX}.crswap`, new Uint8Array(6000));

		// A floor: `list` hides both, so neither is in the total.
		expect(await workspaceSize(store)).toEqual({ bytes: 100, files: 1 });
		// And both are still on the disk, because a half-written file may be one somebody is writing now.
		expect([...store.snapshot().keys()].sort()).toEqual([
			`p/images/a/tile.jpg${TEMP_PATH_SUFFIX}`,
			`p/images/a/tile.jpg${TEMP_PATH_SUFFIX}.crswap`,
			'p/project.json'
		]);
	});

	it('does not disturb a write that is in flight while it counts', async () => {
		// The failure the sweep could cause, from the outside: a write interrupted between its two steps
		// has a temporary file on the disk under the same prefix, and the total must still be a total
		// when that write resumes.
		const store = await filled({ 'p/project.json': 100 });
		const temp = `p/.project.json.abc${TEMP_PATH_SUFFIX}`;
		store.plant(temp, new Uint8Array(4000));

		await workspaceSize(store);

		expect(store.snapshot().has(temp)).toBe(true);
	});
});

describe('the ADR-0008 hosting limit', () => {
	it('is the ~1 GB GitHub Pages budget', () => {
		expect(STATIC_HOSTING_LIMIT_BYTES).toBe(1_000_000_000);
	});

	it('is not crossed by a copy that stays under it', () => {
		expect(crossesHostingLimit(400_000_000, 500_000_000)).toBe(false);
		expect(hostingLimitWarning(400_000_000, 500_000_000)).toBe('');
	});

	it('is crossed by a copy that takes the total past it, even from well under', () => {
		expect(crossesHostingLimit(200_000_000, 900_000_000)).toBe(true);
	});

	it('is crossed by any copy at all once the Workspace is already over', () => {
		expect(crossesHostingLimit(1_200_000_000, 1_000)).toBe(true);
	});

	it('warns in bytes a person can read, naming the limit and both numbers', () => {
		const warning = hostingLimitWarning(900_000_000, 300_000_000);

		expect(warning).toContain('900 MB');
		expect(warning).toContain('300 MB');
		expect(warning).toContain('1.0 GB');
		// Information, not a gate (ADR-0007, and the ticket says so in as many words).
		expect(warning).toMatch(/can still|may still|proceed/i);
	});

	it('says a Workspace already over the limit is already over it', () => {
		expect(hostingLimitWarning(1_400_000_000, 10_000_000)).toContain('already');
	});
});

describe('describeBytes', () => {
	it('reads in the units the number is actually in', () => {
		expect(describeBytes(0)).toBe('0 bytes');
		expect(describeBytes(940)).toBe('940 bytes');
		expect(describeBytes(12_800)).toBe('13 kB');
		expect(describeBytes(4_600_000)).toBe('4.6 MB');
		expect(describeBytes(310_000_000)).toBe('310 MB');
		expect(describeBytes(2_400_000_000)).toBe('2.4 GB');
	});

	it('does not round a real number of bytes down to nothing', () => {
		// "0 MB" beside a copy that is doing something reads as a bug in the app.
		expect(describeBytes(1)).toBe('1 byte');
		expect(describeBytes(1024)).toBe('1.0 kB');
	});
});
