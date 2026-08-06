// The enumerable, recorded set of files publishing writes, so the data-only zip can leave them
// out (ADR-0006).
//
// The list is **empty until ticket 16**, which is the ticket that writes those files and is
// therefore the only ticket that can enumerate them. The mechanism has to exist now regardless:
// ADR-0006 is explicit that without a recorded list the two export flavours — "the data" and
// "the data plus a website" — are indistinguishable, and a list that is discovered afterwards is
// discovered by a user finding a viewer bundle inside the zip they deposited in a repository.

/**
 * Paths publishing writes, relative to the directory it publishes into. A trailing `/` means a
 * whole directory.
 *
 * Empty by design, not by omission: ticket 16 populates it. Note that ADR-0008 amended ADR-0006
 * so the shared bundle lives at the *workspace* root rather than inside each Project — a
 * Project-rooted export never walks the workspace root, so those files are already out. This
 * list is for whatever ticket 16 writes *inside* a Project directory, such as a per-Project
 * `index.html`.
 */
export const VIEWER_FILE_PATHS: readonly string[] = [];

/**
 * A predicate over Project-relative paths, from a recorded list.
 *
 * Separate from {@link isViewerFile} so the matching itself is testable while the real list is
 * still empty. Ticket 16 changes one array and inherits the tests.
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
