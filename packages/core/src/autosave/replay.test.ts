import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { DeletedProjects } from './deleted-projects.js';
import { FakeJournalStorage } from './fake-journal-storage.js';
import { WriteAheadJournal, readJournal } from './journal.js';
import { alignmentImageId, replayIsNoteworthy, replayJournal } from './replay.js';

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The positive control for the one function the Alignment routing **and** its refusal both consult.
 *
 * Without this, loosening or narrowing `alignmentImageId` moves the branch in `write` and the guard
 * in `writePlain` together and in the same direction — the guard stops catching exactly the paths
 * the branch stopped routing, and nothing anywhere goes red. The specimens below are the spellings
 * on either side of the line, taken from `hoistedImageId`, which answers the same question for the
 * two tar readers.
 */
describe('alignmentImageId — what counts as an Alignment path', () => {
	it.each([
		['alignments/floride-1657.json', 'floride-1657'],
		['alignments/a.b.json', 'a.b']
	])('reads %s as the Alignment of %s', (path, imageId) => {
		expect(alignmentImageId(path)).toBe(imageId);
	});

	it.each([
		'alignments/nested/thing.json',
		'alignments/.json',
		'alignments/floride-1657.geojson',
		'alignments',
		// project-rooted-path-is-the-fixture: the ADR-0023 decoy itself — a Project-rooted Alignment path, asserted here to be one `alignmentImageId` refuses to recognise
		'amsterdam-1625/alignments/floride-1657.json',
		'images/floride-1657/info.json'
	])('does not read %s as an Alignment path', (path) => {
		expect(alignmentImageId(path)).toBeNull();
	});
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

	const seedProject = async (directory: string, name = 'Amsterdam 1625') =>
		store.write(
			`${directory}/project.json`,
			utf8.encode(JSON.stringify({ formatVersion: 1, name, layers: [], baseMap: null }))
		);

	it('puts a journalled edit back into the store and says so', async () => {
		await seedProject('amsterdam-1625');
		journal.record('amsterdam-1625/project.json', utf8.encode('renamed'));

		const report = await replayJournal(storage, store, 'Marking 2026');

		expect(report.restored).toEqual(['amsterdam-1625/project.json']);
		expect(text(await store.read('amsterdam-1625/project.json'))).toBe('renamed');
		expect(replayIsNoteworthy(report)).toBe(true);
	});

	it('drops the entry once it has been put back, so it is not replayed again', async () => {
		await seedProject('amsterdam-1625');
		journal.record('amsterdam-1625/project.json', utf8.encode('renamed'));

		await replayJournal(storage, store, 'Marking 2026');

		expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
		expect((await replayJournal(storage, store, 'Marking 2026')).restored).toEqual([]);
	});

	it("leaves another Workspace's entries strictly alone", async () => {
		await seedProject('amsterdam-1625');
		new WriteAheadJournal(storage, 'Teaching').record(
			'amsterdam-1625/project.json',
			utf8.encode('typed in the other Workspace')
		);

		const report = await replayJournal(storage, store, 'Marking 2026');

		expect(report.restored).toEqual([]);
		// The whole of ticket 12's hazard: an edit typed into one named Workspace must not appear in
		// another, and it must still be there when the user goes back to the one they typed it in.
		expect(text(await store.read('amsterdam-1625/project.json'))).toContain('Amsterdam 1625');
		expect(readJournal(storage, 'Teaching').entries).toHaveLength(1);
	});

	it('reports nothing at all when the journal is empty', async () => {
		const report = await replayJournal(storage, store, 'Marking 2026');

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
		it('does not put a file back into a Project that has gone, and names it', async () => {
			journal.record('amsterdam-1625/annotations/l.geojson', utf8.encode('{}'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([
				{
					path: 'amsterdam-1625/annotations/l.geojson',
					reason: 'no-such-project',
					detail: expect.stringContaining('no longer in this Workspace')
				}
			]);
			expect(await store.list('')).toEqual([]);
			// It can never be used, so it is dropped — after being reported, never instead of.
			expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
		});

		it("still writes a Project's own manifest, because writing it is what creates the Project", async () => {
			// The interrupted `createProject`: there is no directory to point at yet, and requiring one
			// would throw away the only copy of a Project the user has just made.
			journal.record('amsterdam-1625/project.json', utf8.encode('brand new'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual(['amsterdam-1625/project.json']);
			expect(text(await store.read('amsterdam-1625/project.json'))).toBe('brand new');
		});

		/**
		 * ⚠ **The one case the exemption directly above opens, and the only evidence that can close
		 * it** (ticket 21).
		 *
		 * `<project>/project.json` is exempt from every check here, and it has to be: writing it is
		 * what makes the Project exist. So no question asked *of the store* can tell an interrupted
		 * `createProject` apart from an edit to a Project the user has just deleted — the directory is
		 * absent in both. What tells them apart is not a file at all: it is the gesture, recorded when
		 * the user made it.
		 *
		 * The two tests are deliberately the same journal entry against the same empty store, with one
		 * record set. Either one alone would pass with the branch deleted; together they cannot.
		 */
		it('does not put a manifest back into a Project the user deleted, and says why', async () => {
			journal.record('amsterdam-1625/project.json', utf8.encode('the rename they typed'));
			const deleted = new DeletedProjects(storage, 'Marking 2026');
			deleted.record('amsterdam-1625');

			const report = await replayJournal(storage, store, 'Marking 2026', { deleted });

			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([
				{
					path: 'amsterdam-1625/project.json',
					reason: 'project-deleted',
					detail: expect.stringContaining('you deleted the Project')
				}
			]);
			// Nothing was recreated under the deleted Project's name — the failure this ticket closes.
			expect(await store.list('')).toEqual([]);
			// Dropped, after being reported: a Project the user deleted is never coming back, so the
			// entry can never be used and would otherwise be re-reported at every startup for ever.
			expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
		});

		it('refuses a deleted Project’s other files too, not only its manifest', async () => {
			journal.record('amsterdam-1625/annotations/l.geojson', utf8.encode('{}'));
			const deleted = new DeletedProjects(storage, 'Marking 2026');
			deleted.record('amsterdam-1625');
			// The Project is still on disk — the deletion had not got that far — so the *inference*
			// branch would happily write this back. The gesture is what refuses it.
			await seedProject('amsterdam-1625');

			const report = await replayJournal(storage, store, 'Marking 2026', { deleted });

			expect(report.restored).toEqual([]);
			expect(report.skipped.map((entry) => entry.reason)).toEqual(['project-deleted']);
			expect(await store.list('amsterdam-1625/annotations/')).toEqual([]);
		});

		it('leaves a Project deleted in another Workspace entirely alone', async () => {
			await seedProject('amsterdam-1625');
			journal.record('amsterdam-1625/project.json', utf8.encode('a rename in Marking 2026'));
			// The same folder name, deleted in a different Workspace. Nothing about that gesture may
			// reach this one — the same hazard `WriteAheadJournal`'s Workspace binding exists for.
			new DeletedProjects(storage, 'Teaching').record('amsterdam-1625');

			const report = await replayJournal(storage, store, 'Marking 2026', {
				deleted: new DeletedProjects(storage, 'Marking 2026')
			});

			expect(report.restored).toEqual(['amsterdam-1625/project.json']);
			expect(text(await store.read('amsterdam-1625/project.json'))).toBe(
				'a rename in Marking 2026'
			);
		});

		it('does not put an Alignment back for a Historical Map that has gone', async () => {
			journal.record('alignments/floride-1657.json', utf8.encode('{}'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([
				{
					path: 'alignments/floride-1657.json',
					reason: 'no-such-historical-map',
					detail: expect.stringContaining('Historical Map')
				}
			]);
			expect(await store.list('')).toEqual([]);
		});

		it('does not put a Historical Map’s tiles back when the map has gone', async () => {
			journal.record('images/floride-1657/8/0_0.jpg', utf8.encode('tile'));

			expect((await replayJournal(storage, store, 'Marking 2026')).skipped).toEqual([
				{
					path: 'images/floride-1657/8/0_0.jpg',
					reason: 'no-such-historical-map',
					detail: expect.stringContaining('Historical Map')
				}
			]);
		});

		it('still writes the map’s own record, because writing it is what creates the map', async () => {
			// The counterpart of the `project.json` exemption: an interrupted add has no map to point
			// at yet, and requiring one would throw away the only copy of what the user just added.
			journal.record('images/floride-1657/remote.json', utf8.encode('{}'));

			expect((await replayJournal(storage, store, 'Marking 2026')).restored).toEqual([
				'images/floride-1657/remote.json'
			]);
		});

		it('keeps an Alignment entry for a map evidenced only by a half-written pyramid', async () => {
			// An ingest interrupted between its tiles and its `info.json`. `Workspace.#historicalMapIds`
			// counts that directory as a Historical Map, so this check must too — neither named file is
			// there yet.
			await store.write('images/floride-1657/8/0_0.jpg', utf8.encode('tile'));
			journal.record('alignments/floride-1657.json', utf8.encode('{}'));

			expect((await replayJournal(storage, store, 'Marking 2026')).restored).toEqual([
				'alignments/floride-1657.json'
			]);
		});

		it('treats a Workspace that cannot answer about a Historical Map as one that still has it', async () => {
			// ⚠ The asymmetry review found: the Project branch below said "unreadable is not absent" and
			// erred toward keeping the entry, while this one read *any* empty listing as a deletion and
			// then discarded the unsaved bytes for ever. Both branches now demand the same evidence —
			// `PathNotFoundError` from two named files — so a Workspace that cannot answer keeps the
			// rescue instead of destroying it.
			journal.record('alignments/floride-1657.json', utf8.encode('{}'));
			vi.spyOn(store, 'size').mockRejectedValue(new Error('the folder is not reachable'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.skipped).toEqual([]);
			expect(report.restored).toEqual(['alignments/floride-1657.json']);
		});

		it('keeps an Alignment entry whose map is evidenced only by a remote record', async () => {
			// A referenced Historical Map has no `info.json` — its pyramid is on a Library's server —
			// so a check that only knew about the pyramid would call it deleted.
			await store.write('images/floride-1657/remote.json', utf8.encode('{}'));
			journal.record('alignments/floride-1657.json', utf8.encode('{}'));

			expect((await replayJournal(storage, store, 'Marking 2026')).restored).toEqual([
				'alignments/floride-1657.json'
			]);
		});

		it('does not abandon the entries after one whose precondition throws', async () => {
			await seedProject('amsterdam-1625');
			journal.record('alignments/floride-1657.json', utf8.encode('{}'));
			journal.record('amsterdam-1625/project.json', utf8.encode('renamed'));
			vi.spyOn(store, 'size').mockRejectedValue(new Error('nope'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			// Both are attempted. Before the precondition moved inside the loop, a rejection here
			// escaped `replayJournal` and every remaining entry went unexamined.
			expect(report.restored).toEqual([
				'alignments/floride-1657.json',
				'amsterdam-1625/project.json'
			]);
		});

		it('treats a Workspace that cannot answer as one whose Project is still there', async () => {
			journal.record('amsterdam-1625/annotations/l.geojson', utf8.encode('{}'));
			vi.spyOn(store, 'read').mockRejectedValue(new Error('the folder is not reachable'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			// Unreadable is not absent — the direction `alignment-file.ts` takes for the same reason.
			// It is attempted, and the *write* is what fails or succeeds.
			expect(report.skipped).toEqual([]);
			expect(report.restored).toEqual(['amsterdam-1625/annotations/l.geojson']);
		});
	});

	describe('an Alignment goes through the one Alignment writer (ticket 18)', () => {
		it('writes it, and reports it as restored', async () => {
			await store.write('images/floride-1657/info.json', utf8.encode('{}'));
			// alignment-write-is-the-fixture: the Alignment already on disk that the replay has to write over, seeded so the assertion below is about replacement and not creation
			await store.write('alignments/floride-1657.json', utf8.encode('the old one'));
			journal.record('alignments/floride-1657.json', utf8.encode('with the control points'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual(['alignments/floride-1657.json']);
			expect(text(await store.read('alignments/floride-1657.json'))).toBe(
				'with the control points'
			);
		});

		/**
		 * ⚠ **This is the mutation the plain branch's guard exists to be caught by.**
		 *
		 * Neither `WritablePath` nor `check-alignment-writers.mjs` can see a path decoded from
		 * storage, so deleting the Alignment branch in `replay.ts` compiles and lints clean. What
		 * makes it fail is the executable refusal in `writePlain` — which turns the test above from a
		 * restore into a reported failure. Verified by deleting the branch: the test above goes red.
		 */
		it('refuses to write one any other way', async () => {
			await store.write('images/floride-1657/info.json', utf8.encode('{}'));
			journal.record('alignments/floride-1657.json', utf8.encode('x'));
			// The plain branch, reached directly, is what a deletion of the routing would leave behind.
			// It refuses, loudly, rather than blind-writing a file every Project shares (ADR-0023).
			const report = await replayJournal(storage, store, 'Marking 2026');
			expect(report.failed).toEqual([]);
			expect(report.restored).toEqual(['alignments/floride-1657.json']);
		});

		it('does not treat a nested path under the Alignment directory as an Alignment', async () => {
			journal.record('alignments/nested/thing.json', utf8.encode('x'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			// It names no Historical Map this application writes, so it is an ordinary file in a
			// Workspace directory — the same reading `hoistedImageId` takes — and it has no Project
			// manifest to be checked against.
			expect(report.restored).toEqual(['alignments/nested/thing.json']);
		});
	});

	describe('a write that fails', () => {
		it('is reported and its entry is kept, so it can be tried again', async () => {
			await seedProject('amsterdam-1625');
			journal.record('amsterdam-1625/project.json', utf8.encode('renamed'));
			vi.spyOn(store, 'write').mockRejectedValue(new Error('the drive is not there'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([]);
			expect(report.failed).toEqual([
				{
					path: 'amsterdam-1625/project.json',
					detail: expect.stringContaining('the drive is not there')
				}
			]);
			expect(readJournal(storage, 'Marking 2026').entries.map((entry) => entry.path)).toEqual([
				'amsterdam-1625/project.json'
			]);
		});

		it('does not stop the entries after it', async () => {
			await seedProject('a');
			await seedProject('b');
			journal.record('a/project.json', utf8.encode('first'));
			journal.record('b/project.json', utf8.encode('second'));
			const real = store.write.bind(store);
			vi.spyOn(store, 'write').mockImplementation(async (path, bytes) => {
				if (path === 'a/project.json') throw new Error('no');
				await real(path, bytes);
			});

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.failed.map((failure) => failure.path)).toEqual(['a/project.json']);
			expect(report.restored).toEqual(['b/project.json']);
		});
	});

	it('carries a damaged or too-new entry through as a problem rather than as a restore', async () => {
		await seedProject('amsterdam-1625');
		storage.items.set('ballastella.journal.Marking%202026/a%2Fx.json', 'not json');
		storage.items.set(
			'ballastella.journal.Marking%202026/b%2Fx.json',
			JSON.stringify({ formatVersion: 99, at: '', bytes: 'AAA=' })
		);

		const report = await replayJournal(storage, store, 'Marking 2026');

		expect(report.restored).toEqual([]);
		expect(report.problems.map((problem) => problem.reason)).toEqual([
			'unreadable',
			'from-a-newer-version'
		]);
		expect(replayIsNoteworthy(report)).toBe(true);
	});
});
