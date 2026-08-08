import { createTarPacker } from 'modern-tar';

import type { ProjectStore, StorePath } from '../store/project-store.js';
import type { TransferProgressListener } from './transfer.js';
import { toWorkspaceName } from '../store/opfs-workspaces.js';
import { isViewerFile } from './viewer-files.js';
import {
	archivePathFor,
	BACKUP_DISPLAY_NAME_RECORD,
	backupFileName,
	TAR_ENTRY_MTIME,
	workspaceDirectoryEntry
} from './workspace-tar.js';

export interface ExportWorkspaceTarOptions {
	readonly onProgress?: TransferProgressListener;
	/**
	 * Which Workspace-relative paths to leave out. Defaults to {@link isViewerFile}, the recorded
	 * viewer-file list ADR-0006 requires; injectable for the same reason the zip exporter's was —
	 * so that what the exclusion *mechanism* does is assertable without depending on what happens to
	 * be in the list this month.
	 */
	readonly excluded?: (relativePath: string) => boolean;
}

export interface WorkspaceBackup {
	/** What to call the file: the **normalised** name, so it matches what the archive unpacks to. */
	readonly fileName: string;
	/**
	 * The name the archive is rooted at — `toWorkspaceName(displayName)`, always a legal Workspace
	 * directory name, and therefore always something restore will accept.
	 */
	readonly workspaceName: string;
	/**
	 * The name that was asked for, unchanged. Differs from {@link workspaceName} only for a folder
	 * Workspace, whose name is the operating system's folder name; carried in the archive as a PAX
	 * record so the round trip loses nothing.
	 */
	readonly displayName: string;
	readonly totalFiles: number;
	/** The Workspace's own bytes. The archive is this plus tar's per-entry padding and headers. */
	readonly totalBytes: number;
	/**
	 * The archive, produced as it is consumed.
	 *
	 * One Workspace file is in memory at a time and each is released as soon as its entry has been
	 * written, so a shared pool of gigabyte pyramids never sits in the heap whole. Backpressure
	 * reaches all the way back: `tar-format.test.ts` measures the packer stalling its writer about
	 * 8 MiB into a sink nobody is reading, so nothing is read from the store until the sink asks for
	 * more. The caller chooses that sink — a file handle, a `Blob` the browser backs with its own
	 * storage.
	 */
	readonly body: ReadableStream<Uint8Array>;
}

/**
 * Write a whole Workspace to one tar. **Reads, and nothing else.**
 *
 * This is the backup, the move-between-machines story, and — for anyone on Firefox, Safari or an
 * iPad, where File System Access and therefore "just copy the folder" do not exist — the only way
 * their work leaves the browser at all (ADR-0001, ADR-0024).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **There is no entry ceiling, and that is the whole reason this is not a zip.** The zip exporter
 * refused above 65,535 files because the zip writer counted entries in sixteen bits: 70,000 entries produced
 * an archive whose index claimed 4,464, and `unzipSync` read back 4,464 files **with no error at
 * all**. Over a *Workspace* — a shared pool of large maps, several Projects deep — exceeding that is
 * the ordinary case rather than the pathological one, so the primary backup path would have refused
 * for exactly the users who have no other one. Tar has no central directory and no entry count, so
 * the ceiling does not exist; `workspace-tar.test.ts` asserts a restore of more than 65,535 files by
 * counting what comes back, which is the assertion that caught the zip writer.
 *
 * **Nothing is compressed, and that is a feature rather than a concession.** Tiles are
 * already-compressed JPEG and an offline copy's pyramid is nearly all tiles — the zip exporter's
 * `ALREADY_COMPRESSED` already skipped deflating them, so compression was buying almost nothing on
 * the bulk of a real Workspace. What dropping it *buys* is that **the archive's own byte length is an
 * honest measure of what it unpacks to**, which is what lets restore check quota against a number it
 * can read off the file the user picked, before it has read a single byte (see
 * `restoreWorkspaceTar`). The zip importer needed `PROJECT_ZIP_LIMITS` and a long comment about
 * 1000:1 deflate bombs to get a bound at all; here there is nothing to bound, because a tar cannot
 * claim to hold more than it holds.
 *
 * **The published viewer files are left out** (ADR-0024). `index.html`, `_app/`,
 * `ballastella-site.json`, `robots.txt` and `base-map/` are what publishing wrote, they are
 * enumerated in `viewer-files.ts`, and including them would bloat every backup and restore a viewer
 * bundle possibly older than the app — which ADR-0006 already warns goes stale against its data. A
 * restored Workspace therefore needs one re-publish to be a site again, and the offline Base Map
 * extract has to be fetched again; `restoreWorkspaceTar` says both rather than letting the user find
 * a stale site or a blank map.
 *
 * **Byte-reproducible.** Entries are sorted and every one gets {@link TAR_ENTRY_MTIME}, so the same
 * Workspace exported twice — and a Workspace exported after a round trip through restore — produces
 * identical archives. That is what lets the round-trip test assert *lossless* rather than *plausible*.
 *
 * **It does not read `project.json`, or interpret anything.** Unlike the Project-level exporter, which reads
 * each Project's Layer stack to gather the shared Historical Maps that Project references, a
 * Workspace backup is the whole Workspace: every file, whatever references it. So there is nothing to
 * parse, nothing to be defeated by a `project.json` that will not parse, and no way for a Project from
 * a newer version of the app to be anything other than backed up — which is precisely the Project a
 * user most needs to get out of a browser they cannot see into (ADR-0010).
 */
export async function exportWorkspaceTar(
	store: ProjectStore,
	displayName: string,
	options: ExportWorkspaceTarOptions = {}
): Promise<WorkspaceBackup> {
	const excluded = options.excluded ?? isViewerFile;

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// ⚠ THE NAME IS NORMALISED HERE, AND SKIPPING THIS SHIPPED BACKUPS THAT COULD NOT BE RESTORED
	//
	// `displayName` is whatever the app calls this Workspace, and for a **folder** Workspace that is
	// the operating system's folder name — which has never been through `toWorkspaceName` and is
	// under no obligation to look like anything. Meanwhile `backupWorkspaceName` refuses to restore
	// an archive whose root directory is not already normalised, because a name that changes under
	// an idempotent normaliser is one our exporter could not have written.
	//
	// Written verbatim, those two rules met in the worst possible place. A scholar with a folder
	// called `Dave's maps` got a backup that **failed at restore** — and only at restore, which is
	// the one moment they cannot afford it. Measured: `Dave's maps` → `Dave s maps`, `maps, 1625` →
	// `maps 1625`, `maps & plans` → `maps plans`, any name over 64 code points truncates, and an NFD
	// `Café Notes` changes while looking identical. Every existing test passed because every fixture
	// was called `My Workspace` or `Marking 2026`, which survive untouched.
	//
	// So the archive's directory is **always** the normalised name, and the restore fence stays
	// strict. This is the layer for it: the fence is core's, so the rule that satisfies the fence
	// belongs beside it rather than in each of the app's call sites.
	const directoryName = toWorkspaceName(displayName);

	// `list('')` is every path in the Workspace, already sorted and already hiding the store's own
	// unfinished writes. Sorted again anyway below, because "already sorted" is a property of the
	// adapters rather than of the interface, and byte-reproducibility is not something to inherit by
	// accident from a `ProjectStore` implementation that has not promised it.
	const paths = (await store.list(''))
		.filter((path) => !excluded(path))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

	const sizes = await Promise.all(paths.map((path) => store.size(path)));
	const totalBytes = sizes.reduce((sum, size) => sum + size, 0);

	return {
		// The normalised name, so what lands in the Downloads folder, what `tar xf` unpacks to, and
		// what the Workspace is called after a restore are all the same string. A file called
		// `Dave's maps.tar` that unpacks to `Dave s maps/` is a small surprise available for free, and
		// this declines it.
		fileName: backupFileName(directoryName),
		workspaceName: directoryName,
		displayName,
		totalFiles: paths.length,
		totalBytes,
		body: tarStream(store, displayName, directoryName, paths, totalBytes, options.onProgress)
	};
}

/**
 * Drive `modern-tar`'s packer from a producer loop, and let backpressure do the throttling.
 *
 * The loop is not awaited by the caller — the archive *is* the `ReadableStream`, and the loop fills
 * it — but every `write()` in it is, which is what bounds memory: measured at `modern-tar` 0.8.2, a
 * packer whose sink is not being read stops resolving `write()` about 8 MiB in, so a slow disk or a
 * user who has not yet chosen a download location throttles the reads instead of the archive piling
 * up in the heap.
 */
function tarStream(
	store: ProjectStore,
	displayName: string,
	directoryName: string,
	paths: readonly StorePath[],
	totalBytes: number,
	onProgress: TransferProgressListener | undefined
): ReadableStream<Uint8Array> {
	const { readable, controller } = createTarPacker();

	let files = 0;
	let bytes = 0;
	const report = (path: string | null): void =>
		onProgress?.({ files, totalFiles: paths.length, bytes, totalBytes, path });

	const produce = async (): Promise<void> => {
		report(null);

		// The Workspace's own directory, first. It is what carries the name, and it is the only thing
		// in the archive when the Workspace is empty — an empty backup that still knows what it is a
		// backup *of*.
		//
		// **And, when normalising changed the name, a PAX record carrying the original**, so nothing
		// the user typed is thrown away by the rule above. A custom PAX key rather than a file in the
		// archive: `tar` ignores keys it does not know, so this costs a reader nothing and adds no
		// document format for ticket 14 to inherit. Measured to round-trip exactly — through both the
		// buffered and the streaming reader, for an NFD name and for Devanagari — in
		// `tar-format.test.ts`, because a claim about PAX is exactly the kind this ticket is not
		// allowed to take from documentation.
		//
		// **Omitted when the name is already normalised**, which is every browser-storage Workspace.
		// That keeps the ordinary archive byte-for-byte what it was before this record existed, so
		// reproducibility is unaffected and the extra 1 KiB block is paid only where it buys something.
		const root = controller.add({
			name: workspaceDirectoryEntry(directoryName),
			size: 0,
			type: 'directory',
			mtime: TAR_ENTRY_MTIME,
			...(displayName === directoryName
				? {}
				: { pax: { [BACKUP_DISPLAY_NAME_RECORD]: displayName } })
		});
		await root.close();

		for (const path of paths) {
			// One file in the heap at a time. `ProjectStore` has no streaming read, so a single very
			// large file — ticket 15's copied `full/max` image is the only one in ADR-0006's layout
			// that can be — is held whole for as long as it takes to write its entry. That is the same
			// bound the Project bundle exporter has and it is a property of the store rather than of tar; the
			// archive around it is still streamed, which is what the ADR's claim is about.
			const content = await store.read(path);
			const entry = controller.add({
				// The **normalised** name on every entry, matching the root directory. An entry prefixed
				// with the raw display name would sit outside the folder the archive says it is a backup
				// of, and restore's own fence would refuse it.
				name: archivePathFor(directoryName, path),
				size: content.length,
				type: 'file',
				mtime: TAR_ENTRY_MTIME
			});
			const writer = entry.getWriter();
			await writer.write(content);
			await writer.close();

			files += 1;
			bytes += content.length;
			report(path);
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
