// Which side of the synchronization contract a repository or Workspace path is on (ADR-0033).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE CLASSIFIER, BECAUSE THREE ANSWERS WERE BEING GIVEN IN FOUR PLACES
//
// A Publish asked "is this mine to overwrite?", a Clone asked "is this mine to download?", and
// nothing asked "is this scholarship or is it a rebuilt viewer?" — so `_app/**` counted as
// Workspace content, which is the same question with the worst possible answer once Update exists.
// Two editor versions synchronizing would then trade obsolete bundles forever, each side seeing the
// other's chunk names as inbound change (SPEC stories 120, 166).
//
// So the rules live here once and callers ask rather than restate. A path is exactly one of three
// things:
//
//   source              Scholarship, and the only thing a status or a transfer compares. Projects
//                       and their Annotations, Workspace Map Images, Offline Copies, Alignments,
//                       and cached Base Map tiles.
//   published-output    What a Publish generates. It may be stale — a site written by another
//                       editor version is — but staleness is a Published Site fact, never source
//                       drift and never a Conflict, and Update never downloads it.
//   outside-ballastella Somebody else's file in the same repository: a README, a LICENSE, a CNAME,
//                       a workflow, a submodule, a `docs/` folder. Preserved, never owned.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `base-map/` IS SPLIT, AND THAT IS THE ONE RULE THAT LOOKS LIKE A MISTAKE
//
// `VIEWER_FILE_PATHS` claims the whole directory, because its glyphs, sprites and extract are
// written by every publish. But ADR-0025 put the opt-in offline tile cache inside it, and those
// bytes are the author's own decision to make a Project work without a network. Treating them as
// generated output would let an Update delete every cached tile as obsolete viewer machinery, so
// `base-map/tiles/**` is source and everything else under `base-map/` is not.

import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { BASE_MAP_TILE_ROOT } from '../base-map/tile-cache.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { topLevelSegment } from '../store/project-store.js';
import { isViewerFile } from '../transfer/viewer-files.js';
import { REMOTE_BINDING_PATH } from './remote-binding.js';

/** What a path is, to synchronization. See this module's header. */
export type PathClass = 'source' | 'published-output' | 'outside-ballastella';

/** The Workspace directories that are source whatever Projects exist. */
const SOURCE_DIRECTORIES = [`${IMAGE_DIRECTORY}/`, `${ALIGNMENT_DIRECTORY}/`];

/**
 * Every top-level directory the given paths hold a `project.json` directly inside.
 *
 * One inventory at a time, so the caller decides which inventories to take the union of — see
 * {@link recognisedProjectDirectories}, and the reason it matters.
 */
export function projectDirectories(paths: Iterable<string>): Set<string> {
	const directories = new Set<string>();
	for (const path of paths) {
		const [directory, name, ...deeper] = path.split('/');
		if (directory !== undefined && name === PROJECT_FILE_NAME && deeper.length === 0) {
			directories.add(directory);
		}
	}
	return directories;
}

/** The three inventories a Project directory can be recognised from. */
export type PathInventories = {
	/** What the Workspace holds now. */
	readonly local?: Iterable<string>;
	/** What the Remote's tree holds now. */
	readonly remote?: Iterable<string>;
	/** What the Synchronization Baseline records the two sides last shared. */
	readonly baseline?: Iterable<string>;
};

/**
 * Every directory any of the three inventories recognises as a Project.
 *
 * ⚠ **The union rather than any one side, and each of the three is load-bearing.** *Local* is the
 * obvious one. *Remote* is what lets a Project deleted here be recognised as ours and removed there
 * with its pyramid: it is gone locally, so only the Remote can still say it was a Project —
 * ADR-0033's "additive only" leak arrives through that back door. *Baseline* covers the path both
 * live sides have already lost sight of: a directory deleted on the Remote and locally by different
 * operations still has files under it that are ours to finish deleting.
 *
 * The union is also what Project Import allocates directory names against (SPEC story 143), so an
 * imported Project cannot be given a name that a Remote nobody has looked at is already using.
 *
 * **A recognised directory stays source-owned for its whole subtree**, `project.json` gone or not,
 * until synchronization establishes that the directory is completely deleted everywhere.
 */
export function recognisedProjectDirectories(inventories: PathInventories): Set<string> {
	const directories = new Set<string>();
	for (const paths of [inventories.local, inventories.remote, inventories.baseline]) {
		if (paths === undefined) continue;
		for (const directory of projectDirectories(paths)) directories.add(directory);
	}
	return directories;
}

/**
 * Which of the three a path is, given the recognised Project directories.
 *
 * ⚠ **`remote.json` is published output, and it is the one entry here that has to be argued for.**
 * It is no longer the Remote relationship — that is installation-local metadata now — but a Publish
 * still writes it so an old Published Site's return links keep working, and an unbound Workspace
 * must not leave a stale one on the Remote. Publish-owned is exactly that: ours to write and ours to
 * remove, never inbound, and never authored local state a synchronization could resurrect.
 */
export function classifyPath(path: string, projects: ReadonlySet<string>): PathClass {
	// Before `isViewerFile`, which claims the whole of `base-map/`. See this module's header.
	if (path.startsWith(BASE_MAP_TILE_ROOT)) return 'source';
	if (isViewerFile(path)) return 'published-output';
	if (path === REMOTE_BINDING_PATH) return 'published-output';
	if (SOURCE_DIRECTORIES.some((directory) => path.startsWith(directory))) return 'source';
	// A top-level *file* is never a Project's, whatever it is called: `listProjects` matches only
	// `<directory>/project.json`.
	if (path.includes('/') && projects.has(topLevelSegment(path))) return 'source';
	return 'outside-ballastella';
}

/**
 * Whether a path is inside Ballastella's namespace at all — source or published output.
 *
 * The exact-mirror boundary of ADR-0033: inside it a Publish makes the Remote be the Workspace, and
 * outside it nothing is touched, which is why a scholar's `CNAME` survives. Publish over it once and
 * their cited address quietly moves back to a `github.io` URL, and the next publish does it again
 * after they fix it.
 *
 * ⚠ **A Clone reads exactly this rule, and there is deliberately no second copy of it.** The two
 * halves have to agree or the namespace leaks: a Clone that brought down a path this excludes would
 * make it Workspace content, and the next publish from that Workspace would push somebody else's
 * `README.md` and workflows into the cloner's own repository as though the cloner had written them.
 */
export const isOwnedPath = (path: string, projects: ReadonlySet<string>): boolean =>
	classifyPath(path, projects) !== 'outside-ballastella';

/** One inventory, split three ways. Entries are carried through whole and in the order given. */
export type ClassifiedInventory<E> = {
	/** Scholarship: the only bucket a status or a transfer compares. */
	readonly source: readonly E[];
	/** What a Publish generates here. Compared only to decide whether the site needs republishing. */
	readonly publishedOutput: readonly E[];
	/** Somebody else's files in the same repository. Preserved, and never transferred either way. */
	readonly outside: readonly E[];
};

/**
 * Split an inventory by {@link classifyPath}, keeping whatever evidence each entry arrived with.
 *
 * Generic over the entry rather than over paths, because the two sides bring different evidence: a
 * Remote tree entry carries a blob SHA and a mode, and a `list` of the Workspace carries a path and
 * nothing else. A planner that had to re-associate paths with their SHAs afterwards is a planner with
 * a second place to get the association wrong.
 */
export function classifyInventory<E extends { readonly path: string }>(
	entries: Iterable<E>,
	projects: ReadonlySet<string>
): ClassifiedInventory<E> {
	const source: E[] = [];
	const publishedOutput: E[] = [];
	const outside: E[] = [];
	for (const entry of entries) {
		const bucket = classifyPath(entry.path, projects);
		if (bucket === 'source') source.push(entry);
		else if (bucket === 'published-output') publishedOutput.push(entry);
		else outside.push(entry);
	}
	return { source, publishedOutput, outside };
}

/**
 * Where two sides' Publish-owned output disagrees: the paths, sorted, or empty for none.
 *
 * **This is Published Site staleness and nothing else** (SPEC story 120). A viewer built by another
 * editor version has different chunk names, so this list is routinely long and routinely means only
 * "republish when you like". It is deliberately not a Conflict, not inbound change, and not part of
 * any source comparison: the two sides never have to agree here, and an Update that tried to make
 * them agree would trade obsolete `_app` bundles forever.
 *
 * Both sides are the {@link ClassifiedInventory.publishedOutput} bucket, so the caller cannot
 * accidentally hand this a Project.
 */
export function publishedOutputDrift(
	local: Iterable<{ readonly path: string; readonly sha: string }>,
	remote: Iterable<{ readonly path: string; readonly sha: string }>
): readonly string[] {
	const here = new Map([...local].map((entry) => [entry.path, entry.sha]));
	const drift = new Set<string>();
	for (const entry of remote) {
		if (here.get(entry.path) !== entry.sha) drift.add(entry.path);
		here.delete(entry.path);
	}
	for (const path of here.keys()) drift.add(path);
	return [...drift].sort();
}
