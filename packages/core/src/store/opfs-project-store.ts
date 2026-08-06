import { DirectoryHandleStore } from './directory-handle-store.js';

/**
 * The default backend: the Origin Private File System, which every modern browser supports
 * (ADR-0001). Built and shipped before the File System Access adapter so the interface could
 * not be shaped around a folder the user can see — a folder is the headline feature, but it
 * is Chromium-desktop only, and an abstraction shaped around it would have left the
 * cross-browser path to rot.
 *
 * The workspace is the OPFS root and Projects are directories inside it (ADR-0008), the same
 * layout a real folder gets, so a Project copied between backends by hand still opens.
 *
 * Everything about bytes on disk is in {@link DirectoryHandleStore}, shared with the folder
 * backend, because an OPFS root and a picked folder are the same handle interface. What is OPFS
 * about OPFS is only the two things below: where the root comes from, and the fact that it is
 * always there.
 */
export class OpfsProjectStore extends DirectoryHandleStore {
	/** The workspace at the OPFS root. What the app uses. */
	static open(): OpfsProjectStore {
		return new OpfsProjectStore(() => navigator.storage.getDirectory());
	}

	/** Whether this browser has OPFS at all. False only in a non-secure context. */
	static isSupported(): boolean {
		return (
			typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
		);
	}
}
