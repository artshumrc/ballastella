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
