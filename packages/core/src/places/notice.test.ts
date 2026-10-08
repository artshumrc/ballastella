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
		for (const connected of [true, false]) {
			const said = EVERY_ROW.map((outcome) => placeLookupNotice(outcome, 'Springfield', connected));
			expect(new Set(said).size, `connected: ${connected}`).toBe(EVERY_ROW.length);
		}
	});

	it('blames nothing about the scholar’s own work when nothing came back', () => {
		for (const connected of [true, false]) {
			const said = placeLookupNotice(UNANSWERED, 'Springfield', connected);
			const row = `connected: ${connected}`;
			expect(said, row).toContain('could not be looked up');
			expect(said, row).toContain('Nothing you did caused this');
			expect(said, row).toContain('Nothing in your Workspace is affected');
		}
	});

	it('sends a query that matched nothing to its spelling, and says nothing failed', () => {
		const said = placeLookupNotice(NONE, 'Sprngfield');
		expect(said).toContain('spelling');
		expect(said).toContain('nothing went wrong');
	});

	it('names the remedy the scholar can actually take, for too many searches too fast', () => {
		const said = placeLookupNotice(TOO_FAST, 'Springfield');
		expect(said).toContain('wait a moment and search again');
		const named = /at most one search every (\d+ )?seconds?/.exec(said);
		expect(
			Number(named?.[1] ?? 1) * 1_000,
			'the sentence names a pace the code does not keep'
		).toBe(PLACE_LOOKUP_MIN_INTERVAL_MS);
	});

	it('drops the it-is-probably-them clause when the connection signal says there is none', () => {
		const connected = placeLookupNotice(UNANSWERED, 'Springfield', true);
		const cut = placeLookupNotice(UNANSWERED, 'Springfield', false);
		expect(connected).toContain('usually the lookup service');
		expect(cut).not.toContain('usually the lookup service');
		expect(cut).toContain('Nothing in your Workspace is affected');
		expect(cut).toContain('searching again in a moment');
	});

	const SAYS_WHAT_THE_SERVICE_DID = [
		/(the (lookup )?service|it|nothing) (answered|replied|responded|returned|sent|came back)/i,
		/(did not|never|could not) (answer|reply|respond|be reached)/i,
		/(answered|replied|responded) with (nothing|no|an?|something)/i,
		/no (answer|reply|response)/i
	];

	it('never claims a thing it cannot know, in any row', () => {
		for (const outcome of EVERY_ROW) {
			for (const connected of [true, false]) {
				const said = placeLookupNotice(outcome, 'Springfield', connected);
				const row = `${outcome.kind}, connected: ${connected}`;
				expect(said, row).not.toMatch(/offline|your connection|your wi-?fi|your internet/i);

				if (outcome.kind !== 'none') {
					expect(said, row).not.toMatch(/spelling|nothing went wrong/);
				}
				if (outcome.kind !== 'too-fast') {
					expect(said, row).not.toMatch(/wait a moment|too soon|one search every/);
				}
				for (const claim of SAYS_WHAT_THE_SERVICE_DID) expect(said, row).not.toMatch(claim);
				if (!(outcome.kind === 'unanswered' && connected)) {
					expect(said, row).not.toMatch(/usually the lookup service/);
				}
			}
		}
	});
});
