import type { BaseMapCatalog } from './entry';

// ┌───────────────────────────────────────────────────────────────────────────────────────┐
// │ THE BASE MAP CATALOG. This module is deployment configuration (ADR-0020).             │
// │                                                                                       │
// │ Adding, removing, relabelling, or repointing an entry must require **no change**       │
// │ anywhere else in the repository. That property is what a forker pointing at their own  │
// │ tiles depends on, and it is asserted rather than intended:                             │
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
 * **Provenance and terms.** This is Protomaps' daily planet build, mirrored on Source Cooperative
 * (AWS us-west-2). Its data is OpenStreetMap under ODbL 1.0, carried by the `attribution` below.
 * The *hosting* is somebody else's, and Source Cooperative says in as many words: "We don't
 * recommend cross-origin hotlinking directly to source.coop URLs." So this is the same **kind** of
 * dependency as the archive it replaced, and it is chosen with that understood rather than
 * overlooked — see the amendment in ADR-0025 dated 2026-08-10.
 *
 * **Why it replaced `demo-bucket.protomaps.com`.** That bucket now answers `404` for this file, so
 * the Base Map was not degraded but absent: Map Images drew on blank space with nothing on
 * screen saying why. The previous decision — recorded in ADR-0025 as settled — was that the demo
 * tiles stayed. A 404 overtook it.
 *
 * **Two facts measured on 2026-08-10 rather than assumed**, because both fail quietly if wrong:
 * `v4.pmtiles` answers `HTTP 206` to a range request with `access-control-allow-origin: *` and
 * `access-control-expose-headers: *`, so a browser can read it cross-origin; and the sibling
 * `v3.pmtiles` is a `404`, so v4 is not a preference here but the only file there. v4 is also what
 * `@protomaps/basemaps@5` styles are built against — a v3 tileset under a v5 style is the silent
 * failure ADR-0025 warns about, a plausible-looking pane of the wrong world.
 *
 * A deployment that wants worldwide coverage it controls should point this entry at its own archive
 * — a bucket of its own or a self-hosted extract — which is a change to this line and nothing else
 * (ADR-0020). `pnpm check:deployment` refuses this host for exactly that reason: production must
 * point this constant at an archive that deployment controls (ADR-0025).
 */
const REMOTE_ARCHIVE = 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles';

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
			// A low-vision Reader must be able to pick a muted Base Map so that annotations stay
			// legible over it. `e2e/viewer-reader.e2e.ts` asserts that selection in the published
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
