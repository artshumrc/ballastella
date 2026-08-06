import { getContext, setContext } from 'svelte';

import {
	FolderPermissionDeniedError,
	OpfsProjectStore,
	chooseWorkspaceFolder,
	forgetWorkspaceFolder,
	isFolderWorkspaceSupported,
	rememberedFolderName,
	reopenWorkspaceFolder,
	type ProjectStore
} from '@ballastella/core';

import { EditorSession } from './editor-session.svelte.js';

/** Where the Workspace is: browser-managed storage, or a folder the user can see. */
export type WorkspaceBacking = 'browser' | 'folder';

/**
 * Which backend the Workspace is on, and the whole of moving between them.
 *
 * Owns the {@link EditorSession} rather than living beside it, because switching backends means
 * *replacing* the session: an `EditorSession` holds one `Autosave` bound to one store, and
 * repointing that store underneath it would leave queued bytes addressed to a Workspace the user
 * has already left. So the swap is a flush, a teardown, and a new session — in that order.
 *
 * A folder Workspace is a capability upgrade and never a gate (ADR-0001). Where the browser has no
 * picker the option is simply absent, and everything else about the app is identical; where it
 * does, the offer is made once and not repeated.
 */
export class WorkspaceStorage {
	/** The live session. Replaced, never repointed, when the backend changes. */
	session = $state<EditorSession>(EditorSession.opfs());
	backing = $state<WorkspaceBacking>('browser');
	/** The folder's name while {@link backing} is `folder`. */
	folderName = $state('');
	/**
	 * A folder from a previous visit, named so the offer to reopen it can name it too.
	 *
	 * Only an offer. Reopening needs `requestPermission()`, which needs transient user activation,
	 * so it must come from a click or a keypress — called automatically on load it fails silently
	 * and the app looks as though it has lost the folder (ADR-0012).
	 */
	reopenable = $state<string | null>(null);
	/** Whether this browser can put a Workspace in a folder at all. */
	canChooseFolder = $state(false);
	/**
	 * Why the folder was not opened, if it was not.
	 *
	 * Every one of these is a normal state with a recovery, not an exception (ADR-0008), and it must
	 * be *said*: falling back to browser storage without a word is indistinguishable, from the
	 * user's side, from the tool having lost the folder they just pointed it at.
	 */
	problem = $state('');

	#teardownFlushOnHide: (() => void) | undefined;

	/** Begin. Returns its own teardown, for the effect that created it. */
	start(): () => void {
		this.canChooseFolder = isFolderWorkspaceSupported();
		this.#teardownFlushOnHide = this.session.installFlushOnHide();
		if (this.canChooseFolder) {
			// Reading IndexedDB prompts for nothing, so it is safe on load; it is the *permission*
			// that needs the gesture.
			void rememberedFolderName()
				.then((name) => {
					this.reopenable = name;
				})
				.catch(() => undefined);
		}
		return () => {
			this.#teardownFlushOnHide?.();
			this.#teardownFlushOnHide = undefined;
		};
	}

	/** Pick a folder. Also the locate-again action for a folder that has gone away (ADR-0008). */
	async chooseFolder(): Promise<void> {
		this.problem = '';
		try {
			const store = await chooseWorkspaceFolder();
			// The picker was closed without choosing. Nothing happened, so nothing is said.
			if (!store) return;
			await this.#adopt(store, 'folder', store.folderName);
		} catch (cause) {
			this.problem = describeFolderProblem(cause);
		}
	}

	/** Reopen the folder from last visit. Must be called from a user gesture. */
	async reopenFolder(): Promise<void> {
		this.problem = '';
		try {
			const store = await reopenWorkspaceFolder();
			if (!store) {
				this.reopenable = null;
				return;
			}
			await this.#adopt(store, 'folder', store.folderName);
		} catch (cause) {
			this.problem = describeFolderProblem(cause);
		}
	}

	/**
	 * Go back to browser-managed storage.
	 *
	 * The folder is untouched and every Project in it stays where it is; so does every Project in
	 * OPFS, which is why trying the folder option and changing one's mind costs nothing. The
	 * remembered handle is dropped, because continuing to offer a folder the user has just moved
	 * away from is nagging — choosing it again brings it back in one gesture.
	 */
	async useBrowserStorage(): Promise<void> {
		this.problem = '';
		await forgetWorkspaceFolder().catch(() => undefined);
		this.reopenable = null;
		await this.#adopt(OpfsProjectStore.open(), 'browser', '');
	}

	/**
	 * Whether a folder from a previous visit is remembered but not open right now.
	 *
	 * The state a bookmarked `?p=` lands in: the Project is in the folder, the folder needs a gesture
	 * to reopen, and browser storage does not have that Project. Said rather than silently treated as
	 * "no such Project", and said on every route rather than only where {@link StorageChoice} is.
	 */
	get awaitingFolder(): boolean {
		return this.backing === 'browser' && this.reopenable !== null;
	}

	async #adopt(store: ProjectStore, backing: WorkspaceBacking, folderName: string): Promise<void> {
		const leaving = this.session;
		// Whatever is still queued belongs to the Workspace it was typed into. Flushed before the
		// swap, and swallowed if that Workspace has become unreachable — which is often exactly why
		// the user is switching.
		await leaving.flush().catch(() => undefined);
		this.#teardownFlushOnHide?.();

		const arriving = new EditorSession(store);
		this.session = arriving;
		this.backing = backing;
		this.folderName = folderName;
		this.reopenable = backing === 'folder' ? folderName : this.reopenable;
		this.#teardownFlushOnHide = arriving.installFlushOnHide();
		// Listing is left to the effect over the URL that opens the Workspace, so a swap and a
		// navigation cannot each trigger their own walk of a Workspace with tens of thousands of
		// tile files in it.
	}
}

const WORKSPACE_HOST = Symbol('ballastella.workspaceHost');

/**
 * The app's one Workspace, held where every route can read it.
 *
 * The whole reason this exists: `/base-map/` used to call `EditorSession.opfs()` while `/` went
 * through {@link WorkspaceStorage}, and with nothing shared between them the user's choice of
 * backing did not cross the route boundary. A folder-Workspace user picking a Base Map wrote the
 * *OPFS* Project of the same name — a state the folder suite deliberately creates — with a fresh
 * `updatedAt`, the indicator said "Saved", and the file in their folder was untouched. Where there
 * was no OPFS namesake the feature was simply absent. Ticket 07 puts that pane on the Project page,
 * which makes it the default path rather than a corner.
 *
 * Provided by the root layout, which mounts once for the whole app, so a client-side navigation
 * carries the live session — a resumed folder included — rather than resolving the backing again.
 */
export class WorkspaceHost {
	/** `null` until the browser-only construction in {@link begin} has run. */
	storage = $state<WorkspaceStorage | null>(null);
	/**
	 * Why this browser cannot hold a Workspace at all, or `''` when it can.
	 *
	 * Answered once here rather than per route: it was duplicated, and the duplicate is how the two
	 * routes came to disagree about the Workspace in the first place.
	 */
	unsupported = $state('');

	/** Construct the Workspace. Browser only, so call it from an effect. Returns its teardown. */
	begin(): (() => void) | undefined {
		// Read into a local rather than back out of the state it just set: an effect that reads the
		// `$state` it writes takes a dependency on itself.
		const reason = EditorSession.unsupportedReason();
		this.unsupported = reason;
		if (reason) return undefined;
		const storage = new WorkspaceStorage();
		this.storage = storage;
		return storage.start();
	}
}

/** Called by the root layout, once. */
export function provideWorkspaceHost(): WorkspaceHost {
	const host = new WorkspaceHost();
	setContext(WORKSPACE_HOST, host);
	return host;
}

/** The Workspace the root layout provided. Every route reads it; none creates one. */
export function useWorkspaceHost(): WorkspaceHost {
	return getContext<WorkspaceHost>(WORKSPACE_HOST);
}

/** A folder that would not open, described for a reader rather than for a log. */
function describeFolderProblem(cause: unknown): string {
	if (cause instanceof FolderPermissionDeniedError) {
		return `${cause.message} You can choose the folder again, or keep working in browser storage.`;
	}
	const detail = cause instanceof Error ? cause.message : String(cause);
	return `That folder could not be opened, so your Workspace has not changed. The browser reported: ${detail}`;
}
