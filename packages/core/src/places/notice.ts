import type { LookupOutcome } from './place';

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
 * request never left the building is the inversion `nothing-fails-silently` story 10 forbids.
 *
 * ⚠ **`unanswered`'s wording is deliberately plain and is refined by the rate-limiter slice**, which
 * adds the *too many searches, too fast* row beside it and drops the it-is-probably-them clause when
 * the connection signal says the browser is offline — `navigator.onLine` may suppress a claim and
 * may never make one (ADR-0029).
 *
 * ⚠ **`none` says nothing about what the service did.** A blank query is answered `none` without a
 * request being issued at all (`lookup.ts`), so a sentence reporting that the service answered would
 * be a claim about a service that was never asked. What `none` can keep is that nothing failed —
 * which is still the whole of the distinction from `unanswered`.
 *
 * @param query what the scholar submitted, so a sentence names the search rather than the app
 */
export function placeLookupNotice(outcome: LookupOutcome, query: string): string {
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
				`The place lookup service did not answer, so “${query}” could not be looked up. Nothing ` +
				'in your Workspace is affected and nothing about your Project has changed — searching ' +
				'again in a moment is worth trying.'
			);
	}
}
