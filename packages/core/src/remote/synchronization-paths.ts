import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { BASE_MAP_TILE_ROOT } from '../base-map/tile-cache.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { topLevelSegment } from '../store/project-store.js';
import { isViewerFile } from '../transfer/viewer-files.js';

export const byPath = (
	left: { readonly path: string },
	right: { readonly path: string }
): number => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

export type PathClass = 'source' | 'published-output' | 'outside-ballastella';

const SOURCE_DIRECTORIES = [`${IMAGE_DIRECTORY}/`, `${ALIGNMENT_DIRECTORY}/`];

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

type PathInventories = {
	readonly local?: Iterable<string>;
	readonly remote?: Iterable<string>;
	readonly baseline?: Iterable<string>;
};

export function recognisedProjectDirectories(inventories: PathInventories): Set<string> {
	const directories = new Set<string>();
	for (const paths of [inventories.local, inventories.remote, inventories.baseline]) {
		if (paths === undefined) continue;
		for (const directory of projectDirectories(paths)) directories.add(directory);
	}
	return directories;
}

export function classifyPath(path: string, projects: ReadonlySet<string>): PathClass {
	if (path.startsWith(BASE_MAP_TILE_ROOT)) return 'source';
	if (isViewerFile(path)) return 'published-output';
	if (SOURCE_DIRECTORIES.some((directory) => path.startsWith(directory))) return 'source';
	if (path.includes('/') && projects.has(topLevelSegment(path))) return 'source';
	return 'outside-ballastella';
}

export const isOwnedPath = (
	path: string,
	projects: ReadonlySet<string>,
	shareLinks: boolean
): boolean => {
	const bucket = classifyPath(path, projects);
	return bucket === 'source' || (shareLinks && bucket === 'published-output');
};

type ClassifiedInventory<E> = {
	readonly source: readonly E[];
	readonly publishedOutput: readonly E[];
	readonly outside: readonly E[];
};

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
