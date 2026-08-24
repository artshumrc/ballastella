// `EditorSession` against an in-memory store (ticket 06).
//
// The session takes a `ProjectStore`, so an in-memory one is the whole of what a test needs — which
// is what makes this the second thing worth having a Node seam for. What is asserted here is the
// pair of failure paths behind the "Add a Map Image" dialog: a Workspace whose `images/`
// cannot be walked, and a map whose record does not say how big it is. Both are refusals, both are
// a sentence a user reads, and neither has a gesture in the interface that produces it on demand.

import {
	DeletedProjects,
	FakeJournalStorage,
	FakeMetadataStorage,
	ManagedProjectStore,
	MemoryProjectStore,
	WriteAheadJournal,
	alignmentPath,
	annotationPath,
	acceptRemoteImageService,
	emptyAnnotationCollection,
	fingerprintOf,
	fullImageResourceMask,
	newAnnotationLayer,
	newAnnotation,
	newMapLayer,
	imageInfoPath,
	newAlignment,
	newProjectFile,
	projectFilePath,
	serialiseAlignment,
	readHeldCopies,
	readJournal,
	serialiseProjectFile,
	type Alignment,
	type AnnotationLayer,
	type Bytes,
	type StorePath
} from '@ballastella/core';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	EditorSession,
	folderWorkspaceKey,
	opfsWorkspaceKey,
	trackLocalChanges,
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

	/**
	 * Called once the store really has the bytes, and **before whoever asked has been told**.
	 *
	 * That gap is not a curiosity: it is where `writeAlignment`'s baseline is stale while the file on
	 * disk has already moved on, and therefore where this session can mistake its own bytes for a
	 * colleague's. A hook rather than a timing guess, so the test that covers it is deterministic —
	 * see "a gesture ends inside the previous write" below.
	 */
	afterWrite: ((path: StorePath) => void) | undefined;

	override async list(prefix: string): Promise<StorePath[]> {
		if (this.failing && prefix.startsWith('images/')) {
			throw new Error('the images folder could not be read');
		}
		return super.list(prefix);
	}

	/**
	 * Called once a read has been answered, which for an Alignment write is the *concurrency re-read*
	 * — the moment between "what is on disk" and "here are my bytes". Anything that commits inside
	 * that gap is committing something the write in progress is about to go over.
	 */
	afterRead: ((path: StorePath) => void) | undefined;

	/** Paths this store will refuse to write, so a failing save is a case a test can drive. */
	refuseWrite: ((path: StorePath) => boolean) | undefined;

	override async write(path: StorePath, bytes: Bytes): Promise<void> {
		if (this.refuseWrite?.(path)) throw new Error(`the Workspace refused to write ${path}`);
		await super.write(path, bytes);
		this.afterWrite?.(path);
	}

	override async read(path: StorePath): Promise<Bytes> {
		const bytes = await super.read(path);
		this.afterRead?.(path);
		return bytes;
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

describe('the picker behind “Add a Map Image”', () => {
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
		// `refreshMapImages` sets `status = 'unreachable'` on any throw, which blanks the whole
		// editor and offers the Workspace-recovery affordance. That is right for the hub, where the
		// Workspace *is* the screen. The dialog calls this walk on every open, so a transient
		// failure reading `images/` used to blank a scholar's open Project because they pressed a
		// button.
		const store = new ImagesGoAway();
		const failing = await openOn(store);
		expect(failing.status).toBe('ready');
		store.failing = true;

		await failing.refreshAddableMapImages();

		expect(failing.status).toBe('ready');
		expect(failing.openProject).not.toBeNull();
		expect(failing.addMapError).toContain('could not be looked through');
		expect(failing.mapImagesLoading).toBe(false);
	});

	it('still takes the hub’s own walk to the unreachable state', async () => {
		// The other half of the same rule, so the split is asserted from both sides rather than
		// being a difference one caller happens to have.
		const store = new ImagesGoAway();
		const failing = await openOn(store);
		store.failing = true;

		await failing.refreshMapImages();

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

	/**
	 * ⚠ **The same corner, reached by a different route** (ticket 07, round 2).
	 *
	 * `'superseded'` is the first replay skip that *keeps* its journal entry — deliberately, because
	 * those bytes are the only copy of an edit that reached no store. The panel's dismiss is keyed on
	 * report contents, so a kept entry means a byte-identical warning at every startup for ever, and
	 * the only other exit is discarding the whole Workspace's journal. So the row carries its own.
	 */
	it('throws away one refused entry’s kept copy, and takes the panel with the last one', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const path = `${DIRECTORY}/annotations/one.geojson` as StorePath;
		const journal = new WriteAheadJournal(storage, WORKSPACE);
		// A stranded edit that knows what was on disk, then something else writing that path — which
		// is what makes the replay refuse rather than restore.
		await store.write(path, new TextEncoder().encode('v1') as Bytes);
		journal.record(path, new TextEncoder().encode('v1') as Bytes);
		journal.forget(path);
		journal.record(path, new TextEncoder().encode('the edit that stranded') as Bytes);
		await store.write(path, new TextEncoder().encode('v2-NEWER') as Bytes);

		await session.replayJournalledEdits();
		const skip = session.replayReport?.skipped[0];
		expect([skip?.reason, skip?.copy]).toEqual(['superseded', expect.any(String)]);

		// ⚠ **A second row whose declined bytes are byte-identical, so it shares a fingerprint** (round
		// 6, finding D). An empty Annotation collection in two Projects is the ordinary way to get one.
		// Filtered on the fingerprint alone, dismissing this row removed both — while only one copy was
		// destroyed, so the survivor came back at the next startup with no explanation.
		const twin = `${DIRECTORY}/annotations/twin.geojson` as StorePath;
		new WriteAheadJournal(storage, WORKSPACE).hold(
			twin,
			new TextEncoder().encode('the edit that stranded') as Bytes,
			'',
			'superseded'
		);
		await session.replayJournalledEdits();
		expect(session.replayReport?.skipped).toHaveLength(2);
		const rows = session.replayReport?.skipped ?? [];
		expect(new Set(rows.map((row) => row.copy)).size).toBe(1);

		session.forgetReplaySkip(path, skip?.copy ?? '');

		// The twin is still there, named and offered, because it is a different file.
		expect(session.replayReport?.skipped.map((row) => row.path)).toEqual([twin]);
		expect(readHeldCopies(storage, WORKSPACE).copies.map((copy) => copy.path)).toEqual([twin]);

		// And what it refused to overwrite is exactly where it was.
		expect(new TextDecoder().decode(await store.read(path))).toBe('v2-NEWER');
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * A STRANDED EDIT IS PUT BACK, RATHER THAN REPORTED AND HELD (ticket 07, round 4)
	 *
	 * This is the whole value of the read-path seam, driven end to end: **the same sequence answered
	 * `'cannot-tell-which-is-newer'` before it existed.**
	 *
	 * A journal entry has to say what its edit was made against, and nothing on the *write* side can
	 * tell it — `record` is synchronous and `Autosave` only learns what the store holds when a write
	 * is acknowledged, which is the case that already worked. Opening the Project is the read that
	 * makes it knowable, and it is a read the application was doing anyway.
	 */
	it('puts a stranded edit back at the next startup, because opening the Project said what was on disk', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const path = projectFilePath(DIRECTORY);
		const onDisk = await store.read(path);

		// The read that already happens. Nothing is written by it (ADR-0010).
		await session.open(DIRECTORY);

		// The scholar renames, and the store refuses the write: the edit is stranded, and its journal
		// entry is now the only copy of it.
		const write = store.write.bind(store);
		store.write = () => Promise.reject(new Error('the drive is not there'));
		await session
			.renameProject(DIRECTORY, 'A name that did not reach the disk')
			.catch(() => undefined);
		expect(readJournal(storage, WORKSPACE).entries[0]?.held).toBe(fingerprintOf(onDisk));

		// A new tab, with the drive back.
		store.write = write;
		await session.replayJournalledEdits();

		expect(session.replayReport?.restored).toEqual([path]);
		expect(session.replayReport?.skipped).toEqual([]);
		expect(new TextDecoder().decode(await store.read(path))).toContain(
			'A name that did not reach the disk'
		);
	});

	/**
	 * The same seam on the file a scholar actually edits all day.
	 *
	 * Deliberately a collection **already on disk that this session never wrote**: a Layer added in
	 * this session has its baseline from the `forget` of its own first write, which is the case that
	 * worked before ticket 07. Last week's Annotations, opened today, are the case that did not.
	 */
	it.each([
		['readAnnotations', (s: EditorSession, l: AnnotationLayer) => s.readAnnotations(l)],
		['readLayerFeatures', (s: EditorSession, l: AnnotationLayer) => s.readLayerFeatures(l)]
	])('says what an Annotation collection held, from %s', async (_name, read) => {
		// ⚠ **Both readers, because they are two methods over one file.** The Layer stack draws through
		// `readLayerFeatures` and the editing surface through `readAnnotations`, and a scholar can reach
		// an edit through either — so a baseline that only one of them supplied would be missing on
		// whichever route they happened to take.
		const { session, storage, store } = await sessionWithJournal();
		const layer = newAnnotationLayer({ id: 'one', name: 'Warehouses' });
		const path = `${DIRECTORY}/${layer.geojsonRef}` as StorePath;
		const onDisk = new TextEncoder().encode(
			'{"type":"FeatureCollection","features":[],"note":"last week"}'
		) as Bytes;
		await store.write(path, onDisk);
		await store.write(
			projectFilePath(DIRECTORY),
			serialiseProjectFile({
				...newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')),
				layers: [layer]
			})
		);
		await session.open(DIRECTORY);

		await read(session, layer);

		// The scholar edits, and the write strands.
		store.write = () => Promise.reject(new Error('the drive is not there'));
		await session
			.writeAnnotations(layer, { ...emptyAnnotationCollection(), annotations: [] })
			.catch(() => undefined);

		expect(readJournal(storage, WORKSPACE).entries.find((entry) => entry.path === path)?.held).toBe(
			fingerprintOf(onDisk)
		);
	});

	/**
	 * And the third read, the one whose file is shared by every Project that draws the map.
	 *
	 * Worth its own test rather than folded into the two above: an Alignment is written through
	 * `alignment-file.ts` and read through a different method from either of them, so "the read paths
	 * report" is three call sites and not one.
	 */
	it.each([
		[
			'readAlignment',
			(sn: EditorSession, image: { width: number; height: number }) =>
				sn.readAlignment('floride-1657', image)
		],
		[
			'readLayerAlignment',
			(sn: EditorSession) =>
				sn.readLayerAlignment(newMapLayer({ id: 'l', name: 'La Floride', imageId: 'floride-1657' }))
		]
	])('says what an Alignment held, from %s', async (_name, read) => {
		// ⚠ **Both readers, one per test row.** The alignment editor reads through the first and the
		// Project screen draws through the second; a scholar reaches an edit by either route. Driving
		// them in one test would let each one cover for the other's deletion, which is the coincidence
		// that has hidden two defects in this ticket already.
		const { session, storage, store } = await sessionWithJournal();
		const image = { width: 400, height: 300 };
		const onDisk = serialiseAlignment({
			...newAlignment('floride-1657', image),
			controlPoints: [
				{ id: 'p0', ordinal: 1, resource: { x: 10, y: 20 }, geo: { lng: 4.9, lat: 52.3 } }
			]
		});
		// alignment-write-is-the-fixture: last week's Alignment, on disk before this session started; the point of the test is that reading it is what tells the journal what the edit is made against
		await store.write(alignmentPath('floride-1657') as StorePath, onDisk);
		await session.open(DIRECTORY);

		const alignment = await read(session, image);
		if (alignment === null) throw new Error('the fixture Alignment did not read back');

		// Another Control Point, and the store refuses the write.
		store.write = () => Promise.reject(new Error('the drive is not there'));
		await session
			.writeAlignment({
				...alignment,
				controlPoints: [
					...alignment.controlPoints,
					{ id: 'p1', ordinal: 2, resource: { x: 30, y: 40 }, geo: { lng: 5.0, lat: 52.4 } }
				]
			})
			.catch(() => undefined);

		expect(
			readJournal(storage, WORKSPACE).entries.find(
				(entry) => entry.path === alignmentPath('floride-1657')
			)?.held
		).toBe(fingerprintOf(onDisk));
	});

	/**
	 * ⚠ **The one thing the seam must not buy back.** Reading fixes what the edit was made against; it
	 * does not license writing over whatever turns up later. A Workspace restore between the read and
	 * the startup still has to be refused.
	 */
	it('still refuses to put that edit back over something written after it', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const path = projectFilePath(DIRECTORY);

		await session.open(DIRECTORY);

		const write = store.write.bind(store);
		store.write = () => Promise.reject(new Error('the drive is not there'));
		await session
			.renameProject(DIRECTORY, 'A name that did not reach the disk')
			.catch(() => undefined);
		store.write = write;
		// Something outside `Autosave` — a tar restored into this Workspace — writing the same path.
		const colleague = serialiseProjectFile(
			newProjectFile('The colleague’s name', new Date('2026-08-09T00:00:00Z'))
		);
		await store.write(path, colleague);

		await session.replayJournalledEdits();

		expect(session.replayReport?.restored).toEqual([]);
		expect(session.replayReport?.skipped.map((entry) => entry.reason)).toEqual(['superseded']);
		expect(await store.read(path)).toEqual(colleague);
		// And the scholar's copy is still held — out of the live journal, so the next edit to this file
		// overwrites an entry rather than the copy the notice is about (round 5, finding B).
		expect(readJournal(storage, WORKSPACE).entries).toEqual([]);
		expect(readHeldCopies(storage, WORKSPACE).copies.map((held) => held.path)).toEqual([path]);
	});

	/**
	 * ⚠ **A held copy has to go with the Map Image it belongs to** (round 6, finding B).
	 *
	 * `alignments/<id>.json` is a *sibling* of `images/<id>/`, which is why `#forgetJournalled` needs a
	 * second call at all — and that second call was `forget`, which sweeps no held copy and, worse,
	 * means "the store has taken these bytes". A copy declined for a deleted map's Alignment outlived
	 * the map and was reported at every startup for ever, with a remedy about a file that is gone.
	 */
	it('takes a declined Alignment copy with the Map Image it belonged to', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const image = { width: 400, height: 300 };
		const onDisk = serialiseAlignment(newAlignment('floride-1657', image));
		// alignment-write-is-the-fixture: the Alignment on disk that the declined copy diverged from; nothing here writes one through the app
		await store.write(alignmentPath('floride-1657') as StorePath, onDisk);
		await store.write(imageInfoPath('floride-1657'), new TextEncoder().encode('{}') as Bytes);
		const journal = new WriteAheadJournal(storage, WORKSPACE);
		journal.hold(
			alignmentPath('floride-1657') as StorePath,
			new TextEncoder().encode('the control points that stranded') as Bytes,
			'',
			'cannot-tell-which-is-newer'
		);
		expect(readHeldCopies(storage, WORKSPACE).copies).toHaveLength(1);

		await session.deleteMapImage('floride-1657');

		expect(readHeldCopies(storage, WORKSPACE).copies).toEqual([]);
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
 * `deleteMapImage` had `deleteProject`'s exact inversion and a **wider** window: its first
 * `await` is `mapImageUsage`, a walk of every Project in the Workspace, where `deleteProject`'s
 * was a single `store.list` — and that one lost 4 runs in 20. The synchronous half was the
 * destructive one (the journal sweep, which holds the user's unsaved Alignment edit) and the
 * asynchronous half was the one a reload cuts. A reload in between lost the edit **and** left the map
 * in place: data loss with no deletion to justify it.
 */
describe('deleting a Map Image, at the unit seam', () => {
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
		// A page that stops running continuations, stalled on `mapImageUsage`'s first walk.
		store.list = () => new Promise<never>(() => undefined);

		void session.deleteMapImage(IMAGE);

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

		const deleted = await session.deleteMapImage(IMAGE);

		expect(deleted).toBe(false);
		expect(session.mapImageError).not.toBe('');
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
	 * write it outright: `alignments/<id>.json` recreated for a Map Image that is gone, which is
	 * the orphan `deleteMapImage` exists to prevent.
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

		expect(await session.deleteMapImage(IMAGE)).toBe(true);
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
	 * no sentence saying why the two were different. They are not: `deleteMapImage` removes both
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

		const deletion = session.deleteMapImage(IMAGE);
		// A whole macrotask, so every await the deletion could run has run. Without the wait it is
		// finished by here and the write lands on a directory the deletion has already emptied.
		await new Promise((resolve) => setTimeout(resolve, 0));
		land();

		expect(await deletion).toBe(true);
		// An orphaned placement for a map that is gone is the one leftover `deleteMapImage`
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

		const deletion = session.deleteMapImage(service.imageId);
		await new Promise((resolve) => setTimeout(resolve, 0));
		land();

		expect(await deletion).toBe(true);
		// A `remote.json` describing a pyramid that is not there: the map is unlisted, its citation
		// survives it, and nothing in the Workspace admits the bytes exist.
		expect(await store.list('')).toEqual([projectFilePath(DIRECTORY)]);
	});

	/**
	 * The third arm of the conditional sweep, and the one no test constructed: a deletion that got
	 * part way. `MapImagePartlyDeletedError` is the only failure that means bytes are gone, and
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

		expect(await session.deleteMapImage(IMAGE)).toBe(false);

		expect(session.mapImageError).toContain('only partly deleted');
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

		expect(await session.deleteMapImage(IMAGE)).toBe(true);

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

/**
 * An Alignment somebody else changed while this session had it open (ticket 07, ADR-0023).
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THE FALSE ALARM IS THE PART THAT NEEDS A TEST, AND IT HAS NO GESTURE.                     │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The true positive is reachable in a browser and is asserted in `alignment-file.test.ts` against
 * the writer. What is only reachable here is the **baseline discipline**: every write this session
 * makes has to move its own record of what is on disk, or the *next* ordinary save compares against
 * stale bytes and tells the user a colleague changed their Alignment when nobody did.
 *
 * That failure is worse than it sounds. A warning about work you cannot see, raised by your own
 * previous keystroke, is one a scholar learns to dismiss — and the next one is real.
 */
describe('the record of what is on disk for an Alignment', () => {
	const IMAGE = { width: 700, height: 500 };
	const IMAGE_ID = 'a-library-sheet';

	/**
	 * A colleague's Alignment, arriving through a synced Workspace.
	 *
	 * **One opt-out with the reasoning written once**, which is the discipline
	 * `packages/core/src/alignment/alignment-fixture.ts` sets out: three near-identical pragmas across
	 * three tests is enough pressure on the mechanism that people start pasting it without reading it.
	 * That helper is core's own and is not on the package's published surface, so the same shape is
	 * spelled here rather than reached for.
	 *
	 * This genuinely is not a write the application makes. It is another process's, which is the whole
	 * situation under test, and routing it through `writeAlignmentFile` would make the arrange step the
	 * very thing being asserted about.
	 */
	const aColleagueWrites = (store: MemoryProjectStore, document: string): Promise<void> =>
		// alignment-write-is-the-fixture: another process's Alignment landing through a sync, which is the situation under test and which no gesture in this app can produce
		store.write(`alignments/${IMAGE_ID}.json` as StorePath, new TextEncoder().encode(document));

	it('does not raise a concurrent-edit alarm on a session’s own successive saves', async () => {
		const opened = await openOn(new ImagesGoAway());
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);

		// Three ordinary saves in a row, exactly as placing three Control Points produces. Every one of
		// them writes over what the previous one wrote, and none of them is a concurrent edit.
		for (const count of [1, 2, 3]) {
			await opened.writeAlignment({
				...alignment,
				controlPoints: Array.from({ length: count }, (_, index) => ({
					id: `p${index}`,
					ordinal: index + 1,
					resource: { x: 10 * index, y: 20 * index },
					geo: { lng: 4.9 + index / 100, lat: 52.3 + index / 100 }
				}))
			});
			expect(opened.saveError).toBe('');
			expect(opened.alignmentChangedElsewhere).toBeNull();
		}
	});

	/** `count` well-behaved Control Points, so two saves differ in their bytes. */
	const pairs = (count: number) =>
		Array.from({ length: count }, (_, index) => ({
			id: `p${index}`,
			ordinal: index + 1,
			resource: { x: 10 * index, y: 20 * index },
			geo: { lng: 4.9 + index / 100, lat: 52.3 + index / 100 }
		}));

	/**
	 * A pair placed while the previous pair's write is still in flight.
	 *
	 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
	 * │ THE TEST ABOVE CANNOT REACH THIS, AND THIS COLLISION IS THIS SESSION'S OWN.                │
	 * └───────────────────────────────────────────────────────────────────────────────────────────┘
	 *
	 * Three `await`ed saves never overlap, so the baseline is always current by the time the next one
	 * reads it. But `AlignmentWorkspace.save()` **fires without awaiting** — a gesture end must not
	 * wait on a store write — and `writeAlignment` reads its baseline at entry while moving it only
	 * once the commit has resolved. So a second gesture ending inside that gap read a baseline one
	 * version stale, re-read the file, found the **first call's own bytes**, and told the user a
	 * colleague had written over their work — handing back their own document as the colleague's.
	 *
	 * ⚠ **The interleaving is chosen rather than raced for, and it has to be.** Two calls fired
	 * back-to-back both enter before either commit, so both see the same baseline *and* the same
	 * disk, and nothing is reported — which is why firing two and hoping proves nothing. The window
	 * that bites is narrower: after the first write's bytes have reached the store and before its
	 * continuation has recorded them. `afterWrite` puts the second gesture exactly there, which is
	 * what a deterministic test of a race looks like.
	 */
	it('does not raise a concurrent-edit alarm when a gesture ends inside the previous write', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(1) });

		let second: Promise<void> | undefined;
		store.afterWrite = (path) => {
			if (!path.startsWith('alignments/') || second) return;
			second = opened.writeAlignment({ ...alignment, controlPoints: pairs(3) });
		};
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(2) });
		await second;

		expect(opened.saveError).toBe('');
		expect(opened.alignmentChangedElsewhere).toBeNull();

		// **And the later gesture is what is on disk.** The cheap way to satisfy the assertion above is
		// to drop the second write, which would silently lose the pair the scholar just placed.
		const written = JSON.parse(
			new TextDecoder().decode(await store.read(`alignments/${IMAGE_ID}.json` as StorePath))
		);
		expect(written.body.features).toHaveLength(3);
	});

	it('does raise it when the file really changed underneath', async () => {
		// The unguarded direction, without which the test above passes against a build that never
		// reports anything at all — which is precisely what ticket 18 shipped.
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		await opened.writeAlignment({ ...alignment, controlPoints: [] });

		// Somebody else's write, arriving through a synced Workspace. Straight to the store, because it
		// is another process's write and not this session's.
		await aColleagueWrites(store, '{"type":"Annotation","from":"a colleague"}\n');

		await opened.writeAlignment({ ...alignment, controlPoints: [] });

		expect(opened.alignmentChangedElsewhere?.imageId).toBe(IMAGE_ID);
		expect(new TextDecoder().decode(opened.alignmentChangedElsewhere?.displaced)).toContain(
			'a colleague'
		);
	});

	it('offers the displaced version back, and stops warning once it is restored', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		await opened.writeAlignment({ ...alignment, controlPoints: [] });
		const theirs = '{"type":"Annotation","from":"a colleague"}\n';
		await aColleagueWrites(store, theirs);
		await opened.writeAlignment({ ...alignment, controlPoints: [] });
		expect(opened.alignmentChangedElsewhere).not.toBeNull();

		await opened.restoreAlignmentChangedElsewhere();

		// Their document is on disk, byte for byte — routed through `writeAlignmentBytes`, which is what
		// stops it being re-serialised through this build's model and losing whatever it does not model.
		expect(
			new TextDecoder().decode(await store.read(`alignments/${IMAGE_ID}.json` as StorePath))
		).toBe(theirs);
		expect(opened.alignmentChangedElsewhere).toBeNull();

		// **And the baseline moved with it.** Without that, the very next save reports their document as
		// a second concurrent change — a warning raised by the user's own act of accepting the first one.
		await opened.writeAlignment({ ...alignment, controlPoints: [] });
		expect(opened.alignmentChangedElsewhere).toBeNull();
	});

	/**
	 * "Put their version back" pressed while a save from the last gesture is still in flight.
	 *
	 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
	 * │ THE RESTORE IS A WRITE TOO, AND IT CAN BE OVERTAKEN BY THE WRITE IT IS UNDOING.            │
	 * └───────────────────────────────────────────────────────────────────────────────────────────┘
	 *
	 * A save is not awaited by the gesture that started it, and it is not one operation: it re-reads
	 * the file, then commits. A restore that commits **inside that gap** is committed and then written
	 * straight over by the save's own bytes — so the user presses a button that says "put their
	 * version back", the alert goes away, and what is on disk is theirs for a few milliseconds and
	 * then the user's again, with nothing saying so. That is worse than the false alarm above: it is a
	 * gesture that reports success and does the opposite.
	 *
	 * `afterRead` puts the restore exactly in that gap. It is the same instrument as `afterWrite`
	 * above and for the same reason — a race asserted at a chosen interleaving rather than raced for.
	 */
	it('puts their version back even when a save is mid-flight over it', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(1) });
		const theirs = '{"type":"Annotation","from":"a colleague"}\n';
		await aColleagueWrites(store, theirs);
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(2) });
		expect(opened.alignmentChangedElsewhere).not.toBeNull();

		let restored: Promise<boolean> | undefined;
		store.afterRead = (path) => {
			if (!path.startsWith('alignments/') || restored) return;
			restored = opened.restoreAlignmentChangedElsewhere();
		};
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(3) });
		await restored;

		expect(
			new TextDecoder().decode(await store.read(`alignments/${IMAGE_ID}.json` as StorePath)),
			'the save the user had already made came back over the version they asked to restore'
		).toBe(theirs);
		expect(opened.alignmentChangedElsewhere).toBeNull();
	});

	/**
	 * A *newer* warning, raised while the restore was waiting its turn.
	 *
	 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
	 * │ THE QUEUE MADE THIS REACHABLE, SO THE QUEUE OWES IT A TEST.                                │
	 * └───────────────────────────────────────────────────────────────────────────────────────────┘
	 *
	 * `restoreAlignmentChangedElsewhere` reads the pending warning at entry and then waits behind
	 * whatever is already writing the file. The save it waits behind can raise a *different* warning
	 * — a second colleague write, and the field is not keyed by image, so it can even be about another
	 * Map Image. Clearing it unconditionally at the end throws away an alert nobody has seen, and
	 * that alert is the one thing on the screen a user cannot find out any other way: nothing moved,
	 * nothing failed, and the indicator says "Saved".
	 */
	it('does not blank a warning that arrived while it was waiting its turn', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(1) });

		const first = '{"type":"Annotation","from":"the first colleague"}\n';
		await aColleagueWrites(store, first);
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(2) });
		expect(new TextDecoder().decode(opened.alignmentChangedElsewhere?.displaced)).toContain(
			'the first colleague'
		);

		// A second colleague's edit lands, and the next save is what notices it. The restore is started
		// inside that save's concurrency re-read, so it queues behind it and the warning it will find at
		// the end is not the one it was answering.
		const second = '{"type":"Annotation","from":"the second colleague"}\n';
		await aColleagueWrites(store, second);
		let restored: Promise<boolean> | undefined;
		store.afterRead = (path) => {
			if (!path.startsWith('alignments/') || restored) return;
			restored = opened.restoreAlignmentChangedElsewhere();
		};
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(3) });
		expect(await restored).toBe(true);

		// The first colleague's version is what the user asked for and what is on disk.
		expect(
			new TextDecoder().decode(await store.read(`alignments/${IMAGE_ID}.json` as StorePath))
		).toBe(first);
		// **And the second colleague's edit is still being warned about.** Nobody has seen this one yet.
		expect(
			new TextDecoder().decode(opened.alignmentChangedElsewhere?.displaced),
			'a warning the user had not seen was cleared by an answer to a different one'
		).toContain('the second colleague');
	});

	/**
	 * A restore the store refused.
	 *
	 * The caller announces the outcome in a sentence and moves focus to it, so "it worked" has to be
	 * something it can *ask*. Reported as a boolean rather than through `saveError`, which is
	 * Workspace-wide: an unrelated `project.json` failure would otherwise report this restore as
	 * having failed, and this call's success would clear a failure that has not gone away.
	 */
	it('says it did not put their version back, and leaves the warning standing', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(1) });
		await aColleagueWrites(store, '{"type":"Annotation","from":"a colleague"}\n');
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(2) });
		expect(opened.alignmentChangedElsewhere).not.toBeNull();

		store.refuseWrite = (path) => path.startsWith('alignments/');
		expect(await opened.restoreAlignmentChangedElsewhere()).toBe(false);

		expect(opened.saveError).toContain('refused to write');
		// Still standing, because their version is still the one that is not on disk.
		expect(opened.alignmentChangedElsewhere).not.toBeNull();
	});

	it('leaves an unrelated save failure on screen when it succeeds', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(1) });
		await aColleagueWrites(store, '{"type":"Annotation","from":"a colleague"}\n');
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(2) });

		// Something else in the Workspace failed a moment ago — a `project.json` write, say — and the
		// user can see it. Answering a question about an Alignment says nothing about that.
		opened.saveError = 'the Project could not be saved';
		expect(await opened.restoreAlignmentChangedElsewhere()).toBe(true);
		expect(
			opened.saveError,
			'a failure the user could see was taken off the screen by an unrelated success'
		).toBe('the Project could not be saved');
	});

	/**
	 * A third write arriving after the first one's bookkeeping has run, with the second still queued.
	 *
	 * The queue deletes its map entry only when the write finishing is the **last one queued**. Delete
	 * unconditionally and this is what happens: A finishes and clears the entry while B is still
	 * waiting on it, so C finds nothing to chain onto, starts immediately, and reads its baseline
	 * before B has moved it — which is the self-collision the queue exists to prevent, reintroduced by
	 * the cleanup.
	 *
	 * Two writes cannot reach it: B is always still chained when A's bookkeeping runs, so there is
	 * nothing for the condition to be wrong about.
	 */
	it('keeps a third write behind the second, not behind nothing', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		// A warm-up, so the file exists and a stale baseline is something `changedSince` can notice.
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(1) });

		const queued: Promise<void>[] = [];
		let landed = 0;
		store.afterWrite = (path) => {
			if (!path.startsWith('alignments/')) return;
			landed += 1;
			// B, queued behind A while A is still in flight; then C, queued while B is still in flight.
			if (landed === 1)
				queued.push(opened.writeAlignment({ ...alignment, controlPoints: pairs(3) }));
			if (landed === 2)
				queued.push(opened.writeAlignment({ ...alignment, controlPoints: pairs(4) }));
		};
		await opened.writeAlignment({ ...alignment, controlPoints: pairs(2) });
		while (queued.length > 0) await queued.shift();

		expect(opened.saveError).toBe('');
		expect(
			opened.alignmentChangedElsewhere,
			'a write that started before the one ahead of it had recorded its bytes'
		).toBeNull();
		const written = JSON.parse(
			new TextDecoder().decode(await store.read(`alignments/${IMAGE_ID}.json` as StorePath))
		);
		expect(written.body.features).toHaveLength(4);
	});

	it('is dismissible, and stays dismissed across the next save', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
		await opened.writeAlignment({ ...alignment, controlPoints: [] });
		await aColleagueWrites(store, '{"from":"a colleague"}\n');
		await opened.writeAlignment({ ...alignment, controlPoints: [] });

		opened.dismissAlignmentChangedElsewhere();
		expect(opened.alignmentChangedElsewhere).toBeNull();

		// The user chose to keep theirs, so the file is now what this session wrote — and saying so
		// again would be reporting the same displacement twice.
		await opened.writeAlignment({ ...alignment, controlPoints: [] });
		expect(opened.alignmentChangedElsewhere).toBeNull();
	});
});

describe('typing an Annotation’s words costs one write, not one per keystroke (ADR-0017 rule 2)', () => {
	/**
	 * ⚠ **The one seam that can see the coalescing.** The editing seam counts *intents* — one debounced
	 * call per keystroke — and the browser's counter records nothing at all for a debounced write, so
	 * neither of them can tell one coalesced write from nine. What `Autosave` does with those calls on an
	 * Annotation Layer's own path is visible here, where the store is the assertion.
	 */
	it('collapses nine keystrokes’ worth of debounced writes into one store write', async () => {
		const store = new ImagesGoAway();
		const opened = await openOn(store);
		const layer = newAnnotationLayer({ id: 'one', name: 'Warehouses' });
		const path = `${DIRECTORY}/${layer.geojsonRef}` as StorePath;
		const written: StorePath[] = [];
		store.afterWrite = (path) => written.push(path);
		const titled = (title: string) => ({
			annotations: [
				newAnnotation({ id: 'a1', geometry: { type: 'Point', coordinates: [4.9, 52.37] }, title })
			]
		});

		const word = 'Zuiderzee';
		for (let typed = 1; typed <= word.length; typed += 1) {
			await opened.writeAnnotations(layer, titled(word.slice(0, typed)), { debounce: true });
		}

		// Nothing has reached the store: nine keystrokes on one path share one window.
		expect(written).toEqual([]);

		await opened.flush();

		expect(written).toEqual([path]);
		// And what landed is the last thing typed rather than the first, so coalescing is not dropping.
		expect(new TextDecoder().decode(await store.read(path))).toContain('Zuiderzee');
	});
});

// ── The local-change index, installed around whichever store the Workspace is (ticket 10) ─────

describe('tracking a Workspace’s own changes', () => {
	it('installs the same tracker for browser storage and for a chosen folder', async () => {
		const storage = new FakeMetadataStorage();
		const browser = trackLocalChanges(
			new MemoryProjectStore(),
			opfsWorkspaceKey('Marking 2026'),
			storage
		);
		const folder = trackLocalChanges(new MemoryProjectStore(), folderWorkspaceKey('maps'), storage);

		expect(browser).toBeInstanceOf(ManagedProjectStore);
		expect(folder).toBeInstanceOf(ManagedProjectStore);
		// Adopting a Workspace already managed — a folder reopened, a Workspace switched back to — must
		// not stack a second wrapper marking every change twice.
		expect(trackLocalChanges(browser, opfsWorkspaceKey('Marking 2026'), storage)).toBe(browser);
	});

	it('leaves the store alone where there is nowhere durable to keep marks', () => {
		const store = new MemoryProjectStore();

		expect(trackLocalChanges(store, opfsWorkspaceKey('Marking 2026'), null)).toBe(store);
	});

	it('records what an ordinary authoring action wrote, without any of it knowing', async () => {
		const storage = new FakeMetadataStorage();
		const store = trackLocalChanges(
			new MemoryProjectStore(),
			opfsWorkspaceKey('Marking 2026'),
			storage
		);
		const session = new EditorSession(store, {
			metadataStorage: storage,
			workspaceKey: opfsWorkspaceKey('Marking 2026')
		});
		const project = await session.createProject('Marking');
		if (project === null) throw new Error('expected a Project');

		const changes = session.localChanges;
		if (changes === null) throw new Error('expected a managed store');

		expect((await changes.localChanges()).written).toEqual([projectFilePath(project.directory)]);
	});

	it('has no index where the session was given a store nothing manages', () => {
		expect(new EditorSession(new MemoryProjectStore()).localChanges).toBeNull();
	});
});

describe('the Project screen’s Edit History (ADR-0039)', () => {
	/** A session on one Project holding `count` Annotation Layers, each with a distinct document. */
	async function withAnnotationLayers(count: number): Promise<{
		store: MemoryProjectStore;
		session: EditorSession;
		layerIds: string[];
	}> {
		const store = new MemoryProjectStore();
		await store.write(
			projectFilePath(DIRECTORY),
			serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')))
		);
		const session = new EditorSession(store);
		await session.open(DIRECTORY);
		const layerIds: string[] = [];
		for (let at = 0; at < count; at += 1) {
			const layer = await session.addAnnotationLayer(`Layer ${at + 1}`);
			if (layer === null) throw new Error('expected an Annotation Layer');
			layerIds.push(layer.id);
		}
		await session.flush();
		return { store, session, layerIds };
	}

	const layerIdsOf = (session: EditorSession): string[] =>
		(session.openProject?.layers ?? []).map((layer) => layer.id);

	it('names the deleted Layer in the sentence the bar will say', async () => {
		const { session, layerIds } = await withAnnotationLayers(1);

		expect(await session.deleteLayer(layerIds[0] as string)).toBe(true);
		expect(session.historyFor(DIRECTORY).undoable?.label).toBe(
			'Undo delete of the Layer “Layer 1”'
		);
	});

	// The fallback `describeUndo` has always used, kept so a Layer nobody named is still identifiable.
	it('falls back to “with no name” for a Layer the scholar never named', async () => {
		const { session, layerIds } = await withAnnotationLayers(1);
		await session.typeLayerName(layerIds[0] as string, '');
		await session.flush();

		await session.deleteLayer(layerIds[0] as string);
		expect(session.historyFor(DIRECTORY).undoable?.label).toBe(
			'Undo delete of the Layer with no name'
		);
	});

	// SPEC stories 19 and 54. The bytes rather than a re-serialisation of a parsed model: an
	// Annotation Layer's document is the scholar's own writing, and undo must not rewrite it.
	it('puts the stack entry and the Layer’s file back byte-identically', async () => {
		const { store, session, layerIds } = await withAnnotationLayers(2);
		const doomed = layerIds[0] as string;
		const path = `${DIRECTORY}/${annotationPath(doomed)}`;
		const fileBefore = await store.read(path);
		const stackBefore = session.openProject?.layers;

		await session.deleteLayer(doomed);
		await session.flush();
		// The deletion really reached storage before anything is undone, so the undo below cannot be
		// satisfied by a revert to the last saved state.
		expect(await store.list(path)).toEqual([]);
		expect(layerIdsOf(session)).toEqual([layerIds[1]]);

		expect(await session.historyFor(DIRECTORY).undo()).toBe(true);
		await session.flush();

		expect(await store.read(path)).toEqual(fileBefore);
		expect(session.openProject?.layers).toEqual(stackBefore);
	});

	// SPEC story 7: an undo pressed by mistake is not itself irreversible.
	it('deletes it again on redo', async () => {
		const { store, session, layerIds } = await withAnnotationLayers(1);
		const doomed = layerIds[0] as string;
		const path = `${DIRECTORY}/${annotationPath(doomed)}`;

		await session.deleteLayer(doomed);
		await session.historyFor(DIRECTORY).undo();
		await session.flush();
		expect(layerIdsOf(session)).toEqual([doomed]);

		expect(await session.historyFor(DIRECTORY).redo()).toBe(true);
		await session.flush();

		expect(layerIdsOf(session)).toEqual([]);
		expect(await store.list(path)).toEqual([]);
	});

	// SPEC stories 6, 10 and 11, driven through the gesture rather than against the class directly.
	it('walks back five deletions in order, and a sixth forgets the first', async () => {
		const { session, layerIds } = await withAnnotationLayers(6);
		const history = session.historyFor(DIRECTORY);

		let afterTheFirstDeletion: string[] = [];
		for (const [at, id] of layerIds.entries()) {
			await session.deleteLayer(id);
			if (at === 0) afterTheFirstDeletion = layerIdsOf(session);
		}
		await session.flush();
		expect(layerIdsOf(session)).toEqual([]);

		for (let step = 0; step < 5; step += 1) expect(await history.undo()).toBe(true);
		await session.flush();

		// Back to the stack the first deletion left, and no further: that Step is off the end of a
		// five-deep history, so its Layer stays gone rather than the sixth deletion being refused.
		expect(layerIdsOf(session)).toEqual(afterTheFirstDeletion);
		expect(history.undoable).toBeNull();
	});

	// The placement today's `open()` already has: after the "already showing it" return, so moving
	// between one Project's screens keeps the history and opening it afresh does not.
	it('keeps the history while the same Project stays open', async () => {
		const { session, layerIds } = await withAnnotationLayers(1);
		await session.deleteLayer(layerIds[0] as string);

		await session.open(DIRECTORY);

		expect(session.historyFor(DIRECTORY).undoable).not.toBeNull();
	});

	it('drops the history when the Project is opened afresh', async () => {
		const { session, layerIds } = await withAnnotationLayers(1);
		await session.deleteLayer(layerIds[0] as string);

		await session.open(null);
		await session.open(DIRECTORY);

		expect(session.historyFor(DIRECTORY).undoable).toBeNull();
	});

	// One history per subject, so the screen that declares it gets the same one every time.
	it('gives one subject the same history every time it is asked', async () => {
		const { session } = await withAnnotationLayers(0);

		expect(session.historyFor(DIRECTORY)).toBe(session.historyFor(DIRECTORY));
		expect(session.historyFor('another-project')).not.toBe(session.historyFor(DIRECTORY));
	});
});

describe('the rest of the Layer stack, as Steps of the Project’s Edit History (ADR-0039)', () => {
	const MAP = 'floride-1657';

	/** A session on one Project, with a Map Image the Workspace can size but no Layer drawing it. */
	async function overAMapImage(): Promise<{ store: MemoryProjectStore; session: EditorSession }> {
		const store = new MemoryProjectStore();
		await store.write(
			projectFilePath(DIRECTORY),
			serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')))
		);
		await store.write(
			imageInfoPath(MAP),
			new TextEncoder().encode(JSON.stringify({ width: 1000, height: 800 })) as Bytes
		);
		const session = new EditorSession(store);
		await session.open(DIRECTORY);
		return { store, session };
	}

	const layerIdsOf = (session: EditorSession): string[] =>
		(session.openProject?.layers ?? []).map((layer) => layer.id);

	const opacityOf = (session: EditorSession, id: string): number => {
		const layer = (session.openProject?.layers ?? []).find((one) => one.id === id);
		if (layer?.kind !== 'map') throw new Error('expected a map Layer');
		return layer.opacity;
	};

	// SPEC stories 13 and 14, and the disjointness invariant that makes the second one true: the Step
	// declares `project.json` and nothing else, so undoing the addition cannot reach the Alignment the
	// gesture also wrote — which belongs to the Workspace and may be drawn by another Project
	// (ADR-0023).
	it('undoes adding a Map Image, leaving its Alignment and its record exactly where they are', async () => {
		const { store, session } = await overAMapImage();

		const layer = await session.addWorkspaceMap(MAP);
		if (layer === null) throw new Error('expected a map Layer');
		await session.flush();
		const alignment = await store.read(alignmentPath(MAP));
		const info = await store.read(imageInfoPath(MAP));
		expect(session.historyFor(DIRECTORY).undoable?.label).toBe(
			`Undo adding the Map Image “${layer.name}”`
		);

		expect(await session.historyFor(DIRECTORY).undo()).toBe(true);
		await session.flush();

		expect(layerIdsOf(session)).toEqual([]);
		expect(await store.read(alignmentPath(MAP))).toEqual(alignment);
		expect(await store.read(imageInfoPath(MAP))).toEqual(info);

		expect(await session.historyFor(DIRECTORY).redo()).toBe(true);
		await session.flush();
		expect(layerIdsOf(session)).toEqual([layer.id]);
	});

	// SPEC story 15. Both files this gesture wrote go back, which is what keeps the stack and
	// `annotations/` agreeing: a Layer whose reference names nothing is a Project the importer refuses.
	it('undoes adding an Annotation Layer, taking its FeatureCollection with it', async () => {
		const { store, session } = await overAMapImage();

		const layer = await session.addAnnotationLayer('Trade routes');
		if (layer === null) throw new Error('expected an Annotation Layer');
		await session.flush();
		const path = `${DIRECTORY}/${annotationPath(layer.id)}`;
		expect(await store.list(path)).toEqual([path]);
		expect(session.historyFor(DIRECTORY).undoable?.label).toBe(
			'Undo adding the Layer “Trade routes”'
		);

		expect(await session.historyFor(DIRECTORY).undo()).toBe(true);
		await session.flush();

		expect(layerIdsOf(session)).toEqual([]);
		expect(await store.list(path)).toEqual([]);

		expect(await session.historyFor(DIRECTORY).redo()).toBe(true);
		await session.flush();
		expect(layerIdsOf(session)).toEqual([layer.id]);
		expect(await store.list(path)).toEqual([path]);
	});

	// SPEC story 16. The label says which way the toggle went, in the scholar's own words for the
	// Layer and never in a value.
	it('undoes hiding a Layer, and says which way it went', async () => {
		const { session } = await overAMapImage();
		const layer = await session.addAnnotationLayer('Trade routes');
		if (layer === null) throw new Error('expected an Annotation Layer');

		await session.showLayer(layer.id, false);
		await session.flush();
		expect(session.openProject?.layers[0]?.visible).toBe(false);
		expect(session.historyFor(DIRECTORY).undoable?.label).toBe(
			'Undo hiding the Layer “Trade routes”'
		);

		expect(await session.historyFor(DIRECTORY).undo()).toBe(true);
		await session.flush();
		expect(session.openProject?.layers[0]?.visible).toBe(true);

		expect(await session.historyFor(DIRECTORY).redo()).toBe(true);
		await session.flush();
		expect(session.openProject?.layers[0]?.visible).toBe(false);
		expect(await session.historyFor(DIRECTORY).undo()).toBe(true);
		await session.flush();

		// And the other direction, which is a different sentence rather than the same one twice.
		await session.showLayer(layer.id, false);
		await session.showLayer(layer.id, true);
		await session.flush();
		expect(session.openProject?.layers[0]?.visible).toBe(true);
		expect(session.historyFor(DIRECTORY).undoable?.label).toBe(
			'Undo showing the Layer “Trade routes”'
		);
	});

	// SPEC story 17. The Step opens when the drag starts and closes when it ends, so undo returns the
	// Layer to the opacity it had before the gesture rather than to some value inside it.
	it('makes a whole opacity drag one Step, back to where it started', async () => {
		const { session } = await overAMapImage();
		const layer = await session.addWorkspaceMap(MAP);
		if (layer === null) throw new Error('expected a map Layer');
		await session.flush();

		for (const opacity of [0.9, 0.7, 0.5, 0.4]) await session.dragLayerOpacity(layer.id, opacity);
		await session.commitLayerEdit();
		await session.flush();
		const history = session.historyFor(DIRECTORY);
		expect(opacityOf(session, layer.id)).toBeCloseTo(0.4, 5);
		expect(history.undoable?.label).toBe(`Undo the opacity of the Layer “${layer.name}”`);

		expect(await history.undo()).toBe(true);
		await session.flush();
		expect(opacityOf(session, layer.id)).toBeCloseTo(1, 5);

		// And forward again, to where the drag left it rather than to a value inside it.
		expect(await history.redo()).toBe(true);
		await session.flush();
		expect(opacityOf(session, layer.id)).toBeCloseTo(0.4, 5);
		expect(await history.undo()).toBe(true);
		await session.flush();

		// One Step and not four: the one behind it is the addition, not a value inside the drag.
		expect(history.undoable?.label).toBe(`Undo adding the Map Image “${layer.name}”`);
	});

	// SPEC story 18.
	it('undoes moving a Layer in the stack', async () => {
		const { session } = await overAMapImage();
		const first = await session.addAnnotationLayer('Trade routes');
		const second = await session.addAnnotationLayer('Hinterland');
		if (!first || !second) throw new Error('expected two Annotation Layers');
		const order = layerIdsOf(session);

		// The newest Layer goes on top, so `Hinterland` is the one at 0 and moving it down is a move.
		await session.moveLayerTo(second.id, 1);
		await session.flush();
		expect(layerIdsOf(session)).toEqual([first.id, second.id]);
		expect(session.historyFor(DIRECTORY).undoable?.label).toBe(
			'Undo moving the Layer “Hinterland”'
		);

		expect(await session.historyFor(DIRECTORY).undo()).toBe(true);
		await session.flush();
		expect(layerIdsOf(session)).toEqual(order);

		expect(await session.historyFor(DIRECTORY).redo()).toBe(true);
		await session.flush();
		expect(layerIdsOf(session)).toEqual([first.id, second.id]);
	});

	// SPEC stories 31 and 32: tidying up names must not push the deletion out of the history, and must
	// not throw the history away either.
	it('spends no Step on a rename, and keeps the history across one', async () => {
		const { session } = await overAMapImage();
		const layer = await session.addAnnotationLayer('Trade routes');
		if (layer === null) throw new Error('expected an Annotation Layer');
		await session.deleteLayer(layer.id);
		await session.flush();
		const history = session.historyFor(DIRECTORY);
		const label = history.undoable?.label;

		const other = await session.addAnnotationLayer('Hinterland');
		if (other === null) throw new Error('expected an Annotation Layer');
		await session.typeLayerName(other.id, 'Hinterland roads');
		await session.commitLayerEdit();
		await session.flush();

		// The addition is a Step; the rename that followed it is not, so the deletion is still one
		// press further back rather than two.
		expect(history.undoable?.label).toBe('Undo adding the Layer “Hinterland”');
		expect(await history.undo()).toBe(true);
		expect(history.undoable?.label).toBe(label);
	});

	// SPEC story 33. The name typed after the Step is carried across into what undo writes: it is the
	// scholar's, it is not part of the deletion, and taking it back would be undoing words nobody
	// asked to have undone.
	it('carries a name typed after a Step across the undo of that Step', async () => {
		const { session } = await overAMapImage();
		const doomed = await session.addAnnotationLayer('Trade routes');
		const kept = await session.addAnnotationLayer('Hinterland');
		if (!doomed || !kept) throw new Error('expected two Annotation Layers');
		await session.flush();

		expect(await session.deleteLayer(doomed.id)).toBe(true);
		await session.typeLayerName(kept.id, 'Hinterland roads');
		await session.commitLayerEdit();
		await session.flush();

		expect(await session.historyFor(DIRECTORY).undo()).toBe(true);
		await session.flush();

		const names = (session.openProject?.layers ?? []).map((layer) => layer.name);
		expect(names).toEqual(['Hinterland roads', 'Trade routes']);
	});
});

/**
 * The Alignment's own Edit History, driven the way the Align screen drives it (ticket 5, ADR-0039).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE GESTURES ARE SPELLED OUT HERE RATHER THAN CALLED
 *
 * The six gestures live in `AlignmentWorkspace.svelte`, between two live map panes, so there is no
 * function on this class to call. What is asserted at this seam is the half that is *not* the
 * component: a Step wrapped around `writeAlignment`, and what `writeBack` then does with an
 * `alignments/<image-id>.json` — which is the half a browser cannot see and the half the fence,
 * the baseline and byte identity all live on. Each test therefore opens its Step exactly as the
 * component's `asStep` does: mutate, then wrap the write.
 *
 * The screen scoping and the pairing rebuild are Seam 2's, in `editor-undo.e2e.ts`.
 */
describe('the Alignment’s Edit History (ADR-0039)', () => {
	const MAP = 'floride-1657';
	const OTHER_MAP = 'nieuw-amsterdam-1660';
	const IMAGE = { width: 1000, height: 800 };

	/** A Project with a Map Image on it, its starter Alignment written by the add. */
	async function overAnAlignment(): Promise<{
		store: MemoryProjectStore;
		session: EditorSession;
		alignment: Alignment;
	}> {
		const store = new MemoryProjectStore();
		await store.write(
			projectFilePath(DIRECTORY),
			serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')))
		);
		for (const map of [MAP, OTHER_MAP]) {
			await store.write(
				imageInfoPath(map),
				new TextEncoder().encode(JSON.stringify(IMAGE)) as Bytes
			);
		}
		const session = new EditorSession(store);
		await session.open(DIRECTORY);
		await session.addWorkspaceMap(MAP);
		await session.flush();
		return { store, session, alignment: await session.readAlignment(MAP, IMAGE) };
	}

	/**
	 * One gesture, as the Align screen opens it: the pairing is mutated and the *write* is the Step.
	 *
	 * @param next the Alignment as the gesture has left it
	 */
	const gesture = (session: EditorSession, label: string, next: Alignment): Promise<void> =>
		session
			.historyFor(next.imageId)
			.step(label, [alignmentPath(next.imageId)], () => session.writeAlignment(next));

	const withPair = (alignment: Alignment, at: number): Alignment => ({
		...alignment,
		controlPoints: [
			...alignment.controlPoints,
			{
				id: `p${at}`,
				ordinal: alignment.controlPoints.length + 1,
				resource: { x: 10 * at, y: 20 * at },
				geo: { lng: 4.9 + at / 100, lat: 52.3 + at / 100 }
			}
		]
	});

	const nudgedCorner = (alignment: Alignment, at: number): Alignment => ({
		...alignment,
		resourceMask: alignment.resourceMask.map((vertex, index) =>
			index === at ? { x: vertex.x + 1, y: vertex.y + 1 } : vertex
		)
	});

	// SPEC stories 24–29, and acceptance criterion 1: the file is byte-identical to what it was
	// before the gesture, which is stronger than "equivalent" — `Alignment.unmodelled` means a
	// re-serialisation of the same document can differ, and a scholar's colleague wrote some of it.
	it.each([
		['Undo placing Control Point 2', (ground: Alignment) => withPair(ground, 2)],
		[
			'Undo move of Control Point 1',
			(ground: Alignment) => ({
				...ground,
				controlPoints: ground.controlPoints.map((point) => ({
					...point,
					resource: { x: 99, y: 99 }
				}))
			})
		],
		['Undo delete of Control Point 1', (ground: Alignment) => ({ ...ground, controlPoints: [] })],
		['Undo the Crop of “La Floride”', (ground: Alignment) => nudgedCorner(ground, 0)],
		[
			'Undo the Crop reset of “La Floride”',
			(ground: Alignment) => ({ ...ground, resourceMask: fullImageResourceMask(IMAGE) })
		],
		[
			'Undo the transformation of “La Floride”',
			(ground: Alignment) => ({ ...ground, transformationType: 'thinPlateSpline' as const })
		]
	])('undoes and redoes %s, byte for byte', async (label, edit) => {
		const { store, session, alignment } = await overAnAlignment();
		// The ground each gesture is performed on: a placed pair and a cropped sheet, so that the
		// deletion and the reset have something to take away.
		await gesture(session, 'Undo placing Control Point 1', withPair(alignment, 1));
		await gesture(
			session,
			'Undo the Crop of “La Floride”',
			nudgedCorner(withPair(alignment, 1), 2)
		);
		const ground = await session.readAlignment(MAP, IMAGE);
		const before = await store.read(alignmentPath(MAP));

		await gesture(session, label, edit(ground));
		await session.flush();
		expect(await store.read(alignmentPath(MAP))).not.toEqual(before);

		const history = session.historyFor(MAP);
		expect(history.undoable?.label).toBe(label);
		expect(await history.undo()).toBe(true);
		await session.flush();
		expect(await store.read(alignmentPath(MAP))).toEqual(before);

		// SPEC story 7: an undo pressed by mistake is not itself irreversible.
		const after = await store.read(alignmentPath(MAP));
		expect(await history.redo()).toBe(true);
		await session.flush();
		expect(await store.read(alignmentPath(MAP))).not.toEqual(after);
	});

	/**
	 * Acceptance criterion 4, and the reason `writeBack` moves the baseline.
	 *
	 * A write that changed the bytes and left the baseline alone makes the *next* ordinary save
	 * report a concurrent change that never happened — a frightening sentence about a colleague who
	 * does not exist, which teaches a scholar to dismiss the real one.
	 */
	it('leaves the next ordinary save with nothing to report', async () => {
		const { session, alignment } = await overAnAlignment();
		await gesture(session, 'Undo placing Control Point 1', withPair(alignment, 1));
		await session.flush();

		expect(await session.historyFor(MAP).undo()).toBe(true);
		await session.flush();
		// The pairing is rebuilt from disk after a write-back, which is what the screen does — and it
		// is `readAlignment` that resets the baseline for a *read*. The next save must be clean even
		// without one, because the undo is what wrote the file.
		await session.writeAlignment(withPair(alignment, 2));
		await session.flush();

		expect(session.alignmentChangedElsewhere).toBeNull();
	});

	// SPEC story 27 and acceptance criterion 5. There is no merging anywhere in this epic: four
	// corners are four Steps, so a scholar can back out of the one they got wrong.
	it('makes four Crop corner moves four Steps', async () => {
		const { session, alignment } = await overAnAlignment();
		const history = session.historyFor(MAP);

		let cropped = alignment;
		for (let corner = 0; corner < 4; corner += 1) {
			cropped = nudgedCorner(cropped, corner);
			await gesture(session, 'Undo the Crop of “La Floride”', cropped);
		}
		await session.flush();
		const fourCorners = cropped.resourceMask;

		for (let back = 0; back < 4; back += 1) {
			expect(history.undoable?.label).toBe('Undo the Crop of “La Floride”');
			expect(await history.undo()).toBe(true);
		}
		await session.flush();

		expect(history.undoable).toBeNull();
		expect((await session.readAlignment(MAP, IMAGE)).resourceMask).toEqual(alignment.resourceMask);
		expect(fourCorners).not.toEqual(alignment.resourceMask);
	});

	// SPEC stories 4 and 5. Keyed by Map Image, so a second map offers its own edits and never the
	// first's — and one Alignment is one history however many Projects draw it (ADR-0023).
	it('gives each Map Image its own history, and keeps the first’s intact', async () => {
		const { session, alignment } = await overAnAlignment();
		await session.addWorkspaceMap(OTHER_MAP);
		await session.flush();
		const other = await session.readAlignment(OTHER_MAP, IMAGE);

		await gesture(session, 'Undo placing Control Point 1', withPair(alignment, 1));
		await gesture(session, 'Undo the transformation of “Nieuw Amsterdam”', {
			...other,
			transformationType: 'polynomial2'
		});
		await session.flush();

		expect(session.historyFor(OTHER_MAP).undoable?.label).toBe(
			'Undo the transformation of “Nieuw Amsterdam”'
		);
		expect(session.historyFor(MAP).undoable?.label).toBe('Undo placing Control Point 1');
		// The Alignment is the Workspace's, so the Project it was reached from is not part of its key.
		await session.open(null);
		await session.open(DIRECTORY);
		expect(session.historyFor(MAP).undoable?.label).toBe('Undo placing Control Point 1');
	});

	// The cue the Align screen rebuilds its pairing on: Control Point ids are minted per session and
	// are not in the file, so an Alignment written back cannot be patched into the one on screen.
	it('says an Alignment has been written back, so the screen can re-read it', async () => {
		const { session, alignment } = await overAnAlignment();
		await gesture(session, 'Undo placing Control Point 1', withPair(alignment, 1));
		await session.flush();
		const quiet = session.alignmentsWrittenBack;

		expect(await session.historyFor(MAP).undo()).toBe(true);
		await session.flush();

		expect(session.alignmentsWrittenBack).toBe(quiet + 1);
	});
});
