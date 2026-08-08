// What crosses the boundary when a Project or a Workspace leaves the browser or arrives in it
// (tickets 13 and 14, ADR-0024).
//
// A **bundle** is one Project, rooted at the Project directory: `project.json` is at the root of the
// archive, not under a directory named after the Project, and the shared material a Layer references
// keeps its Workspace-relative `images/` and `alignments/` paths. The Project's identity is its
// directory name (ADR-0008), and that name is *not* inside the archive — the reader chooses it, which
// is what makes a collision a question for the user rather than an accident.
//
// A **backup** is a whole Workspace, rooted at one directory named after it.

/**
 * How far along a transfer is.
 *
 * ⚠ **`totalFiles` is a real denominator only where one can be known.** An export lists and sizes
 * what it is about to write before it writes any of it, so its two numbers mean what they look like.
 * A tar being *read* has no index — that is the whole reason it can be streamed at all, and why a
 * bundle can be opened on an iPad — so a read reports its running count as both numbers and the UI
 * says "412 files so far" rather than inventing a proportion from the archive's byte length.
 *
 * It is reported at all because an offline copy's pyramid is hundreds of megabytes across thousands
 * of files, and a scholar watching a still screen concludes the tool has hung.
 */
export interface TransferProgress {
	/** Files finished. */
	readonly files: number;
	/** What `files` is out of, or `files` itself where the source cannot say. See above. */
	readonly totalFiles: number;
	/** Bytes finished, measured on the Workspace's own files rather than on the archive. */
	readonly bytes: number;
	readonly totalBytes: number;
	/** The file in flight, or `null` before the first and after the last. */
	readonly path: string | null;
}

export type TransferProgressListener = (progress: TransferProgress) => void;
