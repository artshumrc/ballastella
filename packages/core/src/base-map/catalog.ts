import type { BaseMapCatalog } from './entry';

// ┌───────────────────────────────────────────────────────────────────────────────────────┐
// │ THE BASE MAP CATALOG. This module is deployment configuration (ADR-0020).             │
// │                                                                                       │
// │ Adding, removing, relabelling, or repointing an entry must require **no change**       │
// │ anywhere else in the repository. That property is what a forker pointing at their own  │
// │ tiles depends on (SPEC story 100), and it is asserted rather than intended:            │
// │                                                                                       │
// │   - `scripts/check-base-map-catalog.mjs` fails `pnpm lint` if any other module names   │
// │     an entry id or an archive from this file.                                          │
// │   - `resolve.test.ts` and `style.test.ts` drive every base-map function from fixture   │
// │     catalogs with entirely different entries.                                          │
// │                                                                                       │
// │ So: change this file, and nothing else.                                               │
// └───────────────────────────────────────────────────────────────────────────────────────┘

/**
 * Protomaps' public **demo** planet. Keyless, so it costs no secret and breaks no fork — but it
 * is a network dependency, which is what `needsNetwork` exists to say out loud.
 *
 * **Provenance and terms.** This is the bucket Protomaps publishes for trying the format out. Its
 * data is OpenStreetMap under ODbL 1.0, carried by the `attribution` below; the *hosting* is
 * Protomaps' goodwill, with no published rate limit, uptime promise, or terms of use, and every
 * fork's users reach it by default because it is in this deployment's catalog. Nothing about it is
 * suitable to rely on. A deployment that wants worldwide coverage should point this entry at its
 * own archive — a Protomaps API key, a bucket of its own, or a self-hosted extract — which is a
 * change to this line and nothing else (ADR-0020).
 *
 * This educational development deployment has no hosting budget, so the maintainer explicitly
 * accepted this URL for evaluation only. `pnpm check:deployment` refuses it: production must point
 * this constant at an archive that deployment controls (ADR-0025, ticket 10).
 */
const REMOTE_ARCHIVE = 'https://demo-bucket.protomaps.com/v4.pmtiles';

export const BASE_MAP_CATALOG: BaseMapCatalog = {
	entries: [
		{
			id: 'streets',
			label: 'Streets',
			needsNetwork: true,
			archive: REMOTE_ARCHIVE,
			emphasis: 'streets-and-labels',
			flavor: { light: 'light', dark: 'dark' }
		},
		{
			id: 'physical',
			label: 'Physical geography',
			needsNetwork: true,
			archive: REMOTE_ARCHIVE,
			emphasis: 'water-and-terrain',
			flavor: { light: 'light', dark: 'dark' }
		},
		{
			// SPEC story 98: a low-vision Reader must be able to pick a muted Base Map so that
			// annotations stay legible over it. Ticket 17 asserts that selection in the published
			// viewer, and it cannot pass without an entry here — so this is not a nicety. It is
			// one more style document over the same archive and costs nothing.
			id: 'muted',
			label: 'Muted, high contrast',
			needsNetwork: true,
			archive: REMOTE_ARCHIVE,
			emphasis: 'streets-and-labels',
			flavor: { light: 'grayscale', dark: 'black' }
		},
		{
			id: 'streets-worldwide',
			label: 'Streets, worldwide',
			needsNetwork: true,
			archive: REMOTE_ARCHIVE,
			emphasis: 'streets-and-labels',
			flavor: { light: 'light', dark: 'dark' }
		}
	],
	defaultId: 'streets',
	// The deliberate fallback for a Project with nothing placed on the earth (ADR-0026).
	initialView: { center: [4.9041, 52.3676], zoom: 13 },
	glyphs: 'base-map/fonts/{fontstack}/{range}.pbf',
	sprite: 'base-map/sprites/{flavor}',
	attribution:
		'<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> · ' +
		'<a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a>'
};
