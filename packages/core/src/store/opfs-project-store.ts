import { DirectoryHandleStore } from './directory-handle-store.js';

/**
 * The default backend: the Origin Private File System, which every modern browser supports
 * (ADR-0001). Built and shipped before the File System Access adapter so the interface could
 * not be shaped around a folder the user can see — a folder is the headline feature, but it
 * is Chromium-desktop only, and an abstraction shaped around it would have left the
 * cross-browser path to rot.
 *
 * A workspace is a **named directory in the OPFS root** and Projects are directories inside it —
 * the same layout a real folder gets, so a Project copied between backends by hand still opens.
 * The root itself was the workspace until ticket 12; ADR-0024 needs it to hold several, so that a
 * Review Workspace is not a subdirectory of the user's own. See `opfs-workspaces.ts`.
 *
 * Everything about bytes on disk is in {@link DirectoryHandleStore}, shared with the folder
 * backend, because an OPFS directory and a picked folder are the same handle interface. What is OPFS
 * about OPFS is only the two things below: where the root comes from, and the fact that it is
 * always there.
 */
export class OpfsProjectStore extends DirectoryHandleStore {
	/**
	 * The workspace called `name` in the OPFS root. What the app uses.
	 *
	 * **The factory was already the seam**, which is the whole of why naming Workspaces did not change
	 * this class: the resolver descends one level before handing the store its root, and everything
	 * below that — the traversal, the two-step write, the pruning — is unchanged and still shared with
	 * the folder backend. `create: true` because the resolver runs on the first operation and a
	 * Workspace the user has just switched into may hold nothing yet.
	 */
	static open(name: string): OpfsProjectStore {
		return new OpfsProjectStore(async () =>
			(await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
		);
	}

	/** Whether this browser has OPFS at all. False only in a non-secure context. */
	static isSupported(): boolean {
		return (
			typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
		);
	}
}
