import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	InvalidPathError,
	PathNotFoundError,
	TEMP_PATH_SUFFIX,
	type ProjectStore,
	type StorePath
} from './project-store.js';
import { encode, decode } from '../test-support.js';

export type WriteStep = 'bytes' | 'rename';

interface StoreUnderTest {
	readonly store: ProjectStore;
	everyStoredPath(): Promise<StorePath[]>;
	failNextWrite(step: WriteStep): void;
	plantAbandonedWrite(path: StorePath): Promise<void>;
}

export function describeProjectStore(
	name: string,
	createStore: () => Promise<StoreUnderTest> | StoreUnderTest
): void {
	describe(name, () => {
		let subject: StoreUnderTest;
		let store: ProjectStore;

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
				await store.write('a/b/c/d/tile.jpg', encode('tile'));

				expect(await store.list('a/')).toEqual(['a/b/c/d/tile.jpg']);
			});

			it('replaces the previous contents rather than appending to them', async () => {
				await store.write('p/project.json', encode('a much longer first version'));
				await store.write('p/project.json', encode('short'));

				expect(decode(await store.read('p/project.json'))).toBe('short');
			});

			it('rejects reading a path that holds nothing', async () => {
				await expect(store.read('p/missing.json')).rejects.toThrow(PathNotFoundError);
			});

			it('does not let a caller mutate stored bytes through the array it wrote or read', async () => {
				const written = encode('original');
				await store.write('p/project.json', written);
				written[0] = 0x21;
				const readBack = await store.read('p/project.json');
				readBack[1] = 0x21;

				expect(decode(await store.read('p/project.json'))).toBe('original');
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
				await store.write('a/project.json', encode('a'));
				await store.write('a/annotations/one.geojson', encode('one'));
				await store.write('ab/project.json', encode('ab'));
				await store.write('b/project.json', encode('b'));
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
				await store.write('p/project.json', encode('p'));
				await store.delete('p/project.json');

				expect(await store.list('')).toEqual([]);
				await expect(store.read('p/project.json')).rejects.toThrow(PathNotFoundError);
			});

			it('succeeds when there was nothing there', async () => {
				await expect(store.delete('p/never-existed')).resolves.toBeUndefined();
			});

			it('leaves siblings alone', async () => {
				await store.write('p/a', encode('a'));
				await store.write('p/b', encode('b'));
				await store.delete('p/a');

				expect(await store.list('p/')).toEqual(['p/b']);
			});
		});

		describe('size', () => {
			it('returns the byte length without reading the file', async () => {
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
			const first = encode('{"formatVersion":1,"name":"Amsterdam 1625"}');
			const second = encode('{"formatVersion":1,"name":"Amsterdam 1626"}');
			const abandoned = `p/.project.json.abandoned${TEMP_PATH_SUFFIX}`;

			const steps: [string, WriteStep][] = [
				['the bytes never land', 'bytes'],
				['the move into place fails', 'rename']
			];

			it.each(steps)(
				'keeps the previous contents and leaves no litter behind when %s',
				async (_description, step) => {
					await store.write('p/project.json', first);
					subject.failNextWrite(step);

					await expect(store.write('p/project.json', second)).rejects.toThrow();

					expect(await store.read('p/project.json')).toEqual(first);
					expect(await subject.everyStoredPath()).toEqual(['p/project.json']);
				}
			);

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

			it.each([
				['a half-finished write left behind by a crashed tab', abandoned],
				['the swap file an implementation writes beside a temporary one', `${abandoned}.crswap`]
			])('hides and reclaims %s', async (_description, litter) => {
				await store.write('p/project.json', first);
				await subject.plantAbandonedWrite(litter);

				expect(await store.list('')).toEqual(['p/project.json']);
				expect(await subject.everyStoredPath()).toEqual([litter, 'p/project.json']);

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
				['the reserved temporary suffix', 'p/project.json.ballastella-tmp'],
				['a swap file beside a temporary one', 'p/project.json.ballastella-tmp.crswap']
			])('refuses %s', async (_description, path) => {
				await expect(store.write(path, encode('x'))).rejects.toThrow(InvalidPathError);
				await expect(store.delete(path)).rejects.toThrow(InvalidPathError);
			});
		});
	});
}
