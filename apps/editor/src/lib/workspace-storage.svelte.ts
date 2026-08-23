import { getContext, setContext } from 'svelte';

import {
	DEFAULT_WORKSPACE_NAME,
	FolderPermissionDeniedError,
	assertNotReviewing as refuseInsideReview,
	assertReviewing as refuseOutsideReview,
	chooseWorkspaceFolder,
	openWorkspaceFromGitHub,
	createOpfsWorkspace,
	deleteOpfsWorkspace,
	ensureOpfsWorkspace,
	exportWorkspaceTar,
	forgetWorkspaceFolder,
	ImportRecoveryFailedError,
	UpdateRefusedError,
	isFolderWorkspaceSupported,
	listOpfsWorkspaces,
	openOpfsWorkspace,
	openProjectBundle,
	allocateProjectImport,
	readReviewWorkspaceSource,
	refuseReviewDestination,
	releaseWorkspaceFolder,
	reopenRetainedWorkspaceFolder,
	retainWorkspaceFolder,
	reviewCopyStillHere,
	reviewImportOrigin,
	commitProjectImport,
	readImportEvidence,
	detachImportedProject,
	readProjectBundleSource,
	readRemoteProjectSource,
	remapProjectImport,
	serialiseProjectFile,
	readReviewMark,
	recoverProjectImport,
	recoverWorkspaceUpdate,
	rememberedFolderName,
	reopenWorkspaceFolder,
	restoreWorkspaceTar,
	reviewFromRemote,
	FileSystemAccessProjectStore,
	SynchronizationMetadata,
	Workspace,
	workspaceSize,
	requestPersistentStorage,
	browserJournalStorage,
	discardDeletions,
	discardJournal,
	browserMetadataStorage,
	confirmLegacyRemote,
	discardPublishManifest,
	discardLocalChanges,
	discardSynchronizationMetadata,
	migrateSynchronizationMetadata,
	journalledWorkspaces,
	workspacesWithDeletions,
	bindWorkspaceToRemote,
	browserCredentialStore,
	clearRemoteBinding,
	closedWhileReviewing,
	describeRemote,
	describeReviewSubject,
	readRemoteRights,
	GITHUB_API_ORIGIN,
	GITHUB_APP,
	SIGN_IN_STATE_KEY,
	authorizeUrl,
	clearGrantRecord,
	describeCallbackRefusal,
	exchangeAuthorizationCode,
	isGitHubAppConfigured,
	isGrantFresh,
	newSignInState,
	readGrantRecord,
	refreshGitHubToken,
	signInAgainMessage,
	verifySignInState,
	writeGrantRecord,
	GitHubCallbackRefusedError,
	GitHubSignInError,
	RemoteStatusChecker,
	UNCHECKED_REMOTE_STATUS,
	type CloneReference,
	type CredentialStorage,
	type CredentialStore,
	type GitHubTokenGrant,
	type SignInCallback,
	type JournalStorage,
	type ClosureFile,
	type OpenedBundle,
	type ProjectImportSource,
	type ProjectStore,
	type RemoteBindOutcome,
	type MetadataStorage,
	type RemoteRelationship,
	type SynchronizationBaseline,
	type RemoteReference,
	type RemoteRights,
	type RemoteStatusState,
	type RestoreDestination,
	type ReviewDestination,
	type ReviewMark,
	type ReviewOrigin,
	type ReviewReference,
	type ReviewedProject,
	type StoragePersistence,
	type TransferProgressListener,
	type UpdateDeletionPreview,
	type WorkspaceBackup,
	type WorkspaceRestore,
	type WorkspaceSize
} from '@ballastella/core';

import {
	EditorSession,
	folderWorkspaceKey,
	opfsWorkspaceKey,
	trackLocalChanges,
	type TransferState
} from './editor-session.svelte.js';
import { saveFile } from './save-file.js';

// ── The GitHub App sign-in's browser-side pieces (ticket 10, ADR-0031) ────────────────────────

/**
 * Where the `state` and the grant record are kept: `sessionStorage`, or nothing at all.
 *
 * A browser that will not give us storage degrades to *no App session*, which is the pasted-token
 * path — the same direction `browserCredentialStore` falls in, and for the same reason. Memory is
 * not a substitute here: the whole point of the record is to survive the redirect, and a redirect
 * is precisely what empties a variable.
 */
const signInStorage = (): CredentialStorage => {
	try {
		if (typeof sessionStorage === 'undefined') return nowhere;
		void sessionStorage.length;
		return sessionStorage;
	} catch {
		return nowhere;
	}
};

/** Where the query string the sign-in left from waits, so the open Project survives the redirect. */
const SIGN_IN_RETURN_KEY = 'ballastella.github-sign-in-return';

/**
 * Where the address the authorisation named waits, to be sent again at the exchange.
 *
 * ⚠ **The exchange must name the same `redirect_uri` the authorisation did, byte for byte**, or
 * GitHub answers `redirect_uri_mismatch` and every sign-in fails. Recomputing it on return does not
 * give the same string: by then the callback's parameters have been taken off the bar by a
 * navigation to the app's own resolved root, which normalises a pathname a deployment may well have
 * been reached by (`…/editor/index.html` becomes `…/editor/`). So the string that went out is kept,
 * and the string that went out is what comes back.
 */
const SIGN_IN_REDIRECT_KEY = 'ballastella.github-sign-in-redirect';

/** A storage that holds nothing, for a browser that will not give us one. */
const nowhere: CredentialStorage = {
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {}
};

/**
 * The sign-in's grant record, behind the same seal as the credential itself (story 40, ADR-0024).
 *
 * ⚠ **The record holds the refresh token, which outlives the eight-hour access token and can mint
 * more of them.** So it falls under the rule the credential does, and under it harder: while a
 * teacher has a submission open, the record may not be read, may not be written, and — the part only
 * a seal at the storage can prevent — may not be *spent against the broker*, which would be a
 * request leaving somebody else's Project carrying the reader's own secret. Sealed here rather than
 * at each call site for the reason `closedWhileReviewing` gives about the credential: the rule has
 * to hold for code written later that never saw it.
 *
 * The `state` and the stashed query string are deliberately **not** sealed. Neither is a credential,
 * and the sign-in a scholar starts is refused inside a review copy by the seal below it anyway.
 */
const sealedSignInStorage = (reviewing: () => boolean): CredentialStorage => ({
	getItem: (key) => (reviewing() ? null : signInStorage().getItem(key)),
	setItem: (key, value) => {
		if (!reviewing()) signInStorage().setItem(key, value);
	},
	removeItem: (key) => {
		if (!reviewing()) signInStorage().removeItem(key);
	}
});

/**
 * The address GitHub redirects back to: this page, with nothing on it.
 *
 * ⚠ **Search and hash are stripped, and that is required rather than tidy.** A GitHub App matches
 * the callback against the URL registered on the App itself, so a `?p=amsterdam-1625` left on the
 * end is a redirect URI GitHub refuses outright. The open Project is not lost by this —
 * `beginGitHubSignIn` stashes the query string and `+page.svelte` puts it back on return.
 *
 * Composed from `origin` and `pathname` rather than by emptying a `URL`, which the Svelte lint rule
 * about mutable `URL` instances refuses — and which would be a needless object either way.
 */
const callbackUri = (): string => `${globalThis.location.origin}${globalThis.location.pathname}`;

/**
 * Whose credential this is, or `''` when GitHub will not say.
 *
 * A failure here is deliberately not a failed sign-in: the token works, the publish will work, and
 * the only thing missing is a name on the bar. Refusing the whole sign-in over it would turn a
 * cosmetic outage into an unusable app.
 */
const readGitHubLogin = async (token: string): Promise<string> => {
	try {
		const response = await fetch(`${GITHUB_API_ORIGIN}/user`, {
			headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }
		});
		if (!response.ok) return '';
		const body = (await response.json()) as { login?: unknown };
		return typeof body.login === 'string' ? body.login : '';
	} catch {
		return '';
	}
};

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

/**
 * Where a Workspace can be: browser-managed storage, or a folder the user can see.
 *
 * ⚠ **Two members, and a Remote is not a third** (ADR-0032). A Workspace bound to a repository is
 * still browser-backed or folder-backed; the binding is orthogonal and lives in a document at the
 * Workspace root. A third member would mean a new case in `#adopt`, the journal keys, the switcher,
 * `reopenable`, `canChooseFolder`, and `discard` — six sites where a mistake in the journal key is
 * silent.
 *
 * **A value rather than only a type, so the rule is assertable.** A union written out as a type
 * alias cannot be checked against itself — a test naming its two members is a test of what the test
 * says — whereas this list is a thing a test can count, and every assignment in the app narrows
 * against it. A third member either fails that test or fails to compile at each of the six sites.
 */
export const WORKSPACE_BACKINGS = ['browser', 'folder'] as const;

export type WorkspaceBacking = (typeof WORKSPACE_BACKINGS)[number];

/**
 * The ordinary Workspace an Import offer named when it was opened (ADR-0037).
 *
 * ⚠ **Resolved once, when the offer opens, and carried back to the commit.** An Import copies into
 * *this* Workspace, and the sentence the offer shows says which one — so a switch between reading
 * that sentence and pressing the button must not silently redirect the copy. {@link
 * WorkspaceStorage.importBundle} compares the key it is handed against the Workspace that is open
 * and refuses rather than following the switch.
 */
export interface ImportTarget {
	/** What the offer shows the author, which is {@link WorkspaceStorage.name}. */
	readonly name: string;
	/** The Workspace itself, backing included, so a switch is a mismatch rather than a rename. */
	readonly key: string;
}

/**
 * The ordinary Workspace one Import is writing into, resolved and read once.
 *
 * ⚠ **Not always the Workspace that is open, which is why it is a value rather than `this`.** A
 * direct Import copies into the Workspace the author is looking at; a review Import copies into the
 * one the reviewer *was* looking at when they opened the review copy, which is a Workspace this tab
 * has not adopted and must not adopt until the copy has committed (ADR-0037). Everything the engine
 * needs about a destination is on this, so the two paths share one transaction and cannot come to
 * disagree about what an arriving Project is.
 */
interface ImportInto {
	/** The Workspace as the author reads it, for the result and for the refusals. */
	readonly name: string;
	readonly store: ProjectStore;
	/** Every path it holds now, walked once and used for allocation and for the Remote evidence. */
	readonly local: readonly string[];
	/** The display names its Projects already have, so an arriving one is disambiguated. */
	readonly names: readonly string[];
	readonly remote: RemoteRelationship | null;
	readonly baseline: SynchronizationBaseline | null;
	/** Make what has just arrived visible, before the finished announcement claims it has. */
	settle: () => Promise<void>;
}

/** The recorded review origin, opened but not adopted. See `WorkspaceStorage.importReview`. */
interface ReopenedOrigin {
	/** The granted folder, when the origin is one, so the switch after the commit reuses this grant. */
	readonly folder: FileSystemAccessProjectStore | null;
	readonly into: ImportInto;
}

/** What an Import put in the Workspace that was already open. */
export interface ImportedIntoWorkspace {
	/** The display name it was allocated, which is not the source's when that one was taken. */
	readonly name: string;
	/** The Project's directory, which is its identity (ADR-0008). */
	readonly directory: string;
	/** The Workspace it went into, named as the author reads it. */
	readonly workspace: string;
}

/**
 * What a review Import did, and anything it left for the reviewer to finish.
 *
 * ⚠ **`incomplete` is never a reason the copy failed.** A review Import that does not commit throws;
 * this type only exists past the commit, where the Project is durably in the author's own Workspace
 * and the only thing that can still go wrong is tidying up the review copy behind it. Rolling the
 * Import back to tidy would destroy the work the whole operation existed to keep.
 */
export interface ImportedFromReview extends ImportedIntoWorkspace {
	/** What still needs doing, in the words the reviewer should see, or `''` when nothing does. */
	readonly incomplete: string;
}

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
	 * The repository this Workspace publishes to, or `null` when it is bound to nothing (ADR-0032).
	 *
	 * Read off the Workspace itself on every switch, exactly as {@link review} is and for the same
	 * reason: the binding is a fact about the Workspace rather than about this tab, so it survives a
	 * reload, travels into a folder on disk, and comes back out of a Clone.
	 *
	 * **Orthogonal to {@link backing}.** A Workspace in browser storage and a Workspace in a folder
	 * may each have one, and nothing on this path asks which — `WorkspaceBacking` stays a two-member
	 * union and gains no third member (ADR-0032).
	 */
	remote = $state<RemoteRelationship | null>(null);
	/**
	 * What this installation last saw shared between this Workspace and its Remote, or `null` for
	 * `Cannot tell` (ADR-0038).
	 *
	 * ⚠ **`null` is a determination, not an absence of one.** It is what absence, corruption, a record
	 * naming another repository, and a Baseline the browser refused to keep all read as, and every one
	 * of them means the same thing to a reader: nothing here can say how the two sides differ.
	 */
	baseline = $state<SynchronizationBaseline | null>(null);
	/**
	 * What the Remote Status control shows: the last determination, when it was reached, whether a
	 * check is running, and any failure since (ticket 12).
	 *
	 * ⚠ **Separate from {@link EditorSession.saveState}, which is the whole point of it.** "Saved
	 * locally" is a fact about this machine and says nothing about whether GitHub agrees; a scholar
	 * who reads the one as the other publishes over a colleague's afternoon (SPEC story 111).
	 */
	remoteStatusState = $state<RemoteStatusState>(UNCHECKED_REMOTE_STATUS);
	/**
	 * An Update from GitHub in flight, as files done out of files planned, or `null` for none.
	 *
	 * ⚠ **Here rather than in {@link transfer}, which the hub owns.** The Update control lives on the
	 * navigation bar and is therefore on every screen, so its progress has to be renderable beside it
	 * — an author who starts an Update and walks into a Project must not lose sight of a transfer that
	 * is rewriting files underneath them.
	 */
	updateProgress = $state<{ files: number; totalFiles: number } | null>(null);
	/** What the last Update did, in the words a scholar reads, or `''`. */
	updateNotice = $state('');
	/**
	 * Why the last Update did not happen, or `''`.
	 *
	 * Kept apart from {@link updateNotice} because they are announced differently: a refusal is
	 * inserted at the moment its text first exists and is owed an alert, and a success is a polite
	 * report of something the author was watching.
	 */
	updateFailure = $state('');
	/**
	 * A v1 `remote.json` this installation cannot corroborate, waiting to be confirmed or declined.
	 *
	 * ⚠ **Not a Remote.** SPEC: *"A legacy binding without corroborating installation-local evidence
	 * requires explicit confirmation."* The binding is a file inside the published tree, so a fork, a
	 * colleague's copied folder and a restored Backup all carry one naming somebody else's repository
	 * — and lifting it silently would aim a Publish button at a repository the author has never seen.
	 *
	 * Held for the length of the session rather than written down: declining is an answer about this
	 * visit, and the record that would make it permanent is the confirmation itself.
	 */
	legacyRemote = $state<RemoteRelationship | null>(null);
	/**
	 * Whether a push credential is held right now.
	 *
	 * Mirrored into reactive state rather than read from {@link #credentials} in the markup, because
	 * the store is deliberately not reactive — it is an interface over web storage, and ticket 10
	 * puts a second implementation behind it. Refreshed wherever either half of the answer can
	 * change: a sign-in, a sign-out, and **every switch**, since the store is sealed inside a Review
	 * Workspace and unsealed on the way out of one.
	 */
	signedIn = $state(false);
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
	/**
	 * Why this Workspace is not available, because an interrupted Import could not be resolved
	 * (ticket 05).
	 *
	 * ⚠ **Not a notice beside a Workspace that opened anyway.** An Import writes its provisional files
	 * at ordinary Workspace paths under one durable marker, so while that marker is unresolved *every*
	 * reader would see them — the Project list is whichever directories hold a `project.json`, and
	 * Workspace size, Backup and Publish all walk `list`. `recoverProjectImport` resolves the marker
	 * before anything asks the Workspace a question; when it cannot, this is set and
	 * {@link recovered} is never resolved, so nothing enumerates and the routes render this instead of
	 * a Project list that would be a lie.
	 *
	 * The marker is left exactly where it is, which is the durable evidence the next visit retries
	 * from — so the recovery offered here is a reload.
	 */
	unrecoveredImport = $state('');
	/**
	 * Why this Workspace is not available, because an interrupted Update could not be resolved
	 * (ticket 15).
	 *
	 * {@link unrecoveredImport}'s twin, and for the identical reason: an Update writes the Remote's
	 * bytes at ordinary Workspace paths and removes others, all under one durable marker, so while
	 * that marker is unresolved every reader would see a Project list assembled out of two states —
	 * the Project the Update was removing still listed, the one it was adding half there. SPEC story
	 * 141 is that either the complete inbound change set is visible or the old Workspace is, and the
	 * way that is kept true for a reader is that nothing enumerates until the marker is gone.
	 *
	 * Read through {@link unavailable}, which is what every guard and every route consults: the two
	 * unresolved transactions differ in which engine left them and in nothing a caller cares about.
	 */
	unrecoveredUpdate = $state('');

	/**
	 * Why this Workspace may not be enumerated, opened, backed up or published at all, or `''`.
	 *
	 * ⚠ **One question with two answers, deliberately asked once.** An Import (ticket 05) and an
	 * Update (ticket 15) both leave provisional state at ordinary Workspace paths under a durable
	 * marker, and a guard that consulted one of them was a guard that let the other through — which is
	 * a Project list, a Backup or a Publish over half a transfer.
	 */
	get unavailable(): string {
		return this.unrecoveredImport || this.unrecoveredUpdate;
	}

	/**
	 * The deletions an Update is waiting to be told about, or `null` when it is not (story 126).
	 *
	 * ⚠ **State rather than a callback into a component**, because the transfer outlives the screen it
	 * was started from: the Update control is on the navigation bar, and an author who starts one and
	 * walks into a Project must still be the one asked. Whatever renders this owns answering it, and
	 * {@link answerDeletionPreview} is the only way to answer.
	 */
	deletionPreview = $state<UpdateDeletionPreview | null>(null);

	#teardownFlushOnHide: (() => void) | undefined;
	/**
	 * The granted folder behind the open Workspace, or `null` while it is browser-backed.
	 *
	 * ⚠ **The raw store, kept because the handle is the only durable name a folder has.** What the
	 * session holds is that store wrapped in the local-change index, and a wrapper has no `folder` on
	 * it; what {@link reopenable} holds is a *name*, which two folders may share and which survives a
	 * folder being deleted and another made in its place. A Review Workspace opened from a folder has
	 * to be able to ask for that exact folder again (ADR-0037), and this is what it retains a grant
	 * from.
	 */
	#folderStore: FileSystemAccessProjectStore | null = null;
	/**
	 * The Remote Status checker of the Workspace that is open, or `null` while nothing is bound.
	 *
	 * ⚠ **One per Workspace, replaced on every switch, and the old one closed.** A listing of a large
	 * tree takes seconds, and a click switches Workspace in one of them — so a result arriving
	 * afterwards would render one Workspace's drift beside another's name. Closing makes every
	 * completion still in flight a no-op, which is the same per-Workspace keying
	 * `SynchronizationMetadata` and the write index already have.
	 */
	#statusChecker: RemoteStatusChecker | null = null;
	/** Whatever is waiting on {@link deletionPreview}, or `null`. See {@link answerDeletionPreview}. */
	#answerDeletion: ((confirmed: boolean) => void) | null = null;
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
	 * Where this installation's synchronization metadata lives, resolved once for the whole app
	 * (ADR-0038).
	 *
	 * IndexedDB rather than `localStorage`, because a Baseline for a Workspace of 40 000 files is a
	 * couple of megabytes against an origin-wide 5 MB budget the journal already shares — which is how
	 * the v1 manifest came to be lost *after* a publish had reached GitHub.
	 */
	readonly #metadataStorage: MetadataStorage | null = browserMetadataStorage();
	/**
	 * The push credential, sealed while a Review Workspace is open (ADR-0033, story 40).
	 *
	 * ⚠ **Not on the `EditorSession` and not in the `ProjectStore`.** A token inside the Workspace
	 * would be walked by `exportWorkspaceTar` into a Backup the user mails to a colleague, copied
	 * into the write-ahead journal, and uploaded by the first Publish. It is here, behind an
	 * interface, so that ticket 10's broker-exchanged token is a swap rather than a second path.
	 *
	 * The seal is a wrapper rather than a check at each caller, because it has to hold for code
	 * written later that never saw the rule: while a review copy is open this answers `null` to every
	 * read and writes nothing, so a teacher opening a student's submission cannot reach their own
	 * credential from inside it by any route.
	 */
	readonly #credentials: CredentialStore = closedWhileReviewing(
		() => this.review !== null,
		browserCredentialStore()
	);
	/** The grant record's storage, sealed by the same question — see {@link sealedSignInStorage}. */
	readonly #grants: CredentialStorage = sealedSignInStorage(() => this.review !== null);
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

	/**
	 * Resolve an outstanding Project Import, or leave this Workspace unavailable (ticket 05).
	 *
	 * `false` is not "it failed" so much as "nothing may read this Workspace": the marker is left
	 * exactly where it is, which is the durable evidence the next visit retries from, and
	 * {@link unavailable} is what the routes render instead of a Project list.
	 *
	 * Cleared first, so a second Workspace's answer is never the first's.
	 */
	async #recoverImport(store: ProjectStore): Promise<boolean> {
		this.unrecoveredImport = '';
		try {
			await recoverProjectImport(store);
			return true;
		} catch (cause) {
			// ⚠ **A Workspace that cannot be reached at all is not an Import that will not recover.**
			// `readImportTransaction` answers "unreadable" for a backing that is down as well as for a
			// marker that will not parse, deliberately — the safe direction there is to keep a Workspace
			// shut. But at this level the two have different recoveries: a moved or unplugged folder is
			// already a state this app renders, with a picker or a locate-again beside it, and relabelling
			// it as an unfinished Import would take that way back off the screen and offer a reload
			// instead. So the backing is asked directly, and only a Workspace that answers is one this
			// may draw a conclusion about.
			if (
				!(await store
					.list('')
					.then(() => true)
					.catch(() => false))
			)
				return true;
			this.unrecoveredImport =
				cause instanceof ImportRecoveryFailedError
					? cause.message
					: `This Workspace could not be opened, because an Import that did not finish could not ` +
						`be cleared up: ${cause instanceof Error ? cause.message : String(cause)}`;
			return false;
		}
	}

	/**
	 * Resolve an outstanding Update, or leave this Workspace unavailable (ticket 15).
	 *
	 * {@link WorkspaceStorage.#recoverImport}'s twin, and the two are always run as a pair: either
	 * marker unresolved means nothing may read the Workspace, and there is no order in which one of
	 * them is safe to skip. The backing is asked directly for the same reason it is there — an
	 * unreachable folder is a state this app already renders, with a way back on the screen, and
	 * relabelling it as an unfinished Update would take that away and offer a reload instead.
	 */
	async #recoverUpdate(store: ProjectStore): Promise<boolean> {
		this.unrecoveredUpdate = '';
		try {
			await recoverWorkspaceUpdate(store);
			return true;
		} catch (cause) {
			if (
				!(await store
					.list('')
					.then(() => true)
					.catch(() => false))
			)
				return true;
			this.unrecoveredUpdate =
				cause instanceof UpdateRefusedError
					? cause.message
					: `This Workspace could not be opened, because an Update from GitHub that did not ` +
						`finish could not be cleared up: ${cause instanceof Error ? cause.message : String(cause)}`;
			return false;
		}
	}

	/**
	 * Resolve both kinds of unfinished transfer, in the order they were written.
	 *
	 * The Import first, because it is the older machinery and because an Import that cannot be
	 * resolved shuts the Workspace anyway — running the Update recovery over it would be reading a
	 * Workspace this app has already decided it may not read.
	 */
	async #recoverTransfers(store: ProjectStore): Promise<boolean> {
		if (!(await this.#recoverImport(store))) return false;
		return this.#recoverUpdate(store);
	}

	/** Begin. Returns its own teardown, for the effect that created it. */
	start(): () => void {
		this.canChooseFolder = isFolderWorkspaceSupported();
		this.#teardownFlushOnHide = this.session.installFlushOnHide();
		// ⚠ **Window focus, because that is when a Remote has had time to change.** An out-of-band
		// commit — a colleague publishing, an edit made on github.com — happens while this tab is not
		// the one being looked at, so coming back to it is the one moment worth spending a request on.
		// A timer would spend them while nobody is reading; `RemoteStatusChecker` bounds the rate,
		// because switching back from a facsimile viewer is not a rare event.
		const onFocus = (): void => {
			void this.#statusChecker?.check('focus');
		};
		window.addEventListener('focus', onFocus);
		if (this.#journalStorage === null) {
			this.unprotected =
				`This browser is not letting Ballastella keep a copy of an edit while it is being ` +
				`saved, so an edit made in the last moment before you close this tab may not be kept. ` +
				`Wait for the indicator to read “Saved locally” before you leave. Allowing site data for ` +
				`this page — usually blocked in a private window — turns the protection back on.`;
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
			// ⚠ **First, before anything at all asks this Workspace a question** (ticket 05). An Import
			// that did not finish left its provisional files at ordinary Workspace paths under one
			// durable marker, and until that marker is resolved every reader would see them — the review
			// mark, the Remote, the journal replay, the interrupted deletions and the route's own Project
			// read all included. `false` means it could not be resolved, and then none of them run.
			.then(() => this.#recoverTransfers(this.session.store))
			// ⚠ **The first load never goes through `#adopt`** — the session is built in the field
			// initialiser from the remembered name — so without this the one case the mark exists for is
			// the one it misses: a user who closed the tab inside a review copy and opened it again. The
			// banner would be absent on exactly the screen they most need it on.
			.then(async (available) => {
				if (!available) return false;
				this.review = await this.#markOf(this.session.store);
				// Both facts about the arriving Workspace, read in the same breath as the mark and for
				// the same reason: the first load never goes through `#adopt`, so a binding read only
				// there would be missing on exactly the screen a reload lands on.
				await this.#readRemote(this.session.store, this.session);
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
				await this.#replayAndReport();
				return true;
			})
			// An unresolved Import is the **only** failure that withholds `recovered`: everything else
			// on this chain has already reported itself, and a route left waiting for ever over a
			// Remote that would not read would be a worse failure than the one being recovered.
			.catch(() => this.unavailable === '')
			.then((available) => {
				if (!available) return undefined;
				// Before the Workspace listing, which is not something a Project read has to wait for.
				this.#finishRecovery();
				return this.refreshWorkspaces();
			})
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
			window.removeEventListener('focus', onFocus);
			this.#statusChecker?.close();
			this.#statusChecker = null;
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
			this.#folderStore = store;
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
			this.#folderStore = store;
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
			// **And what this machine last saw on that Workspace's Remote** (ticket 04, ADR-0033). The
			// same key shape and the same reuse hazard: left behind, it is this browser's claim about a
			// repository, standing ready for whichever repository a Workspace made under that name next
			// is bound to — and ticket 05 judges a publish by it.
			discardPublishManifest(this.#journalStorage, opfsWorkspaceKey(name));
		}
		// **And its Remote relationship and Baseline** (ADR-0038), which carry the same reuse hazard in
		// the direction that matters most: left behind, they are this installation's claim that a
		// Workspace called "Marking 2026" belongs to a repository and that its files are already
		// shared with it — standing ready for whatever "Marking 2026" is made next.
		if (this.#metadataStorage) {
			await discardSynchronizationMetadata(this.#metadataStorage, opfsWorkspaceKey(name));
			// The marks are the third installation-local record keyed by this Workspace, and left behind
			// they would stand ready for whatever Workspace is next made with the same name.
			await discardLocalChanges(this.#metadataStorage, opfsWorkspaceKey(name));
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
		// And a Workspace whose Import has not been resolved is not walked at all (ticket 05): a Backup
		// is one of the five readers the marker's gate exists to keep out, and an archive holding half a
		// Project is one the user restores months later believing it whole.
		this.assertRecovered('backed up');
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
	 * ⚠ **A Review's destination is always a Workspace of its own, and that is the operation rather
	 * than a limitation.** Under ADR-0023 there is exactly one Alignment per Map Image in a Workspace,
	 * so laying a colleague's bundle over the user's own shared pool would either overwrite an
	 * Alignment two of their Projects are drawn by, or be refused. A Review's answer is that neither
	 * happens: the bundle lands in a throwaway Workspace, several of which may exist at once, and two
	 * students' conflicting Alignments of the same sheet never meet.
	 *
	 * **Copying a bundle's Project into the Workspace the user already has open is a different
	 * operation** — Import (ADR-0037) — which reads the same file through a read-only source capability
	 * and gives every incoming Map Image a *fresh* identity, so nothing of the user's is overwritten.
	 * This method is not it and must not become it: what it produces is a review copy.
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

	/**
	 * Review one Project out of a public repository, into a **new Review Workspace**, and switch to it.
	 *
	 * ⚠ **The same destination as {@link openBundle}, deliberately.** This is the bundle path with a
	 * different source of bytes (ADR-0024), so what arrives is the same kind of Workspace: throwaway,
	 * unbound, unpublishable, carrying the banner. Nothing here decides that — `reviewFromRemote`
	 * writes the mark, `#adopt` reads it back, and the banner, the sealed credential and the refused
	 * binding all follow from the mark rather than from this method remembering to arrange them.
	 *
	 * ⚠ **No credential is sent, and none is read** (SPEC, "Import: two operations, both
	 * unauthenticated"). A reviewer is often the person with no GitHub account at all — a colleague
	 * sent a link — and consulting the store would make the flow behave differently for somebody who
	 * happened to be signed in, in a way no test that signs in first would ever show.
	 *
	 * ⚠ **Always a browser-storage Workspace, whatever the current backing is**, for the reason
	 * {@link restoreFrom} gives: browser storage can make a new Workspace by itself and a folder
	 * cannot, and a subdirectory of the current folder would be a Workspace inside a Workspace.
	 *
	 * @throws ReviewRefusedError with nothing opened and no Workspace left behind
	 */
	async reviewFrom(remote: ReviewReference): Promise<ReviewedProject> {
		const subject = `${describeRemote(remote)} · ${remote.project}`;
		// Announced for `openBundle`'s reason: a Map Image's pyramid is thousands of files over
		// real minutes, and a still screen with nothing said is where a scholar concludes it has hung.
		const announce = (files: number, totalFiles: number, finished: boolean) => {
			this.transfer = { kind: 'open', subject, files, totalFiles, finished };
		};
		try {
			const opened = await reviewFromRemote((preferred) => this.#makeReviewDestination(preferred), {
				remote,
				estimateStorage: estimateStorage,
				onProgress: ({ files, totalFiles }) => announce(files, totalFiles, false)
			});
			// Only once the Review has finished. Switching first would leave the user looking at a
			// half-filled Workspace, and `#adopt` tears down the session they are in.
			await this.openWorkspace(opened.workspaceName);
			announce(opened.totalFiles, opened.totalFiles, true);
			return opened;
		} catch (cause) {
			// A refusal has left nothing behind, so the progress line must not be left mid-count saying
			// a Project is still being read. What the user needs is the refusal, which the hub renders.
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
		const origin = await this.#reviewOrigin();
		return {
			name,
			store: openOpfsWorkspace(name),
			origin,
			discard: async () => {
				if (origin?.folderReference) await releaseWorkspaceFolder(origin.folderReference);
				await deleteOpfsWorkspace(name);
				await this.refreshWorkspaces();
			}
		};
	}

	/**
	 * The ordinary Workspace a Review beginning now would be Imported back into (ADR-0037).
	 *
	 * ⚠ **Resolved here, once, and never again.** This is the moment the reviewer is unambiguously
	 * standing in the Workspace they are opening somebody's work *from*; everything after it — the
	 * banner's first exit, the switcher, a folder chosen for something else — can move them, and an
	 * Import that asked the question later would answer it about wherever they had got to.
	 *
	 * ⚠ **A Review opened from inside a Review carries the first one's origin forward**, rather than
	 * naming the throwaway Workspace it is standing in or falling back on the last Workspace of the
	 * user's own. A reviewer who opens a second bundle while reading the first is still, in the only
	 * sense this operation cares about, working out of the Workspace they started in — and that
	 * Workspace was written down explicitly rather than inferred, which is the whole test. A review
	 * copy whose own mark records none passes none on.
	 *
	 * `null` for a folder Workspace this installation cannot retain a grant for, which is a Review
	 * that cannot be Imported rather than one that Imports somewhere else.
	 */
	async #reviewOrigin(): Promise<ReviewOrigin | null> {
		if (this.review !== null) return this.review.origin;
		if (this.backing === 'folder') {
			const folder = this.#folderStore;
			if (folder === null) return null;
			const folderReference = await retainWorkspaceFolder(folder.folder).catch(() => null);
			if (folderReference === null) return null;
			return {
				workspaceKey: folderWorkspaceKey(this.folderName),
				backing: 'folder',
				name: this.folderName,
				folderReference
			};
		}
		return {
			workspaceKey: opfsWorkspaceKey(this.workspaceName),
			backing: 'browser',
			name: this.workspaceName,
			folderReference: ''
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
		const held = this.review?.origin?.folderReference ?? '';
		this.workspaces = this.workspaces.filter((name) => name !== discarding);
		this.reviewWorkspaces = this.reviewWorkspaces.filter((name) => name !== discarding);
		await this.#leaveReview();
		await this.#removeWorkspace(discarding);
		// The grant this review copy was holding on its origin's folder. Kept until now because the
		// copy could have been Imported at any moment up to it; after the Workspace is gone it is a
		// handle to a folder for something that no longer exists. The user's *own* grant to that same
		// folder is a different record and is not touched.
		if (held) await releaseWorkspaceFolder(held).catch(() => undefined);
		await this.refreshWorkspaces();
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// IMPORT: COPYING SOMEBODY ELSE'S PROJECT INTO THE WORKSPACE THAT IS OPEN (ADR-0037)
	//
	// ⚠ **The opposite destination from every Review above, and the boundary is the whole design.**
	// A Review makes a throwaway Workspace and may never touch the author's own; an Import writes into
	// the Workspace they are looking at and never makes another. So the two share a *source* — the
	// read-only capability `readProjectBundleSource` and `readRemoteProjectSource` return, which is
	// handed no store at all — and share nothing else. Nothing below may grow a `discard`, and nothing
	// above may grow a destination.

	/**
	 * Which Workspace an Import would copy into, or `null` when none may be.
	 *
	 * Read when the offer opens, shown in it, and handed back to {@link importBundle}. `null` inside a
	 * Review Workspace — a reviewed Project is copied by ticket 19's own operation, from the ordinary
	 * Workspace review began in — and `null` over a Workspace whose interrupted Import has not been
	 * resolved, which cannot be enumerated and so cannot be allocated against.
	 */
	get importTarget(): ImportTarget | null {
		if (this.review !== null || this.unavailable !== '') return null;
		return { name: this.name, key: this.#workspaceKey };
	}

	/**
	 * Copy one Project out of a bundle into the Workspace that is already open.
	 *
	 * The bundle's own refusals — a malformed archive, a Project from a newer version of the app —
	 * are the source's, before the Import below has a destination to plan against.
	 *
	 * @throws ImportSourceRefusedError, ImportRefusedError, ProjectFormatTooNewError — each with
	 *   nothing added to the Workspace
	 */
	async importBundle(file: File, target: ImportTarget): Promise<ImportedIntoWorkspace> {
		return this.#importProject(
			() => readProjectBundleSource(() => file.stream(), { fileName: file.name }),
			file.name,
			() => this.#openImportTarget(target)
		);
	}

	/**
	 * Copy one Project off somebody's Published Site into the Workspace that is already open.
	 *
	 * ⚠ **The same operation as {@link importBundle}, with the bytes coming off GitHub instead of a
	 * file** (ADR-0037). Everything that makes an Import an Import — the detachment, the remapping,
	 * ticket 17's Remote evidence, the allocation and the atomic transaction — is below, shared, so
	 * the two sources cannot come to disagree about what arriving work is.
	 *
	 * ⚠ **Anonymous, and no credential is read** (SPEC story 6). A reader of a public Published Site
	 * is very often somebody with no GitHub account, and the source reads the repository the same way
	 * {@link reviewFrom} does: unauthenticated, or not at all.
	 *
	 * ⚠ **Nothing about the published tree binds this Workspace** (story 80). The source offers a
	 * Project's closure and an observed origin; a Workspace `remote.json` sitting in the published
	 * root is not part of either, and the origin travels as provenance rather than as a relationship.
	 *
	 * @throws ReviewRefusedError, ImportSourceRefusedError, ImportRefusedError,
	 *   ProjectFormatTooNewError — each with nothing added to the Workspace
	 */
	async importRemoteProject(
		remote: ReviewReference,
		target: ImportTarget
	): Promise<ImportedIntoWorkspace> {
		return this.#importProject(
			() => readRemoteProjectSource({ remote }),
			`${describeRemote(remote)} · ${remote.project}`,
			() => this.#openImportTarget(target)
		);
	}

	/**
	 * The ordinary Workspace this review copy would be Imported into, or `null` for one that names
	 * none (ADR-0037).
	 *
	 * What the banner asks the reviewer to confirm is drawn from this, and its being `null` is what
	 * makes the offer absent over a review copy made before there was an origin to record. The
	 * structural refusal is {@link importReview}'s, which does not consult the control.
	 */
	get reviewImportDestination(): ReviewOrigin | null {
		return this.review?.origin ?? null;
	}

	/**
	 * Copy the Project as the reviewer has it now into the Workspace review began from, and only then
	 * throw the review copy away (SPEC stories 83–91, 162, 163).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE ORDER IS THE SAFETY, AND IT IS THE ONLY THING HERE THAT IS NOT SHARED
	 *
	 * 1. The recorded destination is reopened **before anything is read**, so a reviewer whose folder
	 *    is unplugged or whose Workspace is deleted meets a refusal while still standing in the copy
	 *    they were reading, byte for byte as they left it.
	 * 2. The Project is read through the read-only source capability over the *review copy's* store —
	 *    its current state, the reviewer's own edits included — and never from the bundle or the
	 *    published tree it arrived from.
	 * 3. The Import is the shared engine's, unchanged: fresh Map Image identities, the allocation, the
	 *    publication reset, the appended provenance, the quota check and one atomic commit.
	 * 4. Only once that has committed is the destination switched to and the Project opened.
	 * 5. Only once *that* has happened is the review copy deleted.
	 *
	 * ⚠ **Past step 3 nothing rolls back.** There is durable work of the author's own in their own
	 * Workspace from that moment, and a failure to switch, to open or to discard is reported as
	 * something left to do — see {@link ImportedFromReview.incomplete} — never repaired by deleting
	 * the Project that arrived.
	 *
	 * Must be called from a click or a keypress: a folder origin is reopened through
	 * `requestPermission()`, which needs transient user activation (ADR-0012).
	 *
	 * @throws ReviewDestinationUnavailableError with both Workspaces exactly as they were
	 * @throws ImportSourceRefusedError, ImportRefusedError, ProjectFormatTooNewError — each with
	 *   nothing added to the destination and the review copy still open
	 */
	async importReview(): Promise<ImportedFromReview> {
		refuseOutsideReview(this.name, this.review);
		this.assertRecovered('copied out of');
		const mark = this.review as ReviewMark;
		const origin = reviewImportOrigin(mark);
		const reviewWorkspace = this.workspaceName;
		const reopened = await this.#reopenReviewOrigin(origin);

		// ⚠ **A store of its own over the review copy, not `this.session.store`.** The session is
		// replaced the moment the destination is switched to, and the closure's bytes are read lazily —
		// so a source holding the session's store would be reading through a store belonging to a
		// Workspace this tab has left. This one is addressed by name and outlives the swap.
		const source = openOpfsWorkspace(reviewWorkspace);
		const imported = await this.#importProject(
			() => readReviewWorkspaceSource({ store: source, mark }),
			describeReviewSubject(mark),
			() => Promise.resolve(reopened.into)
		);

		let incomplete = '';
		try {
			if (reopened.folder === null) await this.#switchTo(origin.name);
			else {
				this.#folderStore = reopened.folder;
				await this.#adopt(reopened.folder, 'folder', reopened.folder.folderName);
			}
			// "Open or identify the imported Project" (story 87), before the copy it came from goes.
			await this.session.open(imported.directory);
			this.workspaces = this.workspaces.filter((name) => name !== reviewWorkspace);
			this.reviewWorkspaces = this.reviewWorkspaces.filter((name) => name !== reviewWorkspace);
			await this.#removeWorkspace(reviewWorkspace);
			if (origin.folderReference) {
				await releaseWorkspaceFolder(origin.folderReference).catch(() => undefined);
			}
		} catch (cause) {
			incomplete = `${reviewCopyStillHere(reviewWorkspace, imported.name)} ${
				cause instanceof Error ? cause.message : String(cause)
			}`;
		}
		await this.refreshWorkspaces();
		return { ...imported, incomplete };
	}

	/**
	 * Ask for the recorded ordinary Workspace back, and read what an Import into it needs.
	 *
	 * ⚠ **Reopened, not adopted.** The reviewer is still inside the review copy while this runs and
	 * stays there until the Import has committed, so the destination is a store, a listing and its
	 * installation-local synchronization evidence — never `this.session`. Every way it can fail
	 * refuses here, before a single byte of the closure has been read.
	 *
	 * @throws ReviewDestinationUnavailableError with both Workspaces untouched
	 */
	async #reopenReviewOrigin(origin: ReviewOrigin): Promise<ReopenedOrigin> {
		const folder = origin.backing === 'folder' ? await this.#regainFolder(origin) : null;
		if (folder === null && origin.backing === 'browser') {
			// ⚠ **Asked of the OPFS root rather than answered by opening it.** `openOpfsWorkspace`
			// creates at the first write, so an Import into a deleted Workspace would silently make a
			// new empty one and call that the destination — a Workspace the author never made, with
			// somebody else's Project in it and the review copy deleted behind it.
			const existing = await listOpfsWorkspaces().catch(() => {
				refuseReviewDestination(origin, 'unreachable');
			});
			if (!existing.includes(origin.name)) refuseReviewDestination(origin, 'gone');
		}
		const raw: ProjectStore = folder ?? openOpfsWorkspace(origin.name);
		// The folder's *current* name, because a folder that has been renamed is still the folder the
		// grant names — and ticket 01's key is built from the name, so it has to be built from this one.
		const key = folder === null ? origin.workspaceKey : folderWorkspaceKey(folder.folderName);
		const store = trackLocalChanges(raw, key, this.#metadataStorage);

		let local: readonly string[];
		try {
			local = await store.list('');
		} catch (cause) {
			// A handle whose directory is not there is the deleted folder and the folder replaced by
			// another of the same name — the two cases a display name cannot tell apart and a grant can.
			// Anything else is a Workspace that exists and will not answer.
			refuseReviewDestination(
				origin,
				cause instanceof DOMException && cause.name === 'NotFoundError' ? 'gone' : 'unreachable'
			);
		}

		const metadata =
			this.#metadataStorage === null
				? null
				: new SynchronizationMetadata(this.#metadataStorage, key);
		const remote = (await metadata?.readRemote().catch(() => null)) ?? null;
		const baseline =
			remote === null ? null : ((await metadata?.readBaseline(remote).catch(() => null)) ?? null);

		return {
			folder,
			into: {
				name: folder === null ? origin.name : folder.folderName,
				store,
				local,
				names: (await new Workspace(store).listProjects()).map((project) => project.name),
				remote,
				baseline,
				// Nothing to make visible yet: the destination is not on screen, and adopting it is what
				// lists it — which happens after the commit, not inside it.
				settle: () => Promise.resolve()
			}
		};
	}

	/**
	 * Ask for the retained folder grant back, in the words a refusal needs.
	 *
	 * @throws ReviewDestinationUnavailableError
	 */
	async #regainFolder(origin: ReviewOrigin): Promise<FileSystemAccessProjectStore> {
		let folder: FileSystemAccessProjectStore | null;
		try {
			folder = await reopenRetainedWorkspaceFolder(origin.folderReference);
		} catch (cause) {
			// `FolderPermissionDeniedError` is the answer that matters and the only one a user can act
			// on; anything else from the grant is a folder this browser cannot offer back either.
			refuseReviewDestination(
				origin,
				cause instanceof FolderPermissionDeniedError ? 'permission-denied' : 'unreachable'
			);
		}
		// This installation no longer holds the grant — a cleared site, another profile, a browser that
		// would not keep it. There is no second way to ask for one exact folder back.
		if (folder === null) refuseReviewDestination(origin, 'gone');
		return folder;
	}

	/**
	 * The Import itself, over whichever source the caller opened.
	 *
	 * The engine is `@ballastella/core`'s and the order is its own (ADR-0037): the manifest is
	 * detached before it is remapped, because the remapping serialises what it plans; the Map Image
	 * identities are minted before anything is allocated, because the destination path set is what a
	 * transaction is planned over; and the allocated display name is folded in last, because
	 * `commitProjectImport` writes `project.json` from the source's held-back bytes rather than from
	 * the file stream. What this method owns is the three things core deliberately does not know:
	 * which Workspace, what the author is already looking at, and that somebody is waiting.
	 *
	 * ⚠ **The destination is a thunk, resolved after the source has been read and not before.** For a
	 * direct Import that is what re-checks the target immediately before the transaction rather than
	 * only when the offer opened: the offer names a Workspace in words, and a switcher two clicks away
	 * can make that sentence a lie while it is on screen. Refusing is the only honest answer, and
	 * there is nothing to roll back because nothing has been written yet. A review Import resolves its
	 * destination *first* — before a byte of the closure is read — and the thunk simply hands back
	 * what it already holds; see {@link importReview} for why that order is the safety there.
	 *
	 * ⚠ **Progress is counted from the closure's own files, and there is no percentage.** A bundle is
	 * a tar and declares no total, but a closure *does* — its path set is known before a byte moves —
	 * so the two numbers here are both real. A Map Image pyramid is thousands of files over real
	 * minutes and this is the path ADR-0001 makes the only way in on Firefox, Safari and iPad.
	 */
	async #importProject(
		read: () => Promise<ProjectImportSource>,
		subject: string,
		openInto: () => Promise<ImportInto>
	): Promise<ImportedIntoWorkspace> {
		const announce = (files: number, totalFiles: number, finished: boolean) => {
			this.transfer = { kind: 'import', subject, files, totalFiles, finished };
		};
		try {
			const source = await read();
			// The moment the transfer was observed, read once and serialised straight into
			// `project.json`. Nothing holds it and nothing re-reads it, which is the mutable instance
			// in reactive state the rule below is about.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const detached = detachImportedProject(source.project, source.origin, new Date());
			const plan = await remapProjectImport({
				...source,
				project: detached,
				projectFileBytes: serialiseProjectFile(detached)
			});

			const into = await openInto();
			const store = into.store;
			// ⚠ **The Remote is asked before anything is allocated, and one that will not answer refuses
			// the Import** (ticket 17). A bound Workspace's Remote may hold a Project this installation
			// has never seen, and a directory allocated as free because a failed listing did not mention
			// it is a Conflict the author meets at some later Publish. It is also where an Import of the
			// Project this Workspace already synchronizes is refused, which is why the observed origin is
			// handed over rather than only the closure.
			const evidence = await readImportEvidence(source.origin, {
				remote: into.remote,
				baseline: into.baseline,
				local: into.local,
				token: this.credential
			});
			const allocation = allocateProjectImport(plan.closure, {
				names: into.names,
				local: into.local,
				...evidence
			});
			const named = { ...plan.closure.project, name: allocation.name };
			const total = plan.closure.paths.length;
			announce(0, total, false);
			const counted: ProjectImportSource = {
				...plan.closure,
				project: named,
				projectFileBytes: serialiseProjectFile(named),
				files: () => this.#announcing(plan.closure.files(), total, announce)
			};
			await commitProjectImport(store, counted, allocation.destinations, {
				estimateStorage: estimateStorage
			});
			// The Project list this Workspace shows is a walk of its directories, and the Import has just
			// added one. Refreshed before the finished announcement, so the sentence that says a Project
			// arrived is not read out over a list that does not hold it yet.
			await into.settle();
			announce(total, total, true);
			return { name: allocation.name, directory: allocation.directory, workspace: into.name };
		} catch (cause) {
			// Every refusal has left the Workspace as it was, so the progress line must not be left
			// mid-count saying a Project is still arriving. What the user needs is the refusal, which the
			// hub renders as an alert.
			this.transfer = null;
			throw cause;
		}
	}

	/**
	 * The closure's files, announcing each one as it goes past.
	 *
	 * A passthrough rather than an option on `commitProjectImport`: the transaction's contract is that
	 * it writes a validated closure and nothing else, and a progress listener threaded through it
	 * would be a second thing it owes the caller on the rollback path.
	 */
	async *#announcing(
		files: AsyncIterable<ClosureFile>,
		total: number,
		announce: (files: number, totalFiles: number, finished: boolean) => void
	): AsyncIterable<ClosureFile> {
		let written = 0;
		for await (const file of files) {
			written += 1;
			announce(written, total, false);
			yield file;
		}
	}

	/**
	 * The store an Import may write to, or the refusal saying why it may not.
	 *
	 * @throws Error naming the Workspace the offer named, with nothing written
	 */
	#storeForImport(target: ImportTarget): ProjectStore {
		const current = this.importTarget;
		if (current === null || current.key !== target.key) {
			throw new Error(
				`“${target.name}” is not the Workspace that is open any more, so nothing has been ` +
					`Imported. Open it again and start the Import from there.`
			);
		}
		return this.session.store;
	}

	/**
	 * The open Workspace as a destination, re-checked at the moment the transaction is about to be
	 * planned.
	 *
	 * The listing is taken here rather than by the caller so that it is the *same* listing the target
	 * check licensed: a walk taken before the check would describe a Workspace the author may have
	 * switched away from since.
	 */
	async #openImportTarget(target: ImportTarget): Promise<ImportInto> {
		const store = this.#storeForImport(target);
		return {
			name: this.name,
			store,
			local: await store.list(''),
			names: this.session.projects.map((project) => project.name),
			remote: this.remote,
			baseline: this.baseline,
			settle: () => this.session.refresh()
		};
	}

	/** This Workspace, backing included, as the synchronization metadata keys it. */
	get #workspaceKey(): string {
		return this.backing === 'folder'
			? folderWorkspaceKey(this.folderName)
			: opfsWorkspaceKey(this.workspaceName);
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

	/**
	 * Refuse an action over a Workspace whose interrupted Import could not be resolved (ticket 05).
	 *
	 * The second layer under a control that is already absent, for {@link assertNotReviewing}'s
	 * reason: a guard that lives in a component is one route away from being absent. The sentence
	 * carries the recovery's own words, because there is one thing to do about it and repeating it
	 * differently here is how two spellings of the same state come to disagree.
	 */
	assertRecovered(verb: string): void {
		if (this.unavailable === '') return;
		throw new Error(`“${this.name}” cannot be ${verb} until it opens. ${this.unavailable}`);
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE REMOTE, AND THE CREDENTIAL THAT MAY PUSH TO IT (ticket 03, ADR-0032, ADR-0033)
	//
	// Nothing here publishes; that is ticket 04. What this half delivers is that the app knows which
	// repository this Workspace belongs to, knows whether it may write there, and holds a credential
	// for the length of the tab.

	/**
	 * Settle the arriving Workspace's Remote, and re-answer whether a credential is readable.
	 *
	 * ⚠ **Migration runs here, before any synchronization action is offered for the Workspace**, and
	 * this is the only place a `remote.json` is consulted at all. Everything else reads
	 * {@link SynchronizationMetadata}, so a binding downloaded inside a fork's published tree, carried
	 * in a Project Bundle, or restored from a Backup cannot become an active Remote.
	 *
	 * Never throws. A Workspace whose metadata cannot be read is unbound and `Cannot tell`, which is
	 * the direction whose cost is binding again rather than a Publish aimed at an unchecked address.
	 */
	async #readRemote(store: ProjectStore, session: EditorSession): Promise<void> {
		const metadata = session.synchronization;
		this.legacyRemote = null;
		this.remote = null;
		this.baseline = null;
		// ⚠ **Cleared and then nothing, over a Workspace whose Import could not be recovered** (ticket
		// 05). Reading a Remote is a read of this Workspace, and the clears above are why the guard is
		// here rather than at the call: leaving the *previous* Workspace's Remote on screen beside an
		// unavailable one is how a Publish gets offered over work that is not there.
		if (this.unavailable !== '') return;
		if (metadata !== null) {
			const migration = await migrateSynchronizationMetadata({
				metadata,
				store,
				manifests: session.legacyManifests
			});
			// A Review Workspace is never bindable (ADR-0024), so it is never asked either — the offer
			// would be a route into publishing somebody else's Project from a copy built to be thrown
			// away. `this.review` is settled just above this call, in `#adopt`.
			this.legacyRemote =
				migration.kind === 'confirmation-required' && this.review === null
					? migration.remote
					: null;
			this.remote = await metadata.readRemote();
			this.baseline = this.remote === null ? null : await metadata.readBaseline(this.remote);
		}
		this.#refreshCredential();
		this.#watchRemoteStatus(session);
	}

	/**
	 * Give the arriving Workspace its own Remote Status checker, and take the first reading.
	 *
	 * ⚠ **An automatic check needs a credential, or an answer that needs no request** (SPEC story
	 * 115). A signed-out session must not poll: GitHub allows an anonymous reader sixty requests an
	 * hour *per IP address*, so a seminar room on one campus address checking on every window focus
	 * spends the room's whole budget on status and then cannot open a Workspace at all. What is left
	 * for a signed-out author is {@link checkRemoteStatus}, which they press.
	 *
	 * The determination that needs no request is still made: a Workspace with no Baseline is
	 * `Cannot tell` whatever the Remote holds, and `EditorSession.checkRemoteStatus` reaches that
	 * before it would reach the network. Hence the third clause — the two must agree, or a signed-out
	 * session would be polling after all.
	 */
	#watchRemoteStatus(session: EditorSession): void {
		this.#statusChecker?.close();
		this.#statusChecker = null;
		this.remoteStatusState = UNCHECKED_REMOTE_STATUS;
		// The arriving Workspace wears none of the Workspace the author left: an Update's progress, its
		// report and its refusal are all claims about one Workspace's files.
		this.updateProgress = null;
		this.updateNotice = '';
		this.updateFailure = '';
		// ⚠ **And a deletion preview least of all.** It names Projects in the Workspace the author has
		// just left, and its Remove button would delete them out from under a screen showing another
		// Workspace's Projects. Answered `false` rather than merely hidden: the transfer that raised it
		// is waiting on it (SPEC story 127 — declining changes nothing).
		this.#closeDeletionPreview(false);
		const remote = this.remote;
		if (remote === null) return;
		const checker = new RemoteStatusChecker({
			observe: (trigger) => {
				// A gesture may read a public Remote with no credential; an automatic check may not.
				const mayRequest = trigger === 'explicit' || this.credential !== null;
				if (!mayRequest && this.baseline !== null) return null;
				return session.checkRemoteStatus({ remote, token: this.credential, mayRequest });
			},
			now: () => Date.now(),
			onChange: (state) => {
				// The switch is what this guards: a Workspace left behind renders nothing here.
				if (this.#statusChecker === checker) this.remoteStatusState = state;
			}
		});
		this.#statusChecker = checker;
		void checker.check('open');
	}

	/**
	 * Check the Remote's status now, because the author asked (SPEC story 115).
	 *
	 * Never throttled, and the only check that may list a public Remote anonymously — which is what
	 * makes status available at all to somebody who has not signed in. It sends no credential it does
	 * not already hold and asks for none.
	 */
	async checkRemoteStatus(): Promise<void> {
		await this.#statusChecker?.check('explicit');
	}

	/**
	 * Bring the Remote's changes into this Workspace, because the author asked (ticket 14).
	 *
	 * ⚠ **Explicit, and reachable from nowhere but a control that says so.** No status check, no
	 * window focus, no open and no publish reaches this. SPEC story 121 is that Remote work never
	 * changes a Workspace silently, and the way that is kept true is that there is exactly one caller.
	 *
	 * ⚠ **Every phase is guarded by which Workspace this is.** An Update is minutes of downloading and
	 * one click switches Workspaces inside it: the transfer itself is aimed at the session it started
	 * on and stays aimed there, which is right — those are the files the author asked about — but the
	 * progress, the report and the recomputed status must not appear beside another Workspace's name.
	 *
	 * Resolves rather than rejecting: the control is a persistent one on the navigation bar with no
	 * dialog to catch a throw, so the refusal is rendered beside it as an alert.
	 */
	async updateFromRemote(): Promise<void> {
		const remote = this.remote;
		if (remote === null || this.updateProgress !== null) return;
		const session = this.session;
		const key = this.#workspaceKey;
		const mine = () => this.session === session && this.#workspaceKey === key;

		this.updateNotice = '';
		this.updateFailure = '';
		this.updateProgress = { files: 0, totalFiles: 0 };
		try {
			const { update, baselineKept } = await session.updateFromRemote({
				remote,
				onProgress: (progress) => {
					if (mine()) this.updateProgress = progress;
				},
				// ⚠ **Declined by default when the Workspace has moved on.** A preview raised over a
				// Workspace the author has since switched away from would be a dialog naming files they
				// cannot see, and answering it `true` would delete them behind their back.
				confirmDeletion: (preview) =>
					mine() ? this.#askAboutDeletions(preview) : Promise.resolve(false)
			});
			if (!mine()) return;
			// Re-read rather than assumed: `writeBaseline` discards the previous record when it cannot
			// keep the new one, so the honest answer after a refused write is the `null` this reads.
			this.baseline = (await session.synchronization?.readBaseline(remote)) ?? null;
			this.updateNotice = baselineKept
				? update.notice
				: // SPEC: a durable store that refused *after* the transfer succeeded is never reported as
					// a failed Update. The files are here; what this browser cannot say is what has changed.
					`${update.notice} This browser would not keep a record of what the two of them now ` +
					`hold in common, so Ballastella cannot tell what has changed on either side until the ` +
					`next Publish.`;
			// SPEC story 131: the next required action has to be clear the moment the Update finishes,
			// and the status on screen was worked out against the Workspace as it was before it.
			this.updateProgress = null;
			await this.checkRemoteStatus();
		} catch (cause) {
			if (!mine()) return;
			// ⚠ **A decline is a notice, not an alert.** The author looked at what would go and said no,
			// and reporting their own answer back to them as a failure — in the warning colour, through
			// `role="alert"` — is this app telling them something went wrong when nothing did.
			if (cause instanceof UpdateRefusedError && cause.refusal === 'cancelled') {
				this.updateNotice = cause.message;
				return;
			}
			this.updateFailure = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (mine()) {
				this.updateProgress = null;
				// Whatever happened, nothing is waiting to be asked any more. A preview left on screen
				// after the operation that raised it has gone is a confirmation for a transfer that
				// no longer exists.
				this.#closeDeletionPreview(false);
			}
		}
	}

	/**
	 * Put the deletions on screen and wait for the author's answer (SPEC stories 126, 127).
	 *
	 * Resolves `false` for every way of not saying yes — the Cancel button, Escape, the dialog being
	 * closed, the Workspace being switched underneath it — because "no" is the answer that changes
	 * nothing, and a promise that never settled would leave the Update running for ever.
	 */
	#askAboutDeletions(preview: UpdateDeletionPreview): Promise<boolean> {
		// A second preview cannot arise — `updateFromRemote` refuses to start while one is in flight —
		// but a stale resolver would be a transfer waiting on a promise nothing will settle.
		this.#closeDeletionPreview(false);
		return new Promise<boolean>((resolve) => {
			this.#answerDeletion = resolve;
			this.deletionPreview = preview;
		});
	}

	/**
	 * Answer the deletion preview on screen: `true` removes the files, `false` changes nothing.
	 *
	 * The only way to answer it, and the only thing that closes it.
	 */
	answerDeletionPreview(confirmed: boolean): void {
		this.#closeDeletionPreview(confirmed);
	}

	#closeDeletionPreview(confirmed: boolean): void {
		const answer = this.#answerDeletion;
		this.#answerDeletion = null;
		this.deletionPreview = null;
		answer?.(confirmed);
	}

	/**
	 * Whether there is trustworthy evidence of what this Workspace and its Remote last shared.
	 *
	 * `'unbound'`, `'cannot-tell'`, or `'known'`. The three-way comparison itself is not this
	 * ticket's: what this answers is whether there is anything to compare against.
	 */
	get remoteStatus(): 'unbound' | 'cannot-tell' | 'known' {
		if (this.remote === null) return 'unbound';
		return this.baseline === null ? 'cannot-tell' : 'known';
	}

	/**
	 * Accept a legacy `remote.json` as this installation's Remote, having named the repository.
	 *
	 * ⚠ **No Baseline is written.** There is no evidence about what this machine shared with that
	 * repository, and an empty Baseline would claim the Remote holds nothing — the reading that
	 * licenses overwriting all of it. So the Workspace is bound and its status is `Cannot tell` until a
	 * deliberate Publish establishes real evidence.
	 *
	 * @throws Error when the durable store would not keep the relationship
	 */
	async acceptLegacyRemote(): Promise<void> {
		const legacy = this.legacyRemote;
		const metadata = this.session.synchronization;
		if (legacy === null || metadata === null) return;
		if (!(await confirmLegacyRemote(metadata, legacy))) {
			throw new Error(
				`This browser would not keep the record that “${this.name}” belongs to ` +
					`${describeRemote(legacy)}. Site data may be blocked for this site, or browser storage ` +
					`may be full.`
			);
		}
		this.legacyRemote = null;
		this.remote = legacy;
		this.baseline = await metadata.readBaseline(legacy);
		this.#watchRemoteStatus(this.session);
	}

	/** Leave a legacy `remote.json` unlifted. Nothing is written, so the Workspace stays unbound. */
	declineLegacyRemote(): void {
		this.legacyRemote = null;
	}

	#refreshCredential(): void {
		const held = this.#credentials.read() !== null;
		const gained = held && !this.signedIn;
		this.signedIn = held;
		// A sign-in is the moment a bound Workspace can be checked automatically for the first time, and
		// waiting for the next window focus would leave the control reading "Not checked yet" beside a
		// header that has just said who the author is signed in as.
		if (gained) void this.#statusChecker?.check('open');
	}

	/**
	 * The credential a publish would use, or `null`. Always `null` inside a Review Workspace.
	 *
	 * A getter rather than reactive state: the token itself is never rendered, and holding a copy in
	 * `$state` would put it somewhere a component could show it by accident.
	 */
	get credential(): string | null {
		return this.#credentials.read();
	}

	/**
	 * Bind this Workspace to a repository, and keep the credential **only if that worked**.
	 *
	 * The order is what makes "a rejected token is not stored" true: `bindWorkspaceToRemote` asks
	 * GitHub before it writes anything, so a refusal leaves the Workspace unbound and this method
	 * returns before the credential is written anywhere at all.
	 *
	 * `token` is `null` when the credential is one already held — the App sign-in, which acquires it
	 * before there is anything to bind to. **That case must not go through {@link #keepPasted}**,
	 * which clears the grant record: the binding would succeed and take the refresh token with it,
	 * leaving an eight-hour credential that cannot renew and reports itself as an expired sign-in.
	 *
	 * @throws ReviewWorkspaceError for a review copy, RemoteBindRefusedError for GitHub's refusals
	 */
	async bindRemote(remote: RemoteReference, token: string | null): Promise<RemoteBindOutcome> {
		const held = token ?? this.credential;
		if (held === null) {
			throw new Error(
				`Binding “${this.name}” needs a credential, and none is held. Sign in with GitHub, or ` +
					`paste a personal access token.`
			);
		}
		const outcome = await bindWorkspaceToRemote(this.session.store, this.name, {
			token: held,
			remote
		});
		if (token !== null) this.#keepPasted(token);
		const binding = {
			owner: outcome.binding.owner,
			repository: outcome.binding.repository,
			branch: outcome.binding.branch
		};
		// ⚠ **The installation-local relationship is what makes this Workspace bound**, and the
		// `remote.json` `bindWorkspaceToRemote` wrote is now only the Published Site's compatibility
		// evidence. A store that will not keep this leaves the Workspace unbound, so it is said out
		// loud rather than reported as a binding that does not exist.
		const metadata = this.session.synchronization;
		if (metadata !== null && !(await metadata.bindRemote(binding))) {
			throw new Error(
				`Ballastella reached ${describeRemote(binding)}, but this browser would not keep the ` +
					`record that “${this.name}” belongs to it, so the Workspace is not bound. Site data may ` +
					`be blocked for this site, or browser storage may be full.`
			);
		}
		this.legacyRemote = null;
		this.remote = binding;
		this.baseline = metadata === null ? null : await metadata.readBaseline(binding);
		this.#watchRemoteStatus(this.session);
		return outcome;
	}

	/**
	 * Supply a credential for the Remote this Workspace is already bound to (stories 30, 31).
	 *
	 * Validated against that repository rather than merely kept, so a mistyped paste is caught here
	 * and not at the first Publish. Answers what it found out about the rights, which the screen says
	 * out loud — the credential that reaches a repository and cannot push to it is the one worth
	 * knowing about before four thousand tiles have gone.
	 */
	async signIn(token: string): Promise<RemoteRights> {
		const binding = this.remote;
		if (binding === null) {
			throw new Error(
				`“${this.name}” is not bound to a repository yet, so there is nothing to sign in to. ` +
					`Bind it to one first.`
			);
		}
		const rights = await readRemoteRights({ token, remote: binding });
		this.#keepPasted(token);
		return rights;
	}

	/**
	 * Hold a pasted token, and throw away any App session it replaces.
	 *
	 * ⚠ **The grant record has to go, or the pasted token is destroyed by it.** The record is about a
	 * token that is no longer held; left behind, the next freshness check reads an expired grant,
	 * fails to renew it, and clears the credential — which is now the working token the scholar
	 * pasted a moment ago, reported to them as "your GitHub sign-in has expired".
	 */
	#keepPasted(token: string): void {
		this.#credentials.write(token);
		clearGrantRecord(this.#grants);
		this.#refreshCredential();
	}

	/** Forget the credential, so this machine can be handed to somebody (story 37). */
	signOut(): void {
		this.#credentials.clear();
		clearGrantRecord(this.#grants);
		this.identity = '';
		this.#refreshCredential();
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE GITHUB APP SIGN-IN (ticket 10, ADR-0031)
	//
	// The second acquisition path behind the same credential interface. Everything below this class
	// — `bindWorkspaceToRemote`, `readRemoteRights`, the publish engine — receives an opaque bearer
	// string and cannot tell which door it came through. That is the rule ADR-0031 states and the
	// reason none of this lives any lower: the flow is the *UI's* business, and the token is not.

	/** Whether to offer the button at all: false in a fork that has not registered its own App. */
	readonly signInWithGitHubOffered = isGitHubAppConfigured(GITHUB_APP);

	/**
	 * The GitHub account the held credential belongs to, or `''`.
	 *
	 * Read once, on the App path, from `GET /user`. **Not read for a pasted token**, and that is not
	 * a branch on the auth method below the interface — it is that the App flow has just been through
	 * a redirect the user cannot see the result of, so it has something to show them that a paste
	 * (which they typed, for an account they were looking at) does not.
	 */
	identity = $state('');

	/**
	 * Send the user to GitHub to authorise, or say why this browser cannot start a sign-in.
	 *
	 * Answers `''` when the redirect is under way, and the sentence to show when it is not.
	 *
	 * ⚠ **The redirect happens only once the `state` is known to have been kept, and the check is a
	 * read-back rather than the absence of a throw.** A browser with storage blocked hands back a
	 * storage that quietly holds nothing, so a sign-in begun there would send the scholar to GitHub,
	 * make them authorise, and refuse them on return for a reason they cannot act on. Refusing here
	 * costs a sentence and leaves the paste, which needs no storage of that kind, on the same screen.
	 */
	beginGitHubSignIn(): string {
		const state = newSignInState();
		// Captured **before** the redirect and kept, because the exchange has to name this same string
		// and cannot recompute it — see {@link SIGN_IN_REDIRECT_KEY}.
		const redirectUri = callbackUri();
		const storage = signInStorage();
		try {
			storage.setItem(SIGN_IN_STATE_KEY, state);
			storage.setItem(SIGN_IN_REDIRECT_KEY, redirectUri);
			// The Project the scholar was looking at. `callbackUri` has to strip it — a GitHub App
			// matches the callback against the URL registered on the App, so any query string at all is
			// a redirect URI GitHub refuses — so it is stashed here and put back on return.
			storage.setItem(SIGN_IN_RETURN_KEY, globalThis.location.search);
		} catch {
			// Quota, or a storage that throws from every property. Either way the read-back below is
			// what decides, so there is nothing to do here.
		}
		if (storage.getItem(SIGN_IN_STATE_KEY) !== state) {
			return (
				`This browser will not let this page remember the sign-in it would be starting, so going ` +
				`to GitHub could only end in the reply being refused when you came back. It is usually a ` +
				`setting blocking storage for this site. Paste a personal access token below instead — ` +
				`that path needs none of this.`
			);
		}
		globalThis.location.assign(authorizeUrl({ app: GITHUB_APP, redirectUri, state }));
		return '';
	}

	/**
	 * Finish a sign-in the user has just come back from, or refuse it.
	 *
	 * ⚠ **The `state` is consumed whatever happens.** A callback that has been judged once must not be
	 * judgeable again — leaving it in place would let a reload of the callback URL re-run the exchange,
	 * and leaving it in place after a *mismatch* would let an attacker's second attempt find a state
	 * this tab really did generate.
	 *
	 * @throws GitHubCallbackRefusedError when the state does not match or is absent
	 * @throws GitHubSignInError when GitHub refused, or the exchange did
	 */
	async completeGitHubSignIn(callback: SignInCallback): Promise<void> {
		const storage = signInStorage();
		const stored = storage.getItem(SIGN_IN_STATE_KEY);
		const redirectUri = storage.getItem(SIGN_IN_REDIRECT_KEY) ?? callbackUri();
		storage.removeItem(SIGN_IN_STATE_KEY);
		storage.removeItem(SIGN_IN_REDIRECT_KEY);

		const refusal = verifySignInState(callback.state, stored);
		// ⚠ Nothing is stored on a refusal — not the code, not a token, not a partial record. The
		// credential store is left exactly as it was, so a scholar already signed in by paste stays
		// signed in and a forged callback changes nothing at all.
		if (refusal !== '') throw new GitHubCallbackRefusedError(refusal);

		// GitHub's own answer, read before the code is spent: a scholar who pressed Cancel comes back
		// with `error=access_denied`, the real `state`, and **no code**, and exchanging the empty string
		// would tell them their code was incorrect or expired for a thing they chose on purpose.
		const declined = describeCallbackRefusal(callback);
		if (declined !== '') throw new GitHubSignInError(declined);

		// ⚠ **Not from inside somebody else's Project.** The credential and the grant record are both
		// sealed while a review copy is open (story 40), so an exchange here could only end in a token
		// that was thrown away and a screen claiming a sign-in that is not held — and the exchange
		// itself is a request leaving a submission. Refused before the code goes anywhere.
		if (this.review !== null) {
			throw new GitHubSignInError(
				`A review copy of somebody else's Project is open, so nothing has been signed in to. No ` +
					`GitHub sign-in is readable or writable while one is — go back to your own Workspace ` +
					`and sign in there.`
			);
		}

		const grant = await exchangeAuthorizationCode({
			app: GITHUB_APP,
			code: callback.code,
			redirectUri
		});
		// ⚠ **The record is written beside the credential with nothing between them that can throw.**
		// A credential held with no record beside it reads exactly like a pasted token — no expiry to
		// check and no refresh token to spend — so an eight-hour App token would then be carried into a
		// publish that meets its end partway through, which is the one outcome story 33 forbids.
		// `readGitHubLogin`, which can fail and is only a name on the bar, comes after both.
		writeGrantRecord(this.#grants, grant);
		this.#keepGrant(grant);
		this.identity = await readGitHubLogin(grant.token);
	}

	/**
	 * Make sure the held credential will still be good when work starts — **before** it starts.
	 *
	 * Story 33, and the ticket's rule: *"An expired token surfaces as 'sign in again', never as a
	 * publish that fails partway through — check before starting, not during."* A pasted token has no
	 * grant record and is therefore left alone, which is not a branch on the auth method so much as
	 * the absence of anything to check: there is no expiry to read and no refresh token to spend.
	 *
	 * Nothing at all happens inside a review copy: the record is sealed there, so this reads no grant,
	 * spends no refresh token, and reaches no broker from inside somebody else's Project.
	 *
	 * @throws GitHubSignInError when the sign-in has expired and could not be renewed
	 */
	async ensureCredentialFresh(): Promise<void> {
		const grant = readGrantRecord(this.#grants);
		if (grant === null) return;

		// ⚠ **A record is only about the credential it names.** Held ones can disagree: a scholar whose
		// App sign-in ran out pastes a personal access token, and the record left behind still describes
		// the token that is gone. Acted on, it would refuse a refresh and then clear "the expired
		// credential" — which is by then the working token they pasted a moment ago, reported to them
		// as an expiry. A record naming anything other than what is held is a leftover, and goes.
		if (grant.token !== this.#credentials.read()) {
			clearGrantRecord(this.#grants);
			return;
		}
		if (isGrantFresh(grant, Date.now())) return;

		if (grant.refreshToken === '') {
			this.#endExpiredSession();
			throw new GitHubSignInError(signInAgainMessage());
		}
		try {
			const renewed = await refreshGitHubToken({
				app: GITHUB_APP,
				refreshToken: grant.refreshToken
			});
			writeGrantRecord(this.#grants, renewed);
			this.#keepGrant(renewed);
		} catch {
			// Whatever went wrong — a spent refresh token, a broker that is down, one that was never
			// deployed — the remedy a scholar can take is the same one, so it is the only thing said.
			this.#endExpiredSession();
			throw new GitHubSignInError(signInAgainMessage());
		}
	}

	/**
	 * The query string the sign-in left from, consumed so a later reload cannot replay it.
	 *
	 * `''` when there is nothing to put back, which is the ordinary case of signing in from the hub.
	 */
	consumeSignInReturn(): string {
		const storage = signInStorage();
		const search = storage.getItem(SIGN_IN_RETURN_KEY) ?? '';
		storage.removeItem(SIGN_IN_RETURN_KEY);
		return search;
	}

	/** Hold a grant's token as *the* credential, which is all anything below this class ever sees. */
	#keepGrant(grant: GitHubTokenGrant): void {
		this.#credentials.write(grant.token);
		this.#refreshCredential();
	}

	/** Drop a sign-in that has run out, so every screen renders the not-signed-in state. */
	#endExpiredSession(): void {
		this.#credentials.clear();
		clearGrantRecord(this.#grants);
		this.identity = '';
		this.#refreshCredential();
	}

	/**
	 * Forget which repository this Workspace publishes to.
	 *
	 * **Nothing on the Remote is touched.** Unbinding is this machine forgetting an address, never a
	 * deletion of a published site — a scholar who unbinds and binds again is where they were, and
	 * their Reader never saw anything happen. The credential is left alone too: it belongs to a GitHub
	 * account rather than to this Workspace, and signing out is its own button.
	 */
	async unbindRemote(): Promise<void> {
		// The installation-local relationship first, because that is the one that decides whether this
		// Workspace is bound. `remote.json` goes too: left behind, the next visit would find an
		// uncorroborated legacy binding and offer to lift the very relationship just given up.
		await this.session.synchronization?.clearRemote();
		await clearRemoteBinding(this.session.store);
		this.legacyRemote = null;
		this.baseline = null;
		this.remote = null;
		// Nothing left to compare against, so the control goes rather than reporting a Remote that is
		// no longer this Workspace's.
		this.#watchRemoteStatus(this.session);
	}

	/**
	 * Open a Workspace from GitHub: return to the one this installation already keeps for that
	 * repository, or download, validate and adopt a new one (SPEC stories 96–104).
	 *
	 * ⚠ **No credential is sent, and none is needed** (SPEC, "Import: two operations, both
	 * unauthenticated"). Nothing on this path takes a token and this passes none — a student with no
	 * GitHub account can seed a Workspace from their instructor's Remote, which is the story this
	 * whole epic is most likely to be used for. The credential store is deliberately not consulted:
	 * reading it would make the flow behave differently for somebody who happened to be signed in,
	 * and the difference would never show up in a test that signs in first.
	 *
	 * ⚠ **Always a browser-storage Workspace, whatever the current backing is**, for the reason
	 * {@link restoreFrom} gives: browser storage can make a new Workspace by itself and a folder
	 * cannot, and a subdirectory of the current folder would be a Workspace inside a Workspace.
	 *
	 * The quota check happens before the Workspace is created, against the byte total the Remote's own
	 * tree listing reports.
	 *
	 * @returns the sentence to show, which says which Workspace the user is now in
	 * @throws CloneRefusedError with no Workspace adopted and no synchronization evidence recorded
	 */
	async openFromGitHub(remote: CloneReference): Promise<{ notice: string }> {
		const subject = describeRemote(remote);
		// Announced for `openBundle`'s reason: a Map Image's pyramid is thousands of files over
		// real minutes, and a still screen with nothing said is where a scholar concludes it has hung.
		const announce = (files: number, totalFiles: number, finished: boolean) => {
			this.transfer = { kind: 'open', subject, files, totalFiles, finished };
		};
		try {
			const opened = await openWorkspaceFromGitHub({
				remote,
				metadata: this.#metadataStorage,
				workspaceKey: opfsWorkspaceKey,
				open: (preferred) => this.#makeOpenDestination(preferred),
				estimateStorage: estimateStorage,
				onProgress: ({ files, totalFiles }) => announce(files, totalFiles, false)
			});
			if (opened.outcome === 'selected') {
				this.transfer = null;
				return { notice: await this.#selectOpened(opened.workspaceKey, opened.remote) };
			}
			// Only once everything has arrived and validated. Switching first would leave the user
			// looking at a half-filled Workspace, and `#adopt` tears down the session they are in.
			await this.openWorkspace(opened.workspaceName);
			announce(opened.transfer.totalFiles, opened.transfer.totalFiles, true);
			return {
				notice: opened.baselineRecorded
					? opened.transfer.notice
					: // SPEC: a durable store that refused *after* the transfer succeeded is never reported as
						// a failed Open. The Workspace is bound; what it cannot say is what has changed since.
						`${opened.transfer.notice} This browser would not keep a record of what the two of ` +
						`them hold in common, so Ballastella cannot tell what has changed on either side ` +
						`until the next Publish.`
			};
		} catch (cause) {
			// The progress line must not be left mid-count saying a download is still running. What the
			// user needs is the refusal, which the dialog renders as an alert.
			this.transfer = null;
			throw cause;
		}
	}

	/**
	 * Go to the Workspace this installation already keeps for a repository, and say so.
	 *
	 * ⚠ **The key names the backing as well as the name**, so a Workspace bound by hand to a chosen
	 * folder is not selectable from here: this app can open a folder only when the user picks it, and
	 * guessing would be a silent switch to somebody else's directory. Named rather than ignored — the
	 * whole point of the lookup is that a second synchronized copy is not made, so the answer to
	 * "which one" has to be legible even when Ballastella cannot go there itself.
	 */
	async #selectOpened(workspaceKey: string, remote: RemoteRelationship): Promise<string> {
		if (this.backing === 'folder' && folderWorkspaceKey(this.folderName) === workspaceKey) {
			return (
				`${describeRemote(remote)} is already open: this Workspace folder is the one this ` +
				`computer keeps for it. Nothing has been downloaded.`
			);
		}
		// Re-read the directory rather than trust the list this session started with: the record is
		// durable, so it can name a Workspace another tab of the same installation made.
		await this.refreshWorkspaces();
		const named = this.workspaces.find((name) => opfsWorkspaceKey(name) === workspaceKey);
		if (named === undefined) {
			return (
				`${describeRemote(remote)} is already the Remote of a Workspace folder on this computer, ` +
				`so nothing has been downloaded — one computer keeps one Workspace for one repository. ` +
				`Open that folder to go on working in it.`
			);
		}
		if (named !== this.workspaceName || this.backing === 'folder') {
			await this.openWorkspace(named);
		}
		return (
			`Went back to “${named}”, which is the Workspace this computer already keeps for ` +
			`${describeRemote(remote)}. Nothing has been downloaded and nothing in it has changed.`
		);
	}

	/**
	 * A brand new browser-storage Workspace for an Open to fill, named after the repository.
	 *
	 * `createOpfsWorkspace` rather than `ensureOpfsWorkspace`, which is what makes a name collision
	 * produce `atlas (2)` beside `atlas` rather than a download writing into a Workspace the user
	 * already had. Reopening the *same* repository never reaches this — the reverse lookup selects the
	 * Workspace it already has — so what this now guards is a Workspace of the user's own that happens
	 * to share the repository's name.
	 */
	async #makeOpenDestination(preferred: string): Promise<RestoreDestination> {
		const name = await createOpfsWorkspace(preferred);
		await this.refreshWorkspaces();
		return {
			name,
			store: openOpfsWorkspace(name),
			// ⚠ **Never called by the download engine, unlike a restore's, and that is deliberate.** An
			// Open keeps what it has downloaded so that running it again resumes rather than starting
			// a pyramid over. It is here because `RestoreDestination` requires it, and it is real: were
			// a caller ever to want the restore behaviour, this is what it would do.
			discard: async () => {
				await deleteOpfsWorkspace(name);
				await this.refreshWorkspaces();
			}
		};
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
		rawStore: ProjectStore,
		backing: WorkspaceBacking,
		folderName: string,
		workspaceName = this.workspaceName
	): Promise<void> {
		// The key the *arriving* Workspace is, backing included — never the one being left.
		const workspaceKey =
			backing === 'folder' ? folderWorkspaceKey(folderName) : opfsWorkspaceKey(workspaceName);
		// ⚠ **Before anything else is given the store**, so the Import recovery, the review mark and
		// the session that follows all hold the *same* managed store and its one change index (ticket
		// 10). A raw store handed to any of them would author bytes this installation then has no
		// record of, and a Workspace whose Remote Status reads `Up to date` over work GitHub has never
		// seen is the one failure this index exists to prevent.
		const store = trackLocalChanges(rawStore, workspaceKey, this.#metadataStorage);
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
			...(this.#metadataStorage ? { metadataStorage: this.#metadataStorage } : {}),
			workspaceKey
		});
		// ⚠ **Before the mark and before the Remote, because both of those are reads of this
		// Workspace** (ticket 05). An unresolved Import marker means the arriving Workspace is not
		// available at all — its provisional files sit at ordinary paths — so a mark, a Remote, a
		// replay, or the Project the route is about to ask for would all be read over half an Import.
		const available = await this.#recoverTransfers(store);
		// ⚠ **The mark is read before `this.session` is published, and the order is the point.** The
		// banner, the Publish refusal and the backup refusal are all drawn from it, so a frame in which
		// the new session is on screen and the mark is still the *previous* Workspace's is a frame in
		// which the Publish button is offered over somebody else's work — or, switching the other way,
		// a review banner is drawn over the user's own research with a Discard button on it.
		//
		// A folder Workspace is never a review copy: a bundle only ever opens into browser storage, so
		// there is no such file to ask a folder store for.
		this.review = backing === 'folder' || !available ? null : await this.#markOf(store);
		// ⚠ **No branch on backing here, and that is the rule rather than an omission** (ADR-0032). A
		// folder Workspace and a browser one may each be bound; the review mark is forced `null` for a
		// folder above because a bundle only ever opens into browser storage, and no equivalent
		// argument exists for a binding. Read after the mark, so the seal on the credential store is
		// already answering for the arriving Workspace.
		await this.#readRemote(store, arriving);

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
		// The grant belongs to the folder that is open, so a switch into browser storage lets it go —
		// what remains reachable is the *remembered* folder, which is a different record and a gesture
		// away. A retained grant a Review Workspace is holding is untouched by this.
		if (backing === 'browser') this.#folderStore = null;
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
		//
		// Not reached at all when the Import above could not be resolved: the arriving session is on
		// screen so the failure is reported against the Workspace the user actually chose, and
		// `recovered` is left unresolved so no route reads it. The next visit retries from the marker.
		if (!available) return;
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

	/**
	 * Throw away one orphaned Workspace's journalled edits and unfinished deletions, because the user
	 * said so.
	 *
	 * ⚠ **Two counts, not their sum** (ticket 21, round 4). Round 2 added the deletion records to
	 * this and added their count to the journal's, so the one sentence rendered from the answer —
	 * *"Threw away N unsaved changes"* — was false in both nouns for a Workspace holding only a
	 * deletion note: nothing was unsaved and nothing was a change. They are two different kinds of
	 * thing with two different consequences, which is the whole reason `discardDeletions` exists
	 * beside `discardJournal` rather than inside it, and a sum is exactly what cannot say so.
	 */
	discardOrphanedJournal(key: string): { edits: number; deletions: number } {
		if (this.#journalStorage === null) return { edits: 0, deletions: 0 };
		const dropped = {
			edits: discardJournal(this.#journalStorage, key),
			deletions: discardDeletions(this.#journalStorage, key)
		};
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
