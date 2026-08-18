/**
 * The sentence a Reader or a scholar is shown when a Map Image's tiles stop arriving.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS HERE AND NOT WRITTEN OUT IN EACH SPEC
 *
 * Exactly the arrangement `support/base-map-notice.ts` arrived at, and for the reason recorded
 * there. `mapImageTilesUnavailableNotice` in `@ballastella/core` composes one sentence and
 * **both applications render that same function's output** — the published viewer at ticket 04, the
 * editor at ticket 05 — so that one outage is not described two ways at the same person. A contract
 * between two applications is only real if something fails when it breaks, and the way that contract
 * broke last time was one side pinning the whole string and the other pinning four fragments of it,
 * which left an inlined copy on the second side entirely green.
 *
 * So: one expected string, built here, asserted with `toHaveText` — never `toContainText` — on both
 * sides.
 *
 * ⚠ **What this pins is "both render the same text", not "both call core".** An application that
 * inlined this sentence verbatim still passes, and that is the right boundary for a browser test: it
 * asserts what a person reads. What it catches is the thing that actually happens — one side being
 * reworded on its own — and it catches it from either direction, since the expectation lives in
 * neither spec.
 *
 * ⚠ **Deliberately duplicated from core rather than imported.** This suite's tsconfig covers only
 * `e2e/` and resolves nothing from `@ballastella/core`; `support/editor-deployment.ts` explains the
 * arrangement at length. The duplication is safe in the direction that matters — a change to core's
 * wording that is not made here turns both specs red rather than passing quietly.
 *
 * Two of the four rows are written out — the two a browser can produce without a network, by
 * aborting a route and by answering one with a status. The other two are driven at the unit seam in
 * `packages/core/src/injection/tile-failure.test.ts`, where a storage refusal can be invented.
 *
 * The middle clause is shared here exactly as it is shared in core, and that is deliberate: it is
 * the "it is not you, your work is safe" half, it must be identical in every row, and a copy per row
 * here would let core's rows drift apart with this file agreeing.
 */
const SAFE =
	'Nothing you did caused this, and nothing has been lost: the Annotations and the rest of the ' +
	'author’s work are unaffected, and whatever of the map had already been drawn is still on screen.';

/**
 * The recovery clause the two recoverable rows share.
 *
 * ⚠ **Every word of it is measured** — see the two recovery tests in `viewer-reader.e2e.ts`. A
 * refused `info.json` heals with no gesture; a refused tile cell does not, and not after a zoom
 * either. The sentence it replaced promised the map would finish drawing on its own, which was false
 * for the tile-cell half and left a Reader waiting in front of a warning that would never go.
 */
const WHEN_IT_ANSWERS_AGAIN =
	'When it is answering again the map picks up what it can by itself; anything still missing ' +
	'comes back if you hide this Layer and show it again, or reload the page.';

/**
 * The row for a request that got no answer at all — what an aborted route looks like to `fetch`.
 *
 * @param mapName the Layer's name, as the stack shows it
 * @param where the host that did not answer, or `this site` when there was no host to name
 */
export function tilesUnavailableNotice(mapName: string, where: string): string {
	return (
		`The Map Image “${mapName}” stopped drawing, because ${where} could not be reached. ` +
		`${SAFE} That is either your connection or that server, and there is no way to tell which ` +
		`from here. ${WHEN_IT_ANSWERS_AGAIN}`
	);
}

/**
 * The row for a server that answered and failed — and whose remedy is the opposite of the one above.
 *
 * Something answered, so the Reader's own connection demonstrably works, and telling them to go and
 * check it would send them to fix a thing that is not broken.
 */
export function tilesServerErrorNotice(mapName: string, where: string, status: number): string {
	return (
		`The Map Image “${mapName}” stopped drawing, because ${where} answered ${status}. ` +
		`${SAFE} The server answered, so your own connection is working and it is that server that ` +
		`is failing. ${WHEN_IT_ANSWERS_AGAIN}`
	);
}
