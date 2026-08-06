import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveDirectory, type StaticSite } from './static-site.js';

// A Published Site on disk, assembled from the **real built viewer** plus Project data, so that the
// Reader's experience can be driven at a domain root and in a subdirectory.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS ASSEMBLES A SITE RATHER THAN PUBLISHING ONE THROUGH THE EDITOR
//
// `e2e/editor-publish.e2e.ts` already drives publishing end to end — through the dialog, out of OPFS,
// onto disk, and served at two base paths — and that is where "publishing produces a working site"
// belongs. What ticket 17 needs is the *other* half: a great many Reader behaviours over a Project with
// several Layers, an unreachable host, a newer `formatVersion`, an XSS payload, and a 375 px viewport.
// Going through the editor's UI for each of those would put OPFS seeding, a Publish dialog, and a
// 30-second bundle write in front of every assertion, on a suite already at its contention ceiling.
//
// So the bytes come from where publishing gets them: `apps/viewer/build` — the same directory
// `scripts/stage-viewer-bundle.mjs` copies and `publishSite` writes — plus the same `base-map/` assets,
// plus a `ballastella-site.json` of the same shape `serialisePublishedSite` writes. Nothing here
// reimplements the *viewer*, which is the thing under test; what it stands in for is the copying.
//
// `serveDirectory` is ticket 16's, unchanged, and for its own reason: it is deliberately dumb — no
// rewriting, no SPA fallback, no index-guessing beyond a trailing slash — because a static host does
// none of those, and a server cleverer than GitHub Pages would hide exactly the failure being looked
// for. Ticket 16 mutation-verified that **the subdirectory is the load-bearing half**: pointing data
// reads at `/` instead of at the document leaves the root site green and only the subdirectory red.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viewerBuild = path.join(repoRoot, 'apps/viewer/build');
const baseMapAssets = path.join(repoRoot, 'apps/editor/static/base-map');

/** The two base paths every Reader assertion runs at. `''` is a domain root. */
export const SITE_PREFIXES = ['', '/student/atlas-2026'] as const;

export type SiteFiles = Record<string, string | Uint8Array>;

/**
 * A Workspace directory holding the built viewer, `files`, and — unless asked otherwise — the Base Map's
 * own files.
 *
 * The Base Map is copied by default because ADR-0020's self-contained site is the case a Reader on a
 * train has, and because without the archive the reference map is blank, which would make every "is the
 * Layer drawn?" assertion a test of nothing.
 *
 * `withoutBaseMap` is the **other** supported state and not a broken one: including those 4.9 MB is opt-in
 * at publish time (SPEC stories 88 and 89), so a great many real sites will not have them. A bundled
 * catalog entry's archive, glyphs, and sprites are all site-relative paths, so this is the shape in which
 * a viewer that asked for them anyway would answer a Reader with three 404s and a blank rectangle.
 */
export async function writePublishedSite(
	files: SiteFiles,
	options: { withoutBaseMap?: boolean } = {}
): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'ballastella-site-'));
	await cp(viewerBuild, directory, { recursive: true });
	if (!options.withoutBaseMap) {
		await cp(baseMapAssets, path.join(directory, 'base-map'), { recursive: true });
	}
	for (const [relative, contents] of Object.entries(files)) {
		const file = path.join(directory, relative);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, contents);
	}
	return directory;
}

/**
 * The site record publishing writes: the Project list, the viewer stamp, and — where a test supplies
 * one — the Base Map catalog that travels with the site (ADR-0020).
 *
 * **No catalog by default, and that is deliberate on two counts.** `parsePublishedSite` treats a record
 * with no usable `baseMap` as ADR-0020's own fallback case and uses the reading build's catalog, which
 * is exactly what a site published *by this build* carries — so the default record drives the viewer
 * with the same entries a real one would. And naming an entry id in this module would break
 * `scripts/check-base-map-catalog.mjs`, which exempts `*.e2e.ts` but not its support files, for the good
 * reason that a fork repointing its catalog must not have to edit the harness.
 *
 * A test that wants to prove the *record* is what drives the switcher passes its own catalog through
 * `overrides` — see `viewer-reader.e2e.ts`, which supplies one naming an entry this build does not have.
 */
export function siteRecord(
	projects: readonly { directory: string; name: string }[],
	overrides: Record<string, unknown> = {}
): string {
	return `${JSON.stringify(
		{
			formatVersion: 1,
			viewerVersion: 'test-viewer',
			publishedAt: '2026-08-06T00:00:00.000Z',
			projects: [...projects],
			baseMapBundled: true,
			...overrides
		},
		null,
		'\t'
	)}\n`;
}

/** A tab-indented JSON document, matching every file this project writes. */
export const asJson = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`;

/**
 * One published site, served at both base paths from **one directory**, and the way to take it down.
 *
 * The same directory behind both, so this cannot accidentally become a test of two builds.
 */
export async function servePublishedSite(
	files: SiteFiles,
	options: { withoutBaseMap?: boolean } = {}
): Promise<{
	directory: string;
	sites: StaticSite[];
	close(): Promise<void>;
}> {
	const directory = await writePublishedSite(files, options);
	const sites = await Promise.all(SITE_PREFIXES.map((prefix) => serveDirectory(directory, prefix)));
	return {
		directory,
		sites,
		close: async () => {
			await Promise.all(sites.map((site) => site.close()));
			await rm(directory, { recursive: true, force: true });
		}
	};
}

/**
 * A real, decodable JPEG for a pyramid's tiles: one baseline 8 × 8 block.
 *
 * **Real bytes rather than a string standing in for a tile**, because a tile that will not decode is the
 * failure ticket 06 spent a patch on — `@allmaps/render` logs and swallows it — so the map renders blank
 * and any assertion short of "did bytes reach the tile cache?" goes green. Written inline rather than
 * read from a fixture file so this helper has nothing to keep in sync.
 */
export function tileJpeg(): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
		0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
		0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
		0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
		0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
		0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08,
		0x00, 0x08, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
		0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
		0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
		0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
		0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
		0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
		0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
		0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
		0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
		0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
		0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
		0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
		0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
		0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda,
		0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xf7, 0xfa, 0x28, 0xa2, 0x8a, 0xff, 0xd9
	]);
}

/** The bytes of a file inside an assembled site, for assertions about what was and was not written. */
export const readSiteFile = (directory: string, relative: string): Promise<Buffer> =>
	readFile(path.join(directory, relative));

/**
 * Replace a file inside an already-served site.
 *
 * `serveDirectory` reads from disk per request and caches nothing, exactly as a static host does, so this
 * takes effect on the next request with no restart. It exists because one thing a Reader test needs to
 * write can only be written **after** the site has an address: the canonical stamp `stampCanonicalUrl`
 * puts in a pyramid's `info.json` is the address the Workspace is published at (SPEC story 92), and the
 * harness cannot know a port it has not yet been given.
 */
export async function writeSiteFile(
	directory: string,
	relative: string,
	contents: string | Uint8Array
): Promise<void> {
	const file = path.join(directory, relative);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, contents);
}
