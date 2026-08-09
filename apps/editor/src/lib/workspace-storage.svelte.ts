import { getContext, setContext } from 'svelte';

import {
	DEFAULT_WORKSPACE_NAME,
	FolderPermissionDeniedError,
	assertNotReviewing as refuseInsideReview,
	assertReviewing as refuseOutsideReview,
	chooseWorkspaceFolder,
	createOpfsWorkspace,
	deleteOpfsWorkspace,
	ensureOpfsWorkspace,
	exportWorkspaceTar,
	forgetWorkspaceFolder,
	isFolderWorkspaceSupported,
	listOpfsWorkspaces,
	openOpfsWorkspace,
	openProjectBundle,
	readReviewMark,
	rememberedFolderName,
	reopenWorkspaceFolder,
	restoreWorkspaceTar,
	workspaceSize,
	requestPersistentStorage,
	browserJournalStorage,
	discardDeletions,
	discardJournal,
	journalledWorkspaces,
	workspacesWithDeletions,
	type JournalStorage,
	type OpenedBundle,
	type ProjectStore,
	type RestoreDestination,
	type ReviewDestination,
	type ReviewMark,
	type StoragePersistence,
	type TransferProgressListener,
	type WorkspaceBackup,
	type WorkspaceRestore,
	type WorkspaceSize
} from '@ballastella/core';

import {
	EditorSession,
	folderWorkspaceKey,
	opfsWorkspaceKey,
	type TransferState
} from './editor-session.svelte.js';
import { saveFile } from './save-file.js';

/**
 * What the browser will say about its storage, for the pre-restore quota check.
 *
 * Here rather than in `packages/core` because core has to stay Node-safe — the barrel is imported by
 * both apps' root layouts and a value-import of anything browser-only breaks prerender — and passed
 * in, so the refusal is provokable in a test rather than only on a full disk.
 *
 * `null` when the browser will not answer. Safari has historically reported a quota unrelated to the
 * real one, and older builds have no `estimate` at all; `restoreWorkspaceTar` treats an unanswerable
 * estimate as permission to try, because refusing a restore because the API is missing would refuse
 * it on exactly the browsers ADR-0001 makes this path the only way out of.
 */
const estimateStorage = async (): Promise<{ quota?: number; usage?: number } | null> => {
	if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
	return navigator.storage.estimate();
};

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

/**
 * Which Workspace was last open that was **the user's own** — never a Review Workspace.
 *
 * A second key rather than a filter over the first, because they answer different questions and the
 * first one has to keep saying what it says. `OPEN_WORKSPACE_KEY` is "where was I", and a reload
 * inside a review copy has to land back inside it or the banner is a thing a user can navigate away
 * from by accident. This one is "where do I go back *to*", which is what the banner's first exit
 * needs, and a Review Workspace must never be that answer — the exit would lead nowhere.
 */
const OWN_WORKSPACE_KEY = 'ballastella.own-workspace';

/**
 * The **folder** the user's own Workspace was in, or `''` when it was browser storage.
 *
 * ⚠ **A third key, because a folder Workspace is one of the user's own and has no OPFS name.** The
 * first cut recorded "own" only for browser-backed Workspaces, so a scholar whose Workspace is a
 * folder on their own disk — ADR-0001's capability upgrade, and the whole reason the folder path
 * exists — was never recorded as being in one of their own at all. Opening a bundle and pressing
 * "Back to my Workspace" then dropped them into an OPFS Workspace called "My Workspace", **creating
 * it if it did not exist**, while the banner announced they were back in their own. Their real work
 * was in the folder, untouched and off screen, and nothing said so.
 *
 * Kept beside {@link OWN_WORKSPACE_KEY} rather than replacing it: the browser Workspace is still the
 * fallback when the folder grant cannot be had back, and a folder reopen needs a user gesture that
 * may be refused.
 */
const OWN_FOLDER_KEY = 'ballastella.own-folder';

/** Read one remembered name. Never throws: private mode has no storage. */
function remembered(key: string): string {
	try {
		return localStorage.getItem(key) || '';
	} catch {
		return '';
	}
}

/** The remembered Workspace name, or the default. Never throws: private mode has no storage. */
function rememberedWorkspaceName(): string {
	return remembered(OPEN_WORKSPACE_KEY) || DEFAULT_WORKSPACE_NAME;
}

/** The last Workspace of the user's own, or the default. Never throws: private mode has no storage. */
function rememberedOwnWorkspaceName(): string {
	return remembered(OWN_WORKSPACE_KEY) || DEFAULT_WORKSPACE_NAME;
}

function rememberWorkspaceName(name: string): void {
	write(OPEN_WORKSPACE_KEY, name);
}

/** Record where "back to my own Workspace" goes: a folder if it was one, otherwise a named one. */
function rememberOwnWorkspace(name: string, folderName: string): void {
	if (!folderName) write(OWN_WORKSPACE_KEY, name);
	write(OWN_FOLDER_KEY, folderName);
}

function write(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
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
	 * The mark on the Workspace that is open, or `null` when it is one of the user's own (ADR-0024).
	 *
	 * This is what the banner is drawn from, and what refuses to publish or back one up. It is read
	 * off the Workspace itself rather than kept here across a switch: a mark that lived only in this
	 * object would be lost on a reload, and a user would then be inside a throwaway Workspace with
	 * nothing on screen saying so — which is the exact failure ADR-0024 rules out by making review an
	 * action rather than a setting.
	 */
	review = $state<ReviewMark | null>(null);
	/**
	 * Which of {@link workspaces} are Review Workspaces, so the switcher can say which is which.
	 *
	 * They stay *in* the switcher rather than being filtered out of it: several may be open at once,
	 * because a teacher marking thirty submissions moves between them, and two students' conflicting
	 * Alignments of the same sheet never meet precisely because each is in its own Workspace.
	 */
	reviewWorkspaces = $state<string[]>([]);
	/**
	 * The Workspace of the user's own to go back to, which is the banner's first exit.
	 *
	 * Never a Review Workspace — see {@link OWN_WORKSPACE_KEY}. An exit that led into another review
	 * copy would be a way out of a throwaway Workspace that arrives in a different throwaway one.
	 */
	ownWorkspaceName = $state(rememberedOwnWorkspaceName());
	/**
	 * The folder the user's own Workspace is in, or `''` when it is browser storage.
	 *
	 * See {@link OWN_FOLDER_KEY}. This is what makes the banner's first exit lead back to a folder
	 * Workspace rather than into an OPFS one the user has never seen.
	 */
	ownFolderName = $state(remembered(OWN_FOLDER_KEY));
	/**
	 * A bundle being read, announced across the session swap that finishes it.
	 *
	 * ⚠ **Here rather than on the `EditorSession`, and that is why it reaches a screen at all.**
	 * `exportProject` keeps its progress on the session, which is right because an export never
	 * leaves the Workspace it is reading. Opening a bundle *replaces* the session — that is the whole
	 * of {@link openBundle} — so a transfer state kept there would be thrown away with the session
	 * that was holding it, and the closing "Opened …: N files." would be announced onto a component
	 * that had already been given a different session. The first cut passed no listener at all, so
	 * the read-path progress apparatus reached no UI whatsoever — on the path ADR-0001 makes the only
	 * way in for Firefox, Safari and iPad.
	 */
	transfer = $state<TransferState | null>(null);
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
	/**
	 * Journalled edits naming a Workspace that is not in browser storage any more (ticket 20).
	 *
	 * Reported rather than swept up, and reported *here* rather than left to replay, which only ever
	 * looks at the Workspace being opened and so would never meet one. The user is offered the
	 * discard; nothing discards it for them, because a Workspace can be absent from this list for
	 * reasons that are not "it is gone" — a folder Workspace is never in it at all.
	 */
	orphanedJournals = $state<string[]>([]);
	/** `''` when this browser can protect an edit against the tab closing, otherwise why it cannot. */
	unprotected = $state('');

	#teardownFlushOnHide: (() => void) | undefined;
	/**
	 * Where the write-ahead journal lives, resolved once for the whole app.
	 *
	 * `null` on a browser that will not give the page `localStorage` — a private window with storage
	 * blocked. Said out loud in {@link unprotected} rather than treated as normal: on such a browser
	 * an edit inside its debounce window still does not survive leaving the page, which is the whole
	 * of what ticket 20 fixed everywhere else.
	 */
	readonly #journalStorage: JournalStorage | null = browserJournalStorage();
	/**
	 * Resolves once the arriving Workspace's journalled edits have been put back (ticket 20).
	 *
	 * ⚠ **Every read of a Project waits on this, and that is a correctness requirement rather than
	 * politeness.** Opening a Project is driven by an effect over the `?p=` URL, which runs the
	 * moment the layout mounts — concurrently with the replay. Ungated, a reload landed on the
	 * Project screen showing the name the interrupted write was *replacing*: restored on disk, stale
	 * on screen, and one keystroke away from being overwritten by the very edit the journal had just
	 * rescued. Measured; it is what the first run of the new regression test found.
	 *
	 * Never rejects. A replay that failed has already reported itself, and a route that cannot open a
	 * Project because a recovery went wrong would be a worse failure than the one being recovered.
	 */
	#recovered: Promise<void>;
	#finishRecovery: () => void = () => undefined;

	constructor() {
		this.#recovered = this.#beginRecovery();
	}

	/** What a route awaits before reading a Project. See {@link WorkspaceStorage.#recovered}. */
	get recovered(): Promise<void> {
		return this.#recovered;
	}

	/**
	 * Open a fresh recovery window, and answer the promise that closes with it.
	 *
	 * Called **before** the arriving session is published, never after: the effect that opens a
	 * Project re-runs the instant `session` changes, and a window opened afterwards would be one it
	 * had already sailed past.
	 */
	#beginRecovery(): Promise<void> {
		this.#recovered = new Promise<void>((resolve) => {
			this.#finishRecovery = resolve;
		});
		return this.#recovered;
	}

	/** Begin. Returns its own teardown, for the effect that created it. */
	start(): () => void {
		this.canChooseFolder = isFolderWorkspaceSupported();
		this.#teardownFlushOnHide = this.session.installFlushOnHide();
		if (this.#journalStorage === null) {
			this.unprotected =
				`This browser is not letting Ballastella keep a copy of an edit while it is being ` +
				`saved, so an edit made in the last moment before you close this tab may not be kept. ` +
				`Wait for the indicator to read “Saved” before you leave. Allowing site data for this ` +
				`page — usually blocked in a private window — turns the protection back on.`;
		}
		// The Workspace the session was already built for, made real: the store creates its directory at
		// the first write, so without this a Workspace nobody has typed into yet is missing from its own
		// switcher. Then the list, so the switcher has something to switch between.
		//
		// The journal replay is chained onto it (ticket 20) rather than run beside it: putting an
		// unfinished edit back is a *write*, and it belongs after the directory it writes into exists.
		// It also refreshes the Project list when it changed anything, so the hub shows the restored
		// name rather than the one the interrupted write was replacing.
		void ensureOpfsWorkspace(this.workspaceName)
			// ⚠ **The first load never goes through `#adopt`** — the session is built in the field
			// initialiser from the remembered name — so without this the one case the mark exists for is
			// the one it misses: a user who closed the tab inside a review copy and opened it again. The
			// banner would be absent on exactly the screen they most need it on.
			.then(async () => {
				this.review = await this.#markOf(this.session.store);
				// And, when it turns out to be one of the user's own, it is the Workspace the banner's
				// first exit goes back to. `#adopt` records that on every switch, but the Workspace a
				// visit *starts* in never goes through it — so without this line a user who opened a
				// bundle in their first session and then reloaded would be sent "back" to the default
				// Workspace rather than to the one they were actually in.
				//
				// A visit always starts in browser storage — a folder grant needs a gesture — so being
				// here *is* being in a browser-backed Workspace of one's own, and the remembered folder
				// stops being where "back to my Workspace" goes. A reload **inside a review copy** takes
				// neither branch, which is what keeps a folder-Workspace user's exit pointing at their
				// folder across the reload the banner exists to survive.
				//
				// ⚠ **In memory only — nothing is written here.** ADR-0010: merely opening a Project must
				// not modify a byte, and `editor-opening-view.e2e.ts`'s "writes nothing at all" holds
				// `localStorage` to that as well as OPFS. A `setItem` on load is exactly the shape of write
				// that test exists to catch, and it caught this one. Persisting is `#adopt`'s job, which
				// only ever runs from something the user did.
				if (this.review === null) {
					this.ownWorkspaceName = this.workspaceName;
					this.ownFolderName = '';
				}
			})
			.then(() => this.#replayAndReport())
			.catch(() => undefined)
			// Before the Workspace listing, which is not something a Project read has to wait for.
			.finally(() => this.#finishRecovery())
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

	/**
	 * The mark on a store, with an unreadable answer kept rather than turned into "your own".
	 *
	 * `readReviewMark` already treats an unreadable *file* as a mark; this covers the store itself
	 * being unreachable, where the honest answer is "unchanged" rather than "not a review copy". The
	 * failure to avoid on both paths is the same one: a scholar doing an afternoon's real work inside
	 * a Workspace built to be thrown away.
	 */
	async #markOf(store: ProjectStore): Promise<ReviewMark | null> {
		return readReviewMark(store).catch(() => this.review);
	}

	/** Reload the switcher's list. Cheap: one `entries()` of the OPFS root, no descent. */
	async refreshWorkspaces(): Promise<void> {
		this.workspaces = await listOpfsWorkspaces().catch(() => this.workspaces);
		// One small `read` per Workspace, never a walk: the mark is a single file at the root, and the
		// switcher has to be able to say which of these a user is about to step into.
		//
		// ⚠ **A Workspace whose mark cannot be read is treated as a review copy**, which is what the
		// `catch` returns rather than what it used to: `.catch(() => null)` said the opposite of the
		// sentence above it, and answered "one of your own" for a Workspace nothing could be read from
		// at all. `readReviewMark` already takes this direction for an unreadable *file*; this is the
		// same rule for an unreadable store, and it is ticket 20's "unreadable is not absent". The
		// failure it avoids is the one ADR-0024 exists to rule out: an afternoon's real work done
		// inside a Workspace built to be thrown away, because the switcher said it was the user's own.
		const isReviewCopy = async (name: string): Promise<boolean> => {
			try {
				return (await readReviewMark(openOpfsWorkspace(name))) !== null;
			} catch {
				// ⚠ **Not reached today, and saying so is better than implying a test covers it.**
				// `readReviewMark` already turns *every* read failure into a mark rather than rejecting,
				// and `openOpfsWorkspace` does not throw on construction, so nothing in the current OPFS
				// adapter gets here. It is kept — pointing the way the sentence above points — because the
				// alternative is a `catch` that answers "one of your own" for a Workspace nothing could be
				// read from, which is the one wrong answer this whole rule exists to avoid.
				return true;
			}
		};
		this.reviewWorkspaces = (
			await Promise.all(
				this.workspaces.map(async (name) => ((await isReviewCopy(name)) ? name : ''))
			)
		).filter((name) => name !== '');
		// Here rather than beside the replay, because "which Workspaces exist" is the answer the
		// orphan check is *against* — computed before this listing it reported every Workspace but
		// the open one as orphaned, which is a warning about nothing on every first load.
		this.refreshOrphanedJournals();
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
		await this.#switchTo(name);
		await this.refreshWorkspaces();
	}

	/**
	 * The switch itself, without publishing a listing.
	 *
	 * Split out for {@link discardReview}, which leaves a Workspace it is **about to delete** and has
	 * already withdrawn from {@link workspaces}. Going through the public {@link openWorkspace} there
	 * put the doomed name straight back on the switcher — `listOpfsWorkspaces` still returns it,
	 * because the directory is not removed until the leave is over — and one click on it in that
	 * window ran `ensureOpfsWorkspace`, which creates, against a directory being removed. So the
	 * listing happens once, after the deletion.
	 */
	async #switchTo(name: string): Promise<void> {
		if (this.isOpen(name)) return;
		this.problem = '';
		const opened = await ensureOpfsWorkspace(name);
		await this.#adopt(openOpfsWorkspace(opened), 'browser', '', opened);
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
	 * **Refuses the one that is open**, in {@link #removeWorkspace} rather than here and rather than
	 * only in the dialog that asks. Deleting the Workspace out from under a live `EditorSession`
	 * leaves an `Autosave` whose next flush recreates the directory — the store's resolver has
	 * `create: true` — so the user would watch their Workspace come back holding one file. A guard
	 * that lives only in markup is one route away from being absent, and a guard that lives on one
	 * *method* is one caller away from it: {@link discardReview} removes a Workspace without coming
	 * through here at all, which is exactly the route that found this.
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
		await this.#removeWorkspace(name);
		await this.refreshWorkspaces();
	}

	/**
	 * The removal itself, without publishing a listing. See {@link #switchTo} for why that is split.
	 *
	 * ⚠ **The "not the open one" guard lives here, on the deletion, not on the public method above.**
	 * It was on {@link deleteWorkspace}, and {@link discardReview} — the second caller, added later —
	 * went straight past it: it deletes the Workspace it has just left, and relies on the leaving
	 * having worked. There is a reachable arrangement where it does not (see {@link #leaveReview}),
	 * and the consequence is the precise failure the paragraph on {@link deleteWorkspace} describes,
	 * arriving through the one route that could not read it. A guard on the operation cannot be got
	 * round by adding a caller.
	 */
	async #removeWorkspace(name: string): Promise<void> {
		if (this.isOpen(name)) {
			throw new Error(
				`“${name}” is the Workspace you are in, so it cannot be deleted from inside itself. ` +
					`Switch to another Workspace first.`
			);
		}
		await deleteOpfsWorkspace(name);
		// Its journalled edits go with it (ticket 20). Without this they survive the Workspace, become
		// orphans nothing will ever replay, and — if a Workspace of the same name is made later — are
		// put back into somebody else's work under a name they happened to reuse.
		//
		// **And its unfinished deletions, for the same reason and with more force** (ticket 21, review
		// 2). The records have the same key shape and the same reuse hazard, and their effect is
		// *destructive* rather than additive: a record left behind by a Workspace called "Marking
		// 2026" is a standing instruction to delete a folder name inside whatever "Marking 2026" is
		// made next. They were swept by nothing.
		if (this.#journalStorage) {
			discardJournal(this.#journalStorage, opfsWorkspaceKey(name));
			discardDeletions(this.#journalStorage, opfsWorkspaceKey(name));
		}
	}

	/** What a Workspace weighs, so the confirmation can say what is about to go. `list` + `size`. */
	async sizeOfWorkspace(name: string): Promise<WorkspaceSize> {
		return workspaceSize(openOpfsWorkspace(name));
	}

	/**
	 * Write the open Workspace to one tar and hand it to the user (ticket 13, SPEC stories 82–83).
	 *
	 * **Flushed first**, for the same reason `exportProject` flushes: a debounced rename or an
	 * annotation edit still sitting in the `Autosave` queue is work the user has done, and a backup
	 * taken around it is a backup missing the last thing they typed.
	 *
	 * Works on both backings. A folder Workspace can already be copied by hand — that is the whole
	 * point of it — but a scholar who moves between a folder at work and a browser at home needs the
	 * archive from both ends, and refusing here would make the feature depend on which machine they
	 * happened to be at.
	 */
	async backUp(onProgress?: TransferProgressListener): Promise<WorkspaceBackup> {
		// ADR-0024: a Review Workspace is never backed up. It is somebody else's work, held in a
		// Workspace built to be thrown away, and an archive of it in the user's Downloads folder is
		// indistinguishable from a backup of their own — which is how a review copy comes to be restored
		// months later as though it were theirs. Refused here rather than only hidden in the markup: a
		// guard that lives in a component is one route away from being absent.
		this.assertNotReviewing('backed up');
		await this.session.flush().catch(() => undefined);
		const backup = await exportWorkspaceTar(this.session.store, this.name, { onProgress });
		await saveFile(backup.fileName, backup.body);
		return backup;
	}

	/**
	 * Read a backup into a **new** named Workspace, and switch to it (SPEC stories 84–87).
	 *
	 * ⚠ **Always a browser-storage Workspace, whatever the current backing is**, and that is a
	 * decision rather than a limitation. ADR-0024 requires that restore never overwrite and never
	 * merge, which means it needs somewhere new to put things; browser storage can make that by
	 * itself, and a folder cannot — a second folder needs a second picker gesture, and a
	 * subdirectory of the *current* folder would be a Workspace inside a Workspace, which is
	 * precisely the containment failure ticket 12 removed. So a folder-Workspace user restoring a
	 * backup lands in a browser Workspace beside it, with their folder untouched, and can copy it
	 * out from there.
	 *
	 * The quota check happens inside `restoreWorkspaceTar`, before the Workspace is created, against
	 * the file's own size — which is an honest number because nothing in a tar is compressed.
	 */
	async restoreFrom(file: File, onProgress?: TransferProgressListener): Promise<WorkspaceRestore> {
		const restored = await restoreWorkspaceTar(
			file.stream(),
			(preferred) => this.#makeRestoreDestination(preferred),
			{
				archiveBytes: file.size,
				estimateStorage: estimateStorage,
				onProgress
			}
		);
		// Only once the restore has succeeded. Switching first would leave the user looking at a
		// half-written Workspace if it then failed, and `#adopt` tears down the session they are in.
		await this.openWorkspace(restored.workspaceName);
		return restored;
	}

	/**
	 * Open a Project somebody sent, into a **new Review Workspace**, and switch to it (SPEC 90–92).
	 *
	 * ⚠ **There is no other destination, and that is the whole design rather than a limitation.**
	 * Under ADR-0023 there is exactly one Alignment per Historical Map in a Workspace, so opening a
	 * colleague's bundle into the user's own would either overwrite an Alignment two of their Projects
	 * are drawn by, or be refused. ADR-0024's answer is that neither happens: a bundle lands in a
	 * throwaway Workspace of its own, several of which may exist at once, and two students' conflicting
	 * Alignments of the same sheet never meet. There is deliberately no promotion out of one — no "keep
	 * this", no "copy to my Workspace" — because that is the collision arriving by another route.
	 *
	 * **Always a browser-storage Workspace, whatever the current backing is**, for the reason
	 * {@link restoreFrom} gives: browser storage can make a new Workspace by itself and a folder
	 * cannot, and a subdirectory of the current folder would be a Workspace inside a Workspace.
	 *
	 * The quota check happens inside `openProjectBundle`, before the Workspace is created, against the
	 * file's own size — an honest number because nothing in a tar is compressed.
	 *
	 * ⚠ **The progress is announced from here, into {@link transfer}.** A bundle of an offline copy's
	 * pyramid takes real seconds to tens of seconds, and this is the path ADR-0001 makes the *only*
	 * way in on Firefox, Safari and iPad — so a still screen with nothing said is where a scholar
	 * concludes the tool has hung. The first cut wired no listener at all, which left the whole
	 * read-path progress apparatus reaching no UI. See {@link transfer} for why it does not live on
	 * the `EditorSession` the way an export's does.
	 */
	async openBundle(file: File, onProgress?: TransferProgressListener): Promise<OpenedBundle> {
		// The file's own name until `project.json` has been read, because there is nothing else to call
		// it yet: a bundle carries no Project name until its manifest arrives, which is the last entry
		// held back. Named after what the user picked is what they will recognise.
		const announce = (files: number, totalFiles: number, subject: string, finished: boolean) => {
			this.transfer = { kind: 'open', subject, files, totalFiles, finished };
		};
		try {
			const opened = await openProjectBundle(
				file.stream(),
				(preferred) => this.#makeReviewDestination(preferred),
				{
					fileName: file.name,
					archiveBytes: file.size,
					estimateStorage: estimateStorage,
					onProgress: (progress) => {
						announce(progress.files, progress.totalFiles, file.name, false);
						onProgress?.(progress);
					}
				}
			);
			// Only once the bundle has been read. Switching first would leave the user looking at a
			// half-written Workspace if it then failed, and `#adopt` tears down the session they are in.
			await this.openWorkspace(opened.workspaceName);
			announce(opened.totalFiles, opened.totalFiles, opened.project.name || opened.directory, true);
			return opened;
		} catch (cause) {
			// A refusal has left nothing behind, so the progress line must not be left mid-count saying
			// a bundle is still being read. The message the user needs is the refusal, which the hub
			// renders as an alert.
			this.transfer = null;
			throw cause;
		}
	}

	/** A brand new browser-storage Review Workspace near `preferred`, and the way to throw it away. */
	async #makeReviewDestination(preferred: string): Promise<ReviewDestination> {
		// `createOpfsWorkspace` rather than `ensureOpfsWorkspace`, for the reason the restore
		// destination gives and one more: a teacher opening thirty submissions named after the same
		// assignment needs thirty Workspaces, not one opened thirty times.
		const name = await createOpfsWorkspace(preferred);
		return {
			name,
			store: openOpfsWorkspace(name),
			discard: async () => {
				await deleteOpfsWorkspace(name);
				await this.refreshWorkspaces();
			}
		};
	}

	/**
	 * Leave the review copy for the Workspace of the user's own they came from (workspace-and-layers SPEC story 93).
	 *
	 * The review copy is left exactly as it is: this is "put it down", not "finish with it". A teacher
	 * moving between thirty submissions uses this one constantly and must not have to reopen a file
	 * each time.
	 *
	 * The destination is never a Review Workspace. Where a browser-storage one has since been deleted,
	 * `openWorkspace` recreates it — an empty Workspace under a name the user recognises is a better
	 * landing than a second review copy or a refusal.
	 *
	 * ⚠ **A folder Workspace is gone back *to*, not replaced by an OPFS namesake.** When the user's
	 * own Workspace is a folder ({@link ownFolderName}), this reopens it — which is why it must be
	 * called from a click or a keypress, as both of the banner's exits are: `requestPermission()`
	 * needs transient user activation (ADR-0012). The first cut recorded "own" only for browser
	 * backings, so a folder-Workspace user pressing this exit landed in an OPFS Workspace called "My
	 * Workspace" that this method had just created, under a banner announcing they were back in their
	 * own. Their work was in the folder, off screen, and nothing said so.
	 *
	 * A refused or withdrawn grant falls back to the remembered browser Workspace rather than leaving
	 * the user inside the review copy, and `problem` says why the folder was not reopened — the same
	 * bargain {@link reopenFolder} already makes everywhere else.
	 */
	async leaveReview(): Promise<void> {
		await this.#leaveReview();
		await this.refreshWorkspaces();
	}

	/**
	 * Leaving without publishing a listing, so {@link discardReview} can list once at the end.
	 *
	 * ⚠ **It has to actually leave, and there is a reachable arrangement where the obvious switch is a
	 * no-op.** `#switchTo` returns at once when the destination is already open, and the destination
	 * *can be the review copy's own name*: a user in browser Workspace "assignment 7" switches to a
	 * folder — which carries `ownWorkspaceName` across unchanged — deletes the now-unopened OPFS
	 * "assignment 7" from settings, and opens `assignment 7.project.tar`, whose review copy takes the
	 * name that has just come free. Pressing Discard with the folder grant refused then left the
	 * review copy open, and the removal that follows deleted a Workspace with a live `EditorSession`
	 * on it — the failure {@link #removeWorkspace}'s guard exists for, reached from the one caller
	 * that used to bypass it. So when the name is taken by the Workspace being left, a **new** one
	 * near it is made instead: a suffixed empty Workspace of the user's own is the same bargain this
	 * method already strikes when their own has been deleted, and it is the only landing available
	 * that is neither the review copy nor a refusal to leave it.
	 */
	async #leaveReview(): Promise<void> {
		// The folder's refusal, carried across the fallback switch below — `#switchTo` clears `problem`,
		// so without this the reason the folder was not reopened was wiped by the very step that made it
		// matter, and the docstring above promising it was said was false.
		let folderProblem = '';
		if (this.ownFolderName) {
			await this.reopenFolder();
			folderProblem = this.problem;
			if (this.backing === 'folder') {
				// ⚠ **`workspaceName` is carried across a folder adopt unchanged, and coming out of a
				// review copy that is the one thing it must not be.** It is "where a switch back to
				// browser storage goes", and left pointing at the review copy it would send
				// {@link useBrowserStorage} back into the Workspace the user has just left — or, after a
				// discard, recreate the empty directory of one that has just been deleted.
				this.workspaceName = this.ownWorkspaceName;
				rememberWorkspaceName(this.ownWorkspaceName);
				return;
			}
		}
		await this.#switchTo(
			this.isOpen(this.ownWorkspaceName)
				? await createOpfsWorkspace(this.ownWorkspaceName)
				: this.ownWorkspaceName
		);
		if (folderProblem) this.problem = folderProblem;
	}

	/**
	 * Throw the open review copy away, and go back to the user's own Workspace (workspace-and-layers SPEC story 94).
	 *
	 * **Refuses anything that is not a Review Workspace**, here rather than only in the dialog that
	 * asks. This deletes a Workspace and everything in it, and the only thing standing between that and
	 * a user's own research is which Workspace is open — a check that lives in markup is one route away
	 * from being absent, which is the argument {@link deleteWorkspace} already makes about itself.
	 *
	 * The order is leave, then delete, and it cannot be the other way round: deleting the Workspace out
	 * from under a live `EditorSession` leaves an `Autosave` whose next flush recreates the directory,
	 * which is what {@link #removeWorkspace}'s guard refuses for — and, since that guard is on the
	 * removal rather than on the public delete, what this method is held to as well rather than merely
	 * trusted about.
	 *
	 * ⚠ **The doomed name is withdrawn from {@link workspaces} first, and re-listed only after the
	 * deletion.** `NavigationBar` renders that field on every screen, so between the leave and the
	 * removal the switcher offered a Workspace whose directory was being deleted — and switching
	 * *creates*, so one click in that window raced a `getDirectoryHandle({ create: true })` against a
	 * `removeEntry` on the same directory, leaving the user in a Workspace made of whatever survived.
	 * Withdrawing it here closes that: `workspaces` is the only thing either the switcher or Workspace
	 * settings offers, so from the first line of this method there is no control anywhere on screen
	 * that opens the Workspace being discarded.
	 *
	 * Narrower than it sounds and worth being exact about: nothing here reaches a *second tab*, which
	 * has its own listing and no way to hear about this one, for the reason {@link deleteWorkspace}
	 * gives at length. What is closed is every route in this tab.
	 *
	 * Publishing the listing once, at the end, is the other half — going out through the public
	 * `openWorkspace` put the name straight back from OPFS, which still holds it.
	 */
	async discardReview(): Promise<void> {
		refuseOutsideReview(this.name, this.review);
		const discarding = this.workspaceName;
		this.workspaces = this.workspaces.filter((name) => name !== discarding);
		this.reviewWorkspaces = this.reviewWorkspaces.filter((name) => name !== discarding);
		await this.#leaveReview();
		await this.#removeWorkspace(discarding);
		await this.refreshWorkspaces();
	}

	/**
	 * Refuse an action a Review Workspace does not get, in the words the user should see.
	 *
	 * ⚠ **The sentence is core's** (workspace-and-layers SPEC story 111). It was spelled out here, and
	 * a message with no test seam under it is a message that drifts: publishing and backing up are
	 * refused for the same reason and the user is owed the same explanation. `assertNotReviewing` also
	 * guards `exportWorkspaceTar` itself, so deleting the call below changes when the message arrives
	 * rather than whether the rule holds — which is what a guard with two layers is supposed to mean.
	 */
	assertNotReviewing(verb: string): void {
		refuseInsideReview(this.name, this.review, verb);
	}

	/** A brand new browser-storage Workspace near `preferred`, and the way to throw it away. */
	async #makeRestoreDestination(preferred: string): Promise<RestoreDestination> {
		// `createOpfsWorkspace` rather than `ensureOpfsWorkspace`: it suffixes a taken name rather than
		// opening the existing one, which is the difference between "restore beside what I have" and
		// "restore on top of it". Restoring the same backup twice to compare them is a thing people do.
		const name = await createOpfsWorkspace(preferred);
		return {
			name,
			store: openOpfsWorkspace(name),
			// The whole directory, recursively. Available because it is new: nothing in it predates
			// this restore, so there is nothing of the user's to lose.
			discard: async () => {
				await deleteOpfsWorkspace(name);
				await this.refreshWorkspaces();
			}
		};
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
		//
		// **`capture` first, and it is not redundant** (ticket 20). The flush below may reject — an
		// unreachable folder is the common reason for switching at all — and its bytes then stay
		// pending against a session that is about to be discarded. Captured, they are in the leaving
		// Workspace's own journal and are put back the next time that Workspace is opened.
		leaving.capture();
		await leaving.flush().catch(() => undefined);
		this.#teardownFlushOnHide?.();

		const arriving = new EditorSession(store, {
			...(this.#journalStorage ? { journalStorage: this.#journalStorage } : {}),
			// The key the *arriving* Workspace is, backing included — never the one being left.
			workspaceKey:
				backing === 'folder' ? folderWorkspaceKey(folderName) : opfsWorkspaceKey(workspaceName)
		});
		// ⚠ **The mark is read before `this.session` is published, and the order is the point.** The
		// banner, the Publish refusal and the backup refusal are all drawn from it, so a frame in which
		// the new session is on screen and the mark is still the *previous* Workspace's is a frame in
		// which the Publish button is offered over somebody else's work — or, switching the other way,
		// a review banner is drawn over the user's own research with a Discard button on it.
		//
		// A folder Workspace is never a review copy: a bundle only ever opens into browser storage, so
		// there is no such file to ask a folder store for.
		this.review = backing === 'folder' ? null : await this.#markOf(store);

		// Before `this.session` is published, so the route effect that re-runs on the swap waits for
		// the arriving Workspace's replay rather than reading a Project out from under it.
		this.#beginRecovery();
		this.session = arriving;
		this.backing = backing;
		this.folderName = folderName;
		this.workspaceName = workspaceName;
		rememberWorkspaceName(workspaceName);
		// ⚠ **`own` is not "browser-backed and unmarked".** A folder Workspace is *always* one of the
		// user's own — a bundle only ever opens into browser storage, so `review` is forced `null`
		// above — and the first cut's extra `backing === 'browser'` therefore recorded a
		// folder-Workspace user as never having been in one of their own at all. See
		// {@link OWN_FOLDER_KEY} for what that cost.
		const own = this.review === null;
		if (own) {
			this.ownFolderName = backing === 'folder' ? folderName : '';
			// `workspaceName` is carried across a folder adopt unchanged, so the browser Workspace the
			// user left is still the fallback when the folder grant cannot be had back.
			if (backing === 'browser') this.ownWorkspaceName = workspaceName;
			rememberOwnWorkspace(this.ownWorkspaceName, this.ownFolderName);
		}
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
		// After the sweep, so the atomic write a replay performs is not reclaimed out from under it.
		await this.#replayAndReport().catch(() => undefined);
		this.#finishRecovery();
	}

	/**
	 * Put the arriving Workspace's journalled edits back, and account for what could not be (ticket 20).
	 *
	 * The refresh is conditional on something having happened, and that is deliberate rather than an
	 * optimisation: listing a Workspace with tens of thousands of tile files in it is the expensive
	 * walk `#adopt` goes out of its way not to duplicate, and a replay that restored nothing has
	 * changed nothing to show.
	 */
	async #replayAndReport(): Promise<void> {
		const session = this.session;
		// **Before the replay, and before anything reads the Workspace** (ticket 21). A deletion is as
		// asynchronous as an edit and had none of ticket 20's protection, so a Project the user deleted
		// on the way out of the page was still on disk — and back on the hub — at the next startup.
		// Here rather than beside the replay because it is finishing something the user already asked
		// for, which has to have happened before the listing that follows can be true. `Workspace`
		// records the gesture synchronously; this is the half that could not run at the time.
		await session.finishInterruptedDeletions();
		await session.replayJournalledEdits();
		// Guarded against a switch that happened while the replay was running: refreshing a session
		// the user has already left would list a Workspace that is no longer on screen.
		if (this.session === session && session.replayReport !== null) {
			await session.refresh().catch(() => undefined);
			// The **open** Project is not re-read here; it is not read at all until this method has
			// finished, because every route waits on {@link recovered}. Re-reading afterwards would be
			// a second walk of the Workspace to fix a race that no longer exists.
		}
	}

	/**
	 * Which journalled Workspaces are not in browser storage any more.
	 *
	 * ⚠ **"Not in the list" is not "gone", which is why this only reports.** A folder Workspace never
	 * appears in `listOpfsWorkspaces` at all, so every folder key is an orphan by this test; so is a
	 * browser Workspace on a listing that failed. The report therefore names them and offers
	 * {@link discardOrphanedJournal}, and nothing here deletes anybody's unsaved edit on a guess.
	 *
	 * **Both kinds of record, not only the journal** (ticket 21, review 2). An unfinished deletion
	 * lives in the same 5 MB, under a key of the same shape, and was invisible here — so a record
	 * naming a Workspace this browser will never open again could never be seen or discarded, while
	 * the journal keys beside it could. It is also the one kind whose standing instruction is
	 * destructive, which makes it the one a user is likeliest to want to be rid of.
	 */
	refreshOrphanedJournals(): void {
		if (this.#journalStorage === null) return;
		// An array rather than a `Set`: this is a handful of names, and `svelte/prefer-svelte-reactivity`
		// rules out a plain `Set` in a `.svelte.ts` module — a `SvelteSet` for a local nothing reads
		// reactively would be the wrong answer to a rule about reactive state.
		const known = [
			...this.workspaces.map((name) => opfsWorkspaceKey(name)),
			opfsWorkspaceKey(this.workspaceName),
			...(this.folderName ? [folderWorkspaceKey(this.folderName)] : [])
		];
		// Deduplicated by hand for the reason `known` is an array: a plain `Set` is ruled out by
		// `svelte/prefer-svelte-reactivity`, and a `SvelteSet` for a handful of names nothing reads
		// reactively would be the wrong answer to a rule about reactive state.
		const held = [
			...journalledWorkspaces(this.#journalStorage),
			...workspacesWithDeletions(this.#journalStorage)
		];
		this.orphanedJournals = held
			.filter((key, index) => held.indexOf(key) === index && !known.includes(key))
			.sort((a, b) => a.localeCompare(b));
	}

	/** Throw away one orphaned Workspace's journalled edits and unfinished deletions, because the user said so. */
	discardOrphanedJournal(key: string): number {
		if (this.#journalStorage === null) return 0;
		const dropped =
			discardJournal(this.#journalStorage, key) + discardDeletions(this.#journalStorage, key);
		this.refreshOrphanedJournals();
		return dropped;
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
