import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

import { alignmentPath } from '../alignment/alignment.js';
import { imageDirectory } from '../project/image-files.js';
import { parseLayers } from '../project/layer.js';
import { PROJECT_FILE_NAME, projectFilePath } from '../project/project-file.js';
import { PathNotFoundError, type ProjectStore, type StorePath } from '../store/project-store.js';
import type { TransferProgressListener } from './transfer.js';
import { isViewerFile } from './viewer-files.js';

/**
 * Every zip entry gets this modification time.
 *
 * A constant rather than the clock, for two reasons. It makes an export **byte-reproducible** —
 * exporting the same Project twice, or exporting it after a round trip through import, produces
 * the identical archive, which is what lets a test assert a round trip is lossless rather than
 * merely plausible. And it refuses to imply that a zip carries useful times: a Project's
 * `updatedAt` lives inside `project.json` precisely because zipping, cloning, and unzipping all
 * destroy filesystem modification times (ADR-0008).
 *
 * 1980 rather than the Unix epoch because 1980-01-01 is the earliest date a zip's DOS timestamp
 * field can represent, and constructed from *local* fields rather than from UTC because that is
 * what a zip stores — so a Project exported in Boston and one exported in Amsterdam produce the
 * same bytes, and neither falls off the near edge of the representable range.
 */
const ZIP_ENTRY_MTIME = new Date(1980, 0, 2, 12, 0, 0, 0);

/** Extensions whose bytes are already compressed, so deflating them only burns CPU. */
const ALREADY_COMPRESSED = /\.(jpe?g|png|webp|avif|gif|zip|pmtiles|woff2?)$/i;

/**
 * The most files one archive can hold, and a hard ceiling rather than a guideline.
 *
 * A zip counts its entries in a **sixteen-bit field**. Going past it requires the zip64 records
 * `fflate`'s writer does not emit, and the failure is silent in the worst way: exporting 70,000 files
 * produces an archive whose index claims `70000 & 0xffff` = 4,464 of them, and unzipping it returns
 * 4,464 files with no error from fflate or from anything else. The user has a zip that opens, that
 * looks plausible, and that is missing ninety-four per cent of their pyramid — on the only way out of
 * a browser they cannot see into (ADR-0001) and on the path a librarian deposits (SPEC story 94).
 *
 * SPEC puts "tens of thousands of files" on a single 2 GB pyramid, so a Project with a few large
 * archival scans reaches this without being pathological. Refusing legibly is the only honest answer
 * until the archive can be written as zip64; a Project this large still gets out through ticket 12's
 * folder Workspace, which is a real directory the user can copy.
 */
export const MAX_ZIP_ENTRIES = 65535;

/** Rejected when a Project holds more files than one zip archive can index. */
export class ProjectTooLargeToZipError extends Error {
	readonly totalFiles: number;

	constructor(directory: string, totalFiles: number) {
		super(
			`“${directory}” holds ${totalFiles} files, and a single zip cannot index more than ` +
				`${MAX_ZIP_ENTRIES}. It has not been exported, because an archive written past that ` +
				`limit would silently contain only a fraction of the Project. Move this Workspace to a ` +
				`folder on your computer, where the Project is already an ordinary directory you can copy.`
		);
		this.name = 'ProjectTooLargeToZipError';
		this.totalFiles = totalFiles;
	}
}

export interface ExportProjectZipOptions {
	readonly onProgress?: TransferProgressListener;
	/**
	 * Which Project-relative paths to leave out. Defaults to {@link isViewerFile}, the recorded
	 * viewer-file list ADR-0006 requires; injectable so the mechanism is testable while ticket 16
	 * has not yet populated that list.
	 */
	readonly excluded?: (relativePath: string) => boolean;
}

export interface ProjectExport {
	/** What to call the file. The Project's directory name, which is its identity (ADR-0008). */
	readonly fileName: string;
	readonly totalFiles: number;
	readonly totalBytes: number;
	/**
	 * The archive, produced as it is consumed.
	 *
	 * One Project file is in memory at a time and each is released as soon as its entry has been
	 * emitted, so a mirrored pyramid of hundreds of megabytes never sits in the heap whole
	 * (ADR-0001 makes this the only way out for a Firefox, Safari, or iPad user, so it has to work
	 * at the size real Projects reach). The caller chooses the sink — a file handle, a `Blob` the
	 * browser backs with its own storage — and backpressure reaches back here: nothing is read
	 * from the store until the sink asks for more.
	 */
	readonly body: ReadableStream<Uint8Array>;
}

/**
 * Export one Project as a zip, rooted at the Project directory.
 *
 * **The archive's shape did not change, and the Workspace's did** (ADR-0023). A Project directory now
 * holds only `project.json` and `annotations/`, so the `images/<id>/` and `alignments/<id>.json` its
 * map Layers reference are gathered out of the **Workspace** and written at the same archive paths they
 * always occupied. An export is therefore still self-contained and still imports into a Workspace that
 * has never seen the map — which is what makes `project-zip.test.ts`'s round trip a round trip.
 *
 * Reads and nothing else. Exporting a Project must not modify it, including a Project from a
 * newer version of the app — which is exactly the Project a user most needs to get out of a
 * browser they cannot see into. So the Layer stack is read through `parseLayers`, which never throws
 * and has no `formatVersion` opinion, rather than through `parseProjectFile`, which refuses a document
 * from the future (ADR-0010). A `project.json` that will not even parse as JSON exports as itself with
 * no shared material gathered: getting the bytes out still works, which is the property that matters
 * here, and an unopenable document is refused on the way back in by `parseProjectFile` regardless.
 *
 * @throws PathNotFoundError when there is no Project in `directory`
 * @throws ProjectTooLargeToZipError when the Project has more files than one zip can index
 */
export async function exportProjectZip(
	store: ProjectStore,
	directory: string,
	options: ExportProjectZipOptions = {}
): Promise<ProjectExport> {
	const excluded = options.excluded ?? isViewerFile;
	const prefix = `${directory}/`;
	const own = (await store.list(prefix))
		.map((path) => path.slice(prefix.length))
		.filter((relative) => !excluded(relative));

	if (!own.includes(PROJECT_FILE_NAME)) {
		throw new PathNotFoundError(projectFilePath(directory));
	}

	// The Project's own files keep their Project-relative names; the shared material keeps the archive
	// path it has always had, which happens to be its Workspace path too. Held as pairs rather than as
	// one prefix plus a list, because the two halves now come from different places in the store.
	const entries: { readonly archivePath: string; readonly storePath: StorePath }[] = [
		...own.map((relative) => ({
			archivePath: relative,
			storePath: (prefix + relative) as StorePath
		})),
		...(await sharedEntries(store, directory))
	];
	entries.sort((a, b) => a.archivePath.localeCompare(b.archivePath));

	if (entries.length > MAX_ZIP_ENTRIES) {
		throw new ProjectTooLargeToZipError(directory, entries.length);
	}

	const sizes = await Promise.all(entries.map((entry) => store.size(entry.storePath)));
	const totalBytes = sizes.reduce((sum, size) => sum + size, 0);

	return {
		fileName: `${directory}.zip`,
		totalFiles: entries.length,
		totalBytes,
		body: zipStream(store, entries, totalBytes, options.onProgress)
	};
}

/**
 * The Workspace files this Project's map Layers reference, at the archive paths they belong at.
 *
 * One `list` per referenced Historical Map rather than one walk of `images/`, because a Workspace can
 * hold maps no Project uses (ADR-0023) and an export must not carry a stranger's pyramid — that is the
 * difference between a Project bundle and a Workspace backup.
 *
 * A Layer whose image is not in the Workspace contributes nothing rather than failing: export is the
 * way out of a browser, so it does not refuse. The archive is then missing that image and
 * `assertReferencesPresent` says so on the way back in, naming the Layer — which is where a user can
 * act on it.
 */
async function sharedEntries(
	store: ProjectStore,
	directory: string
): Promise<{ archivePath: string; storePath: StorePath }[]> {
	let layers;
	try {
		const raw: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(await store.read(projectFilePath(directory)))
		);
		layers = parseLayers((raw as { layers?: unknown } | null)?.layers);
	} catch {
		return [];
	}

	const imageIds = [
		...new Set(
			layers.flatMap((layer) =>
				layer.kind === 'map' && layer.imageId !== '' ? [layer.imageId] : []
			)
		)
	];

	const found: { archivePath: string; storePath: StorePath }[] = [];
	for (const imageId of imageIds) {
		for (const path of await store.list(`${imageDirectory(imageId)}/`)) {
			found.push({ archivePath: path, storePath: path as StorePath });
		}
		const alignment = alignmentPath(imageId);
		try {
			await store.size(alignment as StorePath);
			found.push({ archivePath: alignment, storePath: alignment as StorePath });
		} catch (cause) {
			// A Historical Map nobody has placed yet has no Alignment, which is ordinary.
			if (!(cause instanceof PathNotFoundError)) throw cause;
		}
	}
	return found;
}

/**
 * Drive fflate's incremental `Zip` from a `ReadableStream`'s `pull`.
 *
 * `pull` is the whole reason this is not a loop over the file list: it is called again only when
 * the sink has taken what it was given, so a slow disk throttles the reads instead of the archive
 * piling up in memory.
 */
function zipStream(
	store: ProjectStore,
	entries: readonly { readonly archivePath: string; readonly storePath: StorePath }[],
	totalBytes: number,
	onProgress: TransferProgressListener | undefined
): ReadableStream<Uint8Array> {
	let next = 0;
	let bytesDone = 0;
	let ended = false;
	const pending: Uint8Array[] = [];
	let failure: Error | undefined;

	const zip = new Zip((error, chunk, final) => {
		if (error) failure ??= error;
		else if (chunk.length > 0 || final) pending.push(chunk);
	});

	const report = (path: string | null) =>
		onProgress?.({
			files: next,
			totalFiles: entries.length,
			bytes: bytesDone,
			totalBytes,
			path
		});

	return new ReadableStream<Uint8Array>({
		start() {
			report(null);
		},

		async pull(controller) {
			// Everything fflate has already handed us goes out before another file is read, so the
			// queue never holds more than one file's worth of the archive.
			while (pending.length === 0 && !ended) {
				const source = entries[next];
				if (source === undefined) {
					// The central directory, which is what makes the archive readable at all.
					zip.end();
					ended = true;
					report(null);
					continue;
				}
				const bytes = await store.read(source.storePath);
				const entry = zipEntry(source.archivePath);
				zip.add(entry);
				entry.push(bytes, true);
				next += 1;
				bytesDone += bytes.length;
				report(source.archivePath);
			}
			if (failure) throw failure;
			const chunk = pending.shift();
			if (chunk !== undefined && chunk.length > 0) controller.enqueue(chunk);
			if (ended && pending.length === 0) controller.close();
		},

		cancel() {
			zip.terminate();
		}
	});
}

function zipEntry(relative: string): ZipPassThrough | ZipDeflate {
	// Tiles are JPEG or PNG and a mirrored pyramid is nearly all tiles: deflating them costs real
	// seconds per hundred megabytes and saves close to nothing. `project.json`, `info.json`,
	// manifests, Alignments, and GeoJSON are text, where it saves most of the file.
	const entry = ALREADY_COMPRESSED.test(relative)
		? new ZipPassThrough(relative)
		: new ZipDeflate(relative, { level: 6 });
	entry.mtime = ZIP_ENTRY_MTIME;
	return entry;
}
