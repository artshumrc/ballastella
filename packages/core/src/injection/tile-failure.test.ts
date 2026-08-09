// Every row of the sentence a person meets when a Historical Map's tiles stop arriving, plus the
// row-crossing assertions that are the actual point of driving it here.
//
// The prior art is `base-map/resolve.test.ts`, and so is the reason: that notice shipped **false in
// two reachable rows** because it was a nested ternary in a template, chosen without the state that
// decided it, and neither row could be produced from a browser. The rows below are the same shape —
// four of them, each with a different remedy — and three of the four are reachable from the viewer
// suite, which makes the fourth exactly the kind of row a browser test cannot defend.

import { describe, expect, it } from 'vitest';

import { historicalMapTilesUnavailableNotice, type TileSourceFailure } from './tile-failure.js';

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
		expect(here).toContain('checking your connection');
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
		expect(notice).toContain('draws itself again once it recovers');
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

			if (failure.kind !== 'no-answer') expect(notice).not.toContain('checking your connection');
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

	it('is one sentence group in a fixed order, so both deployments read the same', () => {
		// Three things, in the order the questions arrive (SPEC: it is not you; your work is safe;
		// here is what would fix it). Asserted as an order rather than as three memberships, because
		// the failure this shape prevents is a remedy read before the reassurance.
		for (const failure of EVERY_ROW) {
			const notice = historicalMapTilesUnavailableNotice(failure, 'Blaeu’s plan');
			const stopped = notice.indexOf('stopped drawing');
			const safe = notice.indexOf('Nothing you did caused this');

			expect(stopped).toBeGreaterThanOrEqual(0);
			expect(safe).toBeGreaterThan(stopped);
			expect(notice.length).toBeGreaterThan(safe + 'Nothing you did caused this'.length);
		}
	});
});
