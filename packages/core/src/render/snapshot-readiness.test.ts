import { describe, expect, test } from 'vitest';

import {
	FRAME_INVALIDATORS,
	canCaptureSnapshot,
	initialSnapshotReadiness,
	snapshotAvailability,
	snapshotReadinessAfter,
	type FrameInvalidator,
	type SnapshotReadiness,
	type SnapshotReadinessEvent
} from './snapshot-readiness.js';

const invalidated = (by: FrameInvalidator = 'camera'): SnapshotReadinessEvent => ({
	kind: 'frame-invalidated',
	by
});
const settled = (generation: number): SnapshotReadinessEvent => ({
	kind: 'frame-settled',
	generation
});
const baseMap = (failed: boolean): SnapshotReadinessEvent => ({ kind: 'base-map-assets', failed });
const mapImage = (failed: boolean): SnapshotReadinessEvent => ({
	kind: 'map-image-assets',
	failed
});
const START: SnapshotReadinessEvent = { kind: 'capture-started' };
const FINISH: SnapshotReadinessEvent = { kind: 'capture-finished' };
const FAIL: SnapshotReadinessEvent = { kind: 'capture-failed' };

const after = (
	readiness: SnapshotReadiness,
	...events: readonly SnapshotReadinessEvent[]
): SnapshotReadiness => events.reduce(snapshotReadinessAfter, readiness);

const readyFrame = (): SnapshotReadiness =>
	after(initialSnapshotReadiness, settled(initialSnapshotReadiness.generation));

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
	test.each(FRAME_INVALIDATORS)('%s returns the control to preparing at once', (by) => {
		const moved = after(readyFrame(), invalidated(by));
		expect(stateOf(moved)).toBe('preparing');
		expect(canCaptureSnapshot(moved)).toBe(false);
		expect(moved.generation).toBe(1);
	});

	test('each one takes the map further from the frame before it', () => {
		const moved = after(readyFrame(), ...FRAME_INVALIDATORS.map((by) => invalidated(by)));
		expect(moved.generation).toBe(FRAME_INVALIDATORS.length);
		expect(stateOf(moved)).toBe('preparing');
	});

	test('a frame invalidated while already preparing still moves on', () => {
		const moved = after(initialSnapshotReadiness, invalidated(), invalidated());
		expect(moved.generation).toBe(2);
		expect(stateOf(moved)).toBe('preparing');
	});
});

describe('an answer from a frame that has gone', () => {
	test('is discarded, and does not enable the control', () => {
		const moved = after(readyFrame(), invalidated());
		const late = snapshotReadinessAfter(moved, settled(0));
		expect(stateOf(late)).toBe('preparing');
		expect(late).toBe(moved);
	});

	test('is discarded however many frames ago it was', () => {
		const moved = after(
			readyFrame(),
			invalidated(),
			invalidated('base-map'),
			invalidated('layer-stack')
		);

		expect(stateOf(after(moved, settled(1)))).toBe('preparing');
		expect(stateOf(after(moved, settled(2)))).toBe('preparing');
	});

	test('does not stop the replacement frame becoming ready', () => {
		const moved = after(readyFrame(), invalidated());
		const ready = after(moved, settled(0), settled(moved.generation));
		expect(snapshotAvailability(ready)).toEqual({ state: 'ready', generation: 1 });
	});

	test('cannot arrive from a frame that has not happened yet either', () => {
		expect(stateOf(after(initialSnapshotReadiness, settled(7)))).toBe('preparing');
	});
});

describe('an asset that did not arrive', () => {
	test('leaves the control unavailable even though the map has fallen quiet', () => {
		const failed = after(readyFrame(), baseMap(true));
		expect(stateOf(failed)).toBe('unavailable');
		expect(canCaptureSnapshot(failed)).toBe(false);
	});

	test('survives the frames drawn after it', () => {
		const failed = after(readyFrame(), mapImage(true), invalidated(), settled(1));
		expect(stateOf(failed)).toBe('unavailable');
	});

	test('re-enables the control only once it has come back and the frame is complete', () => {
		const failed = after(readyFrame(), baseMap(true));
		const recovered = after(failed, baseMap(false));
		expect(stateOf(recovered)).toBe('ready');
		const midFrame = after(failed, invalidated(), baseMap(false));
		expect(stateOf(midFrame)).toBe('preparing');
	});

	test('keeps the control unavailable until both kinds have recovered', () => {
		const both = after(readyFrame(), baseMap(true), mapImage(true));
		expect(stateOf(after(both, baseMap(false)))).toBe('unavailable');
		expect(stateOf(after(both, mapImage(false)))).toBe('unavailable');
		expect(stateOf(after(both, baseMap(false), mapImage(false)))).toBe('ready');
	});

	test('reported twice is the same fact reported twice', () => {
		const failed = after(readyFrame(), baseMap(true));
		expect(snapshotReadinessAfter(failed, baseMap(true))).toBe(failed);
	});
});

describe('capturing', () => {
	test('stops a second press without changing what the frame is', () => {
		const capturing = after(readyFrame(), START);
		expect(canCaptureSnapshot(capturing)).toBe(false);
		expect(stateOf(capturing)).toBe('ready');
		expect(snapshotReadinessAfter(capturing, START)).toBe(capturing);
	});

	test('cannot start on a frame that is not ready', () => {
		const preparing = initialSnapshotReadiness;
		expect(snapshotReadinessAfter(preparing, START)).toBe(preparing);
		const unavailable = after(readyFrame(), baseMap(true));
		expect(snapshotReadinessAfter(unavailable, START)).toBe(unavailable);
	});

	test('hands the control back to the frame it captured', () => {
		const done = after(readyFrame(), START, FINISH);
		expect(canCaptureSnapshot(done)).toBe(true);
		expect(done.captureFailed).toBe(false);
	});

	test('hands it back to the frame that replaced it, when the map moved meanwhile', () => {
		const done = after(readyFrame(), START, invalidated(), FINISH);
		expect(stateOf(done)).toBe('preparing');
		expect(done.capturing).toBe(false);
	});
});

describe('a capture that failed', () => {
	test('is announced without touching the frame, leaving the control ready to press again', () => {
		const failed = after(readyFrame(), START, FAIL);
		expect(failed.captureFailed).toBe(true);
		expect(stateOf(failed)).toBe('ready');
		expect(failed.generation).toBe(0);
		expect(canCaptureSnapshot(failed)).toBe(true);
	});

	test('clears its announcement as the retry begins, so a second failure is heard, and stays cleared by one that works', () => {
		const retrying = after(readyFrame(), START, FAIL, START);
		expect(retrying.captureFailed).toBe(false);
		expect(after(retrying, FAIL).captureFailed).toBe(true);
		expect(after(retrying, FINISH).captureFailed).toBe(false);
	});

	test('does not stop the map moving on', () => {
		const moved = after(readyFrame(), START, FAIL, invalidated());
		expect(stateOf(moved)).toBe('preparing');
		expect(moved.captureFailed).toBe(true);
	});
});
