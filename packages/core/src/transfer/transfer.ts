// What crosses the boundary when a Project leaves the Workspace or arrives in it (ticket 13).
//
// A Project zip is **one Project subdirectory, rooted at the Project directory**: `project.json`
// is at the root of the archive, not under a directory named after the Project. The Project's
// identity is its directory name (ADR-0008), and that name is *not* inside the archive — the
// importer chooses it, which is what makes a collision a question for the user rather than an
// accident.

import type { Bytes } from '../store/project-store.js';

/** One file on its way in or out, named relative to the Project directory. */
export interface TransferFile {
	/** A `/`-separated path relative to the Project directory. Never absolute, never `..`. */
	readonly path: string;
	readonly bytes: Bytes;
}

/**
 * How far along a transfer is.
 *
 * Both totals are known before the first byte moves — export lists and sizes the Project first,
 * import reads the archive's central directory — so this is a real proportion and not a spinner.
 * An offline copy's pyramid is hundreds of megabytes across thousands of tiles, and a scholar watching
 * a still screen concludes the tool has hung.
 */
export interface TransferProgress {
	/** Files finished. */
	readonly files: number;
	readonly totalFiles: number;
	/** Bytes finished, measured on the Project's files rather than on the compressed archive. */
	readonly bytes: number;
	readonly totalBytes: number;
	/** The file in flight, or `null` before the first and after the last. */
	readonly path: string | null;
}

export type TransferProgressListener = (progress: TransferProgress) => void;

/**
 * A Project's files, ready to be written, with the totals known before the first one is.
 *
 * `Workspace.importProject` takes this rather than a zip, so the Workspace knows nothing about zip
 * archives — ticket 14's remote ingest and ticket 15's making an offline copy produce files the same way. The
 * iterable is async and pulled one file at a time on purpose: whatever produces the files decides
 * how much of the source it holds in memory, and the zip reader holds one bounded batch.
 *
 * Obtaining one is also the proof that validation has already happened. Nothing here writes.
 */
export interface ProjectFileSource {
	/** Every path that will be written, relative to the Project directory, in write order. */
	readonly paths: readonly string[];
	readonly totalBytes: number;
	files(): AsyncIterable<TransferFile>;
}
