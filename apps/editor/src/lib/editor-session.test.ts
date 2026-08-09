// `EditorSession` against an in-memory store (ticket 06).
//
// The session takes a `ProjectStore`, so an in-memory one is the whole of what a test needs — which
// is what makes this the second thing worth having a Node seam for. What is asserted here is the
// pair of failure paths behind the "Add a Historical Map" dialog: a Workspace whose `images/`
// cannot be walked, and a map whose record does not say how big it is. Both are refusals, both are
// a sentence a user reads, and neither has a gesture in the interface that produces it on demand.

import {
	DeletedProjects,
	FakeJournalStorage,
	MemoryProjectStore,
	WriteAheadJournal,
	alignmentPath,
	imageInfoPath,
	newProjectFile,
	projectFilePath,
	readJournal,
	serialiseProjectFile,
	type StorePath
} from '@ballastella/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { EditorSession } from './editor-session.svelte.js';

const DIRECTORY = 'amsterdam-1625';

/**
 * A store whose `images/` walk can be made to throw **after** the Project is open.
 *
 * The switch matters: `open()` walks `images/` too, and a Workspace that cannot be walked *then*
 * genuinely is the unreachable state. What this reproduces is the other moment — a folder that went
 * away, or a handle that was revoked, while a scholar had a Project on screen.
 */
class ImagesGoAway extends MemoryProjectStore {
	failing = false;

	override async list(prefix: string): Promise<StorePath[]> {
		if (this.failing && prefix.startsWith('images/')) {
			throw new Error('the images folder could not be read');
		}
		return super.list(prefix);
	}
}

/** That store, holding one empty Project, with a session already open on it. */
async function openOn(store: ImagesGoAway): Promise<EditorSession> {
	await store.write(
		projectFilePath(DIRECTORY),
		serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')))
	);
	const opened = new EditorSession(store);
	await opened.open(DIRECTORY);
	return opened;
}

let session: EditorSession;

describe('the picker behind “Add a Historical Map”', () => {
	beforeEach(async () => {
		session = await openOn(new ImagesGoAway());
	});

	it('refuses a map whose record does not say how big it is, in words', async () => {
		// `addWorkspaceMap`'s own comment calls this branch load-bearing: a starter Alignment's
		// Resource Mask is the whole sheet, and a sheet of unknown size is not one it can invent. So
		// the map is refused in words rather than added with a Resource Mask over nothing.
		const added = await session.addWorkspaceMap('no-such-map');

		expect(added).toBeNull();
		expect(session.addMapError).toContain('images/no-such-map/');
		expect(session.addMapError).toContain('nothing to place an Alignment over');
		// Nothing was written for it — no Layer, and above all no Alignment.
		expect(session.openProject?.layers).toEqual([]);
	});

	it('says a Workspace it cannot look through, without taking the Project off the screen', async () => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE HUB CAN AFFORD THE UNREACHABLE VERDICT; A DIALOG ON AN OPEN PROJECT CANNOT.       │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// `refreshHistoricalMaps` sets `status = 'unreachable'` on any throw, which blanks the whole
		// editor and offers the Workspace-recovery affordance. That is right for the hub, where the
		// Workspace *is* the screen. The dialog calls this walk on every open, so a transient
		// failure reading `images/` used to blank a scholar's open Project because they pressed a
		// button.
		const store = new ImagesGoAway();
		const failing = await openOn(store);
		expect(failing.status).toBe('ready');
		store.failing = true;

		await failing.refreshAddableHistoricalMaps();

		expect(failing.status).toBe('ready');
		expect(failing.openProject).not.toBeNull();
		expect(failing.addMapError).toContain('could not be looked through');
		expect(failing.historicalMapsLoading).toBe(false);
	});

	it('still takes the hub’s own walk to the unreachable state', async () => {
		// The other half of the same rule, so the split is asserted from both sides rather than
		// being a difference one caller happens to have.
		const store = new ImagesGoAway();
		const failing = await openOn(store);
		store.failing = true;

		await failing.refreshHistoricalMaps();

		expect(failing.status).toBe('unreachable');
		expect(failing.unreachableDetail).toContain('could not be read');
	});
});

/**
 * ⚠ **The wiring that ticket 21 claimed and only the browser suite could see.**
 *
 * "Deleting a Project retires its journal entries" lived at one line of `EditorSession` and was
 * asserted nowhere below the e2e: `journal.test.ts` pins the primitive `forgetUnder`, and
 * `Workspace.deleteProject` never touches the journal at all. So the *connection* between the
 * gesture and the sweep — the thing that can be deleted in one keystroke — had no unit seam.
 */
describe('deleting a Project, at the unit seam', () => {
	const WORKSPACE = 'opfs:My Workspace';

	/** A session over an in-memory store with a real journal behind it, holding one Project. */
	async function sessionWithJournal(): Promise<{
		session: EditorSession;
		storage: FakeJournalStorage;
		store: MemoryProjectStore;
	}> {
		const store = new MemoryProjectStore();
		await store.write(
			projectFilePath(DIRECTORY),
			serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')))
		);
		const storage = new FakeJournalStorage();
		const session = new EditorSession(store, { journalStorage: storage, workspaceKey: WORKSPACE });
		await session.refresh();
		return { session, storage, store };
	}

	it('retires every journalled edit belonging to the Project it deletes', async () => {
		const { session, storage } = await sessionWithJournal();
		const journal = new WriteAheadJournal(storage, WORKSPACE);
		journal.record(`${DIRECTORY}/annotations/one.geojson` as StorePath, new Uint8Array([1]));
		journal.record(`${DIRECTORY}/project.json` as StorePath, new Uint8Array([2]));
		// A different Project's entry, which must survive: the sweep is scoped by directory prefix and
		// a sweep that took everything would be the deletion eating somebody else's unsaved work.
		journal.record('boston-1775/project.json' as StorePath, new Uint8Array([3]));

		await session.deleteProject(DIRECTORY);

		expect(readJournal(storage, WORKSPACE).entries.map((entry) => entry.path)).toEqual([
			'boston-1775/project.json'
		]);
	});

	/**
	 * The other half of the same sweep, and the half that was missing (ticket 21, review 2): the
	 * journal is written *from* `Autosave`'s pending bytes, so emptying only the journal left
	 * `pagehide`'s `capture()` free to put the deleted Project's `project.json` straight back.
	 */
	it('gives up the pending bytes too, so a pagehide capture cannot re-journal them', async () => {
		const { session, storage, store } = await sessionWithJournal();
		// A write that has started and not landed — the state `Autosave` holds bytes in, and the one
		// the sweep left untouched. Anything else here resolves before `capture` could see it, which
		// is what made the first spelling of this test vacuous: it passed with `abandon` gutted.
		store.write = () => new Promise<never>(() => undefined);
		void session.renameProject(DIRECTORY, 'Renamed and never landed');
		// One turn, for the manifest read the rename does before it writes.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(readJournal(storage, WORKSPACE).entries.map((entry) => entry.path)).toEqual([
			`${DIRECTORY}/project.json`
		]);

		await session.deleteProject(DIRECTORY);
		// Rule 3's synchronous half, as `installFlushOnHide` fires it at `pagehide`.
		session.capture();

		expect(readJournal(storage, WORKSPACE).entries).toEqual([]);
	});

	/** And the record carries what the hub was showing, which is what a startup checks before removing. */
	it('records the Project’s identity, not only its folder name', async () => {
		const { session, storage } = await sessionWithJournal();
		const store = new MemoryProjectStore();
		// A store that never answers: the deletion cannot finish, so the record is still there to read.
		store.list = () => new Promise<never>(() => undefined);
		const stalled = new EditorSession(store, {
			journalStorage: storage,
			workspaceKey: WORKSPACE
		});
		stalled.projects = session.projects;

		void stalled.deleteProject(DIRECTORY);

		expect(new DeletedProjects(storage, WORKSPACE).pending()).toEqual([
			{
				directory: DIRECTORY,
				at: expect.any(String),
				was: { name: 'Amsterdam 1625', updatedAt: '2026-08-08T00:00:00.000Z' }
			}
		]);
	});
});

/**
 * ⚠ **THE LAST "DESTROY SYNCHRONOUSLY, JUSTIFY ASYNCHRONOUSLY" PAIR IN THE APPLICATION.**
 *
 * `deleteHistoricalMap` had `deleteProject`'s exact inversion and a **wider** window: its first
 * `await` is `historicalMapUsage`, a walk of every Project in the Workspace, where `deleteProject`'s
 * was a single `store.list` — and that one lost 4 runs in 20. The synchronous half was the
 * destructive one (the journal sweep, which holds the user's unsaved Alignment edit) and the
 * asynchronous half was the one a reload cuts. A reload in between lost the edit **and** left the map
 * in place: data loss with no deletion to justify it.
 */
describe('deleting a Historical Map, at the unit seam', () => {
	const WORKSPACE = 'opfs:My Workspace';
	const IMAGE = 'amsterdam-plate-1';

	async function sessionOverAMap(store: MemoryProjectStore): Promise<{
		session: EditorSession;
		storage: FakeJournalStorage;
	}> {
		await store.write(
			projectFilePath(DIRECTORY),
			serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')))
		);
		const storage = new FakeJournalStorage();
		const session = new EditorSession(store, { journalStorage: storage, workspaceKey: WORKSPACE });
		return { session, storage };
	}

	/** The unsaved Alignment edit a scholar has typed and not yet had written. */
	const journalTheAlignment = (storage: FakeJournalStorage) =>
		new WriteAheadJournal(storage, WORKSPACE).record(
			alignmentPath(IMAGE) as StorePath,
			new Uint8Array([1, 2, 3])
		);

	it('does not throw the unsaved Alignment away before the deletion has happened', async () => {
		const store = new MemoryProjectStore();
		const { session, storage } = await sessionOverAMap(store);
		journalTheAlignment(storage);
		// A page that stops running continuations, stalled on `historicalMapUsage`'s first walk.
		store.list = () => new Promise<never>(() => undefined);

		void session.deleteHistoricalMap(IMAGE);

		// Synchronously, in the same turn: nothing has been deleted, so nothing has been given up.
		expect(readJournal(storage, WORKSPACE).entries.map((entry) => entry.path)).toEqual([
			alignmentPath(IMAGE)
		]);
	});

	/**
	 * The opposite mistake, which sweeping unconditionally *after* the await would make: a refusal is
	 * taken before a byte is deleted, so the map is still right there and so is the edit.
	 */
	it('keeps the unsaved Alignment when the deletion is refused because a Project draws the map', async () => {
		const store = new MemoryProjectStore();
		const { session, storage } = await sessionOverAMap(store);
		await store.write(
			imageInfoPath(IMAGE),
			new TextEncoder().encode(JSON.stringify({ width: 1000, height: 800 }))
		);
		await session.open(DIRECTORY);
		expect(await session.addWorkspaceMap(IMAGE)).not.toBeNull();
		await session.flush();
		journalTheAlignment(storage);

		const deleted = await session.deleteHistoricalMap(IMAGE);

		expect(deleted).toBe(false);
		expect(session.historicalMapError).not.toBe('');
		expect(readJournal(storage, WORKSPACE).entries.map((entry) => entry.path)).toEqual([
			alignmentPath(IMAGE)
		]);
	});

	/** And when it does happen, the journalled bytes go — the point of the sweep in the first place. */
	it('retires the map’s journalled bytes once the files are actually gone', async () => {
		const store = new MemoryProjectStore();
		const { session, storage } = await sessionOverAMap(store);
		await store.write(imageInfoPath(IMAGE), new TextEncoder().encode('{}'));
		// alignment-write-is-the-fixture: the Alignment on disk is the specimen this deletion takes with the map
		await store.write(alignmentPath(IMAGE) as StorePath, new TextEncoder().encode('{}'));
		journalTheAlignment(storage);

		expect(await session.deleteHistoricalMap(IMAGE)).toBe(true);

		expect(readJournal(storage, WORKSPACE).entries).toEqual([]);
	});
});
