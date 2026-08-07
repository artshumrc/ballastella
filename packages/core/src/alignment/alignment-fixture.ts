// Putting an Alignment on disk as a test's *arrange* step (ticket 18).
//
// Not part of the application, and nothing outside a test may import it — the same standing
// `store/project-store-suite.ts` has, and for the same reason: it needs the real types, so it lives
// in `src` beside them rather than in a parallel test tree that would drift.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS RATHER THAN A `store.write` IN EVERY TEST
//
// `alignmentPath` returns an `AlignmentPath`, which `store.write` will not take (ticket 18), so a
// test that needs a file at that path has to spell it out — and then
// `scripts/check-alignment-writers.mjs` asks it, correctly, to say why. Done in each test that
// meant nine near-identical opt-out pragmas across the core suite on the first day, which is heavy
// enough pressure on the mechanism that people start pasting the pragma without reading it. Its
// sibling fence `check-workspace-rooted-paths.mjs` carries four opt-outs in total.
//
// So there is one, here, with the reasoning written once. What a test seeding an Alignment wants is
// almost never an Alignment: it is a file of a known size at a known path, or a specific colleague's
// document to be read back. Neither is a write the application makes, and neither should go through
// `writeAlignmentFile`, which would refuse most of them.

import type { Bytes, ProjectStore } from '../store/project-store.js';

/**
 * Write `bytes` at the Alignment path for `imageId`, bypassing the one writer on purpose.
 *
 * @param bytes the document, or a length — a plain `Uint8Array` of that size, for the tests that
 *   care only what the Workspace's byte total does when the map is deleted.
 */
export function seedAlignmentFixture(
	store: ProjectStore,
	imageId: string,
	bytes: Bytes | number
): Promise<void> {
	const content = typeof bytes === 'number' ? (new Uint8Array(bytes) as Bytes) : bytes;
	// alignment-write-is-the-fixture: the one place a test may put a file at an Alignment's path, so the nine that used to do it themselves now say it once, here
	return store.write(`alignments/${imageId}.json`, content);
}
