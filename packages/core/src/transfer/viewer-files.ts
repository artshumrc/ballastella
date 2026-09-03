// The enumerable, recorded set of files a Published Site is made of, so the data-only zip can leave them out —
// and so that a Sync can tell what to remove when Share Links are withdrawn (ADR-0045).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THE LIST LIVES HERE RATHER THAN BESIDE THE SITE WRITE
//
// Three callers need it and they are at opposite ends of the codebase: `export-project-bundle.ts`
// and `export-workspace-tar.ts`, to hand a colleague or a librarian clean data, and
// `published-site/published-site.ts`, which writes exactly these paths. Put in
// the site module it would be reached through the Project bundle exporter, which the barrel exports and
// `apps/viewer` therefore imports wholesale — dragging the site-writing machinery into every Published
// Site's bundle for the sake of one array of strings (ADR-0019). So the names live in this leaf
// module, which imports nothing, and the site write imports them.
//
// The shared bundle lives at the **Workspace** rather than inside each Project (ADR-0008), so these
// paths are relative to the Workspace. That has a consequence worth stating,
// because it looks like a gap otherwise: a Project-rooted export never walks the Workspace, so on
// an ordinary Workspace these files are already outside every archive. What `isViewerFile` still
// does is refuse them from a Project directory that *does* hold them — the shape a Project has when
// somebody unpacks a Published Site into one, or copies a site's folder in to work on it, which
// is exactly the case ADR-0045's "the two export flavours are indistinguishable" warns about.

/** The site record's own name, at the Workspace (ADR-0008). */
export const PUBLISHED_SITE_RECORD_NAME = 'ballastella-site.json';

/**
 * Where the viewer's own directory of hashed assets goes. SvelteKit's `appDir`, and the one
 * directory name a Published Site claims for machinery rather than for content.
 */
export const PUBLISHED_APP_DIRECTORY = '_app/';

/**
 * The empty file that turns GitHub Pages' Jekyll build off, so that {@link PUBLISHED_APP_DIRECTORY}
 * is served rather than excluded for beginning with `_`.
 *
 * A constant because two very different places need the same string — this list, and `writePublishedSite`,
 * which writes the file — and because `scripts/check-nojekyll.mjs` reads it out of here rather than
 * spelling it a third time.
 */
export const JEKYLL_OFF_MARKER = '.nojekyll';

/**
 * Paths a Published Site is made of, relative to the directory it is written into. A trailing `/` means a
 * whole directory.
 *
 * **A fixed list rather than whatever a particular bundle happens to contain**, because the
 * question it answers — "is this file mine or the user's?" — has to be answerable about a Workspace
 * this build did not write: one written by a newer viewer with different chunk names in it, or
 * one whose bundle has since been deleted. The hashed names inside `_app/` are therefore not
 * enumerated one by one; the directory is claimed instead.
 *
 * `published-site.test.ts` asserts this list against what `writePublishedSite` actually wrote, so a file added to
 * the site without being recorded here fails a test rather than escaping into a data archive.
 */
export const VIEWER_FILE_PATHS: readonly string[] = [
	PUBLISHED_APP_DIRECTORY,
	PUBLISHED_SITE_RECORD_NAME,
	// GitHub Pages' Jekyll build excludes every path beginning with `_`, and
	// `PUBLISHED_APP_DIRECTORY` is `_app/` — so without this file a Workspace pushed to a
	// branch-deployed Pages site serves `index.html` and 404s every script and stylesheet it asks
	// for. The Reader gets a blank page and the browser console is the only place that says why.
	//
	// **It is the author's own repository that needs it, which is why it is written rather than
	// merely built.** A fork deployed through `.github/workflows/pages.yml` never meets Jekyll at
	// all; the scholar pushing a Workspace by hand, which is the flow the hosting guide describes,
	// is the one this protects — and that repository holds no workflow of ours to protect them with.
	//
	// **`writePublishedSite` authors it, like the site record and unlike every other path here** — see the
	// empty-marker note there. It is not in the viewer's build and must not be: an empty file
	// fetched over HTTP makes the site write depend on the *authoring* host serving a dotfile, and
	// plenty do not.
	JEKYLL_OFF_MARKER,
	// The Base Map's glyphs and sprites, written with every Published Site. Recorded whether or not
	// this Workspace has them, for the same reason `_app/` is recorded as a directory; legacy sites
	// may still carry no display assets.
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

/** Whether a Project-relative path is something the site write wrote rather than the user's data. */
export const isViewerFile = createViewerFileFilter(VIEWER_FILE_PATHS);

/**
 * Whether a top-level name in a Workspace is one a Published Site claims.
 *
 * Asked of Project *directory* names before the site write puts anything there: a Project that happens to
 * live in a folder called `index.html` or `base-map` would be overwritten by the site, and
 * the site write refuses instead (see `writePublishedSite`).
 */
export const claimedByPublishedSite = (name: string): boolean =>
	VIEWER_FILE_PATHS.some((path) => (path.endsWith('/') ? path.slice(0, -1) : path) === name);

/**
 * Whether an inventory carries a Published Site — which is what having **Share Links** means
 * (ADR-0045).
 *
 * ⚠ **Observed from the bytes, never stored.** A Workspace has Share Links when the files are there,
 * so there is no flag to disagree with them: the tree listing a Sync already fetches answers the
 * question, and a Workspace and its Remote can each be asked the same way. This is the `imageMode`
 * precedent (ADR-0023) — a stored claim can be wrong about the files, a derived one cannot.
 *
 * ⚠ **The site record and nothing else, though the whole set is what the answer is about.** Two of
 * the recorded paths are evidence of nothing: `base-map/` holds the opt-in offline tile cache of a
 * Workspace with no site in it, and {@link JEKYLL_OFF_MARKER} is written into a
 * repository that has to be seeded before it has a branch (ADR-0045). {@link
 * PUBLISHED_SITE_RECORD_NAME} is written by `writePublishedSite` and by nothing else, and it is the file a
 * Reader's first request resolves through — so its presence is exactly the claim being made.
 */
export const carriesPublishedSite = (paths: Iterable<string>): boolean => {
	for (const path of paths) if (path === PUBLISHED_SITE_RECORD_NAME) return true;
	return false;
};

/** What a surface outside a Sync has in hand when it asks whether a Workspace has Share Links. */
export interface ShareLinksEvidence {
	/** Whether this Workspace's own tree carries the site record. */
	readonly workspace: boolean;
	/** Whether the Remote's tree carried it at the last status check that could look. */
	readonly remote: boolean;
	/** Whether the author has asked for the site to come down and no Sync has carried it out. */
	readonly withdrawing: boolean;
}

/**
 * Whether a Workspace has **Share Links**, answered outside a Sync from evidence in hand (ADR-0045).
 *
 * ⚠ **Either side's tree, which is the same rule `planRemoteSend` sends on.** A get brings the
 * source namespace and nothing else, so between a get and the first send the Workspace holds no
 * viewer files while the Remote it got them from serves a site — and a surface answering from the
 * Workspace alone tells that author their address answers nothing, offers to set up what already
 * exists, and puts withdrawal out of reach. The Remote's half is what a status check has already
 * listed, so this costs no request of its own; before any check could look it is `false`, which
 * leaves the local answer standing rather than claiming a site nothing has seen.
 *
 * ⚠ **Withdrawal is the one thing the trees cannot say.** A Workspace the author withdrew from and
 * a Workspace just got from a Remote that has a site hold the same bytes on both sides, because the
 * Remote's copy goes on the next Sync. The recorded request is what separates them, and it is read
 * here for the same reason a send reads it first.
 */
export const observedShareLinks = (evidence: ShareLinksEvidence): boolean =>
	!evidence.withdrawing && (evidence.workspace || evidence.remote);
