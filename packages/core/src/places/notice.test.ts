import { describe, expect, it } from 'vitest';

import { placeLookupNotice } from './notice';
import type { LookupOutcome, Place } from './place';

const PLACE: Place = {
	name: 'Springfield, Sangamon County, Illinois, United States',
	point: { lng: -89.6439575, lat: 39.7990175 },
	bounds: { west: -89.773182, south: 39.653656, east: -89.56851, north: 39.87417 }
};

const NONE: LookupOutcome = { kind: 'none' };
const UNANSWERED: LookupOutcome = { kind: 'unanswered' };

describe('placeLookupNotice', () => {
	it('says which query it is about, in every row', () => {
		for (const outcome of [{ kind: 'places', places: [PLACE] } as const, NONE, UNANSWERED]) {
			expect(placeLookupNotice(outcome, 'Springfield')).toContain('Springfield');
		}
	});

	it('counts the candidates, and agrees with itself about one', () => {
		expect(placeLookupNotice({ kind: 'places', places: [PLACE, PLACE] }, 'Springfield')).toContain(
			'2 places match'
		);
		expect(placeLookupNotice({ kind: 'places', places: [PLACE] }, 'Springfield')).toContain(
			'1 place matches'
		);
	});

	it('tells the two empty-handed outcomes apart', () => {
		// **The assertion this table exists for.** Both outcomes end in no candidates, so one sentence
		// covering both would pass every "the list is empty" test in the suite — and would tell a
		// scholar to check their spelling when the request never left the building.
		expect(placeLookupNotice(NONE, 'Springfield')).not.toBe(
			placeLookupNotice(UNANSWERED, 'Springfield')
		);
	});

	it('blames nothing about the scholar’s own work when the service did not answer', () => {
		const said = placeLookupNotice(UNANSWERED, 'Springfield');
		expect(said).toContain('did not answer');
		expect(said).toContain('Nothing in your Workspace is affected');
	});

	it('says nothing failed, without claiming the service answered', () => {
		// A blank query is `none` without a request being issued, so a sentence saying the service
		// answered would be a claim about a service that was never asked.
		const said = placeLookupNotice(NONE, 'Sprngfield');
		expect(said).not.toContain('answered');
		expect(said).not.toContain('did not answer');
		expect(said).toContain('spelling');
	});
});
