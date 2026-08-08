import { getContext, setContext } from 'svelte';

import {
	DEFAULT_WORKSPACE_NAME,
	FolderPermissionDeniedError,
	chooseWorkspaceFolder,
	createOpfsWorkspace,
	deleteOpfsWorkspace,
	ensureOpfsWorkspace,
	forgetWorkspaceFolder,
	isFolderWorkspaceSupported,
	listOpfsWorkspaces,
	openOpfsWorkspace,
	rememberedFolderName,
	reopenWorkspaceFolder,
	workspaceSize,
	requestPersistentStorage,
	type ProjectStore,
	type StoragePersistence,
	type WorkspaceSize
} from '@ballastella/core';

import { EditorSession } from './editor-session.svelte.js';

/** Where the Workspace is: browser-managed storage, or a folder the user can see. */
export type WorkspaceBacking = 'browser' | 'folder';

/**
 * Which named Workspace browser storage was last opened in, kept across visits.
 *
 * `localStorage` rather than anything in OPFS, and deliberately outside the Workspaces themselves:
 * "which one was I in" is a fact about this browser, not about anybody's work, and writing it into a
 * Workspace would put it in the folder that gets published, backed up (ticket 13), and handed to a
 * colleague (ticket 14).
 */
const OPEN_WORKSPACE_KEY = 'ballastella.workspace';

/** The remembered Workspace name, or the default. Never throws: private mode has no storage. */
function rememberedWorkspaceName(): string {
	try {
		return localStorage.getItem(OPEN_WORKSPACE_KEY) || DEFAULT_WORKSPACE_NAME;
	} catch {
		return DEFAULT_WORKSPACE_NAME;
	}
}

function rememberWorkspaceName(name: string): void {
	try {
		localStorage.setItem(OPEN_WORKSPACE_KEY, name);
	} catch {
		// A browser refusing storage still gets a working Workspace; it simply opens the default one
		// next time. Failing the switch over it would be refusing the feature to keep a bookmark.
	}
}

/**
 * Which Workspace is open and the whole of moving between them — across backends, and since
 * ticket 12 across the several named Workspaces browser storage now holds (ADR-0024).
 *
 * Owns the {@link EditorSession} rather than living beside it, because switching means *replacing*
 * the session: an `EditorSession` holds one `Autosave` bound to one store, and repointing that store
 * underneath it would leave queued bytes addressed to a Workspace the user has already left. So the
 * swap is a flush, a teardown, and a new session — in that order.
 *
 * **Switching between two named Workspaces is the same operation as switching backends**, and goes
 * through the same {@link #adopt}. It has to: the failure it prevents is not about OPFS versus a
 * folder, it is about a queued write landing in whichever Workspace the store happens to point at
 * when the debounce fires — and two OPFS Workspaces make that failure *easier* to reach than two
 * backends did, because switching is now one click on the bar rather than a trip through a picker.
 *
 * A folder Workspace is a capability upgrade and never a gate (ADR-0001). Where the browser has no
 * picker the option is simply absent, and everything else about the app is identical; where it
 * does, the offer is made once and not repeated.
 */
export class WorkspaceStorage {
	/** The live session. Replaced, never repointed, when the Workspace changes. */
	session = $state<EditorSession>(EditorSession.opfs(rememberedWorkspaceName()));
	backing = $state<WorkspaceBacking>('browser');
	/** The folder's name while {@link backing} is `folder`. */
	folderName = $state('');
	/**
	 * The named browser-storage Workspace that is open, or was last open.
	 *
	 * Kept while {@link backing} is `folder` too, so that "use browser storage instead" returns to the
	 * Workspace the user left rather than to the default one — which, with several of them, would be
	 * somebody else's work appearing where their own had been.
	 */
	workspaceName = $state(rememberedWorkspaceName());
	/** Every named Workspace in browser storage, for the bar's switcher. */
	workspaces = $state<string[]>([]);
	/**
	 * What the browser said when asked to keep this origin's storage, or `null` before it answered.
	 *
	 * Recorded rather than acted on: nothing here changes behaviour by it. It is reported in Workspace
	 * settings because a refusal means everything the user has is evictable under disk pressure
	 * (ADR-0024), and they are the only one who can do anything about it.
	 */
	persistence = $state<StoragePersistence | null>(null);
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
		// The Workspace the session was already built for, made real: the store creates its directory at
		// the first write, so without this a Workspace nobody has typed into yet is missing from its own
		// switcher. Then the list, so the switcher has something to switch between.
		void ensureOpfsWorkspace(this.workspaceName)
			.then(() => this.refreshWorkspaces())
			.catch(() => undefined);
		// ADR-0024's latent data-loss fix. Fire and forget, and never awaited by anything the user is
		// waiting on: Chromium answers from its own heuristics and Firefox may not answer at all until a
		// permission prompt is dealt with, and neither is a reason to hold up opening a Workspace.
		void requestPersistentStorage()
			.then((answer) => {
				this.persistence = answer;
			})
			.catch(() => undefined);
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
	 * OPFS, which is why trying the folder option and changing one's mind costs nothing.
	 *
	 * **Whether the handle is dropped depends on which of two buttons this is.** Beside "Choose
	 * Workspace folder…" it is a deliberate switch, and dropping it is right: continuing to offer a
	 * folder the user has just moved away from is the nagging ticket 12 rules out, and choosing it
	 * again brings it back in one gesture. Beside "Locate Workspace folder again", when the Workspace
	 * cannot be reached, it is the escape hatch — a user whose external drive is unplugged clicking it
	 * to keep working — and dropping the grant there costs them a trip back through the operating
	 * system's dialog for a folder they never gave up. Same button, two meanings, told apart by
	 * whether the Workspace they are leaving was reachable.
	 */
	async useBrowserStorage(): Promise<void> {
		this.problem = '';
		if (this.session.status !== 'unreachable') {
			await forgetWorkspaceFolder().catch(() => undefined);
			this.reopenable = null;
		}
		await this.openWorkspace(this.workspaceName);
	}

	/** Reload the switcher's list. Cheap: one `entries()` of the OPFS root, no descent. */
	async refreshWorkspaces(): Promise<void> {
		this.workspaces = await listOpfsWorkspaces().catch(() => this.workspaces);
	}

	/**
	 * Open a named Workspace in browser storage.
	 *
	 * **The same replacement every other switch is** — flush, teardown, new session — because the
	 * queued bytes belong to the Workspace they were typed into. See {@link #adopt}.
	 *
	 * A no-op when it is already the open one, so the switcher's own item does not throw away a live
	 * session and the Project list under it.
	 */
	async openWorkspace(name: string): Promise<void> {
		if (this.isOpen(name)) return;
		this.problem = '';
		const opened = await ensureOpfsWorkspace(name);
		await this.#adopt(openOpfsWorkspace(opened), 'browser', '', opened);
		await this.refreshWorkspaces();
	}

	/**
	 * Try the Workspace that is open again, from scratch. The "locate again" affordance (ADR-0008).
	 *
	 * ⚠ **A new store, not a re-listing, and that is the whole point.** `DirectoryHandleStore` caches
	 * its root handle once it resolves, and since ticket 12 that handle is a *named subdirectory* of
	 * the OPFS root rather than the root itself — which can now be deleted, by a second tab or by the
	 * user in another window. The cached handle is then permanently dead: every operation on it raises
	 * `NotFoundError`, and `session.refresh()` re-lists through the same dead handle, so the recovery
	 * button was one that could not recover. Replacing the session re-resolves it.
	 *
	 * For a folder Workspace this is not the recovery — the way back there is the picker, because the
	 * grant is what was lost — so this only rebuilds a browser-managed one.
	 */
	async locateWorkspaceAgain(): Promise<void> {
		if (this.backing !== 'browser') {
			await this.session.refresh();
			return;
		}
		const name = this.workspaceName;
		// Best-effort: a Workspace that is still gone stays gone, and the fresh session's own listing is
		// what says so — in the words ADR-0008 wants, rather than as a rejection from a click handler.
		await ensureOpfsWorkspace(name).catch(() => undefined);
		await this.#adopt(openOpfsWorkspace(name), 'browser', '', name);
		await this.refreshWorkspaces();
	}

	/** Make a Workspace and switch into it. Answers with the name it really got. */
	async createWorkspace(displayName: string): Promise<string> {
		const name = await createOpfsWorkspace(displayName);
		await this.openWorkspace(name);
		return name;
	}

	/** Whether `name` is the browser-storage Workspace **this tab** currently has open. */
	isOpen(name: string): boolean {
		return this.backing === 'browser' && name === this.workspaceName;
	}

	/**
	 * Delete a named Workspace and everything in it.
	 *
	 * **Refuses the one that is open**, here rather than only in the dialog that asks. Deleting the
	 * Workspace out from under a live `EditorSession` leaves an `Autosave` whose next flush recreates
	 * the directory — the store's resolver has `create: true` — so the user would watch their
	 * Workspace come back holding one file. A guard that lives only in markup is one route away from
	 * being absent.
	 *
	 * ⚠ **It does not cover the case that actually happens, and saying so is better than implying it
	 * does.** {@link isOpen} compares against *this tab's* Workspace, so tab A deleting the Workspace
	 * tab B is working in walks straight through — and browser storage is shared across tabs, which is
	 * the whole reason a Workspace can now vanish under a running app at all. Nothing here can see
	 * another tab: there is no lock and no cross-tab channel in this application, and inventing one
	 * for a confirmation dialog would be a coordination protocol with a single caller.
	 *
	 * What *is* covered is the consequence, which is the half that matters to the user whose
	 * Workspace went: tab B reports it unreachable rather than silently empty (ADR-0008), and
	 * {@link locateWorkspaceAgain} rebuilds the session so the recovery is real. The guard here is
	 * therefore about the one-tab mistake, and the recovery is about the two-tab one.
	 */
	async deleteWorkspace(name: string): Promise<void> {
		if (this.isOpen(name)) {
			throw new Error(
				`“${name}” is the Workspace you are in, so it cannot be deleted from inside itself. ` +
					`Switch to another Workspace first.`
			);
		}
		await deleteOpfsWorkspace(name);
		await this.refreshWorkspaces();
	}

	/** What a Workspace weighs, so the confirmation can say what is about to go. `list` + `size`. */
	async sizeOfWorkspace(name: string): Promise<WorkspaceSize> {
		return workspaceSize(openOpfsWorkspace(name));
	}

	/**
	 * Which Workspace the bar names (SPEC story 88).
	 *
	 * The folder's own name when there is one, and the named Workspace otherwise — the two backings
	 * name a Workspace the same way, because in both the directory *is* the Workspace.
	 */
	get name(): string {
		return this.backing === 'folder' ? this.folderName || 'Workspace folder' : this.workspaceName;
	}

	/**
	 * Whether a folder from a previous visit is remembered but not open right now.
	 *
	 * The state a bookmarked `?p=` lands in: the Project is in the folder, the folder needs a gesture
	 * to reopen, and browser storage does not have that Project. Said rather than silently treated as
	 * "no such Project", and said on every route rather than only where the storage question is asked.
	 */
	get awaitingFolder(): boolean {
		return this.backing === 'browser' && this.reopenable !== null;
	}

	async #adopt(
		store: ProjectStore,
		backing: WorkspaceBacking,
		folderName: string,
		workspaceName = this.workspaceName
	): Promise<void> {
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
		this.workspaceName = workspaceName;
		rememberWorkspaceName(workspaceName);
		this.reopenable = backing === 'folder' ? folderName : this.reopenable;
		this.#teardownFlushOnHide = arriving.installFlushOnHide();
		// Listing is left to the effect over the URL that opens the Workspace, so a swap and a
		// navigation cannot each trigger their own walk of a Workspace with tens of thousands of
		// tile files in it.
		//
		// The sweep, however, belongs here. A write interrupted between its two steps leaves a file
		// nothing else can reach — `list` hides it, `delete` refuses it — and
		// `reclaimAbandonedWrites` had exactly one caller in the app: deleting a Project. So a laptop
		// that died mid-autosave left a dotfile in `~/Dropbox/maps/amsterdam-1625/` that `git add -A`
		// commits and Dropbox syncs, and nothing removed it unless that Project was deleted outright.
		// Adopting a Workspace is the one moment a full sweep is both cheap and expected: it costs the
		// same walk the listing that immediately follows it already does, and the user is watching a
		// Workspace open rather than waiting on an edit.
		//
		// Best-effort and swallowed. A Workspace that cannot be swept is either unreachable — which the
		// listing is about to say properly — or holding a file it will not give up, and neither is a
		// reason to refuse to open it.
		await store.reclaimAbandonedWrites('').catch(() => undefined);
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
