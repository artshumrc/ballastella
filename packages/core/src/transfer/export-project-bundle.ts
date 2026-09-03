import { createTarPacker } from 'modern-tar';

import { alignmentPath } from '../alignment/alignment.js';
import { imageDirectory } from '../project/image-files.js';
import { parseLayers } from '../project/layer.js';
import { PROJECT_FILE_NAME, projectFilePath } from '../project/project-file.js';
import { PathNotFoundError, type ProjectStore, type StorePath } from '../store/project-store.js';
import { bundleFileName } from './project-bundle.js';
import type { TransferProgressListener } from './transfer.js';
import { isViewerFile } from './viewer-files.js';
import { TAR_ENTRY_MTIME } from './workspace-tar.js';

export interface ExportProjectBundleOptions {
	readonly onProgress?: TransferProgressListener;
	/**
	 * Which Project-relative paths to leave out. Defaults to {@link isViewerFile}, the recorded
	 * viewer-file list ADR-0045 requires; injectable for the same reason the backup's is — so what the
	 * exclusion *mechanism* does is assertable without depending on what happens to be in the list.
	 */
	readonly excluded?: (relativePath: string) => boolean;
}

export interface ProjectBundle {
	/** What to call the file. See {@link bundleFileName} for why it is not simply `<directory>.tar`. */
	readonly fileName: string;
	readonly totalFiles: number;
	readonly totalBytes: number;
	/**
	 * The archive, produced as it is consumed.
	 *
	 * One Project file is in memory at a time and each is released as soon as its entry has been
	 * written. Backpressure reaches all the way back: `tar-format.test.ts` measures the packer stalling
	 * its writer about 8 MiB into a sink nobody is reading, so nothing is read from the store until the
	 * sink asks for more. The caller chooses that sink — a file handle, a `Blob` the browser backs with
	 * its own storage.
	 */
	readonly body: ReadableStream<Uint8Array>;
}

/**
 * Write one Project to a self-contained bundle. **Reads, and nothing else.**
 *
 * This is the handoff: a student's whole Project as one file a teacher can open (ADR-0024). It
 * carries `project.json`, `annotations/`, and the `images/<id>/` and `alignments/<id>.json` its map
 * Layers reference — and **not the Workspace's other maps**, which is the whole difference between
 * this and a backup. A Workspace holds a shared pool (ADR-0023) and a colleague has no business
 * receiving a pyramid no Layer in the Project they were sent points at.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **The archive's shape did not change when it stopped being a zip, and it did not change when the
 * Workspace's shape did either.** A Project directory holds only `project.json` and `annotations/`,
 * so the shared material is gathered out of the *Workspace* and written at the same archive paths it
 * has always occupied. A bundle is therefore still Project-relative, still self-contained, and still
 * satisfies `assertReferencesPresent` — which is what makes the round trip a round trip.
 *
 * **There is no entry ceiling.** The zip exporter refused above 65,535 files because the zip writer
 * counted entries in sixteen bits: 70,000 produced an index claiming 4,464, and `unzipSync` read back
 * 4,464 files with no error at all. A single 2 GB pyramid runs to tens of thousands of files, so
 * the refusal fired for a Project with two large archival scans — on the path a student hands their
 * work in by. Tar has no central directory and no entry count, so the limit is gone rather than
 * raised.
 *
 * **Nothing is compressed**, for the reason the backup gives: tiles are already-compressed JPEG and
 * a Project with an offline copy is nearly all tiles, so deflating bought almost nothing — and
 * dropping it makes the archive's own byte length an honest bound on what it unpacks to, which is
 * what lets the reader check quota against a number it can read off the file before opening it.
 *
 * **Byte-reproducible.** Entries are sorted and every one gets {@link TAR_ENTRY_MTIME}, so the same
 * Project exported twice — and one exported after a round trip through a Review Workspace — produces
 * identical archives. That is what lets the round-trip test assert *lossless* rather than *plausible*.
 *
 * **It does not parse `project.json` as a Project.** The Layer stack is read through `parseLayers`,
 * which never throws and has no `formatVersion` opinion, rather than through `parseProjectFile`,
 * which refuses a document from the future (ADR-0010) — because a Project from a newer version of the
 * app is exactly the one a user most needs to get out of a browser they cannot see into. A
 * `project.json` that will not parse as JSON at all exports as itself with no shared material
 * gathered; getting the bytes out still works, and the archive is refused on the way back in by
 * `parseProjectFile` regardless.
 *
 * @throws PathNotFoundError when there is no Project in `directory`
 */
export async function exportProjectBundle(
	store: ProjectStore,
	directory: string,
	options: ExportProjectBundleOptions = {}
): Promise<ProjectBundle> {
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
	// one prefix plus a list, because the two halves come from different places in the store.
	const entries: { readonly archivePath: string; readonly storePath: StorePath }[] = [
		...own.map((relative) => ({
			archivePath: relative,
			storePath: (prefix + relative) as StorePath
		})),
		...(await sharedEntries(store, directory))
	];
	// A plain code-unit sort rather than `localeCompare`, because byte-reproducibility is the point:
	// `localeCompare` answers differently under different locales, so the same Project exported on two
	// machines would order its entries differently and the archives would not be the same bytes. The
	// backup path settled this the same way.
	entries.sort((a, b) =>
		a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0
	);

	const sizes = await Promise.all(entries.map((entry) => store.size(entry.storePath)));
	const totalBytes = sizes.reduce((sum, size) => sum + size, 0);

	return {
		fileName: bundleFileName(directory),
		totalFiles: entries.length,
		totalBytes,
		body: tarStream(store, entries, totalBytes, options.onProgress)
	};
}

/**
 * The Workspace files this Project's map Layers reference, at the archive paths they belong at.
 *
 * One `list` per referenced Map Image rather than one walk of `images/`, because a Workspace can
 * hold maps no Project uses (ADR-0023) and a bundle must not carry a stranger's pyramid — that is the
 * difference between a handoff and a backup, and it is this function.
 *
 * A Layer whose image is not in the Workspace contributes nothing rather than failing: export is the
 * way out of a browser, so it does not refuse. The bundle is then missing that image and
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
			// A Map Image nobody has placed yet has no Alignment, which is ordinary.
			if (!(cause instanceof PathNotFoundError)) throw cause;
		}
	}
	return found;
}

/**
 * Drive `modern-tar`'s packer from a producer loop, and let backpressure do the throttling.
 *
 * The loop is not awaited by the caller — the archive *is* the `ReadableStream`, and the loop fills
 * it — but every `write()` in it is, which is what bounds memory. The backup path documents the
 * measurement; this is the same packer used the same way.
 */
function tarStream(
	store: ProjectStore,
	entries: readonly { readonly archivePath: string; readonly storePath: StorePath }[],
	totalBytes: number,
	onProgress: TransferProgressListener | undefined
): ReadableStream<Uint8Array> {
	const { readable, controller } = createTarPacker();

	let files = 0;
	let bytes = 0;
	const report = (path: string | null): void =>
		onProgress?.({ files, totalFiles: entries.length, bytes, totalBytes, path });

	const produce = async (): Promise<void> => {
		report(null);
		for (const source of entries) {
			// One file in the heap at a time. `ProjectStore` has no streaming read, so a single very
			// large file is held whole for as long as it takes to write its entry; the archive around it
			// is still streamed, which is what ADR-0024's claim is about.
			const content = await store.read(source.storePath);
			const entry = controller.add({
				name: source.archivePath,
				size: content.length,
				type: 'file',
				mtime: TAR_ENTRY_MTIME
			});
			const writer = entry.getWriter();
			await writer.write(content);
			await writer.close();

			files += 1;
			bytes += content.length;
			report(source.archivePath);
		}
		controller.finalize();
		report(null);
	};

	// A failure has to reach the *consumer* of the archive, not a floating rejection: the caller is
	// awaiting the stream, and a producer that threw silently would leave them waiting on a stream
	// that never closes.
	produce().catch((cause: unknown) => {
		controller.error(cause);
	});

	return readable;
}
