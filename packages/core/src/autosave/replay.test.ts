import { beforeEach, describe, expect, it, vi } from 'vitest';

import { baseMapTileSourcePath, writeCachedTileSource } from '../base-map/offline-cache.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { exportProjectBundle } from '../transfer/export-project-bundle.js';
import { exportWorkspaceTar } from '../transfer/export-workspace-tar.js';
import { openProjectBundle } from '../transfer/open-project-bundle.js';
import { restoreWorkspaceTar } from '../transfer/restore-workspace-tar.js';
import { ingestImageFile } from '../tiler/ingest.js';
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
					kept: false,
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
			deleted.record('amsterdam-1625', null);

			const report = await replayJournal(storage, store, 'Marking 2026', { deleted });

			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([
				{
					path: 'amsterdam-1625/project.json',
					reason: 'project-deleted',
					kept: false,
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
			deleted.record('amsterdam-1625', null);
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
			new DeletedProjects(storage, 'Teaching').record('amsterdam-1625', null);

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
					kept: false,
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
					kept: false,
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
			// So it is not *skipped*: nothing here concluded the Project had gone.
			expect(report.skipped).toEqual([]);
			// It is reported as a failure and its entry is kept, because since ticket 07 the same
			// `read` also answers "what does the store hold now", and a Workspace that cannot answer
			// that cannot license a write either. "Could not be put back yet", which is what `failed`
			// means, is the honest one — and it is tried again at the next startup.
			expect(report.restored).toEqual([]);
			expect(report.failed).toEqual([
				{
					path: 'amsterdam-1625/annotations/l.geojson',
					detail: expect.stringContaining('the folder is not reachable')
				}
			]);
			expect(readJournal(storage, 'Marking 2026').entries.map((entry) => entry.path)).toEqual([
				'amsterdam-1625/annotations/l.geojson'
			]);
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

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * REPLAY NEVER REVERTS NEWER BYTES (ticket 07)
	 *
	 * ⚠ **A broken harness here fails toward "no problem found", which is the same direction as the
	 * defect.** Ticket 01's implementer probed this twice with wrong constructor signatures and both
	 * attempts answered `restored: []` — the newer bytes apparently surviving, the defect apparently
	 * absent. So the first test below is a **planted revert**: it drives the hazard with the one thing
	 * that stops it removed, and asserts the revert *happens*. If this suite ever stops being able to
	 * see a revert, that test goes red before any of the green ones can be believed.
	 */
	describe('what the store holds now', () => {
		const PATH = 'amsterdam-1625/annotations/warehouses.geojson';

		/**
		 * A stranded edit whose entry knows what was on disk when it was made.
		 *
		 * Built the only way the journal can build it — record, and forget when the store takes the
		 * bytes, which is exactly what `Autosave` does on every save — rather than by writing an
		 * envelope by hand, so the baseline under test is one the shipped code produces.
		 */
		const strandAnEdit = async (onDisk: string, edited: string): Promise<void> => {
			await seedProject('amsterdam-1625');
			await store.write(PATH, utf8.encode(onDisk));
			journal.record(PATH, utf8.encode(onDisk));
			journal.forget(PATH);
			journal.record(PATH, utf8.encode(edited));
		};

		it('reverts newer bytes when the entry has no baseline, which is the stated limit', async () => {
			// ⚠ **THE PLANTED REVERT.** The entry is recorded with nothing behind it — the first edit to
			// a path in a session, which `journal.ts` says has no baseline — so `compare` reaches the
			// row the module header calls undecidable and writes anyway. That is the residual, stated
			// in the header and pinned here, and it is also this suite's positive control: a harness
			// that could not see a revert would fail this test rather than reassure with an empty
			// `restored`.
			await seedProject('amsterdam-1625');
			await store.write(PATH, utf8.encode('v1'));
			journal.record(PATH, utf8.encode('the edit that stranded'));
			expect(readJournal(storage, 'Marking 2026').entries[0]?.held).toBeNull();
			await store.write(PATH, utf8.encode('v2-NEWER'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([PATH]);
			expect(text(await store.read(PATH))).toBe('the edit that stranded');
		});

		it('refuses to put an entry back over bytes written after it, and says so', async () => {
			await strandAnEdit('v1', 'the edit that stranded');
			// The harness's own precondition: the entry really does carry the baseline the refusal is
			// decided from. Without this the test could pass because nothing was replayed at all.
			expect(readJournal(storage, 'Marking 2026').entries[0]?.held).toEqual(utf8.encode('v1'));
			await store.write(PATH, utf8.encode('v2-NEWER'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(text(await store.read(PATH))).toBe('v2-NEWER');
			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([
				{
					path: PATH,
					reason: 'superseded',
					kept: true,
					detail: expect.stringContaining('has been changed since')
				}
			]);
			// Kept: the entry is the only copy of that edit anywhere, so a refusal that dropped it
			// would destroy the work it exists to protect.
			expect(readJournal(storage, 'Marking 2026').entries.map((entry) => entry.path)).toEqual([
				PATH
			]);
			expect(replayIsNoteworthy(report)).toBe(true);
		});

		it('still puts a genuinely stranded write back, which is the whole point', async () => {
			// ⚠ The acceptance criterion that stops B being "fixed" by refusing everything: the store
			// holds what the edit was made against, so nothing newer exists and the edit is the user's
			// work waiting to be rescued.
			await strandAnEdit('v1', 'the edit that stranded');

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([PATH]);
			expect(text(await store.read(PATH))).toBe('the edit that stranded');
			expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
		});

		it('reports an entry the store already holds as skipped rather than restored', async () => {
			// Nothing is written, so naming it under "the change has been written now" would be a claim
			// about a write that did not happen.
			await seedProject('amsterdam-1625');
			await store.write(PATH, utf8.encode('v1'));
			journal.record(PATH, utf8.encode('v1'));
			const writes = vi.spyOn(store, 'write');

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([
				{
					path: PATH,
					reason: 'already-in-the-store',
					kept: false,
					detail: expect.stringContaining('did not need to be put back')
				}
			]);
			expect(writes).not.toHaveBeenCalled();
			// Dropped: the store has the bytes, which is the one condition an entry goes on.
			expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
		});

		it('tells apart bytes that differ but are the same length', async () => {
			// ⚠ Every other specimen here differs in length as well as in content, so a comparison that
			// only measured `length` passed all of them — and would read a newer file of the same size
			// as "already in the store", drop the entry, and destroy the edit it was holding. A rename
			// from one word to another of equal length is exactly that shape.
			await strandAnEdit('v1', 'v2');
			await store.write(PATH, utf8.encode('v3'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.skipped.map((entry) => entry.reason)).toEqual(['superseded']);
			expect(text(await store.read(PATH))).toBe('v3');
			expect(readJournal(storage, 'Marking 2026').entries.map((entry) => entry.path)).toEqual([
				PATH
			]);
		});

		it('writes when the store holds nothing at all, baseline or no baseline', async () => {
			// There is nothing to revert, so the undecidable row never arises.
			await seedProject('amsterdam-1625');
			journal.record(PATH, utf8.encode('the only copy'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([PATH]);
			expect(text(await store.read(PATH))).toBe('the only copy');
		});

		it('refuses an Alignment over newer bytes too, not only a plain file', async () => {
			// The Alignment path has its own writer and its own branch, so the refusal has to be above
			// the routing rather than inside one leg of it.
			await store.write('images/floride-1657/info.json', utf8.encode('{}'));
			// alignment-write-is-the-fixture: the Alignment already on disk that the stranded edit was made against, seeded so the refusal below has something to compare
			await store.write('alignments/floride-1657.json', utf8.encode('v1'));
			journal.record('alignments/floride-1657.json', utf8.encode('v1'));
			journal.forget('alignments/floride-1657.json');
			journal.record('alignments/floride-1657.json', utf8.encode('the control points'));
			// alignment-write-is-the-fixture: the colleague's newer Alignment this test exists to prove replay will not revert; it stands in for a synced Workspace, not for a write this app makes
			await store.write('alignments/floride-1657.json', utf8.encode('a colleague’s'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([]);
			expect(report.skipped.map((entry) => entry.reason)).toEqual(['superseded']);
			expect(text(await store.read('alignments/floride-1657.json'))).toBe('a colleague’s');
		});
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE FIVE ROUTES THAT WRITE THE STORE WITHOUT RECORDING, ONE AT A TIME (ticket 07)
	 *
	 * The SPEC names five, and they are not one thing: two of them can land on a path the journal
	 * holds an entry for and three of them cannot, so "the five are covered" is not a claim any single
	 * test can make. Each is driven through its **own real entry point** here.
	 *
	 * The out-of-reach argument rests on which paths this application ever hands to `Autosave`, and
	 * therefore ever journals. There are four call sites and they write four shapes:
	 * `<project>/project.json` (`Workspace.writeProject`), `<project>/annotations/<layer>.geojson`
	 * (`EditorSession.writeAnnotations`, `addAnnotationLayer`, layer-delete undo),
	 * `alignments/<image-id>.json` (`alignment-file.ts` through the session's port) and
	 * `images/<image-id>/remote.json` (`EditorSession.addReferencedMap`). That enumeration is read
	 * from the editor app and cannot be fenced from here — what *is* executable is the other half,
	 * asserted below: the paths each route actually writes.
	 */
	describe('the routes that write the store without recording', () => {
		/** The four shapes above, as a predicate over a path. */
		const couldBeJournalled = (path: string): boolean =>
			/^[^/]+\/project\.json$/.test(path) ||
			/^[^/]+\/annotations\/[^/]+\.geojson$/.test(path) ||
			/^alignments\/[^/]+\.json$/.test(path) ||
			/^images\/[^/]+\/remote\.json$/.test(path);

		const streamOf = (bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> =>
			new Blob([bytes]).stream();

		const collect = async (
			stream: ReadableStream<Uint8Array>
		): Promise<Uint8Array<ArrayBuffer>> => {
			const chunks: Uint8Array[] = [];
			const reader = stream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
			}
			let size = 0;
			for (const chunk of chunks) size += chunk.length;
			const out = new Uint8Array(size);
			let at = 0;
			for (const chunk of chunks) {
				out.set(chunk, at);
				at += chunk.length;
			}
			return out;
		};

		/** A destination that hands the route the store the journal belongs to. */
		const into = (name: string) => async () => ({
			name,
			store: store as MemoryProjectStore,
			discard: async () => undefined
		});

		/** A Workspace holding one Project whose Annotation file says `content`. */
		const sourceWith = async (content: string): Promise<MemoryProjectStore> => {
			const other = new MemoryProjectStore();
			other.plant(
				'amsterdam-1625/project.json' as StorePath,
				utf8.encode(
					JSON.stringify({ formatVersion: 1, name: 'Amsterdam 1625', layers: [], baseMap: null })
				) as Bytes
			);
			other.plant(
				'amsterdam-1625/annotations/warehouses.geojson' as StorePath,
				utf8.encode(content) as Bytes
			);
			return other;
		};

		/** A stranded entry for the Annotation file, with the baseline that makes it decidable. */
		const strandTheAnnotation = async (): Promise<void> => {
			await seedProject('amsterdam-1625');
			await store.write('amsterdam-1625/annotations/warehouses.geojson', utf8.encode('v1'));
			journal.record('amsterdam-1625/annotations/warehouses.geojson', utf8.encode('v1'));
			journal.forget('amsterdam-1625/annotations/warehouses.geojson');
			journal.record(
				'amsterdam-1625/annotations/warehouses.geojson',
				utf8.encode('the edit that stranded')
			);
		};

		it('restoring a Workspace tar over the open Workspace is not undone by the replay', async () => {
			await strandTheAnnotation();
			const archive = await collect(
				(await exportWorkspaceTar(await sourceWith('v2-NEWER'), 'W')).body
			);

			await restoreWorkspaceTar(streamOf(archive), into('Marking 2026'));
			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(text(await store.read('amsterdam-1625/annotations/warehouses.geojson'))).toBe(
				'v2-NEWER'
			);
			expect(report.restored).toEqual([]);
			expect(report.skipped.map((entry) => entry.reason)).toEqual(['superseded']);
		});

		it('opening a Project bundle into the open Workspace is not undone by the replay', async () => {
			await strandTheAnnotation();
			const bundle = await collect(
				(await exportProjectBundle(await sourceWith('v2-NEWER'), 'amsterdam-1625')).body
			);

			await openProjectBundle(streamOf(bundle), into('Marking 2026'), {
				fileName: 'amsterdam-1625.project.tar'
			});
			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(text(await store.read('amsterdam-1625/annotations/warehouses.geojson'))).toBe(
				'v2-NEWER'
			);
			expect(report.restored).toEqual([]);
			expect(report.skipped.map((entry) => entry.reason)).toEqual(['superseded']);
		});

		it('replaying twice does not report the second run as a restore', async () => {
			// `replay.ts` is the fifth route, and the one that writes the store from inside this
			// module. A run interrupted between its write and its `forget` leaves an entry whose bytes
			// are already on disk, and the next startup must not call putting them there again a
			// restoration.
			await strandTheAnnotation();
			const entry = readJournal(storage, 'Marking 2026').entries[0];
			await replayJournal(storage, store, 'Marking 2026');
			// The entry as it stood before the first run, put back — which is what an interrupted
			// `forget` leaves behind.
			journal.record(
				'amsterdam-1625/annotations/warehouses.geojson',
				entry?.bytes ?? new Uint8Array()
			);

			const second = await replayJournal(storage, store, 'Marking 2026');

			expect(second.restored).toEqual([]);
			expect(second.skipped.map((skip) => skip.reason)).toEqual(['already-in-the-store']);
		});

		it('an ingest writes nothing the journal can hold an entry for', async () => {
			// Out of reach, measured rather than asserted in prose: a real ingest — including one
			// re-run over an existing map's directory, which is the only way it can meet a path that
			// was there before — writes tiles, `manifest.json` and `info.json`, and none of those is a
			// shape this application journals. If it ever writes one, this goes red.
			await ingestImageFile({
				store,
				imageId: 'floride-1657',
				file: new File([new Uint8Array([0xff, 0xd8]).buffer], 'scan.jpg', {
					type: 'image/jpeg'
				}),
				openDecodeAndCrop: async () => ({
					dimensions: { width: 600, height: 400 },
					encodeTile: async () => utf8.encode('tile') as Bytes,
					close: async () => undefined
				})
			});

			const written = [...store.snapshot().keys()];
			// The pyramid, the manifest and `info.json` — so the check below is over a real ingest's
			// whole output rather than over an empty list.
			expect(written).toContain('images/floride-1657/info.json');
			expect(written.filter(couldBeJournalled)).toEqual([]);
		});

		it('the Base Map offline cache writes nothing the journal can hold an entry for', async () => {
			// Out of reach for the same reason and by the same measure: every path it writes is under
			// `base-map/`, which no `Autosave` call site names.
			await writeCachedTileSource(store, {
				archive: 'demo',
				maxZoom: 6
			});

			const written = [...store.snapshot().keys()];
			expect(written).toEqual([baseMapTileSourcePath('demo')]);
			expect(written.filter(couldBeJournalled)).toEqual([]);
		});
	});
});
