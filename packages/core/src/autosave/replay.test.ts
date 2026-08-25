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
import {
	WriteAheadJournal,
	fingerprintOf,
	forgetHeldCopy,
	readHeldCopies,
	readJournal
} from './journal.js';
import { replayIsNoteworthy, replayJournal } from './replay.js';

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('replayJournal', () => {
	let storage: FakeJournalStorage;
	let store: MemoryProjectStore;
	let journal: WriteAheadJournal;

	beforeEach(() => {
		storage = new FakeJournalStorage();
		store = new MemoryProjectStore();
		journal = new WriteAheadJournal(storage, 'Marking 2026');
	});

	/**
	 * Tell the journal what the store currently holds for `path`, the way a startup does.
	 *
	 * ⚠ **Without this an entry has no baseline, and since round 3 that is its own verdict** —
	 * `'cannot-tell-which-is-newer'`, which keeps the entry and writes nothing. The tests below whose
	 * subject is the *write* path therefore have to say what the edit was made against, or they stop
	 * exercising the thing they are named for. `observe` is the shipped call `replayJournal` itself
	 * makes; nothing here hand-writes an envelope.
	 */
	const baselineFromStore = async (path: StorePath): Promise<void> => {
		const at = journal.mark();
		journal.observe(path, await store.read(path), at);
	};

	const seedProject = async (directory: string, name = 'Amsterdam 1625') =>
		store.write(
			`${directory}/project.json`,
			utf8.encode(JSON.stringify({ formatVersion: 1, name, layers: [], baseMap: null }))
		);

	it('puts a journalled edit back into the store and says so', async () => {
		await seedProject('amsterdam-1625');
		await baselineFromStore('amsterdam-1625/project.json');
		journal.record('amsterdam-1625/project.json', utf8.encode('renamed'));

		const report = await replayJournal(storage, store, 'Marking 2026');

		expect(report.restored).toEqual(['amsterdam-1625/project.json']);
		expect(text(await store.read('amsterdam-1625/project.json'))).toBe('renamed');
		expect(replayIsNoteworthy(report)).toBe(true);
	});

	it('drops the entry once it has been put back, so it is not replayed again', async () => {
		await seedProject('amsterdam-1625');
		await baselineFromStore('amsterdam-1625/project.json');
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
					copy: null,
					detail: expect.stringContaining('no longer in this Workspace')
				}
			]);
			expect(await store.list('')).toEqual([]);
			// It can never be used, so it is dropped — after being reported, never instead of.
			expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
		});

		it('does not file the bytes it dropped as what the store holds', async () => {
			// ⚠ **`discard`, not `forget`.** The two differ in one thing only: `forget` means "the store
			// has these bytes" and is the sole writer of a baseline. These bytes reached no store and
			// never will, so filing them would give the next edit to this path a baseline that was never
			// on disk — and a wrong baseline refuses that edit's rescue. Reachable whenever a Project is
			// recreated under a folder name a stale entry still names.
			const path = 'amsterdam-1625/annotations/l.geojson';
			journal.record(path, utf8.encode('for a Project that has gone'));

			const report = await replayJournal(storage, store, 'Marking 2026', { journal });

			expect(report.skipped.map((entry) => entry.reason)).toEqual(['no-such-project']);
			journal.record(path, utf8.encode('typed in the Project of the same name'));
			expect(readJournal(storage, 'Marking 2026').entries[0]?.held).toBeNull();
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
					copy: null,
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
			await baselineFromStore('amsterdam-1625/project.json');
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

		it('does not put an Alignment back for a Map Image that has gone', async () => {
			journal.record('alignments/floride-1657.json', utf8.encode('{}'));

			const report = await replayJournal(storage, store, 'Marking 2026');

			expect(report.restored).toEqual([]);
			expect(report.skipped).toEqual([
				{
					path: 'alignments/floride-1657.json',
					reason: 'no-such-map-image',
					copy: null,
					detail: expect.stringContaining('Map Image')
				}
			]);
			expect(await store.list('')).toEqual([]);
		});

		it('does not put a Map Image’s tiles back when the map has gone', async () => {
			journal.record('images/floride-1657/8/0_0.jpg', utf8.encode('tile'));

			expect((await replayJournal(storage, store, 'Marking 2026')).skipped).toEqual([
				{
					path: 'images/floride-1657/8/0_0.jpg',
					reason: 'no-such-map-image',
					copy: null,
					detail: expect.stringContaining('Map Image')
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
			// An ingest interrupted between its tiles and its `info.json`. `Workspace.#mapImageIds`
			// counts that directory as a Map Image, so this check must too — neither named file is
			// there yet.
			await store.write('images/floride-1657/8/0_0.jpg', utf8.encode('tile'));
			journal.record('alignments/floride-1657.json', utf8.encode('{}'));

			expect((await replayJournal(storage, store, 'Marking 2026')).restored).toEqual([
				'alignments/floride-1657.json'
			]);
		});

		it('treats a Workspace that cannot answer about a Map Image as one that still has it', async () => {
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
			// A referenced Map Image has no `info.json` — its pyramid is on a Library's server —
			// so a check that only knew about the pyramid would call it deleted.
			await store.write('images/floride-1657/remote.json', utf8.encode('{}'));
			journal.record('alignments/floride-1657.json', utf8.encode('{}'));

			expect((await replayJournal(storage, store, 'Marking 2026')).restored).toEqual([
				'alignments/floride-1657.json'
			]);
		});

		it('does not abandon the entries after one whose precondition throws', async () => {
			await seedProject('amsterdam-1625');
			await baselineFromStore('amsterdam-1625/project.json');
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

		it('treats a Workspace that cannot answer as one whose Project is still there, and reports rather than writes', async () => {
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
			//
			// The cost of that, stated: a path whose read fails *permanently* — a file the backend will
			// never answer for again — is now reported at every startup for ever rather than being
			// written over once. `failed` has always had that property; this branch adds a way to reach
			// it that does not involve the write itself failing.
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
			await baselineFromStore('alignments/floride-1657.json');
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

			// It names no Map Image this application writes, so it is an ordinary file in a
			// Workspace directory — the same reading `hoistedImageId` takes — and it has no Project
			// manifest to be checked against.
			expect(report.restored).toEqual(['alignments/nested/thing.json']);
		});
	});

	describe('a write that fails', () => {
		it('is reported and its entry is kept, so it can be tried again', async () => {
			await seedProject('amsterdam-1625');
			await baselineFromStore('amsterdam-1625/project.json');
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
			await baselineFromStore('a/project.json');
			await baselineFromStore('b/project.json');
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

		/** That the entry really carries a baseline, which several tests below are meaningless without. */
		const expectBaseline = (of: string): void => {
			expect(readJournal(storage, 'Marking 2026').entries[0]?.held).toBe(
				fingerprintOf(utf8.encode(of))
			);
		};

		describe('the store holds nothing → write, without asking', () => {
			it('writes, because there is nothing there to be reverted', async () => {
				await seedProject('amsterdam-1625');
				journal.record(PATH, utf8.encode('the only copy'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.restored).toEqual([PATH]);
				expect(text(await store.read(PATH))).toBe('the only copy');
			});

			it('writes even with a baseline, and that is the branch’s stated limit', async () => {
				// ⚠ The half the row's prose covered and no test reached. "Nothing is there" is narrower
				// than "nothing newer exists": a *deletion* is a newer state too, and this recreates the
				// file over one. Not live today — no deletion path leaves a live entry behind to reach it
				// — so it is pinned as the branch's known reach rather than as a defect.
				await strandAnEdit('v1', 'the edit that stranded');
				expectBaseline('v1');
				await store.delete(PATH);

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.restored).toEqual([PATH]);
				expect(text(await store.read(PATH))).toBe('the edit that stranded');
			});
		});

		describe('the store holds the entry’s bytes → already-in-the-store', () => {
			it('reports it as skipped rather than restored, and drops the entry', async () => {
				// Nothing is written, so naming it under "the change has been written now" would be a
				// claim about a write that did not happen.
				await seedProject('amsterdam-1625');
				await store.write(PATH, utf8.encode('v1'));
				journal.record(PATH, utf8.encode('v1'));

				const report = await replayJournal(storage, store, 'Marking 2026', { journal });

				expect(report.restored).toEqual([]);
				expect(report.skipped).toEqual([
					{
						path: PATH,
						reason: 'already-in-the-store',
						copy: null,
						detail: expect.stringContaining('did not need to be put back')
					}
				]);
				expect(text(await store.read(PATH))).toBe('v1');
				// ⚠ **Dropped through `forget`, not `discard`** — the store demonstrably has these bytes,
				// so this is the `forget` that did not happen when it should have, and it is the one
				// event allowed to write a baseline. Through `discard` the next edit to this file would
				// be recorded against nothing and the scholar asked about it for no reason.
				journal.record(PATH, utf8.encode('the next edit'));
				expect(readJournal(storage, 'Marking 2026').entries[0]?.held).toBe(
					fingerprintOf(utf8.encode('v1'))
				);
				// Dropped: the store has the bytes, which is the one condition an entry goes on. Asserted
				// before the record above, on the report itself.
				expect(report.skipped[0]?.copy).toBeNull();
			});

			it('does not read a store holding a prefix of the entry as holding the entry', async () => {
				// ⚠ **The named kill for `sameBytes`'s length guard, first position.** Without the guard
				// `every` walks only the shorter run, so this reads as "already in the store": the
				// unfinished edit is reported as needing nothing, its entry dropped, and the user's work
				// destroyed with a reassuring sentence. Every other fixture here differs in length.
				await seedProject('amsterdam-1625');
				await store.write(PATH, utf8.encode('the edit'));
				await baselineFromStore(PATH);
				journal.record(PATH, utf8.encode('the edit that stranded'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.skipped).toEqual([]);
				expect(report.restored).toEqual([PATH]);
				expect(text(await store.read(PATH))).toBe('the edit that stranded');
			});
		});

		describe('a baseline the store still matches → write', () => {
			it('puts a genuinely stranded write back, which is the whole point', async () => {
				// ⚠ The acceptance criterion that stops B being "fixed" by refusing everything: the store
				// holds what the edit was made against, so nothing newer exists and the edit is the
				// user's work waiting to be rescued.
				await strandAnEdit('v1', 'the edit that stranded');
				expectBaseline('v1');

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.restored).toEqual([PATH]);
				expect(text(await store.read(PATH))).toBe('the edit that stranded');
				expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
			});

			it('cannot tell “untouched” from “changed and changed back”, and writes', async () => {
				// ⚠ The one channel in which a comparison this module makes costs an *edit* rather than a
				// restore, driven rather than merely admitted. The user restores a backup whose content
				// for this path is exactly what was there before; equality sees no change, and an edit
				// that predates the restore is written over it and named in `restored`.
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v2-COLLEAGUE'));
				await store.write(PATH, utf8.encode('v1'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.restored).toEqual([PATH]);
				expect(text(await store.read(PATH))).toBe('the edit that stranded');
			});
		});

		describe('a baseline the store no longer matches → superseded', () => {
			it('refuses to put the entry back, keeps it, and says so', async () => {
				await strandAnEdit('v1', 'the edit that stranded');
				// The harness's own precondition: the entry really does carry the baseline the refusal is
				// decided from. Without this the test could pass because nothing was replayed at all.
				expectBaseline('v1');
				await store.write(PATH, utf8.encode('v2-NEWER'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(text(await store.read(PATH))).toBe('v2-NEWER');
				expect(report.restored).toEqual([]);
				expect(report.skipped).toEqual([
					{
						path: PATH,
						reason: 'superseded',
						copy: expect.any(String),
						detail: expect.stringContaining('has been changed since')
					}
				]);
				// Kept — and kept *out of the live journal*, which is what makes it survive the next edit
				// to this file rather than being overwritten by it (round 5, finding B).
				expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
				expect(
					readHeldCopies(storage, 'Marking 2026').copies.map((held) => [
						held.path,
						text(held.bytes)
					])
				).toEqual([[PATH, 'the edit that stranded']]);
				expect(replayIsNoteworthy(report)).toBe(true);
			});

			it('tells apart bytes that differ but are the same length', async () => {
				// ⚠ Every other specimen here differs in length as well as in content, so a comparison
				// that only measured `length` passed all of them — and would read a newer file of the
				// same size as "already in the store", drop the entry, and destroy the edit it held.
				await strandAnEdit('v1', 'v2');
				await store.write(PATH, utf8.encode('v3'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.skipped.map((entry) => entry.reason)).toEqual(['superseded']);
				expect(text(await store.read(PATH))).toBe('v3');
				expect(readHeldCopies(storage, 'Marking 2026').copies.map((held) => held.path)).toEqual([
					PATH
				]);
			});

			it('does not read a baseline the store has grown past as still matching', async () => {
				// ⚠ **The named kill for `sameBytes`'s length guard, second position** — the baseline one,
				// where losing the guard licenses the exact revert this module exists to prevent. The
				// store's content is a strict prefix of the baseline, so without the guard the two
				// compare equal, the file reads as untouched since the edit, and the newer bytes go.
				await strandAnEdit('v1-long-baseline', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v1-long'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.restored).toEqual([]);
				expect(report.skipped.map((entry) => entry.reason)).toEqual(['superseded']);
				expect(text(await store.read(PATH))).toBe('v1-long');
			});

			it('refuses an Alignment over newer bytes too, not only a plain file', async () => {
				// The Alignment path has its own writer and its own branch, so the refusal has to be
				// above the routing rather than inside one leg of it.
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

			/**
			 * ⚠ **A refusal must not become a standing one** (round 2, finding H).
			 *
			 * `'superseded'` is the first skip reason that keeps its entry, and it keeps it *because*
			 * something else wrote the path — so that entry's baseline is, by construction, what the
			 * store no longer holds. Carried forward by `WriteAheadJournal.#baseline`, it refuses the
			 * next edit to that path too, and the one after, until some save happens to succeed. The
			 * second session below is the case the journal exists for: an edit made against what is
			 * really on disk, whose write was interrupted.
			 */
			it('does not refuse the next edit to the same path as well', async () => {
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v2-COLLEAGUE'));

				const first = await replayJournal(storage, store, 'Marking 2026', { journal });
				expect(first.skipped.map((entry) => entry.reason)).toEqual(['superseded']);

				// The scholar carries on working, on the colleague's version, and this write strands too.
				journal.record(PATH, utf8.encode('typed on top of the colleague’s'));
				const second = await replayJournal(storage, store, 'Marking 2026', { journal });

				expect(second.restored).toEqual([PATH]);
				expect(text(await store.read(PATH))).toBe('typed on top of the colleague’s');
			});
		});

		/**
		 * ─────────────────────────────────────────────────────────────────────────────────────
		 * A KEPT COPY IS KEPT (round 5, findings A and B)
		 *
		 * Both were the same sentence being false. A declined copy used to be "kept" by leaving the
		 * ordinary journal entry in place — and an entry is addressed by path alone, so the next edit
		 * to that file overwrote it, which is SPEC story 6 verbatim; and the notice's remedy was keyed
		 * on the path too, so pressing it destroyed whatever was there by then rather than the copy the
		 * sentence named.
		 */
		describe('a copy the replay declined', () => {
			it('survives the next edit to the same file', async () => {
				// ⚠ The probe that was red: the scholar carries on working on the file after reading the
				// notice, that write strands too, and the copy the notice is about is gone.
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v2-NEWER'));
				await replayJournal(storage, store, 'Marking 2026', { journal });

				journal.record(PATH, utf8.encode('WORK DONE AFTER THE REPORT'));

				expect(
					readHeldCopies(storage, 'Marking 2026').copies.map((held) => text(held.bytes))
				).toEqual(['the edit that stranded']);
				// And the later edit is journalled as usual, in its own right.
				expect(
					readJournal(storage, 'Marking 2026').entries.map((entry) => text(entry.bytes))
				).toEqual(['WORK DONE AFTER THE REPORT']);
			});

			it('is thrown away by identity, never by whatever is at that path now', async () => {
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v2-NEWER'));
				const report = await replayJournal(storage, store, 'Marking 2026', { journal });
				const copy = report.skipped[0]?.copy ?? '';
				// An hour of work later, with its own stranded write at the same path.
				journal.record(PATH, utf8.encode('WORK DONE AFTER THE REPORT'));

				expect(forgetHeldCopy(storage, 'Marking 2026', PATH, copy)).toBe(true);

				expect(readHeldCopies(storage, 'Marking 2026').copies).toEqual([]);
				// ⚠ The measured defect: this used to be `[]`, the later edit destroyed by a button whose
				// sentence described a different, older version and said that one had been kept.
				expect(
					readJournal(storage, 'Marking 2026').entries.map((entry) => text(entry.bytes))
				).toEqual(['WORK DONE AFTER THE REPORT']);
			});

			it('holds two divergent copies of one file rather than letting the second erase the first', async () => {
				// ⚠ **Why the fingerprint is in the key and not only in the report.** A scholar can strand
				// a second, different edit to the same file and have that declined too; keyed by path,
				// the second copy would overwrite the first — the same destruction this whole section
				// exists to stop, arriving from the other side.
				await strandAnEdit('v1', 'the first divergent edit');
				await store.write(PATH, utf8.encode('v2-NEWER'));
				const first = await replayJournal(storage, store, 'Marking 2026', { journal });
				journal.record(PATH, utf8.encode('the second divergent edit'));
				await store.write(PATH, utf8.encode('v3-NEWER-STILL'));
				await replayJournal(storage, store, 'Marking 2026', { journal });

				expect(
					readHeldCopies(storage, 'Marking 2026').copies.map((held) => text(held.bytes))
				).toEqual(['the first divergent edit', 'the second divergent edit']);

				// And throwing one away leaves the other exactly where it was.
				forgetHeldCopy(storage, 'Marking 2026', PATH, first.skipped[0]?.copy ?? '');
				expect(
					readHeldCopies(storage, 'Marking 2026').copies.map((held) => text(held.bytes))
				).toEqual(['the second divergent edit']);
			});

			it('says it could not be set aside when there is no room, and offers no remedy', async () => {
				// ⚠ **The sentence and the button both used to lie** (round 6, finding A). `hold` answered
				// with the same fingerprint whether it stored anything or not, so a full origin produced
				// "It has been kept" beside a Throw this copy away — for a copy that did not exist.
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v2-NEWER'));
				const room = vi.spyOn(storage, 'setItem').mockImplementation(() => {
					throw new DOMException('full', 'QuotaExceededError');
				});

				const report = await replayJournal(storage, store, 'Marking 2026', { journal });
				room.mockRestore();

				expect(report.skipped[0]?.copy).toBeNull();
				expect(report.skipped[0]?.detail).toContain('could not set your copy aside');
				expect(report.skipped[0]?.detail).not.toContain('has been kept');
				// Nothing was set aside, and the entry it failed to protect is exactly where it was.
				expect(readHeldCopies(storage, 'Marking 2026').copies).toEqual([]);
				expect(
					readJournal(storage, 'Marking 2026').entries.map((entry) => text(entry.bytes))
				).toEqual(['the edit that stranded']);
			});

			it('carries a damaged copy through as a problem rather than losing it in silence', async () => {
				storage.items.set('ballastella.held.Marking%202026/abc%2Fa%2Fx.json', 'not json');

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.problems.map((problem) => problem.reason)).toEqual(['unreadable']);
				expect(replayIsNoteworthy(report)).toBe(true);
			});

			it('is offered again at the next startup, so it is not held invisibly', async () => {
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v2-NEWER'));
				await replayJournal(storage, store, 'Marking 2026', { journal });

				const later = await replayJournal(storage, store, 'Marking 2026', { journal });

				expect(later.skipped.map((entry) => [entry.reason, entry.copy !== null])).toEqual([
					['superseded', true]
				]);
				expect(later.restored).toEqual([]);
				expect(later.skipped[0]?.detail).toContain('still being kept');
			});

			it('does not leave the next edit undecidable as well', async () => {
				// ⚠ The same self-perpetuation the `superseded` branch was fixed for. Without the
				// observation, the scholar answers a question about this file and is then asked about it
				// again at the next startup, having seen the very version they were asked about.
				await seedProject('amsterdam-1625');
				await store.write(PATH, utf8.encode('v2-NEWER'));
				journal.record(PATH, utf8.encode('the edit that stranded'));
				const first = await replayJournal(storage, store, 'Marking 2026', { journal });
				expect(first.skipped.map((entry) => entry.reason)).toEqual(['cannot-tell-which-is-newer']);

				journal.record(PATH, utf8.encode('typed after answering'));

				expect(readJournal(storage, 'Marking 2026').entries[0]?.held).toBe(
					fingerprintOf(utf8.encode('v2-NEWER'))
				);
			});

			it('is not reported twice in the run that held it', async () => {
				// The held copies are snapshotted before the walk, or the decision just taken would be
				// reported once as itself and once as an older copy still waiting.
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v2-NEWER'));

				const report = await replayJournal(storage, store, 'Marking 2026', { journal });

				expect(report.skipped).toHaveLength(1);
			});

			it('goes when the Project it belongs to is deleted', async () => {
				// Otherwise a deletion leaves the loudest thing behind: a notice at every startup about a
				// file that no longer exists, whose offered remedy is about nothing the user cares about.
				await strandAnEdit('v1', 'the edit that stranded');
				await store.write(PATH, utf8.encode('v2-NEWER'));
				await replayJournal(storage, store, 'Marking 2026', { journal });

				expect(journal.forgetUnder('amsterdam-1625/')).toBe(1);

				expect(readHeldCopies(storage, 'Marking 2026').copies).toEqual([]);
			});
		});

		/**
		 * ⚠ **THE PLANTED REVERT, and this suite's positive control.**
		 *
		 * A broken harness here fails toward "no problem found", which is the same direction as the
		 * defect: ticket 01's implementer probed this twice with wrong constructor signatures and both
		 * attempts answered `restored: []` — the newer bytes apparently surviving, the defect apparently
		 * absent. So the first test below plants a revert of exactly the shape the module used to
		 * perform and asserts the harness **sees** it. If this fixture ever stops being able to observe
		 * older bytes landing on newer ones, it goes red before any green result above can be believed.
		 *
		 * ⚠ **It is a control and not a claim about shipped behaviour**, and that distinction has to
		 * stay: since round 3 no row of `compare` reverts. The revert is performed by the test itself,
		 * standing in for the unconditional `store.write` this module did before ticket 07. The
		 * standing proof that the *shipped* refusal is load-bearing is the mutation that neuters
		 * `compare` to always answer `'write'`, which turns nine of these red.
		 */
		describe('the harness can see a revert', () => {
			it('sees older bytes landing on newer ones, which is what the old code did here', async () => {
				await strandAnEdit('v1', 'the edit that stranded');
				const entry = readJournal(storage, 'Marking 2026').entries[0];
				await store.write(PATH, utf8.encode('v2-NEWER'));

				// The pre-ticket-07 replay, in one line: write the entry, drop it, call it restored.
				await store.write(PATH, entry?.bytes ?? new Uint8Array());
				journal.forget(PATH);

				expect(text(await store.read(PATH))).toBe('the edit that stranded');
				expect(readJournal(storage, 'Marking 2026').entries).toEqual([]);
			});
		});

		/**
		 * The row that used to be that revert, and is now a question (round 3).
		 *
		 * Writing silently can destroy a colleague's newer work; refusing and dropping can destroy a
		 * real strand. Neither is defensible without evidence, and there is none — so the entry is kept
		 * and the scholar is told what both versions are.
		 */
		describe('no baseline → cannot tell which is newer', () => {
			it('writes nothing, keeps the entry, and describes both versions', async () => {
				await seedProject('amsterdam-1625');
				await store.write(PATH, utf8.encode('v1'));
				journal.record(PATH, utf8.encode('the edit that stranded'));
				expect(readJournal(storage, 'Marking 2026').entries[0]?.held).toBeNull();
				await store.write(PATH, utf8.encode('v2-NEWER'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				// The newer bytes are untouched, which is the whole point…
				expect(text(await store.read(PATH))).toBe('v2-NEWER');
				expect(report.restored).toEqual([]);
				// …and so is the scholar's copy, which nothing else holds.
				expect(readHeldCopies(storage, 'Marking 2026').copies.map((held) => held.path)).toEqual([
					PATH
				]);
				expect(report.skipped).toEqual([
					{
						path: PATH,
						reason: 'cannot-tell-which-is-newer',
						copy: expect.any(String),
						detail: expect.stringContaining('cannot tell whether it is newer')
					}
				]);
			});

			it('says how big each version is, so the sentence is one somebody can choose from', async () => {
				// The two sizes are the whole of what distinguishes the versions in the report; a chooser
				// reads the bytes themselves from `readJournal` and `store.read`, which is where they are.
				await seedProject('amsterdam-1625');
				await store.write(PATH, new Uint8Array(2048));
				journal.record(PATH, utf8.encode('short'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.skipped[0]?.detail).toContain('5 bytes');
				expect(report.skipped[0]?.detail).toContain('2 KB');
			});

			it('is not reached when the store holds nothing, because that is decidable', async () => {
				// Guards the branch order: absence is answered before the question is asked, so a first
				// save that stranded is still put back without anybody being consulted.
				await seedProject('amsterdam-1625');
				journal.record(PATH, utf8.encode('the only copy'));

				const report = await replayJournal(storage, store, 'Marking 2026');

				expect(report.restored).toEqual([PATH]);
				expect(report.skipped).toEqual([]);
			});
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
	 * The out-of-reach argument rests on which paths this application hands to `Autosave`, and
	 * therefore journals. **Six call sites, in two packages** — `Workspace.writeProject` and its
	 * `queue` twin here in `@ballastella/core`, and `EditorSession`'s `writeAnnotations`,
	 * `addAnnotationLayer`, `addReferencedMap` and layer-delete undo in the editor app — writing four
	 * shapes: `<project>/project.json`, `<project>/annotations/<layer>.geojson`,
	 * `alignments/<image-id>.json` and `images/<image-id>/remote.json`.
	 *
	 * ⚠ **Those are the shapes the app *intends* to journal, and that is weaker than the shapes it
	 * *can*.** The layer-delete undo commits `${directory}/${record.path}`, where `record.path` comes
	 * from `layer.geojsonRef` — parsed as `readString(geojsonRef, '')`, an unvalidated string that can
	 * arrive inside a colleague's bundle. So the predicate below is a description, not a proof of
	 * exhaustiveness. What holds regardless, and is why the conclusion still stands, is the prefix: a
	 * journalled path always begins with a Project directory, while both out-of-reach routes write at
	 * the Workspace root under `images/` or `base-map/`.
	 *
	 * Two questions about that string are left named and unanswered, both wider than this ticket:
	 * whether a `..` inside it could escape the Project prefix, and that `writeAnnotations` writes
	 * `annotationStorePath(directory, layer.id)` while the readers read
	 * `${directory}/${layer.geojsonRef}` — so a non-canonical `geojsonRef` from a colleague's bundle
	 * reads one file and writes another. The second is a display-and-edit divergence rather than a
	 * replay hazard, but it does mean "a file cannot be edited before it has been shown" is true of
	 * the file *shown*, not of the file written.
	 *
	 * What *is* executable is the other half, asserted below: the paths each route actually writes.
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
			origin: null,
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
