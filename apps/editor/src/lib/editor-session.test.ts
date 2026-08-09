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
	acceptRemoteImageService,
	imageInfoPath,
	newAlignment,
	newProjectFile,
	projectFilePath,
	readJournal,
	serialiseProjectFile,
	type StorePath
} from '@ballastella/core';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	EditorSession,
	folderWorkspaceKey,
	opfsWorkspaceKey,
	workspaceIdentityOf
} from './editor-session.svelte.js';

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

		// ⚠ **Not awaited, and that is the assertion.** The sweep is the synchronous half of
		// `Autosave.abandon`, which is the only half a document being torn down would run — so it has
		// to be complete before the deletion's first `await`, and `capture()` here is `pagehide`
		// firing in that window. Awaiting the deletion would prove nothing about it and could not
		// resolve anyway: this store's write never lands, which is what a page that has stopped
		// running its continuations looks like from in here.
		void session.deleteProject(DIRECTORY);
		// Rule 3's synchronous half, as `installFlushOnHide` fires it at `pagehide`.
		session.capture();

		expect(readJournal(storage, WORKSPACE).entries).toEqual([]);
	});

	/**
	 * ⚠ **`abandon` cannot call back a write the store already has**, and the sweep alone read as
	 * though it could (ticket 21, review 3). `Autosave.#drainLoop` captures its `bytes` and then
	 * awaits `store.write`; clearing the pending bytes does not reach into that await. So a
	 * `project.json` write in flight when Delete is pressed — a rename inside its debounce whose
	 * timer has just fired — resolves **after** `#removeEverythingIn` has listed the directory, and
	 * writes the manifest back behind the deletion. `deleteProject` then drops its own record on the
	 * next line, so the Project is on the hub again at the next startup with nothing left to catch
	 * it: the exact defect this ticket exists to close, by a route the sweep could not see.
	 */
	it('waits out a write it could not call back, so the manifest is not written back behind it', async () => {
		const { session, store } = await sessionWithJournal();
		// A store that has taken the bytes and not finished with them, held open by hand.
		let land = (): void => undefined;
		const write = store.write.bind(store);
		store.write = (path, bytes) =>
			new Promise<void>((resolve, reject) => {
				land = () => void write(path, bytes).then(resolve, reject);
			});
		void session.renameProject(DIRECTORY, 'Renamed and still in flight');
		await new Promise((resolve) => setTimeout(resolve, 0));

		const deletion = session.deleteProject(DIRECTORY);
		// A whole macrotask, so every microtask the deletion could run has run: without the wait the
		// listing and the deletes are all long finished by here, and the manifest lands on an empty
		// directory.
		await new Promise((resolve) => setTimeout(resolve, 0));
		land();
		await deletion;

		expect(await store.list('')).toEqual([]);
	});

	/**
	 * ⚠ **The only exit a refusal had was the destructive one** (ticket 21, round 4).
	 *
	 * Since round 3 a folder Workspace finishes no deletion unattended, so a refusal is the whole of
	 * what a startup there ever reports — and nothing ended one. No record expires, `#claim` drops
	 * one only on create or duplicate, Workspace settings cannot reach the Workspace that is open,
	 * and the panel's dismiss is keyed on report *contents*, so the identical report returns at every
	 * startup. The sentence's one remedy — "delete it again" — destroys the Project of whoever's
	 * folder this is.
	 */
	it('forgets the note behind a refusal, and takes the panel with the last one', async () => {
		const { session, storage } = await sessionWithJournal();
		new DeletedProjects(storage, WORKSPACE).record(DIRECTORY, {
			name: 'Amsterdam 1625',
			updatedAt: 'a time this Project no longer says'
		});
		await session.finishInterruptedDeletions();
		expect(session.deletionReport?.refused.map((entry) => entry.directory)).toEqual([DIRECTORY]);

		session.forgetDeletion(DIRECTORY);

		// The note is gone, so the next startup says nothing…
		expect(new DeletedProjects(storage, WORKSPACE).has(DIRECTORY)).toBe(false);
		// …and the panel goes with it rather than lingering with an empty list.
		expect(session.deletionReport).toBeNull();
		// And it is a note that went, never a file: the Project is exactly where it was.
		expect(await session.store.list('')).toEqual([projectFilePath(DIRECTORY)]);
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

	/**
	 * Hold exactly one path's write open, and answer the function that lets it land.
	 *
	 * Every other path writes through untouched, which is what keeps each test above holding one
	 * prefix and leaving the other quiet.
	 */
	function holdOneWriteOpen(
		store: MemoryProjectStore,
		target: string,
		options: { thenFail?: boolean } = {}
	): () => void {
		const write = store.write.bind(store);
		let land = (): void => undefined;
		let held = false;
		store.write = async (path, bytes) => {
			if (held || (path as string) !== target) return write(path, bytes);
			held = true;
			return new Promise<void>((resolve, reject) => {
				land = () =>
					void write(path, bytes).then(
						() => (options.thenFail ? reject(new Error('the folder grant went away')) : resolve()),
						reject
					);
			});
		};
		return () => land();
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

	/**
	 * ⚠ **The Alignment is not under `images/<id>/`, and the pending-bytes sweep was only given that
	 * prefix** (ticket 21, review 3). `alignmentPath(id)` is `alignments/<id>.json` — a sibling — so
	 * the hole item 2 of review 2 closed for the pyramid was left open on the one path where the
	 * unsaved specimen *is* the Alignment. Its journal entry was forgotten and the bytes it is
	 * written from were not, leaving `capture()` to re-journal it at `pagehide` and `flush()` to
	 * write it outright: `alignments/<id>.json` recreated for a Historical Map that is gone, which is
	 * the orphan `deleteHistoricalMap` exists to prevent.
	 *
	 * The test that missed it asserted only that the journal was empty, which the sweep's other half
	 * already made true.
	 */
	it('gives up the Alignment’s pending bytes, not only its journal entry', async () => {
		const store = new MemoryProjectStore();
		const { session, storage } = await sessionOverAMap(store);
		await store.write(imageInfoPath(IMAGE), new TextEncoder().encode('{}'));
		await session.open(DIRECTORY);
		// An Alignment edit that has started and not landed — the state `Autosave` holds bytes in.
		const write = store.write.bind(store);
		store.write = (path, bytes) =>
			(path as string) === (alignmentPath(IMAGE) as string)
				? new Promise<never>(() => undefined)
				: write(path, bytes);
		void session.writeAlignment(newAlignment(IMAGE, { width: 10, height: 10 }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		store.write = write;
		expect(readJournal(storage, WORKSPACE).entries.map((entry) => entry.path)).toEqual([
			alignmentPath(IMAGE)
		]);

		expect(await session.deleteHistoricalMap(IMAGE)).toBe(true);
		// Rule 3's synchronous half, exactly as `installFlushOnHide` fires it at `pagehide`. It
		// re-journals whatever `Autosave` still holds pending, which is the route the sweep's other
		// half was left open on: with the journal emptied and the bytes kept, this line put the
		// Alignment straight back.
		session.capture();

		expect(readJournal(storage, WORKSPACE).entries).toEqual([]);
		// And the map's files really did go, so this is not a green from nothing having happened.
		expect(await store.list('')).toEqual([projectFilePath(DIRECTORY)]);
	});

	/**
	 * ⚠ **THE WINDOW, AND IT IS ON BOTH OF THE MAP'S PREFIXES** (ticket 21, rounds 4 and 5).
	 *
	 * `Autosave.abandon` cannot call back a write the store already has, and `#forgetJournalled` runs
	 * *after* the deletion — so a write in flight when Delete is pressed lands on top of a map that
	 * has gone. Round 4 closed that for `alignments/<id>.json` and left `images/<id>/` wide open with
	 * no sentence saying why the two were different. They are not: `deleteHistoricalMap` removes both
	 * and `#forgetJournalled` sweeps both, so the argument covers both or neither.
	 *
	 * ⚠ **One prefix per test, and that is not tidiness.** Written as one test holding both writes,
	 * the two waits sit in the same `Promise.all` and either one alone parks the deletion until both
	 * are released — so removing either call left the suite green and the pair asserted nothing about
	 * either. Each test below holds exactly one write open and leaves the other prefix quiet.
	 */
	it('lets an in-flight Alignment write land before deleting the map', async () => {
		const store = new MemoryProjectStore();
		const { session } = await sessionOverAMap(store);
		await store.write(imageInfoPath(IMAGE), new TextEncoder().encode('{}'));
		// alignment-write-is-the-fixture: the Alignment on disk is what the deletion has to take with the map
		await store.write(alignmentPath(IMAGE) as StorePath, new TextEncoder().encode('{}'));
		await session.open(DIRECTORY);
		const land = holdOneWriteOpen(store, alignmentPath(IMAGE));
		void session.writeAlignment(newAlignment(IMAGE, { width: 10, height: 10 }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const deletion = session.deleteHistoricalMap(IMAGE);
		// A whole macrotask, so every await the deletion could run has run. Without the wait it is
		// finished by here and the write lands on a directory the deletion has already emptied.
		await new Promise((resolve) => setTimeout(resolve, 0));
		land();

		expect(await deletion).toBe(true);
		// An orphaned placement for a map that is gone is the one leftover `deleteHistoricalMap`
		// exists to prevent — a later import would deduplicate a colleague's copy against it.
		expect(await store.list('')).toEqual([projectFilePath(DIRECTORY)]);
	});

	it('lets an in-flight write under images/<id>/ land before deleting the map', async () => {
		const store = new MemoryProjectStore();
		const { session } = await sessionOverAMap(store);
		await session.open(DIRECTORY);
		// A real service, built the way the app builds one — from a service document, through the
		// guards — rather than a shape cast into the type, so this cannot drift from production.
		const service = await acceptRemoteImageService(
			{
				'@context': 'http://iiif.io/api/image/3/context.json',
				id: 'https://static.example.test/iiif/plate-1',
				type: 'ImageService3',
				protocol: 'http://iiif.io/api/image',
				profile: 'level2',
				width: 1024,
				height: 1024,
				tiles: [{ width: 256, scaleFactors: [1, 2, 4] }]
			},
			{
				requestedUrl: 'https://static.example.test/iiif/plate-1/info.json',
				fallbackUri: 'https://static.example.test/iiif/plate-1'
			}
		);
		// Landed, and then reported as failed. A real File System Access shape — a folder grant
		// revoked between the bytes reaching disk and the write being acknowledged — and the one that
		// isolates this: `addReferencedMap` takes its failure branch, so no Layer is added and the
		// deletion below is not refused, while the bytes are on disk exactly as a late write leaves
		// them.
		const land = holdOneWriteOpen(store, `images/${service.imageId}/remote.json`, {
			thenFail: true
		});
		void session.addReferencedMap({
			service,
			label: 'Plate 1',
			partOf: '',
			canvas: '',
			rights: '',
			attribution: '',
			alignment: null
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const deletion = session.deleteHistoricalMap(service.imageId);
		await new Promise((resolve) => setTimeout(resolve, 0));
		land();

		expect(await deletion).toBe(true);
		// A `remote.json` describing a pyramid that is not there: the map is unlisted, its citation
		// survives it, and nothing in the Workspace admits the bytes exist.
		expect(await store.list('')).toEqual([projectFilePath(DIRECTORY)]);
	});

	/**
	 * The third arm of the conditional sweep, and the one no test constructed: a deletion that got
	 * part way. `HistoricalMapPartlyDeletedError` is the only failure that means bytes are gone, and
	 * bytes being gone is the whole of what licenses throwing the journalled copies away — so the arm
	 * that acts on it has to be exercised, or "conditional" is a claim about one branch.
	 */
	it('retires the journalled bytes of a map the Workspace only half deleted', async () => {
		const store = new MemoryProjectStore();
		const { session, storage } = await sessionOverAMap(store);
		await store.write(imageInfoPath(IMAGE), new TextEncoder().encode('{}'));
		// alignment-write-is-the-fixture: the Alignment on disk is the specimen this half-finished deletion is measured by
		await store.write(alignmentPath(IMAGE) as StorePath, new TextEncoder().encode('{}'));
		journalTheAlignment(storage);
		// The Alignment goes first and by design, so refusing the second delete is a map whose
		// placement has gone and whose `info.json` has not: still listed, and half its bytes removed.
		let seen = 0;
		const remove = store.delete.bind(store);
		store.delete = async (path) => {
			seen += 1;
			if (seen === 2) throw new Error('The Workspace is locked');
			return remove(path);
		};

		expect(await session.deleteHistoricalMap(IMAGE)).toBe(false);

		expect(session.historicalMapError).toContain('only partly deleted');
		expect(readJournal(storage, WORKSPACE).entries).toEqual([]);
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

/**
 * ⚠ **The one function that decides whether a recorded deletion may destroy anything**, and its
 * only coverage was transitive, through the browser suite (ticket 21, round 4).
 *
 * `WorkspaceIdentity` is the whole of round 3's design: identity is a property of the **key**,
 * because a copy reproduces a Project's contents perfectly and no comparison of them can tell two
 * folders apart. This is where a key becomes that answer, and it is two lines of prefix matching —
 * which is exactly the kind of thing that gets "simplified" by somebody who has not read the two
 * hundred lines of comment behind it. It belongs in the fast suite.
 */
describe('what a Workspace key says about which directory it is', () => {
	it('calls a named browser Workspace one place, because this origin owns it', () => {
		expect(workspaceIdentityOf(opfsWorkspaceKey('Marking 2026'))).toBe('this-browser');
	});

	it('calls a picked folder a name anywhere, because two drives may both hold one', () => {
		expect(workspaceIdentityOf(folderWorkspaceKey('maps'))).toBe('a-name-anywhere');
	});

	/**
	 * A key from a build that spelled them differently, and the empty key a session with no Workspace
	 * key at all supplies. Both answer the direction that destroys nothing — the same rule
	 * `Workspace`'s own default follows, and for the same reason.
	 */
	it('calls anything it does not recognise a name anywhere', () => {
		expect(workspaceIdentityOf('')).toBe('a-name-anywhere');
		expect(workspaceIdentityOf('sharepoint:Teaching')).toBe('a-name-anywhere');
		// Not a prefix match on a substring: `opfs:` has to be where the key starts.
		expect(workspaceIdentityOf('mirror-of-opfs:Teaching')).toBe('a-name-anywhere');
	});
});
