// Every row of the sentence a person meets when a Historical Map's tiles stop arriving, plus the
// row-crossing assertions that are the actual point of driving it here.
//
// The prior art is `base-map/resolve.test.ts`, and so is the reason: that notice shipped **false in
// two reachable rows** because it was a nested ternary in a template, chosen without the state that
// decided it, and neither row could be produced from a browser. The rows below are the same shape —
// four of them, each with a different remedy — and three of the four are reachable from the viewer
// suite, which makes the fourth exactly the kind of row a browser test cannot defend.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	TILE_RECOVERY_DELAYS,
	historicalMapTilesUnavailableNotice,
	keepAskingForMissingTiles,
	type TileSourceFailure
} from './tile-failure.js';

/** Every row, with a host on the ones that can carry one and without on the ones that cannot. */
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

describe('historicalMapTilesUnavailableNotice', () => {
	it('names the Layer when the failure belongs to one, and does not invent one when it does not', () => {
		// A pass-through request carries a URL and no Layer, so there is a real row with nothing to
		// name. Naming the wrong map would send a scholar to check an Alignment that is fine.
		const failure: TileSourceFailure = { kind: 'no-answer', host: null };

		expect(historicalMapTilesUnavailableNotice(failure, 'Blaeu’s plan')).toContain(
			'The Historical Map “Blaeu’s plan”'
		);
		expect(historicalMapTilesUnavailableNotice(failure)).toContain('A Historical Map on this page');
		expect(historicalMapTilesUnavailableNotice(failure)).not.toContain('“');
	});

	it('says the connection or that server, for a request that got no answer at all', () => {
		const here = historicalMapTilesUnavailableNotice({ kind: 'no-answer', host: null });
		const library = historicalMapTilesUnavailableNotice({
			kind: 'no-answer',
			host: 'maps.library.example'
		});

		expect(here).toContain('this site could not be reached');
		expect(library).toContain('maps.library.example could not be reached');
		// Both remedies, because `status === 0` genuinely cannot tell them apart from inside the page.
		expect(here).toContain('either your connection or that server');
	});

	it('tells a Reader that reconnecting will not help when the file is simply not there', () => {
		const notice = historicalMapTilesUnavailableNotice({ kind: 'file-missing', host: null });

		expect(notice).toContain('does not hold the file it is drawn from');
		expect(notice).toContain('Reconnecting will not help');
		expect(notice).toContain('Whoever published this site has to restore it');
	});

	it('names the status, and says the connection is working, when a server answered and failed', () => {
		const notice = historicalMapTilesUnavailableNotice({
			kind: 'server-error',
			host: 'maps.library.example',
			status: 503
		});

		expect(notice).toContain('maps.library.example answered 503');
		// The one thing this row knows that the no-answer row cannot: something answered.
		expect(notice).toContain('your own connection is working');
	});

	it('names the gesture that actually fetches what is still missing, and no other', () => {
		// ⚠ **This row is measured, not reasoned.** `viewer-reader.e2e.ts` drives both shapes of the
		// failure: a refused `info.json` heals with no gesture at all (`loadMissingImagesInViewport`
		// runs every frame), and a refused tile cell does not — **not even after a zoom**, because the
		// failed cell sits in the renderer's tile cache. Only a rebuilt layer re-requests it.
		//
		// The sentence used to promise "the map finishes drawing on its own … worth checking your
		// connection and waiting rather than reloading". A Reader who followed that waited in front of
		// a warning that would never go. So: what the map does by itself, and what it needs a person
		// for, said separately.
		for (const failure of EVERY_ROW) {
			const notice = historicalMapTilesUnavailableNotice(failure, 'Blaeu’s plan');
			const recovers = failure.kind === 'no-answer' || failure.kind === 'server-error';

			if (recovers) {
				expect(notice, failure.kind).toContain('picks up what it can by itself');
				expect(notice, failure.kind).toContain('hide this Layer and show it again');
				expect(notice, failure.kind).toContain('reload the page');
			} else {
				// Nothing to come back: reloading for a file the site does not carry cannot work.
				expect(notice, failure.kind).not.toContain('picks up what it can');
				expect(notice, failure.kind).not.toContain('hide this Layer');
			}

			// The two claims that were false, in every row, in any wording.
			expect(notice, failure.kind).not.toContain('finishes drawing on its own');
			expect(notice, failure.kind).not.toContain('waiting rather than reloading');
			expect(notice, failure.kind).not.toContain('draws itself again');
			// And never the gesture that was measured NOT to work.
			expect(notice, failure.kind).not.toMatch(/mov(e|ing) the map|pan|zoom/i);
		}
	});

	it('says what happened and nothing more for a failure it cannot classify', () => {
		// The row that exists so the other three cannot be made to lie. Folding an unknown storage
		// refusal into "could not be reached" would tell a scholar whose browser storage refused to go
		// and check their wifi.
		const notice = historicalMapTilesUnavailableNotice({
			kind: 'unreadable',
			host: null,
			detail: 'the quota was exceeded'
		});

		expect(notice).toContain('the quota was exceeded');
		expect(notice).toContain('Reloading the page');
	});

	it('says it is not the reader’s doing and that the rest of the work is safe, in every row', () => {
		// SPEC stories 14 and 15, which are the two questions a half-drawn map raises before any
		// remedy is any use: is this me, and is the rest of it gone?
		for (const failure of EVERY_ROW) {
			const notice = historicalMapTilesUnavailableNotice(failure, 'Blaeu’s plan');

			expect(notice).toContain('Nothing you did caused this');
			expect(notice).toContain('the Annotations and the rest of the author’s work are unaffected');
			expect(notice).toContain('already been drawn is still on screen');
		}
	});

	it('never gives a row another row’s remedy, and never claims the map is whole', () => {
		// The assertion this file exists for. Each of these strings is *true in exactly one row* and
		// actively harmful in the others: sending a Reader to their router when the file is absent,
		// telling somebody with no wifi that their connection is fine, or claiming a map is drawn
		// while a notice above it says it stopped.
		for (const failure of EVERY_ROW) {
			const notice = historicalMapTilesUnavailableNotice(failure, 'Blaeu’s plan');

			if (failure.kind !== 'no-answer') {
				expect(notice).not.toContain('either your connection or that server');
			}
			if (failure.kind !== 'file-missing') {
				expect(notice).not.toContain('Whoever published');
				expect(notice).not.toContain('Reconnecting will not help');
			}
			if (failure.kind !== 'server-error') {
				expect(notice).not.toContain('your own connection is working');
				// And no row invents a status it was never given.
				expect(notice).not.toMatch(/answered \d/);
			}
			// No row claims what is on the screen beyond what survived, in any wording.
			expect(notice).not.toMatch(/fully drawn|is complete|all of the map|drawn in full/);
			// And no row tells a person to do the thing that is guaranteed not to work here: there is
			// nothing to save, re-align, or re-publish from a Reader's side.
			expect(notice).not.toMatch(/try again later by hand|re-align|publish it again/);
		}
	});

	it('puts the three things in the order the questions arrive, and says all three', () => {
		// SPEC: it is not you; your work is safe; here is what would fix it. Asserted as three indices
		// in order rather than as three memberships, because the failure this shape prevents is a
		// remedy read before the reassurance.
		//
		// ⚠ **The first version of this test could not detect a reorder**, which is what it existed
		// for. It compared the fact against the reassurance and then asserted that the string was
		// merely *longer* than the reassurance — satisfied by `SAFE` alone, and green with `remedy()`
		// returning `''` for every row. The remedy needs its own index, and the index needs to be of
		// something only that row's remedy contains.
		const REMEDY_MARK: Record<TileSourceFailure['kind'], string> = {
			'no-answer': 'either your connection or that server',
			'file-missing': 'Whoever published this site',
			'server-error': 'your own connection is working',
			unreadable: 'Reloading the page'
		};

		for (const failure of EVERY_ROW) {
			const notice = historicalMapTilesUnavailableNotice(failure, 'Blaeu’s plan');
			const stopped = notice.indexOf('stopped drawing');
			const safe = notice.indexOf('Nothing you did caused this');
			const remedy = notice.indexOf(REMEDY_MARK[failure.kind]);

			expect(stopped, failure.kind).toBeGreaterThanOrEqual(0);
			expect(safe, failure.kind).toBeGreaterThan(stopped);
			expect(remedy, failure.kind).toBeGreaterThan(safe);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE HALF OF THE SENTENCE THAT IS NOT WORDING
//
// "The map picks up what it can by itself" is a claim about behaviour, and it was **false for a
// Reader who was sitting still**. `WebGL2Renderer.render` re-asks for a refused `info.json` on every
// painted frame; MapLibre paints no frames when nothing changes; so on a settled map the record was
// never re-requested and the notice never came down. `viewer-reader.e2e.ts` is where a Reader's
// experience of that is asserted — the notice going away with no gesture — and it is the right place
// for it, because only a browser has a renderer that stops painting.
//
// What that test cannot show is the shape of the schedule: that it backs off, and above all that it
// **ends**. A budget that ran for ever would pass exactly the same end-to-end assertions while
// costing a Reader their battery on a site that is simply broken. So the bound lives here, where it
// can be driven off a clock.

describe('keepAskingForMissingTiles', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('asks again with no gesture at all, and asks soonest while a Reader is still watching', () => {
		vi.useFakeTimers();
		const asked = vi.fn();

		keepAskingForMissingTiles(asked);

		// Nothing has happened but time. This is the whole point: no click, no zoom, no redraw.
		expect(asked, 'nothing is asked before the first delay').not.toHaveBeenCalled();
		// Most outages that recover recover within seconds, which is also the window in which somebody
		// is still looking at the map — so the first re-ask is within half a second of the refusal and
		// the ones after it are close behind.
		vi.advanceTimersByTime(500);
		expect(asked).toHaveBeenCalled();
		vi.advanceTimersByTime(2_000);
		expect(asked.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it('stops asking a site that stays broken, rather than repainting for ever', () => {
		vi.useFakeTimers();
		const asked = vi.fn();

		keepAskingForMissingTiles(asked);
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);

		// A bounded retry and not a loop: the budget is spent, and — the assertion that actually
		// distinguishes the two — nothing is left waiting to run. Each frame is another request to a
		// server already known to be failing, and a Reader who leaves a broken site open must not go
		// on paying for it.
		expect(asked).toHaveBeenCalledTimes(TILE_RECOVERY_DELAYS.length);
		expect(vi.getTimerCount(), 'nothing is still scheduled').toBe(0);

		// And it backs off rather than hammering: every wait is at least as long as the one before it,
		// and the whole budget is minutes rather than hours.
		const backingOff = TILE_RECOVERY_DELAYS.every(
			(delay, index) => index === 0 || delay >= TILE_RECOVERY_DELAYS[index - 1]!
		);
		expect(backingOff).toBe(true);
		expect(TILE_RECOVERY_DELAYS.reduce((total, delay) => total + delay, 0)).toBeLessThan(
			5 * 60 * 1000
		);
	});

	it('stops the moment it is told the bytes came back', () => {
		vi.useFakeTimers();
		const asked = vi.fn();

		const stop = keepAskingForMissingTiles(asked);
		vi.advanceTimersByTime(1_000);
		const askedWhileMissing = asked.mock.calls.length;
		stop();
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);

		// Called by the caller when the notice comes down and on teardown, and both have to be final:
		// a schedule that outlived a removed map would repaint something that is gone.
		expect(asked).toHaveBeenCalledTimes(askedWhileMissing);
		expect(vi.getTimerCount()).toBe(0);
	});
});
