// The enumerable, recorded set of files publishing writes, so the data-only zip can leave them
// out (ADR-0006).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THE LIST LIVES HERE RATHER THAN BESIDE THE REST OF PUBLISHING
//
// Two callers need it and they are at opposite ends of the codebase: `export-project-zip.ts`, to
// hand a librarian clean data, and `publish/publish.ts`, which writes exactly these paths. Put in
// the publish module it would be reached through the Project bundle exporter, which the barrel exports and
// `apps/viewer` therefore imports wholesale — dragging the publish machinery into every Published
// Site's bundle for the sake of one array of strings (ADR-0019). So the names live in this leaf
// module, which imports nothing, and publishing imports them.
//
// ADR-0008 amended ADR-0006: the shared bundle lives at the **Workspace** rather than inside each
// Project, so these paths are relative to the Workspace. That has a consequence worth stating,
// because it looks like a gap otherwise: a Project-rooted export never walks the Workspace, so on
// an ordinary Workspace these files are already outside every archive. What `isViewerFile` still
// does is refuse them from a Project directory that *does* hold them — the shape a Project has when
// somebody unpacks a Published Site into one, or copies a published folder in to work on it, which
// is exactly the case ADR-0006's "the two export flavours are indistinguishable" warns about.

/** The site record's own name, at the Workspace (ADR-0008). */
export const PUBLISHED_SITE_RECORD_NAME = 'ballastella-site.json';

/**
 * Where the viewer's own directory of hashed assets goes. SvelteKit's `appDir`, and the one
 * directory name publishing claims for machinery rather than for content.
 */
export const PUBLISHED_APP_DIRECTORY = '_app/';

/**
 * Paths publishing writes, relative to the directory it publishes into. A trailing `/` means a
 * whole directory.
 *
 * **A fixed list rather than whatever a particular bundle happens to contain**, because the
 * question it answers — "is this file mine or the user's?" — has to be answerable about a Workspace
 * this build did not publish: one published by a newer viewer with different chunk names in it, or
 * one whose bundle has since been deleted. The hashed names inside `_app/` are therefore not
 * enumerated one by one; the directory is claimed instead.
 *
 * `publish.test.ts` asserts this list against what `publishSite` actually wrote, so a file added to
 * the site without being recorded here fails a test rather than escaping into a data archive.
 */
export const VIEWER_FILE_PATHS: readonly string[] = [
	PUBLISHED_APP_DIRECTORY,
	PUBLISHED_SITE_RECORD_NAME,
	// The Base Map extract, its glyphs, and its sprites, written only for a site that has to work
	// with no network at all (ADR-0020, SPEC story 88). Recorded whether or not this Workspace has
	// them, for the same reason `_app/` is recorded as a directory.
	'base-map/',
	'index.html',
	'robots.txt'
];

/**
 * A predicate over Project-relative paths, from a recorded list.
 *
 * Separate from {@link isViewerFile} so the matching itself is testable independently of the list
 * the application uses.
 */
export function createViewerFileFilter(paths: Iterable<string>): (relativePath: string) => boolean {
	const exact = new Set<string>();
	const directories: string[] = [];
	for (const path of paths) {
		if (path.endsWith('/')) directories.push(path);
		else exact.add(path);
	}
	return (relativePath) =>
		exact.has(relativePath) || directories.some((prefix) => relativePath.startsWith(prefix));
}

/** Whether a Project-relative path is something publishing wrote rather than the user's data. */
export const isViewerFile = createViewerFileFilter(VIEWER_FILE_PATHS);

/**
 * Whether a top-level name in a Workspace is one publishing claims.
 *
 * Asked of Project *directory* names before publishing writes anything: a Project that happens to
 * live in a folder called `index.html` or `base-map` would be overwritten by the site, and
 * publishing refuses instead (see `publishSite`).
 */
export const claimedByPublishing = (name: string): boolean =>
	VIEWER_FILE_PATHS.some((path) => (path.endsWith('/') ? path.slice(0, -1) : path) === name);
