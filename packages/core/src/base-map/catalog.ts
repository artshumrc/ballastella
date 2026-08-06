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
 * The bundled extract, served as a static file from `apps/editor/static/`. One archive, read
 * over HTTP Range requests by the `pmtiles://` protocol — no tile server, no API key, and no
 * per-fork registration (ADR-0005, SPEC story 101).
 *
 * Three of the four entries below name this one archive. They differ only in the style
 * document built over it, which is the whole zero-extra-data claim.
 */
const BUNDLED_ARCHIVE = 'base-map/amsterdam-centre.pmtiles';

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
 * change to this line and nothing else (ADR-0020). It is here because a `needsNetwork: true` entry
 * has to exist for the switcher's marking to mean anything and for ticket 17 to have something to
 * assert, and a keyless one is the only kind a fork inherits without setup.
 */
const REMOTE_ARCHIVE = 'https://demo-bucket.protomaps.com/v4.pmtiles';

export const BASE_MAP_CATALOG: BaseMapCatalog = {
	entries: [
		{
			id: 'streets',
			label: 'Streets',
			needsNetwork: false,
			archive: BUNDLED_ARCHIVE,
			emphasis: 'streets-and-labels',
			flavor: { light: 'light', dark: 'dark' }
		},
		{
			id: 'physical',
			label: 'Physical geography',
			needsNetwork: false,
			archive: BUNDLED_ARCHIVE,
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
			needsNetwork: false,
			archive: BUNDLED_ARCHIVE,
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
	// Central Amsterdam, inside the bundled extract's bounds. A deployment whose default view
	// falls outside its bundled archive renders a plausible-looking empty map.
	initialView: { center: [4.9041, 52.3676], zoom: 13 },
	glyphs: 'base-map/fonts/{fontstack}/{range}.pbf',
	sprite: 'base-map/sprites/{flavor}',
	attribution:
		'<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> · ' +
		'<a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a>'
};
