import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidPathError, PathNotFoundError, type ProjectStore } from './project-store.js';

/**
 * The behaviour every {@link ProjectStore} backend owes its callers, run against each of
 * them unchanged.
 *
 * This is the load-bearing artefact of the storage layer, not a convenience. Ticket 12's
 * File System Access adapter has to pass this suite **with no changes to the suite**: if a
 * backend needs the interface widened or an assertion relaxed, that is evidence the
 * interface was shaped around whichever backend was written first, and the fix belongs in
 * the interface (ADR-0001).
 *
 * @param name how the backend is described in test output
 * @param createStore a fresh, empty store per test
 */
export function describeProjectStore(
	name: string,
	createStore: () => Promise<ProjectStore> | ProjectStore
): void {
	describe(name, () => {
		let store: ProjectStore;
		const utf8 = new TextEncoder();

		beforeEach(async () => {
			store = await createStore();
		});

		describe('reading and writing', () => {
			it('reads back exactly the bytes written', async () => {
				const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
				await store.write('amsterdam-1625/project.json', bytes);

				expect(await store.read('amsterdam-1625/project.json')).toEqual(bytes);
			});

			it('creates missing parent directories on the way', async () => {
				await store.write('a/b/c/d/tile.jpg', utf8.encode('tile'));

				expect(await store.list('a/')).toEqual(['a/b/c/d/tile.jpg']);
			});

			it('replaces the previous contents rather than appending to them', async () => {
				await store.write('p/project.json', utf8.encode('a much longer first version'));
				await store.write('p/project.json', utf8.encode('short'));

				expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('short');
			});

			it('rejects reading a path that holds nothing', async () => {
				await expect(store.read('p/missing.json')).rejects.toThrow(PathNotFoundError);
			});

			it('does not let a caller mutate stored bytes through the array it wrote or read', async () => {
				const written = utf8.encode('original');
				await store.write('p/project.json', written);
				written[0] = 0x21;
				const readBack = await store.read('p/project.json');
				readBack[1] = 0x21;

				expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('original');
			});

			it('stores a zero-length file as a file that exists and is empty', async () => {
				await store.write('p/empty', new Uint8Array());

				expect(await store.read('p/empty')).toEqual(new Uint8Array());
				expect(await store.size('p/empty')).toBe(0);
				expect(await store.list('p/')).toEqual(['p/empty']);
			});
		});

		describe('listing', () => {
			beforeEach(async () => {
				await store.write('a/project.json', utf8.encode('a'));
				await store.write('a/images/one/info.json', utf8.encode('one'));
				await store.write('ab/project.json', utf8.encode('ab'));
				await store.write('b/project.json', utf8.encode('b'));
			});

			it('returns every path under a directory prefix, recursively, sorted', async () => {
				expect(await store.list('a/')).toEqual(['a/images/one/info.json', 'a/project.json']);
			});

			it('matches on the string prefix, so a partial name does not straddle directories', async () => {
				expect(await store.list('ab')).toEqual(['ab/project.json']);
			});

			it('lists the whole workspace for an empty prefix', async () => {
				expect(await store.list('')).toEqual([
					'a/images/one/info.json',
					'a/project.json',
					'ab/project.json',
					'b/project.json'
				]);
			});

			it('returns nothing for a prefix that matches nothing', async () => {
				expect(await store.list('nowhere/')).toEqual([]);
			});
		});

		describe('deleting', () => {
			it('removes the path', async () => {
				await store.write('p/project.json', utf8.encode('p'));
				await store.delete('p/project.json');

				expect(await store.list('')).toEqual([]);
				await expect(store.read('p/project.json')).rejects.toThrow(PathNotFoundError);
			});

			it('succeeds when there was nothing there', async () => {
				await expect(store.delete('p/never-existed')).resolves.toBeUndefined();
			});

			it('leaves siblings alone', async () => {
				await store.write('p/a', utf8.encode('a'));
				await store.write('p/b', utf8.encode('b'));
				await store.delete('p/a');

				expect(await store.list('p/')).toEqual(['p/b']);
			});
		});

		describe('size', () => {
			it('returns the byte length', async () => {
				await store.write('p/tile.jpg', new Uint8Array(1234));

				expect(await store.size('p/tile.jpg')).toBe(1234);
			});

			it('answers without reading the file', async () => {
				// The whole reason `size` is in the interface (ADR-0008's hosting cliff, warned about
				// in tickets 15 and 16): a workspace's total is thousands of tile files, and summing
				// it by reading every one of them would be unusable. A `size` implemented as a read
				// would pass every other assertion here, so this one guards it directly.
				await store.write('p/tile.jpg', new Uint8Array(1234));
				const read = vi.spyOn(store, 'read');

				expect(await store.size('p/tile.jpg')).toBe(1234);
				expect(read).not.toHaveBeenCalled();
			});

			it('rejects for a path that holds nothing', async () => {
				await expect(store.size('p/missing.jpg')).rejects.toThrow(PathNotFoundError);
			});
		});

		describe('atomic writes (ADR-0017 rule 4)', () => {
			const first = utf8.encode('{"formatVersion":1,"name":"Amsterdam 1625"}');
			const second = utf8.encode('{"formatVersion":1,"name":"Amsterdam 1626"}');

			it('leaves the previous contents intact and parseable when a write is interrupted', async () => {
				await store.write('p/project.json', first);
				const interrupted = interruptTheRename(store);

				await expect(store.write('p/project.json', second)).rejects.toThrow('storage went away');

				expect(interrupted).toHaveBeenCalledOnce();
				const survivor = new TextDecoder().decode(await store.read('p/project.json'));
				expect(JSON.parse(survivor)).toEqual({ formatVersion: 1, name: 'Amsterdam 1625' });
			});

			it('leaves no litter behind when a write is interrupted', async () => {
				await store.write('p/project.json', first);
				interruptTheRename(store);
				await store.write('p/project.json', second).catch(() => undefined);

				expect(await store.list('')).toEqual(['p/project.json']);
				expect(await store.size('p/project.json')).toBe(first.byteLength);
			});

			it('creates nothing at all when the very first write to a path is interrupted', async () => {
				interruptTheRename(store);
				await store.write('p/project.json', first).catch(() => undefined);

				expect(await store.list('')).toEqual([]);
			});
		});

		describe('paths', () => {
			it.each([
				['an empty path', ''],
				['a leading slash', '/p/project.json'],
				['a trailing slash', 'p/'],
				['an empty segment', 'p//project.json'],
				['a parent traversal', 'p/../escaped.json'],
				['a current-directory segment', 'p/./project.json'],
				['a backslash separator', 'p\\project.json'],
				['the reserved temporary suffix', 'p/project.json.ballastella-tmp']
			])('refuses %s', async (_description, path) => {
				await expect(store.write(path, utf8.encode('x'))).rejects.toThrow(InvalidPathError);
			});
		});
	});
}

/**
 * Break the rename half of the next temp-file write.
 *
 * Reaching for a protected member is deliberate and is the only way to assert rule 4 without
 * fault-injection hooks in shipping code: the requirement is about what survives when the
 * *second* step of the write fails, and no public API can produce that failure. The member is
 * declared on `TempFileWriteStore`, so every backend fails in the same place.
 */
function interruptTheRename(store: ProjectStore) {
	const internals = store as unknown as {
		renameTempFile: (from: string, to: string) => Promise<void>;
	};
	return vi
		.spyOn(internals, 'renameTempFile')
		.mockRejectedValueOnce(new Error('storage went away'));
}
