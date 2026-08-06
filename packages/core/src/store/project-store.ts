// The one narrow interface every byte of a user's work passes through (ADR-0001).
//
// Paths are opaque strings. The store exposes no handles, no directories, and nothing
// else backend-specific, deliberately: the OPFS adapter was built first so the shape
// could not be bent towards a folder-like backend, and ticket 12's File System Access
// adapter has to fit this interface unchanged.

/** A `/`-separated path relative to the workspace root. Never absolute, never empty. */
export type StorePath = string;

/**
 * File contents as they cross the store boundary.
 *
 * `Uint8Array<ArrayBuffer>` rather than the default `Uint8Array<ArrayBufferLike>`: the write
 * APIs underneath reject a `SharedArrayBuffer`-backed view, and saying so in the type is
 * better than an assertion at every call site. Everything that actually produces bytes here —
 * `new Uint8Array(n)`, `TextEncoder.encode`, `slice`, `arrayBuffer()` — already satisfies it.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface ProjectStore {
	/** The bytes at `path`. Rejects with {@link PathNotFoundError} if there are none. */
	read(path: StorePath): Promise<Bytes>;

	/**
	 * Replace the bytes at `path`, creating it and any missing parents.
	 *
	 * **Atomic** (ADR-0017 rule 4): the bytes land at a temporary path first and are then
	 * renamed over `path`, so an interrupted write leaves the previous contents intact and
	 * parseable rather than truncated. `project.json` holds the layer list — the map of
	 * everything — and is the most frequently written file, so a torn write there is the
	 * worst loss the storage layer can inflict.
	 */
	write(path: StorePath, bytes: Bytes): Promise<void>;

	/**
	 * Every existing file path that begins with `prefix`, sorted. A plain string-prefix
	 * match, so pass a trailing `/` to list a directory's contents. `''` lists everything.
	 *
	 * Rejects when the workspace itself cannot be reached — a normal state the caller is
	 * expected to render, not an unhandled rejection (ADR-0008).
	 */
	list(prefix: string): Promise<StorePath[]>;

	/** Remove `path`. Idempotent: deleting what is not there succeeds. */
	delete(path: StorePath): Promise<void>;

	/**
	 * The byte length of `path`, **without reading it**.
	 *
	 * Tickets 15 and 16 both have to warn about the ~1 GB static-hosting cliff (ADR-0008),
	 * and a multi-gigabyte pyramid is thousands of tile files. Summing sizes by reading each
	 * one would be the slowest possible way to answer a question both real backends answer
	 * for free from directory metadata.
	 */
	size(path: StorePath): Promise<number>;

	/**
	 * Remove every half-finished atomic write under `prefix`.
	 *
	 * A write interrupted between its two steps — a tab that died, a laptop that closed — leaves a
	 * temporary file that **nothing else here can reach**: the suffix is reserved, so `write` and
	 * `delete` refuse it and `list` never reports it. Without this, deleting a Project leaves its
	 * directory on disk forever, holding bytes that are excluded from the `list` + `size` totals
	 * tickets 15 and 16 need for ADR-0008's ~1 GB hosting warning; in ticket 12's real folder it is
	 * a stray dotfile the user commits to their repository.
	 *
	 * Deliberately a removal and nothing else. It does not list the litter and does not write, so
	 * it gives no caller a way to put bytes at a path `list` would hide.
	 */
	reclaimAbandonedWrites(prefix: string): Promise<void>;
}

/** Rejected from `read` and `size` when nothing is stored at the path. */
export class PathNotFoundError extends Error {
	readonly path: StorePath;

	constructor(path: StorePath) {
		super(`Nothing is stored at ${path}`);
		this.name = 'PathNotFoundError';
		this.path = path;
	}
}

/** Thrown when a caller hands the store something that is not a usable path. */
export class InvalidPathError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`Invalid store path ${JSON.stringify(path)}: ${reason}`);
		this.name = 'InvalidPathError';
		this.path = path;
	}
}

/**
 * The suffix marking a half-finished atomic write. Reserved: no path a caller supplies may
 * end with it, and `list` never reports one, so a write interrupted between its two steps
 * cannot leave litter that later looks like project data.
 */
export const TEMP_PATH_SUFFIX = '.ballastella-tmp';

export const isTempPath = (path: string): boolean => path.endsWith(TEMP_PATH_SUFFIX);

/** Validates a caller-supplied path, returning it unchanged so it can be used inline. */
export function assertStorePath(path: string): StorePath {
	if (typeof path !== 'string' || path.length === 0) {
		throw new InvalidPathError(path, 'must be a non-empty string');
	}
	if (path.startsWith('/') || path.endsWith('/')) {
		throw new InvalidPathError(path, 'must not start or end with "/"');
	}
	if (path.includes('\\')) {
		throw new InvalidPathError(path, 'must use "/" as its separator');
	}
	if (isTempPath(path)) {
		throw new InvalidPathError(path, `must not end with the reserved ${TEMP_PATH_SUFFIX}`);
	}
	for (const segment of path.split('/')) {
		if (segment === '') throw new InvalidPathError(path, 'must not contain an empty segment');
		if (segment === '.' || segment === '..') {
			throw new InvalidPathError(path, 'must not contain "." or ".." segments');
		}
	}
	return path;
}

/** The segments of a path: `a/b/c.json` → `['a', 'b', 'c.json']`. */
export const pathSegments = (path: string): string[] => path.split('/').filter(Boolean);

/** Everything before the last `/`, or `''` for a path at the root. */
export function parentPath(path: string): string {
	const cut = path.lastIndexOf('/');
	return cut === -1 ? '' : path.slice(0, cut);
}

/** The first path segment: the Project directory, for a path inside a Project. */
export function topLevelSegment(path: string): string {
	const cut = path.indexOf('/');
	return cut === -1 ? path : path.slice(0, cut);
}
