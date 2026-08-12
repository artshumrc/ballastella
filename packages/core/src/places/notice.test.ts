import { describe, expect, it } from 'vitest';

import { PLACE_LOOKUP_MIN_INTERVAL_MS } from './lookup';
import { placeLookupNotice } from './notice';
import type { LookupOutcome, Place } from './place';

const PLACE: Place = {
	name: 'Springfield, Sangamon County, Illinois, United States',
	point: { lng: -89.6439575, lat: 39.7990175 },
	bounds: { west: -89.773182, south: 39.653656, east: -89.56851, north: 39.87417 }
};

const PLACES: LookupOutcome = { kind: 'places', places: [PLACE] };
const NONE: LookupOutcome = { kind: 'none' };
const UNANSWERED: LookupOutcome = { kind: 'unanswered' };
const TOO_FAST: LookupOutcome = { kind: 'too-fast' };

/** Every row of the table, so a row added without a sentence of its own cannot go unnoticed. */
const EVERY_ROW: readonly LookupOutcome[] = [PLACES, NONE, UNANSWERED, TOO_FAST];

describe('placeLookupNotice', () => {
	it('says which query it is about, in every row and either way round', () => {
		for (const outcome of EVERY_ROW) {
			for (const connected of [true, false]) {
				expect(placeLookupNotice(outcome, 'Springfield', connected)).toContain('Springfield');
			}
		}
	});

	it('counts the candidates, and agrees with itself about one', () => {
		expect(placeLookupNotice({ kind: 'places', places: [PLACE, PLACE] }, 'Springfield')).toContain(
			'2 places match'
		);
		expect(placeLookupNotice(PLACES, 'Springfield')).toContain('1 place matches');
	});

	it('gives the four outcomes four different sentences, with a connection and without', () => {
		// **The assertion this table exists for**, and `none` against `unanswered` is the pair that
		// matters: both end in no candidates, so one sentence covering both would pass every "the list
		// is empty" test in the suite — and would tell a scholar to check their spelling when the
		// request never left the building.
		//
		// ⚠ **Both connection states**, because `unanswered` is the row that changes between them: a
		// collapse that only shows up while offline would otherwise sit in the half of the table this
		// assertion never looked at.
		for (const connected of [true, false]) {
			const said = EVERY_ROW.map((outcome) => placeLookupNotice(outcome, 'Springfield', connected));

			expect(new Set(said).size, `connected: ${connected}`).toBe(EVERY_ROW.length);
		}
	});

	it('blames nothing about the scholar’s own work when nothing came back', () => {
		// **Both connection states**, because the first of the three beats is the one the offline row is
		// able to lose: with the it-is-probably-the-service clause gone, a passive "could not be looked
		// up" leaves *you typed it wrong* open. "Nothing you did caused this" is true whatever the
		// connection is doing and says nothing about where the failure was — the same job
		// `tile-failure.ts`'s `SAFE` does across its four rows.
		for (const connected of [true, false]) {
			const said = placeLookupNotice(UNANSWERED, 'Springfield', connected);
			const row = `connected: ${connected}`;

			expect(said, row).toContain('could not be looked up');
			expect(said, row).toContain('Nothing you did caused this');
			expect(said, row).toContain('Nothing in your Workspace is affected');
		}
	});

	it('sends a query that matched nothing to its spelling, and says nothing failed', () => {
		// A blank query is `none` without a request being issued at all, so this row can say that nothing
		// failed and can say nothing about what the service did. That second half is asserted for every
		// row and at clause level by `never claims a thing it cannot know` below, rather than as a ban on
		// a word here.
		const said = placeLookupNotice(NONE, 'Sprngfield');

		expect(said).toContain('spelling');
		expect(said).toContain('nothing went wrong');
	});

	it('names the remedy the scholar can actually take, for too many searches too fast', () => {
		// The one failure with a remedy in the scholar's own hands. It reads the same whether this
		// application's limiter refused or the service answered `429`, because `lookUpPlaces` gives both
		// the same outcome — there is one code path and one sentence (ADR-0029).
		const said = placeLookupNotice(TOO_FAST, 'Springfield');

		expect(said).toContain('wait a moment and search again');

		// ⚠ **The pace is read back out of the sentence and compared with the constant the limiter paces
		// by**, rather than asserted as the literal it currently renders. A literal here would let
		// `PLACE_LOOKUP_MIN_INTERVAL_MS` move to 2000 with the app still telling scholars one a second,
		// green the whole way — a false user-facing claim reachable by a one-line change.
		const named = /at most one search every (\d+ )?seconds?/.exec(said);
		expect(
			Number(named?.[1] ?? 1) * 1_000,
			'the sentence names a pace the code does not keep'
		).toBe(PLACE_LOOKUP_MIN_INTERVAL_MS);
	});

	it('drops the it-is-probably-them clause when the connection signal says there is none', () => {
		const connected = placeLookupNotice(UNANSWERED, 'Springfield', true);
		const cut = placeLookupNotice(UNANSWERED, 'Springfield', false);

		// Online the application can say where the failure probably was; with no connection it cannot,
		// and the difference is exactly that clause — the rest of the sentence is true either way.
		expect(connected).toContain('usually the lookup service');
		expect(cut).not.toContain('usually the lookup service');
		expect(cut).toContain('Nothing in your Workspace is affected');
		expect(cut).toContain('searching again in a moment');
	});

	/**
	 * Saying what the service did, in the clause-shaped ways a sentence here could come to say it.
	 *
	 * ⚠ **The claim, not the vocabulary.** Banning the word *answered* outlaws the single English word
	 * — including an honest use of it — while leaving "replied with nothing" green, which is the same
	 * claim by another verb. No row may report what the service did: `none` is produced for a blank
	 * query with no request issued at all, and `unanswered` covers a response this application could
	 * not read as well as one that never arrived.
	 */
	const SAYS_WHAT_THE_SERVICE_DID = [
		/(the (lookup )?service|it|nothing) (answered|replied|responded|returned|sent|came back)/i,
		/(did not|never|could not) (answer|reply|respond|be reached)/i,
		/(answered|replied|responded) with (nothing|no|an?|something)/i,
		/no (answer|reply|response)/i
	];

	it('never claims a thing it cannot know, in any row', () => {
		// The assertion this file exists for, and the one a rendered string cannot be asked. Every
		// string below is true in at most one row and actively wrong in the others: sending somebody to
		// their spelling when no request went out, telling them to slow down when the service is simply
		// down, or blaming a server on the strength of a signal that reports a link rather than
		// reachability.
		for (const outcome of EVERY_ROW) {
			for (const connected of [true, false]) {
				const said = placeLookupNotice(outcome, 'Springfield', connected);
				const row = `${outcome.kind}, connected: ${connected}`;

				// ⚠ **No row asserts anything about the scholar's own connection, in either direction.**
				// `navigator.onLine` may suppress a claim and may never make one, so there is no row this
				// is allowed in — which is why it is asserted outside the branch below.
				expect(said, row).not.toMatch(/offline|your connection|your wi-?fi|your internet/i);

				if (outcome.kind !== 'none') {
					expect(said, row).not.toMatch(/spelling|nothing went wrong/);
				}
				if (outcome.kind !== 'too-fast') {
					expect(said, row).not.toMatch(/wait a moment|too soon|one search every/);
				}
				// ⚠ **No row reports what the service did, and there is no row this is allowed in** —
				// including `places`, which has the evidence and still does not need to say it.
				for (const claim of SAYS_WHAT_THE_SERVICE_DID) expect(said, row).not.toMatch(claim);
				// Blame goes only to the row that has evidence for it, and only while there is a
				// connection to make that evidence mean anything.
				if (!(outcome.kind === 'unanswered' && connected)) {
					expect(said, row).not.toMatch(/usually the lookup service/);
				}
			}
		}
	});
});
