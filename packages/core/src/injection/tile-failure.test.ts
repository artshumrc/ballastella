import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	TILE_RECOVERY_DELAYS,
	mapImageTilesUnavailableNotice,
	keepAskingForMissingTiles,
	type TileSourceFailure
} from './tile-failure.js';

const EVERY_ROW: readonly TileSourceFailure[] = [
	{ kind: 'no-answer', host: null },
	{ kind: 'no-answer', host: 'maps.library.example' },
	{ kind: 'file-missing', host: null },
	{ kind: 'file-missing', host: 'maps.library.example' },
	{ kind: 'server-error', host: null, status: 500 },
	{ kind: 'server-error', host: 'maps.library.example', status: 503 },
	{ kind: 'unreadable', host: null, detail: 'the quota was exceeded' },
	{ kind: 'unreadable', host: 'maps.library.example', detail: 'the quota was exceeded' }
];

describe('mapImageTilesUnavailableNotice', () => {
	it('names the Layer when the failure belongs to one, and does not invent one when it does not', () => {
		const failure: TileSourceFailure = { kind: 'no-answer', host: null };

		expect(mapImageTilesUnavailableNotice(failure, 'Blaeu’s plan')).toContain(
			'The Map Image “Blaeu’s plan”'
		);
		expect(mapImageTilesUnavailableNotice(failure)).toContain('A Map Image on this page');
		expect(mapImageTilesUnavailableNotice(failure)).not.toContain('“');
	});

	it('says the connection or that server, for a request that got no answer at all', () => {
		const here = mapImageTilesUnavailableNotice({ kind: 'no-answer', host: null });
		const library = mapImageTilesUnavailableNotice({
			kind: 'no-answer',
			host: 'maps.library.example'
		});

		expect(here).toContain('this site could not be reached');
		expect(library).toContain('maps.library.example could not be reached');
		expect(here).toContain('either your connection or that server');
	});

	it('tells a Reader that reconnecting will not help when the file is simply not there', () => {
		const notice = mapImageTilesUnavailableNotice({ kind: 'file-missing', host: null });
		expect(notice).toContain('does not hold the file it is drawn from');
		expect(notice).toContain('Reconnecting will not help');
		expect(notice).toContain('Whoever made this site has to restore it');
	});

	it('names the status, and says the connection is working, when a server answered and failed', () => {
		const notice = mapImageTilesUnavailableNotice({
			kind: 'server-error',
			host: 'maps.library.example',
			status: 503
		});

		expect(notice).toContain('maps.library.example answered 503');
		expect(notice).toContain('your own connection is working');
	});

	it('names the gesture that actually fetches what is still missing, and no other', () => {
		for (const failure of EVERY_ROW) {
			const notice = mapImageTilesUnavailableNotice(failure, 'Blaeu’s plan');
			const recovers = failure.kind === 'no-answer' || failure.kind === 'server-error';

			if (recovers) {
				expect(notice, failure.kind).toContain('picks up what it can by itself');
				expect(notice, failure.kind).toContain('hide this Layer and show it again');
				expect(notice, failure.kind).toContain('reload the page');
			} else {
				expect(notice, failure.kind).not.toContain('picks up what it can');
				expect(notice, failure.kind).not.toContain('hide this Layer');
			}

			expect(notice, failure.kind).not.toContain('finishes drawing on its own');
			expect(notice, failure.kind).not.toContain('waiting rather than reloading');
			expect(notice, failure.kind).not.toContain('draws itself again');
			expect(notice, failure.kind).not.toMatch(/mov(e|ing) the map|pan|zoom/i);
		}
	});

	it('says what happened and nothing more for a failure it cannot classify', () => {
		const notice = mapImageTilesUnavailableNotice({
			kind: 'unreadable',
			host: null,
			detail: 'the quota was exceeded'
		});

		expect(notice).toContain('the quota was exceeded');
		expect(notice).toContain('Reloading the page');
	});

	it('never gives a row another row’s remedy, and never claims the map is whole', () => {
		for (const failure of EVERY_ROW) {
			const notice = mapImageTilesUnavailableNotice(failure, 'Blaeu’s plan');

			if (failure.kind !== 'no-answer') {
				expect(notice).not.toContain('either your connection or that server');
			}
			if (failure.kind !== 'file-missing') {
				expect(notice).not.toContain('Whoever made');
				expect(notice).not.toContain('Reconnecting will not help');
			}
			if (failure.kind !== 'server-error') {
				expect(notice).not.toContain('your own connection is working');
				expect(notice).not.toMatch(/answered \d/);
			}
			expect(notice).not.toMatch(/fully drawn|is complete|all of the map|drawn in full/);
			expect(notice).not.toMatch(/try again later by hand|re-align|make it again/);
		}
	});

	it('puts the three things in the order the questions arrive, and says all three: that it is not the reader’s doing and the rest is safe', () => {
		const REMEDY_MARK: Record<TileSourceFailure['kind'], string> = {
			'no-answer': 'either your connection or that server',
			'file-missing': 'Whoever made this site',
			'server-error': 'your own connection is working',
			unreadable: 'Reloading the page'
		};

		for (const failure of EVERY_ROW) {
			const notice = mapImageTilesUnavailableNotice(failure, 'Blaeu’s plan');
			const stopped = notice.indexOf('stopped drawing');
			const safe = notice.indexOf('Nothing you did caused this');
			const remedy = notice.indexOf(REMEDY_MARK[failure.kind]);
			expect(stopped, failure.kind).toBeGreaterThanOrEqual(0);
			expect(safe, failure.kind).toBeGreaterThan(stopped);
			expect(remedy, failure.kind).toBeGreaterThan(safe);
			expect(notice).toContain('the Annotations and the rest of the author’s work are unaffected');
			expect(notice).toContain('already been drawn is still on screen');
		}
	});
});

describe('keepAskingForMissingTiles', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const painting = (): ReturnType<typeof vi.fn> => {
		const asked = vi.fn();
		keepAskingForMissingTiles((delivered) => {
			asked();
			delivered();
		});
		return asked;
	};

	it('asks again with no gesture, soonest while a Reader is still watching, waiting each of its lengthening delays in turn and no other', () => {
		vi.useFakeTimers();
		const asked = painting();
		const dueAt = [250, 750, 1_750, 3_750, 7_750, 15_750, 31_750, 61_750, 91_750, 121_750, 151_750];
		let now = 0;
		for (const [index, due] of dueAt.entries()) {
			vi.advanceTimersByTime(due - 1 - now);
			expect(asked, `nothing more is asked at ${due - 1}ms`).toHaveBeenCalledTimes(index);
			vi.advanceTimersByTime(2);
			expect(asked, `re-ask ${index + 1} has happened by ${due + 1}ms`).toHaveBeenCalledTimes(
				index + 1
			);
			now = due + 1;
		}
	});

	it('parks rather than spending the budget on frames a hidden tab never paints', () => {
		vi.useFakeTimers();
		const asked = vi.fn();
		let paint: (() => void) | undefined;
		keepAskingForMissingTiles((delivered) => {
			asked();
			paint = delivered;
		});

		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		expect(asked, 'the budget is not spent while nothing is painting').toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount(), 'and nothing is left spinning either').toBe(0);

		paint?.();
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		expect(asked).toHaveBeenCalledTimes(2);
	});

	it('stops asking a site that stays broken, rather than repainting for ever', () => {
		vi.useFakeTimers();
		const asked = painting();

		vi.advanceTimersByTime(24 * 60 * 60 * 1000);

		expect(asked).toHaveBeenCalledTimes(TILE_RECOVERY_DELAYS.length);
		expect(vi.getTimerCount(), 'nothing is still scheduled').toBe(0);

		const backingOff = TILE_RECOVERY_DELAYS.every(
			(delay, index) => index === 0 || delay >= TILE_RECOVERY_DELAYS[index - 1]!
		);
		expect(backingOff).toBe(true);
		expect(TILE_RECOVERY_DELAYS).toHaveLength(11);
		expect(TILE_RECOVERY_DELAYS.reduce((total, delay) => total + delay, 0)).toBe(151_750);
	});

	it('stops the moment it is told the bytes came back', () => {
		vi.useFakeTimers();
		const asked = vi.fn();

		const stop = keepAskingForMissingTiles((delivered) => {
			asked();
			delivered();
		});
		vi.advanceTimersByTime(1_000);
		const askedWhileMissing = asked.mock.calls.length;
		stop();
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);

		expect(asked).toHaveBeenCalledTimes(askedWhileMissing);
		expect(vi.getTimerCount()).toBe(0);
	});
});
