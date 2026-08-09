// `EditorSession` against an in-memory store (ticket 06).
//
// The session takes a `ProjectStore`, so an in-memory one is the whole of what a test needs — which
// is what makes this the second thing worth having a Node seam for. What is asserted here is the
// pair of failure paths behind the "Add a Historical Map" dialog: a Workspace whose `images/`
// cannot be walked, and a map whose record does not say how big it is. Both are refusals, both are
// a sentence a user reads, and neither has a gesture in the interface that produces it on demand.

import {
	MemoryProjectStore,
	newProjectFile,
	projectFilePath,
	serialiseProjectFile,
	type Bytes,
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
	 * Historical Map. Clearing it unconditionally at the end throws away an alert nobody has seen, and
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
