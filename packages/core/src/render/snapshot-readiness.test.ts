// Every rule the Map Snapshot control's availability is made of.
//
// This is the whole of the readiness machine's coverage, by design: the Epic adds no Playwright
// test, so the claim "the control is never ready for a frame that has gone" is proved here or
// nowhere. A reducer is what makes that affordable — the invalidators, the late answers and the
// capture are all just events, and there is no map, no canvas and no clock anywhere below.

import { describe, expect, test } from 'vitest';

import {
	FRAME_INVALIDATORS,
	canCaptureSnapshot,
	initialSnapshotReadiness,
	snapshotAvailability,
	snapshotReadinessAfter,
	type SnapshotReadiness,
	type SnapshotReadinessEvent
} from './snapshot-readiness.js';

const after = (
	readiness: SnapshotReadiness,
	...events: readonly SnapshotReadinessEvent[]
): SnapshotReadiness => events.reduce(snapshotReadinessAfter, readiness);

/** A frame that has finished drawing: what every rule below is measured against. */
const readyFrame = (): SnapshotReadiness =>
	after(initialSnapshotReadiness, {
		kind: 'frame-settled',
		generation: initialSnapshotReadiness.generation
	});

const stateOf = (readiness: SnapshotReadiness) => snapshotAvailability(readiness).state;

test('nothing is ready before a frame has settled', () => {
	expect(stateOf(initialSnapshotReadiness)).toBe('preparing');
	expect(canCaptureSnapshot(initialSnapshotReadiness)).toBe(false);
});

test('a settled frame is ready, and says which frame it is', () => {
	const ready = readyFrame();

	expect(snapshotAvailability(ready)).toEqual({ state: 'ready', generation: 0 });
	expect(canCaptureSnapshot(ready)).toBe(true);
});

describe('every invalidator replaces the frame', () => {
	// `test.each` over the exported list rather than a written-out set, so an invalidator added to
	// the union without a rule here is impossible: the list *is* the union's definition.
	test.each(FRAME_INVALIDATORS)('%s returns the control to preparing at once', (by) => {
		const moved = after(readyFrame(), { kind: 'frame-invalidated', by });

		expect(stateOf(moved)).toBe('preparing');
		expect(canCaptureSnapshot(moved)).toBe(false);
		// A new generation rather than only an unsettled flag: what makes the previous frame's
		// answers identifiable when they arrive.
		expect(moved.generation).toBe(1);
	});

	test('each one takes the map further from the frame before it', () => {
		const invalidated = FRAME_INVALIDATORS.reduce(
			(readiness, by) => snapshotReadinessAfter(readiness, { kind: 'frame-invalidated', by }),
			readyFrame()
		);

		expect(invalidated.generation).toBe(FRAME_INVALIDATORS.length);
		expect(stateOf(invalidated)).toBe('preparing');
	});

	test('a frame invalidated while already preparing still moves on', () => {
		// Two pans in a row: the first frame's wait is as obsolete as the settled frame's was, and
		// the generation is what tells its late answer apart from the second's.
		const moved = after(
			initialSnapshotReadiness,
			{ kind: 'frame-invalidated', by: 'camera' },
			{ kind: 'frame-invalidated', by: 'camera' }
		);

		expect(moved.generation).toBe(2);
		expect(stateOf(moved)).toBe('preparing');
	});
});

describe('an answer from a frame that has gone', () => {
	test('is discarded, and does not enable the control', () => {
		const moved = after(readyFrame(), { kind: 'frame-invalidated', by: 'camera' });

		const late = snapshotReadinessAfter(moved, { kind: 'frame-settled', generation: 0 });

		expect(stateOf(late)).toBe('preparing');
		// Identity, so a consumer holding this in `$state.raw` does no work for it either.
		expect(late).toBe(moved);
	});

	test('is discarded however many frames ago it was', () => {
		const moved = after(
			readyFrame(),
			{ kind: 'frame-invalidated', by: 'camera' },
			{ kind: 'frame-invalidated', by: 'base-map' },
			{ kind: 'frame-invalidated', by: 'layer-stack' }
		);

		expect(stateOf(after(moved, { kind: 'frame-settled', generation: 1 }))).toBe('preparing');
		expect(stateOf(after(moved, { kind: 'frame-settled', generation: 2 }))).toBe('preparing');
	});

	test('does not stop the replacement frame becoming ready', () => {
		const moved = after(readyFrame(), { kind: 'frame-invalidated', by: 'camera' });

		const settled = after(
			moved,
			{ kind: 'frame-settled', generation: 0 },
			{ kind: 'frame-settled', generation: moved.generation }
		);

		expect(snapshotAvailability(settled)).toEqual({ state: 'ready', generation: 1 });
	});

	test('cannot arrive from a frame that has not happened yet either', () => {
		// The pane is handed the generation it is waiting on, so this is a wiring error rather than a
		// race; refusing it is what keeps the rule "only the current frame" rather than "not older".
		const settled = after(initialSnapshotReadiness, { kind: 'frame-settled', generation: 7 });

		expect(stateOf(settled)).toBe('preparing');
	});
});

describe('an asset that did not arrive', () => {
	test('leaves the control unavailable even though the map has fallen quiet', () => {
		const failed = after(readyFrame(), { kind: 'base-map-assets', failed: true });

		expect(stateOf(failed)).toBe('unavailable');
		expect(canCaptureSnapshot(failed)).toBe(false);
	});

	test('is a Map Image as much as a Base Map', () => {
		const failed = after(readyFrame(), { kind: 'map-image-assets', failed: true });

		expect(stateOf(failed)).toBe('unavailable');
	});

	test('survives the frames drawn after it', () => {
		// A refusal stands until the shim says every refused URL has come back, so panning away from
		// the hole does not mean the map is whole.
		const failed = after(
			readyFrame(),
			{ kind: 'map-image-assets', failed: true },
			{ kind: 'frame-invalidated', by: 'camera' },
			{ kind: 'frame-settled', generation: 1 }
		);

		expect(stateOf(failed)).toBe('unavailable');
	});

	test('re-enables the control only once it has come back and the frame is complete', () => {
		const failed = after(readyFrame(), { kind: 'base-map-assets', failed: true });

		const recovered = after(failed, { kind: 'base-map-assets', failed: false });
		expect(stateOf(recovered)).toBe('ready');

		// And recovery alone is not enough while the replacement frame is still being drawn.
		const midFrame = after(
			failed,
			{ kind: 'frame-invalidated', by: 'camera' },
			{ kind: 'base-map-assets', failed: false }
		);
		expect(stateOf(midFrame)).toBe('preparing');
	});

	test('keeps the control unavailable until both kinds have recovered', () => {
		const both = after(
			readyFrame(),
			{ kind: 'base-map-assets', failed: true },
			{ kind: 'map-image-assets', failed: true }
		);

		expect(stateOf(after(both, { kind: 'base-map-assets', failed: false }))).toBe('unavailable');
		expect(stateOf(after(both, { kind: 'map-image-assets', failed: false }))).toBe('unavailable');
		expect(
			stateOf(
				after(
					both,
					{ kind: 'base-map-assets', failed: false },
					{ kind: 'map-image-assets', failed: false }
				)
			)
		).toBe('ready');
	});

	test('reported twice is the same fact reported twice', () => {
		const failed = after(readyFrame(), { kind: 'base-map-assets', failed: true });

		expect(snapshotReadinessAfter(failed, { kind: 'base-map-assets', failed: true })).toBe(failed);
	});
});

describe('capturing', () => {
	test('stops a second press without changing what the frame is', () => {
		const capturing = after(readyFrame(), { kind: 'capture-started' });

		expect(canCaptureSnapshot(capturing)).toBe(false);
		// The frame is still the complete one; only the control is busy.
		expect(stateOf(capturing)).toBe('ready');
		expect(snapshotReadinessAfter(capturing, { kind: 'capture-started' })).toBe(capturing);
	});

	test('cannot start on a frame that is not ready', () => {
		const preparing = initialSnapshotReadiness;
		expect(snapshotReadinessAfter(preparing, { kind: 'capture-started' })).toBe(preparing);

		const unavailable = after(readyFrame(), { kind: 'base-map-assets', failed: true });
		expect(snapshotReadinessAfter(unavailable, { kind: 'capture-started' })).toBe(unavailable);
	});

	test('hands the control back to the frame it captured', () => {
		const done = after(readyFrame(), { kind: 'capture-started' }, { kind: 'capture-finished' });

		expect(canCaptureSnapshot(done)).toBe(true);
		expect(done.captureFailed).toBe(false);
	});

	test('hands it back to the frame that replaced it, when the map moved meanwhile', () => {
		const done = after(
			readyFrame(),
			{ kind: 'capture-started' },
			{ kind: 'frame-invalidated', by: 'camera' },
			{ kind: 'capture-finished' }
		);

		expect(stateOf(done)).toBe('preparing');
		expect(done.capturing).toBe(false);
	});
});

describe('a capture that failed', () => {
	test('is announced without touching the frame', () => {
		const failed = after(readyFrame(), { kind: 'capture-started' }, { kind: 'capture-failed' });

		expect(failed.captureFailed).toBe(true);
		// Rule 4: a browser that would not encode a PNG says nothing about the map's own assets.
		expect(stateOf(failed)).toBe('ready');
		expect(failed.generation).toBe(0);
	});

	test('leaves the control ready to be pressed again', () => {
		const failed = after(readyFrame(), { kind: 'capture-started' }, { kind: 'capture-failed' });

		expect(canCaptureSnapshot(failed)).toBe(true);
	});

	test('clears its announcement as the retry begins, so a second failure is heard', () => {
		const retrying = after(
			readyFrame(),
			{ kind: 'capture-started' },
			{ kind: 'capture-failed' },
			{ kind: 'capture-started' }
		);

		expect(retrying.captureFailed).toBe(false);

		const failedAgain = after(retrying, { kind: 'capture-failed' });
		expect(failedAgain.captureFailed).toBe(true);
	});

	test('is cleared by a retry that works', () => {
		const succeeded = after(
			readyFrame(),
			{ kind: 'capture-started' },
			{ kind: 'capture-failed' },
			{ kind: 'capture-started' },
			{ kind: 'capture-finished' }
		);

		expect(succeeded.captureFailed).toBe(false);
	});

	test('does not stop the map moving on', () => {
		const moved = after(
			readyFrame(),
			{ kind: 'capture-started' },
			{ kind: 'capture-failed' },
			{ kind: 'frame-invalidated', by: 'camera' }
		);

		expect(stateOf(moved)).toBe('preparing');
		expect(moved.captureFailed).toBe(true);
	});
});
