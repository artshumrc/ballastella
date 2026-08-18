/**
 * The sentence a scholar or a Reader is shown when a Base Map's archive answered nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS HERE AND NOT WRITTEN OUT IN EACH SPEC
 *
 * `baseMapUnavailableNotice` in `@ballastella/core` composes one sentence, and **both applications
 * render that same function's output** — deliberately, so that one outage is not described two ways
 * at the same person (`ProjectScreen.svelte` and the viewer's `+page.svelte` both say so at their
 * call sites). A contract between two applications is only real if something fails when it breaks.
 *
 * It was not. The viewer spec pinned the whole sentence; `editor-base-map.e2e.ts` pinned four
 * fragments of it — so replacing the editor's `{unavailableNotice}` with an inlined sentence
 * containing those four fragments left the entire repository green, and the editor is the side that
 * would drift, because it is the side with more notices around it to be tempted into rewording.
 *
 * So: one expected string, built here, asserted with `toHaveText` (never `toContainText`) on both
 * sides. A **function** rather than a constant because the two specs legitimately render different
 * Base Maps — the editor seeds no author default and gets “Streets”, the viewer asks for “Physical
 * geography” — and a constant would have forced one of them to stop asserting the label.
 *
 * ⚠ **What this pins is "both render the same text", not "both call core".** An application that
 * inlined this sentence *verbatim* still passes, and that is the right boundary for a browser test:
 * it asserts what a scholar reads. What it catches is the thing that actually happens — one side
 * being reworded on its own — and it catches it from either direction, since the expectation lives
 * in neither spec.
 *
 * ⚠ **Deliberately duplicated from core rather than imported.** This suite's tsconfig covers only
 * `e2e/`, and resolves nothing from `@ballastella/core`; `support/editor-deployment.ts` explains the
 * arrangement at length. The duplication is safe in the direction that matters — a change to core's
 * wording that is not made here turns both specs red rather than passing quietly.
 *
 * Only the `needsNetwork` remedy is written out, because every entry in this deployment's catalog
 * has a remote archive and no spec can produce the other branch. `resolve.test.ts` covers the
 * site-served wording at the unit seam, where an entry can be invented.
 *
 * @param label the Base Map entry's label, as the switcher shows it
 * @param host the host the archive is fetched from
 */
export function unavailableNotice(label: string, host: string): string {
	return (
		`The Base Map “${label}” could not be loaded from ${host}. ` +
		'Nothing in your Workspace is affected — your Map Images, their Alignments and your ' +
		'Annotations are all still here and still saving, and they will draw over the geography ' +
		'again as soon as a Base Map does. ' +
		'This Base Map is fetched from another server, so this is usually that server rather ' +
		'than your connection. Try another Base Map, or make this Project available offline ' +
		'while one is working so it keeps drawing when none is.'
	);
}
