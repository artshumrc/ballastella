import { DirectoryHandleStore } from './directory-handle-store.js';

/**
 * The capability upgrade of ADR-0001: a Workspace in a real folder the user picked, which they
 * can see in Finder or Explorer, back up with Dropbox, and commit to git.
 *
 * **There is nothing here about bytes on disk, and that is the whole point.** ADR-0001 built the
 * OPFS backend first so this one would have to fit the interface rather than widen it, and it
 * does: a picked `FileSystemDirectoryHandle` and the OPFS root are the same interface, so every
 * read, the two-step atomic write of ADR-0017 rule 4, the temporary-file reclaim, and the
 * directory pruning are the shared {@link DirectoryHandleStore} unchanged. A Project written
 * here is byte-for-byte the layout ADR-0008 specifies, so one copied into OPFS by hand opens,
 * and one copied out is just files.
 *
 * Chromium desktop only — Firefox has declared the picker "harmful" and will not ship it,
 * Safari desktop and iOS do not have it, and Chrome on Android does not. Roughly 28% of global
 * browser usage, which is why this is an upgrade and never a gate: see
 * {@link isFolderWorkspaceSupported} in `workspace-folder.ts` for the detection, and note that
 * nothing in this class needs the picker — a Workspace folder is granted once and then it is
 * simply a directory.
 */
export class FileSystemAccessProjectStore extends DirectoryHandleStore {
	readonly #folder: FileSystemDirectoryHandle;

	constructor(folder: FileSystemDirectoryHandle) {
		// Resolved eagerly and handed over as a constant: unlike OPFS, whose root the browser will
		// hand out again on request, this handle *is* the grant. There is nothing to re-resolve, and
		// a folder that has gone away fails at the operation the user asked for, where ADR-0008's
		// "Workspace not reachable" and its locate-again affordance live.
		super(() => Promise.resolve(folder));
		this.#folder = folder;
	}

	/** The folder's own name, for telling the user which folder their Workspace is. */
	get folderName(): string {
		return this.#folder.name;
	}

	/**
	 * The granted handle, so it can be remembered across visits.
	 *
	 * Exposed on this class rather than on {@link ProjectStore}: a handle is the one thing the
	 * store interface deliberately has none of, and putting it there to save this getter would
	 * shape the interface around this backend — precisely what ADR-0001 forbids.
	 */
	get folder(): FileSystemDirectoryHandle {
		return this.#folder;
	}
}
