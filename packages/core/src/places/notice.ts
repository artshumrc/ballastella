import { PLACE_LOOKUP_MIN_INTERVAL_MS } from './lookup';
import type { LookupOutcome } from './place';

const ONE_SEARCH =
	PLACE_LOOKUP_MIN_INTERVAL_MS === 1_000
		? 'one search every second'
		: `one search every ${PLACE_LOOKUP_MIN_INTERVAL_MS / 1_000} seconds`;

export function placeLookupNotice(outcome: LookupOutcome, query: string, connected = true): string {
	switch (outcome.kind) {
		case 'places':
			return (
				`${outcome.places.length} ${outcome.places.length === 1 ? 'place matches' : 'places match'} ` +
				`“${query}”. Choose one to move the map to it.`
			);
		case 'none':
			return (
				`No place matching “${query}” was found, and nothing went wrong — this is a spelling to ` +
				'check rather than a fault. A town, a city, or a street with its town after it are the ' +
				'shapes the lookup answers best.'
			);
		case 'unanswered':
			return (
				`“${query}” could not be looked up. Nothing you did caused this. Nothing in your ` +
				'Workspace is affected and nothing about your Project has changed' +
				(connected
					? ', and this is usually the lookup service rather than anything at your end — ' +
						'searching again in a moment is worth trying.'
					: ' — searching again in a moment is worth trying.')
			);
		case 'too-fast':
			return (
				`“${query}” was not looked up, because the lookup service takes at most ${ONE_SEARCH} ` +
				'and this one came too soon after the last. Nothing in your Workspace is affected — wait ' +
				'a moment and search again.'
			);
	}
}
