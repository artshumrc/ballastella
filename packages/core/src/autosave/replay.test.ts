import { beforeEach, describe, expect, it, vi } from 'vitest';

import { baseMapTileSourcePath, writeCachedTileSource } from '../base-map/offline-cache.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { exportWorkspaceTar } from '../transfer/export-workspace-tar.js';
import { restoreWorkspaceTar } from '../transfer/restore-workspace-tar.js';
import { ingestImageFile } from '../tiler/ingest.js';
import { DeletedProjects } from './deleted-projects.js';
import { FakeJournalStorage } from './fake-journal-storage.js';
import {
	WriteAheadJournal,
	fingerprintOf,
	forgetHeldCopy,
	readHeldCopies,
	readJournal
} from './journal.js';
import { replayIsNoteworthy, replayJournal } from './replay.js';
import { collect, decode, encode, seeded, streamOf } from '../test-support.js';

const PATH = 'amsterdam-1625/annotations/warehouses.geojson';
const MANIFEST = 'amsterdam-1625/project.json';
const ALIGNMENT = 'alignments/floride-1657.json';

const PROJECT_JSON = JSON.stringify({
	formatVersion: 1,
	name: 'Amsterdam 1625',
	layers: [],
	baseMap: null
});

const skip = (path: string, reason: string, detail: string, copy: unknown = null) => ({
	path,
	reason,
	copy,
	detail: expect.stringContaining(detail)
});

describe('replayJournal', () => {
	let storage: FakeJournalStorage;
	let store: MemoryProjectStore;
	let journal: WriteAheadJournal;

	beforeEach(() => {
		storage = new FakeJournalStorage();
		store = new MemoryProjectStore();
		journal = new WriteAheadJournal(storage, 'Marking 2026');
	});

	const baselineFromStore = async (path: StorePath): Promise<void> => {
		const at = journal.mark();
		journal.observe(path, await store.read(path), at);
	};

	const seedProject = (directory: string) =>
		store.write(`${directory}/project.json`, encode(PROJECT_JSON));

	const strandAnEdit = async (onDisk: string, edited: string): Promise<void> => {
		await seedProject('amsterdam-1625');
		await store.write(PATH, encode(onDisk));
		journal.record(PATH, encode(onDisk));
		journal.forget(PATH);
		journal.record(PATH, encode(edited));
	};

	const replay = (options?: Parameters<typeof replayJournal>[3]) =>
		replayJournal(storage, store, 'Marking 2026', options);
	const journalled = () => readJournal(storage, 'Marking 2026').entries;
	const held = () => readHeldCopies(storage, 'Marking 2026').copies;
	const read = async (path: string) => decode(await store.read(path));
	const reasons = (report: Awaited<ReturnType<typeof replay>>) =>
		report.skipped.map((entry) => entry.reason);
	const expectBaseline = (of: string): void => {
		expect(journalled()[0]?.held).toBe(fingerprintOf(encode(of)));
	};

	it('puts a journalled edit back into the store, says so, and drops the entry', async () => {
		await seedProject('amsterdam-1625');
		await baselineFromStore(MANIFEST);
		journal.record(MANIFEST, encode('renamed'));

		const report = await replay();
		expect(report.restored).toEqual([MANIFEST]);
		expect(await read(MANIFEST)).toBe('renamed');
		expect(replayIsNoteworthy(report)).toBe(true);
		expect(journalled()).toEqual([]);
		expect((await replay()).restored).toEqual([]);
	});

	it("leaves another Workspace's entries strictly alone", async () => {
		await seedProject('amsterdam-1625');
		new WriteAheadJournal(storage, 'Teaching').record(
			MANIFEST,
			encode('typed in the other Workspace')
		);

		const report = await replay();
		expect(report.restored).toEqual([]);
		expect(await read(MANIFEST)).toContain('Amsterdam 1625');
		expect(readJournal(storage, 'Teaching').entries).toHaveLength(1);
	});

	it('reports nothing at all when the journal is empty', async () => {
		const report = await replay();

		expect(report).toEqual({
			workspace: 'Marking 2026',
			restored: [],
			skipped: [],
			failed: [],
			problems: []
		});
		expect(replayIsNoteworthy(report)).toBe(false);
	});

	describe('what it refuses to write', () => {
		it.each([
			['amsterdam-1625/annotations/l.geojson', 'no-such-project', 'no longer in this Workspace'],
			[ALIGNMENT, 'no-such-map-image', 'Map Image'],
			['images/floride-1657/8/0_0.jpg', 'no-such-map-image', 'Map Image']
		])(
			'does not put %s back when its owner has gone, and names it',
			async (path, reason, detail) => {
				journal.record(path, encode('for an owner that has gone'));

				const report = await replay({ journal });
				expect(report.restored).toEqual([]);
				expect(report.skipped).toEqual([skip(path, reason, detail)]);
				expect(await store.list('')).toEqual([]);
				expect(journalled()).toEqual([]);
				journal.record(path, encode('typed into an owner of the same name'));
				expect(journalled()[0]?.held).toBeNull();
			}
		);

		it.each([MANIFEST, 'images/floride-1657/remote.json'])(
			'still writes %s, because writing it is what creates its owner',
			async (path) => {
				journal.record(path, encode('brand new'));

				expect((await replay()).restored).toEqual([path]);
				expect(await read(path)).toBe('brand new');
			}
		);

		it.each([
			[MANIFEST, false],
			['amsterdam-1625/annotations/l.geojson', true]
		])('does not put %s back into a Project the user deleted', async (path, projectOnDisk) => {
			journal.record(path, encode('{}'));
			const deleted = new DeletedProjects(storage, 'Marking 2026');
			deleted.record('amsterdam-1625', null);
			if (projectOnDisk) await seedProject('amsterdam-1625');

			const report = await replay({ deleted });
			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([skip(path, 'project-deleted', 'you deleted the Project')]);
			expect(await store.list(path)).toEqual([]);
			expect(journalled()).toEqual([]);
		});

		it('leaves a Project deleted in another Workspace entirely alone', async () => {
			await seedProject('amsterdam-1625');
			await baselineFromStore(MANIFEST);
			journal.record(MANIFEST, encode('a rename in Marking 2026'));
			new DeletedProjects(storage, 'Teaching').record('amsterdam-1625', null);

			const report = await replay({ deleted: new DeletedProjects(storage, 'Marking 2026') });
			expect(report.restored).toEqual([MANIFEST]);
			expect(await read(MANIFEST)).toBe('a rename in Marking 2026');
		});

		it.each(['images/floride-1657/8/0_0.jpg', 'images/floride-1657/remote.json'])(
			'keeps an Alignment entry for a map evidenced only by %s',
			async (evidence) => {
				await store.write(evidence, encode('{}'));
				journal.record(ALIGNMENT, encode('{}'));

				expect((await replay()).restored).toEqual([ALIGNMENT]);
			}
		);

		it('treats a Workspace that cannot answer about a Map Image as one that still has it, and goes on', async () => {
			await seedProject('amsterdam-1625');
			await baselineFromStore(MANIFEST);
			journal.record(ALIGNMENT, encode('{}'));
			journal.record(MANIFEST, encode('renamed'));
			vi.spyOn(store, 'size').mockRejectedValue(new Error('the folder is not reachable'));

			const report = await replay();
			expect(report.skipped).toEqual([]);
			expect(report.restored).toEqual([ALIGNMENT, MANIFEST]);
		});

		it('treats a Workspace that cannot answer as one whose Project is still there, and reports rather than writes', async () => {
			const path = 'amsterdam-1625/annotations/l.geojson';
			journal.record(path, encode('{}'));
			vi.spyOn(store, 'read').mockRejectedValue(new Error('the folder is not reachable'));

			const report = await replay();
			expect(report.skipped).toEqual([]);
			expect(report.restored).toEqual([]);
			expect(report.failed).toEqual([
				{ path, detail: expect.stringContaining('the folder is not reachable') }
			]);
			expect(journalled().map((entry) => entry.path)).toEqual([path]);
		});
	});

	describe('an Alignment goes through the one Alignment writer', () => {
		it('writes it, and reports it as restored', async () => {
			await store.write('images/floride-1657/info.json', encode('{}'));
			await store.write(ALIGNMENT, encode('the old one'));
			await baselineFromStore(ALIGNMENT);
			journal.record(ALIGNMENT, encode('with the control points'));

			const report = await replay();
			expect(report.failed).toEqual([]);
			expect(report.restored).toEqual([ALIGNMENT]);
			expect(await read(ALIGNMENT)).toBe('with the control points');
		});

		it('does not treat a nested path under the Alignment directory as an Alignment', async () => {
			journal.record('alignments/nested/thing.json', encode('x'));

			expect((await replay()).restored).toEqual(['alignments/nested/thing.json']);
		});
	});

	it('reports a write that fails, keeps its entry to be tried again, and goes on', async () => {
		await seedProject('a');
		await seedProject('b');
		await baselineFromStore('a/project.json');
		await baselineFromStore('b/project.json');
		journal.record('a/project.json', encode('first'));
		journal.record('b/project.json', encode('second'));
		const real = store.write.bind(store);
		vi.spyOn(store, 'write').mockImplementation(async (path, bytes) => {
			if (path === 'a/project.json') throw new Error('the drive is not there');
			await real(path, bytes);
		});

		const report = await replay();
		expect(report.failed).toEqual([
			{ path: 'a/project.json', detail: expect.stringContaining('the drive is not there') }
		]);
		expect(report.restored).toEqual(['b/project.json']);
		expect(journalled().map((entry) => entry.path)).toEqual(['a/project.json']);
	});

	it('carries a damaged or too-new entry through as a problem rather than as a restore', async () => {
		await seedProject('amsterdam-1625');
		storage.items.set('ballastella.journal.Marking%202026/a%2Fx.json', 'not json');
		storage.items.set(
			'ballastella.journal.Marking%202026/b%2Fx.json',
			JSON.stringify({ formatVersion: 99, at: '', bytes: 'AAA=' })
		);

		const report = await replay();
		expect(report.restored).toEqual([]);
		expect(report.problems.map((problem) => problem.reason)).toEqual([
			'unreadable',
			'from-a-newer-version'
		]);
		expect(replayIsNoteworthy(report)).toBe(true);
	});

	describe('what the store holds now', () => {
		it('writes without asking when the store holds nothing and there is no baseline', async () => {
			await seedProject('amsterdam-1625');
			journal.record(PATH, encode('the only copy'));

			const report = await replay();
			expect(report.restored).toEqual([PATH]);
			expect(report.skipped).toEqual([]);
			expect(await read(PATH)).toBe('the only copy');
		});

		it.each([
			['untouched since the baseline', async () => {}],
			[
				'changed and changed back, which it cannot tell from untouched',
				async () => {
					await store.write(PATH, encode('v2-COLLEAGUE'));
					await store.write(PATH, encode('v1'));
				}
			],
			['emptied, which is the stated limit of that branch', () => store.delete(PATH)]
		])('puts a stranded write back over a store %s', async (_, between) => {
			await strandAnEdit('v1', 'the edit that stranded');
			expectBaseline('v1');
			await between();

			const report = await replay();
			expect(report.restored).toEqual([PATH]);
			expect(await read(PATH)).toBe('the edit that stranded');
			expect(journalled()).toEqual([]);
		});

		it('reports the entry’s own bytes as already in the store, and drops the entry', async () => {
			await seedProject('amsterdam-1625');
			await store.write(PATH, encode('v1'));
			journal.record(PATH, encode('v1'));

			const report = await replay({ journal });
			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([
				skip(PATH, 'already-in-the-store', 'did not need to be put back')
			]);
			expect(await read(PATH)).toBe('v1');
			journal.record(PATH, encode('the next edit'));
			expectBaseline('v1');
		});

		it('does not read a store holding a prefix of the entry as holding the entry', async () => {
			await seedProject('amsterdam-1625');
			await store.write(PATH, encode('the edit'));
			await baselineFromStore(PATH);
			journal.record(PATH, encode('the edit that stranded'));

			const report = await replay();
			expect(report.skipped).toEqual([]);
			expect(report.restored).toEqual([PATH]);
			expect(await read(PATH)).toBe('the edit that stranded');
		});

		describe('a baseline the store no longer matches → superseded', () => {
			it.each([
				['v1', 'the edit that stranded', 'v2-NEWER'],
				['v1', 'v2', 'v3'],
				['v1-long-baseline', 'the edit that stranded', 'v1-long']
			])(
				'refuses to put back over %s → %s → %s, holds the entry aside, and says so',
				async (baseline, edited, newer) => {
					await strandAnEdit(baseline, edited);
					expectBaseline(baseline);
					await store.write(PATH, encode(newer));

					const report = await replay();
					expect(await read(PATH)).toBe(newer);
					expect(report.restored).toEqual([]);
					expect(report.skipped).toEqual([
						skip(PATH, 'superseded', 'has been changed since', expect.any(String))
					]);
					expect(journalled()).toEqual([]);
					expect(held().map((copy) => [copy.path, decode(copy.bytes)])).toEqual([[PATH, edited]]);
					expect(replayIsNoteworthy(report)).toBe(true);
				}
			);

			it('refuses an Alignment over newer bytes too, not only a plain file', async () => {
				await store.write('images/floride-1657/info.json', encode('{}'));
				await store.write(ALIGNMENT, encode('v1'));
				journal.record(ALIGNMENT, encode('v1'));
				journal.forget(ALIGNMENT);
				journal.record(ALIGNMENT, encode('the control points'));
				await store.write(ALIGNMENT, encode('a colleague’s'));

				const report = await replay();
				expect(report.restored).toEqual([]);
				expect(reasons(report)).toEqual(['superseded']);
				expect(await read(ALIGNMENT)).toBe('a colleague’s');
			});

			it('does not refuse the next edit to the same path as well', async () => {
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, encode('v2-COLLEAGUE'));
				expect(reasons(await replay({ journal }))).toEqual(['superseded']);

				journal.record(PATH, encode('typed on top of the colleague’s'));
				expect((await replay({ journal })).restored).toEqual([PATH]);
				expect(await read(PATH)).toBe('typed on top of the colleague’s');
			});
		});

		describe('a copy the replay declined', () => {
			const decline = async (edited = 'the edit that stranded') => {
				await strandAnEdit('v1', edited);
				await store.write(PATH, encode('v2-NEWER'));
				return replay({ journal });
			};

			it('survives the next edit to the same file, and is thrown away only by identity', async () => {
				const copy = (await decline()).skipped[0]?.copy ?? '';
				journal.record(PATH, encode('WORK DONE AFTER THE REPORT'));
				expect(held().map((each) => decode(each.bytes))).toEqual(['the edit that stranded']);

				expect(forgetHeldCopy(storage, 'Marking 2026', PATH, copy)).toBe(true);
				expect(held()).toEqual([]);
				expect(journalled().map((entry) => decode(entry.bytes))).toEqual([
					'WORK DONE AFTER THE REPORT'
				]);
			});

			it('holds two divergent copies of one file rather than letting the second erase the first', async () => {
				const first = await decline('the first divergent edit');
				journal.record(PATH, encode('the second divergent edit'));
				await store.write(PATH, encode('v3-NEWER-STILL'));
				await replay({ journal });

				expect(held().map((copy) => decode(copy.bytes))).toEqual([
					'the first divergent edit',
					'the second divergent edit'
				]);

				forgetHeldCopy(storage, 'Marking 2026', PATH, first.skipped[0]?.copy ?? '');
				expect(held().map((copy) => decode(copy.bytes))).toEqual(['the second divergent edit']);
			});

			it('says it could not be set aside when there is no room, and offers no remedy', async () => {
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, encode('v2-NEWER'));
				const room = vi.spyOn(storage, 'setItem').mockImplementation(() => {
					throw new DOMException('full', 'QuotaExceededError');
				});

				const report = await replay({ journal });
				room.mockRestore();

				expect(report.skipped[0]?.copy).toBeNull();
				expect(report.skipped[0]?.detail).toContain('could not set your copy aside');
				expect(report.skipped[0]?.detail).not.toContain('has been kept');
				expect(held()).toEqual([]);
				expect(journalled().map((entry) => decode(entry.bytes))).toEqual([
					'the edit that stranded'
				]);
			});

			it('carries a damaged copy through as a problem rather than losing it in silence', async () => {
				storage.items.set('ballastella.held.Marking%202026/abc%2Fa%2Fx.json', 'not json');

				const report = await replay();
				expect(report.problems.map((problem) => problem.reason)).toEqual(['unreadable']);
				expect(replayIsNoteworthy(report)).toBe(true);
			});

			it('is reported once in the run that held it, and offered again at the next startup', async () => {
				expect((await decline()).skipped).toHaveLength(1);

				const later = await replay({ journal });
				expect(later.skipped.map((entry) => [entry.reason, entry.copy !== null])).toEqual([
					['superseded', true]
				]);
				expect(later.restored).toEqual([]);
				expect(later.skipped[0]?.detail).toContain('still being kept');
			});

			it('goes when the Project it belongs to is deleted', async () => {
				await decline();

				expect(journal.forgetUnder('amsterdam-1625/')).toBe(1);
				expect(held()).toEqual([]);
			});
		});

		it('the harness sees older bytes landing on newer ones, which is what the old code did here', async () => {
			await strandAnEdit('v1', 'the edit that stranded');
			const entry = journalled()[0];
			await store.write(PATH, encode('v2-NEWER'));

			await store.write(PATH, entry?.bytes ?? new Uint8Array());
			journal.forget(PATH);

			expect(await read(PATH)).toBe('the edit that stranded');
			expect(journalled()).toEqual([]);
		});

		describe('no baseline → cannot tell which is newer', () => {
			it('writes nothing, keeps the entry, describes both versions, and leaves the next edit decidable', async () => {
				await seedProject('amsterdam-1625');
				await store.write(PATH, encode('v1'));
				journal.record(PATH, encode('the edit that stranded'));
				expect(journalled()[0]?.held).toBeNull();
				await store.write(PATH, encode('v2-NEWER'));

				const report = await replay({ journal });
				expect(await read(PATH)).toBe('v2-NEWER');
				expect(report.restored).toEqual([]);
				expect(held().map((copy) => copy.path)).toEqual([PATH]);
				expect(report.skipped).toEqual([
					skip(
						PATH,
						'cannot-tell-which-is-newer',
						'cannot tell whether it is newer',
						expect.any(String)
					)
				]);

				journal.record(PATH, encode('typed after answering'));
				expectBaseline('v2-NEWER');
			});

			it('says how big each version is, so the sentence is one somebody can choose from', async () => {
				await seedProject('amsterdam-1625');
				await store.write(PATH, new Uint8Array(2048));
				journal.record(PATH, encode('short'));

				const report = await replay();
				expect(report.skipped[0]?.detail).toContain('5 bytes');
				expect(report.skipped[0]?.detail).toContain('2 KB');
			});
		});
	});

	describe('the routes that write the store without recording', () => {
		const couldBeJournalled = (path: string): boolean =>
			/^[^/]+\/project\.json$/.test(path) ||
			/^[^/]+\/annotations\/[^/]+\.geojson$/.test(path) ||
			/^alignments\/[^/]+\.json$/.test(path) ||
			/^images\/[^/]+\/remote\.json$/.test(path);

		it('restoring a Workspace tar over the open Workspace is not undone by the replay', async () => {
			await strandAnEdit('v1', 'the edit that stranded');
			const source = await seeded({ [MANIFEST]: PROJECT_JSON, [PATH]: 'v2-NEWER' });
			const archive = await collect((await exportWorkspaceTar(source, 'W')).body);

			await restoreWorkspaceTar(streamOf(archive), async () => ({
				name: 'Marking 2026',
				store,
				origin: null,
				discard: async () => undefined
			}));
			const report = await replay();
			expect(await read(PATH)).toBe('v2-NEWER');
			expect(report.restored).toEqual([]);
			expect(reasons(report)).toEqual(['superseded']);
		});

		it('replaying twice does not report the second run as a restore', async () => {
			await strandAnEdit('v1', 'the edit that stranded');
			const entry = journalled()[0];
			await replay();
			journal.record(PATH, entry?.bytes ?? new Uint8Array());

			const second = await replay();
			expect(second.restored).toEqual([]);
			expect(reasons(second)).toEqual(['already-in-the-store']);
		});

		it('an ingest writes nothing the journal can hold an entry for', async () => {
			await ingestImageFile({
				store,
				imageId: 'floride-1657',
				file: new File([new Uint8Array([0xff, 0xd8]).buffer], 'scan.jpg', { type: 'image/jpeg' }),
				openDecodeAndCrop: async () => ({
					dimensions: { width: 600, height: 400 },
					encodeTile: async () => encode('tile') as Bytes,
					close: async () => undefined
				})
			});

			const written = [...store.snapshot().keys()];
			expect(written).toContain('images/floride-1657/info.json');
			expect(written.filter(couldBeJournalled)).toEqual([]);
		});

		it('the Base Map offline cache writes nothing the journal can hold an entry for', async () => {
			await writeCachedTileSource(store, { archive: 'demo', maxZoom: 6 });

			const written = [...store.snapshot().keys()];
			expect(written).toEqual([baseMapTileSourcePath('demo')]);
			expect(written.filter(couldBeJournalled)).toEqual([]);
		});
	});
});
