import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	InvalidPathError,
	PathNotFoundError,
	TEMP_PATH_SUFFIX,
	type ProjectStore,
	type StorePath
} from './project-store.js';

/** Where a write can fail. Both are states only the storage layer can put the store into. */
export type WriteStep = 'bytes' | 'rename';

/**
 * One backend, plus the three things the suite needs that the public interface cannot give it.
 *
 * Each of these is supplied by the backend's own test file rather than reached for inside the
 * suite. That is the difference that matters: the suite knows nothing structural about any
 * backend, so the File System Access adapter passes it unchanged by providing a fixture, not by
 * having to inherit from a particular base class.
 */
export interface StoreUnderTest {
	readonly store: ProjectStore;

	/**
	 * Every path the backend actually holds, sorted, temporary files included.
	 *
	 * `list` filters the reserved suffix **by construction**, so a "no litter" assertion made
	 * through `list` passes whether or not the cleanup exists. This is the backend's own view.
	 */
	everyStoredPath(): Promise<StorePath[]>;

	/**
	 * Make the next `write` fail at `step`, and only that one.
	 *
	 * `'bytes'` is the temporary file failing to land — a full disk, which Chromium reports from
	 * `close()`. `'rename'` is the move into place failing, which is the step ADR-0017 rule 4 is
	 * actually about. No public API can produce either, and each backend has its own honest way to
	 * inject them: the in-memory double has a documented fault switch alongside `unreachable()`,
	 * and the OPFS adapter is interrupted by patching the browser API it calls.
	 */
	failNextWrite(step: WriteStep): void;

	/**
	 * Put a half-finished atomic write at `path` — what a tab that died between the two steps of a
	 * write leaves behind.
	 *
	 * There is deliberately no way to do this through the interface: the suffix is reserved, so
	 * `write` refuses it, `list` never reports it, and `delete` cannot be handed it. That is why
	 * `reclaimAbandonedWrites` exists, and why this has to come from the fixture.
	 */
	plantAbandonedWrite(path: StorePath): Promise<void>;
}

/**
 * The behaviour every {@link ProjectStore} backend owes its callers, run against each of
 * them unchanged.
 *
 * This is the load-bearing artefact of the storage layer, not a convenience. Every
 * backend has to pass this suite **with no changes to the suite**: if a
 * backend needs the interface widened or an assertion relaxed, that is evidence the
 * interface was shaped around whichever backend was written first, and the fix belongs in
 * the interface (ADR-0001).
 *
 * @param name how the backend is described in test output
 * @param createStore a fresh, empty {@link StoreUnderTest} per test
 */
export function describeProjectStore(
	name: string,
	createStore: () => Promise<StoreUnderTest> | StoreUnderTest
): void {
	describe(name, () => {
		let subject: StoreUnderTest;
		let store: ProjectStore;
		const utf8 = new TextEncoder();

		beforeEach(async () => {
			subject = await createStore();
			store = subject.store;
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
				await store.write('a/annotations/one.geojson', utf8.encode('one'));
				await store.write('ab/project.json', utf8.encode('ab'));
				await store.write('b/project.json', utf8.encode('b'));
			});

			it('returns every path under a directory prefix, recursively, sorted', async () => {
				expect(await store.list('a/')).toEqual(['a/annotations/one.geojson', 'a/project.json']);
			});

			it('matches on the string prefix, so a partial name does not straddle directories', async () => {
				expect(await store.list('ab')).toEqual(['ab/project.json']);
			});

			it('lists the whole workspace for an empty prefix', async () => {
				expect(await store.list('')).toEqual([
					'a/annotations/one.geojson',
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
			const abandoned = `p/.project.json.abandoned${TEMP_PATH_SUFFIX}`;

			const steps: [string, WriteStep][] = [
				['the bytes never land', 'bytes'],
				['the move into place fails', 'rename']
			];

			it('leaves the previous contents intact and parseable when the move into place fails', async () => {
				await store.write('p/project.json', first);
				subject.failNextWrite('rename');

				await expect(store.write('p/project.json', second)).rejects.toThrow();

				const survivor = new TextDecoder().decode(await store.read('p/project.json'));
				expect(JSON.parse(survivor)).toEqual({ formatVersion: 1, name: 'Amsterdam 1625' });
			});

			it.each(steps)('leaves no litter behind when %s', async (_description, step) => {
				await store.write('p/project.json', first);
				subject.failNextWrite(step);
				await store.write('p/project.json', second).catch(() => undefined);

				// The backend's own view, not `list`'s: `list` filters the reserved suffix by
				// construction, so through `list` this assertion passes with no cleanup at all.
				expect(await subject.everyStoredPath()).toEqual(['p/project.json']);
				expect(await store.size('p/project.json')).toBe(first.byteLength);
			});

			it.each(steps)(
				'creates nothing at all when the very first write to a path fails and %s',
				async (_description, step) => {
					subject.failNextWrite(step);
					await store.write('p/project.json', first).catch(() => undefined);

					expect(await subject.everyStoredPath()).toEqual([]);
				}
			);

			it('recovers next time, rather than being poisoned by the failure', async () => {
				subject.failNextWrite('rename');
				await store.write('p/project.json', first).catch(() => undefined);

				await store.write('p/project.json', second);

				expect(await store.read('p/project.json')).toEqual(second);
				expect(await subject.everyStoredPath()).toEqual(['p/project.json']);
			});

			it('reclaims a half-finished write left behind by a crashed tab', async () => {
				await store.write('p/project.json', first);
				await subject.plantAbandonedWrite(abandoned);

				// `list` cannot report it and `delete` cannot be handed it, so without a sweep a
				// "deleted" Project's directory survives on disk forever — outside the `list` + `size`
				// totals the ~1 GB hosting warning is judged against, and in a real folder a stray dotfile the
				// user commits to their git repository.
				expect(await store.list('')).toEqual(['p/project.json']);
				expect(await subject.everyStoredPath()).toEqual([abandoned, 'p/project.json']);

				await store.reclaimAbandonedWrites('p/');

				expect(await subject.everyStoredPath()).toEqual(['p/project.json']);
			});

			it('reclaims only litter, and only under the prefix it was given', async () => {
				await store.write('p/project.json', first);
				await store.write('q/project.json', second);
				const elsewhere = `q/.project.json.abandoned${TEMP_PATH_SUFFIX}`;
				await subject.plantAbandonedWrite(abandoned);
				await subject.plantAbandonedWrite(elsewhere);

				await store.reclaimAbandonedWrites('p/');

				expect(await subject.everyStoredPath()).toEqual([
					'p/project.json',
					elsewhere,
					'q/project.json'
				]);
			});

			it('gives a caller no way to reach a reserved path itself', async () => {
				// `reclaimAbandonedWrites` removes; it neither lists nor writes. A caller that could
				// name a temporary path could put Project data somewhere `list` hides it.
				await expect(store.write(abandoned, first)).rejects.toThrow(InvalidPathError);
				await expect(store.delete(abandoned)).rejects.toThrow(InvalidPathError);
			});

			it('treats the swap file an implementation writes beside a temporary one as litter too', async () => {
				// Chromium's `createWritable()` creates `<name>.crswap` next to the file it is writing,
				// so a crash during the *first* step of an atomic write leaves
				// `<name>.ballastella-tmp.crswap` — which does not end in the reserved suffix. Left
				// outside the machinery it was invisible to `reclaimAbandonedWrites`, which exists for
				// exactly this, while `list` reported it **as project data**: into the size totals tickets
				// 15 and 16 warn from, into a zip on export, and on into a colleague's Workspace.
				//
				// Planted here rather than provoked, because only one backend writes one and every
				// backend owes the same answer about it. The exception path is asserted for real in
				// `e2e/editor-folder-workspace.e2e.ts`; this is the crash path, which nothing can stage.
				const swap = `${abandoned}.crswap`;
				await store.write('p/project.json', first);
				await subject.plantAbandonedWrite(swap);

				expect(await store.list('')).toEqual(['p/project.json']);
				await expect(store.write(swap, first)).rejects.toThrow(InvalidPathError);

				await store.reclaimAbandonedWrites('p/');

				expect(await subject.everyStoredPath()).toEqual(['p/project.json']);
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
