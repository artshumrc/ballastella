import { PLACE_LOOKUP_MIN_INTERVAL_MS } from './lookup';
import type { LookupOutcome } from './place';

/**
 * The pace, in the words the sentence needs, taken from the number the limiter actually paces by.
 *
 * A rate written out in prose beside a constant is a claim that drifts the moment the constant moves:
 * `PLACE_LOOKUP_MIN_INTERVAL_MS` changed to 2000 with this sentence still saying *a second* tells a
 * scholar a number this application does not honour, with nothing anywhere going red.
 */
const ONE_SEARCH =
	PLACE_LOOKUP_MIN_INTERVAL_MS === 1_000
		? 'one search every second'
		: `one search every ${PLACE_LOOKUP_MIN_INTERVAL_MS / 1_000} seconds`;

/**
 * What one lookup outcome says to a scholar, in one sentence per row.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE WORDING IS HERE AND NOT IN THE SEARCH COMPONENT
 *
 * The same reason `baseMapUnavailableNotice` is in this package: the sentence is a claim the code
 * has to be able to keep, and a string built inside a Svelte template can only be asked about
 * through a browser. It is also what stops **the two empty-handed rows drifting together**. `none`
 * and `unanswered` are the same shape to a careless consumer — neither has candidates — and the
 * failure that matters is one sentence covering both: "no results for Boston Common" when the
 * request never left the building is an inversion this module exists to prevent.
 *
 * ⚠ **`none` says nothing about what the service did.** A blank query is answered `none` without a
 * request being issued at all (`lookup.ts`), so a sentence reporting that the service answered would
 * be a claim about a service that was never asked. What `none` can keep is that nothing failed —
 * which is still the whole of the distinction from `unanswered`.
 *
 * ⚠ **`too-fast` is one row for two causes.** A `429` and this application's own limiter refusing to
 * issue a request produce the same outcome, so they produce this same sentence: the remedy is
 * identical, and a scholar told to wait does not care which side counted (ADR-0029).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT `connected` MAY DO, AND WHAT IT MAY NOT
 *
 * It may **suppress** a claim and may never **make** one. The signal behind it is `navigator.onLine`
 * — a link rather than reachability, false-positive in both directions — so `unanswered` drops its
 * it-is-probably-the-service clause when it is false, and gains nothing in its place. Telling
 * somebody whose wifi is off that a server in another country is having a bad afternoon is worse
 * than saying nothing; telling them they are offline on the strength of that signal is asserting
 * something it cannot support (`online.svelte.ts`, ADR-0029).
 *
 * @param query what the scholar submitted, so a sentence names the search rather than the app
 * @param connected whether this browser reports a connection. Defaults to `true`, which is the
 *   value that says the least: it is the one under which every clause is a claim somebody has to
 *   stand behind.
 */
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
			// The whole difference is the last clause. What is shared is the fact — the lookup did not
			// happen — and the two beats that come before the remedy, all of which are true whatever the
			// connection is doing and none of which says where the failure was. `unanswered` also covers
			// a response this application could not read, so even "the service did not answer" would be a
			// shade beyond what this row knows.
			//
			// ⚠ **"Nothing you did caused this" is it-is-not-you**, and it stays when the connection
			// signal takes the last clause away: without it the offline row is a passive "could not be
			// looked up" that leaves *you typed it wrong* open, which is the first question a scholar
			// asks (`resolve.ts`). It is not the same claim as "it was the service" — it is true wherever
			// the failure was, which is what lets `tile-failure.ts`'s `SAFE` say it in all four rows.
			return (
				`“${query}” could not be looked up. Nothing you did caused this. Nothing in your ` +
				'Workspace is affected and nothing about your Project has changed' +
				(connected
					? ', and this is usually the lookup service rather than anything at your end — ' +
						'searching again in a moment is worth trying.'
					: ' — searching again in a moment is worth trying.')
			);
		case 'too-fast':
			// No "nothing you did caused this" here, and it is the one row where that clause would be
			// false: this search came too soon after the last one, which is a thing the scholar did. The
			// beat it exists for — leaving nothing for them to suspect of themselves — is served by
			// naming the cause outright, and the remedy is theirs to take.
			return (
				`“${query}” was not looked up, because the lookup service takes at most ${ONE_SEARCH} ` +
				'and this one came too soon after the last. Nothing in your Workspace is affected — wait ' +
				'a moment and search again.'
			);
	}
}
