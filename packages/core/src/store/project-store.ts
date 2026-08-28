// The one narrow interface every byte of a user's work passes through (ADR-0001).
//
// Paths are opaque strings. The store exposes no handles, no directories, and nothing
// else backend-specific, deliberately: the OPFS adapter was built first so the shape
// could not be bent towards a folder-like backend, and the File System Access adapter
// has to fit this interface unchanged.

/** A `/`-separated path relative to the workspace root. Never absolute, never empty. */
export type StorePath = string;

/**
 * The brand that makes a blind Alignment write **fail to compile**.
 *
 * A phantom property and nothing else: `AlignmentPath` is still a `string` at runtime and there is
 * no cost to carrying it. It exists so that {@link WritablePath} can name every store path *except*
 * an Alignment's, and so `store.write(alignmentPath(id), …)` is a type error rather than a review
 * comment.
 */
declare const alignmentPathBrand: unique symbol;

/**
 * The path of one Map Image's Alignment in the Workspace (ADR-0023).
 *
 * Produced by `alignmentPath` alone. It is assignable to {@link StorePath}, so **reads, `list`,
 * `size`, and `delete` take it unchanged** — reading an Alignment is the ordinary thing to do with
 * one. It is deliberately *not* assignable to {@link WritablePath}.
 */
export type AlignmentPath = StorePath & {
	readonly [alignmentPathBrand]: 'alignments/<image-id>.json';
};

/**
 * A path a caller may hand to a **write**: every {@link StorePath} except an {@link AlignmentPath}.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE ONE WRITER OF AN ALIGNMENT IS A TYPE AND NOT A CONVENTION
 *
 * ADR-0023 made `alignments/<image-id>.json` belong to the **Workspace**, shared by every Project
 * that draws the map. Nothing in the code changed to reflect what that means for a write, and two
 * blind overwrites of it were then written independently — one of them two lines from a correct
 * guard by the same author. That is a missing invariant, not two lapses.
 *
 * The failure mode is why this is structural rather than reviewed: an overwrite does not throw, does
 * not log, and does not 404. It shows up as a colleague's Control Points quietly gone, in a Project
 * nobody had open. The only way to turn an `AlignmentPath` into a `WritablePath` is
 * `alignment/alignment-file.ts`, which will not let the caller past without saying which of create /
 * update / replace they mean.
 *
 * The optional-and-`undefined` phantom property is what does it. A plain `string` — every other
 * store path in the codebase, literal or computed — has no such property and is assignable; an
 * `AlignmentPath` carries it as a string literal, which is not assignable to `undefined`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT REFUSE, WHICH IS NOT AN OVERSIGHT
 *
 * **It refuses values that came out of `alignmentPath()`, and nothing else.** The property has to be
 * optional or every one of the thousands of ordinary `string` paths in this codebase would need a
 * cast to be written, which would be a worse invariant than the one being protected. The exact price
 * is that an Alignment path the compiler sees as a plain `string` is accepted:
 *
 *     const p = `alignments/${id}.json`;
 *     await store.write(p, bytes);        // compiles
 *
 * That spelling is caught by `scripts/check-alignment-writers.mjs` instead, which follows the path
 * through the local it is bound to. Neither layer can see a path computed at runtime from data; the
 * places that happen are the two tar readers — `restore-workspace-tar.ts` and
 * `open-project-bundle.ts` — which are routed through the owning module
 * rather than fenced. Read the two together — this type is the cheap half, not the whole guard.
 */
export type WritablePath = StorePath & { readonly [alignmentPathBrand]?: undefined };

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
	 *
	 * **{@link WritablePath} rather than {@link StorePath}**, so an Alignment cannot be written from
	 * here at all. Every other path in the codebase is a plain string and is unaffected.
	 */
	write(path: WritablePath, bytes: Bytes): Promise<void>;

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
	 * Publishing and offline copies both have to warn about the ~1 GB static-hosting cliff
	 * (ADR-0008), and a multi-gigabyte pyramid is thousands of tile files. Summing sizes by reading each
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
	 * ADR-0008's ~1 GB hosting warning is judged against; in a real folder it is a stray dotfile the
	 * user commits to their repository.
	 *
	 * Deliberately a removal and nothing else. It does not list the litter and does not write, so
	 * it gives no caller a way to put bytes at a path `list` would hide.
	 */
	reclaimAbandonedWrites(prefix: string): Promise<void>;
}

/**
 * The read half of {@link ProjectStore}: everything a Reader of a Published Site needs, and
 * nothing that could change a byte of it.
 *
 * **A type, and it is the whole of "the viewer has no store `write`".** ADR-0006 names an
 * HTTP adapter as the third backend, and a static host can answer exactly one question: what are the
 * bytes at this path? It cannot list a directory, it will not accept a `PUT`, and there is nothing for
 * `reclaimAbandonedWrites` to sweep. An adapter that satisfied the full interface by rejecting from
 * four of its six methods would put a `write` in the viewer's reach and make "read-only" a runtime
 * promise rather than a fact the compiler holds — so the narrow type is the interface the viewer is
 * given, and `createHttpProjectStore` returns this.
 *
 * `Pick` rather than a hand-written interface, so `read`'s signature cannot drift from
 * {@link ProjectStore.read} and the same {@link PathNotFoundError} contract holds for a 404 as for a
 * missing file in OPFS. Every consumer that only reads — {@link createStoreImageFetch} is the one that
 * matters, since it is how a pyramid reaches a renderer — takes this rather than the full interface,
 * which is what lets one shim serve all three backends.
 */
export type ReadOnlyProjectStore = Pick<ProjectStore, 'read'>;

/**
 * {@link ReadOnlyProjectStore} plus the enumeration a **source reader** needs, and nothing else.
 *
 * A Project Import source has to find out what a Workspace holds before it can say what one
 * Project's closure is — which `images/<id>/` files exist, whether an Alignment is there — and
 * `read` alone cannot answer that. So this adds `list` and `size` and stops: no `write`, no `delete`,
 * no `reclaimAbandonedWrites`. Under ADR-0037 only the Import engine may hold a validated closure and
 * a writable ordinary Workspace at once, and this is the capability the Review Workspace source is
 * given instead of the whole interface.
 *
 * Not offered to the viewer, which keeps {@link ReadOnlyProjectStore}: a static host cannot list a
 * directory, so `createHttpProjectStore` could not satisfy this and must not have to.
 */
export type EnumerableReadOnlyProjectStore = ReadOnlyProjectStore &
	Pick<ProjectStore, 'list' | 'size'>;

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

/**
 * The reserved suffix, optionally followed by **one further extension**.
 *
 * The extension is the part that was missing. Writing a file is itself not one step: Chromium's
 * `createWritable()` creates a visible `<name>.crswap` beside its destination and exchanges the two
 * on `close()`, so a tab that dies mid-write leaves `<name>.ballastella-tmp.crswap` — which does not
 * end in the reserved suffix. Outside the machinery, that file was invisible to
 * `reclaimAbandonedWrites`, which exists for exactly this, while `list` reported it **as project
 * data**: counted in the size totals tickets 15 and 16 warn from, swept into a zip on export, and
 * carried on into whoever was handed that zip.
 *
 * Written for the *shape* rather than for `.crswap` by name, because the swap file is an
 * implementation's private business and Safari's may not be spelled the same. The cost is that a
 * user's own `notes.ballastella-tmp.txt` would be hidden, which is the reserved suffix working as
 * intended — nothing may be stored under a name the store has claimed.
 */
const TEMP_PATH_PATTERN = new RegExp(`${TEMP_PATH_SUFFIX.replace('.', '\\.')}(\\.[^./]+)?$`);

export const isTempPath = (path: string): boolean => TEMP_PATH_PATTERN.test(path);

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
		throw new InvalidPathError(
			path,
			`must not end with the reserved ${TEMP_PATH_SUFFIX}, with or without a further extension`
		);
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
