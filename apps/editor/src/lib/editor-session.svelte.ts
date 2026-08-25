import { fetchAnnotationsFromApi } from '@allmaps/stdlib';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import {
	Autosave,
	DeletedProjects,
	EditHistory,
	LocalChangeIndex,
	ManagedProjectStore,
	MapImageInUseError,
	PublishManifests,
	SynchronizationMetadata,
	MapImagePartlyDeletedError,
	OpfsProjectStore,
	PathNotFoundError,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	ReservedDirectoryNameError,
	WriteAheadJournal,
	Workspace,
	addLayer,
	alignmentImageId,
	alignmentPath,
	annotationStorePath,
	assembleWithCanvas,
	browserJournalStorage,
	browserMetadataStorage,
	forgetHeldCopy,
	deletionsAreNoteworthy,
	replayIsNoteworthy,
	replayJournal,
	baseMapCacheSize as readBaseMapCacheSize,
	baseMapCacheSizeFor as readBaseMapCacheSizeFor,
	cachedTilePath,
	checkSourceStatus,
	clearBaseMapCache as emptyBaseMapCache,
	createStoreImageFetch,
	readCachedTileSource,
	writeCachedTileSource,
	deleteMapImage,
	emptyAnnotationCollection,
	exportProjectBundle,
	imageDirectory,
	imageInfoPath,
	imageManifestPath,
	imageSizeFromInfo,
	ingestImageFile,
	fetchTilesIntoCache,
	installFlushOnHide,
	listIngestedImages,
	listReferencedImages,
	listWorkspaceMapImages,
	makeOfflineCopy,
	manageProjectStore,
	moveLayer,
	layerFileRef,
	newAlignment,
	newAnnotationLayer,
	newMapLayer,
	offlineCoverage,
	emptyCollection,
	openDecodeAndCropSource,
	parseAlignment,
	parseAnnotations,
	parseProjectFile,
	partitionByOfflineCopy,
	planPublish,
	planRemotePublish as planWorkspaceUpload,
	projectFilePath,
	publishSite,
	publishWorkspaceToRemote as publishWorkspace,
	readPublishedSite,
	readImageLabel,
	readRemoteInventory,
	updateFromGitHub,
	referencedAlignmentAddress,
	referencedImage,
	referencedImagePath,
	removeLayer,
	renameLayer,
	serialiseAnnotations,
	serialiseReferencedImage,
	setLayerVisible,
	setMapLayerOpacity,
	sourceOf,
	workspaceSize,
	writeAlignmentBytes,
	writeAlignmentFileReporting,
	type Alignment,
	type AlignmentAddress,
	type AlignmentFilePort,
	type AlignmentWriteOutcome,
	type AnnotationCollection,
	type AnnotationLayer,
	type BaseMapCacheSize,
	type Bytes,
	type StorePath,
	type CachedTileSource,
	type FetchFn,
	type FetchTilesOptions,
	type GeoBounds,
	type HistoryFiles,
	type MapImageSource,
	type IngestProgress,
	type IngestedImage,
	type FinishedDeletions,
	type WorkspaceIdentity,
	type JournalReplayReport,
	type JournalStorage,
	type MetadataStorage,
	type Layer,
	type MapLayer,
	type OfflineCopyPlan,
	type OfflineCopyProgress,
	type OfflineCoverage,
	type PendingLocalFile,
	type ProjectFile,
	type ProjectStore,
	type ProjectSummary,
	type PublishPlan,
	type PublishedRepository,
	type PublishedSite,
	type ReferencedImage,
	type RemoteImageService,
	type RemotePublishPlan,
	type RemoteRepository,
	type RemoteStatusObservation,
	type SaveState,
	type SynchronizationBaseline,
	type TileCoordinate,
	type TileFetchResult,
	type TransferProgress,
	type UpdateDeletionPreview,
	type ViewerBundle,
	type ViewerBundleFile,
	type WorkspaceMapImage,
	type WorkspaceSize,
	type WorkspaceUpdate
} from '@ballastella/core';

import { recordAlignmentWrite } from './alignment/browser-test-handle.js';
import { recordAnnotationWrite } from './annotations/browser-test-handle.js';
import { saveFile } from './save-file.js';

/**
 * Whether the workspace can be reached. Not reachable is a **normal state** with a
 * locate-again affordance, not an unhandled rejection at startup (ADR-0008): a folder gets
 * moved, renamed, deleted, or has its permission declined, and a scholar who meets a stack
 * trace at that moment reasonably concludes the tool has eaten their work.
 */
export type WorkspaceStatus = 'loading' | 'ready' | 'unreachable';

/**
 * The write-ahead journal's key for a named Workspace in browser storage, and for a folder.
 *
 * **The backing is in the key**, because a folder called `Marking 2026` and an OPFS Workspace
 * called `Marking 2026` are two different places holding two different people's afternoons, and one
 * replaying into the other is exactly the failure ticket 12 made easy to reach.
 */
export const opfsWorkspaceKey = (name: string): string => `opfs:${name}`;
export const folderWorkspaceKey = (folderName: string): string => `folder:${folderName}`;

/**
 * Install local-change tracking around the store an ordinary Workspace is about to be opened from.
 *
 * ⚠ **The one place a {@link LocalChangeIndex} is constructed, and both backings go through it.** A
 * chosen folder and a browser-storage Workspace are marked by the same wrapper — the seam is
 * `ProjectStore`, so there is nothing backend-specific to get right — and `manageProjectStore` is
 * idempotent, so a Workspace switched away from and back to is never wrapped twice.
 *
 * Untracked where there is no durable metadata store, exactly as the journal and the Baseline are:
 * a browser that will not keep a record cannot be given one, and its Remote Status reads
 * `Cannot tell` rather than a fabricated `Up to date`.
 */
export function trackLocalChanges(
	store: ProjectStore,
	workspaceKey: string,
	metadataStorage: MetadataStorage | null
): ProjectStore {
	return metadataStorage === null
		? store
		: manageProjectStore(store, new LocalChangeIndex(metadataStorage, workspaceKey));
}

/**
 * Whether a Workspace key names **one place** or only a name a user can reproduce anywhere.
 *
 * Beside the two constructors above and derived from the same prefixes, so that no call site can
 * hold a key and a contradicting opinion about it — which is the one way `Workspace`'s option could
 * be got wrong. See {@link WorkspaceIdentity} for why this, and not any comparison of what is inside
 * the directory, is what licenses finishing a deletion unattended.
 *
 * A prefix this build does not know answers `'a-name-anywhere'`, which destroys nothing.
 */
export const workspaceIdentityOf = (key: string): WorkspaceIdentity =>
	key.startsWith('opfs:') ? 'this-browser' : 'a-name-anywhere';

/**
 * A journal key as a **Workspace the user recognises**, never as the key itself.
 *
 * ⚠ **`opfs:` is a debug token and it was reaching the screen**, in "finished saving in
 * `opfs:Marking 2026`" and on the buttons in Workspace settings. CONTEXT.md is that the UI names
 * the Workspace; a scholar has never seen that prefix and has no way to find out what it means.
 *
 * The folder case keeps a qualifier rather than dropping the distinction, because a folder
 * Workspace and a browser-storage one may share a name and the sentence has to be true of exactly
 * one of them.
 */
export function workspaceKeyLabel(key: string): string {
	if (key.startsWith('opfs:')) return key.slice('opfs:'.length);
	if (key.startsWith('folder:')) return `${key.slice('folder:'.length)} (Workspace folder)`;
	// A key from a build that keyed them differently. Shown as it is rather than mangled: the user
	// is being asked to recognise it, and a prefix this build does not know is information.
	return key;
}

/**
 * A transfer in flight, for the status region that announces it.
 *
 * A bundle of an offline copy's pyramid takes real seconds to tens of seconds, and it is announced
 * rather than merely drawn: workspace-and-layers SPEC story 96 asks for status to reach assistive technology, and this is
 * one of the two places in the app where the user is waiting on something they cannot see.
 */
export interface TransferState {
	/**
	 * Which transfer, because the three count differently.
	 *
	 * `'export'` and `'import'` both know their total before they start — an export walks a Project it
	 * can already list, and an Import is planned over a closure whose path set is decided before a byte
	 * moves. `'open'` does not: a tar declares no index, so it counts up with no denominator to invent.
	 */
	readonly kind: 'export' | 'import' | 'open';
	/** The Project being moved, by display name where there is one. */
	readonly subject: string;
	readonly files: number;
	readonly totalFiles: number;
	readonly finished: boolean;
}

/**
 * Why the Project named in `?p=` cannot be shown, or why the one that was asked for was not made.
 *
 * `'reserved-name'` is the second of those and the only one that is about a Project which does not
 * exist yet: ADR-0023 keeps `images/`, `alignments/`, and `base-map/` for the Workspace itself, and a
 * scholar typing "Images" has done nothing wrong — `toDirectoryName` is what turned it into a
 * collision. It is a problem with the *name*, so it is rendered on the hub beside the list, and never
 * as an unreachable Workspace: the Workspace is right there and every other Project must stay visible.
 */
export type ProjectProblem =
	| { readonly kind: 'format-too-new' | 'unreadable'; readonly message: string }
	| { readonly kind: 'missing'; readonly message: string }
	| { readonly kind: 'reserved-name'; readonly message: string };

/**
 * What adding a Map Image did to `alignments/<image-id>.json`.
 *
 * Three outcomes rather than a boolean because only one of them is worth telling the user about,
 * and it is not the one a boolean would name. `'left alone'` is the ordinary re-add, silent by
 * design; `'kept over the offer'` is the user having asked for a community Alignment and not got
 * it, which must be said out loud — a Map Image has **one** Alignment, shared by every Project
 * that draws it (ADR-0023), so importing over it would have discarded work that may belong to a
 * Project the user is not even looking at.
 *
 * **The union itself is `AlignmentWriteOutcome`, imported rather than restated** (ticket 18). It was
 * spelled out here as well, which is two spellings of one vocabulary in the ticket that exists
 * because two spellings of one rule drifted apart.
 */
type InitialAlignment = AlignmentWriteOutcome;

/** A Map Image put in the stack, and what became of its Alignment. */
type MapLayerAdded = {
	/** The new Layer, or the one this Project already had for this Map Image. */
	readonly layer: MapLayer;
	readonly alignment: InitialAlignment;
};

/** One opacity drag in progress, and the Edit History Step held open across it. */
interface OpacityDrag {
	readonly id: string;
	/**
	 * Every position reported so far, in the order they arrived and behind the `before` image being
	 * taken. Extended by each one, and awaited by the release.
	 */
	applied: Promise<void>;
	/** Ends the gesture the Step is wrapped around. */
	readonly end: () => void;
	/** The Step itself, awaited by whoever ends it so the last position is written before they return. */
	readonly step: Promise<void>;
}

/**
 * One style drag in progress over an Annotation Layer's file, and the Step held open across it.
 *
 * `key` is which slider on which Annotation, so that a scholar moving from stroke width to stroke
 * opacity without letting go gets two Steps rather than one merged one.
 */
interface AnnotationDrag {
	readonly key: string;
	readonly path: StorePath;
	/**
	 * Every position reported so far, in the order they arrived and behind the `before` image being
	 * taken. Extended by each one, and awaited by the release.
	 */
	applied: Promise<void>;
	/** Ends the gesture the Step is wrapped around. */
	readonly end: () => void;
	/** The Step itself, awaited by whoever ends it so the last position is written before they return. */
	readonly step: Promise<void>;
}

/** The outcome of {@link EditorSession.addReferencedMap}. */
export type ReferencedMapAdded = {
	/** The new Layer, or the one this Project already had for this Map Image. */
	readonly layer: MapLayer;
	/**
	 * The user chose a community Alignment and it was **not** written, because this Workspace already
	 * holds an Alignment for that Map Image that somebody has worked on. The Layer was still
	 * added, and it draws the Alignment that was already there. The surface that asked must say so.
	 */
	readonly keptExistingAlignment: boolean;
};

/**
 * Everything the editor knows about the user's workspace, and the only place the app talks to
 * `@ballastella/core`.
 *
 * The store is injected rather than reached for, so the browser tests can hand in a backend
 * that fails and the app has no idea it is being lied to.
 *
 * **It is also the app's only writer of `project.json`, and holds the only in-memory copy of
 * it.** Every pane that records something — the Project name here, the Base Map default in
 * ticket 04, the Layer stack in ticket 09 — mutates {@link openProject} and writes through
 * {@link Workspace}. A pane that kept its own snapshot and serialised the whole document back
 * would clobber whatever another pane had just written, and ticket 07 puts both panes on one
 * page, which makes that a race inside a single component rather than between tabs.
 */
/** How a session is told which Workspace it is, which is what the journal is keyed by. */
export interface EditorSessionOptions {
	/**
	 * Where an edit is written ahead of the store (ticket 20).
	 *
	 * Optional, and its absence is a real state rather than a default: a browser with no usable
	 * `localStorage` — a locked-down private window — cannot offer this protection at all, and a
	 * silent stand-in would make the app claim a guarantee it does not have.
	 */
	readonly journalStorage?: JournalStorage;
	/**
	 * Which Workspace this session is, for the journal's key.
	 *
	 * ⚠ **Includes the backing, because two different Workspaces may share a name.** `opfs:Marking
	 * 2026` and `folder:Marking 2026` are two directories in two places, and an edit typed into one
	 * must not be replayed into the other.
	 *
	 * ⚠ **And a folder Workspace is identified by its folder's name, which is not unique.** The
	 * browser offers a picked directory no stable identifier a page may keep, so two folders called
	 * `maps` on two drives share a key. What bounds the damage is replay's own precondition — the
	 * Project's `project.json` has to still be there — and what remains is a case that is strictly
	 * better than today's, where the edit is simply lost. It is recorded in ADR-0017 rather than
	 * left here to be found.
	 */
	readonly workspaceKey?: string;
	/**
	 * Where this installation's synchronization metadata is kept (ADR-0038).
	 *
	 * Optional for the reason {@link journalStorage} is: a context with no IndexedDB cannot hold a
	 * Remote relationship or a Baseline at all, and a silent stand-in would let the app claim
	 * synchronization evidence it has no way to keep. Its absence reads as `Cannot tell`.
	 */
	readonly metadataStorage?: MetadataStorage;
}

export class EditorSession {
	readonly #workspace: Workspace;
	/** Which Workspace this session is, for an Update's durable record of one. `''` when unkeyed. */
	readonly #workspaceKey: string;
	readonly #autosave: Autosave;
	/** The write-ahead journal for **this** Workspace, or `undefined` where there can be none. */
	readonly #journal: WriteAheadJournal | undefined;
	readonly #journalStorage: JournalStorage | undefined;
	/**
	 * Which Projects the user deleted from **this** Workspace (ticket 21).
	 *
	 * `undefined` on a browser that will not give the page `localStorage`, exactly as {@link #journal}
	 * is, and for the same reason: the protection is genuinely unavailable there and a stand-in would
	 * make the app claim it anyway. That case — no storage at all — is what `WorkspaceStorage`'s
	 * `unprotected` sentence covers.
	 *
	 * ⚠ **The case where there *is* a storage and it refuses the write is a different one, and it
	 * used to be silent.** This comment claimed `protectionWarning`'s sibling "already says so in
	 * words"; it does not. That sentence is about an edit on its way to being saved and offers
	 * "wait for the indicator to read Saved", which is a remedy a deletion does not have — and it is
	 * not shown at all in the read-only-`localStorage` case, which is precisely where `record`
	 * fails. ADR-0017 asks for **two refusals, not one**, so there is now
	 * {@link deletionWarning}.
	 */
	readonly #deleted: DeletedProjects | undefined;
	/**
	 * The v1 `localStorage` publish manifest, kept only so migration can read it (ADR-0038).
	 *
	 * ⚠ **Not a runtime store any more.** What the Remote last held is the Synchronization Baseline in
	 * {@link #synchronization}; this is consulted once, by `migrateSynchronizationMetadata`, to decide
	 * whether a v1 Workspace's binding is corroborated by evidence this machine wrote itself.
	 *
	 * `undefined` where there can be no journal storage, exactly as {@link #deleted} is.
	 */
	readonly #manifests: PublishManifests | undefined;
	/**
	 * This Workspace's installation-local Remote relationship and Baseline, or `undefined` where there
	 * is nowhere durable to keep them.
	 */
	readonly #synchronization: SynchronizationMetadata | undefined;
	/** Held for the tiler, which writes tens of thousands of files that are not `project.json`. */
	readonly #store: ProjectStore;
	/** Bumped by every {@link open}, so a read that resolves late knows it has been superseded. */
	#openGeneration = 0;
	/**
	 * One Edit History per subject — a Project directory, or a Map Image id (ADR-0039).
	 *
	 * Held here rather than by a screen because a history outlives the screen that draws it: walking
	 * from the Project screen to `/align` and back must find the same one. Created on first use and
	 * dropped with the session, which is what makes switching Workspace leave none behind (SPEC story
	 * 41) — a new Workspace is a new `EditorSession`.
	 *
	 * A `SvelteMap` because `svelte/prefer-svelte-reactivity` requires one, and as with
	 * {@link #alignmentOnDisk} that is free rather than merely tolerable: nothing reads this in a
	 * reactive context. What a screen renders is the history's own subscription, not this.
	 */
	readonly #histories = new SvelteMap<string, EditHistory>();

	/**
	 * How many times an Edit History has written an Annotation Layer's document back.
	 *
	 * A counter rather than a path, because what the Project screen does with it is re-read every
	 * Layer's document: it holds one record for Alignments and collections together, and a Step may
	 * name a Layer whose row is not even on screen. Bumped only by {@link #historyFiles}, so an
	 * ordinary edit — which changes the in-memory collection itself — costs no read at all.
	 */
	annotationsWrittenBack = $state(0);

	/**
	 * How many times an Edit History has written an Alignment back.
	 *
	 * The Align screen's cue to re-read. Control Point ids are minted per session and are not in the
	 * file, so an Alignment that has just been written back has fresh ones and the pairing on screen
	 * has to be rebuilt from it rather than patched (ADR-0039).
	 *
	 * A counter rather than an image id, as with {@link annotationsWrittenBack}: only the screen
	 * showing a Map Image declares that map's Edit History, so the one re-read this can provoke is
	 * the one that was asked for.
	 */
	alignmentsWrittenBack = $state(0);

	/**
	 * The opacity drag now under way, and the Step held open for it, or `null`.
	 *
	 * A drag reports every position it passes through, and each one is an ordinary debounced write —
	 * but the Step spans the whole gesture, so undo goes back to where the drag started rather than to
	 * a value inside it (SPEC story 17). Opened by {@link #openOpacityStep} and closed by
	 * {@link commitLayerEdit}, which is what the range's `change` event reaches.
	 */
	#opacityDrag: OpacityDrag | null = null;

	/**
	 * The Annotation style drag now under way, and the Step held open for it, or `null`.
	 *
	 * The Annotation half of what {@link #opacityDrag} is for the Layer stack: every position a range
	 * reports is an ordinary debounced write, and the Step spans the whole gesture so undo goes back
	 * to the style the Annotation had before the drag rather than to a value inside it (SPEC story 23).
	 * Opened by {@link dragAnnotations} and closed by the unlabelled {@link writeAnnotations} the
	 * range's `change` event reaches.
	 */
	#annotationDrag: AnnotationDrag | null = null;

	/**
	 * How every Edit History reads and writes the files it holds.
	 *
	 * Ordinary writes go through {@link Autosave}, so an undo coalesces and flushes like any other
	 * edit and there is no bespoke save path (ADR-0017). `null` deletes, which is how redo of a
	 * restored file removes it again.
	 */
	readonly #historyFiles: HistoryFiles = {
		flush: () => this.flush(),
		read: async (path) => {
			try {
				return await this.#store.read(path);
			} catch (cause) {
				// No file is an image in its own right: it is what a Step records for a file the gesture
				// created, and what undo writes back to remove it again.
				if (cause instanceof PathNotFoundError) return null;
				throw cause;
			}
		},
		writeBack: async (path, bytes) => {
			const imageId = alignmentImageId(path);
			try {
				if (imageId !== null) {
					await this.#writeAlignmentBack(imageId, bytes);
				} else if (bytes === null) {
					await this.#store.delete(path);
				} else {
					await this.#autosave.commit(path, bytes);
				}
			} catch (cause) {
				// ⚠ **Reported here, because nowhere else can report it.** `EditHistory` moves its cursor
				// only on a write that landed, so a failed undo leaves the bar reading exactly as it did
				// before the press — which is what a *successful* undo of a no-op would look like too.
				// The forward gestures each set this in their own catch; a write-back has no such caller,
				// so without this the failure reaches the user as nothing at all (SPEC story 50).
				this.saveError = cause instanceof Error ? cause.message : String(cause);
				// Rethrown: the history counts this file as not landed, which is what keeps the Step and
				// the cursor where they are.
				throw cause;
			}
			// The document on screen is the one in memory, and a history writes bytes rather than
			// calling the mutators that keep it. Without this the Layer would be back in the file and
			// absent from the stack until something re-read it.
			if (this.openDirectory !== null && path === projectFilePath(this.openDirectory)) {
				this.openProject = bytes === null ? null : parseProjectFile(bytes);
			}
			// The same problem for an Annotation Layer's collection, which is the Project screen's rather
			// than this class's: it holds the map Layers' Alignments in the same record. So this says a
			// fresh read is due and the screen does it, which is also where a selection the write-back
			// took away is let go of (SPEC stories 52, 53).
			if (this.openDirectory !== null && path.startsWith(`${this.openDirectory}/annotations/`)) {
				this.annotationsWrittenBack += 1;
			}
			// And for an Alignment, which the Align screen cannot patch in place: Control Point ids are
			// minted per session and are not in the file, so what came back has fresh ones and the
			// pairing has to be rebuilt from it (ADR-0039).
			if (imageId !== null) this.alignmentsWrittenBack += 1;
			this.saveError = '';
		}
	};

	status = $state<WorkspaceStatus>('loading');
	/** The underlying failure, shown beneath "Workspace not reachable" so it is diagnosable. */
	unreachableDetail = $state('');
	projects = $state<ProjectSummary[]>([]);
	saveState = $state<SaveState>('saved');
	/**
	 * Why the last edit is **not** protected against this tab closing before it is saved, or `''`.
	 *
	 * Distinct from {@link saveError}, which is why an edit did not reach storage. This one says the
	 * edit is on its way and the safety net under it is missing — a different sentence with a
	 * different remedy, and one the user can act on only while the page still exists (ticket 20).
	 */
	protectionWarning = $state('');
	/**
	 * What the last startup replay put back, if anything, for the user to be told about.
	 *
	 * `null` until a replay has run, and left `null` when it had nothing to say. SPEC story 111 wants
	 * this as visible text and story 112 wants it announced, and a recovery the user cannot tell
	 * happened is one they cannot check.
	 */
	replayReport = $state<JournalReplayReport | null>(null);
	/**
	 * What the last startup's *deletions* did, if anything (ticket 21, review 2).
	 *
	 * ⚠ **The destructive half of the same recovery chain, and it reported nothing in either
	 * direction.** `Workspace.finishInterruptedDeletions` answered with three lists and
	 * `EditorSession` discarded all three. ADR-0017's standard for this chain is explicit and
	 * repeated — *"every replay is named to the user, so an older state coming back is visible rather
	 * than silent"*, *"Nothing is reported as restored that was not written"* — and the replay half
	 * honoured it while the half that **removes files from a scholar's folder during startup** said
	 * nothing at all. SPEC stories 111 and 112 apply to it exactly as they apply to a replay, and the
	 * silence is also what made a wrong-folder deletion undetectable before the manifest precondition
	 * existed to refuse one.
	 *
	 * `null` when a startup found nothing to do, which is the ordinary case.
	 */
	deletionReport = $state<FinishedDeletions | null>(null);
	/**
	 * Why this deletion is **not** protected against the tab closing before it finishes, or `''`.
	 *
	 * The sibling {@link protectionWarning} is not (ticket 21, review 2). That one is about an edit
	 * on its way to storage and its remedy is "wait for the indicator to read Saved"; a deletion has
	 * no indicator and no such wait, and the browsers that reach this are ones where reads answer and
	 * writes reject — a full `localStorage` (ADR-0017 documents a single Annotation collection
	 * filling the 5 MB the deletion record shares), and Safari with cookies blocked, where the
	 * read-only probe accepts the storage and every write throws.
	 */
	deletionWarning = $state('');
	/**
	 * Why the last edit did not reach storage, if it did not. Shown beside the save indicator.
	 *
	 * A write that fails is not an unreachable Workspace — the Workspace is right there and its
	 * Projects still list — so it must not replace the page with "not reachable". ADR-0017 rule 5
	 * makes the indicator the signal for this, and a quota failure that says nothing at all is
	 * the worst version: the map switches, the app looks fine, and the choice is gone on reopen.
	 */
	saveError = $state('');

	/** The export or bundle-opening in flight, or `null`. Rendered as announced status. */
	transfer = $state<TransferState | null>(null);
	/**
	 * Why the last export did not happen. It is the whole point of the refusals: ADR-0010's "this
	 * Project is from a newer version" has to reach a screen, or a user hands a colleague a file that
	 * silently does nothing.
	 */
	transferError = $state('');

	/** The Project directory currently open, from `?p=`. */
	openDirectory = $state<string | null>(null);
	openProject = $state<ProjectFile | null>(null);
	projectProblem = $state<ProjectProblem | null>(null);

	/**
	 * The Map Images **the Workspace** holds, and the ingest running now if one is (ADR-0023).
	 *
	 * Not the open Project's: a pyramid is shared, so `images/` has one answer whichever Project is
	 * open, and which of these a Project *draws* is its Layer stack rather than a second list.
	 *
	 * `ingest` is `null` between jobs rather than a finished-looking value, so the progress region
	 * disappears when there is nothing to report instead of sitting at 100% forever.
	 */
	images = $state<IngestedImage[]>([]);
	/**
	 * The Map Images the Workspace **references** rather than holds (ADR-0007, ADR-0023).
	 *
	 * A separate list from {@link images}: a local copy has an `info.json` of ours beside it and a
	 * referenced image has a `remote.json` instead, because its tiles and its description are both on
	 * somebody else's server. Keeping them apart is what makes "referenced or local copy?" an
	 * observation of the files rather than a flag in `project.json` that could disagree with them.
	 *
	 * An image that has been copied offline appears in **both** — its pyramid is here and its
	 * `remote.json` stays, because that record is the citation ADR-0007 protects — so this is the list of
	 * everything the Workspace knows an origin for, and {@link remoteOrigins} is what says which are
	 * still fetched from the library.
	 */
	referencedImages = $state<ReferencedImage[]>([]);
	/**
	 * Referenced images whose `remote.json` will not parse, by id and reason.
	 *
	 * Surfaced rather than swallowed, for the same reason {@link alignmentError} is: the Project has a
	 * Layer that names an image nothing can draw, and drawing nothing while saying nothing is how a
	 * user concludes the tool lost their work.
	 */
	referencedImageErrors = $state<{ imageId: string; reason: string }[]>([]);

	/**
	 * Every Map Image in the Workspace, with its size, where its tiles are, and who draws it.
	 *
	 * The hub's reclaim list — the one place a scholar can answer "why is my Workspace two gigabytes?"
	 * (SPEC stories 63–65). Loaded by {@link refreshMapImages} rather than on every render, because
	 * it weighs every file under `images/` and that is a walk a keystroke must not trigger.
	 *
	 * A **separate** list from {@link images} and {@link referencedImages}, which are what an open
	 * Project's panes read: those two are the raw halves of the observation, and this is the answer with
	 * used-by and a size against it.
	 */
	mapImages = $state<WorkspaceMapImage[]>([]);

	/** Whether {@link mapImages} is still being walked, so the hub can say so rather than "none". */
	mapImagesLoading = $state(false);
	/**
	 * Why the last attempt to delete a Map Image did not happen, or `''`.
	 *
	 * A refusal rather than an error boundary: a map two Projects draw cannot be deleted, and the
	 * sentence naming them is the whole of the interaction (SPEC story 64).
	 */
	mapImageError = $state('');

	/**
	 * Why adding a Map Image the Workspace already holds did not happen, or `''`.
	 *
	 * Its own field rather than {@link ingestError}, which is the file source's, and rather than
	 * {@link mapImageError}, which is the hub's refusal to delete. Three different gestures fail
	 * for three different reasons, and a shared field is how one of them ends up wearing another's
	 * sentence — which this epic has already shipped once, in `layer-not-aligned`.
	 */
	addMapError = $state('');

	ingest = $state<IngestProgress | null>(null);
	/** The name of the file being ingested, for the progress message (SPEC story 23). */
	ingestLabel = $state('');
	ingestError = $state('');
	/** Not `$state`: nothing renders it, and `cancelIngest` is the only reader. */
	#ingestAbort: AbortController | null = null;

	/**
	 * Why the Map Image's stored Alignment could not be read, if it could not.
	 *
	 * A file that is there and unreadable must say so. Falling back to an empty Alignment silently
	 * would show the user no Control Points and then overwrite the ones they had on the next save —
	 * which is the largest single loss this slice could inflict.
	 */
	alignmentError = $state('');

	/**
	 * An Alignment somebody else changed while this session had it open, and what they had (ticket 07).
	 *
	 * `null` until it happens, and it is **not cleared by the next write** — see
	 * {@link dismissAlignmentChangedElsewhere}. A notice about work the user cannot see, that
	 * disappears on their next gesture, is a notice nobody reads. Only the user dismissing it, or
	 * putting the other version back, ends it.
	 *
	 * ADR-0023's mitigation is visibility, and this field is the visibility: the write already
	 * happened, so nothing here is a guard.
	 */
	alignmentChangedElsewhere = $state.raw<{
		readonly imageId: string;
		/** What was on disk and has been written over. Kept so it can be offered back. */
		readonly displaced: Bytes;
	} | null>(null);

	/**
	 * For each Map Image, the Alignment bytes this session believes are on disk.
	 *
	 * Written by {@link readAlignment} — what it read — and by every successful
	 * {@link writeAlignment} — what it wrote. `Autosave.commit` resolves only once the store has the
	 * bytes, so "what we last wrote" really is what is on disk at that moment; a debounced write
	 * would have made this an announcement of a change that had not happened yet, which is why
	 * {@link writeAlignment} must keep using `commit` rather than `queue`.
	 *
	 * `null` records "there was no file", which is different from having no entry at all: no entry
	 * means this session has never looked, and a write from there makes no claim to check.
	 *
	 * A `SvelteMap` because `svelte/prefer-svelte-reactivity` requires one, and here that is free
	 * rather than merely tolerable: **nothing reads this in a reactive context.** The only readers are
	 * {@link writeAlignment} and {@link restoreAlignmentChangedElsewhere}, both called from event
	 * handlers, so there is no `$derived` for a write to invalidate. What *is* rendered is
	 * {@link alignmentChangedElsewhere}, which is set from the write's result.
	 *
	 * That field is `$state.raw`, and since this ticket's second round that is load-bearing rather
	 * than a performance choice: {@link restoreAlignmentChangedElsewhere} clears it only when it is
	 * **identically** the record it was answering, so that an answer to one warning cannot blank a
	 * newer one that arrived while it waited. A deeply reactive proxy would not compare that way.
	 */
	readonly #alignmentOnDisk = new SvelteMap<string, Bytes | null>();

	/**
	 * The Alignment write currently in flight for each Map Image, so the next one waits for it.
	 *
	 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
	 * │ WITHOUT THIS, THIS SESSION REPORTS *ITSELF* AS THE COLLEAGUE WHO CHANGED THE FILE.         │
	 * └───────────────────────────────────────────────────────────────────────────────────────────┘
	 *
	 * `AlignmentWorkspace.save()` fires and does not await — correctly, because a gesture end must not
	 * wait on a store write. {@link writeAlignment} reads {@link #alignmentOnDisk} at entry and moves
	 * it only once the commit has resolved. So **two gesture ends inside one store write** gave the
	 * second call a baseline one version stale: `alignment-file.ts` re-read, found the *first call's
	 * own bytes*, and reported "written over a change" with the user's own document as `displaced`.
	 *
	 * That is the exact false alarm {@link #rememberAlignmentOnDisk} exists to prevent, reachable from
	 * this application's own save path rather than from a synced Workspace — and it is the likelier of
	 * the two in practice, because it needs nothing but a fast hand. A warning about work you cannot
	 * see, raised by your own previous keystroke, is one a scholar learns to dismiss; the next one is
	 * real.
	 *
	 * **A queue and not a lock.** Nothing is refused and nothing is dropped: each write still happens,
	 * in the order the gestures ended, which is the order the user made them. What it removes is the
	 * overlap, and with it the only way this session can see its own bytes as somebody else's. It says
	 * nothing about the residual `AlignmentWrite.update` states — a *real* colleague landing a change
	 * between the re-read and the commit is still lost silently, and no per-session queue can help
	 * with that.
	 *
	 * Keyed per Map Image, because two different maps' Alignments are two different files and
	 * serialising them against each other would be a debounce nobody asked for.
	 *
	 * A `SvelteMap` for `svelte/prefer-svelte-reactivity`; as with {@link #alignmentOnDisk}, nothing
	 * reads it in a reactive context.
	 */
	readonly #alignmentWriteInFlight = new SvelteMap<string, Promise<void>>();

	constructor(store: ProjectStore, options: EditorSessionOptions = {}) {
		this.#store = store;
		this.#workspaceKey = options.workspaceKey ?? '';
		this.#journalStorage = options.journalStorage;
		this.#journal =
			options.journalStorage && options.workspaceKey
				? new WriteAheadJournal(options.journalStorage, options.workspaceKey)
				: undefined;
		this.#autosave = new Autosave(store, {
			...(this.#journal ? { journal: this.#journal } : {}),
			// The whole reason the journal is written at the edit rather than at `pagehide`: there is
			// still a screen to put this on and a person to read it (SPEC stories 111 and 112). At
			// `pagehide` there would be neither.
			onJournalRefused: (problem) => {
				this.protectionWarning =
					problem === null ? '' : problem instanceof Error ? problem.message : String(problem);
			}
		});
		this.#deleted =
			options.journalStorage && options.workspaceKey
				? new DeletedProjects(options.journalStorage, options.workspaceKey)
				: undefined;
		this.#manifests =
			options.journalStorage && options.workspaceKey
				? new PublishManifests(options.journalStorage, options.workspaceKey)
				: undefined;
		this.#synchronization =
			options.metadataStorage && options.workspaceKey
				? new SynchronizationMetadata(options.metadataStorage, options.workspaceKey)
				: undefined;
		this.#workspace = new Workspace(store, {
			autosave: this.#autosave,
			...(this.#deleted ? { deleted: this.#deleted } : {}),
			// Out of the key the records are filed under, and out of nothing else. A session with no
			// key has no `#deleted` either, so nothing ever consults this — but `''` answers
			// `'a-name-anywhere'`, which is the direction that destroys nothing, rather than leaving
			// the safe answer to a ternary a reader has to check.
			identity: workspaceIdentityOf(options.workspaceKey ?? ''),
			// What a `project.json` held when it was read, told to the journal (ticket 07). See
			// {@link #readObserved} for why the read path is where this has to come from, and why the
			// port has two calls rather than one.
			...(this.#journal ? { observer: this.#journal } : {}),
			onDeletionNotRecorded: () => {
				this.deletionWarning =
					'This browser would not let Ballastella write the deletion down, so it is only as ' +
					'safe as this tab: if the page closes before it finishes, the Project can come back. ' +
					'Wait for it to disappear from the list before closing this tab. Site data may be ' +
					'blocked for this site, or browser storage may be full.';
			}
		});
		this.#autosave.subscribe((state) => {
			this.saveState = state;
		});
	}

	/**
	 * This Workspace's installation-local Remote relationship and Baseline, or `null` where there is
	 * nowhere durable to keep them — which reads as unbound and `Cannot tell`.
	 *
	 * Exposed because the migration decision and the bind/unbind gestures live in
	 * `WorkspaceStorage`, and both must act on the *same* record this session publishes against.
	 */
	get synchronization(): SynchronizationMetadata | null {
		return this.#synchronization ?? null;
	}

	/**
	 * What Ballastella has written or deleted in this Workspace since its Baseline, or `null` where
	 * nothing is tracking it (ADR-0038).
	 *
	 * The seam an automatic Remote Status check is answered from, and the reason it can be answered at
	 * all without reading a multi-gigabyte Workspace. `null` is a session whose store was never
	 * managed — no durable metadata to keep marks in — which reads as `Cannot tell`.
	 */
	get localChanges(): ManagedProjectStore | null {
		return this.#store instanceof ManagedProjectStore ? this.#store : null;
	}

	/** The v1 manifest reader migration corroborates a legacy binding against, or `null`. */
	get legacyManifests(): PublishManifests | null {
		return this.#manifests ?? null;
	}

	/** The default: a named workspace in OPFS, which every modern browser has (ADR-0001, ADR-0024). */
	static opfs(name: string): EditorSession {
		const journalStorage = browserJournalStorage();
		const metadataStorage = browserMetadataStorage();
		return new EditorSession(
			trackLocalChanges(OpfsProjectStore.open(name), opfsWorkspaceKey(name), metadataStorage),
			{
				...(journalStorage ? { journalStorage } : {}),
				...(metadataStorage ? { metadataStorage } : {}),
				workspaceKey: opfsWorkspaceKey(name)
			}
		);
	}

	/**
	 * Carry out any deletion the user asked for that the page did not live long enough to finish
	 * (ticket 21).
	 *
	 * **Before {@link replayJournalledEdits}, not after**, and the order is load-bearing in one
	 * direction only: with the record still in place, a replay that ran first would refuse the
	 * deleted Project's entries by name rather than by inference, which is what
	 * `ReplaySkipReason: 'project-deleted'` is for — so either order is *safe*. This order is the one
	 * that leaves nothing on disk for a listing to find, which is what the hub renders.
	 *
	 * Resolves rather than rejects, for the same reason the replay does: a Workspace too broken to
	 * finish a deletion in is one the listing beside this is about to describe properly (ADR-0008).
	 */
	async finishInterruptedDeletions(): Promise<void> {
		try {
			const report = await this.#workspace.finishInterruptedDeletions();
			// Named to the user, in both directions, for the reason `replayReport` is — and with more
			// reason: this one took files away. See {@link deletionReport}.
			this.deletionReport = deletionsAreNoteworthy(report) ? report : null;
		} catch {
			// A store that cannot even be listed. Every record stays where it is and is tried again at
			// the next startup; the listing beside this is what tells the user the Workspace is
			// unreachable.
		}
	}

	/**
	 * Throw away the note behind one refused deletion, because the user said to (ticket 21, round 4).
	 *
	 * ⚠ **The only exit a refusal had was the destructive one.** Since round 3 a folder Workspace
	 * finishes no deletion unattended, so a refusal is the *whole* of what a startup there ever
	 * reports — and nothing ended one. No record expires; `Workspace.#claim` drops one only when a
	 * Project is created or duplicated under that name; and Workspace settings' discard is by
	 * construction unable to reach the Workspace that is open, which is always the one showing the
	 * refusal. The panel's "Got it" is keyed on the report's *contents*, so the next startup builds a
	 * byte-identical report and shows it again. What the user was left with was a warning at every
	 * visit, for ever, whose one offered remedy — "delete it again" — destroys a Project that may
	 * belong to the colleague whose folder they opened.
	 *
	 * Non-destructive by construction: it removes a note about a deletion, never a file. Its cost is
	 * the one the user has just accepted in words — if the deletion really was theirs and really was
	 * unfinished, the Project stays, listed, and Delete is right there.
	 */
	forgetDeletion(directory: string): void {
		this.#deleted?.forget(directory);
		const report = this.deletionReport;
		if (report === null) return;
		const remaining = {
			...report,
			refused: report.refused.filter((entry) => entry.directory !== directory)
		};
		// Through the same predicate the report was published by, so a panel holding nothing but the
		// refusal just forgotten goes away rather than lingering empty.
		this.deletionReport = deletionsAreNoteworthy(remaining) ? remaining : null;
	}

	/**
	 * Put back whatever the journal is still holding for this Workspace (ticket 20).
	 *
	 * Called once, as the Workspace is adopted, and never twice for the same session: replay drops
	 * every entry it wrote, so a second call finds nothing — but the *report* is what the user reads,
	 * and re-running would clear it.
	 *
	 * Resolves rather than rejects. A Workspace too broken to replay into is one the listing beside
	 * this is about to describe properly (ADR-0008), and a rejection from here would replace that
	 * with an error boundary.
	 */
	async replayJournalledEdits(): Promise<void> {
		const journal = this.#journal;
		const storage = this.#journalStorage;
		if (!journal || !storage) return;
		try {
			const report = await replayJournal(storage, this.#store, journal.workspace, {
				...(this.#deleted ? { deleted: this.#deleted } : {}),
				// This session's own journal rather than one the replay builds and throws away, so that
				// what it read off the store outlives the call (ticket 07). A `'superseded'` skip keeps
				// an entry whose baseline is provably stale, and this is what stops that one refusal
				// becoming a standing refusal for every later edit to the same path.
				//
				// ⚠ **Reachability is not claimed, and the measurement is why** — the same standard
				// `Autosave.#forget` sets for its own guard. Round 4 added the read-path seam
				// ({@link #observeStoreContent}), and this replay runs at startup, *before* any Project
				// can be opened; every write path in this class reads before it writes. So in this
				// application the later read always overwrites what the replay observed, and deleting
				// this word turns no test in this file red. It stays because `replayJournal` is not
				// this class's alone — `replay.test.ts` drives a caller with no read path, where it is
				// load-bearing, and the two-session test there goes red without it.
				journal
			});
			this.replayReport = replayIsNoteworthy(report) ? report : null;
		} catch {
			// A store that cannot even be listed. The entries stay where they are, and the listing
			// beside this is what tells the user the Workspace is unreachable.
		}
	}

	/**
	 * Read a file, and tell the write-ahead journal what the store held for it.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THE READ PATH IS WHERE THIS COMES FROM, AND WHY NOWHERE ELSE WOULD DO
	 *
	 * A journal entry has to record what the edit was made *against*, or a replay at the next startup
	 * cannot tell a stranded write from a revert and has to ask the scholar instead
	 * (`ReplaySkipReason: 'cannot-tell-which-is-newer'`). Two other places were tried on paper and
	 * neither works:
	 *
	 *   - **`WriteAheadJournal.record` reading the store.** It is synchronous by contract — that is the
	 *     whole of why the journal exists, because a document being unloaded does not run a
	 *     continuation — and `ProjectStore.read` is not.
	 *   - **`Autosave` supplying it.** `Autosave` learns what the store holds only when a write is
	 *     *acknowledged*, so it could supply a baseline only for paths whose writes have already
	 *     succeeded — which is exactly the set that already had one. It would have looked like a fix
	 *     and closed nothing.
	 *
	 * What is left is the read this application has already done. **A file cannot be edited before it
	 * has been shown**, so by the time an edit exists its bytes have been in hand, at no extra I/O and
	 * with no race: the read has resolved, the edit has not happened yet, and the journal's record is
	 * synchronous.
	 *
	 * ⚠ **A stale observation refuses; it never overwrites.** If something writes the path between the
	 * read and the edit, the baseline is wrong — and `replay.ts` reads a baseline only to *refuse* a
	 * write, so the cost is a rescue the scholar is asked about rather than a colleague's work lost.
	 * That is the same direction every other imprecision in this field takes.
	 *
	 * Called only for reads that **succeeded**. An absent or unreadable file says nothing about what
	 * the store holds, and guessing is what this exists to avoid.
	 */
	async #readObserved(path: StorePath): Promise<Bytes> {
		// ⚠ **The token is taken before the read, and that ordering is the whole of it.** A read is
		// asynchronous and a save can land while it is in flight — `readLayerFeatures` and
		// `readAnnotations` name the same file, so a redraw overlapping a debounced `writeAnnotations`
		// is the ordinary shape. Reported without it, the stale read filed the *previous* content as
		// the baseline and the next stranded edit was refused with "that file has been changed since",
		// which was false and in exactly the case the journal exists for.
		const at = this.#journal?.mark() ?? 0;
		const bytes = await this.#store.read(path);
		this.#journal?.observe(path, bytes, at);
		return bytes;
	}

	/**
	 * Throw away a journal entry a replay refused, because the user said to (ticket 07).
	 *
	 * ⚠ **`'superseded'` is the first skip that keeps its entry, and a kept entry has no other
	 * exit.** The panel's "Got it" is keyed on the report's *contents*, so the next startup builds a
	 * byte-identical report and shows it again; nothing expires; and the only other remedy on offer
	 * is discarding the whole Workspace's journal from Workspace settings, which takes every other
	 * file's rescue copy with it. That is the same corner an unfinished deletion was left in, and
	 * this is the same answer: an exit the user can take once they have read the sentence.
	 *
	 * Destructive, unlike {@link forgetDeletion}, and the wording beside it has to say so — these
	 * bytes are the only copy of that edit. It is offered anyway because the alternative is a warning
	 * at every visit about work the application has already declined to put back.
	 *
	 * Held copies live outside the live journal (`journal.ts`), so this reaches neither an entry
	 * waiting to be written nor a file in the Workspace — only the copy the sentence names.
	 */
	forgetReplaySkip(path: string, copy: string): void {
		// ⚠ **Both fields, because a fingerprint is not unique across paths.** Two files whose declined
		// bytes are identical — an empty Annotation collection in two Projects is the ordinary case —
		// share one, so filtering on the fingerprint alone removed both rows while only one copy was
		// destroyed, and the survivor came back at the next startup with no explanation. The `{#each}`
		// key in `RecoveredEdits.svelte` is already `path:copy` for the same reason.

		const storage = this.#journalStorage;
		if (!storage || !this.#journal) return;
		// ⚠ **By fingerprint, never by path alone** (round 5, finding A). This notice is built at
		// startup and never expires, so it can be pressed after arbitrary later work — and keyed on the
		// path it destroyed whatever was at that path *then*, which could be a stranded edit made an
		// hour later, while the sentence beside the button described a different, older version and
		// said the copy had been kept.
		forgetHeldCopy(storage, this.#journal.workspace, path, copy);
		const report = this.replayReport;
		if (report === null) return;
		const remaining = {
			...report,
			skipped: report.skipped.filter((entry) => entry.path !== path || entry.copy !== copy)
		};
		// Through the same predicate the report was published by, so a panel holding nothing but the
		// skip just forgotten goes away rather than lingering empty.
		this.replayReport = replayIsNoteworthy(remaining) ? remaining : null;
	}

	/**
	 * Why this browser cannot hold a Workspace at all, or `''` when it can.
	 *
	 * OPFS is missing only in a non-secure context, and the raw DOM failure for that is
	 * "navigator.storage.getDirectory is not a function" — which diagnoses nothing and reads as
	 * the tool being broken rather than as the page being served over plain HTTP.
	 */
	static unsupportedReason(): string {
		if (OpfsProjectStore.isSupported()) return '';
		return (
			'This browser is not offering storage for a Workspace. That happens when the page is ' +
			'not served over a secure connection — open it over https://, or from localhost.'
		);
	}

	/**
	 * The store this session is bound to.
	 *
	 * For the whole-Workspace operations that are about the Workspace rather than about a Project, and
	 * therefore live on `WorkspaceStorage` rather than here — a backup is the one of those so far
	 * (ticket 13). Read-only and deliberately narrow: it does not license a second writer. Every write
	 * still goes through this session's `Workspace` and its `Autosave` (ADR-0017 rule 4), and the one
	 * caller of this only ever reads. `Workspace` exposes its own store the same way and for the same
	 * reason.
	 */
	get store(): ProjectStore {
		return this.#store;
	}

	/** ADR-0017 rule 3. Returns its own teardown. */
	installFlushOnHide(): () => void {
		return installFlushOnHide(this.#autosave, { document, window });
	}

	/** Reload the Project list. Also the "locate again" action while there is no picker yet. */
	async refresh(): Promise<void> {
		try {
			this.projects = await this.#workspace.listProjects();
			this.status = 'ready';
			this.unreachableDetail = '';
		} catch (cause) {
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async createProject(displayName: string): Promise<ProjectSummary | null> {
		return this.#mutate(null, () => this.#workspace.createProject(displayName));
	}

	async renameProject(directory: string, displayName: string): Promise<void> {
		await this.#mutate(directory, () => this.#workspace.renameProject(directory, displayName));
		if (this.openDirectory === directory && this.openProject) {
			this.openProject = { ...this.openProject, name: displayName };
		}
	}

	async duplicateProject(directory: string): Promise<void> {
		await this.#mutate(directory, () => this.#workspace.duplicateProject(directory));
	}

	/**
	 * Put a Project on the Published Site's Front Page, or take it off (ADR-0032).
	 *
	 * Through `#mutate` like every other hub action, so the list on screen comes back from the
	 * Workspace rather than from a value flipped here — which is what makes the control's state a
	 * reading of `project.json` and therefore something that survives a reload.
	 */
	async setProjectOnFrontPage(directory: string, onFrontPage: boolean): Promise<void> {
		await this.#mutate(directory, () =>
			this.#workspace.setProjectOnFrontPage(directory, onFrontPage)
		);
	}

	/**
	 * Remove a Project and everything in it.
	 *
	 * **The journal is emptied of it first** (ticket 20). `ProjectStore.delete` does not go through
	 * `Autosave`, so a rename still inside its debounce window would otherwise sit in the journal and
	 * be replayed at the next startup — putting `project.json` back into a directory the user had
	 * just watched disappear. Replay has its own precondition for this, and it cannot see the case
	 * that matters here: a *new* Project made afterwards under the same directory name, which from
	 * replay's side is indistinguishable from the old one still being there.
	 *
	 * Before the deletion rather than after, so a deletion that fails part way through does not leave
	 * journalled bytes for files that have gone.
	 *
	 * ⚠ **`Autosave` is swept too, and it is swept by `Workspace.deleteProject`** (ticket 21, reviews
	 * 2 and 3). The journal is written *from* Autosave's pending bytes, so a sweep that left those in
	 * place was undone within milliseconds by rule 3's own two halves: `capture()` re-journals
	 * `<project>/project.json` at `pagehide`, after the sweep, and `flush()` writes it into the store
	 * outright. That call lives in core now, beside the record it has to be ordered against — it has
	 * to run before the removal *and* be waited on after the record, which only the method holding
	 * both can do. See {@link Autosave.abandon}.
	 *
	 * **The Project's summary goes into the record**, out of the list the hub was rendering, so that a
	 * startup which finishes this deletion can see whether the Project has been changed since. It is
	 * not what says the Workspace is the right one — a copy reproduces it exactly; see
	 * `WorkspaceIdentity`.
	 */
	async deleteProject(directory: string): Promise<void> {
		// Cleared here rather than left standing: the callback below re-raises it synchronously if this
		// browser still will not hold the note, so what the user reads is about the deletion in front
		// of them and not about one they made ten minutes ago.
		this.deletionWarning = '';
		const was = this.projects.find((project) => project.directory === directory) ?? null;
		this.#journal?.forgetUnder(`${directory}/`);
		await this.#mutate(directory, () =>
			this.#workspace.deleteProject(
				directory,
				was ? { name: was.name, updatedAt: was.updatedAt } : null
			)
		);
	}

	/**
	 * Hand one Project to somebody else as a self-contained bundle (workspace-and-layers SPEC story 89, ADR-0024).
	 *
	 * The bundle carries `project.json`, the Project's `annotations/`, and the `images/<id>/` and
	 * `alignments/<id>.json` its Layers reference — and **not** the Workspace's other maps, which is
	 * what makes it a handoff rather than a backup.
	 *
	 * Everything pending is flushed first. Exporting a Project whose last edit is still inside the
	 * autosave debounce would otherwise produce an archive missing the change the user just made —
	 * the one failure that would make this whole path untrustworthy, since the file is what they are
	 * about to send somebody (ADR-0017 rule 1).
	 */
	async exportProject(project: ProjectSummary): Promise<void> {
		this.transferError = '';
		await this.flush();
		const announce = (progress: TransferProgress, finished: boolean) => {
			this.transfer = {
				kind: 'export',
				subject: project.name,
				files: progress.files,
				totalFiles: progress.totalFiles,
				finished
			};
		};
		try {
			const exported = await exportProjectBundle(this.#workspace.store, project.directory, {
				onProgress: (progress) => announce(progress, false)
			});
			await saveFile(exported.fileName, exported.body);
			announce(
				{
					files: exported.totalFiles,
					totalFiles: exported.totalFiles,
					bytes: exported.totalBytes,
					totalBytes: exported.totalBytes,
					path: null
				},
				true
			);
		} catch (cause) {
			this.transfer = null;
			this.transferError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Put down a refusal the user has now had a chance to act on.
	 *
	 * Called when the New Project dialog is opened again, so that a refused name is not still being
	 * complained about over the attempt to replace it. A successful {@link #mutate} clears it too.
	 */
	dismissProjectProblem(): void {
		this.projectProblem = null;
	}

	/**
	 * Clear the last Map Image refusal.
	 *
	 * Called when a deletion is asked for again, so the sentence beside the list is always about the
	 * click the user has just made rather than about a map they have since stopped thinking about.
	 */
	dismissMapImageError(): void {
		this.mapImageError = '';
	}

	/** Clear the announced transfer status, once the user has had a chance to read it. */
	clearTransfer(): void {
		this.transfer = null;
	}

	/**
	 * Show the Project named by `?p=`, or the hub when `directory` is `null`.
	 *
	 * Reads and nothing else. Opening last year's work must leave every byte of it alone
	 * (ADR-0010), so there is no write anywhere on this path — not a stamped `updatedAt`, not a
	 * normalised field.
	 *
	 * **Idempotent, and immune to a read that arrives late.** Opening is driven by an effect over
	 * the URL, which can run more than once for one navigation, and the naive version blanked
	 * {@link openProject} and re-read it every time. An edit typed inside that window was dropped
	 * silently — `typeProjectName` saw no open Project and returned — and the field snapped back to
	 * the name on disk with nothing to say it had happened. Losing a keystroke is a small thing;
	 * losing it invisibly, in the one component whose whole job is not losing work, is not.
	 */
	async open(directory: string | null): Promise<void> {
		// Already showing it. Re-opening the same Project can only discard what is in memory.
		if (directory !== null && directory === this.openDirectory && this.openProject !== null) {
			return;
		}
		const generation = ++this.#openGeneration;
		await this.flush();
		if (generation !== this.#openGeneration) return;
		this.openDirectory = directory;
		this.openProject = null;
		this.projectProblem = null;
		// The Edit History of the Project being opened goes, and this is the place that knows the
		// Project has changed: a history taken before it was last closed describes files a scholar has
		// not seen since. It is *after* the "already showing it" return above, so moving between the
		// panes of one Project leaves its Steps alone. Only that Project's — another's is nothing this
		// opening disturbs.
		if (directory !== null) this.#discardHistory(directory);
		this.images = [];
		this.referencedImages = [];
		this.referencedImageErrors = [];
		this.ingestError = '';
		this.addMapError = '';
		// The hub is what a null `?p=` shows, and it needs the list. Listing here rather than on
		// every mutation is what keeps typing a Project name from walking the whole Workspace once
		// per keystroke — a 2 GB pyramid is tens of thousands of files.
		if (directory === null) return this.refresh();

		try {
			const file = await this.#workspace.readProject(directory);
			// A later `open` has already moved on; this read is stale and would clobber it.
			if (generation !== this.#openGeneration) return;
			this.openProject = file;
			this.status = 'ready';
			this.unreachableDetail = '';
			// A read, like everything else on this path: `listIngestedImages` looks for `info.json`
			// files and writes nothing (ADR-0010). `listReferencedImages` looks for `remote.json`, which
			// is the same walk of the same directory and is where the other kind of Map Image is.
			//
			// Both walk the **Workspace's** `images/` rather than this Project's, because that is where the
			// pyramids are (ADR-0023). Nothing is reconciled afterwards: which of these a Layer draws is the
			// Layer's `imageId`, and whether the tiles are local is read off the files, so there is no
			// stored claim left that could disagree with the folder.
			this.images = await listIngestedImages(this.#store);
			const referenced = await listReferencedImages(this.#store);
			if (generation !== this.#openGeneration) return;
			this.referencedImages = referenced.images;
			this.referencedImageErrors = referenced.unreadable;
		} catch (cause) {
			if (generation !== this.#openGeneration) return;
			const problem = describeProblem(cause, directory);
			if (problem) {
				// "This Project is not there" and "the Workspace is not there" are the **same failure**
				// on the read path: a Workspace folder that has been deleted makes
				// `getDirectoryHandle('amsterdam-1625')` raise the same `NotFoundError` as a Project that
				// really has gone. Blaming the Project is the worse of the two guesses by a long way — it
				// tells a scholar their work does not exist while it sits in a folder on their desk — and
				// it offers the wrong recovery, so the Workspace is asked before the Project is blamed.
				//
				// Only on this path, and only for this one kind: `refresh` walks the Workspace, which is
				// too expensive to do on the way to a Project that opened perfectly well.
				if (problem.kind === 'missing') {
					await this.refresh();
					if (generation !== this.#openGeneration) return;
					if (this.status === 'unreachable') return;
				}
				this.projectProblem = problem;
				return;
			}
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Add a Map Image from a file on the user's computer (SPEC stories 21, 22, 23).
	 *
	 * **The pyramid lands in the Workspace, not in the Project** (ADR-0023), so the map this adds is
	 * available to every Project from the moment it is prepared. The open Project is required, because
	 * the gesture that reaches here is inside one and **the Layer is made now** — adding a Map
	 * Image is the one thing that puts a map Layer in the stack (ADR-0023), and it is made whether or not
	 * anyone ever places a Control Point on it.
	 *
	 * The tiling itself is deliberately not routed through {@link #mutate} or {@link Autosave}. A
	 * pyramid is thousands of immutable files written once, not a document edited repeatedly, so
	 * coalescing writes would only add a buffer the size of the image; and ADR-0017's autosave rules are
	 * about an edit that is ending, which this is not. `project.json` is written once at the end, by
	 * {@link #addMapLayer}, because the stack genuinely changed.
	 *
	 * The tiler is handed in from here, because `@ballastella/core` names the seam rather than
	 * reaching for a canvas of its own (ADR-0019). An image larger than a browser will decode is
	 * refused by `ingestImageFile` before anything is opened (ADR-0027); there is no second tiler to
	 * fall back to and the refusal says so in terms of the image rather than of the deployment.
	 */
	async ingestImage(file: File): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **ONE INGEST AT A TIME, AND SAYING SO IS THE POINT** (ticket 17's rule, found again).
		//
		// This used to be `if (!directory || this.ingest) return;` — a second file discarded in
		// silence, with no error, no announcement and nothing on screen that changed. The comment
		// below on the `images` listing already recorded the symptom ("picking the next file inside
		// that window did nothing at all") and answered it by moving the *listing* last; but the
		// signal the Project screen actually shows for "it is here" is the **Layer row**, which
		// {@link #addMapLayer} publishes several awaits before this method's `finally` clears
		// {@link ingest}. So the window it was closing never closed, and the drop stayed silent.
		//
		// The file input beside it is `disabled` while an ingest runs, which is what keeps a person
		// out of this window — a `change` event does not originate from a disabled input. It is not
		// what keeps a *caller* out: `setInputFiles` in the browser suite performs no enabled check
		// and dispatches `change` on a disabled input regardless (measured on @playwright/test
		// 1.62.1), and this silent return is what
		// `editor-stored-image-pane.e2e.ts`'s two-pyramid test spent 30 s waiting for in 6 runs of 30.
		//
		// So the guard stays — a second tiler running against the same Workspace is not wanted — and
		// it now answers. A refusal a user can read is the difference between "the app is busy" and
		// "the app is broken", and it costs one line.
		if (this.ingest) {
			this.ingestError = `“${file.name}” was not added: “${this.ingestLabel}” is still being prepared. Wait for it to finish, then pick the file again.`;
			return;
		}

		this.ingestError = '';
		this.ingestLabel = file.name;
		this.ingest = {
			phase: 'inspecting',
			tilesWritten: 0,
			tileCount: 0,
			fraction: 0
		};

		// A gigapixel scan is thousands of tiles and minutes of work, and picking the wrong file is
		// ordinary. `ingestImageFile` has taken a signal and cleaned up after itself since it was
		// written; nothing supplied one, so the claim was in a comment and not in the app.
		const controller = new AbortController();
		this.#ingestAbort = controller;

		try {
			const ingested = await ingestImageFile({
				store: this.#store,
				file,
				openDecodeAndCrop: openDecodeAndCropSource,
				onProgress: (progress) => {
					this.ingest = progress;
				},
				signal: controller.signal
			});
			// **The Layer, now.** A local image id is random (ADR-0015), so this is always a Map
			// Image no Layer draws yet and always a Layer added rather than a no-op — but it goes through
			// the same method the referenced path uses, so there is one implementation of "adding a map
			// puts a Layer in the stack" rather than two that can drift.
			await this.#addMapLayer({ imageId: ingested.imageId, image: ingested });
			// **Last, so the map appears in the list only once the whole add is done.** The list is what
			// the interface shows for "it is here", and the file input beside it is disabled while
			// {@link ingest} is running — so listing the pyramid before the Layer and the Alignment were
			// written made a Map Image look added while the second half was still in flight, and
			// picking the next file inside that window did nothing at all.
			this.images = await listIngestedImages(this.#store);
		} catch (cause) {
			// A cancellation is not a failure and must not be reported as one: the user asked for it,
			// and the job has already removed the tiles it had written.
			this.ingestError = controller.signal.aborted
				? ''
				: cause instanceof Error
					? cause.message
					: String(cause);
		} finally {
			this.#ingestAbort = null;
			this.ingest = null;
			this.ingestLabel = '';
		}
	}

	/** Stop the ingest in progress, if there is one. Leaves the Project as it was. */
	cancelIngest(): void {
		this.#ingestAbort?.abort();
	}

	/**
	 * A `fetch` that answers the Workspace's stored pyramids.
	 *
	 * The ADR-0011 injection layer, handed out from here because this is the only place the app
	 * talks to `@ballastella/core` and the only place that holds the store. Every consumer of a
	 * Map Image's bytes takes this one function: the image pane's MapLibre source through
	 * `addProtocol`, `@allmaps/maplibre` through its `fetchFn` option, and OpenSeadragon's
	 * `TileSource`. Requests to any other host pass straight through to the network, so a remote
	 * referenced image keeps working unchanged.
	 *
	 * **No longer nullable, because it no longer depends on a Project being open** (ADR-0023). The
	 * pyramids are the Workspace's, so one shim serves every Project — which is exactly what makes two
	 * Projects referencing the same `imageId` draw the same bytes. The version that took a
	 * `projectDirectory` is the change SPEC calls the riskiest in the epic: rooted at a Project, this
	 * function answers a request for one map with *another map's* tiles, and nothing raises.
	 */
	imageServiceFetch(): FetchFn {
		return createStoreImageFetch({ store: this.#store });
	}

	/**
	 * Read one Map Image's Alignment, or start a new one over the whole image.
	 *
	 * A missing file comes back as a fresh Alignment rather than as an error — and **nothing is written
	 * here**, which is ADR-0010: merely opening last year's Project, or opening the alignment view over
	 * one of its maps, must not modify a single byte of it.
	 *
	 * **When the file appears is the add, not the first Control Point** (ADR-0023). Every Map Image
	 * in a Project has had a starter Alignment on disk since the moment it was added, because a map
	 * Layer whose `alignments/<id>.json` is absent is a Project `assertReferencesPresent` refuses. So the
	 * missing-file branch below is no longer the ordinary first case; it is a Workspace whose Alignment
	 * has been deleted or was written by an older build, and answering with a starter is what lets the
	 * user carry on rather than meeting an error over a map they can see.
	 *
	 * **Read from the Workspace, so it is the same Alignment whichever Project asked** (ADR-0023). That
	 * is the accepted risk of the move stated as code: refining it moves every Project that draws this
	 * map, published ones included.
	 *
	 * A file that exists and cannot be read is a different matter and is surfaced: it means an
	 * Alignment the user made is not being shown, and silently replacing it with an empty one would
	 * discard their work on the next save.
	 */
	async readAlignment(
		imageId: string,
		image: { width: number; height: number }
	): Promise<Alignment> {
		this.alignmentError = '';
		try {
			// The bytes, not the model: this is the baseline a later write compares against, and
			// `Alignment.unmodelled` means a re-serialisation of the same document can differ. Held
			// here because this is the moment the user's view of the file is fixed (ticket 07). The
			// journal is told the same fact by the read itself, for a different question — a revert at
			// startup rather than a concurrent edit — off the one read.
			const bytes = await this.#readObserved(alignmentPath(imageId));
			this.#alignmentOnDisk.set(imageId, bytes);
			return parseAlignment(bytes, { imageId });
		} catch (cause) {
			if (cause instanceof PathNotFoundError) {
				this.#alignmentOnDisk.set(imageId, null);
				return newAlignment(imageId, image);
			}
			// Deliberately no entry: an unreadable file is one this session cannot claim to know, and
			// a baseline of `null` here would report every later write as having displaced something.
			this.#alignmentOnDisk.delete(imageId);
			this.alignmentError = cause instanceof Error ? cause.message : String(cause);
			throw cause;
		}
	}

	/**
	 * Stop showing {@link alignmentChangedElsewhere}. The user has read it.
	 *
	 * A method rather than letting the component assign, because the field is the record of a thing
	 * that happened and clearing it is a decision — the same reason `saveError` is not public state
	 * anybody may blank.
	 */
	dismissAlignmentChangedElsewhere(): void {
		this.alignmentChangedElsewhere = null;
	}

	/**
	 * Put back the Alignment somebody else made, discarding the edit that displaced it.
	 *
	 * The other half of "let them choose". A `replace`, said in the words the user was shown — which
	 * is what {@link AlignmentWrite}'s `discarding` field is for, and this is the application's first
	 * caller of that intent.
	 *
	 * The baseline is updated to the bytes just written, so the next ordinary save is not itself
	 * reported as displacing something.
	 *
	 * @returns whether their version is now on disk. **Reported rather than left to be inferred**, and
	 *   that is not tidiness: the caller announces the outcome in a sentence and moves focus to it, so
	 *   a caller that could not tell success from failure said "their version is back, and the list
	 *   below is what is on disk now" over a screen where nothing had changed and the warning was
	 *   still standing — false in both halves, and read out loud to the one user who cannot see the
	 *   contradiction. `saveError` is not the signal to use for this: it is Workspace-wide, so an
	 *   unrelated `project.json` failure would report this restore as having failed.
	 */
	async restoreAlignmentChangedElsewhere(): Promise<boolean> {
		const pending = this.alignmentChangedElsewhere;
		if (!pending || !this.openDirectory) return false;
		let restored = false;
		// **Behind whatever is already writing this map's file**, for the reason {@link
		// #alignmentWriteInFlight} gives at length. A gesture end fires a save without awaiting it, so
		// "place a pair, then press this" can have that save still in flight — and a restore that
		// overtook it would put their version on disk and then have the user's own queued bytes land on
		// top of it, warning about a concurrent change a second time. The user asked for their edit to
		// go; it has to go after it has arrived.
		await this.#behindAlignmentWritesFor(pending.imageId, async () => {
			try {
				await writeAlignmentBytes(this.#alignmentFile, {
					imageId: pending.imageId,
					bytes: pending.displaced,
					write: {
						intent: 'replace',
						discarding:
							'the Control Points this session wrote over the version that arrived from ' +
							'elsewhere, at the user’s request'
					}
				});
				this.#alignmentOnDisk.set(pending.imageId, pending.displaced);
				// ⚠ **Only the warning the user answered**, and the queue above is what made this matter.
				// Waiting behind an in-flight save means that save can raise a *newer*
				// `alignmentChangedElsewhere` while this one waits — a second colleague write, or one on
				// a different Map Image, since the field is not keyed by image. Blanking it
				// unconditionally throws away an alert nobody has seen, and that alert is the one thing on
				// the screen a user cannot find out any other way. So it is cleared only if it is still
				// the one this call is answering.
				if (this.alignmentChangedElsewhere === pending) this.alignmentChangedElsewhere = null;
				// Their version is now on disk, so every Step this session took over it describes bytes
				// that are no longer there (ADR-0039). Undoing one would displace their work a second
				// time — silently, and by an affordance the user reached for to be safe.
				this.#discardHistory(pending.imageId);
				restored = true;
				// **Not `saveError = ''`.** This call succeeded; that says nothing about a `project.json`
				// write that failed a moment ago, and clearing it takes a failure off the screen without
				// the failure having gone away. Only a failure *here* touches it — see the catch.
			} catch (cause) {
				this.saveError = cause instanceof Error ? cause.message : String(cause);
			}
		});
		return restored;
	}

	/**
	 * Write an Alignment (SPEC stories 91 and 94).
	 *
	 * **Now, not on a timer.** Every edit that reaches here is a discrete act or the end of a
	 * gesture — a pair completed, a dragged half released on pointer-up, a pair deleted — which is
	 * ADR-0017 rule 1, and is why a drag costs exactly one store write rather than one per frame.
	 * The debounce is for text being typed; there is no such thing here.
	 *
	 * Routed through the same {@link Autosave} as `project.json` so that rule 2's per-file debounce
	 * and rule 5's save state are one mechanism rather than one per file kind.
	 *
	 * **It touches `project.json` not at all, and that is ADR-0023.** A map Layer is created by exactly
	 * one thing — the user adding a Map Image to a Project — so placing, moving, or deleting a
	 * Control Point cannot create one, cannot rename one, and cannot reorder the stack. The version
	 * that made a Layer here needed a tombstone list in `project.json` to stop a deleted Layer coming
	 * back on the next nudge; with the Layer made by the gesture alone there is nothing to resurrect it,
	 * and that field went with it.
	 *
	 * **An `update`, said out loud** (ticket 18). This is the one write in the application that is a
	 * user editing the Alignment in front of them, so it is the one write that does not have to ask
	 * what is already on disk. Saying so is what distinguishes it from the two blind overwrites this
	 * epic wrote by accident, and it is checked: `writeAlignmentFile` is the only thing that can turn
	 * an `AlignmentPath` into a path the store will accept, and it does not take a caller that has
	 * not named its intent.
	 */
	async writeAlignment(alignment: Alignment): Promise<void> {
		// The Alignment is the Workspace's (ADR-0023), but the surface that writes one is inside a
		// Project; no Project open means no alignment workspace, and a write from nowhere is a bug
		// rather than a case to serve.
		if (!this.openDirectory) return;
		// **Behind whatever is already writing this map's file** — see {@link #alignmentWriteInFlight}
		// for what two overlapping gesture ends did to the baseline. The queue is here rather than
		// inside `#writeAlignmentNow` so that the baseline read happens *after* the previous write has
		// moved it, which is the whole of the fix.
		await this.#behindAlignmentWritesFor(alignment.imageId, () =>
			this.#writeAlignmentNow(alignment)
		);
	}

	/**
	 * Run `write` once every Alignment write already queued for this Map Image has finished.
	 *
	 * The queue itself. See {@link #alignmentWriteInFlight} for what it is for and what it is not:
	 * it removes this session's overlap with itself, and says nothing about a real colleague.
	 *
	 * `write` must not reject — both callers report a store failure through `saveError` — because the
	 * chain is a plain `then` and a rejection would poison every later write for the same map.
	 */
	async #behindAlignmentWritesFor(imageId: string, write: () => Promise<void>): Promise<void> {
		const queued = (this.#alignmentWriteInFlight.get(imageId) ?? Promise.resolve()).then(write);
		this.#alignmentWriteInFlight.set(imageId, queued);
		try {
			await queued;
		} finally {
			// Only when this was the last one queued, or a write that arrived while this was in flight
			// would lose its place in the line.
			if (this.#alignmentWriteInFlight.get(imageId) === queued) {
				this.#alignmentWriteInFlight.delete(imageId);
			}
		}
	}

	/**
	 * One Alignment write, once it is this one's turn. See {@link writeAlignment}.
	 *
	 * **It never rejects**, which is what lets the queue above be a plain `then` chain: a store
	 * failure is a sentence on `saveError`, exactly as it was before the queue existed, so one
	 * refused write cannot poison every later one for the same map.
	 */
	async #writeAlignmentNow(alignment: Alignment): Promise<void> {
		const path = alignmentPath(alignment.imageId);
		const baseline = this.#alignmentOnDisk.get(alignment.imageId);
		try {
			const report = await writeAlignmentFileReporting(this.#alignmentFile, {
				alignment,
				// **The bytes this session believes are on disk** (ticket 07). Omitted entirely when it
				// has never looked, which is a caller making no claim rather than one claiming absence.
				write:
					baseline === undefined ? { intent: 'update' } : { intent: 'update', basedOn: baseline },
				// **The address has to be supplied on every write, including this one** (ADR-0007). It is
				// not carried on `Alignment` and does not survive a read, so omitting it here does not
				// leave the document's `target.source.id` alone — it rewrites it to the ADR-0004
				// placeholder. For a map whose tiles are on a Library's server that is a file Allmaps
				// cannot resolve and a Layer that renders nothing, produced by placing a Control Point.
				// `#recordLocalCopy` omits it deliberately, which is now a difference the two say out loud
				// rather than one that happens to be spelled the same.
				...this.#alignmentAddressFor(alignment.imageId)
			});
			this.saveError = '';
			// The new baseline. Set from what the writer actually wrote, so the next write's comparison
			// is against bytes produced by one serialiser rather than two.
			this.#rememberAlignmentOnDisk(alignment.imageId, report.written);
			if (report.outcome === 'written over a change' && report.displaced) {
				// Reported, never blocked (ADR-0023: visibility, not prevention). The edit is already on
				// disk; what is new is that the user now knows something of somebody else's is not.
				this.alignmentChangedElsewhere = {
					imageId: alignment.imageId,
					displaced: report.displaced
				};
				// And this map's Edit History goes with it (ADR-0039). Somebody else — another tab, a
				// synced folder — has written this Alignment since the Steps were taken, so their `before`
				// images describe a file that has moved underneath them.
				this.#discardHistory(alignment.imageId);
			}
			// After the write resolved, so an attempt the store refused is not counted as one that
			// happened. This is what lets the drag test assert the *number* of writes.
			recordAlignmentWrite(path, alignment.controlPoints.length);
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Give a Map Image the Alignment it starts life with, or the one the user chose to import,
	 * and **never at the cost of one somebody has worked on** (ADR-0023).
	 *
	 * The starter is `newAlignment`: zero Control Points and a Resource Mask over the whole sheet, the
	 * same document {@link readAlignment} has always produced in memory for a map nobody has placed
	 * yet. **The difference is that it is now on disk**, and that is the whole point — a map Layer's
	 * references are derived from its `imageId`, so a Layer whose `alignments/<id>.json` does not exist
	 * is a Project `assertReferencesPresent` refuses, and this build would export a zip it then would
	 * not import (ADR-0023's consequence on the starter Alignment).
	 *
	 * This does not offend ADR-0010, which forbids writing when *merely opening* a Project. Adding a
	 * Map Image is an explicit act, and this happens only on that act.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY AN OFFERED ALIGNMENT DOES NOT SIMPLY WIN
	 *
	 * A remote resource's image id is `generateId(uri)`, the same every time anybody adds it, and
	 * ADR-0023 moved `alignments/<id>.json` out of the Project and into the Workspace — one Alignment
	 * per Map Image, shared by every Project that draws it. So an unconditional write here is not
	 * "overwrite the file I just made". It is: align a Library map in Project A, place Control Points,
	 * add the same map to Project B months later, accept the community offer Allmaps happens to have
	 * — and Project A's placement is gone, silently, from a gesture that said nothing about Project A.
	 *
	 * The rule is therefore **the offer is written only when there is nothing to lose**: no file at
	 * all, or a file still byte-identical to the starter. Anything else is kept, and the caller says
	 * so — because the user did ask for something, and a silent no-op is its own kind of wrong.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE DECISION ITSELF IS NOT HERE, AND THAT IS TICKET 18
	 *
	 * Everything above describes `writeAlignmentFile`'s `create` intent, which is where the rule now
	 * lives — in `@ballastella/core`, beside the type that makes a blind write fail to compile, so
	 * that the next author of an Alignment write inherits it instead of rediscovering it. This method
	 * is what is left once the decision moves out: which Alignment, and where the image is served
	 * from.
	 *
	 * @param options.address where the tiles are. A referenced image's Alignment names the Library's
	 *   service as its `resource.id` rather than the ADR-0004 placeholder (ADR-0007, SPEC story 91),
	 *   so the caller that knows the service supplies it. A value rather than a `serialise` callback,
	 *   because a callback is a second serialiser at the call site and the two spellings drift.
	 * @param options.offered an Alignment the user chose to import, or `null` for the starter.
	 */
	async #writeInitialAlignment(
		imageId: string,
		image: { width: number; height: number },
		options: {
			address?: AlignmentAddress;
			offered?: Alignment | null;
		} = {}
	): Promise<InitialAlignment> {
		// Re-keyed onto this Workspace's image id: a community Alignment arrives keyed on the Allmaps
		// identifier of the resource, which is the same string here, but the record is the authority.
		const alignment = options.offered
			? { ...options.offered, imageId }
			: newAlignment(imageId, image);
		const report = await writeAlignmentFileReporting(this.#alignmentFile, {
			alignment,
			write: { intent: 'create' },
			...(options.address ? { address: options.address } : {})
		});
		this.#rememberAlignmentOnDisk(imageId, report.written);
		return report.outcome;
	}

	/**
	 * Record what is on disk for a Map Image after a write this session made (ticket 07).
	 *
	 * **Every write of an Alignment must come through here, and the reason is a false alarm rather
	 * than a lost edit.** `writeAlignment` compares against this baseline to decide whether somebody
	 * else changed the file; a write that changed the bytes and did not update it leaves the next
	 * ordinary save reporting a concurrent edit that never happened — a frightening sentence about a
	 * colleague who does not exist, which is worse than no sentence at all because it teaches the user
	 * to dismiss the real one.
	 *
	 * `null` — a write that did not happen, such as a `create` declining over somebody's work — leaves
	 * the baseline alone. Nothing changed, so nothing this session believes about the file has.
	 */
	#rememberAlignmentOnDisk(imageId: string, written: Bytes | null): void {
		if (written) this.#alignmentOnDisk.set(imageId, written);
	}

	/**
	 * Put one side of an Alignment Step's images back on disk (ADR-0039, SPEC stories 24–29).
	 *
	 * **Through `writeAlignmentBytes`, verbatim.** One module owns `alignments/<image-id>.json` and
	 * every caller of it names its intent (ticket 18), so an Edit History cannot reach `Autosave` the
	 * way it does for every other path. Verbatim rather than re-serialised for the reason a Step holds
	 * bytes at all: `Alignment.unmodelled` means a round trip through this build's model can differ
	 * from the document the scholar's colleague wrote.
	 *
	 * A `replace`, said in the words the scholar read: the Step's own label is on the control they
	 * pressed, which is what {@link AlignmentWrite}'s `discarding` field asks for.
	 *
	 * **Behind whatever is already writing this map's file**, for the reason
	 * {@link #alignmentWriteInFlight} gives at length — and the baseline moves with it, for the reason
	 * {@link #rememberAlignmentOnDisk} gives: a write that changed the bytes and left the baseline
	 * alone makes the *next* ordinary save report a colleague who does not exist.
	 *
	 * The queue takes a `write` that must not reject, so a failure is carried out of it and thrown
	 * from here instead: whether the history's cursor moves is decided by whether this resolves.
	 */
	async #writeAlignmentBack(imageId: string, bytes: Bytes | null): Promise<void> {
		let failure: unknown = null;
		await this.#behindAlignmentWritesFor(imageId, async () => {
			try {
				if (bytes === null) {
					// The gesture created the Alignment and reversing it takes the file away again. Deleting
					// an `AlignmentPath` needs no intent — only writing one is fenced.
					await this.#store.delete(alignmentPath(imageId));
					this.#alignmentOnDisk.set(imageId, null);
					return;
				}
				await writeAlignmentBytes(this.#alignmentFile, {
					imageId,
					bytes,
					write: {
						intent: 'replace',
						discarding:
							'the Alignment edit named on the control the user pressed, which is what this ' +
							'screen’s Edit History was asked to reverse'
					}
				});
				this.#alignmentOnDisk.set(imageId, bytes);
			} catch (cause) {
				failure = cause;
			}
		});
		if (failure !== null) throw failure;
	}

	/**
	 * Where one Map Image's tiles are, as the union `tileBaseFor` and `imagePaneSourceFor` take.
	 *
	 * **The one lookup behind two answers that must never disagree** (ticket 07). The pane's tile base
	 * and the Alignment's `resource.id` are both "where is this image served from", and the pairing
	 * that matters is the wrong one: a pane drawing a Library's sheet while the Alignment says
	 * `unset.invalid` writes a file Allmaps cannot resolve and a warped Layer that renders nothing —
	 * and the reverse writes a Library's address over Control Points placed on our own pyramid. Both
	 * now read this, so there is one fact rather than two lookups that happen to be spelled the same.
	 *
	 * Derived from whether a `remote.json` is on disk (ADR-0023: `imageMode` is observable, never
	 * stored), through `remoteOrigins`, which is `partitionByOfflineCopy` and therefore answers
	 * `'offline-copy'` for a referenced map that has since been copied — which is right: once the
	 * pyramid is here it is what should be drawn and what the Alignment should be keyed on.
	 */
	mapImageSource(imageId: string): MapImageSource {
		const referenced = this.remoteOrigins.referenced.find((image) => image.imageId === imageId);
		return referenced ? sourceOf(referenced) : { imageMode: 'offline-copy', imageId };
	}

	/**
	 * Where this Map Image's Alignment should say its image is served from, as an argument
	 * spread onto a `writeAlignmentFile` call — `{ address }` for a referenced map, `{}` for one
	 * whose pyramid is in the Workspace.
	 *
	 * **`{}` and not `{ address: undefined }`**, so a caller that spreads this cannot accidentally
	 * override an address it passed itself.
	 */
	#alignmentAddressFor(imageId: string): { address?: AlignmentAddress } {
		const source = this.mapImageSource(imageId);
		return source.imageMode === 'referenced'
			? { address: referencedAlignmentAddress(source.service) }
			: {};
	}

	/**
	 * Storage as `writeAlignmentFile` needs it: read from the store, commit through {@link Autosave}.
	 *
	 * Through `Autosave` and not straight to the store, which is the whole reason this is a port and
	 * not a `ProjectStore`: an Alignment write that went round `Autosave` would bypass ADR-0017 rule
	 * 2's per-file debounce and rule 5's save state, so the Saved indicator would stop describing the
	 * file the user is actually editing.
	 */
	get #alignmentFile(): AlignmentFilePort {
		return {
			read: (path) => this.#store.read(path),
			commit: (path, bytes) => this.#autosave.commit(path, bytes)
		};
	}

	/**
	 * The open Project's map Layer for one Map Image, or `undefined`.
	 *
	 * **A lookup and nothing else.** Since ADR-0023 a map that is in a Project always already has its
	 * Layer — adding the map is what made it, and made its starter Alignment with it — so the question
	 * "which Layer of this Project draws this map?" has an answer in memory and never needs a write to
	 * produce one. An earlier draft of the `/align/` route asked the same question with a method that
	 * *created* the Layer when there was none, by routing `readAlignment` into `writeAlignment`; for a
	 * map already aligned in another Project that rewrote a Workspace-shared `alignments/<id>.json`
	 * through `serialiseAlignment`, dropping every field of a third-party Alignment document that
	 * `Alignment` does not model (SPEC story 60). Merely opening a view is not a write, and this cannot
	 * become one.
	 *
	 * **`undefined` is a real answer, not a gap to fill.** `images` lists the *Workspace's* Map
	 * Images (ADR-0023), so a Project can be shown a map it does not draw — and putting a map into a
	 * Project is adding it, a different gesture with its own affordance, rather than something a link
	 * should do on the way past.
	 *
	 * The one implementation of this question, so `#addMapLayer` and every screen that asks it cannot
	 * drift into two answers about what counts as "this Project already draws that map".
	 */
	mapLayerFor(imageId: string): MapLayer | undefined {
		return this.openProject?.layers.find(
			(layer): layer is MapLayer => layer.kind === 'map' && layer.imageId === imageId
		);
	}

	/**
	 * Put a `kind: 'map'` Layer in the stack for a Map Image the user has just added (ADR-0023).
	 *
	 * **The one thing in the application that creates a map Layer.** An Alignment write does not, which
	 * is what lets a deleted Layer stay deleted without a tombstone in `project.json`: nothing but this
	 * gesture can bring one back, and the gesture is the user asking for it.
	 *
	 * The name starts as the image's own label, read from its `manifest.json`, which for a file the
	 * user picked is the file's name — an image id is a random identifier (ADR-0015), so naming the
	 * Layer from it would name it after a hash. SPEC story 54 is that they can then rename it.
	 *
	 * **Adding a map this Project already draws is a no-op on the stack**, not an error and not a
	 * duplicate. The existing Layer keeps its id, its position, and the name the user gave it, and
	 * `project.json` is not written, so `updatedAt` does not move either. The test is the `imageId`,
	 * which is a map Layer's whole link to its Map Image.
	 *
	 * **The Alignment is settled before that no-op, not after it**, which is the one thing the
	 * re-add gesture can repair. A Project written by an earlier build can hold a map Layer whose
	 * `alignments/<id>.json` was never written — that Project is un-exportable, because
	 * `assertReferencesPresent` refuses it by name — and returning early on "the Layer is already
	 * there" would leave the user's only obvious remedy, adding the map again, doing nothing at all.
	 * It is also where an offered community Alignment lands when the map is already in the stack.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHAT MAY BE HELD ACROSS THE AWAITS, AND WHAT MAY NOT
	 *
	 * **Nothing is read out of `openProject` before an `await` and used after it.** Reading the
	 * image's label is a store read, and a version that took its snapshot of the document first and
	 * wrote that snapshot back discarded whatever else changed inside the window — the Project name
	 * field is on the same page, so renaming a Project while a map was being added reverted the name,
	 * on screen and on disk.
	 *
	 * `directory` is the one value that *is* captured first, because the early bail needs it and
	 * because it is not part of the document — it is which folder the document belongs to. Held
	 * carelessly it would be worse than a stale snapshot rather than better: if the user opened
	 * another Project inside the window, `#write(directory)` would put **that** Project's document
	 * into **this** Project's folder. So it is compared against `openDirectory` again after the
	 * awaits, and a mismatch abandons the write. The rule with the exception spelled out: nothing
	 * captured before an await is written after one without first being confirmed still current.
	 *
	 * @returns the Layer — the new one, or the one that was already there — and what became of the
	 *   Alignment; or `null` when nothing could be written.
	 */
	async #addMapLayer(fields: {
		imageId: string;
		image: { width: number; height: number };
		/** What to call it, when the caller knows better than `manifest.json` does. */
		name?: string;
		/** Where the image is served from. See {@link #writeInitialAlignment}. */
		address?: AlignmentAddress;
		/** A community Alignment the user chose to import. See {@link #writeInitialAlignment}. */
		alignment?: Alignment | null;
	}): Promise<MapLayerAdded | null> {
		const { imageId } = fields;
		const directory = this.openDirectory;
		// {@link mapLayerFor}, which reads the *live* `openProject` — which is exactly what each of the
		// three questions below wants, and the reason they are three questions rather than one snapshot
		// consulted three times.
		const drawnAlready = (): MapLayer | undefined => this.mapLayerFor(imageId);

		const before = this.openProject;
		if (!directory || !before) return null;

		let alignment: InitialAlignment;
		try {
			// **Before `project.json`**, and the same discipline `addAnnotationLayer` and ticket 13's
			// importer keep: a Layer whose reference names a file that is not there is a Project this
			// build's own import refuses. Written this way, the worst a failure leaves is an Alignment
			// nothing draws — bytes, not breakage.
			alignment = await this.#writeInitialAlignment(imageId, fields.image, {
				...(fields.address ? { address: fields.address } : {}),
				offered: fields.alignment
			});
			this.saveError = '';
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
			return null;
		}

		// Asked again rather than from `before`: the Alignment write awaited, and the map may have been
		// added by another gesture in that window.
		const drawn = this.openProject;
		if (!drawn) return null;
		const already = drawnAlready();
		if (already) return { layer: already, alignment };

		const name = fields.name || (await this.#imageLabel(imageId)) || imageId;
		// Taken again after that await too, never from a snapshot above — and `directory` with it, so
		// this Project's document cannot be written into a Project the user opened in the meantime.
		const project = this.openProject;
		if (!project || this.openDirectory !== directory) return null;
		// Asked a third time as well: two adds of the same map in flight together must produce one
		// Layer, not two rows over one pyramid.
		const raced = drawnAlready();
		if (raced) return { layer: raced, alignment };

		const layer = newMapLayer({ id: crypto.randomUUID(), name, imageId });
		// **`project.json` and nothing else**, which is the disjointness invariant ADR-0039 rests on and
		// is load-bearing here: this gesture also wrote a starter Alignment, and undoing it must leave
		// that Alignment and the Map Image exactly where they are. It mirrors the deletion, which leaves
		// both alone for the same reason (ADR-0023) — they are the Workspace's, and another Project may
		// be drawing them.
		const written = await this.historyFor(directory).step(
			`Undo adding the Map Image ${quotedName(name)}`,
			[projectFilePath(directory)],
			async () => {
				// Taken again inside the Step, because `step()` flushes before it takes its image: nothing
				// captured before an await is written after one without first being confirmed still current.
				const current = this.openProject;
				if (!current || this.openDirectory !== directory) return false;
				this.openProject = { ...current, layers: addLayer(current.layers, layer) };
				await this.#write(directory);
				return this.saveError === '';
			}
		);
		return written ? { layer, alignment } : null;
	}

	/**
	 * Add a Map Image that stays on somebody else's server (SPEC stories 16–20, 25, 29).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE ORDER OF THE THREE WRITES, WHICH IS NOT ARBITRARY
	 *
	 *   1. `images/<id>/remote.json` — where the tiles are, and the provenance.
	 *   2. `alignments/<id>.json` — the community Alignment the user chose, or the starter one every
	 *      Map Image gets (ADR-0023), written by {@link #addMapLayer}.
	 *   3. `project.json`, gaining the Layer that references both.
	 *
	 * `project.json` is **last**, and it is the same discipline `addAnnotationLayer` follows and the
	 * same one ticket 13's importer follows: a Layer whose references name files that do not exist is
	 * a Project that `assertReferencesPresent` refuses. Written the other way round, a failure between
	 * the writes would leave a Layer in the stack that nothing can draw and that no later action would
	 * repair. Written this way, a failure leaves an orphaned `remote.json` — a file nothing reads,
	 * which the next add overwrites.
	 *
	 * **Step 2 used to happen only for a community Alignment, and that was the trap.** A referenced map
	 * added without one produced a Layer whose `alignments/<id>.json` did not exist, so this build
	 * exported a zip it then refused to import (ADR-0023's consequence on the starter Alignment).
	 *
	 * **And step 2 is not this method's to do**, which is the other half of the same lesson. The
	 * community Alignment used to be committed here, unconditionally, before `#addMapLayer` ran — one
	 * serialisation here and a second inside, two writers of one file that could disagree, and the one
	 * here with no idea whether it was writing over somebody's work. Both are now
	 * {@link #writeInitialAlignment}, which reaches `writeAlignmentFile` — the only thing that decides
	 * what `alignments/<id>.json` ends up holding and the only place the offer-versus-existing
	 * question is answered. See its comment for why the offer does not simply win.
	 *
	 * **Nothing records that the map is referenced, because nothing has to** (ADR-0023). `remote.json`
	 * without an `info.json` beside it *is* the record, so there is no claim in `project.json` that could
	 * disagree with the folder — and the whole "finish the interrupted copy" repair path went with it.
	 *
	 * The Alignment, either one, is serialised with the **remote service** as its `resource.id`, not
	 * the ADR-0004 placeholder. For a referenced image that is both what makes the file resolvable by
	 * Allmaps (ADR-0007, SPEC story 91) and what makes the warped Layer render at all —
	 * `@allmaps/maplibre` fetches tiles from that `id`.
	 *
	 * @returns the Layer — the new one, or the one this Project already had for this map — with what
	 *   became of the Alignment beside it; or `null` when nothing could be written
	 */
	async addReferencedMap(fields: {
		service: RemoteImageService;
		label: string;
		partOf: string;
		canvas: string;
		rights: string;
		attribution: string;
		/** A community Alignment to import, or `null` to start from scratch (ADR-0015). */
		alignment: Alignment | null;
	}): Promise<ReferencedMapAdded | null> {
		if (!this.openDirectory || !this.openProject) return null;

		const { service } = fields;
		const record = referencedImage({
			imageId: service.imageId,
			service: service.uri,
			label: fields.label,
			partOf: fields.partOf,
			canvas: fields.canvas,
			rights: fields.rights,
			attribution: fields.attribution,
			width: service.width,
			height: service.height,
			// The picture the hub will show beside this map's name is the single tile at the coarsest level
			// of the Library's own pyramid, and which level that is follows from the sheet's pixels and this
			// (ADR-0030). It is in hand only here, at the moment the service was read and accepted.
			tileSize: service.tileSize
		});
		try {
			await this.#autosave.commit(
				referencedImagePath(record.imageId),
				serialiseReferencedImage(record)
			);
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
			return null;
		}

		// Adding the same remote resource twice is one Layer, not two, and `#addMapLayer` is where that
		// is decided. `generateId(uri)` is deterministic, so the second add lands on the same image id —
		// which is a feature (a whole class adding the same map produces one Layer each, and a
		// colleague's Project agrees) and would otherwise be a duplicate Layer over the same tiles.
		const added = await this.#addMapLayer({
			imageId: record.imageId,
			image: { width: service.width, height: service.height },
			alignment: fields.alignment,
			name: record.label || record.imageId,
			// The Library's service rather than the ADR-0004 placeholder, which for a referenced image is
			// both what makes the file resolvable by Allmaps (SPEC story 91) and what makes the warped
			// Layer render at all — `@allmaps/maplibre` fetches its tiles from that `id`.
			address: referencedAlignmentAddress(record.service)
		});
		if (!added) return null;
		// The record is refreshed even when the Layer was already there: the add re-read the resource's
		// description from the library, and the newer one is the one to keep.
		this.referencedImages = [
			...this.referencedImages.filter((image) => image.imageId !== record.imageId),
			record
		];
		return { layer: added.layer, keptExistingAlignment: added.alignment === 'kept over the offer' };
	}

	/**
	 * Draw a Map Image this Workspace already holds in **this** Project too (SPEC stories 27, 33).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * NOTHING IS COPIED, AND THAT IS THE WHOLE FEATURE
	 *
	 * This writes a Layer and, at most, a starter Alignment. It does not read a tile, does not write
	 * one, and does not touch `images/` at all — which is what ADR-0023 bought: one pyramid, prepared
	 * once, drawn by any number of Projects. The Alignment is the Workspace's too, so a map that was
	 * placed on the earth in another Project is placed here the moment its Layer appears, with no
	 * further action.
	 *
	 * **`create`, never `replace`.** {@link #addMapLayer} routes the Alignment through
	 * {@link writeAlignmentFile}'s `create` intent, so the file somebody else's afternoon is in is
	 * kept and the starter is written only when there is nothing there. The one case that reaches the
	 * write is the reason this source has to offer more than the maps a Project already has: a
	 * Map Image whose ingest landed and whose starter Alignment did not arrives with a pyramid
	 * and **without** a Layer (ADR-0023 writes the Alignment first on purpose), and after a reload
	 * nothing on the Project screen connects the two. Adding it from here is the repair.
	 *
	 * **The size comes off `info.json`, or off the `remote.json` for a map whose tiles are a
	 * Library's**, because a starter Alignment's Resource Mask is the whole sheet and a sheet of
	 * unknown size is not one this can invent. A map neither record describes is refused in words
	 * rather than added with a Resource Mask over nothing.
	 *
	 * @returns the Layer — the new one, or the one this Project already had — or `null` when nothing
	 *   was written
	 */
	async addWorkspaceMap(imageId: string): Promise<MapLayer | null> {
		this.addMapError = '';
		if (!this.openDirectory || !this.openProject) return null;

		const image = await this.#storedImageSize(imageId);
		if (image === null) {
			this.addMapError =
				`That Map Image was not added: this Workspace holds no readable description of its ` +
				`size, so there is nothing to place an Alignment over. Its record at ` +
				`images/${imageId}/ is missing or damaged.`;
			return null;
		}

		// The Library's service for a referenced map, `{}` for one whose pyramid is here — the same
		// answer `writeAlignment` spreads, out of the same helper, so a map added from this source and
		// one added from the library flow cannot end up with different `target.source.id`s.
		const added = await this.#addMapLayer({
			imageId,
			image,
			...this.#alignmentAddressFor(imageId)
		});
		if (added === null) {
			this.addMapError =
				this.saveError || 'That Map Image was not added: the Layer could not be written.';
			return null;
		}
		return added.layer;
	}

	/**
	 * The pixel dimensions of a Map Image already in this Workspace, or `null`.
	 *
	 * Two records, in this order, and the order is the same rule {@link tileLocation} states: an
	 * `info.json` of ours means the tiles are here and it is the authority on their size; otherwise
	 * the `remote.json` is what the Workspace knows. An offline copy has both, and they agree —
	 * `makeOfflineCopy` tiles the image the record describes — so preferring the local one costs
	 * nothing and keeps the answer on the file the pyramid was actually cut from.
	 */
	async #storedImageSize(imageId: string): Promise<{ width: number; height: number } | null> {
		try {
			const bytes = await this.#store.read(imageInfoPath(imageId));
			const size = imageSizeFromInfo(JSON.parse(new TextDecoder().decode(bytes)));
			if (size !== null) return size;
		} catch {
			// No `info.json`, or one that will not parse. The remote record is the other half of the
			// question rather than a fallback for a failure — a referenced map has never had one.
		}
		const record = this.referencedImages.find((image) => image.imageId === imageId);
		if (record && record.width > 0 && record.height > 0) {
			return { width: record.width, height: record.height };
		}
		return null;
	}

	/**
	 * The Map Images **the Workspace** still fetches from a library, and the ones it has copied.
	 *
	 * Split on **whether the pyramid is there**, which is now the only thing there is to split on
	 * (ADR-0023): the stored `imageMode` is gone, so this is not merely the more reliable of two answers
	 * but the whole answer. A copy whose pyramid landed and whose `project.json` write did not used to be
	 * a lasting disagreement with a repair button behind it; there is nothing left to disagree, so the
	 * repair path is deleted rather than kept as dead code that lies.
	 */
	get remoteOrigins(): { referenced: ReferencedImage[]; offlineCopies: ReferencedImage[] } {
		return partitionByOfflineCopy(this.referencedImages, this.images);
	}

	/**
	 * The Workspace Map Images whose tiles are on somebody else's server, by image id.
	 *
	 * **Here rather than derived again in the Layers pane**, which is where it used to be: it is the
	 * same question `partitionByOfflineCopy` above has just answered, and a `$derived` set in a page is
	 * how one rule acquires a second reading. Every pane that needs it takes this one.
	 */
	get referencedImageIds(): ReadonlySet<string> {
		// A `SvelteSet` rather than a plain one because this file is reactive and the lint rule that says
		// so is right in general: a plain `Set` held anywhere here would not notify. Rebuilt on every
		// read from `$state` this getter depends on, so nothing is held.
		return new SvelteSet(this.remoteOrigins.referenced.map((image) => image.imageId));
	}

	/**
	 * Walk the Workspace's Map Images for the hub's reclaim list (SPEC story 63).
	 *
	 * Called by the hub when it appears, again whenever the **Project list** changes — a Project
	 * deleted here can be the last one that drew a map, and a stale list would say "no Project uses
	 * this map" about one still in use, or the reverse — and again after a deletion. Nothing else calls
	 * it: it weighs every file under `images/`, so it is a walk tied to a change in what it reports and
	 * never to a keystroke or a re-render.
	 */
	async refreshMapImages(): Promise<void> {
		this.mapImagesLoading = true;
		try {
			this.mapImages = await listWorkspaceMapImages(this.#store);
		} catch (cause) {
			// The same call `refresh` makes about the Project list: a Workspace that cannot be walked is
			// the unreachable state, not an exception the hub has to survive.
			//
			// ⚠ **This verdict is the hub's to afford, and only the hub's.** It blanks the whole screen
			// and offers the Workspace-recovery affordance, which is right when the Workspace *is* the
			// screen. {@link refreshAddableMapImages} is the same walk asked for from a dialog on
			// an open Project, and it deliberately does not come here: a transient failure reading
			// `images/` must not take a scholar's Project off the screen because they pressed a button.
			this.mapImages = [];
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.mapImagesLoading = false;
		}
	}

	/**
	 * Re-read everything the "already in this Workspace" picker is built from (ticket 06).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ONE WALK, THREE RECORDS, BECAUSE TWO OF THEM DECIDED DIFFERENT HALVES OF ONE ANSWER
	 *
	 * The picker lists {@link mapImages} and adds out of {@link referencedImages} and
	 * {@link images}. Re-walking only the first is how a dialog comes to **offer a map it will then
	 * refuse**: `listWorkspaceMapImages` lists an image directory holding a `remote.json`
	 * whether or not this session has ever read that record, and `addWorkspaceMap` gets the map's
	 * size out of the record. A referenced map that entered the Workspace after this Project was
	 * opened — another tab, a synced folder, which is exactly what ADR-0023 invites — was listed by
	 * the fresh walk and refused by the stale one.
	 *
	 * `images` is here for the other half of the same rule: whether a map is still *referenced* is
	 * `partitionByOfflineCopy(referencedImages, images)`, so a map copied offline in another tab
	 * would otherwise be added with a Library's address over a pyramid that is right here.
	 *
	 * **A walk failure is a sentence in the dialog, not the unreachable verdict.** See the warning
	 * on {@link refreshMapImages}. `addMapError` is where it goes because that is the element
	 * the picker already renders, beside the list the failure is about.
	 */
	async refreshAddableMapImages(): Promise<void> {
		this.addMapError = '';
		this.mapImagesLoading = true;
		try {
			const referenced = await listReferencedImages(this.#store);
			this.referencedImages = referenced.images;
			this.referencedImageErrors = referenced.unreadable;
			this.images = await listIngestedImages(this.#store);
			this.mapImages = await listWorkspaceMapImages(this.#store);
		} catch (cause) {
			this.addMapError =
				`The Map Images in this Workspace could not be looked through: ` +
				`${cause instanceof Error ? cause.message : String(cause)} Everything already in this ` +
				`Project is unaffected, and a file or a library address still works.`;
		} finally {
			this.mapImagesLoading = false;
		}
	}

	/**
	 * Delete one Map Image from the Workspace — its pyramid, its `remote.json`, and its Alignment
	 * (SPEC story 65).
	 *
	 * **Refused, not cascaded, when a Project draws it** (SPEC story 64). The refusal names the Projects
	 * and is rendered beside the list; core decides it, so the sentence a user reads is written once.
	 *
	 * The open Project's own two lists are refreshed as well, because a map can be deleted from the hub
	 * while a Project is open in another route and a stale `images` there is a pane drawing from a
	 * pyramid that is gone.
	 *
	 * @returns whether the map was deleted
	 */
	async deleteMapImage(imageId: string): Promise<boolean> {
		this.mapImageError = '';
		const label = this.mapImages.find((map) => map.imageId === imageId)?.label ?? '';
		await this.#quietBeforeDeleting(imageId);
		try {
			await deleteMapImage(this.#store, imageId, { label });
		} catch (cause) {
			// ⚠ **The sweep is here and below, and never before the `await`** (ticket 21, review 2).
			// Sweeping first would make this the one remaining "destroy synchronously, justify
			// asynchronously" pair in the application — the inversion `Workspace.deleteProject` had
			// and ticket 21 fixed. The synchronous half throws away the user's unsaved Alignment edit;
			// the asynchronous half is the one a reload cuts. A reload in between would therefore lose
			// the edit **and** leave the map in place: data loss with no deletion to justify it,
			// through a window wider than `deleteProject`'s, because two awaits open it —
			// `#quietBeforeDeleting` and then `deleteMapImage` itself.
			//
			// Swept only when something was actually removed, which `MapImagePartlyDeletedError`
			// is the only failure that says. `MapImageInUseError` is a refusal taken *before*
			// anything is deleted, and sweeping on it would throw away an unsaved Alignment for a map
			// that is still right there — the same loss by the opposite mistake.
			if (cause instanceof MapImagePartlyDeletedError) {
				this.#forgetJournalled(imageId);
				this.#discardHistory(imageId);
			}
			// Two of these are sentences core has already written for the user, and they are used as
			// written. "Could not be deleted" is the fallback and is only true when nothing was: a
			// half-finished deletion says so itself, because telling a user nothing happened when the
			// Alignment and half the tiles are gone is the one message here that could cost them work.
			this.mapImageError =
				cause instanceof MapImageInUseError || cause instanceof MapImagePartlyDeletedError
					? cause.message
					: `“${label || imageId}” could not be deleted: ${
							cause instanceof Error ? cause.message : String(cause)
						}`;
			// The listing is walked again either way: a partly deleted map is still listed, and what it
			// now weighs is not what the row on screen says.
			await this.refreshMapImages();
			return false;
		}
		// The files are gone, so now the journalled copies of them may go (ticket 20's reason, in
		// ticket 21's order): anything still journalled for the pyramid or the Alignment would be put
		// back at the next startup, describing a Map Image that is no longer in the Workspace.
		this.#forgetJournalled(imageId);
		// The subject of this Alignment's Edit History is gone, so the history goes too (ADR-0039):
		// nothing may offer to reverse an edit to a map that is no longer in the Workspace, and undoing
		// one would recreate the very orphan `alignments/<id>.json` this deletion just swept.
		this.#discardHistory(imageId);
		this.images = this.images.filter((image) => image.imageId !== imageId);
		this.referencedImages = this.referencedImages.filter((image) => image.imageId !== imageId);
		await this.refreshMapImages();
		return true;
	}

	/**
	 * Drop every pending and journalled byte belonging to one Map Image: its pyramid **and its
	 * Alignment**.
	 *
	 * ⚠ **The Alignment is not under `images/<id>/`, and `abandon` was only given that prefix**
	 * (ticket 21, review 3). `alignmentPath(id)` is `alignments/<id>.json` — a sibling, which is why
	 * the journal below needs a second call and why one `abandon` was not enough. So on the very path
	 * this method exists for, the unsaved specimen *is* the Alignment: its journal entry was
	 * forgotten and the pending bytes it is written from were not, leaving `capture()` to re-journal
	 * it at `pagehide` and `flush()` to write it outright — recreating `alignments/<id>.json` for a
	 * Map Image that is gone, which is the orphan `deleteMapImage` exists to prevent.
	 *
	 * ⚠ **The promise `abandon` answers with is dropped here, and that is now merely true rather than
	 * load-bearing** (round 4). This runs *after* `deleteMapImage` has removed the files, so a
	 * write still in flight has already either landed or not and waiting on it would re-delete
	 * nothing. The window it used to leave open is closed by {@link #quietBeforeDeleting}, at the top
	 * of {@link deleteMapImage} and **before** the deletion, where waiting can still change the
	 * outcome.
	 */
	#forgetJournalled(imageId: string): void {
		void this.#autosave.abandon(`${imageDirectory(imageId)}/`);
		void this.#autosave.abandon(alignmentPath(imageId));
		this.#journal?.forgetUnder(`${imageDirectory(imageId)}/`);
		// ⚠ **`forgetUnder`, not `forget`, and the exact path is a legal prefix of itself.** Two things
		// turn on it. `forget` means "the store has taken these bytes" and is the only thing that
		// writes a baseline, so using it for a *deletion* files bytes the store never took. And
		// `forgetUnder` is what sweeps the held namespace: a copy a replay declined for this map's
		// Alignment would otherwise outlive the map, and be reported at every startup for ever with a
		// remedy about a file that no longer exists — precisely what that sweep exists to prevent.
		this.#journal?.forgetUnder(alignmentPath(imageId));
	}

	/**
	 * Let the store finish with a Map Image's files before asking for them to be deleted
	 * (ticket 21, rounds 4 and 5).
	 *
	 * `Autosave.abandon` cannot call back a write the store already has, and `#forgetJournalled` runs
	 * *after* the deletion, so a write still in flight when Delete is pressed lands on top of a map
	 * that has gone — an orphaned `alignments/<id>.json` that a later import would deduplicate a
	 * colleague's copy against, or an `images/<id>/image-info.json` for a pyramid that is not there.
	 *
	 * ⚠ **Both prefixes, exactly as {@link #forgetJournalled} sweeps both** (round 5). The first cut
	 * waited on the Alignment alone, which left the pyramid's own files — `image-info.json`,
	 * `remote.json`, the tiles — with the identical window and no sentence saying why they were
	 * different. They are not different; the argument covers both or neither. Each is pinned by its
	 * own test holding one write open, because written as one test the two waits sit in the same
	 * `Promise.all` and either alone parks the deletion until both are released — so a pair would
	 * have asserted nothing about either.
	 *
	 * ⚠ **What this closes is the *in-flight* case, and saying more than that is what round 4 got
	 * wrong.** `Autosave.settled` also brings a merely-pending file to rest, but on these two
	 * prefixes nothing debounced is ever queued and a pending file is swept by
	 * {@link #forgetJournalled} before anything restarts it. The wait earns its place on writes the
	 * store already has, which are the ones nothing downstream can call back.
	 *
	 * ⚠ **This is not the inversion review 2 removed from this method.** What made the old ordering
	 * an inversion was not that something happened before the deletion but that it *destroyed the
	 * user's only copy* — the journal entry holding an unsaved Alignment — before anything justified
	 * destroying it, so a reload in between lost the edit **and** left the map in place.
	 * `Autosave.settled` discards nothing: it starts the writes that were already queued and waits
	 * for the store to take them. An edit that survives this is on disk, so the refusal below can
	 * still refuse and the user still has their work. `Workspace.deleteProject` does the same thing
	 * with `abandon`, two files away, for the same reason.
	 *
	 * Bounded, so a write that never settles costs a pause and not the gesture; if the wait expires
	 * the deletion goes ahead anyway, and `deleteMapImage`'s partial-failure design leaves a map
	 * that is still listed and can be finished by hand.
	 */
	async #quietBeforeDeleting(imageId: string): Promise<void> {
		await Promise.all([
			this.#autosave.settled(`${imageDirectory(imageId)}/`),
			this.#autosave.settled(alignmentPath(imageId))
		]);
	}

	/**
	 * How many bytes the whole Workspace holds, for the ADR-0008 hosting warning (ticket 15, 16).
	 *
	 * Through `workspaceSize`, which uses `ProjectStore#size` and never `read`: a Workspace with a
	 * offline copy's pyramid in it is tens of thousands of files, and opening every one of them to add up
	 * their lengths would make this the slowest thing in the application. The whole Workspace rather
	 * than the open Project, because the ~1 GB budget is shared by every Project published together.
	 */
	async workspaceBytes(): Promise<WorkspaceSize> {
		return workspaceSize(this.#store);
	}

	// ── The Base Map's offline tile cache (ADR-0025) ─────────────────────────────────────────────
	//
	// Workspace-level, so these take no Project directory: two Projects in the same city share tiles,
	// which is what makes "is this Project available offline?" a question about which files exist.
	// Every one of these is a thin pass-through to core, for the same reason the rest of this class is
	// — the store is held here and nowhere else.

	/**
	 * How much of what `bounds` needs is already cached for one archive, and what filling it takes.
	 *
	 * `archive` is the catalog entry's own `archive` string, which is what the cache directory is keyed
	 * on (ticket 12). Asked per archive because a Workspace may hold a cache for each of several, and
	 * one archive's tiles do not make a Project drawn on another available offline.
	 */
	async offlineBaseMapCoverage(
		archive: string,
		bounds: GeoBounds,
		maxZoom: number
	): Promise<OfflineCoverage> {
		return offlineCoverage(this.#store, archive, bounds, maxZoom);
	}

	/** Fetch the tiles a coverage says are missing into the Workspace. */
	async fetchBaseMapTiles(options: Omit<FetchTilesOptions, 'store'>): Promise<TileFetchResult> {
		return fetchTilesIntoCache({ ...options, store: this.#store });
	}

	/**
	 * What **every** Base Map cache in this Workspace is taking up, for the hub's reclaim list.
	 *
	 * `list` + `size`, never `read`. Summed across archives because the sentence it feeds is about the
	 * Workspace's disk and the button beside it clears the lot.
	 */
	async baseMapCacheSize(): Promise<BaseMapCacheSize> {
		return readBaseMapCacheSize(this.#store);
	}

	/** What one archive's cache holds, which is the depth its own MapLibre source is capped at. */
	async baseMapCacheSizeFor(archive: string): Promise<BaseMapCacheSize> {
		return readBaseMapCacheSizeFor(this.#store, archive);
	}

	/** What one archive's cache records about its own depth, or `null` if it records nothing. */
	async cachedBaseMapTileSource(archive: string): Promise<CachedTileSource | null> {
		return readCachedTileSource(this.#store, archive);
	}

	/** Record where the cache came from. Called after a run, never before one. */
	async recordBaseMapTileSource(source: CachedTileSource): Promise<void> {
		await writeCachedTileSource(this.#store, source);
	}

	/** Delete every cached tile, and report how many went. */
	async clearBaseMapCache(): Promise<number> {
		return emptyBaseMapCache(this.#store);
	}

	/**
	 * Serve one cached tile to MapLibre, or `null` when the cache has none there (ADR-0011).
	 *
	 * The Base Map's counterpart to {@link imageServiceFetch}: the store is reached from the page
	 * through a function, never by a service worker holding a directory handle. Bound rather than
	 * returned as a method reference so a protocol registration keeps working across a re-render.
	 *
	 * ⚠ **The same function every time**, which the doc above used to claim and the code did not do.
	 * A fresh closure per call makes `{ maxZoom, readTile }` a new value on every recompute, and the
	 * `$effect` that registers it tears the protocol down and puts it back on every document change —
	 * MapLibre keeps a `maxzoom`-bearing source pointed at a handler that is briefly `null`. The store
	 * is fixed for the life of a session, so there is nothing for a second closure to capture.
	 */
	readCachedBaseMapTile(archive: string): (tile: TileCoordinate) => Promise<Uint8Array | null> {
		if (this.#readCachedBaseMapTile?.archive !== archive) {
			this.#readCachedBaseMapTile = {
				archive,
				read: this.#makeCachedBaseMapTileReader(archive)
			};
		}
		return this.#readCachedBaseMapTile.read;
	}

	/**
	 * The reader for the archive last asked about, kept — see the warning above.
	 *
	 * One slot rather than a cache per archive, and keyed since ticket 12 keyed the cache directory: a
	 * pane draws one Base Map at a time, so the reader only has to be stable *while* an entry is
	 * selected. Picking another entry deliberately produces a new function, which is exactly what the
	 * registering `$effect` should see — the tiles being served really have changed, and a reader that
	 * stayed identical while closing over the previous archive's key is the wrong-map failure arriving
	 * through the cache instead of through the directory.
	 *
	 * A plain field and not `$state`: it is written from inside a `$derived`, and nothing may re-run
	 * because a memo was filled in.
	 */
	#readCachedBaseMapTile: {
		archive: string;
		read: (tile: TileCoordinate) => Promise<Uint8Array | null>;
	} | null = null;

	#makeCachedBaseMapTileReader(
		archive: string
	): (tile: TileCoordinate) => Promise<Uint8Array | null> {
		const store = this.#store;
		return async (tile) => {
			try {
				return await store.read(cachedTilePath(archive, tile));
			} catch {
				// A tile the cache does not hold. Answered as absence rather than as an error, because a
				// stray request outside a partly filled cache is ordinary — and the Project-level claim
				// about being available offline is computed from `offlineCoverage`, never from whether
				// anything here complained.
				return null;
			}
		};
	}

	/**
	 * What publishing would write into this Workspace, and everything the user must read first
	 * (ticket 16; ADR-0006, ADR-0008).
	 *
	 * **Writes nothing.** Two of the three required warnings are questions rather than reports — the
	 * Base Map's size has to be stated *before* it is added (ADR-0020) and the ~1 GB hosting cliff is
	 * a decision (ADR-0008) — so the plan is a separate step the dialog shows before its button does
	 * anything.
	 */
	async planPublish(options: {
		bundle: ViewerBundle;
		/**
		 * This deployment's own address, which the site records so its Front Page can lead back here
		 * (SPEC story 55).
		 *
		 * Required rather than optional, and supplied by the app for `readAsset`'s reason: where this
		 * deployment lives is `$lib/base-map/deployment-assets`'s business, and a caller that could
		 * quietly omit it would publish a site with no way back and nothing to say so.
		 */
		editorUrl: string;
		/**
		 * The repository this Workspace publishes to, so the site can point back at it (SPEC story
		 * 146) — or `null` for a publish into a folder.
		 *
		 * Supplied by the app because the relationship is installation-local metadata held by
		 * `WorkspaceStorage`, and generated *into* the site rather than synchronized: nothing a
		 * Published Site says may bind a Workspace.
		 */
		repository: PublishedRepository | null;
	}): Promise<PublishPlan> {
		return planPublish(this.#store, {
			bundle: options.bundle,
			projects: await this.#workspace.listProjects(),
			editorUrl: options.editorUrl,
			repository: options.repository
		});
	}

	/**
	 * Write the Published Site (SPEC stories 78–81).
	 *
	 * Everything pending is flushed first, for the same reason exporting a zip flushes: publishing a
	 * Project whose last edit is still inside the autosave debounce would put a site on the web that
	 * is missing the change the user just made — and unlike an export, they may not look at it again
	 * for a week (ADR-0017 rule 1).
	 *
	 * `readAsset` comes from the app rather than from here, because where this deployment serves the
	 * viewer's files from is `$lib/publish/viewer-bundle-source`'s business and must stay relative
	 * (ADR-0006).
	 */
	async publish(options: {
		plan: PublishPlan;
		readAsset: (file: ViewerBundleFile) => Promise<Bytes>;
		onProgress?: (progress: { files: number; totalFiles: number; path: string | null }) => void;
	}): Promise<PublishedSite> {
		await this.flush();
		const site = await publishSite({
			store: this.#store,
			plan: options.plan,
			readAsset: options.readAsset,
			...(options.onProgress ? { onProgress: options.onProgress } : {})
		});
		// The Project list on screen is what the site now claims, so a stale list would make the
		// staleness notice wrong in the direction that matters.
		this.projects = await this.#workspace.listProjects();
		return site;
	}

	/** The record the Published Site carries about itself, or `null` if there is no site yet. */
	async readPublishedSite(): Promise<PublishedSite | null> {
		return readPublishedSite(this.#store);
	}

	/**
	 * What sending this Workspace to its Remote would cost, and everything the user must read first
	 * (ticket 04; ADR-0031, ADR-0033).
	 *
	 * **Sends nothing**, so both of its refusals — a truncated tree, a Workspace of more files than a
	 * publish can list — reach the user with the Remote untouched. It is the forecast the dialog shows
	 * before the button does anything: the two numbers of story 9, the three budgets, and whether
	 * there is anything to do at all.
	 *
	 * @throws RemotePublishRefusedError, RemotePublishCredentialError, RemotePublishFailedError
	 */
	async planRemotePublish(options: {
		token: string;
		remote: RemoteRepository;
		/**
		 * What the local publish will write into the Workspace before the upload runs, so the three
		 * budgets are about the publish being agreed to rather than about the folder as it stands.
		 * `PublishDialog` hands it {@link PublishPlan.files}.
		 */
		pending?: readonly PendingLocalFile[];
	}): Promise<RemotePublishPlan> {
		return planWorkspaceUpload(this.#store, {
			token: options.token,
			remote: options.remote,
			baseline: await this.#lastSharedWith(options.remote),
			...(options.pending ? { pending: options.pending } : {})
		});
	}

	/**
	 * What this Workspace and `remote` last shared, or `null` for `Cannot tell`.
	 *
	 * ⚠ **The Remote is handed to the record rather than assumed of it**, which is what makes a
	 * re-bound Workspace safe: `SynchronizationMetadata.readBaseline` answers `null` for a record
	 * naming a different repository or branch, so this machine's claim about `ada/atlas` can never
	 * stand as evidence about `ada/atlas-2`. A session with nowhere durable to keep a Baseline has no
	 * record at all and says so, which the engine reads as the same "we cannot say" and refuses on
	 * rather than guesses at.
	 */
	async #lastSharedWith(remote: RemoteRepository): Promise<SynchronizationBaseline | null> {
		return (await this.#synchronization?.readBaseline(remote)) ?? null;
	}

	/**
	 * What this Workspace's Remote Status is now, observed and nothing more (ticket 12, ADR-0038).
	 *
	 * ⚠ **Observational, and every clause of that is load-bearing.** It lists Remote metadata; it
	 * downloads no file bytes, writes no Workspace path, writes no Remote path, and — SPEC story 117 —
	 * never advances a Baseline. A check that recorded what it saw would adopt another machine's
	 * afternoon as this one's evidence, and the next Publish would remove it as an ordinary deletion.
	 *
	 * ⚠ **No local read, list or hash either** (SPEC story 114). The local half comes from ticket 10's
	 * durable write index, so the answer costs one GitHub request rather than a walk of tens of
	 * thousands of pyramid tiles. That is what makes checking on every window focus affordable at all —
	 * and it is why a *deliberate* Update or Publish still takes the complete read-and-hash pass, which
	 * is entitled to revise what this displayed.
	 *
	 * ⚠ **`mayRequest: false` is what keeps a signed-out session from polling GitHub.** An anonymous
	 * reader gets sixty requests an hour per IP address (ADR-0031), so automatic anonymous checking
	 * would spend a shared campus address's whole budget on status. The determinations that need no
	 * request are still made — a Workspace with no Baseline is `Cannot tell` whatever the Remote holds
	 * — and anything else answers `'not-attempted'`, which leaves the last determination untouched.
	 *
	 * @param token the credential to list with, or `null` to list a public Remote anonymously
	 */
	async checkRemoteStatus(options: {
		remote: RemoteRepository;
		token: string | null;
		/** Whether this check may ask GitHub at all. `false` answers from local evidence, or not at all. */
		mayRequest: boolean;
	}): Promise<RemoteStatusObservation> {
		const changes = this.localChanges;
		const baseline = (await this.#synchronization?.readBaseline(options.remote)) ?? null;
		// Nothing durable to compare against, or nothing tracking what changed here: `Cannot tell`, and
		// it is a *determination* rather than a failure — so it is reached without a request, which is
		// also what lets a signed-out Workspace say it at all.
		if (changes === null || baseline === null) {
			return {
				outcome: 'determined',
				status: 'cannot-tell',
				publishedSiteStale: [],
				requested: false
			};
		}
		if (!options.mayRequest) return { outcome: 'not-attempted' };
		const found = await checkSourceStatus({
			changes,
			remote: await readRemoteInventory({ remote: options.remote, token: options.token }),
			baseline
		});
		return {
			outcome: 'determined',
			status: found.status,
			publishedSiteStale: found.publishedSiteStale,
			requested: true
		};
	}

	/**
	 * Bring the Remote's own additions, replacements and confirmed deletions into this Workspace
	 * (tickets 14 and 15, ADR-0038).
	 *
	 * ⚠ **Everything pending is written down first, and both flushes are load-bearing.** The engine
	 * reads and hashes every file in the Workspace to build its plan, so an Annotation still inside
	 * the autosave debounce would be hashed as the bytes *before* the edit — and the Remote's version
	 * of that path would then look like a safe inbound replacement of work the author had just done.
	 * The write index is flushed for the other direction: `clearShared` below narrows the record on
	 * disk, and marks still only in memory would survive it.
	 *
	 * ⚠ **No credential is passed and none is taken** (SPEC story 105). Inbound synchronization reads
	 * a public repository anonymously; an author who cannot push to their instructor's Remote can
	 * still receive from it, and consulting the credential store here would make the flow behave
	 * differently for whoever happened to be signed in.
	 *
	 * The evidence is recorded in the order SPEC gives: the Baseline first, and the index narrowed
	 * only if it was kept. A refused Baseline write leaves `Cannot tell` beside a *successful* Update
	 * — never an Update reported as failed after the bytes have arrived — and `writeBaseline` has
	 * already discarded the stale record rather than leaving one that describes the state before.
	 *
	 * @returns what arrived, and whether the Baseline advance was kept
	 * @throws UpdateRefusedError for every refusal there is, with the Workspace as it was
	 */
	async updateFromRemote(options: {
		remote: RemoteRepository;
		onProgress?: (progress: { files: number; totalFiles: number }) => void;
		/** Show what would be removed and answer whether to go ahead (SPEC stories 126, 127). */
		confirmDeletion?: (preview: UpdateDeletionPreview) => Promise<boolean>;
	}): Promise<{ update: WorkspaceUpdate; baselineKept: boolean }> {
		await this.flush();
		await this.localChanges?.flushChanges();

		const update = await updateFromGitHub(this.#store, {
			remote: options.remote,
			baseline: (await this.#synchronization?.readBaseline(options.remote)) ?? null,
			estimateStorage: () => navigator.storage.estimate(),
			workspace: this.#workspaceKey,
			...(options.confirmDeletion ? { confirmDeletion: options.confirmDeletion } : {}),
			...(options.onProgress
				? { onProgress: ({ files, totalFiles }) => options.onProgress?.({ files, totalFiles }) }
				: {})
		});

		// ⚠ **Every Edit History goes, and being generous here is the safe direction** (ADR-0039). An
		// Update rewrites arbitrary paths anywhere in the Workspace, and a Step holds the bytes of the
		// files its gesture wrote — so any Step taken before this may describe a file the Update has
		// just replaced, and undoing it would write the pre-Update bytes back over what arrived. That
		// is the same hazard as the unread `openProject` below, with a worse blast radius: it reaches
		// the Alignments too, and it is a gesture the scholar performs on purpose.
		for (const history of this.#histories.values()) history.discard();

		// The inbound writes crossed the managed store like any other, so they are in the index as
		// this Workspace's own changes until the Baseline that makes them shared is durable.
		await this.localChanges?.flushChanges();
		const baselineKept =
			this.#synchronization === undefined ||
			(await this.#synchronization.writeBaseline({
				remote: options.remote,
				commit: update.commit,
				files: update.baseline
			}));
		// ⚠ **Only the paths the Update made shared, and only once the Baseline is durable.** Clearing
		// the whole index would report the author's untouched local-only work as shared with a Remote
		// that has never seen it (SPEC story 130); clearing anything at all under a refused Baseline
		// write would drop the record of local changes there is now no evidence to compare against.
		if (baselineKept) await this.localChanges?.changes.clearShared(update.shared);

		// The hub's list is what an inbound Project appears in, and the Update wrote its `project.json`
		// underneath every reader (SPEC story 123).
		this.projects = await this.#workspace.listProjects();
		// ⚠ **And the Project on screen is read again, because the Update may have replaced it.** Update
		// is reachable from the navigation bar with a Project open, and `openProject` is the model every
		// Layer edit spreads over before writing it back — so an inbound `project.json` left unread would
		// be silently undone by the next `addLayer`, taking the Layer the Update had just brought in
		// (SPEC story 124). `openProject` is blanked first because `open` returns early for the Project it
		// is already showing.
		const showing = this.openDirectory;
		if (showing !== null) {
			this.openProject = null;
			await this.open(showing);
		}
		return { update, baselineKept };
	}

	/**
	 * Send this Workspace to its Remote, and record what the Remote then holds.
	 *
	 * ⚠ **It plans again rather than taking the plan the user was shown, and that is a correctness
	 * requirement.** Confirming the dialog stamps the canonical address into every `info.json` and
	 * writes the viewer's files into the Workspace — so by the time this is called the Workspace holds
	 * files the forecast never saw, and `publishToRemote` uploads exactly the paths its plan names.
	 * Handed the forecast it would publish a site with no `index.html` in it, silently, on the one
	 * publish that most needs to work: the first.
	 *
	 * The Baseline is installation-local rather than a file in the Workspace, because it records what
	 * *this machine* last shared with the Remote and a record that travelled with the Workspace would
	 * be another machine's belief arriving as this one's evidence (ADR-0038).
	 *
	 * @returns the plan that ran, the commit the branch now holds, and whether the Baseline was kept
	 * @throws RemotePublishRefusedError when the Remote moved past what `replace` agreed to
	 * @throws RemotePublishRateLimitedError, RemotePublishCredentialError, RemotePublishFailedError
	 */
	async publishToRemote(options: {
		token: string;
		remote: RemoteRepository;
		/**
		 * The paths of the conflict the scholar was shown and agreed to replace (ADR-0033).
		 *
		 * ⚠ **The paths and not a `true`, because the plan this runs is not the plan they read.** The
		 * forecast is made before the local publish writes; this replans afterwards, against a tree
		 * listing taken minutes later on a large Workspace. Handed a bare "yes" the engine would apply a
		 * decision about one `notes.json` to whatever the second listing found — including a Project
		 * another machine published in the window, deleted without anybody having seen its name. So the
		 * agreement travels as the set it was about, and `publishToRemote` refuses when the second
		 * plan's conflict is not a subset of it.
		 *
		 * Left out, a Remote somebody else has written to is refused, which is the default.
		 */
		replace?: readonly string[];
		onProgress?: (progress: {
			files: number;
			totalFiles: number;
			requestsRemaining: number | null;
		}) => void;
	}): Promise<{ commit: string; plan: RemotePublishPlan; baselineKept: boolean }> {
		// Everything pending on disk first, for the same reason `publish` flushes: an Annotation still
		// inside the autosave debounce would go to a public host missing the edit just made. The write
		// index is flushed for the other direction: `clearShared` below narrows the record on disk, and
		// marks still only in memory would survive it.
		await this.flush();
		await this.localChanges?.flushChanges();
		const { commit, plan, baselineKept } = await publishWorkspace(this.#store, {
			token: options.token,
			remote: options.remote,
			...(this.#synchronization === undefined ? {} : { metadata: this.#synchronization }),
			...(this.localChanges === null ? {} : { changes: this.localChanges.changes }),
			...(options.replace === undefined ? {} : { replace: options.replace }),
			...(options.onProgress ? { onProgress: options.onProgress } : {})
		});
		return { commit, plan, baselineKept };
	}

	/**
	 * Copy a referenced Map Image into the Workspace as local tiles (SPEC stories 27, 28).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * TWO WRITES NOW, WHERE THERE WERE THREE
	 *
	 *   1. the pyramid, through `makeOfflineCopy` → `ingestImageFile`, whose `info.json` lands last
	 *      and is therefore the completion marker for the whole directory;
	 *   2. `alignments/<id>.json`, rewritten to name the ADR-0004 placeholder instead of the library.
	 *
	 * **`project.json` is not touched at all, and that is ADR-0023 rather than an omission.** The third
	 * write existed to flip a Layer's `imageMode` from `'referenced'` to a local copy. There is no such
	 * field: `remote.json` beside an `info.json` of ours *is* the record that the tiles are here, so
	 * making the copy is the whole of recording it, and every Project that draws this map sees it at
	 * once rather than only the one that happened to be open.
	 *
	 * That also removes the half-committed state the repair path existed for. The pyramid landing and a
	 * document write failing afterwards used to leave a Layer claiming the library while the tiles sat
	 * unused — permanent, self-contradicting, and greeted on next open by a "Finish the offline copy"
	 * button. With one derived answer there is nothing left to finish.
	 *
	 * **Step 2 is not optional.** The stored Alignment of a referenced image names the remote service as
	 * its `resource.id`, which is what made it resolvable by Allmaps and what made the warped Layer
	 * render at all. Left alone after a copy it would keep sending `@allmaps/maplibre` to the library for
	 * tiles that are now in this folder — so the copy would work, the map would draw, and making an offline copy would
	 * have bought nothing. It is also what publishing serves, and a self-contained site whose Alignment
	 * points at a stranger's server is not self-contained.
	 *
	 * A failure before step 1 finishes leaves the map still fetched from the library, which is the state
	 * it was in.
	 *
	 * @returns `true` when the copy landed and the Alignment names this Workspace's own tiles
	 */
	async makeOfflineCopy(options: {
		image: ReferencedImage;
		service: RemoteImageService;
		/** The plan the user was shown, so what was agreed to is what runs. */
		plan: OfflineCopyPlan;
		onProgress?: (progress: OfflineCopyProgress) => void;
		signal?: AbortSignal;
	}): Promise<boolean> {
		const { image, service, plan } = options;

		await makeOfflineCopy({
			store: this.#store,
			service,
			plan,
			label: image.label || image.imageId,
			fetch: this.imageServiceFetch(),
			assemble: assembleWithCanvas,
			openDecodeAndCrop: openDecodeAndCropSource,
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
			...(options.signal ? { signal: options.signal } : {})
		});

		// No check that the session is still on the Project it started from. The pyramid and the Alignment
		// both belong to the Workspace, so neither write depends on which Project is open — which is what
		// used to make "the user navigated away mid-copy" one of the three routes into a half-committed
		// copy.
		return this.#recordLocalCopy(image.imageId);
	}

	/**
	 * Rewrite a copied map's Alignment to name this Workspace's own tiles rather than the library.
	 *
	 * The second of {@link makeOfflineCopy}'s two writes, kept as its own method because it is the only part
	 * of a copy that touches a document the user made.
	 *
	 * Idempotent: re-serialising an Alignment that already names the ADR-0004 placeholder produces the
	 * same bytes, so a copy repeated over a map already copied changes nothing.
	 *
	 * **An `update`, and it has to be** (ticket 18). It is not a `create` — there is certainly an
	 * Alignment there and the whole point is to change it — and it is not a `replace`, because nothing
	 * of the user's is discarded: every Control Point, the Resource Mask and the transformation type
	 * are read out of the existing file and written straight back, and since ticket 18 so is every
	 * member of the document this build does not model. The one thing that changes is the address,
	 * which is not the user's work but a statement of where the tiles now are — and the user asked for
	 * exactly that by asking for the copy.
	 *
	 * @returns `true` when the Alignment names the placeholder and the pyramid is on disk
	 */
	async #recordLocalCopy(imageId: string): Promise<boolean> {
		const path = alignmentPath(imageId);
		try {
			// Round-tripped through the parser rather than string-edited: `alignment-file.ts` is the one
			// writer of that document, and omitting the address is what puts the placeholder back.
			//
			// **No `basedOn`, deliberately.** This is not a user's edit racing a colleague's; it is this
			// session rewriting the address of a file it has just finished copying the tiles for, and the
			// bytes it is based on were read one line above. A concurrency report here would be about the
			// wrong thing.
			const report = await writeAlignmentFileReporting(this.#alignmentFile, {
				alignment: parseAlignment(await this.#store.read(path), { imageId }),
				write: { intent: 'update' }
			});
			// **The baseline moves with it — as insurance, and it is worth being exact that no reachable
			// path needs it today.** The copy rewrites `target.source.id` from the Library's service to
			// the placeholder, so a session holding a stale baseline over this map would report its next
			// ordinary save as a concurrent edit. That session cannot currently exist: the offline-copy
			// dialog is mounted only by `ProjectScreen.svelte`, the alignment view is the separate
			// `/align` route, one session cannot have both on screen, and a second tab is a second
			// `EditorSession` this line could not reach anyway. `writeAlignment`'s only callers are also
			// both downstream of `loadAlignment` → `readAlignment`, which re-establishes the baseline
			// from disk. So deleting this line leaves the whole gate green, and it is kept because the
			// rule on {@link #rememberAlignmentOnDisk} is "every write moves the baseline" and a write
			// that opted out would be the exception a future caller inherits.
			this.#rememberAlignmentOnDisk(imageId, report.written);
			this.saveError = '';
		} catch (cause) {
			// No Alignment yet is the ordinary case for a map nobody has placed. Anything else is not:
			// leaving an Alignment that points at the library would undo the whole copy, so it is reported
			// and the copy is not claimed to have landed.
			if (!(cause instanceof PathNotFoundError)) {
				this.saveError = cause instanceof Error ? cause.message : String(cause);
				return false;
			}
		}

		this.images = await listIngestedImages(this.#store);
		return this.images.some((image) => image.imageId === imageId);
	}

	/**
	 * Ask `annotations.allmaps.org` whether anyone has already aligned this image.
	 *
	 * The seam is here because this is the only place the app talks to `@ballastella/core` and to the
	 * `@allmaps/*` packages, and because it is the *only* call site — `findCommunityAlignments`
	 * returns before reaching it when the setting is off, so "off means no request" is structural
	 * rather than a flag threaded through a third party's code.
	 *
	 * `fetchAnnotationsFromApi` reaches the network through the page's own `fetch` and offers no
	 * injection point, which is why it cannot be routed through the ADR-0011 shim and why the request
	 * is counted by `recordRemoteRequest` at the caller instead.
	 */
	async fetchCommunityAnnotations(image: Parameters<typeof fetchAnnotationsFromApi>[0]) {
		return fetchAnnotationsFromApi(image);
	}

	/** What the user calls one Map Image, or `''` when its manifest cannot be read. */
	async #imageLabel(imageId: string): Promise<string> {
		try {
			const bytes = await this.#store.read(imageManifestPath(imageId));
			return readImageLabel(JSON.parse(new TextDecoder().decode(bytes)));
		} catch {
			// Swallowed, because a name is not worth failing an add over. The caller falls back to the
			// image id — a poor name the user can change (SPEC story 54) — where throwing would leave a
			// Map Image prepared, an Alignment written, and no Layer drawing either of them.
			return '';
		}
	}

	/**
	 * Add an empty Annotation Layer to the stack (SPEC stories 55 and 56).
	 *
	 * Its `FeatureCollection` is written **before** the Layer that references it, and with the same
	 * discipline as `orderForWriting` in the zip importer: a Layer whose `geojsonRef` names nothing is
	 * a Project that ticket 13's import refuses, so the reference must never exist without its file.
	 * Drawing into it is ticket 10.
	 *
	 * **And `project.json` is read after that write rather than before it**, for the same reason as
	 * {@link #addMapLayer}: a snapshot taken before an `await` and written back after it discards
	 * whatever else changed in between. Here the "whatever else" is the other click — a user
	 * double-clicking the button got one Layer instead of two, plus an orphaned `.geojson` in
	 * `annotations/` that nothing references and no part of the interface can reach.
	 *
	 * @returns the Layer, or `null` when it could not be created
	 */
	async addAnnotationLayer(name: string): Promise<AnnotationLayer | null> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return null;
		const layer = newAnnotationLayer({ id: crypto.randomUUID(), name });
		// Both files the gesture writes, the document first, which is the order undo writes them back
		// in: a Layer whose reference names a file that is not there is a Project the importer refuses,
		// and on screen it is a row that reads an empty document and paints nothing.
		return this.historyFor(directory).step(
			`Undo adding the Layer ${quotedName(name)}`,
			[annotationStorePath(directory, layer.id), projectFilePath(directory)],
			async () => {
				try {
					await this.#autosave.commit(
						annotationStorePath(directory, layer.id),
						emptyAnnotationCollection()
					);
				} catch (cause) {
					this.saveError = cause instanceof Error ? cause.message : String(cause);
					return null;
				}
				const project = this.openProject;
				if (!project) return null;
				this.openProject = { ...project, layers: addLayer(project.layers, layer) };
				await this.#write(directory);
				return layer;
			}
		);
	}

	/**
	 * Rename a Layer (SPEC story 54). Coalesced per file, so a name typed one character at a time is
	 * one write and not twelve (ADR-0017 rule 2).
	 *
	 * **Only `project.json` changes.** The name is display state and has no business in the Alignment
	 * or the GeoJSON, which are portability documents that stand on their own (ADR-0002).
	 */
	async typeLayerName(id: string, name: string): Promise<void> {
		await this.#changeLayers((layers) => renameLayer(layers, id, name), { debounce: true });
	}

	/** SPEC story 50. A discrete act, so it is written now rather than debounced. */
	async showLayer(id: string, visible: boolean): Promise<void> {
		await this.#changeLayers((layers) => setLayerVisible(layers, id, visible), {
			// Which way the toggle went, because that is what undoing it will reverse.
			label: `Undo ${visible ? 'showing' : 'hiding'} the Layer ${this.#quotedLayerName(id)}`
		});
	}

	/**
	 * SPEC story 51. Debounced, because dragging a range input is a continuous gesture and
	 * {@link commitLayerEdit} is what commits it on release (ADR-0017 rule 1).
	 *
	 * **One drag is one Step** (SPEC story 17), so the Step is opened by the first position reported
	 * and closed by {@link commitLayerEdit}, rather than one per `input` event: undo returns the Layer
	 * to the opacity it had before the gesture and never to some value inside it.
	 */
	async dragLayerOpacity(id: string, opacity: number): Promise<void> {
		const standing = this.#opacityDrag;
		// A second slider reporting while one is open: the Step that is standing belongs to a Layer the
		// scholar has stopped dragging, so it is closed before this one opens.
		if (standing && standing.id !== id) await this.commitLayerEdit();

		const change = (layers: readonly Layer[]): readonly Layer[] =>
			setMapLayerOpacity(layers, id, opacity);
		const drag = this.#openOpacityStep(id);
		if (drag === null) {
			await this.#changeLayers(change, { debounce: true });
			return;
		}
		const directory = this.openDirectory;
		if (directory === null) return;
		const write = this.#applyLayerChange(directory, change);
		if (write === null) return;
		// **The bytes are queued behind the drag's `before` image, and queued synchronously.** A range
		// reports positions faster than a store read answers and the release arrives in the same task as
		// the last of them, so a write that ran ahead of the image — or a release that closed the Step
		// while one was still queued — would put bytes the scholar never saw in it.
		const applied = drag.applied.then(() => write({ debounce: true }));
		drag.applied = applied;
		await applied;
	}

	/** Move a Layer to a position in the stack, 0 being the top (SPEC stories 52 and 53). */
	async moveLayerTo(id: string, toIndex: number): Promise<void> {
		await this.#changeLayers((layers) => moveLayer(layers, id, toIndex), {
			label: `Undo moving the Layer ${this.#quotedLayerName(id)}`
		});
	}

	/**
	 * The Step one opacity drag will fill, opened on the first position it reports.
	 *
	 * The gesture handed to `step()` is a promise resolved when the drag ends, which is what makes the
	 * whole drag one Step: the `before` image is read when the first position arrives and the
	 * `after` image once the last one has been flushed. Synchronous, so that the positions arriving
	 * behind it join this drag rather than each opening a Step of its own.
	 *
	 * `null` where there is nothing to record against — no open Project — and the caller writes
	 * without a Step.
	 */
	#openOpacityStep(id: string): OpacityDrag | null {
		const standing = this.#opacityDrag;
		if (standing?.id === id) return standing;
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return null;

		let start = (): void => {};
		let end = (): void => {};
		const started = new Promise<void>((resolve) => {
			start = resolve;
		});
		const finished = new Promise<void>((resolve) => {
			end = resolve;
		});
		const step = this.historyFor(directory).step(
			`Undo the opacity of the Layer ${this.#quotedLayerName(id)}`,
			[projectFilePath(directory)],
			async () => {
				start();
				await finished;
			}
		);
		const drag: OpacityDrag = { id, end, step, applied: started };
		this.#opacityDrag = drag;
		return drag;
	}

	/** The Layer's name as the bar will say it, for a Step's label. */
	#quotedLayerName(id: string): string {
		return quotedName(this.openProject?.layers.find((layer) => layer.id === id)?.name ?? '');
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE EDIT HISTORIES (ADR-0039)
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The Edit History of one subject — a Project directory or a Map Image id — created on first use
	 * (ADR-0039).
	 *
	 * A screen asks for its own and declares it to the navigation bar; the bar draws the controls for
	 * whatever is declared and nothing when nothing is, which is how a screen added later is undo-free
	 * until it says otherwise (SPEC story 55).
	 *
	 * **A Map Image and not a Project on the Alignment side**, because that is what an Alignment is
	 * keyed by: the file belongs to the Workspace and is shared by every Project that draws the map,
	 * so reaching it from a second Project reaches the same history (ADR-0023, SPEC story 5).
	 */
	historyFor(subject: string): EditHistory {
		const standing = this.#histories.get(subject);
		if (standing) return standing;
		const made = new EditHistory(this.#historyFiles);
		this.#histories.set(subject, made);
		return made;
	}

	/**
	 * Throw away one subject's Edit History, because something other than its own Steps has written
	 * the files it describes or its subject is gone (ADR-0039).
	 *
	 * **Not {@link historyFor}**: asking for a history in order to empty it would mint one for a
	 * subject that has never had a Step, and the map is keyed by subject for the lifetime of the
	 * session.
	 *
	 * The whole history goes, never a subset. Trimming to the Steps that still apply means deciding
	 * which images are still true, and the honest answer is that this cannot be known from here —
	 * being wrong writes stale bytes over the very work these events exist to make visible.
	 */
	#discardHistory(subject: string): void {
		this.#histories.get(subject)?.discard();
	}

	/**
	 * Delete a Layer, and the file it draws, as one Step of the Project's Edit History (SPEC story 19).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE ORDER, WHICH IS THE CREATION ORDER IN REVERSE
	 *
	 *   1. `step()`'s flush, so the bytes its `before` image holds are the ones the user can see, and
	 *      so no debounced write can land after the file has gone and put it back unrecorded;
	 *   2. read the referenced file, to learn whether there is one to remove;
	 *   3. `project.json`, losing the Layer;
	 *   4. the referenced file.
	 *
	 * **`project.json` before the file, because every other path here writes the file first.** A Layer
	 * whose reference names nothing is a Project ticket 13's import refuses by name; written the other
	 * way round, a failure between the two steps would leave exactly that. This way the worst
	 * intermediate state is a file nothing references — bytes, not breakage.
	 *
	 * **Steps 2 and 4 do nothing for a map Layer, and that is ADR-0023** (SPEC story 67). Its Map
	 * Image and its Alignment belong to the Workspace and may be drawn by other Projects, so removing the
	 * Layer must leave both where they are — `layerFileRef` answers `''` for a map Layer, which is where
	 * that decision lives. Only an Annotation Layer has a file of this Project's to take with it.
	 *
	 * **The images are the Edit History's, taken either side of the whole gesture** (ADR-0039).
	 * Nothing here reads the file to keep a copy of it: `step()` does that for every declared path,
	 * which is what makes a restored file byte-identical to the deleted one without a restore path of
	 * its own.
	 *
	 * **Nothing records the deletion, because nothing has to** (ADR-0023). A map Layer used to be
	 * created by an Alignment write, so deleting one and then nudging a Control Point put a *new* Layer
	 * at the top of the stack with a fresh id, and undo could not help — from the app's point of view
	 * nothing had been undone. `ProjectFile` carried a list of the deleted maps' image ids for exactly
	 * that. A Layer is now made only by {@link #addMapLayer}, on the user's explicit "add this map"
	 * gesture, so there is nothing left that could resurrect one and no tombstone to keep.
	 *
	 * @returns whether the Layer went
	 */
	async deleteLayer(id: string): Promise<boolean> {
		const directory = this.openDirectory;
		const opened = this.openProject;
		if (!directory || !opened) return false;
		const layer = opened.layers.find((one) => one.id === id);
		if (!layer) return false;

		const ref = layerFileRef(layer);
		// The files this gesture writes, declared rather than inferred: an Annotation Layer's document
		// goes with the entry `project.json` loses. A map Layer answers `''` and declares only
		// `project.json`, which is ADR-0023 — its Map Image and its Alignment are the Workspace's.
		//
		// **The file is named first, because that is the order undo writes them back in.** A Layer whose
		// reference names a file that is not there is a Project this build's own import refuses — and,
		// on screen, a restored Layer that mounts before its document exists reads an empty one and
		// paints nothing.
		const paths =
			ref === ''
				? [projectFilePath(directory)]
				: [`${directory}/${ref}`, projectFilePath(directory)];

		return this.historyFor(directory).step(
			`Undo delete of the Layer ${quotedName(layer.name)}`,
			paths,
			async () => {
				const path = ref === '' ? '' : `${directory}/${ref}`;
				let present = false;
				if (path !== '') {
					try {
						await this.#store.read(path);
						present = true;
					} catch (cause) {
						// No file is the ordinary case for a Layer nothing has been put in yet. Anything else
						// is not: deleting a file we could not read would be deleting work we cannot give
						// back.
						if (!(cause instanceof PathNotFoundError)) {
							this.saveError = cause instanceof Error ? cause.message : String(cause);
							return false;
						}
					}
				}

				// Taken again after the await, never from the snapshot above: `#addMapLayer` and
				// `addAnnotationLayer` both had to learn this, and the document is the one whose loss is
				// "not one annotation but the map of everything" (ADR-0017 rule 4).
				const project = this.openProject;
				if (!project || !project.layers.some((one) => one.id === id)) return false;
				this.openProject = { ...project, layers: removeLayer(project.layers, id) };
				await this.#write(directory);
				if (this.saveError !== '') {
					// The document did not reach storage, so the Layer has not been deleted. Put the stack
					// back as it was rather than leaving the screen claiming a deletion the file does not
					// carry.
					this.openProject = project;
					return false;
				}

				if (present) await this.#store.delete(path);
				return true;
			}
		);
	}

	/**
	 * The edit is over — the field lost focus, Enter was pressed, or the slider was released.
	 *
	 * **A no-op when nothing is waiting to be written**, which is the same guard
	 * {@link commitProjectName} carries and for the same reason: `writeProject` stamps a fresh
	 * `updatedAt`, and ADR-0010 is explicit that merely looking at an old Project must not modify
	 * files. Tabbing through a Layer's name field is looking.
	 */
	async commitLayerEdit(): Promise<void> {
		const drag = this.#opacityDrag;
		if (drag) {
			// The drag is over, so its Step closes: `step()` flushes what the last position left pending
			// and reads the `after` image from that. There is no `#write` to do here — the flush is the
			// commit, and doing both would stamp a second `updatedAt` for one gesture.
			this.#opacityDrag = null;
			// Every position reported so far, applied first: one still queued would land after the
			// `after` image had been read and go unrecorded.
			await drag.applied;
			drag.end();
			await drag.step;
			return;
		}
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		if (!this.#autosave.hasPendingWrite(projectFilePath(directory))) return;
		await this.#write(directory);
	}

	/**
	 * Apply `change` to the Layer stack and write the document.
	 *
	 * One funnel for every Layer mutation, so that reordering, renaming, and toggling are ordinary
	 * mutations of the one in-memory `project.json` — coalescing and flushing like every other edit
	 * rather than each inventing a save path of its own (ADR-0017). It also means there is exactly one
	 * place where "no such Layer" is a no-op rather than a write of an unchanged document.
	 */
	async #changeLayers(
		change: (layers: readonly Layer[]) => readonly Layer[],
		options: { debounce?: boolean; label?: string } = {}
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		// `null` is the no-op: every operation in `layer.ts` returns the array it was given when it
		// changed nothing, so a move that hit the end of the stack costs no write at all — and,
		// answered here, no Step and neither of the flushes one takes its images between.
		const write = this.#applyLayerChange(directory, change);
		if (write === null) return;

		const { label } = options;
		// **No label, no Step**, which is how renaming stays the browser's to undo (SPEC stories 30, 31)
		// without a name for what it is not: a gesture is recorded because its caller said so.
		if (label === undefined) {
			await write(options);
			return;
		}
		await this.historyFor(directory).step(label, [projectFilePath(directory)], () =>
			write(options)
		);
	}

	/**
	 * Apply `change` to the stack in memory, answering how to put it on disk — or `null` when there
	 * was nothing to change.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THE TWO HALVES ARE SEPARATE, WHICH IS ABOUT STEPS RATHER THAN ABOUT WRITING
	 *
	 * A Step's `before` image is read from the store, so the gesture's own bytes must not reach the
	 * store until that read has happened — otherwise undo would write the edit back over itself. But
	 * the *screen* must not wait for a store read to show what the scholar just did: the row a
	 * reorder moved has to be under the pointer for the next click, and a list still in its old order
	 * is a list they will click the wrong row in.
	 *
	 * So the document in memory changes with the gesture and the bytes go out inside the Step, and
	 * the indicator is told here rather than by the write: an edit exists from the moment it is
	 * applied, and a screen reading `Saved locally` in between would be reporting an unwritten edit
	 * as a written one. {@link Autosave}'s own subscription carries it from there.
	 */
	#applyLayerChange(
		directory: string,
		change: (layers: readonly Layer[]) => readonly Layer[]
	): ((options: { debounce?: boolean }) => Promise<void>) | null {
		const project = this.openProject;
		if (!project || this.openDirectory !== directory) return null;
		const layers = change(project.layers);
		if (layers === project.layers) return null;
		this.openProject = { ...project, layers };
		this.saveState = 'saving';
		return (options) => this.#write(directory, options);
	}

	/**
	 * One map Layer's Alignment as stored, or `null` when there is no file yet.
	 *
	 * Read from the Workspace by the Layer's `imageId` (ADR-0023) — and without the Map Image's
	 * pyramid, which the stack does not load: the Alignment carries the image's pixel dimensions itself,
	 * so a Layer can be drawn from the one file it names.
	 *
	 * A Layer whose `imageId` is `''` names no Map Image — a hand-edited or damaged document — and
	 * answers `null` rather than reading `alignments/.json`.
	 *
	 * A file that is there and unreadable throws, for the same reason {@link readAlignment} surfaces
	 * it: silently drawing nothing would hide an Alignment the user made.
	 */
	async readLayerAlignment(layer: MapLayer): Promise<Alignment | null> {
		const { imageId } = layer;
		if (imageId === '') return null;
		try {
			return parseAlignment(await this.#readObserved(alignmentPath(imageId)), { imageId });
		} catch (cause) {
			if (cause instanceof PathNotFoundError) return null;
			throw cause;
		}
	}

	/**
	 * One Annotation Layer's `FeatureCollection` as stored, or `null` when there is no file.
	 *
	 * Parsed as JSON and no further: what the features mean, how they are styled, and how a
	 * description's Markdown is sanitised are ticket 10's, and this slice draws them without
	 * interpreting them.
	 */
	async readLayerFeatures(layer: AnnotationLayer): Promise<unknown> {
		const directory = this.openDirectory;
		if (!directory || layer.geojsonRef === '') return null;
		try {
			const bytes = await this.#readObserved(`${directory}/${layer.geojsonRef}`);
			return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		} catch (cause) {
			if (cause instanceof PathNotFoundError) return null;
			throw cause;
		}
	}

	/**
	 * One Annotation Layer's Annotations, as the model (ticket 10).
	 *
	 * Beside {@link readLayerFeatures} rather than replacing it, and the difference is the point: that
	 * one parses as JSON and no further, because the Layer stack draws a `FeatureCollection` without
	 * interpreting it. This one is for *editing*, which needs the Annotations themselves.
	 *
	 * A Layer with no file yet reads as an empty collection rather than as a failure, because that is
	 * the ordinary state of a Layer somebody has only just added — and **nothing is written here**
	 * (ADR-0010).
	 */
	async readAnnotations(layer: AnnotationLayer): Promise<AnnotationCollection> {
		const directory = this.openDirectory;
		if (!directory || layer.geojsonRef === '') return emptyCollection();
		try {
			const bytes = await this.#readObserved(`${directory}/${layer.geojsonRef}`);
			return parseAnnotations(bytes, { path: layer.geojsonRef });
		} catch (cause) {
			if (cause instanceof PathNotFoundError) return emptyCollection();
			// A file that is there and unreadable must say so, for the same reason `readAlignment`
			// surfaces it: drawing nothing quietly would hide Annotations the user made, and the next
			// save would overwrite them.
			throw cause;
		}
	}

	/**
	 * Write one Annotation Layer's Annotations (SPEC stories 57–66).
	 *
	 * **Through the same {@link Autosave} as everything else**, so ADR-0017's per-file debounce, its
	 * flush-on-hide, and its save state are one mechanism rather than one per file kind. There is no
	 * bespoke save path here, and in particular no `onblur`-rewrites-on-focus-and-leave shape — the
	 * one ticket 02 shipped and had to remove, because ADR-0010 is explicit that merely looking at an
	 * old Project must not modify files.
	 *
	 * `debounce` is for text being typed into the title and description fields (rule 2). A drawn
	 * shape, a moved vertex, a colour chosen, and a deletion are all discrete acts or the end of a
	 * gesture, so they are written now (rule 1) — which is what lets the vertex test assert the
	 * *number* of writes rather than merely that one happened.
	 *
	 * **`project.json` is deliberately not touched.** An Annotation is content; the Layer that
	 * references it already exists, and its name, visibility, and position are display state that has
	 * no business in a portability document (ADR-0002). Stamping `updatedAt` on the document for every
	 * vertex nudge is the same waste {@link writeAlignment} refuses on the Alignment path.
	 */
	async writeAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		options: { debounce?: boolean; label?: string } = {}
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		const path = annotationStorePath(directory, layer.id);
		const { label } = options;
		// A slider released: the drag its positions filled closes here, and `step()` flushes what the
		// last position left pending and reads the `after` image from that. There is no write left to
		// do — the flush is the commit, and doing both would put the same bytes out twice.
		if (label === undefined && options.debounce !== true && this.#annotationDrag?.path === path) {
			await this.#closeAnnotationDrag();
			return;
		}
		const bytes = serialiseAnnotations(collection);
		// **No label, no Step**, the same convention `#changeLayers` follows: a gesture is recorded
		// because its caller said so, which is what keeps a typed title out of the history without
		// anything here having to name what a title is not (SPEC stories 30, 33).
		//
		// **The Layer's own document and nothing else**, which is ADR-0039's disjointness invariant on
		// this side: an Annotation is content, `project.json` is untouched by it, and a Step that named
		// both would be a Project Step reaching into an Alignment's neighbour.
		if (label !== undefined) {
			// **The indicator is told here rather than by the write**, for the reason
			// {@link #applyLayerChange} records: a Step reads its `before` image before the gesture's bytes
			// go out, and a screen reading `Saved locally` across that read would be reporting an edit
			// that exists and is unwritten as a written one. {@link Autosave}'s own subscription carries
			// it from there.
			this.saveState = 'saving';
			await this.historyFor(directory).step(label, [path], () =>
				this.#putAnnotations(path, collection, bytes, options)
			);
			return;
		}
		await this.#putAnnotations(path, collection, bytes, options);
	}

	/**
	 * One position of a style drag over an Annotation Layer's file (SPEC story 23).
	 *
	 * **One drag is one Step**, so the Step is opened by the first position reported and closed by the
	 * unlabelled {@link writeAnnotations} the release reaches, rather than one Step per `input` event:
	 * a five-deep history must not be spent on one slider, and undo must return the Annotation to the
	 * style it had before the gesture rather than to some value inside it.
	 *
	 * `drag.key` names the slider, so reporting on a second one without letting go of the first closes
	 * the standing Step before opening this one — the same thing {@link dragLayerOpacity} does when a
	 * different Layer's slider reports.
	 */
	async dragAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		drag: { key: string; label: string }
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		const path = annotationStorePath(directory, layer.id);
		const bytes = serialiseAnnotations(collection);
		const standing = this.#annotationDrag;
		if (standing && standing.key !== drag.key) await this.#closeAnnotationDrag();

		const open = this.#openAnnotationStep(directory, path, drag);
		// **The bytes are queued behind the drag's `before` image, and queued synchronously.** A range
		// reports positions faster than a store read answers and the release arrives in the same task as
		// the last of them, so a write that ran ahead of the image — or a release that closed the Step
		// while one was still queued — would put bytes the scholar never saw in it.
		const applied = open.applied.then(() =>
			this.#putAnnotations(path, collection, bytes, { debounce: true })
		);
		open.applied = applied;
		await applied;
	}

	/**
	 * The Step one style drag will fill, opened on the first position it reports.
	 *
	 * The gesture handed to `step()` is a promise resolved when the drag ends, which is what makes the
	 * whole drag one Step: the `before` image is read when the first position arrives and the `after`
	 * image once the last one has been flushed. Synchronous, so that the positions arriving behind it
	 * join this drag rather than each opening a Step of its own.
	 */
	#openAnnotationStep(
		directory: string,
		path: StorePath,
		drag: { key: string; label: string }
	): AnnotationDrag {
		const standing = this.#annotationDrag;
		if (standing?.key === drag.key) return standing;

		let start = (): void => {};
		let end = (): void => {};
		const started = new Promise<void>((resolve) => {
			start = resolve;
		});
		const finished = new Promise<void>((resolve) => {
			end = resolve;
		});
		// The indicator is told here rather than by the write, for the reason the labelled branch of
		// {@link writeAnnotations} records: a screen reading `Saved locally` across the `before` image's
		// read would be reporting an edit that exists and is unwritten as a written one.
		this.saveState = 'saving';
		// The Layer's own document and nothing else, which is ADR-0039's disjointness invariant: a style
		// is content, and `project.json` is untouched by it.
		const step = this.historyFor(directory).step(drag.label, [path], async () => {
			start();
			await finished;
		});
		const opened: AnnotationDrag = { key: drag.key, path, end, step, applied: started };
		this.#annotationDrag = opened;
		return opened;
	}

	/** End the standing style drag, so its Step reads its `after` image and closes. */
	async #closeAnnotationDrag(): Promise<void> {
		const drag = this.#annotationDrag;
		if (!drag) return;
		this.#annotationDrag = null;
		// Every position reported so far, applied first: one still queued would land after the `after`
		// image had been read and go unrecorded.
		await drag.applied;
		drag.end();
		await drag.step;
	}

	/** One Annotation Layer's bytes out through {@link Autosave}, on the timer or now. */
	async #putAnnotations(
		path: StorePath,
		collection: AnnotationCollection,
		bytes: Bytes,
		options: { debounce?: boolean }
	): Promise<void> {
		if (options.debounce) {
			// Rule 2's per-file timer. Nothing is recorded for this path: the write happens on the timer
			// rather than here, and the counter exists to assert that a *gesture* costs one write.
			this.#autosave.queue(path, bytes);
			return;
		}
		try {
			await this.#autosave.commit(path, bytes);
			this.saveError = '';
			// After the write resolved, so an attempt the store refused is not counted as one that
			// happened. This is what lets the vertex test assert the number of writes.
			recordAnnotationWrite(path, collection.annotations.length, bytes.length);
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Whether an Annotation Layer has bytes waiting inside their debounce window.
	 *
	 * Asked by the commit-on-blur path, so that tabbing through a title field is *looking* rather than
	 * an edit — the same guard {@link commitProjectName} and {@link commitLayerEdit} both carry, and the
	 * reason it exists is ADR-0010: merely opening last year's Project must not modify a byte of it.
	 */
	hasPendingAnnotationWrite(layer: AnnotationLayer): boolean {
		const directory = this.openDirectory;
		if (!directory) return false;
		const path = annotationStorePath(directory, layer.id);
		// **A drag under way counts as pending even with its timer already fired.** The release is the
		// only thing that closes the drag's Step, and it arrives through the commit-on-blur path — so a
		// drag long enough for the debounce to elapse mid-gesture would otherwise leave the Step open
		// for ever and swallow the gesture after it.
		if (this.#annotationDrag?.path === path) return true;
		return this.#autosave.hasPendingWrite(path);
	}

	/**
	 * The open Project's display name is being typed. Coalesced per file, so a name typed one
	 * character at a time is one write and not twelve (ADR-0017 rule 2).
	 */
	async typeProjectName(displayName: string): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		this.openProject = { ...this.openProject, name: displayName };
		await this.#write(directory, { debounce: true });
	}

	/**
	 * The edit is over — the field lost focus, or Enter was pressed. Writes now rather than on a
	 * timer, the same rule a dragged Control Point will follow on pointer-up (ADR-0017 rule 1).
	 *
	 * A no-op when nothing is waiting to be written. Rule 1 is "commit the edit that is ending",
	 * not "write on every blur": tabbing through the name field must not rewrite `project.json`,
	 * because `writeProject` stamps a fresh `updatedAt` and ADR-0010 is explicit that merely
	 * looking at an old Project must not modify files.
	 */
	async commitProjectName(): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		if (!this.#autosave.hasPendingWrite(projectFilePath(directory))) return;
		await this.#write(directory);
	}

	/**
	 * Record the author's default Base Map (ADR-0020, ticket 04).
	 *
	 * A discrete choice, so it is written now rather than debounced, and through the same
	 * `Workspace` and the same in-memory document as every other mutation — the id is one field
	 * of `project.json`, not a file of its own.
	 */
	async chooseBaseMap(id: string): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		this.openProject = { ...this.openProject, baseMap: id };
		await this.#write(directory);
	}

	/** Write everything pending and wait for the store to have it. */
	async flush(): Promise<void> {
		await this.#autosave.flush();
	}

	/**
	 * Put everything pending in the write-ahead journal, synchronously (ticket 20).
	 *
	 * The half of {@link flush} that survives the page going away. Called by `installFlushOnHide` and
	 * by `WorkspaceStorage` before it discards a session, where the flush may reject and leave bytes
	 * with nowhere else to be.
	 */
	capture(): void {
		this.#autosave.capture();
	}

	/**
	 * Write the open Project's document.
	 *
	 * Deliberately not routed through {@link #mutate}: an edit inside a Project does not change
	 * the hub's list of them, and a failed write is a save-state problem rather than an
	 * unreachable Workspace.
	 */
	async #write(directory: string, options: { debounce?: boolean } = {}): Promise<void> {
		try {
			await this.#workspace.writeProject(directory, this.openProject as ProjectFile, options);
			this.saveError = '';
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * A hub action: it changes which Projects exist, so the list is reloaded after it.
	 *
	 * @param directory the Project it acts on, for the message when that Project has gone
	 */
	async #mutate<T>(directory: string | null, action: () => Promise<T>): Promise<T | null> {
		try {
			const result = await action();
			this.projects = await this.#workspace.listProjects();
			this.status = 'ready';
			this.unreachableDetail = '';
			// A refused name that has since been accepted is no longer a problem, and an alert about a
			// Project that now exists is worse than none — it says the action failed while its result is
			// in the list underneath it.
			this.projectProblem = null;
			return result;
		} catch (cause) {
			// A Project that another tab deleted, or one from a newer version, is a problem with
			// that Project — not with the Workspace, which is right here and still lists. Rendering
			// "Workspace not reachable" over a reachable Workspace is its own kind of data-loss
			// scare, and it hides the recovery the user actually has.
			const problem = describeProblem(cause, directory);
			if (problem) {
				this.projectProblem = problem;
				await this.refresh();
				return null;
			}
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
			return null;
		}
	}
}

/**
 * A Layer's or a Map Image's own name in quotation marks, for the sentence an Edit History's
 * controls say.
 *
 * Something nobody named still has to be identifiable in the one sentence that says what undo will
 * give back, which is what the fallback phrase is for.
 */
const quotedName = (name: string): string => (name === '' ? 'with no name' : `“${name}”`);

/**
 * A failure that is about one Project rather than about the Workspace, described for a reader.
 * `null` for anything else, which the caller renders as an unreachable Workspace.
 */
function describeProblem(cause: unknown, directory: string | null): ProjectProblem | null {
	if (cause instanceof ProjectFormatTooNewError) {
		return { kind: 'format-too-new', message: cause.message };
	}
	if (cause instanceof PathNotFoundError) {
		return {
			kind: 'missing',
			message: directory
				? `There is no Project called “${directory}” in this Workspace.`
				: `Something this action needed is no longer in the Workspace: ${cause.message}`
		};
	}
	if (cause instanceof ProjectFileUnreadableError) {
		return { kind: 'unreadable', message: cause.message };
	}
	// A name the Workspace itself needs (ADR-0023). Nothing was created and nothing is wrong with the
	// Workspace, so this must not become "Workspace not reachable" — which is what it was before this
	// case existed, and which replaced the hub, and every Project in it, with a data-loss scare over a
	// name the user can simply change. The message names the reservation, which is the acceptance
	// criterion: "reserved" without saying what is reserved leaves nothing to act on.
	if (cause instanceof ReservedDirectoryNameError) {
		return { kind: 'reserved-name', message: cause.message };
	}
	return null;
}
