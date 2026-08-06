import { unzip, type UnzipFileInfo, type Unzipped } from 'fflate';

import { PROJECT_FILE_NAME, parseProjectFile, type ProjectFile } from '../project/project-file.js';
import type { Bytes } from '../store/project-store.js';
import type { ProjectFileSource, TransferFile } from './transfer.js';

/** Why a zip cannot be imported. Each one is refused before a single byte is written. */
export type ProjectZipRejection =
	/** The bytes are not a zip archive, or the archive is damaged. */
	| 'not-a-zip'
	/** No `project.json` at the root of the archive, so this is not a Project zip. */
	| 'no-project-file'
	/** An entry would be written outside the Project directory. */
	| 'path-traversal'
	/** An entry uses a compression method this build cannot read. */
	| 'unsupported-compression'
	/** `project.json` names a file, or an image directory needs one, that is not in the archive. */
	| 'missing-reference';

/**
 * A zip that will not be imported, with a message for the person who was handed it.
 *
 * Separate from {@link ProjectFileUnreadableError} and {@link ProjectFormatTooNewError}, which
 * `readProjectZip` lets through untouched: those two are about the `project.json` inside and their
 * messages are already the right ones to show — in particular ADR-0010's refusal, which names the
 * remedy and is the same sentence a user sees when the same Project sits in their Workspace.
 */
export class ProjectZipRejectedError extends Error {
	readonly reason: ProjectZipRejection;

	constructor(reason: ProjectZipRejection, message: string) {
		super(`${message} Nothing has been imported.`);
		this.name = 'ProjectZipRejectedError';
		this.reason = reason;
	}
}

/**
 * A validated Project zip, ready to be handed to `Workspace.importProject`.
 *
 * Holding this is the proof that validation passed. There is deliberately no way to write a zip's
 * contents without producing one first: a partially written import is worse than a rejected one,
 * because the user is left with a directory that is neither their colleague's Project nor absent.
 */
export interface ProjectZip extends ProjectFileSource {
	/** The manifest, parsed. Lets the caller name the Project before deciding where to put it. */
	readonly project: ProjectFile;
}

/**
 * How much is inflated at once, in uncompressed bytes and in entries.
 *
 * Import re-reads the archive once per batch, which is cheap — fflate reads the central directory
 * and skips whatever the filter declines, without inflating it — and it is what keeps a
 * hundred-megabyte pyramid from existing twice over in the heap, compressed and inflated, on a
 * machine whose browser is the only place that Project lives (ADR-0001).
 */
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_ENTRIES = 128;

/**
 * Read and validate a Project zip. **Writes nothing, and reaches no store.**
 *
 * Every check in ticket 13's table happens here, before the caller has anything it could write:
 * `project.json` present and parseable, `formatVersion` not from the future, referenced files
 * present, and no entry that would escape the Project directory. That last one is not theory — a
 * zip is a file another person made, and on ticket 12's File System Access backend an entry named
 * `../../something` writes into a folder the user never chose.
 *
 * @throws ProjectZipRejectedError for anything wrong with the archive
 * @throws ProjectFileUnreadableError when `project.json` is not readable JSON
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export async function readProjectZip(archive: Bytes): Promise<ProjectZip> {
	const entries: UnzipFileInfo[] = [];
	// Only `project.json` is inflated: it is the one file whose *contents* validation looks at, and
	// the filter is called for every entry regardless, so the archive is fully enumerated for the
	// price of one small inflate.
	const extracted = await inflate(archive, (entry) => {
		entries.push(entry);
		return entry.name === PROJECT_FILE_NAME;
	});

	const paths: string[] = [];
	let totalBytes = 0;
	for (const entry of entries) {
		assertSafeEntryName(entry.name);
		// A zip records directories as their own zero-length entries. Nothing needs them: the store
		// creates missing parents on write, and an empty directory holds no scholarship.
		if (entry.name.endsWith('/')) continue;
		if (entry.compression !== 0 && entry.compression !== 8) {
			throw new ProjectZipRejectedError(
				'unsupported-compression',
				`“${entry.name}” in this zip uses a compression method this copy of Ballastella cannot read.`
			);
		}
		paths.push(entry.name);
		totalBytes += entry.originalSize;
	}

	const manifest = extracted[PROJECT_FILE_NAME];
	if (!manifest) {
		throw new ProjectZipRejectedError(
			'no-project-file',
			`This zip has no ${PROJECT_FILE_NAME} at its root, so it is not a Ballastella Project. ` +
				`A Project zip holds one Project, with ${PROJECT_FILE_NAME} at the top.`
		);
	}
	// Parsed, not merely present. Both failures it can raise are the right message to show as they
	// are, and the format refusal has to happen here rather than after the files land: an imported
	// zip is the likeliest way a Project from a newer version reaches an older build at all.
	const project = parseProjectFile(manifest);

	assertReferencesPresent(project, new Set(paths));

	const ordered = orderForWriting(paths);
	return {
		project,
		paths: ordered,
		totalBytes,
		files: () => inflateInBatches(archive, ordered, entries)
	};
}

/**
 * `project.json` last.
 *
 * The Workspace's list of Projects *is* whichever directories hold a `project.json` (ADR-0008), so
 * an import interrupted half way — a closed laptop, a full disk — leaves a directory of orphaned
 * files rather than a Project that lists on the hub and opens with most of its Layers missing. The
 * first is litter; the second reads as the tool having eaten somebody's work.
 */
function orderForWriting(paths: readonly string[]): string[] {
	const rest = paths.filter((path) => path !== PROJECT_FILE_NAME).sort();
	return paths.includes(PROJECT_FILE_NAME) ? [...rest, PROJECT_FILE_NAME] : rest;
}

/**
 * Refuse an entry name that is not a plain relative path inside the Project.
 *
 * The store would refuse most of these too, but only at the moment of writing — by which point
 * earlier entries are already on disk. This is why the check lives in validation.
 */
function assertSafeEntryName(name: string): void {
	const reject = (why: string): never => {
		throw new ProjectZipRejectedError(
			'path-traversal',
			`This zip contains an entry that would not stay inside the Project: “${name}” ${why}.`
		);
	};

	if (name === '') reject('has no name');
	if (name.startsWith('/')) reject('is an absolute path');
	if (/^[A-Za-z]:/.test(name)) reject('is an absolute path with a drive letter');
	if (name.includes('\\')) reject('uses a backslash as a separator');
	// eslint-disable-next-line no-control-regex -- a control character in a filename is not a filename
	if (/[\u0000-\u001f\u007f]/.test(name)) reject('contains a control character');
	const segments = name.split('/');
	// A zip records a directory as an entry whose name ends in `/`, so its final empty segment is
	// legitimate. Any other empty segment is a `//` in the path.
	const named = segments.at(-1) === '' ? segments.slice(0, -1) : segments;
	for (const segment of named) {
		if (segment === '..') reject('climbs out of the Project directory');
		if (segment === '.') reject('contains a “.” segment');
		if (segment === '') reject('contains an empty path segment');
	}
}

/**
 * Refuse a zip whose `project.json` points at files it does not carry.
 *
 * `alignmentRef` and `geojsonRef` are the two references a Layer holds (SPEC's Layer union, given
 * a type by ticket 09). They are read structurally here rather than through that type, so this
 * check works on the `layers: unknown[]` of today and keeps working when ticket 09 lands — and it
 * tolerates a Layer kind this build has never heard of, which is the same forward tolerance
 * ADR-0014 asks of the Layer list itself.
 */
function assertReferencesPresent(project: ProjectFile, present: ReadonlySet<string>): void {
	const missing = (reference: string, why: string): never => {
		throw new ProjectZipRejectedError(
			'missing-reference',
			`This zip is missing “${reference}”, which ${why}.`
		);
	};

	for (const layer of project.layers) {
		if (typeof layer !== 'object' || layer === null) continue;
		for (const key of ['alignmentRef', 'geojsonRef'] as const) {
			const reference = (layer as Record<string, unknown>)[key];
			if (typeof reference !== 'string' || reference === '') continue;
			if (!present.has(reference)) missing(reference, `a Layer in ${PROJECT_FILE_NAME} refers to`);
		}
	}

	// An image directory without its `info.json` is a heap of tiles no IIIF client can open
	// (ADR-0006's layout), so the pyramid is missing whether or not any Layer has been wired to it
	// yet. Checked from the archive's own contents rather than from a reference, because the link
	// from a Layer to its image runs through the Georeference Annotation, whose shape ticket 07
	// defines — see the note on this ticket.
	const imageDirectories = new Set<string>();
	for (const path of present) {
		const segments = path.split('/');
		if (segments[0] === 'images' && segments.length > 2) {
			imageDirectories.add(`${segments[0]}/${segments[1]}`);
		}
	}
	for (const directory of [...imageDirectories].sort()) {
		const info = `${directory}/info.json`;
		if (!present.has(info))
			missing(info, `the image directory “${directory}” needs to be readable`);
	}
}

/** Inflate the entries the filter accepts. Rejects rather than throwing synchronously. */
function inflate(archive: Bytes, filter: (entry: UnzipFileInfo) => boolean): Promise<Unzipped> {
	return new Promise((resolve, reject) => {
		try {
			unzip(archive, { filter }, (error, unzipped) => {
				if (!error) return resolve(unzipped);
				reject(
					error instanceof ProjectZipRejectedError
						? error
						: new ProjectZipRejectedError(
								'not-a-zip',
								`This file could not be read as a zip archive: ${error.message}.`
							)
				);
			});
		} catch (cause) {
			// fflate raises a malformed central directory synchronously.
			reject(
				cause instanceof ProjectZipRejectedError
					? cause
					: new ProjectZipRejectedError(
							'not-a-zip',
							`This file could not be read as a zip archive: ${
								cause instanceof Error ? cause.message : String(cause)
							}.`
						)
			);
		}
	});
}

/** The Project's files, inflated a bounded batch at a time and in the order given. */
async function* inflateInBatches(
	archive: Bytes,
	paths: readonly string[],
	entries: readonly UnzipFileInfo[]
): AsyncIterable<TransferFile> {
	const sizeOf = new Map(entries.map((entry) => [entry.name, entry.originalSize]));

	for (let from = 0; from < paths.length;) {
		let to = from;
		let bytes = 0;
		while (to < paths.length) {
			// At least one entry per batch, however large that one entry is on its own.
			if (to > from && (to - from >= BATCH_ENTRIES || bytes >= BATCH_BYTES)) break;
			const path = paths[to];
			if (path === undefined) break;
			bytes += sizeOf.get(path) ?? 0;
			to += 1;
		}

		const wanted = new Set(paths.slice(from, to));
		const batch = await inflate(archive, (entry) => wanted.has(entry.name));
		for (const path of paths.slice(from, to)) {
			const inflated = batch[path];
			if (!inflated) {
				throw new ProjectZipRejectedError(
					'not-a-zip',
					`“${path}” is listed in this zip but its contents could not be read.`
				);
			}
			yield { path, bytes: inflated };
		}
		from = to;
	}
}
